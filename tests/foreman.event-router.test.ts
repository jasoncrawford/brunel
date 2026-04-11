/**
 * Unit tests for forwardEvent — the function that decides whether to send or
 * queue a GitHub event to a worker.
 *
 * Covers the bug reported in issue #601: comments on a completed task were
 * forwarded to the worker that completed it (because task.workerId is still
 * set after completion but the task status is "complete").
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

function connectedWorker() {
  return vi.fn().mockReturnValue({ status: "connected" });
}

// ── Tests for terminal task states ─────────────────────────────────────────────

describe("forwardEvent — completed/closed/merged tasks", () => {
  it("does not forward events to the worker when the task is complete", () => {
    // A completed task still has workerId set (complete() only sets completedAt).
    const task = Task.fromTest({
      task_id: "42",
      issue_number: 42,
      worker_id: "worker-1",
      completed_at: new Date().toISOString(),
    });
    const deps = makeDeps(connectedWorker());

    forwardEvent(deps, task, makeEvent(), "#42");

    expect(deps.sendMsg).not.toHaveBeenCalled();
    expect(deps.taskManager.queueEvent).not.toHaveBeenCalled();
  });

  it("does not queue events for closed tasks (no worker assigned)", () => {
    const task = Task.fromTest({
      task_id: "42",
      issue_number: 42,
      issue_closed_at: new Date().toISOString(),
    });
    const deps = makeDeps();

    forwardEvent(deps, task, makeEvent(), "#42");

    expect(deps.sendMsg).not.toHaveBeenCalled();
    expect(deps.taskManager.queueEvent).not.toHaveBeenCalled();
  });

  it("does not forward events to the worker when the task's PR is merged", () => {
    const task = Task.fromTest({
      task_id: "42",
      issue_number: 42,
      worker_id: "worker-1",
      pr_merged_at: new Date().toISOString(),
    });
    const deps = makeDeps(connectedWorker());

    forwardEvent(deps, task, makeEvent(), "#42");

    expect(deps.sendMsg).not.toHaveBeenCalled();
    expect(deps.taskManager.queueEvent).not.toHaveBeenCalled();
  });

  it("logs a drop message for completed tasks", () => {
    const task = Task.fromTest({
      task_id: "42",
      issue_number: 42,
      worker_id: "worker-1",
      completed_at: new Date().toISOString(),
    });
    const deps = makeDeps(connectedWorker());

    forwardEvent(deps, task, makeEvent("issue_comment"), "#42");

    expect(deps.flog).toHaveBeenCalledWith(expect.stringContaining("dropped"));
    expect(deps.flog).toHaveBeenCalledWith(expect.stringContaining("complete"));
  });
});

// ── Tests for active task states (regression guard) ────────────────────────────

describe("forwardEvent — active tasks still receive events", () => {
  it("sends event_notification to a connected worker for an assigned task", () => {
    const task = Task.fromTest({
      task_id: "42",
      issue_number: 42,
      worker_id: "worker-1",
    });
    const deps = makeDeps(connectedWorker());

    forwardEvent(deps, task, makeEvent(), "#42");

    expect(deps.sendMsg).toHaveBeenCalledOnce();
    expect(deps.sendMsg).toHaveBeenCalledWith(
      "worker-1",
      expect.objectContaining({ type: "event_notification" }),
    );
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
