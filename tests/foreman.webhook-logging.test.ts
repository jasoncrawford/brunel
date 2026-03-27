/**
 * Tests verifying that webhook events are associated with the correct task when logged.
 *
 * Covers the bug in issue #254: webhook events were always logged with taskId: null,
 * making it impossible to see the real history of a task or worker.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import http from "http";
import { TaskQueue, WorkerRegistry, createForemanWss } from "../src/foreman.js";
import { DEFAULT_TASK_LABEL } from "../src/config.js";
import type { DbLogger, WebhookEventData } from "../src/db.js";

// ── Minimal mock dbLogger ─────────────────────────────────────────────────────

function makeMockDbLogger(): DbLogger & { calls: WebhookEventData[] } {
  const calls: WebhookEventData[] = [];
  return {
    calls,
    logWebhookEvent(data) { calls.push(data); },
    logForemanMessage() {},
    async queryLog() { return []; },
    async queryTaskEvents() { return []; },
    async queryWorkerMessages() { return []; },
  };
}

// ── Test harness ──────────────────────────────────────────────────────────────

let queue: TaskQueue;
let dbLogger: ReturnType<typeof makeMockDbLogger>;
let routeEvent: (id: string, name: string, payload: unknown) => void;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: { repository: { issue: { blockedBy: { nodes: [] } } } } }),
  }));
  process.env.GITHUB_REPO = "owner/repo";
  process.env.GITHUB_TOKEN = "token";

  queue = new TaskQueue();
  dbLogger = makeMockDbLogger();

  const registry = new WorkerRegistry();
  const httpServer = http.createServer();
  ({ routeEventToWorker: routeEvent } = createForemanWss(queue, registry, httpServer, {
    taskLabel: DEFAULT_TASK_LABEL,
    dbLogger,
  }));

  return () => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_REPO;
    delete process.env.GITHUB_TOKEN;
  };
});

// ── Scenarios ─────────────────────────────────────────────────────────────────

describe("webhook event logging associates events with tasks", () => {
  it("logs an issue/labeled event (new task) with the issue number as taskId", () => {
    routeEvent("evt-1", "issues", {
      action: "labeled",
      label: { name: DEFAULT_TASK_LABEL },
      issue: {
        number: 42,
        title: "Fix the bug",
        body: "Body",
        labels: [{ name: DEFAULT_TASK_LABEL }],
      },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    expect(dbLogger.calls).toHaveLength(1);
    expect(dbLogger.calls[0].taskId).toBe("42");
  });

  it("logs an issue_comment event on an existing task with the task's taskId", () => {
    queue.addTask({
      taskId: "42",
      issueNumber: 42,
      title: "Fix the bug",
      body: "Body",
      labels: [],
      repoUrl: "https://github.com/owner/repo",
    });

    routeEvent("evt-1", "issue_comment", {
      action: "created",
      issue: { number: 42, title: "Fix the bug" },
      comment: { body: "LGTM" },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    expect(dbLogger.calls).toHaveLength(1);
    expect(dbLogger.calls[0].taskId).toBe("42");
  });

  it("logs a pull_request/opened event with the linked task's taskId", () => {
    queue.addTask({
      taskId: "42",
      issueNumber: 42,
      title: "Fix the bug",
      body: "Body",
      labels: [],
      repoUrl: "https://github.com/owner/repo",
    });

    routeEvent("evt-1", "pull_request", {
      action: "opened",
      pull_request: {
        number: 10,
        title: "Fix: closes #42",
        body: "Closes #42",
        head: { ref: "fix-issue-42" },
      },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    expect(dbLogger.calls).toHaveLength(1);
    expect(dbLogger.calls[0].taskId).toBe("42");
  });

  it("logs a pull_request/closed event (after PR registered) with the task's taskId", () => {
    queue.addTask({
      taskId: "42",
      issueNumber: 42,
      title: "Fix the bug",
      body: "Body",
      labels: [],
      repoUrl: "https://github.com/owner/repo",
    });

    // Register the PR first
    routeEvent("evt-pr", "pull_request", {
      action: "opened",
      pull_request: { number: 10, title: "Fix", body: "Closes #42", head: { ref: "fix-42" } },
      repository: { html_url: "https://github.com/owner/repo" },
    });
    dbLogger.calls.length = 0; // reset after PR opened

    routeEvent("evt-1", "pull_request", {
      action: "closed",
      pull_request: { number: 10, title: "Fix", body: "Closes #42", head: { ref: "fix-42" } },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    expect(dbLogger.calls).toHaveLength(1);
    expect(dbLogger.calls[0].taskId).toBe("42");
  });

  it("logs a check_run event (by PR number) with the task's taskId", () => {
    queue.addTask({
      taskId: "42",
      issueNumber: 42,
      title: "Fix the bug",
      body: "Body",
      labels: [],
      repoUrl: "https://github.com/owner/repo",
    });
    routeEvent("evt-pr", "pull_request", {
      action: "opened",
      pull_request: { number: 10, title: "Fix", body: "Closes #42", head: { ref: "fix-42" } },
      repository: { html_url: "https://github.com/owner/repo" },
    });
    dbLogger.calls.length = 0;

    routeEvent("evt-1", "check_run", {
      action: "completed",
      check_run: {
        name: "CI",
        conclusion: "success",
        pull_requests: [{ number: 10 }],
      },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    expect(dbLogger.calls).toHaveLength(1);
    expect(dbLogger.calls[0].taskId).toBe("42");
  });

  it("logs a check_run event (by branch) with the task's taskId", () => {
    queue.addTask({
      taskId: "42",
      issueNumber: 42,
      title: "Fix the bug",
      body: "Body",
      labels: [],
      repoUrl: "https://github.com/owner/repo",
    });
    routeEvent("evt-pr", "pull_request", {
      action: "opened",
      pull_request: { number: 10, title: "Fix", body: "Closes #42", head: { ref: "fix-issue-42" } },
      repository: { html_url: "https://github.com/owner/repo" },
    });
    dbLogger.calls.length = 0;

    routeEvent("evt-1", "check_run", {
      action: "completed",
      check_run: {
        name: "CI",
        conclusion: "failure",
        pull_requests: [],
        check_suite: { head_branch: "fix-issue-42" },
      },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    expect(dbLogger.calls).toHaveLength(1);
    expect(dbLogger.calls[0].taskId).toBe("42");
  });

  it("logs a pull_request_review event with the task's taskId", () => {
    queue.addTask({
      taskId: "42",
      issueNumber: 42,
      title: "Fix the bug",
      body: "Body",
      labels: [],
      repoUrl: "https://github.com/owner/repo",
    });
    routeEvent("evt-pr", "pull_request", {
      action: "opened",
      pull_request: { number: 10, title: "Fix", body: "Closes #42", head: { ref: "fix-42" } },
      repository: { html_url: "https://github.com/owner/repo" },
    });
    dbLogger.calls.length = 0;

    routeEvent("evt-1", "pull_request_review", {
      action: "submitted",
      pull_request: { number: 10, title: "Fix" },
      review: { state: "approved" },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    expect(dbLogger.calls).toHaveLength(1);
    expect(dbLogger.calls[0].taskId).toBe("42");
  });

  it("logs an event for an unknown PR with taskId: null", () => {
    routeEvent("evt-1", "pull_request", {
      action: "closed",
      pull_request: { number: 99, title: "Unknown PR", body: "", head: { ref: "unknown" } },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    expect(dbLogger.calls).toHaveLength(1);
    expect(dbLogger.calls[0].taskId).toBeNull();
  });

  it("logs an event with no matching task with taskId: null", () => {
    routeEvent("evt-1", "issues", {
      action: "labeled",
      label: { name: "some-other-label" },
      issue: { number: 100, title: "Unrelated issue", body: "", labels: [] },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    expect(dbLogger.calls).toHaveLength(1);
    expect(dbLogger.calls[0].taskId).toBeNull();
  });
});
