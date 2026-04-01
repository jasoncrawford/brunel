import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TaskQueue, WorkerRegistry, createForemanWss } from "../src/foreman.js";
import { isBlocked } from "../src/dependencies.js";
import type { TaskStore, TaskRow } from "../src/db.js";
import type { TaskStatus } from "../src/types.js";
import WebSocket, { WebSocketServer } from "ws";
import http from "http";
import type { AddressInfo } from "net";
import { waitUntil } from "./helpers.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTaskStore(rows: Partial<TaskRow>[] = []): TaskStore {
  const full: TaskRow[] = rows.map((r) => ({
    taskId: "42", issueNumber: 42, repo: "owner/repo", title: "Test task",
    status: "assigned" as const, workerId: "w1", prNumber: null, branch: null,
    createdAt: "2026-01-01T00:00:00Z", assignedAt: "2026-01-01T01:00:00Z", completedAt: null,
    ...r,
  }));
  return {
    upsertTask: vi.fn().mockResolvedValue(undefined),
    markAssigned: vi.fn().mockResolvedValue(undefined),
    markComplete: vi.fn().mockResolvedValue(undefined),
    markPending: vi.fn().mockResolvedValue(undefined),
    markBlocked: vi.fn().mockResolvedValue(undefined),
    updateTaskPr: vi.fn().mockResolvedValue(undefined),
    listTasks: vi.fn().mockImplementation(async (opts?: { status?: string }) => {
      if (opts?.status) return full.filter((r) => r.status === opts.status);
      return full;
    }),
  };
}

const baseTask = {
  taskId: "42",
  issueNumber: 42,
  title: "Test task",
  body: "body",
  labels: [],
  repoUrl: "https://github.com/test/repo",
};

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

let taskQueue: TaskQueue;
let registry: WorkerRegistry;
let httpServer: http.Server;
let wss: WebSocketServer;
let port: number;
const openClients: WebSocket[] = [];

function connect(msg: object): Promise<WebSocket> {
  return connectWorker(port, msg).then((ws) => { openClients.push(ws); return ws; });
}

beforeEach(() => {
  taskQueue = new TaskQueue();
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
    const taskStore = makeTaskStore();
    taskStore.markAssigned = vi.fn().mockImplementation(async () => {
      callOrder.push("db");
    });

    taskQueue.addTask(baseTask);
    ({ wss } = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      taskStore,
    }));

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
    const taskStore = makeTaskStore();
    taskStore.markAssigned = vi.fn().mockRejectedValue(new Error("db down"));

    taskQueue.addTask(baseTask);
    ({ wss } = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      taskStore,
    }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "w1", status: "idle" });
    await waitUntil(() => registry.get("w1")?.status === "idle");

    expect(taskQueue.get("42")?.status).toBe("pending");
  });

  it("works transparently without taskStore (null store)", async () => {
    taskQueue.addTask(baseTask);
    ({ wss } = createForemanWss(taskQueue, registry, httpServer, { taskLabel: "brunel:ready" }));

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
    const taskStore = makeTaskStore();
    taskQueue.addTask(baseTask);
    taskQueue.assignTask("42", "w1"); // simulate what main block does after startup restore

    ({ wss } = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      taskStore,
    }));

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
    const taskStore = makeTaskStore();
    taskQueue.addTask(baseTask);
    taskQueue.assignTask("42", "original-worker"); // simulate startup loading

    ({ wss } = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      taskStore,
    }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "new-worker", status: "idle" });
    await waitUntil(() => registry.get("new-worker")?.status === "idle");

    // new-worker should NOT get task 42 — it belongs to original-worker
    expect(taskQueue.get("42")?.status).toBe("assigned");
    expect(taskQueue.get("42")?.assignedWorkerId).toBe("original-worker");
  });

  it("busy worker reconnect correctly reclaims its task", async () => {
    const taskStore = makeTaskStore();
    taskQueue.addTask(baseTask);
    taskQueue.assignTask("42", "w1");

    ({ wss } = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      taskStore,
    }));

    port = await startServer();
    await connect({ type: "worker_hello", workerId: "w1", status: "busy", taskId: "42" });

    await waitUntil(() => registry.get("w1")?.status === "busy");
    expect(taskQueue.get("42")?.status).toBe("assigned");
    expect(taskQueue.get("42")?.assignedWorkerId).toBe("w1");
    // markPending must NOT be called — worker reclaimed its task
    expect(taskStore.markPending).not.toHaveBeenCalled();
  });
});

// ── PR tracking persistence ───────────────────────────────────────────────────

describe("PR tracking persistence", () => {
  it("calls updateTaskPr when PR opened event is routed", () => {
    const taskStore = makeTaskStore();
    taskQueue.addTask(baseTask);
    taskQueue.assignTask("42", "w1");

    const result = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      taskStore,
    });
    ({ wss } = result);

    result.routeEvent("evt-1", "pull_request", {
      action: "opened",
      pull_request: {
        number: 10,
        body: "Fixes #42\n\nSome work.",
        head: { ref: "fix-issue-42" },
      },
    });

    expect(taskStore.updateTaskPr).toHaveBeenCalledWith("42", 10, "fix-issue-42");
  });

  it("calls updateTaskPr with null branch when PR has no head ref", () => {
    const taskStore = makeTaskStore();
    taskQueue.addTask(baseTask);
    taskQueue.assignTask("42", "w1");

    const result = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      taskStore,
    });
    ({ wss } = result);

    result.routeEvent("evt-1", "pull_request", {
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
function restoreTasksFromDb(rows: TaskRow[], tq: TaskQueue): void {
  for (const row of rows) {
    if (row.status === "complete") continue;
    tq.addTask({
      taskId: row.taskId,
      issueNumber: row.issueNumber,
      title: row.title,
      body: "",
      labels: [],
      repoUrl: `https://github.com/${row.repo}`,
      status: row.status as TaskStatus,
      depsLoaded: true,
    });
    if (row.workerId) tq.assignTask(row.taskId, row.workerId);
    if (row.prNumber !== null) tq.registerPr(row.prNumber, row.taskId);
    if (row.branch) tq.registerBranch(row.branch, row.taskId);
  }
}

describe("startup — restore tasks from tasks table (DB is source of truth)", () => {
  it("assigned task from taskStore is visible in the snapshot", async () => {
    const taskStore = makeTaskStore([{ taskId: "42", workerId: "w1", status: "assigned" }]);

    ({ wss } = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      taskStore,
      reclaimTimeoutMs: 1000,
    }));

    port = await startServer();

    // Simulate new startup: just use taskStore.listTasks()
    const activeTasks = await taskStore.listTasks();
    restoreTasksFromDb(activeTasks, taskQueue);

    expect(taskQueue.get("42")?.status).toBe("assigned");
    expect(taskQueue.get("42")?.assignedWorkerId).toBe("w1");
    expect(taskQueue.get("42")?.title).toBe("Test task");
  });

  it("blocked task from taskStore is restored as blocked", async () => {
    const taskStore = makeTaskStore([{ taskId: "42", workerId: null, status: "blocked" }]);

    ({ wss } = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      taskStore,
      reclaimTimeoutMs: 1000,
    }));

    port = await startServer();

    const activeTasks = await taskStore.listTasks();
    restoreTasksFromDb(activeTasks, taskQueue);

    expect(taskQueue.get("42")?.status).toBe("blocked");
    expect(taskQueue.nextPending()).toBeNull(); // blocked tasks are not assignable
  });

  it("PR number and branch are restored from taskStore", async () => {
    const taskStore = makeTaskStore([{
      taskId: "42", workerId: "w1", status: "assigned",
      prNumber: 10, branch: "fix-42",
    }]);

    ({ wss } = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      taskStore,
      reclaimTimeoutMs: 1000,
    }));

    port = await startServer();

    const activeTasks = await taskStore.listTasks();
    restoreTasksFromDb(activeTasks, taskQueue);

    expect(taskQueue.getTaskForPr(10)?.taskId).toBe("42");
    expect(taskQueue.getTaskForBranch("fix-42")?.taskId).toBe("42");
  });

  it("complete tasks from taskStore are skipped", async () => {
    const taskStore = makeTaskStore([{ taskId: "42", workerId: null, status: "complete" }]);

    ({ wss } = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      taskStore,
      reclaimTimeoutMs: 1000,
    }));

    port = await startServer();

    const activeTasks = await taskStore.listTasks();
    restoreTasksFromDb(activeTasks, taskQueue);

    expect(taskQueue.get("42")).toBeUndefined();
  });
});

// ── Reconnect to complete task (issue closed while worker active) ─────────────

describe("startup — blocked status reconciliation after graph rebuild", () => {
  it("blocked task whose blocker closed while foreman was down becomes pending", async () => {
    const taskStore = makeTaskStore([{ taskId: "42", workerId: null, status: "blocked" }]);

    // Restore from DB: task is blocked
    const activeTasks = await taskStore.listTasks();
    restoreTasksFromDb(activeTasks, taskQueue);
    expect(taskQueue.get("42")?.status).toBe("blocked");

    // After GitHub reconcile: task 42 was blocked by issue 5, which is now closed
    const graph = new Map([[42, new Set([5])]]);
    const openIssues = new Set<number>(); // issue 5 is closed — not in openIssues

    // Simulate the startup reconciliation loop
    for (const t of taskQueue.getPendingAndBlockedTasks()) {
      if (t.status === "blocked" && !isBlocked(t.issueNumber, graph, openIssues)) {
        taskQueue.setUnblocked(t.taskId);
        taskStore.markPending(t.taskId).catch(() => {});
      } else if (t.status === "pending" && isBlocked(t.issueNumber, graph, openIssues)) {
        taskQueue.setBlocked(t.taskId);
        taskStore.markBlocked(t.taskId).catch(() => {});
      }
    }

    expect(taskQueue.get("42")?.status).toBe("pending");
    expect(taskStore.markPending).toHaveBeenCalledWith("42");
  });

  it("pending task whose blocker was open when foreman was down becomes blocked", async () => {
    const taskStore = makeTaskStore([{ taskId: "42", workerId: null, status: "pending" }]);

    const activeTasks = await taskStore.listTasks();
    restoreTasksFromDb(activeTasks, taskQueue);

    // After GitHub reconcile: issue 5 is still open and blocks task 42
    const graph = new Map([[42, new Set([5])]]);
    const openIssues = new Set([5]);

    for (const t of taskQueue.getPendingAndBlockedTasks()) {
      if (t.status === "blocked" && !isBlocked(t.issueNumber, graph, openIssues)) {
        taskQueue.setUnblocked(t.taskId);
        taskStore.markPending(t.taskId).catch(() => {});
      } else if (t.status === "pending" && isBlocked(t.issueNumber, graph, openIssues)) {
        taskQueue.setBlocked(t.taskId);
        taskStore.markBlocked(t.taskId).catch(() => {});
      }
    }

    expect(taskQueue.get("42")?.status).toBe("blocked");
    expect(taskStore.markBlocked).toHaveBeenCalledWith("42");
  });
});

describe("startup reconnect — worker reconnects to complete task", () => {
  it("busy worker reconnect to complete task is reclaimed (not re-idled)", async () => {
    // Simulate: issue was closed while worker was active, so the foreman marked
    // the task complete in-memory. Worker briefly disconnects and reconnects.
    taskQueue.addTask(baseTask);
    taskQueue.assignTask("42", "w1");
    taskQueue.completeTask("42"); // issue closed while worker was active

    ({ wss } = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      reclaimTimeoutMs: 1000,
    }));

    port = await startServer();
    await connect({ type: "worker_hello", workerId: "w1", status: "busy", taskId: "42" });

    await waitUntil(() => registry.get("w1") !== undefined);
    // Worker should be registered as busy, not idle
    expect(registry.get("w1")?.status).toBe("busy");
    // Task should stay complete
    expect(taskQueue.get("42")?.status).toBe("complete");
  });

  it("busy worker that calls task_complete on a complete task releases correctly", async () => {
    const taskStore = makeTaskStore();
    taskQueue.addTask(baseTask);
    taskQueue.assignTask("42", "w1");
    taskQueue.completeTask("42");

    ({ wss } = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      taskStore,
      reclaimTimeoutMs: 1000,
    }));

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
    const taskStore = makeTaskStore();
    taskQueue.addTask(baseTask);
    taskQueue.assignTask("42", "w1");

    ({ wss } = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      taskStore,
    }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "w1", status: "busy", taskId: "42" });

    await waitUntil(() => registry.get("w1")?.status === "busy");
    ws.send(JSON.stringify({ type: "task_complete", workerId: "w1", taskId: "42" }));
    await waitUntil(() => registry.get("w1")?.status === "idle");

    expect(taskStore.markComplete).toHaveBeenCalledWith("42");
  });
});
