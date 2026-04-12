/**
 * Unit tests for handleBusyHello and handleIdleHello.
 *
 * These functions were extracted from handleWorkerHello in wss.ts so that
 * each reconnection case can be verified without spinning up a real WebSocket
 * server.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleBusyHello, handleIdleHello } from "../src/foreman/controllers/wss.js";
import type { BusyHelloDeps, IdleHelloDeps } from "../src/foreman/controllers/wss.js";
import { Worker } from "../src/foreman/models/worker.js";
import { TaskManager } from "../src/foreman/models/task-manager.js";
import { setupInMemoryTasks } from "./helpers/task.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function fakeWs() {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
}

function makeBusyDeps(taskManager: TaskManager): BusyHelloDeps & {
  sendMsg: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  flog: ReturnType<typeof vi.fn>;
} {
  const sendMsg = vi.fn();
  const log = vi.fn();
  const flog = vi.fn();
  const deps: BusyHelloDeps = {
    ws: fakeWs(),
    taskManager,
    sendMsg,
    log,
    flog,
  };
  return Object.assign(deps, { sendMsg, log, flog });
}

function makeIdleDeps(): IdleHelloDeps & {
  sendMsg: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  flog: ReturnType<typeof vi.fn>;
} {
  const sendMsg = vi.fn();
  const log = vi.fn();
  const flog = vi.fn();
  const deps: IdleHelloDeps = {
    ws: fakeWs(),
    sendMsg,
    log,
    flog,
  };
  return Object.assign(deps, { sendMsg, log, flog });
}

/** Returns the hello_ack message from a sendMsg mock's calls. */
function helloAck(sendMsg: ReturnType<typeof vi.fn>) {
  const call = sendMsg.mock.calls.find(([, msg]) => msg.type === "hello_ack");
  return call ? (call[1] as { type: string; status: string }) : undefined;
}

// ── Test setup ─────────────────────────────────────────────────────────────────

let taskManager: TaskManager;
let addTask: ReturnType<typeof setupInMemoryTasks>["addTask"];

beforeEach(() => {
  Worker._reset();
  taskManager = new TaskManager();
  ({ addTask } = setupInMemoryTasks(taskManager));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── handleBusyHello ────────────────────────────────────────────────────────────

describe("handleBusyHello", () => {
  describe("unknown task", () => {
    it("numeric taskId — creates placeholder and sends busy ack", async () => {
      const deps = makeBusyDeps(taskManager);
      await handleBusyHello("w1", "42", deps);

      const ack = helloAck(deps.sendMsg);
      expect(ack?.status).toBe("busy");
      expect(Worker.get("w1")?.currentTaskId).toBe("42");
    });

    it("non-numeric taskId — sends cancelled ack", async () => {
      const deps = makeBusyDeps(taskManager);
      await handleBusyHello("w1", "not-a-number", deps);

      const ack = helloAck(deps.sendMsg);
      expect(ack?.status).toBe("cancelled");
    });
  });

  describe("complete task", () => {
    it("same worker — reclaims for finalization (busy ack, task.assign NOT called again)", async () => {
      const task = addTask({
        task_id: "10",
        issue_number: 10,
        worker_id: "w1",
        completed_at: new Date().toISOString(),
        assigned_at: new Date().toISOString(),
      });

      const deps = makeBusyDeps(taskManager);
      await handleBusyHello("w1", "10", deps);

      const ack = helloAck(deps.sendMsg);
      expect(ack?.status).toBe("busy");
      // task.assign must NOT be called because task is already complete
      expect(task.assign).not.toHaveBeenCalled();
      expect(Worker.get("w1")?.currentTaskId).toBe("10");
    });

    it("different worker — sends cancelled ack", async () => {
      addTask({
        task_id: "10",
        issue_number: 10,
        worker_id: "w2",
        completed_at: new Date().toISOString(),
        assigned_at: new Date().toISOString(),
      });

      const deps = makeBusyDeps(taskManager);
      await handleBusyHello("w1", "10", deps);

      const ack = helloAck(deps.sendMsg);
      expect(ack?.status).toBe("cancelled");
    });
  });

  describe("live task", () => {
    it("taken by a different worker — sends cancelled ack", async () => {
      addTask({
        task_id: "10",
        issue_number: 10,
        worker_id: "w2",
        assigned_at: new Date().toISOString(),
      });

      const deps = makeBusyDeps(taskManager);
      await handleBusyHello("w1", "10", deps);

      const ack = helloAck(deps.sendMsg);
      expect(ack?.status).toBe("cancelled");
    });

    it("owned by same worker — reclaims (busy ack, task.assign called)", async () => {
      const task = addTask({
        task_id: "10",
        issue_number: 10,
        worker_id: "w1",
        assigned_at: new Date().toISOString(),
      });

      const deps = makeBusyDeps(taskManager);
      await handleBusyHello("w1", "10", deps);

      const ack = helloAck(deps.sendMsg);
      expect(ack?.status).toBe("busy");
      expect(task.assign).toHaveBeenCalledWith("w1");
      expect(Worker.get("w1")?.currentTaskId).toBe("10");
    });

    it("unassigned — reclaims (busy ack, task.assign called)", async () => {
      const task = addTask({ task_id: "10", issue_number: 10 });

      const deps = makeBusyDeps(taskManager);
      await handleBusyHello("w1", "10", deps);

      const ack = helloAck(deps.sendMsg);
      expect(ack?.status).toBe("busy");
      expect(task.assign).toHaveBeenCalledWith("w1");
    });
  });

  describe("queued events", () => {
    it("flushes queued events after reclaim", async () => {
      addTask({
        task_id: "10",
        issue_number: 10,
        worker_id: "w1",
        assigned_at: new Date().toISOString(),
      });

      // Queue an event manually via the task manager
      taskManager.queueEvent("10", { toWorkerPayload: () => ({ name: "issue_comment", payload: {} }), eventName: "issue_comment" } as any);

      const deps = makeBusyDeps(taskManager);
      await handleBusyHello("w1", "10", deps);

      const eventNotifs = deps.sendMsg.mock.calls.filter(
        ([, msg]) => (msg as { type: string }).type === "event_notification"
      );
      expect(eventNotifs).toHaveLength(1);
    });
  });
});

// ── handleIdleHello ────────────────────────────────────────────────────────────

describe("handleIdleHello", () => {
  it("no prior task — registers worker and sends idle ack", async () => {
    const deps = makeIdleDeps();
    await handleIdleHello("w1", deps);

    const ack = helloAck(deps.sendMsg);
    expect(ack?.status).toBe("idle");
    expect(Worker.get("w1")?.status).toBe("idle");
  });

  it("has prior task — reverts it and sends idle ack", async () => {
    const task = addTask({
      task_id: "10",
      issue_number: 10,
      worker_id: "w1",
      assigned_at: new Date().toISOString(),
    });

    const deps = makeIdleDeps();
    await handleIdleHello("w1", deps);

    expect(task.revert).toHaveBeenCalled();
    const ack = helloAck(deps.sendMsg);
    expect(ack?.status).toBe("idle");
    expect(Worker.get("w1")?.status).toBe("idle");
  });

  it("revert failure is logged but does not throw", async () => {
    const task = addTask({
      task_id: "10",
      issue_number: 10,
      worker_id: "w1",
      assigned_at: new Date().toISOString(),
    });
    vi.mocked(task.revert).mockRejectedValueOnce(new Error("DB down"));

    const deps = makeIdleDeps();
    await expect(handleIdleHello("w1", deps)).resolves.toBeUndefined();
    expect(deps.flog).toHaveBeenCalledWith(expect.stringContaining("ERROR"));
  });
});
