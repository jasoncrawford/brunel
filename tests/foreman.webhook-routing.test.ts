/**
 * Tests for webhook-triggered task enqueueing and worker assignment.
 *
 * Covers the bug in issue #53: when a GitHub webhook fires for an issue
 * being labeled brunel:ready, the foreman was not enqueueing the task or
 * dispatching it to idle workers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "net";
import { TaskQueue, WorkerRegistry, createForemanWss } from "../src/foreman.js";
import { loadDefaultConfig } from "../src/config.js";
const defaultCfg = await loadDefaultConfig();
import type { ForemanMessage } from "../src/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function connectWorker(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/worker`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMsg(ws: WebSocket): Promise<ForemanMessage> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

/** Collects messages until predicate returns true; resolves with the matching message. */
function nextMsgWhere(ws: WebSocket, predicate: (msg: ForemanMessage) => boolean): Promise<ForemanMessage> {
  return new Promise((resolve) => {
    const handler = (data: Buffer | string) => {
      const msg: ForemanMessage = JSON.parse(data.toString());
      if (predicate(msg)) {
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
}

function send(ws: WebSocket, msg: object) {
  ws.send(JSON.stringify(msg));
}

function closeClient(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.once("close", resolve);
    ws.close();
  });
}

function labeledPayload(issueNumber: number, labelName: string) {
  return {
    action: "labeled",
    label: { name: labelName },
    issue: {
      number: issueNumber,
      title: `Issue ${issueNumber}`,
      body: `Body of issue ${issueNumber}`,
      labels: [{ name: labelName }],
    },
    repository: { html_url: "https://github.com/owner/repo" },
  };
}

function openedPayload(issueNumber: number, labels: string[]) {
  return {
    action: "opened",
    issue: {
      number: issueNumber,
      title: `Issue ${issueNumber}`,
      body: `Body of issue ${issueNumber}`,
      labels: labels.map((name) => ({ name })),
    },
    repository: { html_url: "https://github.com/owner/repo" },
  };
}

function prOpenedPayload(prNumber: number, body: string, headBranch = `branch-for-pr-${prNumber}`) {
  return {
    action: "opened",
    pull_request: {
      number: prNumber,
      title: `PR ${prNumber}`,
      body,
      head: { ref: headBranch },
    },
    repository: { html_url: "https://github.com/owner/repo" },
  };
}

// Real-world: GitHub sends empty pull_requests for branch-push-triggered check events
function checkRunPayloadByBranch(headBranch: string, conclusion: string) {
  return {
    action: "completed",
    check_run: {
      name: "CI",
      conclusion,
      output: { summary: "Test output" },
      pull_requests: [],
      check_suite: { head_branch: headBranch },
    },
    repository: { html_url: "https://github.com/owner/repo" },
  };
}

function checkSuitePayloadByBranch(headBranch: string, conclusion: string) {
  return {
    action: "completed",
    check_suite: {
      conclusion,
      pull_requests: [],
      head_branch: headBranch,
    },
    repository: { html_url: "https://github.com/owner/repo" },
  };
}

function checkRunPayload(prNumber: number, conclusion: string) {
  return {
    action: "completed",
    check_run: {
      name: "CI",
      conclusion,
      output: { summary: "Test output" },
      pull_requests: [{ number: prNumber }],
    },
    repository: { html_url: "https://github.com/owner/repo" },
  };
}

function prReviewPayload(prNumber: number) {
  return {
    action: "submitted",
    pull_request: { number: prNumber, title: "PR title" },
    review: { state: "changes_requested", body: "Please fix this." },
    repository: { html_url: "https://github.com/owner/repo" },
  };
}

function prReviewCommentPayload(prNumber: number) {
  return {
    action: "created",
    pull_request: { number: prNumber, title: "PR title" },
    comment: { body: "Nit: rename this", path: "src/foo.ts" },
    repository: { html_url: "https://github.com/owner/repo" },
  };
}

function issueCommentPayload(prOrIssueNumber: number, body = "LGTM") {
  return {
    action: "created",
    issue: { number: prOrIssueNumber, title: `Issue/PR ${prOrIssueNumber}`, pull_request: {} },
    comment: { body, user: { login: "reviewer" } },
    repository: { html_url: "https://github.com/owner/repo" },
  };
}

function checkSuitePayload(prNumber: number, conclusion: string) {
  return {
    action: "completed",
    check_suite: {
      conclusion,
      pull_requests: [{ number: prNumber }],
    },
    repository: { html_url: "https://github.com/owner/repo" },
  };
}

// ── Test harness ──────────────────────────────────────────────────────────────

let queue: TaskQueue;
let registry: WorkerRegistry;
let httpServer: http.Server;
let wss: WebSocketServer;
let routeEvent: (id: string, name: string, payload: unknown) => void;
let port: number;
const openClients: WebSocket[] = [];

function connect(): Promise<WebSocket> {
  return connectWorker(port).then((ws) => { openClients.push(ws); return ws; });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { repository: { issue: { blockedBy: { nodes: [] } } } } }) }));
  process.env.GITHUB_REPO = "owner/repo";
  process.env.GITHUB_TOKEN = "token";
  process.env.TASK_LABEL = "brunel:ready";
  process.env.DONE_LABEL = "brunel:done";

  queue = new TaskQueue();
  registry = new WorkerRegistry();
  httpServer = http.createServer();
  ({ wss, routeEvent } = createForemanWss(queue, registry, httpServer, { taskLabel: defaultCfg.taskLabel, reclaimTimeoutMs: defaultCfg.workerReclaimTimeoutMs }));

  return new Promise<void>((resolve) => {
    httpServer.listen(0, () => {
      port = (httpServer.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GITHUB_REPO;
  delete process.env.GITHUB_TOKEN;
  delete process.env.TASK_LABEL;
  delete process.env.DONE_LABEL;

  return new Promise<void>((resolve) => {
    const clients = openClients.splice(0);
    const alive = clients.filter((c) => c.readyState !== WebSocket.CLOSED);
    if (alive.length === 0) {
      wss.close(() => httpServer.close(resolve));
      return;
    }
    let pending = alive.length;
    for (const c of alive) {
      c.once("close", () => {
        if (--pending === 0) wss.close(() => httpServer.close(resolve));
      });
      c.close();
    }
  });
});

// ── Scenarios ─────────────────────────────────────────────────────────────────

describe("webhook-triggered task routing", () => {
  it("issues/labeled with task label assigns task to idle worker", async () => {
    // Worker connects and waits in standby (no tasks yet)
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // standby

    // Webhook fires: issue #42 gets labeled brunel:ready.
    // reconcile() runs synchronously (task depsLoaded:false → standby),
    // then startDepsLoad completes async → reconcile() assigns the task.
    // Use nextMsgWhere to skip intermediate standby(s) and wait for task_assigned.
    const reply = nextMsgWhere(ws, (m) => m.type === "task_assigned");
    routeEvent("evt-1", "issues", labeledPayload(42, "brunel:ready"));

    const msg = await reply;
    expect(msg.type).toBe("task_assigned");
    expect((msg as any).issue.number).toBe(42);
    expect((msg as any).issue.title).toBe("Issue 42");
    expect((msg as any).issue.repoUrl).toBe("https://github.com/owner/repo");
    expect(queue.get("42")?.status).toBe("assigned");
    expect(registry.get("w1")?.status).toBe("busy");
  });

  it("issues/labeled with non-task label does not enqueue or assign", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // standby

    // No message should arrive after an unrelated label event
    routeEvent("evt-1", "issues", labeledPayload(42, "some-other-label"));
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);

    expect(raceResult).toBe("timeout");
    expect(queue.getTaskForIssue(42)).toBeUndefined();
  });

  it("issues/labeled with task label enqueues task when no idle worker available", () => {
    // No worker connected at all
    routeEvent("evt-1", "issues", labeledPayload(42, "brunel:ready"));

    const task = queue.getTaskForIssue(42);
    expect(task).toBeDefined();
    expect(task?.status).toBe("pending");
    expect(task?.issueNumber).toBe(42);
    expect(task?.repoUrl).toBe("https://github.com/owner/repo");
  });

  it("pending task from webhook gets assigned when worker later connects", async () => {
    // Webhook fires before any worker is available
    routeEvent("evt-1", "issues", labeledPayload(42, "brunel:ready"));
    expect(queue.getTaskForIssue(42)?.status).toBe("pending");

    // Worker connects afterwards and should receive the task
    const ws = await connect();
    const reply = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });

    const msg = await reply;
    expect(msg.type).toBe("task_assigned");
    expect((msg as any).issue.number).toBe(42);
    expect(queue.get("42")?.status).toBe("assigned");
  });

  it("issues/labeled does not enqueue duplicate if issue already in queue", async () => {
    // Pre-populate the queue with this issue
    queue.addTask({
      taskId: "42",
      issueNumber: 42,
      title: "Existing Issue",
      body: "Body",
      labels: ["brunel:ready"],
      repoUrl: "https://github.com/owner/repo",
    });

    routeEvent("evt-1", "issues", labeledPayload(42, "brunel:ready"));

    // Only one task should exist, and it should still be pending
    expect(queue.get("42")?.status).toBe("pending");
    // Confirm it's really the same task (title unchanged from original)
    expect(queue.get("42")?.title).toBe("Existing Issue");
  });

  it("issues/opened with task label in issue labels assigns task to idle worker", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // standby

    // Webhook fires: issue #99 opened with task label.
    // reconcile() runs synchronously (task depsLoaded:false → standby),
    // then startDepsLoad completes async → reconcile() assigns the task.
    // Use nextMsgWhere to skip intermediate standby(s) and wait for task_assigned.
    const reply = nextMsgWhere(ws, (m) => m.type === "task_assigned");
    routeEvent("evt-1", "issues", openedPayload(99, ["brunel:ready", "bug"]));

    const msg = await reply;
    expect(msg.type).toBe("task_assigned");
    expect((msg as any).issue.number).toBe(99);
    expect(queue.get("99")?.status).toBe("assigned");
    expect(registry.get("w1")?.status).toBe("busy");
  });

  it("issues/opened without task label does not enqueue", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // standby

    routeEvent("evt-1", "issues", openedPayload(99, ["bug", "enhancement"]));
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);

    expect(raceResult).toBe("timeout");
    expect(queue.getTaskForIssue(99)).toBeUndefined();
  });

  it("busy worker is not interrupted when new task arrives via webhook", async () => {
    // Give worker an existing task
    queue.addTask({
      taskId: "1",
      issueNumber: 1,
      title: "First Issue",
      body: "Body",
      labels: ["brunel:ready"],
      repoUrl: "https://github.com/owner/repo",
    });
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned for issue 1

    // New issue arrives via webhook
    routeEvent("evt-1", "issues", labeledPayload(2, "brunel:ready"));

    // Worker should NOT receive a new task_assigned while still busy
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");

    // But issue 2 should be pending, ready for when the worker finishes
    expect(queue.getTaskForIssue(2)?.status).toBe("pending");
  });
});

describe("PR event forwarding to workers", () => {
  it("pull_request/opened with closing keyword registers PR and routes check_run to worker", async () => {
    // Set up a task for issue 42
    queue.addTask({
      taskId: "42",
      issueNumber: 42,
      title: "Issue 42",
      body: "Body",
      labels: ["brunel:ready"],
      repoUrl: "https://github.com/owner/repo",
    });

    // Worker connects and receives the task
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned

    // Worker opens a PR that closes issue #42
    routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Fixes #42\n\nSome description."));

    // check_run for that PR should now be forwarded to the worker
    const reply = nextMsg(ws);
    routeEvent("evt-cr", "check_run", checkRunPayload(10, "failure"));

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("check_run");
  });

  it("pull_request_review for a registered PR is forwarded to the worker", async () => {
    queue.addTask({
      taskId: "42",
      issueNumber: 42,
      title: "Issue 42",
      body: "Body",
      labels: ["brunel:ready"],
      repoUrl: "https://github.com/owner/repo",
    });

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned

    routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Closes #42"));

    const reply = nextMsg(ws);
    routeEvent("evt-rev", "pull_request_review", prReviewPayload(10));

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("pull_request_review");
  });

  it("pull_request_review_comment for a registered PR is forwarded to the worker", async () => {
    queue.addTask({
      taskId: "42",
      issueNumber: 42,
      title: "Issue 42",
      body: "Body",
      labels: ["brunel:ready"],
      repoUrl: "https://github.com/owner/repo",
    });

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned

    routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Resolves #42"));

    const reply = nextMsg(ws);
    routeEvent("evt-cmt", "pull_request_review_comment", prReviewCommentPayload(10));

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("pull_request_review_comment");
  });

  it("pull_request/opened without linked issue does not crash and is not forwarded", async () => {
    queue.addTask({
      taskId: "42",
      issueNumber: 42,
      title: "Issue 42",
      body: "Body",
      labels: ["brunel:ready"],
      repoUrl: "https://github.com/owner/repo",
    });

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned

    // PR with no linked issue — should be silently ignored
    routeEvent("evt-pr", "pull_request", prOpenedPayload(99, "A new PR with no issue reference."));

    // check_run for that PR should not be forwarded
    routeEvent("evt-cr", "check_run", checkRunPayload(99, "failure"));
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it("check_run for unknown PR is silently dropped", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // standby

    routeEvent("evt-cr", "check_run", checkRunPayload(999, "failure"));
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it("check_suite/completed for a registered PR is forwarded to the worker", async () => {
    queue.addTask({
      taskId: "42",
      issueNumber: 42,
      title: "Issue 42",
      body: "Body",
      labels: ["brunel:ready"],
      repoUrl: "https://github.com/owner/repo",
    });

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned

    routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Closes #42"));

    const reply = nextMsg(ws);
    routeEvent("evt-cs", "check_suite", checkSuitePayload(10, "failure"));

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("check_suite");
  });

  it("check_suite for unknown PR is silently dropped", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // standby

    routeEvent("evt-cs", "check_suite", checkSuitePayload(999, "failure"));
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it("check_suite with empty pull_requests is routed by head_branch", async () => {
    queue.addTask({
      taskId: "42", issueNumber: 42, title: "Issue 42", body: "Body",
      labels: ["brunel:ready"], repoUrl: "https://github.com/owner/repo",
    });
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned

    routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Closes #42", "fix-issue-42"));

    const reply = nextMsg(ws);
    routeEvent("evt-cs", "check_suite", checkSuitePayloadByBranch("fix-issue-42", "failure"));

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("check_suite");
  });

  it("check_run with empty pull_requests is routed by head_branch", async () => {
    queue.addTask({
      taskId: "42", issueNumber: 42, title: "Issue 42", body: "Body",
      labels: ["brunel:ready"], repoUrl: "https://github.com/owner/repo",
    });
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned

    routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Closes #42", "fix-issue-42"));

    const reply = nextMsg(ws);
    routeEvent("evt-cr", "check_run", checkRunPayloadByBranch("fix-issue-42", "failure"));

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("check_run");
  });

  it("check_suite with empty pull_requests and unknown branch is silently dropped", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // standby

    routeEvent("evt-cs", "check_suite", checkSuitePayloadByBranch("unknown-branch", "failure"));
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });
});

  it("issue_comment/created on a PR is forwarded to the worker handling that issue", async () => {
    queue.addTask({
      taskId: "42",
      issueNumber: 42,
      title: "Issue 42",
      body: "Body",
      labels: ["brunel:ready"],
      repoUrl: "https://github.com/owner/repo",
    });

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned

    // Worker opens PR #10 that closes issue #42
    routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Closes #42"));

    // User posts a top-level comment on PR #10 — issue.number = 10 (the PR number)
    const reply = nextMsg(ws);
    routeEvent("evt-cmt", "issue_comment", issueCommentPayload(10, "Please address the nit above."));

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("issue_comment");
  });

describe("foreman event filtering", () => {
  it("pull_request/synchronize is dropped and not forwarded to worker", async () => {
    queue.addTask({
      taskId: "42",
      issueNumber: 42,
      title: "Issue 42",
      body: "Body",
      labels: ["brunel:ready"],
      repoUrl: "https://github.com/owner/repo",
    });

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned

    // Register PR for the task
    routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Closes #42"));

    // synchronize event should be silently dropped
    routeEvent("evt-sync", "pull_request", {
      action: "synchronize",
      pull_request: { number: 10, title: "PR 10", body: "Closes #42", head: { ref: "branch" } },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it('issues/unlabeled with task label removes a pending task from the queue', async () => {
    // Enqueue task via webhook (no worker connected, so it stays pending)
    routeEvent("evt-labeled", "issues", labeledPayload(42, "brunel:ready"));
    expect(queue.getTaskForIssue(42)?.status).toBe("pending");

    // Remove the label — pending task should be dequeued
    routeEvent("evt-unlabeled", "issues", {
      action: "unlabeled",
      label: { name: "brunel:ready" },
      issue: { number: 42, title: "Issue 42", body: "Body", labels: [] },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    expect(queue.getTaskForIssue(42)).toBeUndefined();
  });

  it('issues/unlabeled with task label does not remove an already-assigned task', async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // standby

    const reply = nextMsg(ws);
    routeEvent("evt-labeled", "issues", labeledPayload(42, "brunel:ready"));
    await reply; // task_assigned

    expect(queue.getTaskForIssue(42)?.status).toBe("assigned");

    // Removing the label should leave the assigned task intact
    routeEvent("evt-unlabeled", "issues", {
      action: "unlabeled",
      label: { name: "brunel:ready" },
      issue: { number: 42, title: "Issue 42", body: "Body", labels: [] },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    expect(queue.getTaskForIssue(42)?.status).toBe("assigned");
  });

  it('issues/unlabeled with non-task label does not remove a pending task', async () => {
    routeEvent("evt-labeled", "issues", labeledPayload(42, "brunel:ready"));
    expect(queue.getTaskForIssue(42)?.status).toBe("pending");

    routeEvent("evt-unlabeled", "issues", {
      action: "unlabeled",
      label: { name: "some-other-label" },
      issue: { number: 42, title: "Issue 42", body: "Body", labels: [{ name: "brunel:ready" }] },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    expect(queue.getTaskForIssue(42)).toBeDefined();
  });
});