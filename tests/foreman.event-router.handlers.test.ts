/**
 * Unit tests for the per-event-type routing functions:
 * routePrEvent, routePrReviewEvent, routeCheckEvent, routeIssueEvent.
 */
import http from "http";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ForemanWss } from "../src/foreman/controllers/wss.js";
import { Task } from "../src/foreman/models/task.js";
import { Worker } from "../src/foreman/models/worker.js";
import { WebhookEvent } from "../src/foreman/models/webhook-event.js";
import { setupInMemoryTasks } from "./helpers/task.js";
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
  taskManager: {
    queueEvent: ReturnType<typeof vi.fn>;
    dequeueIssue: ReturnType<typeof vi.fn>;
    closeIssue: ReturnType<typeof vi.fn>;
    reopenIssue: ReturnType<typeof vi.fn>;
    assignIdleWorkers: ReturnType<typeof vi.fn>;
    handleIssueLabeledEvent: ReturnType<typeof vi.fn>;
    handleIssueBodyEditedEvent: ReturnType<typeof vi.fn>;
    handlePrOpenedEvent: ReturnType<typeof vi.fn>;
    handlePrClosedEvent: ReturnType<typeof vi.fn>;
    getTaskForCheckEvent: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
}

function makeDeps(): TestDeps {
  const taskManager = {
    queueEvent: vi.fn(),
    dequeueIssue: vi.fn().mockResolvedValue(undefined),
    closeIssue: vi.fn().mockResolvedValue(undefined),
    reopenIssue: vi.fn().mockResolvedValue(undefined),
    assignIdleWorkers: vi.fn().mockResolvedValue([]),
    handleIssueLabeledEvent: vi.fn().mockResolvedValue(null),
    handleIssueBodyEditedEvent: vi.fn(),
    handlePrOpenedEvent: vi.fn().mockResolvedValue(null),
    handlePrClosedEvent: vi.fn().mockResolvedValue(null),
    getTaskForCheckEvent: vi.fn().mockResolvedValue(null),
    on: vi.fn(),
  };
  const wss = new ForemanWss({
    config: { taskLabel: "brunel:ready", githubRepo: "owner/repo", githubToken: "token", workerSecret: undefined, pingIntervalMs: 1e9 },
    taskManager: taskManager as any,
    server: http.createServer(),
  });
  const sendMsg = vi.spyOn(wss, "sendMsg").mockImplementation(() => {});
  return { wss, sendMsg, taskManager };
}

let taskStore: ReturnType<typeof setupInMemoryTasks>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  Worker._reset();
  taskStore = setupInMemoryTasks();
  logSpy = vi.spyOn(utils, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── routePrEvent ──────────────────────────────────────────────────────────────

describe("routePrEvent — missing PR number", () => {
  it("returns null task when pull_request has no number", async () => {
    const { wss } = makeDeps();
    const result = await wss.routePrEvent({ pull_request: {} }, makeEvent());
    expect(result).toEqual({ taskId: null, workerId: null });
  });
});

describe("routePrEvent — synchronize", () => {
  it("returns the task without forwarding when action is synchronize", async () => {
    taskStore.addTask({ task_id: "42", issue_number: 42, pr_number: 99 });
    const { wss, sendMsg } = makeDeps();
    const result = await wss.routePrEvent(
      { action: "synchronize", pull_request: { number: 99 } },
      makeEvent(),
    );
    expect(result.taskId).toBe("42");
    expect(sendMsg).not.toHaveBeenCalled();
  });
});

describe("routePrEvent — opened", () => {
  it("calls handlePrOpenedEvent and forwards event when a linked task is found", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign(task);
    const { wss, sendMsg, taskManager } = makeDeps();
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
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("returns null when handlePrOpenedEvent finds no linked issue", async () => {
    const { wss, sendMsg, taskManager } = makeDeps();
    taskManager.handlePrOpenedEvent.mockResolvedValue(null);
    const result = await wss.routePrEvent(
      { action: "opened", pull_request: { number: 99, body: "no link here", head: { ref: "branch" } } },
      makeEvent(),
    );
    expect(result).toEqual({ taskId: null, workerId: null });
    expect(sendMsg).not.toHaveBeenCalled();
  });
});

describe("routePrEvent — closed without merge", () => {
  it("calls handlePrClosedEvent and forwards the event to the task", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42, pr_number: 99 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign(task);
    const { wss, sendMsg, taskManager } = makeDeps();
    taskManager.handlePrClosedEvent.mockResolvedValue(task);
    const result = await wss.routePrEvent(
      { action: "closed", pull_request: { number: 99, merged: false } },
      makeEvent(),
    );
    expect(taskManager.handlePrClosedEvent).toHaveBeenCalledWith(99, false);
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("returns null when no task owns the PR", async () => {
    const { wss, sendMsg, taskManager } = makeDeps();
    taskManager.handlePrClosedEvent.mockResolvedValue(null);
    const result = await wss.routePrEvent(
      { action: "closed", pull_request: { number: 99, merged: false } },
      makeEvent(),
    );
    expect(result).toEqual({ taskId: null, workerId: null });
  });
});

describe("routePrEvent — closed with merge", () => {
  it("calls handlePrClosedEvent with merged=true and forwards the event", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42, pr_number: 99 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign(task);
    const { wss, sendMsg, taskManager } = makeDeps();
    taskManager.handlePrClosedEvent.mockResolvedValue(task);
    const result = await wss.routePrEvent(
      { action: "closed", pull_request: { number: 99, merged: true } },
      makeEvent(),
    );
    expect(taskManager.handlePrClosedEvent).toHaveBeenCalledWith(99, true);
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("returns null when no task owns the PR", async () => {
    const { wss } = makeDeps();
    const result = await wss.routePrEvent(
      { action: "closed", pull_request: { number: 99, merged: true } },
      makeEvent(),
    );
    expect(result).toEqual({ taskId: null, workerId: null });
  });
});

describe("routePrEvent — passthrough", () => {
  it("forwards other PR events to the task", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42, pr_number: 99 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign(task);
    const { wss, sendMsg } = makeDeps();
    const result = await wss.routePrEvent(
      { action: "labeled", pull_request: { number: 99 } },
      makeEvent(),
    );
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("returns null task when no task owns the PR", async () => {
    const { wss } = makeDeps();
    const result = await wss.routePrEvent(
      { action: "labeled", pull_request: { number: 99 } },
      makeEvent(),
    );
    expect(result).toEqual({ taskId: null, workerId: null });
  });
});

// ── routePrReviewEvent ────────────────────────────────────────────────────────

describe("routePrReviewEvent", () => {
  it("returns null when PR number is missing", async () => {
    const { wss } = makeDeps();
    const result = await wss.routePrReviewEvent({ pull_request: {} }, makeEvent("pull_request_review"));
    expect(result).toEqual({ taskId: null, workerId: null });
  });

  it("forwards review events to the task that owns the PR", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42, pr_number: 99 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign(task);
    const { wss, sendMsg } = makeDeps();
    const result = await wss.routePrReviewEvent(
      { pull_request: { number: 99 } },
      makeEvent("pull_request_review"),
    );
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("returns null when no task owns the reviewed PR", async () => {
    const { wss } = makeDeps();
    const result = await wss.routePrReviewEvent(
      { pull_request: { number: 99 } },
      makeEvent("pull_request_review"),
    );
    expect(result).toEqual({ taskId: null, workerId: null });
  });
});

// ── routeCheckEvent ───────────────────────────────────────────────────────────

describe("routeCheckEvent — via PR number", () => {
  it("forwards check_run to the task when getTaskForCheckEvent finds it by PR", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42, pr_number: 99 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign(task);
    const { wss, sendMsg, taskManager } = makeDeps();
    taskManager.getTaskForCheckEvent.mockResolvedValue({ task, ref: "PR #99" });
    const result = await wss.routeCheckEvent(
      { check_run: { pull_requests: [{ number: 99 }] } },
      makeEvent("check_run"),
      "check_run",
    );
    expect(taskManager.getTaskForCheckEvent).toHaveBeenCalledWith([99], "");
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("forwards check_suite to the task when getTaskForCheckEvent finds it by PR", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42, pr_number: 99 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign(task);
    const { wss, sendMsg, taskManager } = makeDeps();
    taskManager.getTaskForCheckEvent.mockResolvedValue({ task, ref: "PR #99" });
    const result = await wss.routeCheckEvent(
      { check_suite: { pull_requests: [{ number: 99 }] } },
      makeEvent("check_suite"),
      "check_suite",
    );
    expect(taskManager.getTaskForCheckEvent).toHaveBeenCalledWith([99], "");
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });
});

describe("routeCheckEvent — via branch name", () => {
  it("passes head_branch to getTaskForCheckEvent for check_run", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign(task);
    const { wss, sendMsg, taskManager } = makeDeps();
    taskManager.getTaskForCheckEvent.mockResolvedValue({ task, ref: "branch feature-branch" });
    const result = await wss.routeCheckEvent(
      { check_run: { pull_requests: [], check_suite: { head_branch: "feature-branch" } } },
      makeEvent("check_run"),
      "check_run",
    );
    expect(taskManager.getTaskForCheckEvent).toHaveBeenCalledWith([], "feature-branch");
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("passes head_branch to getTaskForCheckEvent for check_suite", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign(task);
    const { wss, sendMsg, taskManager } = makeDeps();
    taskManager.getTaskForCheckEvent.mockResolvedValue({ task, ref: "branch feature-branch" });
    const result = await wss.routeCheckEvent(
      { check_suite: { pull_requests: [], head_branch: "feature-branch" } },
      makeEvent("check_suite"),
      "check_suite",
    );
    expect(taskManager.getTaskForCheckEvent).toHaveBeenCalledWith([], "feature-branch");
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("returns null when getTaskForCheckEvent finds nothing", async () => {
    const { wss } = makeDeps();
    const result = await wss.routeCheckEvent(
      { check_run: { pull_requests: [], check_suite: { head_branch: "unknown-branch" } } },
      makeEvent("check_run"),
      "check_run",
    );
    expect(result).toEqual({ taskId: null, workerId: null });
  });
});

// ── routeIssueEvent ───────────────────────────────────────────────────────────

describe("routeIssueEvent — enqueue on labeled", () => {
  it("calls handleIssueLabeledEvent and returns the enqueued task", async () => {
    const task = Task.fromTest({ task_id: "42", issue_number: 42 });
    const { wss, taskManager } = makeDeps();
    taskManager.handleIssueLabeledEvent.mockResolvedValue(task);
    const issue = { number: 42, title: "Do something", body: "details", state: "open", labels: [{ name: "brunel:ready" }] };
    const result = await wss.routeIssueEvent(
      { action: "labeled", label: { name: "brunel:ready" }, repository: { html_url: "https://github.com/owner/repo" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.handleIssueLabeledEvent).toHaveBeenCalledWith(
      42, "owner/repo", "Do something", "details", ["brunel:ready"], "open",
      expect.objectContaining({ repo: "owner/repo" }),
    );
    expect(result).toEqual({ taskId: "42", workerId: null });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("enqueued via issues/labeled"));
  });

  it("returns null when handleIssueLabeledEvent returns null (e.g. closed issue)", async () => {
    const { wss, taskManager } = makeDeps();
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
  });

  it("ignores a labeled event for a different label", async () => {
    const { wss, taskManager } = makeDeps();
    const issue = { number: 42, title: "Do something", body: "", state: "open", labels: [] };
    const result = await wss.routeIssueEvent(
      { action: "labeled", label: { name: "other-label" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.handleIssueLabeledEvent).not.toHaveBeenCalled();
    expect(result).toEqual({ taskId: null, workerId: null });
  });
});

describe("routeIssueEvent — enqueue on opened", () => {
  it("calls handleIssueLabeledEvent when opened with the task label already attached", async () => {
    const task = Task.fromTest({ task_id: "42", issue_number: 42 });
    const { wss, taskManager } = makeDeps();
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
  });

  it("does not call handleIssueLabeledEvent when opened without the task label", async () => {
    const { wss, taskManager } = makeDeps();
    const issue = { number: 42, title: "Do something", body: "", state: "open", labels: [] };
    const result = await wss.routeIssueEvent(
      { action: "opened" },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.handleIssueLabeledEvent).not.toHaveBeenCalled();
    expect(result).toEqual({ taskId: null, workerId: null });
  });
});

describe("routeIssueEvent — unlabeled (dequeue)", () => {
  it("dequeues the task when the task label is removed", async () => {
    taskStore.addTask({ task_id: "42", issue_number: 42 });
    const { wss, taskManager } = makeDeps();
    const issue = { number: 42 };
    await wss.routeIssueEvent(
      { action: "unlabeled", label: { name: "brunel:ready" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.dequeueIssue).toHaveBeenCalledWith(42);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("dequeued"));
  });

  it("does not dequeue when a different label is removed", async () => {
    taskStore.addTask({ task_id: "42", issue_number: 42 });
    const { wss, taskManager } = makeDeps();
    const issue = { number: 42 };
    await wss.routeIssueEvent(
      { action: "unlabeled", label: { name: "other-label" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.dequeueIssue).not.toHaveBeenCalled();
  });
});

describe("routeIssueEvent — closed", () => {
  it("calls closeIssue when an issue is closed", async () => {
    const { wss, taskManager } = makeDeps();
    const issue = { number: 42 };
    await wss.routeIssueEvent(
      { action: "closed" },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.closeIssue).toHaveBeenCalledWith(42);
  });
});

describe("routeIssueEvent — reopened", () => {
  it("calls reopenIssue when an issue is reopened", async () => {
    const { wss, taskManager } = makeDeps();
    const issue = { number: 42 };
    await wss.routeIssueEvent(
      { action: "reopened" },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.reopenIssue).toHaveBeenCalledWith(42);
  });
});

describe("routeIssueEvent — edited", () => {
  it("calls handleIssueBodyEditedEvent when the issue body is edited for a tracked task", async () => {
    taskStore.addTask({ task_id: "42", issue_number: 42 });
    const { wss, taskManager } = makeDeps();
    const issue = { number: 42, body: "updated body" };
    await wss.routeIssueEvent(
      { action: "edited", changes: { body: { from: "old body" } } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.handleIssueBodyEditedEvent).toHaveBeenCalledWith(
      42, "updated body", expect.objectContaining({ repo: "owner/repo" }),
    );
  });

  it("does not call handleIssueBodyEditedEvent when the body was not changed", async () => {
    taskStore.addTask({ task_id: "42", issue_number: 42 });
    const { wss, taskManager } = makeDeps();
    const issue = { number: 42, title: "updated title" };
    await wss.routeIssueEvent(
      { action: "edited", changes: { title: { from: "old title" } } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.handleIssueBodyEditedEvent).not.toHaveBeenCalled();
  });

  it("does not call handleIssueBodyEditedEvent when the issue is not tracked", async () => {
    const { wss, taskManager } = makeDeps();
    const issue = { number: 42, body: "updated body" };
    await wss.routeIssueEvent(
      { action: "edited", changes: { body: { from: "old body" } } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.handleIssueBodyEditedEvent).not.toHaveBeenCalled();
  });
});

describe("routeIssueEvent — passthrough forwarding", () => {
  it("forwards other issue events to the tracked task", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign(task);
    const { wss, sendMsg } = makeDeps();
    const issue = { number: 42 };
    const result = await wss.routeIssueEvent(
      { action: "assigned" },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("routes issue_comment on a PR via getByPr fallback", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42, pr_number: 99 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign(task);
    const { wss, sendMsg } = makeDeps();
    const issue = { number: 99 }; // PR number in issue.number
    const result = await wss.routeIssueEvent(
      { action: "created" },
      makeEvent("issue_comment"),
      issue,
      99,
    );
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });
});
