/**
 * Unit tests for the per-event-type routing functions:
 * routePrEvent, routePrReviewEvent, routeCheckEvent, routeIssueEvent.
 *
 * After the seqId refactor these functions return { task, ref } and do NOT
 * call forwardEvent themselves — forwarding is done by routeEvent() after
 * WebhookEvent.log() returns the DB-assigned sequence id.
 *
 * Tests here verify the task-determination and side-effect logic only.
 * End-to-end forwarding behavior is covered in foreman.webhook-routing.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Webhooks } from "@octokit/webhooks";
import { WebhookController } from "../src/foreman/controllers/webhook-controller.js";
import { WorkerMessenger } from "../src/foreman/controllers/worker-messenger.js";
import { TaskManager } from "../src/foreman/models/task-manager.js";
import { Task } from "../src/foreman/models/task.js";
import { Worker } from "../src/foreman/models/worker.js";
import { WebhookEvent } from "../src/foreman/models/webhook-event.js";
import { fakeRepo, resetDb, seedTask, createTestRepo } from "./helpers/task.js";
import * as utils from "../src/utils.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function fakeWs() {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
}

function makeEvent(name = "pull_request"): WebhookEvent {
  return WebhookEvent.fromIncoming("evt-1", name, {});
}

interface TestDeps {
  wss: WebhookController;
  sendMsg: ReturnType<typeof vi.fn>;
  taskManager: TaskManager;
}

async function makeDeps(): Promise<TestDeps> {
  const repo = await createTestRepo("owner/repo");
  const taskManager = repo.taskManager;
  // Spy on all TaskManager methods so the tests can assert calls without side effects
  vi.spyOn(taskManager, "dequeueIssue").mockResolvedValue(undefined);
  vi.spyOn(taskManager, "closeIssue").mockResolvedValue(undefined);
  vi.spyOn(taskManager, "reopenIssue").mockResolvedValue(undefined);
  vi.spyOn(taskManager, "assignIdleWorkers").mockResolvedValue([]);
  vi.spyOn(taskManager, "handleIssueLabeledEvent").mockResolvedValue(null);
  vi.spyOn(taskManager, "handleIssueBodyEditedEvent").mockImplementation(() => {});
  vi.spyOn(taskManager, "handlePrOpenedEvent").mockResolvedValue(null);
  vi.spyOn(taskManager, "handlePrClosedEvent").mockResolvedValue(null);
  vi.spyOn(taskManager, "getTaskForCheckEvent").mockResolvedValue(null);
  const messenger = new WorkerMessenger({});
  const wss = new WebhookController({
    webhooks: new Webhooks({ secret: "test-secret" }),
    config: { taskLabel: "brunel:ready" },
    messenger,
    assignWork: async () => {},
  });
  const sendMsg = vi.spyOn(messenger, "send").mockImplementation(() => false);
  return { wss, sendMsg, taskManager };
}

let logSpy: ReturnType<typeof vi.spyOn>;
let testRepoId: number;

beforeEach(async () => {
  Worker._reset();
  resetDb();
  const repo = await createTestRepo("owner/repo");
  testRepoId = repo.id;
  logSpy = vi.spyOn(utils, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── routePrEvent ──────────────────────────────────────────────────────────────

describe("routePrEvent — missing PR number", () => {
  it("returns null task when pull_request has no number", async () => {
    const { wss } = await makeDeps();
    const result = await wss.routePrEvent({ pull_request: {} }, makeEvent());
    expect(result.task).toBeNull();
  });
});

describe("routePrEvent — synchronize", () => {
  it("returns the task with forward=false when action is synchronize", async () => {
    await seedTask({ task_id: "42", issue_number: 42, pr_number: 99, repo_id: testRepoId });
    const { wss, sendMsg } = await makeDeps();
    const result = await wss.routePrEvent(
      { action: "synchronize", pull_request: { number: 99 }, repository: { full_name: "owner/repo" } },
      makeEvent(),
    );
    expect(result.task?.taskId).toBe("42");
    expect(result.forward).toBe(false);
    // Routing functions do not forward — sendMsg is never called here
    expect(sendMsg).not.toHaveBeenCalled();
  });
});

describe("routePrEvent — opened", () => {
  it("calls handlePrOpenedEvent and returns the linked task", async () => {
    const task = await seedTask({ task_id: "42", issue_number: 42, repo_id: testRepoId, worker_id: "worker-1", assigned_at: new Date().toISOString() });
    const { wss, taskManager } = await makeDeps();
    taskManager.handlePrOpenedEvent.mockResolvedValue(task);
    const result = await wss.routePrEvent(
      {
        action: "opened",
        pull_request: {
          number: 99,
          body: "Closes #42",
          head: { ref: "feature-branch" },
        },
        repository: { full_name: "owner/repo" },
      },
      makeEvent(),
    );
    expect(taskManager.handlePrOpenedEvent).toHaveBeenCalledWith(99, "Closes #42", "feature-branch");
    expect(result.task?.taskId).toBe("42");
  });

  it("returns null task when handlePrOpenedEvent finds no linked issue", async () => {
    const { wss, taskManager } = await makeDeps();
    taskManager.handlePrOpenedEvent.mockResolvedValue(null);
    const result = await wss.routePrEvent(
      { action: "opened", pull_request: { number: 99, body: "no link here", head: { ref: "branch" } }, repository: { full_name: "owner/repo" } },
      makeEvent(),
    );
    expect(result.task).toBeNull();
  });
});

describe("routePrEvent — closed without merge", () => {
  it("calls handlePrClosedEvent and returns the task", async () => {
    const task = await seedTask({ task_id: "42", issue_number: 42, pr_number: 99, repo_id: testRepoId, worker_id: "worker-1", assigned_at: new Date().toISOString() });
    const { wss, taskManager } = await makeDeps();
    taskManager.handlePrClosedEvent.mockResolvedValue(task);
    const result = await wss.routePrEvent(
      { action: "closed", pull_request: { number: 99, merged: false }, repository: { full_name: "owner/repo" } },
      makeEvent(),
    );
    expect(taskManager.handlePrClosedEvent).toHaveBeenCalledWith(99, false);
    expect(result.task?.taskId).toBe("42");
  });

  it("returns null task when no task owns the PR", async () => {
    const { wss, taskManager } = await makeDeps();
    taskManager.handlePrClosedEvent.mockResolvedValue(null);
    const result = await wss.routePrEvent(
      { action: "closed", pull_request: { number: 99, merged: false }, repository: { full_name: "owner/repo" } },
      makeEvent(),
    );
    expect(result.task).toBeNull();
  });
});

describe("routePrEvent — closed with merge", () => {
  it("calls handlePrClosedEvent with merged=true and returns the task", async () => {
    const task = await seedTask({ task_id: "42", issue_number: 42, pr_number: 99, repo_id: testRepoId, worker_id: "worker-1", assigned_at: new Date().toISOString() });
    const { wss, taskManager } = await makeDeps();
    taskManager.handlePrClosedEvent.mockResolvedValue(task);
    const result = await wss.routePrEvent(
      { action: "closed", pull_request: { number: 99, merged: true }, repository: { full_name: "owner/repo" } },
      makeEvent(),
    );
    expect(taskManager.handlePrClosedEvent).toHaveBeenCalledWith(99, true);
    expect(result.task?.taskId).toBe("42");
  });

  it("returns null task when no task owns the PR", async () => {
    const { wss } = await makeDeps();
    const result = await wss.routePrEvent(
      { action: "closed", pull_request: { number: 99, merged: true }, repository: { full_name: "owner/repo" } },
      makeEvent(),
    );
    expect(result.task).toBeNull();
  });
});

describe("routePrEvent — passthrough", () => {
  it("returns the task for other PR events", async () => {
    await seedTask({ task_id: "42", issue_number: 42, pr_number: 99, repo_id: testRepoId, worker_id: "worker-1", assigned_at: new Date().toISOString() });
    const { wss } = await makeDeps();
    const result = await wss.routePrEvent(
      { action: "labeled", pull_request: { number: 99 }, repository: { full_name: "owner/repo" } },
      makeEvent(),
    );
    expect(result.task?.taskId).toBe("42");
  });

  it("returns null task when no task owns the PR", async () => {
    const { wss } = await makeDeps();
    const result = await wss.routePrEvent(
      { action: "labeled", pull_request: { number: 99 }, repository: { full_name: "owner/repo" } },
      makeEvent(),
    );
    expect(result.task).toBeNull();
  });
});

// ── routePrReviewEvent ────────────────────────────────────────────────────────

describe("routePrReviewEvent", () => {
  it("returns null task when PR number is missing", async () => {
    const { wss } = await makeDeps();
    const result = await wss.routePrReviewEvent({ pull_request: {} }, makeEvent("pull_request_review"));
    expect(result.task).toBeNull();
  });

  it("returns the task that owns the PR", async () => {
    await seedTask({ task_id: "42", issue_number: 42, pr_number: 99, repo_id: testRepoId, worker_id: "worker-1", assigned_at: new Date().toISOString() });
    const { wss } = await makeDeps();
    const result = await wss.routePrReviewEvent(
      { pull_request: { number: 99 }, repository: { full_name: "owner/repo" } },
      makeEvent("pull_request_review"),
    );
    expect(result.task?.taskId).toBe("42");
  });

  it("returns null task when no task owns the reviewed PR", async () => {
    const { wss } = await makeDeps();
    const result = await wss.routePrReviewEvent(
      { pull_request: { number: 99 }, repository: { full_name: "owner/repo" } },
      makeEvent("pull_request_review"),
    );
    expect(result.task).toBeNull();
  });
});

// ── routeCheckEvent ───────────────────────────────────────────────────────────

describe("routeCheckEvent — via PR number", () => {
  it("returns the task when getTaskForCheckEvent finds it by PR (check_run)", async () => {
    const task = await seedTask({ task_id: "42", issue_number: 42, pr_number: 99, repo_id: testRepoId, worker_id: "worker-1", assigned_at: new Date().toISOString() });
    const { wss, taskManager } = await makeDeps();
    taskManager.getTaskForCheckEvent.mockResolvedValue({ task, ref: "PR #99" });
    const result = await wss.routeCheckEvent(
      { check_run: { pull_requests: [{ number: 99 }] }, repository: { full_name: "owner/repo" } },
      makeEvent("check_run"),
    );
    expect(taskManager.getTaskForCheckEvent).toHaveBeenCalledWith([99], "");
    expect(result.task?.taskId).toBe("42");
  });

  it("returns the task when getTaskForCheckEvent finds it by PR (check_suite)", async () => {
    const task = await seedTask({ task_id: "42", issue_number: 42, pr_number: 99, repo_id: testRepoId, worker_id: "worker-1", assigned_at: new Date().toISOString() });
    const { wss, taskManager } = await makeDeps();
    taskManager.getTaskForCheckEvent.mockResolvedValue({ task, ref: "PR #99" });
    const result = await wss.routeCheckEvent(
      { check_suite: { pull_requests: [{ number: 99 }] }, repository: { full_name: "owner/repo" } },
      makeEvent("check_suite"),
    );
    expect(taskManager.getTaskForCheckEvent).toHaveBeenCalledWith([99], "");
    expect(result.task?.taskId).toBe("42");
  });
});

describe("routeCheckEvent — via branch name", () => {
  it("passes head_branch to getTaskForCheckEvent for check_run", async () => {
    const task = await seedTask({ task_id: "42", issue_number: 42, repo_id: testRepoId, worker_id: "worker-1", assigned_at: new Date().toISOString() });
    const { wss, taskManager } = await makeDeps();
    taskManager.getTaskForCheckEvent.mockResolvedValue({ task, ref: "branch feature-branch" });
    const result = await wss.routeCheckEvent(
      { check_run: { pull_requests: [], check_suite: { head_branch: "feature-branch" } }, repository: { full_name: "owner/repo" } },
      makeEvent("check_run"),
    );
    expect(taskManager.getTaskForCheckEvent).toHaveBeenCalledWith([], "feature-branch");
    expect(result.task?.taskId).toBe("42");
  });

  it("passes head_branch to getTaskForCheckEvent for check_suite", async () => {
    const task = await seedTask({ task_id: "42", issue_number: 42, repo_id: testRepoId, worker_id: "worker-1", assigned_at: new Date().toISOString() });
    const { wss, taskManager } = await makeDeps();
    taskManager.getTaskForCheckEvent.mockResolvedValue({ task, ref: "branch feature-branch" });
    const result = await wss.routeCheckEvent(
      { check_suite: { pull_requests: [], head_branch: "feature-branch" }, repository: { full_name: "owner/repo" } },
      makeEvent("check_suite"),
    );
    expect(taskManager.getTaskForCheckEvent).toHaveBeenCalledWith([], "feature-branch");
    expect(result.task?.taskId).toBe("42");
  });

  it("returns null task when getTaskForCheckEvent finds nothing", async () => {
    const { wss } = await makeDeps();
    const result = await wss.routeCheckEvent(
      { check_run: { pull_requests: [], check_suite: { head_branch: "unknown-branch" } }, repository: { full_name: "owner/repo" } },
      makeEvent("check_run"),
    );
    expect(result.task).toBeNull();
  });
});

// ── routeIssueEvent ───────────────────────────────────────────────────────────

describe("routeIssueEvent — enqueue on labeled", () => {
  it("calls handleIssueLabeledEvent and returns the enqueued task", async () => {
    const task = Task.fromTest({ task_id: "42", issue_number: 42, repo_id: testRepoId });
    const { wss, taskManager } = await makeDeps();
    taskManager.handleIssueLabeledEvent.mockResolvedValue(task);
    const issue = { number: 42, title: "Do something", body: "details", state: "open", labels: [{ name: "brunel:ready" }] };
    const result = await wss.routeIssueEvent(
      { action: "labeled", label: { name: "brunel:ready" }, repository: { full_name: "owner/repo" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.handleIssueLabeledEvent).toHaveBeenCalledWith(
      42, "Do something", "details", ["brunel:ready"], "open",
    );
    expect(result.task?.taskId).toBe("42");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("enqueued via issues/labeled"));
  });

  it("returns null task when handleIssueLabeledEvent returns null (e.g. closed issue)", async () => {
    const { wss, taskManager } = await makeDeps();
    taskManager.handleIssueLabeledEvent.mockResolvedValue(null);
    const issue = { number: 42, title: "Do something", body: "", state: "closed", labels: [{ name: "brunel:ready" }] };
    const result = await wss.routeIssueEvent(
      { action: "labeled", label: { name: "brunel:ready" }, repository: { full_name: "owner/repo" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.handleIssueLabeledEvent).toHaveBeenCalled();
    expect(result.task).toBeNull();
  });

  it("ignores a labeled event for a different label", async () => {
    const { wss, taskManager } = await makeDeps();
    const issue = { number: 42, title: "Do something", body: "", state: "open", labels: [] };
    const result = await wss.routeIssueEvent(
      { action: "labeled", label: { name: "other-label" }, repository: { full_name: "owner/repo" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.handleIssueLabeledEvent).not.toHaveBeenCalled();
    expect(result.task).toBeNull();
  });
});

describe("routeIssueEvent — enqueue on opened", () => {
  it("calls handleIssueLabeledEvent when opened with the task label already attached", async () => {
    const task = Task.fromTest({ task_id: "42", issue_number: 42, repo_id: testRepoId });
    const { wss, taskManager } = await makeDeps();
    taskManager.handleIssueLabeledEvent.mockResolvedValue(task);
    const issue = { number: 42, title: "Do something", body: "details", state: "open", labels: [{ name: "brunel:ready" }] };
    const result = await wss.routeIssueEvent(
      { action: "opened", repository: { full_name: "owner/repo" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.handleIssueLabeledEvent).toHaveBeenCalled();
    expect(result.task?.taskId).toBe("42");
  });

  it("does not call handleIssueLabeledEvent when opened without the task label", async () => {
    const { wss, taskManager } = await makeDeps();
    const issue = { number: 42, title: "Do something", body: "", state: "open", labels: [] };
    const result = await wss.routeIssueEvent(
      { action: "opened", repository: { full_name: "owner/repo" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.handleIssueLabeledEvent).not.toHaveBeenCalled();
    expect(result.task).toBeNull();
  });
});

describe("routeIssueEvent — unlabeled (dequeue)", () => {
  it("dequeues the task when the task label is removed", async () => {
    await seedTask({ task_id: "42", issue_number: 42, repo_id: testRepoId });
    const { wss, taskManager } = await makeDeps();
    const issue = { number: 42 };
    await wss.routeIssueEvent(
      { action: "unlabeled", label: { name: "brunel:ready" }, repository: { full_name: "owner/repo" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.dequeueIssue).toHaveBeenCalledWith(42);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("dequeued"));
  });

  it("does not dequeue when a different label is removed", async () => {
    await seedTask({ task_id: "42", issue_number: 42, repo_id: testRepoId });
    const { wss, taskManager } = await makeDeps();
    const issue = { number: 42 };
    const result = await wss.routeIssueEvent(
      { action: "unlabeled", label: { name: "other-label" }, repository: { full_name: "owner/repo" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.dequeueIssue).not.toHaveBeenCalled();
    // Non-task label removal falls through: task exists, so task is returned
    expect(result.task?.taskId).toBe("42");
  });
});

describe("routeIssueEvent — closed", () => {
  it("calls closeIssue when an issue is closed", async () => {
    const { wss, taskManager } = await makeDeps();
    const issue = { number: 42 };
    await wss.routeIssueEvent(
      { action: "closed", repository: { full_name: "owner/repo" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.closeIssue).toHaveBeenCalledWith(42);
  });

  it("returns the tracked task when the issue is closed", async () => {
    await seedTask({ task_id: "42", issue_number: 42, repo_id: testRepoId });
    const { wss, taskManager } = await makeDeps();
    const issue = { number: 42 };
    const result = await wss.routeIssueEvent(
      { action: "closed", repository: { full_name: "owner/repo" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.closeIssue).toHaveBeenCalledWith(42);
    expect(result.task?.taskId).toBe("42");
  });
});

describe("routeIssueEvent — reopened", () => {
  it("calls reopenIssue when an issue is reopened", async () => {
    const { wss, taskManager } = await makeDeps();
    const issue = { number: 42 };
    await wss.routeIssueEvent(
      { action: "reopened", repository: { full_name: "owner/repo" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.reopenIssue).toHaveBeenCalledWith(42);
  });

  it("returns the tracked task when the issue is reopened", async () => {
    await seedTask({ task_id: "42", issue_number: 42, repo_id: testRepoId });
    const { wss, taskManager } = await makeDeps();
    const issue = { number: 42 };
    const result = await wss.routeIssueEvent(
      { action: "reopened", repository: { full_name: "owner/repo" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.reopenIssue).toHaveBeenCalledWith(42);
    expect(result.task?.taskId).toBe("42");
  });
});

describe("routeIssueEvent — edited", () => {
  it("calls handleIssueBodyEditedEvent when the issue body is edited for a tracked task", async () => {
    await seedTask({ task_id: "42", issue_number: 42, repo_id: testRepoId });
    const { wss, taskManager } = await makeDeps();
    const issue = { number: 42, body: "updated body" };
    const result = await wss.routeIssueEvent(
      { action: "edited", changes: { body: { from: "old body" } }, repository: { full_name: "owner/repo" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.handleIssueBodyEditedEvent).toHaveBeenCalledWith(
      42, "updated body",
    );
    expect(result.task?.taskId).toBe("42");
  });

  it("does not call handleIssueBodyEditedEvent when the body was not changed", async () => {
    await seedTask({ task_id: "42", issue_number: 42, repo_id: testRepoId });
    const { wss, taskManager } = await makeDeps();
    const issue = { number: 42, title: "updated title" };
    const result = await wss.routeIssueEvent(
      { action: "edited", changes: { title: { from: "old title" } }, repository: { full_name: "owner/repo" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.handleIssueBodyEditedEvent).not.toHaveBeenCalled();
    // Task exists, so task is still returned even when body didn't change
    expect(result.task?.taskId).toBe("42");
  });

  it("does not call handleIssueBodyEditedEvent when the issue is not tracked", async () => {
    const { wss, taskManager } = await makeDeps();
    const issue = { number: 42, body: "updated body" };
    await wss.routeIssueEvent(
      { action: "edited", changes: { body: { from: "old body" } }, repository: { full_name: "owner/repo" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(taskManager.handleIssueBodyEditedEvent).not.toHaveBeenCalled();
  });

  it("persists updated body to DB when body is edited", async () => {
    await seedTask({ task_id: "42", issue_number: 42, repo_id: testRepoId, body: "original body" });
    const { wss } = await makeDeps();
    await wss.routeIssueEvent(
      { action: "edited", changes: { body: { from: "original body" } }, repository: { full_name: "owner/repo" } },
      makeEvent("issues"),
      { number: 42, body: "updated body" },
      42,
    );
    const task = await Task.getByRepoIssue(testRepoId, 42);
    expect(task?.body).toBe("updated body");
  });

  it("persists updated title to DB when title is edited", async () => {
    await seedTask({ task_id: "42", issue_number: 42, repo_id: testRepoId, title: "original title" });
    const { wss } = await makeDeps();
    await wss.routeIssueEvent(
      { action: "edited", changes: { title: { from: "original title" } }, repository: { full_name: "owner/repo" } },
      makeEvent("issues"),
      { number: 42, title: "updated title" },
      42,
    );
    const task = await Task.getByRepoIssue(testRepoId, 42);
    expect(task?.title).toBe("updated title");
  });
});

describe("routeIssueEvent — passthrough forwarding", () => {
  it("returns the tracked task for other issue events", async () => {
    await seedTask({ task_id: "42", issue_number: 42, repo_id: testRepoId, worker_id: "worker-1", assigned_at: new Date().toISOString() });
    const { wss } = await makeDeps();
    const issue = { number: 42 };
    const result = await wss.routeIssueEvent(
      { action: "assigned", repository: { full_name: "owner/repo" } },
      makeEvent("issues"),
      issue,
      42,
    );
    expect(result.task?.taskId).toBe("42");
  });

  it("routes issue_comment on a PR via getByPr fallback", async () => {
    await seedTask({ task_id: "42", issue_number: 42, pr_number: 99, repo_id: testRepoId, worker_id: "worker-1", assigned_at: new Date().toISOString() });
    const { wss } = await makeDeps();
    const issue = { number: 99 }; // PR number in issue.number
    const result = await wss.routeIssueEvent(
      { action: "created", repository: { full_name: "owner/repo" } },
      makeEvent("issue_comment"),
      issue,
      99,
    );
    expect(result.task?.taskId).toBe("42");
  });
});
