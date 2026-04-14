/**
 * Unit tests for ForemanWss.handleBusyHello and ForemanWss.handleIdleHello.
 *
 * Each reconnection case is verified by calling the public methods directly on
 * a ForemanWss instance with sendMsg spied out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import { ForemanWss } from "../src/foreman/controllers/wss.js";
import { Worker } from "../src/foreman/models/worker.js";
import { TaskManager } from "../src/foreman/models/task-manager.js";
import { setupInMemoryTasks } from "./helpers/task.js";
import * as utils from "../src/utils.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function fakeWs() {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
}

function makeWss(taskManager: TaskManager) {
  const wss = new ForemanWss({
    config: { taskLabel: "brunel:ready", githubRepo: "owner/repo", githubToken: "token", workerSecret: undefined, pingIntervalMs: 1e9 },
    taskManager,
    server: http.createServer(),
  });
  const sendMsg = vi.spyOn(wss, "sendMsg").mockImplementation(() => {});
  return { wss, sendMsg };
}

/** Returns the hello_ack message from a sendMsg spy's calls. */
function helloAck(sendMsg: ReturnType<typeof vi.spyOn>) {
  const call = sendMsg.mock.calls.find(([, msg]) => (msg as { type: string }).type === "hello_ack");
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
      const { wss, sendMsg } = makeWss(taskManager);
      await wss.handleBusyHello("w1", "42", fakeWs());

      const ack = helloAck(sendMsg);
      expect(ack?.status).toBe("busy");
      expect(Worker.get("w1")?.currentTaskId).toBe("42");
    });

    it("non-numeric taskId — sends cancelled ack", async () => {
      const { wss, sendMsg } = makeWss(taskManager);
      await wss.handleBusyHello("w1", "not-a-number", fakeWs());

      const ack = helloAck(sendMsg);
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

      const { wss, sendMsg } = makeWss(taskManager);
      await wss.handleBusyHello("w1", "10", fakeWs());

      const ack = helloAck(sendMsg);
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

      const { wss, sendMsg } = makeWss(taskManager);
      await wss.handleBusyHello("w1", "10", fakeWs());

      const ack = helloAck(sendMsg);
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

      const { wss, sendMsg } = makeWss(taskManager);
      await wss.handleBusyHello("w1", "10", fakeWs());

      const ack = helloAck(sendMsg);
      expect(ack?.status).toBe("cancelled");
    });

    it("owned by same worker — reclaims (busy ack, task.assign called)", async () => {
      const task = addTask({
        task_id: "10",
        issue_number: 10,
        worker_id: "w1",
        assigned_at: new Date().toISOString(),
      });

      const { wss, sendMsg } = makeWss(taskManager);
      await wss.handleBusyHello("w1", "10", fakeWs());

      const ack = helloAck(sendMsg);
      expect(ack?.status).toBe("busy");
      expect(task.assign).toHaveBeenCalledWith(expect.objectContaining({ workerId: "w1" }));
      expect(Worker.get("w1")?.currentTaskId).toBe("10");
    });

    it("unassigned — reclaims (busy ack, task.assign called)", async () => {
      const task = addTask({ task_id: "10", issue_number: 10 });

      const { wss, sendMsg } = makeWss(taskManager);
      await wss.handleBusyHello("w1", "10", fakeWs());

      const ack = helloAck(sendMsg);
      expect(ack?.status).toBe("busy");
      expect(task.assign).toHaveBeenCalledWith(expect.objectContaining({ workerId: "w1" }));
    });
  });

  describe("queued events", () => {
    it("flushes queued events after reclaim", async () => {
      const task = addTask({
        task_id: "10",
        issue_number: 10,
        worker_id: "w1",
        assigned_at: new Date().toISOString(),
      });

      // Queue an event manually via the task manager
      taskManager.queueEvent(task, { toWorkerPayload: () => ({ name: "issue_comment", payload: {} }), eventName: "issue_comment" } as any);

      const { wss, sendMsg } = makeWss(taskManager);
      await wss.handleBusyHello("w1", "10", fakeWs());

      const eventNotifs = sendMsg.mock.calls.filter(
        ([, msg]) => (msg as { type: string }).type === "event_notification"
      );
      expect(eventNotifs).toHaveLength(1);
    });
  });
});

// ── handleIdleHello ────────────────────────────────────────────────────────────

describe("handleIdleHello", () => {
  it("no prior task — registers worker and sends idle ack", async () => {
    const { wss, sendMsg } = makeWss(taskManager);
    await wss.handleIdleHello("w1", fakeWs());

    const ack = helloAck(sendMsg);
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

    const { wss, sendMsg } = makeWss(taskManager);
    await wss.handleIdleHello("w1", fakeWs());

    expect(task.revert).toHaveBeenCalled();
    const ack = helloAck(sendMsg);
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

    const { wss } = makeWss(taskManager);
    const logSpy = vi.spyOn(utils, "log").mockImplementation(() => {});
    await expect(wss.handleIdleHello("w1", fakeWs())).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("ERROR"));
  });
});
