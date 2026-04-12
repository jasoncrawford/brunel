/**
 * Unit tests for the per-event-type handler methods extracted from EventRouter.routeEvent:
 * routePrEvent, routePrReviewEvent, routeCheckEvent, routeIssueEvent.
 *
 * Each handler is called directly via (router as any) so tests don't have to
 * construct a full webhook payload and route it through the top-level dispatcher.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventRouter } from "../src/foreman/controllers/event-router.js";
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

type RouterWithMocks = EventRouter & {
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
  };
};

function makeRouter(): RouterWithMocks {
  const queueEvent = vi.fn();
  const registerBranch = vi.fn();
  const getTaskForBranch = vi.fn().mockResolvedValue(null);
  const enqueueIssue = vi.fn().mockResolvedValue(undefined);
  const dequeueIssue = vi.fn().mockResolvedValue(undefined);
  const closeIssue = vi.fn().mockResolvedValue(undefined);
  const reopenIssue = vi.fn().mockResolvedValue(undefined);
  const resetBlockers = vi.fn();
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
  };
  const router = new EventRouter({
    taskManager: taskManager as any,
    repo: "owner/repo",
    token: "token",
    taskLabel: "brunel:ready",
    sendMsg,
    flog,
    assignIdleWorkers: vi.fn().mockResolvedValue(undefined),
  });
  return Object.assign(router, { sendMsg, flog, taskManager }) as RouterWithMocks;
}

function callPrEvent(router: EventRouter, p: Record<string, unknown>, evt: WebhookEvent) {
  return (router as any).routePrEvent(p, evt);
}

function callPrReviewEvent(router: EventRouter, p: Record<string, unknown>, evt: WebhookEvent) {
  return (router as any).routePrReviewEvent(p, evt);
}

function callCheckEvent(router: EventRouter, p: Record<string, unknown>, evt: WebhookEvent, name: string) {
  return (router as any).routeCheckEvent(p, evt, name);
}

function callIssueEvent(
  router: EventRouter,
  p: Record<string, unknown>,
  evt: WebhookEvent,
  issue: Record<string, unknown>,
  issueNumber: number,
) {
  return (router as any).routeIssueEvent(p, evt, issue, issueNumber);
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
    const router = makeRouter();
    const result = await callPrEvent(router, { pull_request: {} }, makeEvent());
    expect(result).toEqual({ taskId: null, workerId: null });
  });
});

describe("routePrEvent — synchronize", () => {
  it("returns the task without forwarding when action is synchronize", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42, pr_number: 99 });
    const router = makeRouter();
    const result = await callPrEvent(
      router,
      { action: "synchronize", pull_request: { number: 99 } },
      makeEvent(),
    );
    expect(result.taskId).toBe("42");
    expect(router.sendMsg).not.toHaveBeenCalled();
  });
});

describe("routePrEvent — opened", () => {
  it("registers PR on a linked task when PR body closes the issue", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42 });
    const router = makeRouter();
    const result = await callPrEvent(
      router,
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
    expect(task.prNumber).toBe(99);
    expect(task.branch).toBe("feature-branch");
    expect(router.taskManager.registerBranch).toHaveBeenCalledWith("feature-branch", "42");
    expect(router.flog).toHaveBeenCalledWith(expect.stringContaining("PR #99 registered"));
    expect(result.taskId).toBe("42");
  });

  it("does nothing when PR body does not link an issue", async () => {
    const router = makeRouter();
    const result = await callPrEvent(
      router,
      { action: "opened", pull_request: { number: 99, body: "no link here", head: { ref: "branch" } } },
      makeEvent(),
    );
    expect(result).toEqual({ taskId: null, workerId: null });
    expect(router.taskManager.registerBranch).not.toHaveBeenCalled();
  });
});

describe("routePrEvent — closed without merge", () => {
  it("unregisters PR and forwards the event to the task", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42, pr_number: 99 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign("42");
    const router = makeRouter();
    const result = await callPrEvent(
      router,
      { action: "closed", pull_request: { number: 99, merged: false } },
      makeEvent(),
    );
    expect(task.prNumber).toBeNull();
    expect(router.flog).toHaveBeenCalledWith(expect.stringContaining("unregistered"));
    expect(router.sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("returns null when no task owns the PR", async () => {
    const router = makeRouter();
    const result = await callPrEvent(
      router,
      { action: "closed", pull_request: { number: 99, merged: false } },
      makeEvent(),
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
    const router = makeRouter();
    const result = await callPrEvent(
      router,
      { action: "closed", pull_request: { number: 99, merged: true } },
      makeEvent(),
    );
    expect(task.prMergedAt).toBeTruthy();
    expect(router.flog).toHaveBeenCalledWith(expect.stringContaining("merged"));
    expect(router.sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("returns null when no task owns the PR", async () => {
    const router = makeRouter();
    const result = await callPrEvent(
      router,
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
    w.assign("42");
    const router = makeRouter();
    const result = await callPrEvent(
      router,
      { action: "labeled", pull_request: { number: 99 } },
      makeEvent(),
    );
    expect(router.sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("returns null task when no task owns the PR", async () => {
    const router = makeRouter();
    const result = await callPrEvent(
      router,
      { action: "labeled", pull_request: { number: 99 } },
      makeEvent(),
    );
    expect(result).toEqual({ taskId: null, workerId: null });
  });
});

// ── routePrReviewEvent ────────────────────────────────────────────────────────

describe("routePrReviewEvent", () => {
  it("returns null when PR number is missing", async () => {
    const router = makeRouter();
    const result = await callPrReviewEvent(router, { pull_request: {} }, makeEvent("pull_request_review"));
    expect(result).toEqual({ taskId: null, workerId: null });
  });

  it("forwards review events to the task that owns the PR", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42, pr_number: 99 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign("42");
    const router = makeRouter();
    const result = await callPrReviewEvent(
      router,
      { pull_request: { number: 99 } },
      makeEvent("pull_request_review"),
    );
    expect(router.sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("returns null when no task owns the reviewed PR", async () => {
    const router = makeRouter();
    const result = await callPrReviewEvent(
      router,
      { pull_request: { number: 99 } },
      makeEvent("pull_request_review"),
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
    const router = makeRouter();
    const result = await callCheckEvent(
      router,
      { check_run: { pull_requests: [{ number: 99 }] } },
      makeEvent("check_run"),
      "check_run",
    );
    expect(router.sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("forwards check_suite to the task when the suite links a PR", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42, pr_number: 99 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign("42");
    const router = makeRouter();
    const result = await callCheckEvent(
      router,
      { check_suite: { pull_requests: [{ number: 99 }] } },
      makeEvent("check_suite"),
      "check_suite",
    );
    expect(router.sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });
});

describe("routeCheckEvent — via branch name", () => {
  it("forwards check_run to the task resolved from head_branch", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign("42");
    const router = makeRouter();
    router.taskManager.getTaskForBranch = vi.fn().mockResolvedValue(task);
    const result = await callCheckEvent(
      router,
      { check_run: { pull_requests: [], check_suite: { head_branch: "feature-branch" } } },
      makeEvent("check_run"),
      "check_run",
    );
    expect(router.taskManager.getTaskForBranch).toHaveBeenCalledWith("feature-branch");
    expect(router.sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("forwards check_suite to the task resolved from head_branch", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign("42");
    const router = makeRouter();
    router.taskManager.getTaskForBranch = vi.fn().mockResolvedValue(task);
    const result = await callCheckEvent(
      router,
      { check_suite: { pull_requests: [], head_branch: "feature-branch" } },
      makeEvent("check_suite"),
      "check_suite",
    );
    expect(router.taskManager.getTaskForBranch).toHaveBeenCalledWith("feature-branch");
    expect(router.sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("returns null when neither PR nor branch matches a task", async () => {
    const router = makeRouter();
    const result = await callCheckEvent(
      router,
      { check_run: { pull_requests: [], check_suite: { head_branch: "unknown-branch" } } },
      makeEvent("check_run"),
      "check_run",
    );
    expect(result).toEqual({ taskId: null, workerId: null });
  });
});

// ── routeIssueEvent ───────────────────────────────────────────────────────────

describe("routeIssueEvent — enqueue on labeled", () => {
  it("enqueues the issue and starts dep loading when labeled with task label", async () => {
    const router = makeRouter();
    const issue = { number: 42, title: "Do something", body: "details", state: "open", labels: [{ name: "brunel:ready" }] };
    const result = await callIssueEvent(
      router,
      { action: "labeled", label: { name: "brunel:ready" }, repository: { html_url: "https://github.com/owner/repo" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(router.taskManager.enqueueIssue).toHaveBeenCalledWith("42", 42, "owner/repo", "Do something", "details", ["brunel:ready"]);
    expect(result).toEqual({ taskId: "42", workerId: null });
  });

  it("ignores a labeled event when the issue is already closed", async () => {
    const router = makeRouter();
    const issue = { number: 42, title: "Do something", body: "", state: "closed", labels: [{ name: "brunel:ready" }] };
    const result = await callIssueEvent(
      router,
      { action: "labeled", label: { name: "brunel:ready" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(router.taskManager.enqueueIssue).not.toHaveBeenCalled();
    expect(result).toEqual({ taskId: null, workerId: null });
    expect(router.flog).toHaveBeenCalledWith(expect.stringContaining("ignoring"));
  });

  it("ignores a labeled event for a different label", async () => {
    const router = makeRouter();
    const issue = { number: 42, title: "Do something", body: "", state: "open", labels: [] };
    const result = await callIssueEvent(
      router,
      { action: "labeled", label: { name: "other-label" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(router.taskManager.enqueueIssue).not.toHaveBeenCalled();
    expect(result).toEqual({ taskId: null, workerId: null });
  });
});

describe("routeIssueEvent — enqueue on opened", () => {
  it("enqueues the issue when opened with the task label already attached", async () => {
    const router = makeRouter();
    const issue = { number: 42, title: "Do something", body: "details", state: "open", labels: [{ name: "brunel:ready" }] };
    const result = await callIssueEvent(
      router,
      { action: "opened", repository: { html_url: "https://github.com/owner/repo" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(router.taskManager.enqueueIssue).toHaveBeenCalled();
    expect(result).toEqual({ taskId: "42", workerId: null });
  });

  it("does not enqueue when opened without the task label", async () => {
    const router = makeRouter();
    const issue = { number: 42, title: "Do something", body: "", state: "open", labels: [] };
    const result = await callIssueEvent(
      router,
      { action: "opened" },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(router.taskManager.enqueueIssue).not.toHaveBeenCalled();
    expect(result).toEqual({ taskId: null, workerId: null });
  });
});

describe("routeIssueEvent — unlabeled (dequeue)", () => {
  it("dequeues the task when the task label is removed", async () => {
    taskStore.addTask({ task_id: "42", issue_number: 42 });
    const router = makeRouter();
    const issue = { number: 42 };
    await callIssueEvent(
      router,
      { action: "unlabeled", label: { name: "brunel:ready" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(router.taskManager.dequeueIssue).toHaveBeenCalledWith(42);
    expect(router.flog).toHaveBeenCalledWith(expect.stringContaining("dequeued"));
  });

  it("does not dequeue when a different label is removed", async () => {
    taskStore.addTask({ task_id: "42", issue_number: 42 });
    const router = makeRouter();
    const issue = { number: 42 };
    await callIssueEvent(
      router,
      { action: "unlabeled", label: { name: "other-label" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(router.taskManager.dequeueIssue).not.toHaveBeenCalled();
  });
});

describe("routeIssueEvent — closed", () => {
  it("calls closeIssue when an issue is closed", async () => {
    const router = makeRouter();
    const issue = { number: 42 };
    await callIssueEvent(
      router,
      { action: "closed" },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(router.taskManager.closeIssue).toHaveBeenCalledWith(42);
  });
});

describe("routeIssueEvent — reopened", () => {
  it("calls reopenIssue when an issue is reopened", async () => {
    const router = makeRouter();
    const issue = { number: 42 };
    await callIssueEvent(
      router,
      { action: "reopened" },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(router.taskManager.reopenIssue).toHaveBeenCalledWith(42);
  });
});

describe("routeIssueEvent — edited", () => {
  it("resets and reloads blockers when the issue body is edited for a tracked task", async () => {
    taskStore.addTask({ task_id: "42", issue_number: 42 });
    const router = makeRouter();
    // Prevent real fetchIssueStates network call by spying on startDepsLoad
    vi.spyOn(router as any, "startDepsLoad").mockReturnValue(undefined);
    const issue = { number: 42, body: "updated body" };
    await callIssueEvent(
      router,
      { action: "edited", changes: { body: { from: "old body" } } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(router.taskManager.resetBlockers).toHaveBeenCalledWith(42);
    expect((router as any).startDepsLoad).toHaveBeenCalledWith(42, "updated body");
  });

  it("does not reset blockers when the body was not changed", async () => {
    taskStore.addTask({ task_id: "42", issue_number: 42 });
    const router = makeRouter();
    const issue = { number: 42, title: "updated title" };
    await callIssueEvent(
      router,
      { action: "edited", changes: { title: { from: "old title" } } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(router.taskManager.resetBlockers).not.toHaveBeenCalled();
  });
});

describe("routeIssueEvent — passthrough forwarding", () => {
  it("forwards other issue events to the tracked task", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign("42");
    const router = makeRouter();
    const issue = { number: 42 };
    const result = await callIssueEvent(
      router,
      { action: "assigned" },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(router.sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });

  it("routes issue_comment on a PR via getByPr fallback", async () => {
    const task = taskStore.addTask({ task_id: "42", issue_number: 42, pr_number: 99 });
    const w = Worker.register("worker-1", fakeWs());
    task.workerId = "worker-1";
    w.assign("42");
    const router = makeRouter();
    const issue = { number: 99 }; // PR number in issue.number
    const result = await callIssueEvent(
      router,
      { action: "created" },
      makeEvent("issue_comment"),
      issue,
      99,
    );
    expect(router.sendMsg).toHaveBeenCalledOnce();
    expect(result.taskId).toBe("42");
  });
});
