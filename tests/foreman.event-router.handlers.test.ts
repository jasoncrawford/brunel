/**
 * Unit tests for the per-event-type routing functions:
 * routePrEvent, routePrReviewEvent, routeCheckEvent, routeIssueEvent.
 */
import http from "http";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ForemanWss } from "../src/foreman/controllers/wss.js";
import { TaskManager } from "../src/foreman/models/task-manager.js";
import { Task } from "../src/foreman/models/task.js";
import { Worker } from "../src/foreman/models/worker.js";
import { WebhookEvent } from "../src/foreman/models/webhook-event.js";
import { resetDb, seedTask, createTestRepo } from "./helpers/task.js";
import * as utils from "../src/utils.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function fakeWs() {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
}

function makeEvent(name = "pull_request"): WebhookEvent {
  return WebhookEvent.fromIncoming("evt-1", name, {});
}

interface TestDeps {
  wss: ForemanWss;
  sendMsg: ReturnType<typeof vi.fn>;
  forwardEvent: ReturnType<typeof vi.spyOn>;
  taskManager: TaskManager;
}

async function makeDeps(): Promise<TestDeps> {
  const repo = await createTestRepo("owner/repo");
  const taskManager = repo.taskManager;
  // Spy on all TaskManager methods so the tests can assert calls without side effects
  vi.spyOn(taskManager, "queueEvent").mockImplementation(() => {});
  vi.spyOn(taskManager, "dequeueIssue").mockResolvedValue(undefined);
  vi.spyOn(taskManager, "closeIssue").mockResolvedValue(undefined);
  vi.spyOn(taskManager, "reopenIssue").mockResolvedValue(undefined);
  vi.spyOn(taskManager, "assignIdleWorkers").mockResolvedValue([]);
  vi.spyOn(taskManager, "handleIssueLabeledEvent").mockResolvedValue(null);
  vi.spyOn(taskManager, "handleIssueBodyEditedEvent").mockImplementation(() => {});
  vi.spyOn(taskManager, "handlePrOpenedEvent").mockResolvedValue(null);
  vi.spyOn(taskManager, "handlePrClosedEvent").mockResolvedValue(null);
  vi.spyOn(taskManager, "getTaskForCheckEvent").mockResolvedValue(null);
  const wss = new ForemanWss({
    config: { taskLabel: "brunel:ready", githubRepo: "owner/repo", githubToken: "token", workerSecret: undefined, pingIntervalMs: 1e9 },
    server: http.createServer(),
  });
  const sendMsg = vi.spyOn(wss, "sendMsg").mockImplementation(() => {});
  const forwardEvent = vi.spyOn(wss, "forwardEvent");
  return { wss, sendMsg, forwardEvent, taskManager };
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  Worker._reset();
  resetDb();
  logSpy = vi.spyOn(utils, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── routePrEvent ──────────────────────────────────────────────────────────────

describe("routePrEvent — missing PR number", () => {
  it("returns null task when pull_request has no number", async () => {
    const { wss, forwardEvent } = await makeDeps();
    const result = await wss.routePrEvent({ pull_request: {} }, makeEvent());
    expect(result).toEqual({ taskId: null, workerId: null });
    expect(forwardEvent).not.toHaveBeenCalled();
  });
});

describe("routePrEvent — synchronize", () => {
  it("returns the task without forwarding when action is synchronize", async () => {
    await seedTask({ task_id: "42", issue_number: 42, pr_number: 99 });
    const { wss, sendMsg, forwardEvent } = await makeDeps();
    const result = await wss.routePrEvent(
      { action: "synchronize", pull_request: { number: 99 } },
      makeEvent(),
    );
    expect(result.taskId).toBe("42");
    expect(sendMsg).not.toHaveBeenCalled();
    expect(forwardEvent).not.toHaveBeenCalled();
  });
});

describe("routePrEvent — opened", () => {
  it("calls handlePrOpenedEvent and forwards event when a linked task is found", async () => {
    const w = Worker.register("worker-1", fakeWs());
    const task = await seedTask({ task_id: "42", issue_number: 42, worker_id: "worker-1", assigned_at: new Date().toISOString() });
    w.assign(task);
    const { wss, sendMsg, forwardEvent, taskManager } = await makeDeps();
    taskManager.handlePrOpenedEvent.mockResolvedValue(task);
    const result = await wss.routePrEvent(
      {
        action: "opened",
        pull_request: {
          number: 99,
          body: "Closes #42",
          head: { ref: "feature-branch" },
        },
      },
      makeEvent(),
    );
    expect(taskManager.handlePrOpenedEvent).toHaveBeenCalledWith(99, "Closes #42", "feature-branch");
    expect(forwardEvent).toHaveBeenCalledOnce();
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("returns null when handlePrOpenedEvent finds no linked issue", async () => {
    const { wss, sendMsg, forwardEvent, taskManager } = await makeDeps();
    taskManager.handlePrOpenedEvent.mockResolvedValue(null);
    const result = await wss.routePrEvent(
      { action: "opened", pull_request: { number: 99, body: "no link here", head: { ref: "branch" } } },
      makeEvent(),
    );
    expect(result).toEqual({ taskId: null, workerId: null });
    expect(forwardEvent).not.toHaveBeenCalled();
    expect(sendMsg).not.toHaveBeenCalled();
  });
});

describe("routePrEvent — closed without merge", () => {
  it("calls handlePrClosedEvent and forwards the event to the task", async () => {
    const w = Worker.register("worker-1", fakeWs());
    const task = await seedTask({ task_id: "42", issue_number: 42, pr_number: 99, worker_id: "worker-1", assigned_at: new Date().toISOString() });
    w.assign(task);
    const { wss, sendMsg, forwardEvent, taskManager } = await makeDeps();
    taskManager.handlePrClosedEvent.mockResolvedValue(task);
    const result = await wss.routePrEvent(
      { action: "closed", pull_request: { number: 99, merged: false } },
      makeEvent(),
    );
    expect(taskManager.handlePrClosedEvent).toHaveBeenCalledWith(99, false);
    expect(forwardEvent).toHaveBeenCalledOnce();
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("returns null when no task owns the PR", async () => {
    const { wss, forwardEvent, taskManager } = await makeDeps();
    taskManager.handlePrClosedEvent.mockResolvedValue(null);
    const result = await wss.routePrEvent(
      { action: "closed", pull_request: { number: 99, merged: false } },
      makeEvent(),
    );
    expect(result).toEqual({ taskId: null, workerId: null });
    expect(forwardEvent).not.toHaveBeenCalled();
  });
});

describe("routePrEvent — closed with merge", () => {
  it("calls handlePrClosedEvent with merged=true and forwards the event", async () => {
    const w = Worker.register("worker-1", fakeWs());
    const task = await seedTask({ task_id: "42", issue_number: 42, pr_number: 99, worker_id: "worker-1", assigned_at: new Date().toISOString() });
    w.assign(task);
    const { wss, sendMsg, forwardEvent, taskManager } = await makeDeps();
    taskManager.handlePrClosedEvent.mockResolvedValue(task);
    const result = await wss.routePrEvent(
      { action: "closed", pull_request: { number: 99, merged: true } },
      makeEvent(),
    );
    expect(taskManager.handlePrClosedEvent).toHaveBeenCalledWith(99, true);
    expect(forwardEvent).toHaveBeenCalledOnce();
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("returns null when no task owns the PR", async () => {
    const { wss, forwardEvent } = await makeDeps();
    const result = await wss.routePrEvent(
      { action: "closed", pull_request: { number: 99, merged: true } },
      makeEvent(),
    );
    expect(result).toEqual({ taskId: null, workerId: null });
    expect(forwardEvent).not.toHaveBeenCalled();
  });
});

describe("routePrEvent — passthrough", () => {
  it("forwards other PR events to the task", async () => {
    const w = Worker.register("worker-1", fakeWs());
    const task = await seedTask({ task_id: "42", issue_number: 42, pr_number: 99, worker_id: "worker-1", assigned_at: new Date().toISOString() });
    w.assign(task);
    const { wss, sendMsg, forwardEvent } = await makeDeps();
    const result = await wss.routePrEvent(
      { action: "labeled", pull_request: { number: 99 } },
      makeEvent(),
    );
    expect(forwardEvent).toHaveBeenCalledOnce();
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("returns null task when no task owns the PR", async () => {
    const { wss, forwardEvent } = await makeDeps();
    const result = await wss.routePrEvent(
      { action: "labeled", pull_request: { number: 99 } },
      makeEvent(),
    );
    expect(result).toEqual({ taskId: null, workerId: null });
    expect(forwardEvent).not.toHaveBeenCalled();
  });
});

// ── routePrReviewEvent ────────────────────────────────────────────────────────

describe("routePrReviewEvent", () => {
  it("returns null when PR number is missing", async () => {
    const { wss, forwardEvent } = await makeDeps();
    const result = await wss.routePrReviewEvent({ pull_request: {} }, makeEvent("pull_request_review"));
    expect(result).toEqual({ taskId: null, workerId: null });
    expect(forwardEvent).not.toHaveBeenCalled();
  });

  it("forwards review events to the task that owns the PR", async () => {
    const w = Worker.register("worker-1", fakeWs());
    const task = await seedTask({ task_id: "42", issue_number: 42, pr_number: 99, worker_id: "worker-1", assigned_at: new Date().toISOString() });
    w.assign(task);
    const { wss, sendMsg, forwardEvent } = await makeDeps();
    const result = await wss.routePrReviewEvent(
      { pull_request: { number: 99 } },
      makeEvent("pull_request_review"),
    );
    expect(forwardEvent).toHaveBeenCalledOnce();
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("returns null when no task owns the reviewed PR", async () => {
    const { wss, forwardEvent } = await makeDeps();
    const result = await wss.routePrReviewEvent(
      { pull_request: { number: 99 } },
      makeEvent("pull_request_review"),
    );
    expect(result).toEqual({ taskId: null, workerId: null });
    expect(forwardEvent).not.toHaveBeenCalled();
  });
});

// ── routeCheckEvent ───────────────────────────────────────────────────────────

describe("routeCheckEvent — via PR number", () => {
  it("forwards check_run to the task when getTaskForCheckEvent finds it by PR", async () => {
    const w = Worker.register("worker-1", fakeWs());
    const task = await seedTask({ task_id: "42", issue_number: 42, pr_number: 99, worker_id: "worker-1", assigned_at: new Date().toISOString() });
    w.assign(task);
    const { wss, sendMsg, forwardEvent, taskManager } = await makeDeps();
    taskManager.getTaskForCheckEvent.mockResolvedValue({ task, ref: "PR #99" });
    const result = await wss.routeCheckEvent(
      { check_run: { pull_requests: [{ number: 99 }] } },
      makeEvent("check_run"),
      "check_run",
    );
    expect(taskManager.getTaskForCheckEvent).toHaveBeenCalledWith([99], "");
    expect(forwardEvent).toHaveBeenCalledOnce();
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("forwards check_suite to the task when getTaskForCheckEvent finds it by PR", async () => {
    const w = Worker.register("worker-1", fakeWs());
    const task = await seedTask({ task_id: "42", issue_number: 42, pr_number: 99, worker_id: "worker-1", assigned_at: new Date().toISOString() });
    w.assign(task);
    const { wss, sendMsg, forwardEvent, taskManager } = await makeDeps();
    taskManager.getTaskForCheckEvent.mockResolvedValue({ task, ref: "PR #99" });
    const result = await wss.routeCheckEvent(
      { check_suite: { pull_requests: [{ number: 99 }] } },
      makeEvent("check_suite"),
      "check_suite",
    );
    expect(taskManager.getTaskForCheckEvent).toHaveBeenCalledWith([99], "");
    expect(forwardEvent).toHaveBeenCalledOnce();
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });
});

describe("routeCheckEvent — via branch name", () => {
  it("passes head_branch to getTaskForCheckEvent for check_run", async () => {
    const w = Worker.register("worker-1", fakeWs());
    const task = await seedTask({ task_id: "42", issue_number: 42, worker_id: "worker-1", assigned_at: new Date().toISOString() });
    w.assign(task);
    const { wss, sendMsg, forwardEvent, taskManager } = await makeDeps();
    taskManager.getTaskForCheckEvent.mockResolvedValue({ task, ref: "branch feature-branch" });
    const result = await wss.routeCheckEvent(
      { check_run: { pull_requests: [], check_suite: { head_branch: "feature-branch" } } },
      makeEvent("check_run"),
      "check_run",
    );
    expect(taskManager.getTaskForCheckEvent).toHaveBeenCalledWith([], "feature-branch");
    expect(forwardEvent).toHaveBeenCalledOnce();
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("passes head_branch to getTaskForCheckEvent for check_suite", async () => {
    const w = Worker.register("worker-1", fakeWs());
    const task = await seedTask({ task_id: "42", issue_number: 42, worker_id: "worker-1", assigned_at: new Date().toISOString() });
    w.assign(task);
    const { wss, sendMsg, forwardEvent, taskManager } = await makeDeps();
    taskManager.getTaskForCheckEvent.mockResolvedValue({ task, ref: "branch feature-branch" });
    const result = await wss.routeCheckEvent(
      { check_suite: { pull_requests: [], head_branch: "feature-branch" } },
      makeEvent("check_suite"),
      "check_suite",
    );
    expect(taskManager.getTaskForCheckEvent).toHaveBeenCalledWith([], "feature-branch");
    expect(forwardEvent).toHaveBeenCalledOnce();
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("returns null when getTaskForCheckEvent finds nothing", async () => {
    const { wss, forwardEvent } = await makeDeps();
    const result = await wss.routeCheckEvent(
      { check_run: { pull_requests: [], check_suite: { head_branch: "unknown-branch" } } },
      makeEvent("check_run"),
      "check_run",
    );
    expect(result).toEqual({ taskId: null, workerId: null });
    expect(forwardEvent).not.toHaveBeenCalled();
  });
});

// ── routeIssueEvent ───────────────────────────────────────────────────────────

describe("routeIssueEvent — enqueue on labeled", () => {
  it("calls handleIssueLabeledEvent and returns the enqueued task", async () => {
    const task = Task.fromTest({ task_id: "42", issue_number: 42 });
    const { wss, forwardEvent, taskManager } = await makeDeps();
    taskManager.handleIssueLabeledEvent.mockResolvedValue(task);
    const issue = { number: 42, title: "Do something", body: "details", state: "open", labels: [{ name: "brunel:ready" }] };
    const result = await wss.routeIssueEvent(
      { action: "labeled", label: { name: "brunel:ready" }, repository: { html_url: "https://github.com/owner/repo" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.handleIssueLabeledEvent).toHaveBeenCalledWith(
      42, "Do something", "details", ["brunel:ready"], "open",
    );
    expect(result).toEqual({ taskId: "42", workerId: null });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("enqueued via issues/labeled"));
    // The labeled event is queued for the worker to receive once assigned; forwardEvent is called
    // but sendMsg is not (no worker connected yet).
    expect(forwardEvent).toHaveBeenCalledOnce();
  });

  it("returns null when handleIssueLabeledEvent returns null (e.g. closed issue)", async () => {
    const { wss, forwardEvent, taskManager } = await makeDeps();
    taskManager.handleIssueLabeledEvent.mockResolvedValue(null);
    const issue = { number: 42, title: "Do something", body: "", state: "closed", labels: [{ name: "brunel:ready" }] };
    const result = await wss.routeIssueEvent(
      { action: "labeled", label: { name: "brunel:ready" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.handleIssueLabeledEvent).toHaveBeenCalled();
    expect(result).toEqual({ taskId: null, workerId: null });
    expect(forwardEvent).not.toHaveBeenCalled();
  });

  it("ignores a labeled event for a different label", async () => {
    const { wss, forwardEvent, taskManager } = await makeDeps();
    const issue = { number: 42, title: "Do something", body: "", state: "open", labels: [] };
    const result = await wss.routeIssueEvent(
      { action: "labeled", label: { name: "other-label" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.handleIssueLabeledEvent).not.toHaveBeenCalled();
    expect(result).toEqual({ taskId: null, workerId: null });
    expect(forwardEvent).not.toHaveBeenCalled();
  });
});

describe("routeIssueEvent — enqueue on opened", () => {
  it("calls handleIssueLabeledEvent when opened with the task label already attached", async () => {
    const task = Task.fromTest({ task_id: "42", issue_number: 42 });
    const { wss, forwardEvent, taskManager } = await makeDeps();
    taskManager.handleIssueLabeledEvent.mockResolvedValue(task);
    const issue = { number: 42, title: "Do something", body: "details", state: "open", labels: [{ name: "brunel:ready" }] };
    const result = await wss.routeIssueEvent(
      { action: "opened", repository: { html_url: "https://github.com/owner/repo" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.handleIssueLabeledEvent).toHaveBeenCalled();
    expect(result).toEqual({ taskId: "42", workerId: null });
    expect(forwardEvent).toHaveBeenCalledOnce();
  });

  it("does not call handleIssueLabeledEvent when opened without the task label", async () => {
    const { wss, forwardEvent, taskManager } = await makeDeps();
    const issue = { number: 42, title: "Do something", body: "", state: "open", labels: [] };
    const result = await wss.routeIssueEvent(
      { action: "opened" },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.handleIssueLabeledEvent).not.toHaveBeenCalled();
    expect(result).toEqual({ taskId: null, workerId: null });
    expect(forwardEvent).not.toHaveBeenCalled();
  });
});

describe("routeIssueEvent — unlabeled (dequeue)", () => {
  it("dequeues the task when the task label is removed", async () => {
    await seedTask({ task_id: "42", issue_number: 42 });
    const { wss, forwardEvent, taskManager } = await makeDeps();
    const issue = { number: 42 };
    await wss.routeIssueEvent(
      { action: "unlabeled", label: { name: "brunel:ready" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.dequeueIssue).toHaveBeenCalledWith(42);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("dequeued"));
    // Worker does not need to know the label was removed
    expect(forwardEvent).not.toHaveBeenCalled();
  });

  it("does not dequeue when a different label is removed", async () => {
    await seedTask({ task_id: "42", issue_number: 42 });
    const { wss, forwardEvent, taskManager } = await makeDeps();
    const issue = { number: 42 };
    await wss.routeIssueEvent(
      { action: "unlabeled", label: { name: "other-label" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.dequeueIssue).not.toHaveBeenCalled();
    // Non-task label removal falls through: task exists, so the event is forwarded to the worker
    expect(forwardEvent).toHaveBeenCalledOnce();
  });
});

describe("routeIssueEvent — closed", () => {
  it("calls closeIssue when an issue is closed", async () => {
    const { wss, forwardEvent, taskManager } = await makeDeps();
    const issue = { number: 42 };
    await wss.routeIssueEvent(
      { action: "closed" },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.closeIssue).toHaveBeenCalledWith(42);
    // No tracked task → nothing to forward
    expect(forwardEvent).not.toHaveBeenCalled();
  });

  it("calls forwardEvent when a tracked task exists", async () => {
    await seedTask({ task_id: "42", issue_number: 42 });
    const { wss, forwardEvent, taskManager } = await makeDeps();
    const issue = { number: 42 };
    await wss.routeIssueEvent(
      { action: "closed" },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.closeIssue).toHaveBeenCalledWith(42);
    expect(forwardEvent).toHaveBeenCalledOnce();
  });
});

describe("routeIssueEvent — reopened", () => {
  it("calls reopenIssue when an issue is reopened", async () => {
    const { wss, forwardEvent, taskManager } = await makeDeps();
    const issue = { number: 42 };
    await wss.routeIssueEvent(
      { action: "reopened" },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.reopenIssue).toHaveBeenCalledWith(42);
    // No tracked task → nothing to forward
    expect(forwardEvent).not.toHaveBeenCalled();
  });

  it("calls forwardEvent when a tracked task exists", async () => {
    await seedTask({ task_id: "42", issue_number: 42 });
    const { wss, forwardEvent, taskManager } = await makeDeps();
    const issue = { number: 42 };
    await wss.routeIssueEvent(
      { action: "reopened" },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.reopenIssue).toHaveBeenCalledWith(42);
    expect(forwardEvent).toHaveBeenCalledOnce();
  });
});

describe("routeIssueEvent — edited", () => {
  it("calls handleIssueBodyEditedEvent when the issue body is edited for a tracked task", async () => {
    await seedTask({ task_id: "42", issue_number: 42 });
    const { wss, forwardEvent, taskManager } = await makeDeps();
    const issue = { number: 42, body: "updated body" };
    await wss.routeIssueEvent(
      { action: "edited", changes: { body: { from: "old body" } } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.handleIssueBodyEditedEvent).toHaveBeenCalledWith(
      42, "updated body",
    );
    expect(forwardEvent).toHaveBeenCalledOnce();
  });

  it("does not call handleIssueBodyEditedEvent when the body was not changed", async () => {
    await seedTask({ task_id: "42", issue_number: 42 });
    const { wss, forwardEvent, taskManager } = await makeDeps();
    const issue = { number: 42, title: "updated title" };
    await wss.routeIssueEvent(
      { action: "edited", changes: { title: { from: "old title" } } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.handleIssueBodyEditedEvent).not.toHaveBeenCalled();
    // Task exists, so the event is still forwarded even when body didn't change
    expect(forwardEvent).toHaveBeenCalledOnce();
  });

  it("does not call handleIssueBodyEditedEvent when the issue is not tracked", async () => {
    const { wss, forwardEvent, taskManager } = await makeDeps();
    const issue = { number: 42, body: "updated body" };
    await wss.routeIssueEvent(
      { action: "edited", changes: { body: { from: "old body" } } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.handleIssueBodyEditedEvent).not.toHaveBeenCalled();
    expect(forwardEvent).not.toHaveBeenCalled();
  });
});

describe("routeIssueEvent — passthrough forwarding", () => {
  it("forwards other issue events to the tracked task", async () => {
    const w = Worker.register("worker-1", fakeWs());
    const task = await seedTask({ task_id: "42", issue_number: 42, worker_id: "worker-1", assigned_at: new Date().toISOString() });
    w.assign(task);
    const { wss, sendMsg, forwardEvent } = await makeDeps();
    const issue = { number: 42 };
    const result = await wss.routeIssueEvent(
      { action: "assigned" },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(forwardEvent).toHaveBeenCalledOnce();
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("routes issue_comment on a PR via getByPr fallback", async () => {
    const w = Worker.register("worker-1", fakeWs());
    const task = await seedTask({ task_id: "42", issue_number: 42, pr_number: 99, worker_id: "worker-1", assigned_at: new Date().toISOString() });
    w.assign(task);
    const { wss, sendMsg, forwardEvent } = await makeDeps();
    const issue = { number: 99 }; // PR number in issue.number
    const result = await wss.routeIssueEvent(
      { action: "created" },
      makeEvent("issue_comment"),
      issue,
      99,
    );
    expect(forwardEvent).toHaveBeenCalledOnce();
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });
});
