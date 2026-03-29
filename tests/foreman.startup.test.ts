import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TaskQueue, WorkerRegistry, createForemanWss } from "../src/foreman.js";
import type { TaskAssignmentStore, TaskStore, TaskRow } from "../src/db.js";
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
    updateTaskPr: vi.fn().mockResolvedValue(undefined),
    listTasks: vi.fn().mockImplementation(async (opts?: { status?: string }) => {
      if (opts?.status) return full.filter((r) => r.status === opts.status);
      return full;
    }),
  };
}

function makeStore(overrides: Partial<TaskAssignmentStore> = {}): TaskAssignmentStore {
  return {
    upsertAssignment: vi.fn().mockResolvedValue(undefined),
    updatePr: vi.fn().mockResolvedValue(undefined),
    deleteAssignment: vi.fn().mockResolvedValue(undefined),
    listAssignments: vi.fn().mockResolvedValue([]),
    ...overrides,
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
  it("calls upsertAssignment before sending task_assigned", async () => {
    const callOrder: string[] = [];
    const store = makeStore({
      upsertAssignment: vi.fn().mockImplementation(async () => {
        callOrder.push("db");
      }),
    });

    taskQueue.addTask(baseTask);
    ({ wss } = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      assignStore: store,
    }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "w1", status: "idle" });
    const msg = await nextMsg(ws);
    callOrder.push("after-recv");

    expect(msg).toMatchObject({ type: "task_assigned", taskId: "42" });
    expect(store.upsertAssignment).toHaveBeenCalledWith("42", "w1");
    expect(callOrder[0]).toBe("db");
  });

  it("reverts task to pending if DB write fails", async () => {
    const store = makeStore({
      upsertAssignment: vi.fn().mockRejectedValue(new Error("db down")),
    });

    taskQueue.addTask(baseTask);
    ({ wss } = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      assignStore: store,
    }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "w1", status: "idle" });
    await waitUntil(() => registry.get("w1")?.status === "idle");

    expect(taskQueue.get("42")?.status).toBe("pending");
  });

  it("works transparently without assignStore (null store)", async () => {
    taskQueue.addTask(baseTask);
    ({ wss } = createForemanWss(taskQueue, registry, httpServer, { taskLabel: "brunel:ready" }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "w1", status: "idle" });
    const msg = await nextMsg(ws);

    expect(msg).toMatchObject({ type: "task_assigned", taskId: "42" });
  });
});

// ── Startup reconnect behaviour ───────────────────────────────────────────────

describe("startup reconnect behaviour", () => {
  it("idle worker whose task was loaded from DB triggers deleteAssignment and revert", async () => {
    // After revert, tryAssignWork will offer the task again (correct: worker starts fresh).
    const store = makeStore();
    taskQueue.addTask(baseTask);
    taskQueue.assignTask("42", "w1"); // simulate what main block does after loadAssignments

    ({ wss } = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      assignStore: store,
    }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "w1", status: "idle" });
    const msg = await nextMsg(ws);

    // deleteAssignment should be called (the old session's row is removed)
    expect(store.deleteAssignment).toHaveBeenCalledWith("42");
    // Worker gets the task re-assigned (fresh session — prior assignment was reverted)
    expect(msg).toMatchObject({ type: "task_assigned" });
  });

  it("a different idle worker does not steal a startup-assigned task", async () => {
    const store = makeStore();
    taskQueue.addTask(baseTask);
    taskQueue.assignTask("42", "original-worker"); // simulate startup loading

    ({ wss } = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      assignStore: store,
    }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "new-worker", status: "idle" });
    await waitUntil(() => registry.get("new-worker")?.status === "idle");

    // new-worker should NOT get task 42 — it belongs to original-worker
    expect(taskQueue.get("42")?.status).toBe("assigned");
    expect(taskQueue.get("42")?.assignedWorkerId).toBe("original-worker");
  });

  it("busy worker reconnect correctly reclaims its task", async () => {
    const store = makeStore();
    taskQueue.addTask(baseTask);
    taskQueue.assignTask("42", "w1");

    ({ wss } = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      assignStore: store,
    }));

    port = await startServer();
    await connect({ type: "worker_hello", workerId: "w1", status: "busy", taskId: "42" });

    await waitUntil(() => registry.get("w1")?.status === "busy");
    expect(taskQueue.get("42")?.status).toBe("assigned");
    expect(taskQueue.get("42")?.assignedWorkerId).toBe("w1");
    // deleteAssignment must NOT be called — worker reclaimed its task
    expect(store.deleteAssignment).not.toHaveBeenCalled();
  });
});

// ── PR tracking persistence ───────────────────────────────────────────────────

describe("PR tracking persistence", () => {
  it("calls updatePr when PR opened event is routed", () => {
    const store = makeStore();
    taskQueue.addTask(baseTask);
    taskQueue.assignTask("42", "w1");

    const result = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      assignStore: store,
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

    expect(store.updatePr).toHaveBeenCalledWith("42", 10, "fix-issue-42");
  });

  it("calls updatePr with null branch when PR has no head ref", () => {
    const store = makeStore();
    taskQueue.addTask(baseTask);
    taskQueue.assignTask("42", "w1");

    const result = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      assignStore: store,
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

    expect(store.updatePr).toHaveBeenCalledWith("42", 10, null);
  });
});

// ── Startup: restore task from taskStore when issue was closed mid-task ───────

describe("startup — restore task when issue closed mid-task", () => {
  it("task restored from taskStore is visible in the snapshot", async () => {
    // Simulate: task was assigned before foreman restart, issue was closed,
    // so labeledIssues/reconcile didn't add it. assignStore still has the row.
    // taskStore still has it as "assigned".
    const taskStore = makeTaskStore([{ taskId: "42", workerId: "w1" }]);
    const assignStore = makeStore({
      listAssignments: vi.fn().mockResolvedValue([
        { taskId: "42", workerId: "w1", prNumber: null, branch: null },
      ]),
    });

    ({ wss } = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      assignStore,
      taskStore,
      reclaimTimeoutMs: 1000,
    }));

    port = await startServer();

    // Simulate what startup does: call listTasks and then manually restore
    // (in production this is done in the main if (isMain) block).
    const assigned = await taskStore.listTasks({ status: "assigned" });
    const assignedMap = new Map(assigned.map((r) => [r.taskId, r]));
    const assignments = await assignStore.listAssignments();
    for (const row of assignments) {
      if (!taskQueue.get(row.taskId)) {
        const tr = assignedMap.get(row.taskId);
        if (tr) {
          taskQueue.addTask({
            taskId: tr.taskId, issueNumber: tr.issueNumber, title: tr.title,
            body: "", labels: [], repoUrl: `https://github.com/${tr.repo}`, depsLoaded: true,
          });
        }
      }
      taskQueue.assignTask(row.taskId, row.workerId);
    }

    // Task should now be in the queue as assigned
    expect(taskQueue.get("42")?.status).toBe("assigned");
    expect(taskQueue.get("42")?.assignedWorkerId).toBe("w1");
    expect(taskQueue.get("42")?.title).toBe("Test task");
  });

  it("orphaned assignment (task not in taskStore) is still deleted", async () => {
    // taskStore has no assigned task, but assignStore still has a row
    const taskStore = makeTaskStore([]); // empty
    const assignStore = makeStore({
      listAssignments: vi.fn().mockResolvedValue([
        { taskId: "99", workerId: "w1", prNumber: null, branch: null },
      ]),
    });

    ({ wss } = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      assignStore,
      taskStore,
      reclaimTimeoutMs: 1000,
    }));

    port = await startServer();

    // Simulate startup restore logic
    const assigned = await taskStore.listTasks({ status: "assigned" });
    const assignedMap = new Map(assigned.map((r) => [r.taskId, r]));
    const assignments = await assignStore.listAssignments();
    for (const row of assignments) {
      if (!taskQueue.get(row.taskId)) {
        const tr = assignedMap.get(row.taskId);
        if (!tr) {
          // Orphaned — delete
          assignStore.deleteAssignment(row.taskId);
          continue;
        }
        taskQueue.addTask({
          taskId: tr.taskId, issueNumber: tr.issueNumber, title: tr.title,
          body: "", labels: [], repoUrl: `https://github.com/${tr.repo}`, depsLoaded: true,
        });
      }
      taskQueue.assignTask(row.taskId, row.workerId);
    }

    expect(taskQueue.get("99")).toBeUndefined();
    expect(assignStore.deleteAssignment).toHaveBeenCalledWith("99");
  });
});

// ── Reconnect to complete task (issue closed while worker active) ─────────────

describe("startup reconnect — worker reconnects to complete task", () => {
  it("busy worker reconnect to complete task is reclaimed (not re-idled)", async () => {
    // Simulate: issue was closed while worker was active, so the foreman marked
    // the task complete in-memory. Worker briefly disconnects and reconnects.
    const store = makeStore();
    taskQueue.addTask(baseTask);
    taskQueue.assignTask("42", "w1");
    taskQueue.completeTask("42"); // issue closed while worker was active

    ({ wss } = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      assignStore: store,
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
    const store = makeStore();
    taskQueue.addTask(baseTask);
    taskQueue.assignTask("42", "w1");
    taskQueue.completeTask("42");

    ({ wss } = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      assignStore: store,
      reclaimTimeoutMs: 1000,
    }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "w1", status: "busy", taskId: "42" });

    await waitUntil(() => registry.get("w1") !== undefined);
    ws.send(JSON.stringify({ type: "task_complete", workerId: "w1", taskId: "42" }));
    await waitUntil(() => registry.get("w1")?.status === "idle");

    expect(store.deleteAssignment).toHaveBeenCalledWith("42");
  });
});

// ── task_complete deletes DB row ──────────────────────────────────────────────

describe("task_complete deletes DB row", () => {
  it("calls deleteAssignment when task_complete received", async () => {
    const store = makeStore();
    taskQueue.addTask(baseTask);
    taskQueue.assignTask("42", "w1");

    ({ wss } = createForemanWss(taskQueue, registry, httpServer, {
      taskLabel: "brunel:ready",
      assignStore: store,
    }));

    port = await startServer();
    const ws = await connect({ type: "worker_hello", workerId: "w1", status: "busy", taskId: "42" });

    await waitUntil(() => registry.get("w1")?.status === "busy");
    ws.send(JSON.stringify({ type: "task_complete", workerId: "w1", taskId: "42" }));
    await waitUntil(() => registry.get("w1")?.status === "idle");

    expect(store.deleteAssignment).toHaveBeenCalledWith("42");
  });
});
