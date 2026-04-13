/**
 * Unit tests for the per-event-type routing functions:
 * routePrEvent, routePrReviewEvent, routeCheckEvent, routeIssueEvent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { type RoutingDeps, routePrEvent, routePrReviewEvent, routeCheckEvent, routeIssueEvent } from "../src/foreman/controllers/wss.js";
import { Task } from "../src/foreman/models/task.js";
import { Worker } from "../src/foreman/models/worker.js";
import { WebhookEvent } from "../src/foreman/models/webhook-event.js";
import { setupInMemoryTasks } from "./helpers/task.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function fakeWs() {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
}

function makeEvent(name = "pull_request"): WebhookEvent {
  return WebhookEvent.fromIncoming("evt-1", name, {});
}

interface TestDeps {
  deps: RoutingDeps;
  sendMsg: ReturnType<typeof vi.fn>;
  flog: ReturnType<typeof vi.fn>;
  taskManager: {
    queueEvent: ReturnType<typeof vi.fn>;
    registerBranch: ReturnType<typeof vi.fn>;
    getTaskForBranch: ReturnType<typeof vi.fn>;
    enqueueIssue: ReturnType<typeof vi.fn>;
    dequeueIssue: ReturnType<typeof vi.fn>;
    closeIssue: ReturnType<typeof vi.fn>;
    reopenIssue: ReturnType<typeof vi.fn>;
    resetBlockers: ReturnType<typeof vi.fn>;
    assignIdleWorkers: ReturnType<typeof vi.fn>;
  };
}

function makeDeps(): TestDeps {
  const queueEvent = vi.fn();
  const registerBranch = vi.fn();
  const getTaskForBranch = vi.fn().mockResolvedValue(null);
  const enqueueIssue = vi.fn().mockResolvedValue(undefined);
  const dequeueIssue = vi.fn().mockResolvedValue(undefined);
  const closeIssue = vi.fn().mockResolvedValue(undefined);
  const reopenIssue = vi.fn().mockResolvedValue(undefined);
  const resetBlockers = vi.fn();
  const assignIdleWorkers = vi.fn().mockResolvedValue([]);
  const sendMsg = vi.fn();
  const flog = vi.fn();
  const taskManager = {
    queueEvent,
    registerBranch,
    getTaskForBranch,
    enqueueIssue,
    dequeueIssue,
    closeIssue,
    reopenIssue,
    resetBlockers,
    assignIdleWorkers,
  };
  const deps: RoutingDeps = {
    taskManager: taskManager as any,
    repo: "owner/repo",
    token: "token",
    taskLabel: "brunel:ready",
  };
  return { deps, sendMsg, flog, taskManager };
}

let taskStore: ReturnType<typeof setupInMemoryTasks>;

beforeEach(() => {
  Worker._reset();
  taskStore = setupInMemoryTasks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── routePrEvent ──────────────────────────────────────────────────────────────

describe("routePrEvent — missing PR number", () => {
  it("returns null task when pull_request has no number", async () => {
    const { deps, sendMsg, flog } = makeDeps();
    const result = await routePrEvent({ pull_request: {} }, makeEvent(), deps, sendMsg, flog);
    expect(result).toEqual({ taskId: null, workerId: null });
  });
});

describe("routePrEvent — synchronize", () => {
  it("returns the task without forwarding when action is synchronize", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42, pr_number: 99 });
    const { deps, sendMsg, flog } = makeDeps();
    const result = await routePrEvent(
      { action: "synchronize", pull_request: { number: 99 } },
      makeEvent(),
      deps,
      sendMsg,
      flog,
    );
    expect(result.taskId).toBe("42");
    expect(sendMsg).not.toHaveBeenCalled();
  });
});

describe("routePrEvent — opened", () => {
  it("registers PR on a linked task when PR body closes the issue", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42 });
    const { deps, sendMsg, flog, taskManager } = makeDeps();
    const result = await routePrEvent(
      {
        action: "opened",
        pull_request: {
          number: 99,
          body: "Closes #42",
          head: { ref: "feature-branch" },
        },
      },
      makeEvent(),
      deps,
      sendMsg,
      flog,
    );
    expect(task.prNumber).toBe(99);
    expect(task.branch).toBe("feature-branch");
    expect(taskManager.registerBranch).toHaveBeenCalledWith("feature-branch", "42");
    expect(flog).toHaveBeenCalledWith(expect.stringContaining("PR #99 registered"));
    expect(result.taskId).toBe("42");
  });

  it("does nothing when PR body does not link an issue", async () => {
    const { deps, sendMsg, flog, taskManager } = makeDeps();
    const result = await routePrEvent(
      { action: "opened", pull_request: { number: 99, body: "no link here", head: { ref: "branch" } } },
      makeEvent(),
      deps,
      sendMsg,
      flog,
    );
    expect(result).toEqual({ taskId: null, workerId: null });
    expect(taskManager.registerBranch).not.toHaveBeenCalled();
  });
});

describe("routePrEvent — closed without merge", () => {
  it("unregisters PR and forwards the event to the task", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42, pr_number: 99 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign("42");
    const { deps, sendMsg, flog } = makeDeps();
    const result = await routePrEvent(
      { action: "closed", pull_request: { number: 99, merged: false } },
      makeEvent(),
      deps,
      sendMsg,
      flog,
    );
    expect(task.prNumber).toBeNull();
    expect(flog).toHaveBeenCalledWith(expect.stringContaining("unregistered"));
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("returns null when no task owns the PR", async () => {
    const { deps, sendMsg, flog } = makeDeps();
    const result = await routePrEvent(
      { action: "closed", pull_request: { number: 99, merged: false } },
      makeEvent(),
      deps,
      sendMsg,
      flog,
    );
    expect(result).toEqual({ taskId: null, workerId: null });
  });
});

describe("routePrEvent — closed with merge", () => {
  it("records merge and forwards the event to the task", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42, pr_number: 99 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign("42");
    const { deps, sendMsg, flog } = makeDeps();
    const result = await routePrEvent(
      { action: "closed", pull_request: { number: 99, merged: true } },
      makeEvent(),
      deps,
      sendMsg,
      flog,
    );
    expect(task.prMergedAt).toBeTruthy();
    expect(flog).toHaveBeenCalledWith(expect.stringContaining("merged"));
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("returns null when no task owns the PR", async () => {
    const { deps, sendMsg, flog } = makeDeps();
    const result = await routePrEvent(
      { action: "closed", pull_request: { number: 99, merged: true } },
      makeEvent(),
      deps,
      sendMsg,
      flog,
    );
    expect(result).toEqual({ taskId: null, workerId: null });
  });
});

describe("routePrEvent — passthrough", () => {
  it("forwards other PR events to the task", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42, pr_number: 99 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign("42");
    const { deps, sendMsg, flog } = makeDeps();
    const result = await routePrEvent(
      { action: "labeled", pull_request: { number: 99 } },
      makeEvent(),
      deps,
      sendMsg,
      flog,
    );
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("returns null task when no task owns the PR", async () => {
    const { deps, sendMsg, flog } = makeDeps();
    const result = await routePrEvent(
      { action: "labeled", pull_request: { number: 99 } },
      makeEvent(),
      deps,
      sendMsg,
      flog,
    );
    expect(result).toEqual({ taskId: null, workerId: null });
  });
});

// ── routePrReviewEvent ────────────────────────────────────────────────────────

describe("routePrReviewEvent", () => {
  it("returns null when PR number is missing", async () => {
    const { deps, sendMsg, flog } = makeDeps();
    const result = await routePrReviewEvent({ pull_request: {} }, makeEvent("pull_request_review"), deps, sendMsg, flog);
    expect(result).toEqual({ taskId: null, workerId: null });
  });

  it("forwards review events to the task that owns the PR", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42, pr_number: 99 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign("42");
    const { deps, sendMsg, flog } = makeDeps();
    const result = await routePrReviewEvent(
      { pull_request: { number: 99 } },
      makeEvent("pull_request_review"),
      deps,
      sendMsg,
      flog,
    );
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("returns null when no task owns the reviewed PR", async () => {
    const { deps, sendMsg, flog } = makeDeps();
    const result = await routePrReviewEvent(
      { pull_request: { number: 99 } },
      makeEvent("pull_request_review"),
      deps,
      sendMsg,
      flog,
    );
    expect(result).toEqual({ taskId: null, workerId: null });
  });
});

// ── routeCheckEvent ───────────────────────────────────────────────────────────

describe("routeCheckEvent — via PR number", () => {
  it("forwards check_run to the task when the check links a PR", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42, pr_number: 99 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign("42");
    const { deps, sendMsg, flog } = makeDeps();
    const result = await routeCheckEvent(
      { check_run: { pull_requests: [{ number: 99 }] } },
      makeEvent("check_run"),
      "check_run",
      deps,
      sendMsg,
      flog,
    );
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("forwards check_suite to the task when the suite links a PR", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42, pr_number: 99 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign("42");
    const { deps, sendMsg, flog } = makeDeps();
    const result = await routeCheckEvent(
      { check_suite: { pull_requests: [{ number: 99 }] } },
      makeEvent("check_suite"),
      "check_suite",
      deps,
      sendMsg,
      flog,
    );
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });
});

describe("routeCheckEvent — via branch name", () => {
  it("forwards check_run to the task resolved from head_branch", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign("42");
    const { deps, sendMsg, flog, taskManager } = makeDeps();
    taskManager.getTaskForBranch = vi.fn().mockResolvedValue(task);
    const result = await routeCheckEvent(
      { check_run: { pull_requests: [], check_suite: { head_branch: "feature-branch" } } },
      makeEvent("check_run"),
      "check_run",
      deps,
      sendMsg,
      flog,
    );
    expect(taskManager.getTaskForBranch).toHaveBeenCalledWith("feature-branch");
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("forwards check_suite to the task resolved from head_branch", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign("42");
    const { deps, sendMsg, flog, taskManager } = makeDeps();
    taskManager.getTaskForBranch = vi.fn().mockResolvedValue(task);
    const result = await routeCheckEvent(
      { check_suite: { pull_requests: [], head_branch: "feature-branch" } },
      makeEvent("check_suite"),
      "check_suite",
      deps,
      sendMsg,
      flog,
    );
    expect(taskManager.getTaskForBranch).toHaveBeenCalledWith("feature-branch");
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("returns null when neither PR nor branch matches a task", async () => {
    const { deps, sendMsg, flog } = makeDeps();
    const result = await routeCheckEvent(
      { check_run: { pull_requests: [], check_suite: { head_branch: "unknown-branch" } } },
      makeEvent("check_run"),
      "check_run",
      deps,
      sendMsg,
      flog,
    );
    expect(result).toEqual({ taskId: null, workerId: null });
  });
});

// ── routeIssueEvent ───────────────────────────────────────────────────────────

describe("routeIssueEvent — enqueue on labeled", () => {
  it("enqueues the issue and starts dep loading when labeled with task label", async () => {
    vi.spyOn(Task, "fetchBlockers").mockResolvedValue([]);
    const { deps, sendMsg, flog, taskManager } = makeDeps();
    const issue = { number: 42, title: "Do something", body: "details", state: "open", labels: [{ name: "brunel:ready" }] };
    const result = await routeIssueEvent(
      { action: "labeled", label: { name: "brunel:ready" }, repository: { html_url: "https://github.com/owner/repo" } },
      makeEvent("issues"),
      issue,
      42,
      deps,
      sendMsg,
      flog,
    );
    expect(taskManager.enqueueIssue).toHaveBeenCalledWith("42", 42, "owner/repo", "Do something", "details", ["brunel:ready"]);
    expect(result).toEqual({ taskId: "42", workerId: null });
  });

  it("ignores a labeled event when the issue is already closed", async () => {
    const { deps, sendMsg, flog, taskManager } = makeDeps();
    const issue = { number: 42, title: "Do something", body: "", state: "closed", labels: [{ name: "brunel:ready" }] };
    const result = await routeIssueEvent(
      { action: "labeled", label: { name: "brunel:ready" } },
      makeEvent("issues"),
      issue,
      42,
      deps,
      sendMsg,
      flog,
    );
    expect(taskManager.enqueueIssue).not.toHaveBeenCalled();
    expect(result).toEqual({ taskId: null, workerId: null });
    expect(flog).toHaveBeenCalledWith(expect.stringContaining("ignoring"));
  });

  it("ignores a labeled event for a different label", async () => {
    const { deps, sendMsg, flog, taskManager } = makeDeps();
    const issue = { number: 42, title: "Do something", body: "", state: "open", labels: [] };
    const result = await routeIssueEvent(
      { action: "labeled", label: { name: "other-label" } },
      makeEvent("issues"),
      issue,
      42,
      deps,
      sendMsg,
      flog,
    );
    expect(taskManager.enqueueIssue).not.toHaveBeenCalled();
    expect(result).toEqual({ taskId: null, workerId: null });
  });
});

describe("routeIssueEvent — enqueue on opened", () => {
  it("enqueues the issue when opened with the task label already attached", async () => {
    vi.spyOn(Task, "fetchBlockers").mockResolvedValue([]);
    const { deps, sendMsg, flog, taskManager } = makeDeps();
    const issue = { number: 42, title: "Do something", body: "details", state: "open", labels: [{ name: "brunel:ready" }] };
    const result = await routeIssueEvent(
      { action: "opened", repository: { html_url: "https://github.com/owner/repo" } },
      makeEvent("issues"),
      issue,
      42,
      deps,
      sendMsg,
      flog,
    );
    expect(taskManager.enqueueIssue).toHaveBeenCalled();
    expect(result).toEqual({ taskId: "42", workerId: null });
  });

  it("does not enqueue when opened without the task label", async () => {
    const { deps, sendMsg, flog, taskManager } = makeDeps();
    const issue = { number: 42, title: "Do something", body: "", state: "open", labels: [] };
    const result = await routeIssueEvent(
      { action: "opened" },
      makeEvent("issues"),
      issue,
      42,
      deps,
      sendMsg,
      flog,
    );
    expect(taskManager.enqueueIssue).not.toHaveBeenCalled();
    expect(result).toEqual({ taskId: null, workerId: null });
  });
});

describe("routeIssueEvent — unlabeled (dequeue)", () => {
  it("dequeues the task when the task label is removed", async () => {
    taskStore.addTask({ task_id: "42", issue_number: 42 });
    const { deps, sendMsg, flog, taskManager } = makeDeps();
    const issue = { number: 42 };
    await routeIssueEvent(
      { action: "unlabeled", label: { name: "brunel:ready" } },
      makeEvent("issues"),
      issue,
      42,
      deps,
      sendMsg,
      flog,
    );
    expect(taskManager.dequeueIssue).toHaveBeenCalledWith(42);
    expect(flog).toHaveBeenCalledWith(expect.stringContaining("dequeued"));
  });

  it("does not dequeue when a different label is removed", async () => {
    taskStore.addTask({ task_id: "42", issue_number: 42 });
    const { deps, sendMsg, flog, taskManager } = makeDeps();
    const issue = { number: 42 };
    await routeIssueEvent(
      { action: "unlabeled", label: { name: "other-label" } },
      makeEvent("issues"),
      issue,
      42,
      deps,
      sendMsg,
      flog,
    );
    expect(taskManager.dequeueIssue).not.toHaveBeenCalled();
  });
});

describe("routeIssueEvent — closed", () => {
  it("calls closeIssue when an issue is closed", async () => {
    const { deps, sendMsg, flog, taskManager } = makeDeps();
    const issue = { number: 42 };
    await routeIssueEvent(
      { action: "closed" },
      makeEvent("issues"),
      issue,
      42,
      deps,
      sendMsg,
      flog,
    );
    expect(taskManager.closeIssue).toHaveBeenCalledWith(42);
  });
});

describe("routeIssueEvent — reopened", () => {
  it("calls reopenIssue when an issue is reopened", async () => {
    const { deps, sendMsg, flog, taskManager } = makeDeps();
    const issue = { number: 42 };
    await routeIssueEvent(
      { action: "reopened" },
      makeEvent("issues"),
      issue,
      42,
      deps,
      sendMsg,
      flog,
    );
    expect(taskManager.reopenIssue).toHaveBeenCalledWith(42);
  });
});

describe("routeIssueEvent — edited", () => {
  it("resets and reloads blockers when the issue body is edited for a tracked task", async () => {
    taskStore.addTask({ task_id: "42", issue_number: 42 });
    vi.spyOn(Task, "fetchBlockers").mockResolvedValue([]);
    const { deps, sendMsg, flog, taskManager } = makeDeps();
    const issue = { number: 42, body: "updated body" };
    await routeIssueEvent(
      { action: "edited", changes: { body: { from: "old body" } } },
      makeEvent("issues"),
      issue,
      42,
      deps,
      sendMsg,
      flog,
    );
    expect(taskManager.resetBlockers).toHaveBeenCalledWith(42);
    // startDepsLoad fires Task.fetchBlockers with the new body
    expect(Task.fetchBlockers).toHaveBeenCalledWith(42, "updated body", expect.any(Object));
  });

  it("does not reset blockers when the body was not changed", async () => {
    taskStore.addTask({ task_id: "42", issue_number: 42 });
    const { deps, sendMsg, flog, taskManager } = makeDeps();
    const issue = { number: 42, title: "updated title" };
    await routeIssueEvent(
      { action: "edited", changes: { title: { from: "old title" } } },
      makeEvent("issues"),
      issue,
      42,
      deps,
      sendMsg,
      flog,
    );
    expect(taskManager.resetBlockers).not.toHaveBeenCalled();
  });
});

describe("routeIssueEvent — passthrough forwarding", () => {
  it("forwards other issue events to the tracked task", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign("42");
    const { deps, sendMsg, flog } = makeDeps();
    const issue = { number: 42 };
    const result = await routeIssueEvent(
      { action: "assigned" },
      makeEvent("issues"),
      issue,
      42,
      deps,
      sendMsg,
      flog,
    );
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("routes issue_comment on a PR via getByPr fallback", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42, pr_number: 99 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign("42");
    const { deps, sendMsg, flog } = makeDeps();
    const issue = { number: 99 }; // PR number in issue.number
    const result = await routeIssueEvent(
      { action: "created" },
      makeEvent("issue_comment"),
      issue,
      99,
      deps,
      sendMsg,
      flog,
    );
    expect(sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });
});
