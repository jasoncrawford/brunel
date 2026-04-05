import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkerRegistry } from "../src/foreman/worker-registry.js";
import { createForemanWss } from "../src/foreman/wss.js";
import { TaskModel } from "../src/foreman/task-model.js";
import { loadDefaultConfig } from "../src/config.js";
import { isBlocked } from "../src/foreman/dependencies.js";
import { createMemoryTaskStore } from "../src/foreman/db.js";

const defaultCfg = await loadDefaultConfig();
import type { TaskStore, TaskRow } from "../src/foreman/db.js";
import type { LabeledIssueState, TaskStatus } from "../src/types.js";
import WebSocket, { WebSocketServer } from "ws";
import http from "http";
import type { AddressInfo } from "net";
import { waitUntil } from "./helpers.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Creates a real in-memory store with vi.spyOn on all methods for assertion. */
function makeSpiedStore(): TaskStore {
  const store = createMemoryTaskStore();
  vi.spyOn(store, "upsertTask");
  vi.spyOn(store, "updateTaskContent");
  vi.spyOn(store, "markAssigned");
  vi.spyOn(store, "markComplete");
  vi.spyOn(store, "markPending");
  vi.spyOn(store, "markBlocked");
  vi.spyOn(store, "updateTaskPr");
  vi.spyOn(store, "deleteTask");
  vi.spyOn(store, "getTask");
  vi.spyOn(store, "listTasks");
  return store;
}

/** Register a task and mark its deps as loaded so tryAssignWork will pick it up. */
async function registerReady(
  tm: TaskModel,
  taskId: string,
  issueNumber: number,
  repoSlug: string,
  title: string,
  body: string,
  labels: string[],
): Promise<void> {
  await tm.register(taskId, issueNumber, repoSlug, title, body, labels);
  tm.trackIssue(issueNumber, {
    number: issueNumber, title, body, labels,
    repoUrl: `https://github.com/${repoSlug}`,
  }, true);
}

function connectWorker(port: number, msg: object): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/worker`);
    ws.once("open", () => { ws.send(JSON.stringify(msg)); resolve(ws); });
    ws.once("error", reject);
  });
}

function nextMsg(ws: WebSocket): Promise<object> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

function makeQueue(ws: WebSocket): { next: () => Promise<object> } {
  const pending: object[] = [];
  const waiters: Array<(m: object) => void> = [];
  ws.on("message", (data: Buffer | string) => {
    const msg = JSON.parse(data.toString()) as object;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else pending.push(msg);
  });
  return {
    next(): Promise<object> {
      if (pending.length > 0) return Promise.resolve(pending.shift()!);
      return new Promise((r) => waiters.push(r));
    },
  };
}

function closeClient(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.once("close", resolve);
    ws.close();
  });
}

// ── Test harness ──────────────────────────────────────────────────────────────

let taskModel: TaskModel;
let registry: WorkerRegistry;
let httpServer: http.Server;
let wss: WebSocketServer;
let port: number;
const openClients: WebSocket[] = [];

function connect(msg: object): Promise<WebSocket> {
  return connectWorker(port, msg).then((ws) => { openClients.push(ws); return ws; });
}

beforeEach(() => {
  registry = new WorkerRegistry();
  httpServer = http.createServer();
});

afterEach(() => new Promise<void>((resolve) => {
  const clients = openClients.splice(0);
  const alive = clients.filter((c) => c.readyState !== WebSocket.CLOSED);
  const finish = () => {
    if (wss) {
      wss.close(() => httpServer.close(resolve));
    } else {
      httpServer.close(resolve);
    }
  };
  if (alive.length === 0) { finish(); return; }
  let pending = alive.length;
  for (const c of alive) {
    c.once("close", () => { if (--pending === 0) finish(); });
    c.close();
  }
}));

function startServer(): Promise<number> {
  return new Promise((resolve) => {
    httpServer.listen(0, () => resolve((httpServer.address() as AddressInfo).port));
  });
}

// ── tryAssignWork — DB persistence ────────────────────────────────────────────

describe("tryAssignWork — DB persistence", () => {
  it("calls markAssigned before sending task_assigned", async () => {
    const callOrder: string[] = [];
    const taskStore = makeSpiedStore();
    const origMarkAssigned = taskStore.markAssigned.bind(taskStore);
    taskStore.markAssigned = vi.fn().mockImplementation(async (...args: [string, string]) => {
      callOrder.push("db");
      return origMarkAssigned(...args);
    });

    taskModel = new TaskModel(taskStore);
    await registerReady(taskModel, "42", 42, "owner/repo", "Test task", "body", []);
    ({ wss } = createForemanWss(taskModel, registry, httpServer, { ...defaultCfg, taskLabel: "brunel:ready" }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "w1", status: "idle" });
    const q = makeQueue(ws);
    await q.next(); // hello_ack
    const msg = await q.next(); // task_assigned
    callOrder.push("after-recv");

    expect(msg).toMatchObject({ type: "task_assigned", taskId: "42" });
    expect(taskStore.markAssigned).toHaveBeenCalledWith("42", "w1");
    expect(callOrder[0]).toBe("db");
  });

  it("reverts task to pending if DB write fails", async () => {
    const taskStore = makeSpiedStore();
    taskStore.markAssigned = vi.fn().mockRejectedValue(new Error("db down"));

    taskModel = new TaskModel(taskStore);
    await registerReady(taskModel, "42", 42, "owner/repo", "Test task", "body", []);
    ({ wss } = createForemanWss(taskModel, registry, httpServer, { ...defaultCfg, taskLabel: "brunel:ready" }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "w1", status: "idle" });
    await waitUntil(() => registry.get("w1")?.status === "idle");

    expect((await taskModel.get("42"))?.status).toBe("pending");
  });

  it("works transparently without taskStore (null store)", async () => {
    taskModel = new TaskModel();
    await registerReady(taskModel, "42", 42, "owner/repo", "Test task", "body", []);
    ({ wss } = createForemanWss(taskModel, registry, httpServer, { ...defaultCfg, taskLabel: "brunel:ready" }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "w1", status: "idle" });
    const q = makeQueue(ws);
    await q.next(); // hello_ack
    const msg = await q.next(); // task_assigned

    expect(msg).toMatchObject({ type: "task_assigned", taskId: "42" });
  });
});

// ── Startup reconnect behaviour ───────────────────────────────────────────────

describe("startup reconnect behaviour", () => {
  it("idle worker whose task was loaded from DB triggers markPending and revert", async () => {
    // After revert, tryAssignWork will offer the task again (correct: worker starts fresh).
    const taskStore = makeSpiedStore();
    taskModel = new TaskModel(taskStore);
    await registerReady(taskModel, "42", 42, "owner/repo", "Test task", "body", []);
    await taskModel.assign("42", "w1"); // simulate what main block does after startup restore

    ({ wss } = createForemanWss(taskModel, registry, httpServer, { ...defaultCfg, taskLabel: "brunel:ready" }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "w1", status: "idle" });
    const q = makeQueue(ws);
    await q.next(); // hello_ack
    const msg = await q.next(); // task_assigned

    // markPending should be called (task reverted from old session)
    expect(taskStore.markPending).toHaveBeenCalledWith("42");
    // Worker gets the task re-assigned (fresh session — prior assignment was reverted)
    expect(msg).toMatchObject({ type: "task_assigned" });
  });

  it("a different idle worker does not steal a startup-assigned task", async () => {
    const taskStore = makeSpiedStore();
    taskModel = new TaskModel(taskStore);
    await registerReady(taskModel, "42", 42, "owner/repo", "Test task", "body", []);
    await taskModel.assign("42", "original-worker"); // simulate startup loading

    ({ wss } = createForemanWss(taskModel, registry, httpServer, { ...defaultCfg, taskLabel: "brunel:ready" }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "new-worker", status: "idle" });
    await waitUntil(() => registry.get("new-worker")?.status === "idle");

    // new-worker should NOT get task 42 — it belongs to original-worker
    expect((await taskModel.get("42"))?.status).toBe("assigned");
    expect((await taskModel.get("42"))?.assignedWorkerId).toBe("original-worker");
  });

  it("busy worker reconnect correctly reclaims its task", async () => {
    const taskStore = makeSpiedStore();
    taskModel = new TaskModel(taskStore);
    await registerReady(taskModel, "42", 42, "owner/repo", "Test task", "body", []);
    await taskModel.assign("42", "w1");

    ({ wss } = createForemanWss(taskModel, registry, httpServer, { ...defaultCfg, taskLabel: "brunel:ready" }));

    port = await startServer();
    await connect({ type: "worker_hello", workerId: "w1", status: "busy", taskId: "42" });

    await waitUntil(() => registry.get("w1")?.status === "busy");
    expect((await taskModel.get("42"))?.status).toBe("assigned");
    expect((await taskModel.get("42"))?.assignedWorkerId).toBe("w1");
    // markPending must NOT be called — worker reclaimed its task
    expect(taskStore.markPending).not.toHaveBeenCalled();
  });
});

// ── PR tracking persistence ───────────────────────────────────────────────────

describe("PR tracking persistence", () => {
  it("calls updateTaskPr when PR opened event is routed", async () => {
    const taskStore = makeSpiedStore();
    taskModel = new TaskModel(taskStore);
    await registerReady(taskModel, "42", 42, "owner/repo", "Test task", "body", []);
    await taskModel.assign("42", "w1");

    const result = createForemanWss(taskModel, registry, httpServer, { ...defaultCfg, taskLabel: "brunel:ready" });
    ({ wss } = result);

    await result.routeEvent("evt-1", "pull_request", {
      action: "opened",
      pull_request: {
        number: 10,
        body: "Fixes #42\n\nSome work.",
        head: { ref: "fix-issue-42" },
      },
    });

    expect(taskStore.updateTaskPr).toHaveBeenCalledWith("42", 10, "fix-issue-42");
  });

  it("calls updateTaskPr with null branch when PR has no head ref", async () => {
    const taskStore = makeSpiedStore();
    taskModel = new TaskModel(taskStore);
    await registerReady(taskModel, "42", 42, "owner/repo", "Test task", "body", []);
    await taskModel.assign("42", "w1");

    const result = createForemanWss(taskModel, registry, httpServer, { ...defaultCfg, taskLabel: "brunel:ready" });
    ({ wss } = result);

    await result.routeEvent("evt-1", "pull_request", {
      action: "opened",
      pull_request: {
        number: 10,
        body: "Fixes #42",
        head: {}, // no ref
      },
    });

    expect(taskStore.updateTaskPr).toHaveBeenCalledWith("42", 10, null);
  });
});

// ── Startup: restore tasks from taskStore (DB is primary source of truth) ─────

// Helper: run the new startup DB-restore logic (mirrors what isMain does).
async function restoreTasksFromDb(rows: TaskRow[], tm: TaskModel): Promise<void> {
  for (const row of rows) {
    if (row.status === "complete") continue;
    await tm.register(row.taskId, row.issueNumber, row.repo, row.title, row.body, row.labels);
    // Mark deps loaded for the issue (simulates startup having loaded deps)
    tm.trackIssue(row.issueNumber, {
      number: row.issueNumber, title: row.title, body: row.body,
      labels: row.labels, repoUrl: `https://github.com/${row.repo}`,
    }, true);
    if (row.status === "blocked") await tm.block(row.taskId);
    if (row.workerId) await tm.assign(row.taskId, row.workerId);
    if (row.prNumber !== null) await tm.registerPr(row.taskId, row.prNumber, null);
    if (row.branch) tm.registerBranch(row.branch, row.taskId);
  }
}

describe("startup — restore tasks from tasks table (DB is source of truth)", () => {
  it("assigned task from taskStore is visible in the snapshot", async () => {
    taskModel = new TaskModel();

    ({ wss } = createForemanWss(taskModel, registry, httpServer, { ...defaultCfg, taskLabel: "brunel:ready" }));

    port = await startServer();

    // Simulate startup: restore from DB rows
    const rows: TaskRow[] = [{
      taskId: "42", issueNumber: 42, repo: "owner/repo", title: "Test task",
      body: "", labels: [], status: "assigned" as const, workerId: "w1",
      prNumber: null, branch: null,
      createdAt: "2026-01-01T00:00:00Z", assignedAt: "2026-01-01T01:00:00Z", completedAt: null,
    }];
    await restoreTasksFromDb(rows, taskModel);

    expect((await taskModel.get("42"))?.status).toBe("assigned");
    expect((await taskModel.get("42"))?.assignedWorkerId).toBe("w1");
    expect((await taskModel.get("42"))?.title).toBe("Test task");
  });

  it("blocked task from taskStore is restored as blocked", async () => {
    taskModel = new TaskModel();

    ({ wss } = createForemanWss(taskModel, registry, httpServer, { ...defaultCfg, taskLabel: "brunel:ready" }));

    port = await startServer();

    const rows: TaskRow[] = [{
      taskId: "42", issueNumber: 42, repo: "owner/repo", title: "Test task",
      body: "", labels: [], status: "blocked" as const, workerId: null,
      prNumber: null, branch: null,
      createdAt: "2026-01-01T00:00:00Z", assignedAt: null, completedAt: null,
    }];
    await restoreTasksFromDb(rows, taskModel);

    expect((await taskModel.get("42"))?.status).toBe("blocked");
    expect(await taskModel.nextPending()).toBeNull(); // blocked tasks are not assignable
  });

  it("PR number and branch are restored from taskStore", async () => {
    taskModel = new TaskModel();

    ({ wss } = createForemanWss(taskModel, registry, httpServer, { ...defaultCfg, taskLabel: "brunel:ready" }));

    port = await startServer();

    const rows: TaskRow[] = [{
      taskId: "42", issueNumber: 42, repo: "owner/repo", title: "Test task",
      body: "", labels: [], status: "assigned" as const, workerId: "w1",
      prNumber: 10, branch: "fix-42",
      createdAt: "2026-01-01T00:00:00Z", assignedAt: "2026-01-01T01:00:00Z", completedAt: null,
    }];
    await restoreTasksFromDb(rows, taskModel);

    expect((await taskModel.getTaskForPr(10))?.taskId).toBe("42");
    expect((await taskModel.getTaskForBranch("fix-42"))?.taskId).toBe("42");
  });

  it("complete tasks from taskStore are skipped", async () => {
    taskModel = new TaskModel();

    ({ wss } = createForemanWss(taskModel, registry, httpServer, { ...defaultCfg, taskLabel: "brunel:ready" }));

    port = await startServer();

    const rows: TaskRow[] = [{
      taskId: "42", issueNumber: 42, repo: "owner/repo", title: "Test task",
      body: "", labels: [], status: "complete" as const, workerId: null,
      prNumber: null, branch: null,
      createdAt: "2026-01-01T00:00:00Z", assignedAt: null, completedAt: "2026-01-01T02:00:00Z",
    }];
    await restoreTasksFromDb(rows, taskModel);

    expect(await taskModel.get("42")).toBeNull();
  });

  it("body and labels are included in task_assigned after startup restore + reconcile", async () => {
    // Simulates the full startup sequence:
    // 1. Task is restored from DB with empty body/labels
    // 2. GitHub data is loaded into labeledIssues (via loadIssuesToQueue)
    // 3. reconcile() is called to sync labeledIssues → taskQueue
    // 4. Worker connects and must receive the real body/labels in task_assigned
    taskModel = new TaskModel();

    const { wss: fwss, reconcile } = createForemanWss(taskModel, registry, httpServer, { ...defaultCfg, taskLabel: "brunel:ready" });
    wss = fwss;

    port = await startServer();

    // Step 1: restore from DB (empty body/labels, as in startup)
    const rows: TaskRow[] = [{
      taskId: "42", issueNumber: 42, repo: "owner/repo", title: "Test task",
      body: "", labels: [], status: "pending" as const, workerId: null,
      prNumber: null, branch: null,
      createdAt: "2026-01-01T00:00:00Z", assignedAt: null, completedAt: null,
    }];
    // Restore without marking deps loaded (simulates before GitHub fetch)
    for (const row of rows) {
      if (row.status === "complete") continue;
      await taskModel.register(row.taskId, row.issueNumber, row.repo, row.title, row.body, row.labels);
    }
    expect((await taskModel.get("42"))?.body).toBe("");
    expect((await taskModel.get("42"))?.labels).toEqual([]);

    // Step 2: GitHub data loaded into labeledIssues
    taskModel.trackIssue(42, {
      number: 42,
      title: "Test task",
      body: "Real issue description",
      labels: ["brunel:ready", "bug"],
      repoUrl: "https://github.com/owner/repo",
    }, true);

    // Step 3: reconcile syncs labeledIssues → taskQueue
    await reconcile();

    // Step 4: worker connects and receives task_assigned with real body/labels
    const ws = await connect({ type: "worker_hello", workerId: "w1", status: "idle" });
    const q = makeQueue(ws);
    await q.next(); // hello_ack
    const msg = await q.next() as { type: string; issue: { body: string; labels: string[] } };

    expect(msg.type).toBe("task_assigned");
    expect(msg.issue.body).toBe("Real issue description");
    expect(msg.issue.labels).toEqual(["brunel:ready", "bug"]);
  });
});

// ── Reconnect to complete task (issue closed while worker active) ─────────────

describe("startup — blocked status reconciliation after graph rebuild", () => {
  it("blocked task whose blocker closed while foreman was down becomes pending", async () => {
    const taskStore = makeSpiedStore();
    taskModel = new TaskModel(taskStore);

    // Restore from DB: task is blocked
    const rows: TaskRow[] = [{
      taskId: "42", issueNumber: 42, repo: "owner/repo", title: "Test task",
      body: "", labels: [], status: "blocked" as const, workerId: null,
      prNumber: null, branch: null,
      createdAt: "2026-01-01T00:00:00Z", assignedAt: null, completedAt: null,
    }];
    await restoreTasksFromDb(rows, taskModel);
    expect((await taskModel.get("42"))?.status).toBe("blocked");

    // After GitHub reconcile: task 42 was blocked by issue 5, which is now closed
    const graph = new Map([[42, new Set([5])]]);
    const openIssues = new Set<number>(); // issue 5 is closed — not in openIssues

    const { wss: fwss } = createForemanWss(taskModel, registry, httpServer, { ...defaultCfg, taskLabel: "brunel:ready" });
    wss = fwss;

    for (const t of await taskModel.getPendingAndBlockedTasks()) {
      if (t.status === "blocked" && !isBlocked(t.issueNumber, graph, openIssues)) {
        await taskModel.unblock(t.taskId);
      } else if (t.status === "pending" && isBlocked(t.issueNumber, graph, openIssues)) {
        await taskModel.block(t.taskId);
      }
    }

    expect((await taskModel.get("42"))?.status).toBe("pending");
    expect(taskStore.markPending).toHaveBeenCalledWith("42");
  });

  it("pending task whose blocker was open when foreman was down becomes blocked", async () => {
    const taskStore = makeSpiedStore();
    taskModel = new TaskModel(taskStore);

    const rows: TaskRow[] = [{
      taskId: "42", issueNumber: 42, repo: "owner/repo", title: "Test task",
      body: "", labels: [], status: "pending" as const, workerId: null,
      prNumber: null, branch: null,
      createdAt: "2026-01-01T00:00:00Z", assignedAt: null, completedAt: null,
    }];
    await restoreTasksFromDb(rows, taskModel);

    // After GitHub reconcile: issue 5 is still open and blocks task 42
    const graph = new Map([[42, new Set([5])]]);
    const openIssues = new Set([5]);

    const { wss: fwss } = createForemanWss(taskModel, registry, httpServer, { ...defaultCfg, taskLabel: "brunel:ready" });
    wss = fwss;

    for (const t of await taskModel.getPendingAndBlockedTasks()) {
      if (t.status === "blocked" && !isBlocked(t.issueNumber, graph, openIssues)) {
        await taskModel.unblock(t.taskId);
      } else if (t.status === "pending" && isBlocked(t.issueNumber, graph, openIssues)) {
        await taskModel.block(t.taskId);
      }
    }

    expect((await taskModel.get("42"))?.status).toBe("blocked");
    expect(taskStore.markBlocked).toHaveBeenCalledWith("42");
  });
});

describe("startup reconnect — worker reconnects to complete task", () => {
  it("busy worker reconnect to complete task is cancelled (not reclaimed)", async () => {
    // Simulate: issue was closed while worker was active, so the foreman marked
    // the task complete in-memory. Worker briefly disconnects and reconnects.
    taskModel = new TaskModel();
    await registerReady(taskModel, "42", 42, "owner/repo", "Test task", "body", []);
    await taskModel.assign("42", "w1");
    await taskModel.complete("42"); // issue closed while worker was active

    ({ wss } = createForemanWss(taskModel, registry, httpServer, { ...defaultCfg, taskLabel: "brunel:ready" }));

    port = await startServer();
    await connect({ type: "worker_hello", workerId: "w1", status: "busy", taskId: "42" });

    await waitUntil(() => registry.get("w1") !== undefined);
    // Worker should be cancelled (registered as idle), not reclaimed as busy
    expect(registry.get("w1")?.status).toBe("idle");
    // Task should stay complete
    expect((await taskModel.get("42"))?.status).toBe("complete");
  });

  it("busy worker that calls task_complete on a complete task releases correctly", async () => {
    const taskStore = makeSpiedStore();
    taskModel = new TaskModel(taskStore);
    await registerReady(taskModel, "42", 42, "owner/repo", "Test task", "body", []);
    await taskModel.assign("42", "w1");
    await taskModel.complete("42");

    ({ wss } = createForemanWss(taskModel, registry, httpServer, { ...defaultCfg, taskLabel: "brunel:ready" }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "w1", status: "busy", taskId: "42" });

    await waitUntil(() => registry.get("w1") !== undefined);
    ws.send(JSON.stringify({ type: "task_complete", workerId: "w1", taskId: "42" }));
    await waitUntil(() => registry.get("w1")?.status === "idle");

    expect(taskStore.markComplete).toHaveBeenCalledWith("42");
  });
});

// ── task_complete marks task complete in DB ────────────────────────────────────

describe("task_complete marks task complete in DB", () => {
  it("calls markComplete when task_complete received", async () => {
    const taskStore = makeSpiedStore();
    taskModel = new TaskModel(taskStore);
    await registerReady(taskModel, "42", 42, "owner/repo", "Test task", "body", []);
    await taskModel.assign("42", "w1");

    ({ wss } = createForemanWss(taskModel, registry, httpServer, { ...defaultCfg, taskLabel: "brunel:ready" }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "w1", status: "busy", taskId: "42" });

    await waitUntil(() => registry.get("w1")?.status === "busy");
    ws.send(JSON.stringify({ type: "task_complete", workerId: "w1", taskId: "42" }));
    await waitUntil(() => registry.get("w1")?.status === "idle");

    expect(taskStore.markComplete).toHaveBeenCalledWith("42");
  });
});
