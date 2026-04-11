/**
 * Unit tests for forwardEvent — the function that decides whether to send or
 * queue a GitHub event to a worker.
 *
 * Covers the bug reported in issue #601: comments on a completed task were
 * forwarded to the worker that had moved on to a new task. The fix checks the
 * registry's currentTaskId rather than task status — mirroring the worker-side
 * guard — so any case where the worker has moved on is caught.
 */
import { describe, it, expect, vi } from "vitest";
import { forwardEvent } from "../src/foreman/controllers/event-router.js";
import type { EventRouterDeps } from "../src/foreman/controllers/event-router.js";
import { Task } from "../src/foreman/models/task.js";
import type { GitHubEvent } from "../src/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeEvent(name = "issue_comment"): GitHubEvent {
  return { id: "evt-1", name, payload: {} };
}

function makeDeps(registryGet: ReturnType<typeof vi.fn> = vi.fn()): EventRouterDeps & { sendMsg: ReturnType<typeof vi.fn>; queueEvent: ReturnType<typeof vi.fn>; flog: ReturnType<typeof vi.fn> } {
  const queueEvent = vi.fn();
  const sendMsg = vi.fn();
  const flog = vi.fn();
  return {
    taskManager: { queueEvent } as unknown as EventRouterDeps["taskManager"],
    registry: { get: registryGet } as unknown as EventRouterDeps["registry"],
    repo: "owner/repo",
    token: "token",
    taskLabel: "brunel:ready",
    sendMsg,
    flog,
    assignIdleWorkers: vi.fn().mockResolvedValue(undefined),
    queueEvent,
  } as unknown as ReturnType<typeof makeDeps>;
}

/** Registry returns a worker currently assigned to the given task. */
function workerOnTask(taskId: string) {
  return vi.fn().mockReturnValue({ status: "busy", currentTaskId: taskId });
}

/** Registry returns a worker that has moved on to a different task (or is idle). */
function workerOnDifferentTask() {
  return vi.fn().mockReturnValue({ status: "busy", currentTaskId: "other-task-id" });
}

/** Registry returns a worker that is idle (currentTaskId cleared after completion). */
function idleWorker() {
  return vi.fn().mockReturnValue({ status: "idle", currentTaskId: undefined });
}

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
    const deps = makeDeps(workerOnDifferentTask());

    forwardEvent(deps, task, makeEvent(), "#42");

    expect(deps.sendMsg).not.toHaveBeenCalled();
    expect(deps.taskManager.queueEvent).not.toHaveBeenCalled();
  });

  it("drops the event when the registry shows the worker is now idle (task completed, no new task yet)", () => {
    const task = Task.fromTest({
      task_id: "42",
      issue_number: 42,
      worker_id: "worker-1",
      completed_at: new Date().toISOString(),
    });
    const deps = makeDeps(idleWorker());

    forwardEvent(deps, task, makeEvent(), "#42");

    expect(deps.sendMsg).not.toHaveBeenCalled();
    expect(deps.taskManager.queueEvent).not.toHaveBeenCalled();
  });

  it("logs a drop message when the worker has moved on", () => {
    const task = Task.fromTest({
      task_id: "42",
      issue_number: 42,
      worker_id: "worker-1",
      completed_at: new Date().toISOString(),
    });
    const deps = makeDeps(workerOnDifferentTask());

    forwardEvent(deps, task, makeEvent("issue_comment"), "#42");

    expect(deps.flog).toHaveBeenCalledWith(expect.stringContaining("dropped"));
    expect(deps.flog).toHaveBeenCalledWith(expect.stringContaining("different task"));
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
    const deps = makeDeps(workerOnTask("42"));

    forwardEvent(deps, task, makeEvent(), "#42");

    expect(deps.sendMsg).toHaveBeenCalledOnce();
    expect(deps.sendMsg).toHaveBeenCalledWith(
      "worker-1",
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
    const deps = makeDeps(workerOnTask("42"));

    forwardEvent(deps, task, makeEvent(), "#42");

    expect(deps.sendMsg).toHaveBeenCalledOnce();
    expect(deps.flog).not.toHaveBeenCalledWith(expect.stringContaining("dropped"));
  });

  it("still forwards events when the task's issue is closed but worker is still on it", () => {
    const task = Task.fromTest({
      task_id: "42",
      issue_number: 42,
      worker_id: "worker-1",
      issue_closed_at: new Date().toISOString(),
    });
    const deps = makeDeps(workerOnTask("42"));

    forwardEvent(deps, task, makeEvent(), "#42");

    expect(deps.sendMsg).toHaveBeenCalledOnce();
    expect(deps.flog).not.toHaveBeenCalledWith(expect.stringContaining("dropped"));
  });

  it("queues event for a pending task with no worker", () => {
    const task = Task.fromTest({ task_id: "42", issue_number: 42 });
    task.blockersLoaded = true; // no open blockers → status is "pending"
    const deps = makeDeps();

    forwardEvent(deps, task, makeEvent(), "#42");

    expect(deps.taskManager.queueEvent).toHaveBeenCalledOnce();
    expect(deps.sendMsg).not.toHaveBeenCalled();
  });
});
