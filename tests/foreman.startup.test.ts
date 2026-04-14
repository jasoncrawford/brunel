import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Worker } from "../src/foreman/models/worker.js";
import { ForemanWss } from "../src/foreman/controllers/wss.js";
import { TaskManager } from "../src/foreman/models/task-manager.js";
import { Task } from "../src/foreman/models/task.js";
import { setupInMemoryTasks } from "./helpers/task.js";
import { loadDefaultConfig } from "../src/config.js";

const defaultCfg = await loadDefaultConfig();
import WebSocket, { WebSocketServer } from "ws";
import http from "http";
import type { AddressInfo } from "net";
import { waitUntil } from "./helpers.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Register a task and mark its deps as loaded so tryAssignWork will pick it up. */
async function registerReady(
  tm: TaskManager,
  taskId: string,
  issueNumber: number,
  repoSlug: string,
  title: string,
  body: string,
  labels: string[],
): Promise<void> {
  await Task.upsert(taskId, issueNumber, repoSlug, title, body, labels);
  tm.trackIssue(issueNumber);
  tm.markBlockersLoaded(issueNumber);
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

let taskManager: TaskManager;

let httpServer: http.Server;
let wss: WebSocketServer;
let port: number;
const openClients: WebSocket[] = [];

function connect(msg: object): Promise<WebSocket> {
  return connectWorker(port, msg).then((ws) => { openClients.push(ws); return ws; });
}

beforeEach(() => {
  Worker._reset();
  httpServer = http.createServer();
  taskManager = new TaskManager();
  setupInMemoryTasks(taskManager);
});

afterEach(() => {
  return new Promise<void>((resolve) => {
    const clients = openClients.splice(0);
    const alive = clients.filter((c) => c.readyState !== WebSocket.CLOSED);
    const finish = () => {
      const cleanup = () => { vi.restoreAllMocks(); resolve(); };
      if (wss) {
        wss.close(() => httpServer.close(cleanup));
      } else {
        httpServer.close(cleanup);
      }
    };
    if (alive.length === 0) { finish(); return; }
    let pending = alive.length;
    for (const c of alive) {
      c.once("close", () => { if (--pending === 0) finish(); });
      c.close();
    }
  });
});

function startServer(): Promise<number> {
  return new Promise((resolve) => {
    httpServer.listen(0, () => resolve((httpServer.address() as AddressInfo).port));
  });
}

// ── tryAssignWork — assign persistence ────────────────────────────────────────

describe("tryAssignWork — assign persistence", () => {
  it("task.assign is called and task status becomes assigned before task_assigned is sent", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Test task", "body", []);

    ({ wss } = new ForemanWss({ taskManager, server: httpServer, config: { ...defaultCfg, taskLabel: "brunel:ready" } }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "w1", status: "idle" });
    const q = makeQueue(ws);
    await q.next(); // hello_ack
    const msg = await q.next(); // task_assigned

    expect(msg).toMatchObject({ type: "task_assigned", taskId: "42" });
    // After task_assigned is sent, the task should be assigned (assign was called)
    expect((await Task.get("42"))?.status).toBe("assigned");
    expect((await Task.get("42"))?.workerId).toBe("w1");
  });

  it("reverts task to pending if assign fails", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Test task", "body", []);

    // Spy on task.assign to make it fail
    const task = await Task.get("42");
    vi.spyOn(task!, "assign").mockRejectedValue(new Error("db down"));

    ({ wss } = new ForemanWss({ taskManager, server: httpServer, config: { ...defaultCfg, taskLabel: "brunel:ready" } }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "w1", status: "idle" });
    await waitUntil(() => Worker.get("w1")?.status === "idle");

    expect((await Task.get("42"))?.status).toBe("pending");
  });

  it("works transparently with in-memory task store", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Test task", "body", []);
    ({ wss } = new ForemanWss({ taskManager, server: httpServer, config: { ...defaultCfg, taskLabel: "brunel:ready" } }));

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
  it("idle worker whose task was previously assigned triggers revert and re-assign", async () => {
    // After revert, tryAssignWork will offer the task again (correct: worker starts fresh).
    await registerReady(taskManager, "42", 42, "owner/repo", "Test task", "body", []);
    const t = await Task.get("42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs)); // simulate what main block does after startup restore

    ({ wss } = new ForemanWss({ taskManager, server: httpServer, config: { ...defaultCfg, taskLabel: "brunel:ready" } }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "w1", status: "idle" });
    const q = makeQueue(ws);
    await q.next(); // hello_ack
    const msg = await q.next(); // task_assigned

    // Worker gets the task re-assigned (fresh session — prior assignment was reverted)
    expect(msg).toMatchObject({ type: "task_assigned" });
  });

  it("a different idle worker does not steal a startup-assigned task", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Test task", "body", []);
    const t = await Task.get("42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("original-worker", fakeWs)); // simulate startup loading

    ({ wss } = new ForemanWss({ taskManager, server: httpServer, config: { ...defaultCfg, taskLabel: "brunel:ready" } }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "new-worker", status: "idle" });
    await waitUntil(() => Worker.get("new-worker")?.status === "idle");

    // new-worker should NOT get task 42 — it belongs to original-worker
    expect((await Task.get("42"))?.status).toBe("assigned");
    expect((await Task.get("42"))?.workerId).toBe("original-worker");
  });

  it("busy worker reconnect correctly reclaims its task", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Test task", "body", []);
    const t = await Task.get("42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs));

    ({ wss } = new ForemanWss({ taskManager, server: httpServer, config: { ...defaultCfg, taskLabel: "brunel:ready" } }));

    port = await startServer();
    await connect({ type: "worker_hello", workerId: "w1", status: "busy", taskId: "42" });

    await waitUntil(() => Worker.get("w1")?.status === "busy");
    expect((await Task.get("42"))?.status).toBe("assigned");
    expect((await Task.get("42"))?.workerId).toBe("w1");
  });
});

// ── PR tracking persistence ───────────────────────────────────────────────────

describe("PR tracking persistence", () => {
  it("calls task.registerPr when PR opened event is routed", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Test task", "body", []);
    const t = await Task.get("42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs));
    const spyRegisterPr = vi.spyOn(t!, "registerPr");

    const result = new ForemanWss({ taskManager, server: httpServer, config: { ...defaultCfg, taskLabel: "brunel:ready" } });
    ({ wss } = result);

    await result.routeEvent("evt-1", "pull_request", {
      action: "opened",
      pull_request: {
        number: 10,
        body: "Fixes #42\n\nSome work.",
        head: { ref: "fix-issue-42" },
      },
    });

    expect(spyRegisterPr).toHaveBeenCalledWith(10, "fix-issue-42");
  });

  it("calls task.registerPr with null branch when PR has no head ref", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Test task", "body", []);
    const t = await Task.get("42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs));
    const spyRegisterPr = vi.spyOn(t!, "registerPr");

    const result = new ForemanWss({ taskManager, server: httpServer, config: { ...defaultCfg, taskLabel: "brunel:ready" } });
    ({ wss } = result);

    await result.routeEvent("evt-1", "pull_request", {
      action: "opened",
      pull_request: {
        number: 10,
        body: "Fixes #42",
        head: {}, // no ref
      },
    });

    expect(spyRegisterPr).toHaveBeenCalledWith(10, null);
  });
});

// ── Startup: restore tasks from store (DB is primary source of truth) ─────────

// Helper: run the startup DB-restore logic using the in-memory task store.
// Mirrors what index.ts does with loadActiveTasksFromDb + manual setup.
async function restoreTasksFromDb(rows: Array<{
  taskId: string; issueNumber: number; repo: string; title: string;
  body: string; labels: string[]; workerId?: string | null;
  prNumber?: number | null; branch?: string | null;
  completedAt?: string | null;
}>, tm: TaskManager): Promise<void> {
  for (const row of rows) {
    if (row.completedAt) continue;
    await Task.upsert(row.taskId, row.issueNumber, row.repo, row.title, row.body ?? "", row.labels ?? []);
    // Mark deps loaded for the issue (simulates startup having loaded deps)
    tm.trackIssue(row.issueNumber);
    tm.markBlockersLoaded(row.issueNumber);
    if (row.workerId) {
      const t = await Task.get(row.taskId);
      const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
      if (t) await t.assign(Worker.register(row.workerId, fakeWs));
    }
    if (row.prNumber != null) {
      const t = await Task.get(row.taskId);
      if (t) await t.registerPr(row.prNumber, row.branch ?? null);
    }
    if (row.branch) { const t = await Task.get(row.taskId); if (t) tm.registerBranch(row.branch, t); }
  }
}

describe("startup — restore tasks from tasks table (DB is source of truth)", () => {
  it("assigned task from store is visible in the snapshot", async () => {
    ({ wss } = new ForemanWss({ taskManager, server: httpServer, config: { ...defaultCfg, taskLabel: "brunel:ready" } }));

    port = await startServer();

    // Simulate startup: restore from DB rows
    const rows = [{
      taskId: "42", issueNumber: 42, repo: "owner/repo", title: "Test task",
      body: "", labels: [], workerId: "w1",
      prNumber: null, branch: null, completedAt: null,
    }];
    await restoreTasksFromDb(rows, taskManager);

    expect((await Task.get("42"))?.status).toBe("assigned");
    expect((await Task.get("42"))?.workerId).toBe("w1");
    expect((await Task.get("42"))?.title).toBe("Test task");
  });

  it("pending task from store can be assigned by nextPending", async () => {
    ({ wss } = new ForemanWss({ taskManager, server: httpServer, config: { ...defaultCfg, taskLabel: "brunel:ready" } }));

    port = await startServer();

    const rows = [{
      taskId: "42", issueNumber: 42, repo: "owner/repo", title: "Test task",
      body: "", labels: [], workerId: null,
      prNumber: null, branch: null, completedAt: null,
    }];
    await restoreTasksFromDb(rows, taskManager);

    // Mark deps as loaded so nextPending will return the task
    const task = await taskManager.nextPending(() => true);
    expect(task?.taskId).toBe("42");
  });

  it("PR number and branch are restored from store", async () => {
    ({ wss } = new ForemanWss({ taskManager, server: httpServer, config: { ...defaultCfg, taskLabel: "brunel:ready" } }));

    port = await startServer();

    const rows = [{
      taskId: "42", issueNumber: 42, repo: "owner/repo", title: "Test task",
      body: "", labels: [], workerId: "w1",
      prNumber: 10, branch: "fix-42", completedAt: null,
    }];
    await restoreTasksFromDb(rows, taskManager);

    expect((await Task.getByPr(10))?.taskId).toBe("42");
    expect((await taskManager.getTaskForBranch("fix-42"))?.taskId).toBe("42");
  });

  it("complete tasks from store are skipped", async () => {
    ({ wss } = new ForemanWss({ taskManager, server: httpServer, config: { ...defaultCfg, taskLabel: "brunel:ready" } }));

    port = await startServer();

    const rows = [{
      taskId: "42", issueNumber: 42, repo: "owner/repo", title: "Test task",
      body: "", labels: [], workerId: null,
      prNumber: null, branch: null, completedAt: "2026-01-01T02:00:00Z",
    }];
    await restoreTasksFromDb(rows, taskManager);

    expect(await Task.get("42")).toBeNull();
  });

  it("body and labels are included in task_assigned after startup restore + reconcile", async () => {
    // Simulates the full startup sequence:
    // 1. Task is restored from DB with empty body/labels
    // 2. GitHub data is loaded into labeledIssues (via loadIssuesToQueue)
    // 3. reconcile() is called to sync labeledIssues → taskQueue
    // 4. Worker connects and must receive the real body/labels in task_assigned
    const localForemanWss = new ForemanWss({ taskManager, server: httpServer, config: { ...defaultCfg, taskLabel: "brunel:ready" } });
    wss = localForemanWss.wss;

    port = await startServer();

    // Step 1: restore from DB (empty body/labels, as in startup)
    await Task.upsert("42", 42, "owner/repo", "Test task", "", []);
    expect((await Task.get("42"))?.body).toBe("");
    expect((await Task.get("42"))?.labels).toEqual([]);

    // Step 2: GitHub data updates the task (simulates loadIssuesFromGithub calling Task.upsert)
    await Task.upsert("42", 42, "owner/repo", "Test task", "Real issue description", ["brunel:ready", "bug"]);
    taskManager.trackIssue(42);
    taskManager.markBlockersLoaded(42);

    // Step 3: reconcile assigns idle workers
    await localForemanWss.reconcile();

    // Step 4: worker connects and receives task_assigned with real body/labels
    const ws = await connect({ type: "worker_hello", workerId: "w1", status: "idle" });
    const q = makeQueue(ws);
    await q.next(); // hello_ack
    const msg = await q.next() as { type: string; issue: { body: string; labels: string[] } };

    expect(msg.type).toBe("task_assigned");
    expect(msg.issue.body).toBe("Real issue description");
    expect(msg.issue.labels).toEqual(["brunel:ready", "bug"]);
  });

  it("GitHub sync during startup does not steal assignment from original worker (issue #600 regression)", async () => {
    // Reproduces the bug from issue #600:
    // 1. Task is restored from DB with worker_id set (loadActiveTasksFromDb)
    // 2. GitHub sync calls Task.upsert() again for the same task (loadIssuesFromGithub)
    // 3. reconcile() runs — MUST NOT assign the task to a different idle worker
    const localForemanWss2 = new ForemanWss({ taskManager, server: httpServer, config: { ...defaultCfg, taskLabel: "brunel:ready" } });
    wss = localForemanWss2.wss;

    port = await startServer();

    // Step 1: restore from DB — task is assigned to "original-worker"
    await Task.upsert("42", 42, "owner/repo", "Test task", "", []);
    const t = await Task.get("42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("original-worker", fakeWs));
    taskManager.trackIssue(42);
    taskManager.markBlockersLoaded(42);

    // Step 2: GitHub sync calls upsert for the same task (content refresh only)
    await Task.upsert("42", 42, "owner/repo", "Test task", "New body from GitHub", ["brunel:ready"]);

    // Assignment must be preserved after the GitHub sync upsert
    expect((await Task.get("42"))?.workerId).toBe("original-worker");

    // Step 3: reconcile() — must NOT assign the task to a new worker
    await localForemanWss2.reconcile();

    expect((await Task.get("42"))?.workerId).toBe("original-worker");
    expect((await Task.get("42"))?.status).toBe("assigned");

    // Step 4: an idle worker connects — must NOT receive the already-assigned task
    const ws = await connect({ type: "worker_hello", workerId: "new-worker", status: "idle" });
    await waitUntil(() => Worker.get("new-worker")?.status === "idle");

    expect((await Task.get("42"))?.workerId).toBe("original-worker");
  });
});

// ── Reconnect to complete task (issue closed while worker active) ─────────────

describe("startup — derived blocked status", () => {
  it("pending task with closed blocker is derived as pending", async () => {
    const rows = [{
      taskId: "42", issueNumber: 42, repo: "owner/repo", title: "Test task",
      body: "", labels: [], workerId: null,
      prNumber: null, branch: null, completedAt: null,
    }];
    await restoreTasksFromDb(rows, taskManager);

    // Task 42 was blocked by issue 5, which is now closed
    taskManager.setBlockers(42, [5]);
    taskManager.setIssueOpenState(5, false); // issue 5 is closed

    const snapshots = await taskManager.getTasksForBroadcast();
    expect(snapshots[0].status).toBe("pending");
  });

  it("pending task with open blocker is derived as blocked", async () => {
    const rows = [{
      taskId: "42", issueNumber: 42, repo: "owner/repo", title: "Test task",
      body: "", labels: [], workerId: null,
      prNumber: null, branch: null, completedAt: null,
    }];
    await restoreTasksFromDb(rows, taskManager);

    // Task 42 is blocked by issue 5, which is still open
    taskManager.setBlockers(42, [5]);
    taskManager.setIssueOpenState(5, true); // issue 5 is open

    const snapshots = await taskManager.getTasksForBroadcast();
    expect(snapshots[0].status).toBe("blocked");
  });
});

describe("startup reconnect — worker reconnects to complete task", () => {
  it("busy worker reconnect to complete task is reclaimed for finalization", async () => {
    // Simulate: issue was closed while worker was active, so the foreman marked
    // the task complete in-memory. Worker briefly disconnects and reconnects.
    // Worker should be allowed to reclaim to do finalization work (doc updates, etc.).
    await registerReady(taskManager, "42", 42, "owner/repo", "Test task", "body", []);
    const t = await Task.get("42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    const w1 = Worker.register("w1", fakeWs);
    await t!.assign(w1);
    w1.remove(); // deregister so waitUntil below detects the real reconnect
    await t!.complete(); // issue closed while worker was active

    ({ wss } = new ForemanWss({ taskManager, server: httpServer, config: { ...defaultCfg, taskLabel: "brunel:ready" } }));

    port = await startServer();
    await connect({ type: "worker_hello", workerId: "w1", status: "busy", taskId: "42" });

    await waitUntil(() => Worker.get("w1") !== undefined);
    // Worker should be reclaimed as busy to allow finalization work
    expect(Worker.get("w1")?.status).toBe("busy");
    // Task should stay complete
    expect((await Task.get("42"))?.status).toBe("complete");
  });

  it("busy worker that calls task_complete on a complete task releases correctly", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Test task", "body", []);
    const t = await Task.get("42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs));
    await t!.complete();

    ({ wss } = new ForemanWss({ taskManager, server: httpServer, config: { ...defaultCfg, taskLabel: "brunel:ready" } }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "w1", status: "busy", taskId: "42" });

    await waitUntil(() => Worker.get("w1") !== undefined);
    // Spy on complete after the task is already obtained
    const t2 = await Task.get("42");
    const spyComplete = vi.spyOn(t2!, "complete");

    ws.send(JSON.stringify({ type: "task_complete", workerId: "w1", taskId: "42" }));
    await waitUntil(() => Worker.get("w1")?.status === "idle");

    // The task was already complete; task_complete is still a no-op (idempotent)
    expect(Worker.get("w1")?.status).toBe("idle");
  });
});

// ── task_complete marks task complete ─────────────────────────────────────────

describe("task_complete marks task complete", () => {
  it("calls task.complete when task_complete received", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Test task", "body", []);
    const t = await Task.get("42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs));

    ({ wss } = new ForemanWss({ taskManager, server: httpServer, config: { ...defaultCfg, taskLabel: "brunel:ready" } }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "w1", status: "busy", taskId: "42" });

    await waitUntil(() => Worker.get("w1")?.status === "busy");

    // Get fresh task reference and spy on complete
    const t2 = await Task.get("42");
    const spyComplete = vi.spyOn(t2!, "complete");

    ws.send(JSON.stringify({ type: "task_complete", workerId: "w1", taskId: "42" }));
    await waitUntil(() => Worker.get("w1")?.status === "idle");

    expect(spyComplete).toHaveBeenCalled();
  });
});
