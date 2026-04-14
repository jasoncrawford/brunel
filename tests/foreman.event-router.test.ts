/**
 * Unit tests for forwardEvent — the function that decides whether to
 * send or queue a GitHub event to a worker.
 *
 * Covers the bug reported in issue #601: comments on a completed task were
 * forwarded to the worker that had moved on to a new task. The fix checks the
 * registry's currentTaskId rather than task status — mirroring the worker-side
 * guard — so any case where the worker has moved on is caught.
 */
import http from "http";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ForemanWss } from "../src/foreman/controllers/wss.js";
import { Task } from "../src/foreman/models/task.js";
import { Worker } from "../src/foreman/models/worker.js";
import { WebhookEvent } from "../src/foreman/models/webhook-event.js";
import * as utils from "../src/utils.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function fakeWs() {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
}

function makeEvent(name = "issue_comment"): WebhookEvent {
  return WebhookEvent.fromIncoming("evt-1", name, {});
}

function makeWss(taskManager: any): { wss: ForemanWss; sendMsg: ReturnType<typeof vi.fn> } {
  const wss = new ForemanWss({
    config: { taskLabel: "brunel:ready", githubRepo: "owner/repo", githubToken: "token", workerSecret: undefined, pingIntervalMs: 1e9 },
    taskManager,
    server: http.createServer(),
  });
  const sendMsg = vi.spyOn(wss, "sendMsg").mockImplementation(() => {});
  return { wss, sendMsg };
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  Worker._reset();
  logSpy = vi.spyOn(utils, "log").mockImplementation(() => {});
});

afterEach(() => { vi.restoreAllMocks(); });

// ── Core bug fix: worker that has moved on ─────────────────────────────────────

describe("forwardEvent — worker has moved on to a different task", () => {
  it("drops the event when the registry shows the worker is now on a different task", () => {
    // Simulates the bug: task T1 completes, worker is assigned T2,
    // but task.workerId for T1 still points to that worker.
    const task = Task.fromTest({
      task_id: "42",
      issue_number: 42,
      worker_id: "worker-1",
      completed_at: new Date().toISOString(),
    });
    const w = Worker.register("worker-1", fakeWs());
    w.assign(Task.fromTest({ task_id: "other-task-id", issue_number: 999 })); // worker has moved on to a different task
    const taskManager = { queueEvent: vi.fn(), assignIdleWorkers: vi.fn().mockResolvedValue([]), on: vi.fn() };
    const { wss, sendMsg } = makeWss(taskManager);

    wss.forwardEvent(task, makeEvent(), "#42");

    expect(sendMsg).not.toHaveBeenCalled();
    expect(taskManager.queueEvent).not.toHaveBeenCalled();
  });

  it("drops the event when the registry shows the worker is now idle (task completed, no new task yet)", () => {
    const task = Task.fromTest({
      task_id: "42",
      issue_number: 42,
      worker_id: "worker-1",
      completed_at: new Date().toISOString(),
    });
    Worker.register("worker-1", fakeWs()); // idle with no currentTaskId
    const taskManager = { queueEvent: vi.fn(), assignIdleWorkers: vi.fn().mockResolvedValue([]), on: vi.fn() };
    const { wss, sendMsg } = makeWss(taskManager);

    wss.forwardEvent(task, makeEvent(), "#42");

    expect(sendMsg).not.toHaveBeenCalled();
    expect(taskManager.queueEvent).not.toHaveBeenCalled();
  });

  it("logs a drop message when the worker has moved on", () => {
    const task = Task.fromTest({
      task_id: "42",
      issue_number: 42,
      worker_id: "worker-1",
      completed_at: new Date().toISOString(),
    });
    const w = Worker.register("worker-1", fakeWs());
    w.assign(Task.fromTest({ task_id: "other-task-id", issue_number: 999 })); // worker has moved on to a different task
    const taskManager = { queueEvent: vi.fn(), assignIdleWorkers: vi.fn().mockResolvedValue([]), on: vi.fn() };
    const { wss } = makeWss(taskManager);

    wss.forwardEvent(task, makeEvent("issue_comment"), "#42");

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("dropped"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("different task"));
  });
});

// ── Active tasks still receive events (regression guard) ───────────────────────

describe("forwardEvent — active tasks still receive events", () => {
  it("forwards the event when the registry confirms the worker is still on this task", () => {
    const task = Task.fromTest({
      task_id: "42",
      issue_number: 42,
      worker_id: "worker-1",
    });
    const w = Worker.register("worker-1", fakeWs());
    w.assign(task);
    const taskManager = { queueEvent: vi.fn(), assignIdleWorkers: vi.fn().mockResolvedValue([]), on: vi.fn() };
    const { wss, sendMsg } = makeWss(taskManager);

    wss.forwardEvent(task, makeEvent(), "#42");

    expect(sendMsg).toHaveBeenCalledOnce();
    expect(sendMsg).toHaveBeenCalledWith(
      expect.objectContaining({ workerId: "worker-1" }),
      expect.objectContaining({ type: "event_notification" }),
    );
  });

  it("still forwards events to the worker when the task's PR is merged", () => {
    // PR merged ≠ task complete; the worker may still be doing cleanup work.
    const task = Task.fromTest({
      task_id: "42",
      issue_number: 42,
      worker_id: "worker-1",
      pr_merged_at: new Date().toISOString(),
    });
    const w = Worker.register("worker-1", fakeWs());
    w.assign(task);
    const taskManager = { queueEvent: vi.fn(), assignIdleWorkers: vi.fn().mockResolvedValue([]), on: vi.fn() };
    const { wss, sendMsg } = makeWss(taskManager);

    wss.forwardEvent(task, makeEvent(), "#42");

    expect(sendMsg).toHaveBeenCalledOnce();
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("dropped"));
  });

  it("still forwards events when the task's issue is closed but worker is still on it", () => {
    const task = Task.fromTest({
      task_id: "42",
      issue_number: 42,
      worker_id: "worker-1",
      issue_closed_at: new Date().toISOString(),
    });
    const w = Worker.register("worker-1", fakeWs());
    w.assign(task);
    const taskManager = { queueEvent: vi.fn(), assignIdleWorkers: vi.fn().mockResolvedValue([]), on: vi.fn() };
    const { wss, sendMsg } = makeWss(taskManager);

    wss.forwardEvent(task, makeEvent(), "#42");

    expect(sendMsg).toHaveBeenCalledOnce();
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("dropped"));
  });

  it("queues event for a pending task with no worker", () => {
    const task = Task.fromTest({ task_id: "42", issue_number: 42 });
    task.blockersLoaded = true; // no open blockers → status is "pending"
    const taskManager = { queueEvent: vi.fn(), assignIdleWorkers: vi.fn().mockResolvedValue([]), on: vi.fn() };
    const { wss, sendMsg } = makeWss(taskManager);

    wss.forwardEvent(task, makeEvent(), "#42");

    expect(taskManager.queueEvent).toHaveBeenCalledOnce();
    expect(sendMsg).not.toHaveBeenCalled();
  });
});
