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
import { WorkerRegistry } from "../src/foreman/models/worker-registry.js";
import { createForemanWss } from "../src/foreman/controllers/wss.js";
import { TaskModel } from "../src/foreman/models/task-model.js";
import { loadDefaultConfig } from "../src/config.js";
const defaultCfg = await loadDefaultConfig();
import type { ForemanMessage } from "../src/types.js";
import { waitUntil } from "./helpers.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Register a task and mark its deps as loaded so tryAssignWork will pick it up. */
async function registerReady(
  tm: TaskModel,
  taskId: string,
  issueNumber: number,
  repoSlug: string,
  title: string,
  body: string,
  labels: string[],
): Promise<void> {
  await tm.register(taskId, issueNumber, repoSlug, title, body, labels);
  tm.trackIssue(issueNumber, {
    number: issueNumber, title, body, labels,
    repoUrl: `https://github.com/${repoSlug}`,
  }, true);
}

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

function prClosedPayload(prNumber: number, merged: boolean) {
  return {
    action: "closed",
    pull_request: {
      number: prNumber,
      title: `PR ${prNumber}`,
      merged,
      head: { ref: `branch-for-pr-${prNumber}` },
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

let taskModel: TaskModel;
let registry: WorkerRegistry;
let httpServer: http.Server;
let wss: WebSocketServer;
let routeEvent: (id: string, name: string, payload: unknown) => Promise<void>;
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

  taskModel = new TaskModel();
  registry = new WorkerRegistry();
  httpServer = http.createServer();
  ({ wss, routeEvent } = createForemanWss(taskModel, registry, httpServer, defaultCfg));

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
    // Worker connects idle (no tasks yet)
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await waitUntil(() => !!registry.get("w1"));

    // Webhook fires: issue #42 gets labeled brunel:ready.
    // then startDepsLoad completes async → reconcile() assigns the task.
    // Use nextMsgWhere in case startDepsLoad resolves asynchronously before task_assigned.
    const reply = nextMsgWhere(ws, (m) => m.type === "task_assigned");
    routeEvent("evt-1", "issues", labeledPayload(42, "brunel:ready"));

    const msg = await reply;
    expect(msg.type).toBe("task_assigned");
    expect((msg as any).issue.number).toBe(42);
    expect((msg as any).issue.title).toBe("Issue 42");
    expect((msg as any).issue.repoUrl).toBe("https://github.com/owner/repo");
    expect((await taskModel.get("42"))?.status).toBe("assigned");
    expect(registry.get("w1")?.status).toBe("busy");
  });

  it("issues/labeled with non-task label does not enqueue or assign", async () => {
    const ws = await connect();
    const ackP = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await ackP; // consume hello_ack (worker is now registered)

    // No message should arrive after an unrelated label event
    routeEvent("evt-1", "issues", labeledPayload(42, "some-other-label"));
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);

    expect(raceResult).toBe("timeout");
    expect(await taskModel.getTaskForIssue(42)).toBeNull();
  });

  it("issues/labeled with task label enqueues task when no idle worker available", async () => {
    // No worker connected at all
    routeEvent("evt-1", "issues", labeledPayload(42, "brunel:ready"));

    // Allow async processing to complete
    await new Promise((r) => setTimeout(r, 50));

    const task = await taskModel.getTaskForIssue(42);
    expect(task).toBeDefined();
    expect(task?.status).toBe("pending");
    expect(task?.issueNumber).toBe(42);
    expect(task?.repoUrl).toBe("https://github.com/owner/repo");
  });

  it("pending task from webhook gets assigned when worker later connects", async () => {
    // Webhook fires before any worker is available
    routeEvent("evt-1", "issues", labeledPayload(42, "brunel:ready"));

    // Allow async processing to complete
    await new Promise((r) => setTimeout(r, 50));
    expect((await taskModel.getTaskForIssue(42))?.status).toBe("pending");

    // Worker connects afterwards — use nextMsgWhere to skip hello_ack and get task_assigned
    const ws = await connect();
    const reply = nextMsgWhere(ws, (m) => m.type === "task_assigned");
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });

    const msg = await reply;
    expect(msg.type).toBe("task_assigned");
    expect((msg as any).issue.number).toBe(42);
    expect((await taskModel.get("42"))?.status).toBe("assigned");
  });

  it("issues/labeled does not enqueue duplicate if issue already in queue", async () => {
    // Pre-populate the queue with this issue (with deps loaded so it's assignable)
    await registerReady(taskModel, "42", 42, "owner/repo", "Existing Issue", "Body", ["brunel:ready"]);

    routeEvent("evt-1", "issues", labeledPayload(42, "brunel:ready"));

    // Allow async processing to complete
    await new Promise((r) => setTimeout(r, 50));

    // Only one task should exist, and it should still be pending
    expect((await taskModel.get("42"))?.status).toBe("pending");
  });

  it("issues/opened with task label in issue labels assigns task to idle worker", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await waitUntil(() => !!registry.get("w1"));

    // Webhook fires: issue #99 opened with task label.
    // then startDepsLoad completes async → reconcile() assigns the task.
    // Use nextMsgWhere in case startDepsLoad resolves asynchronously before task_assigned.
    const reply = nextMsgWhere(ws, (m) => m.type === "task_assigned");
    routeEvent("evt-1", "issues", openedPayload(99, ["brunel:ready", "bug"]));

    const msg = await reply;
    expect(msg.type).toBe("task_assigned");
    expect((msg as any).issue.number).toBe(99);
    expect((await taskModel.get("99"))?.status).toBe("assigned");
    expect(registry.get("w1")?.status).toBe("busy");
  });

  it("issues/opened without task label does not enqueue", async () => {
    const ws = await connect();
    const ackP = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await ackP; // consume hello_ack

    routeEvent("evt-1", "issues", openedPayload(99, ["bug", "enhancement"]));
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);

    expect(raceResult).toBe("timeout");
    expect(await taskModel.getTaskForIssue(99)).toBeNull();
  });

  it("busy worker is not interrupted when new task arrives via webhook", async () => {
    // Give worker an existing task
    await registerReady(taskModel, "1", 1, "owner/repo", "First Issue", "Body", ["brunel:ready"]);
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned"); // task_assigned for issue 1

    // New issue arrives via webhook
    routeEvent("evt-1", "issues", labeledPayload(2, "brunel:ready"));

    // Worker should NOT receive a new task_assigned while still busy
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");

    // But issue 2 should be pending, ready for when the worker finishes
    expect((await taskModel.getTaskForIssue(2))?.status).toBe("pending");
  });
});

describe("PR event forwarding to workers", () => {
  it("pull_request/opened with closing keyword registers PR and routes check_run to worker", async () => {
    // Set up a task for issue 42
    await registerReady(taskModel, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    // Worker connects and receives the task
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    // Worker opens a PR that closes issue #42
    await routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Fixes #42\n\nSome description."));

    // check_run for that PR should now be forwarded to the worker
    const reply = nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "check_run");
    routeEvent("evt-cr", "check_run", checkRunPayload(10, "failure"));

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("check_run");
  });

  it("pull_request_review for a registered PR is forwarded to the worker", async () => {
    await registerReady(taskModel, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    await routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Closes #42"));

    const reply = nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "pull_request_review");
    routeEvent("evt-rev", "pull_request_review", prReviewPayload(10));

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("pull_request_review");
  });

  it("pull_request_review_comment for a registered PR is forwarded to the worker", async () => {
    await registerReady(taskModel, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    await routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Resolves #42"));

    const reply = nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "pull_request_review_comment");
    routeEvent("evt-cmt", "pull_request_review_comment", prReviewCommentPayload(10));

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("pull_request_review_comment");
  });

  it("pull_request/opened without linked issue does not crash and is not forwarded", async () => {
    await registerReady(taskModel, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

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
    const ackP = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await ackP; // consume hello_ack

    routeEvent("evt-cr", "check_run", checkRunPayload(999, "failure"));
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it("check_suite/completed for a registered PR is forwarded to the worker", async () => {
    await registerReady(taskModel, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    await routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Closes #42"));

    const reply = nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "check_suite");
    routeEvent("evt-cs", "check_suite", checkSuitePayload(10, "failure"));

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("check_suite");
  });

  it("check_suite for unknown PR is silently dropped", async () => {
    const ws = await connect();
    const ackP = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await ackP; // consume hello_ack

    routeEvent("evt-cs", "check_suite", checkSuitePayload(999, "failure"));
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it("check_suite with empty pull_requests is routed by head_branch", async () => {
    await registerReady(taskModel, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    await routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Closes #42", "fix-issue-42"));

    const reply = nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "check_suite");
    routeEvent("evt-cs", "check_suite", checkSuitePayloadByBranch("fix-issue-42", "failure"));

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("check_suite");
  });

  it("check_run with empty pull_requests is routed by head_branch", async () => {
    await registerReady(taskModel, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    await routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Closes #42", "fix-issue-42"));

    const reply = nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "check_run");
    routeEvent("evt-cr", "check_run", checkRunPayloadByBranch("fix-issue-42", "failure"));

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("check_run");
  });

  it("check_suite with empty pull_requests and unknown branch is silently dropped", async () => {
    const ws = await connect();
    const ackP = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await ackP; // consume hello_ack

    routeEvent("evt-cs", "check_suite", checkSuitePayloadByBranch("unknown-branch", "failure"));
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it("pull_request/closed without merging clears PR from task in TaskQueue", async () => {
    await registerReady(taskModel, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    routeEvent("evt-pr-open", "pull_request", prOpenedPayload(10, "Closes #42"));
    // Wait for async PR registration
    await new Promise((r) => setTimeout(r, 50));
    expect((await taskModel.getTaskForPr(10))?.taskId).toBe("42");
    expect((await taskModel.get("42"))?.prNumber).toBe(10);

    routeEvent("evt-pr-close", "pull_request", prClosedPayload(10, false));
    // Wait for async PR unregistration
    await new Promise((r) => setTimeout(r, 50));
    expect(await taskModel.getTaskForPr(10)).toBeNull();
    expect((await taskModel.get("42"))?.prNumber).toBeUndefined();
  });

  it("pull_request/closed without merging still forwards the event to the worker", async () => {
    await registerReady(taskModel, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    routeEvent("evt-pr-open", "pull_request", prOpenedPayload(10, "Closes #42"));
    await nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "pull_request");

    const reply = nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "pull_request");
    routeEvent("evt-pr-close", "pull_request", prClosedPayload(10, false));
    const msg = await reply;
    expect((msg as any).event.payload.action).toBe("closed");
  });

  it("pull_request/closed with merge does NOT clear PR from task in TaskQueue", async () => {
    await registerReady(taskModel, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    routeEvent("evt-pr-open", "pull_request", prOpenedPayload(10, "Closes #42"));
    // Wait for async PR registration
    await new Promise((r) => setTimeout(r, 50));
    expect((await taskModel.get("42"))?.prNumber).toBe(10);

    routeEvent("evt-pr-close", "pull_request", prClosedPayload(10, true));
    // Wait for async processing
    await new Promise((r) => setTimeout(r, 50));
    // Merged PR: keep the association (issue will close → task completes)
    expect((await taskModel.get("42"))?.prNumber).toBe(10);
    expect((await taskModel.getTaskForPr(10))?.taskId).toBe("42");
  });
});

  it("issue_comment/created on a PR is forwarded to the worker handling that issue", async () => {
    await registerReady(taskModel, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    // Worker opens PR #10 that closes issue #42
    await routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Closes #42"));

    // User posts a top-level comment on PR #10 — issue.number = 10 (the PR number)
    const reply = nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "issue_comment");
    routeEvent("evt-cmt", "issue_comment", issueCommentPayload(10, "Please address the nit above."));

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("issue_comment");
  });

describe("foreman event filtering", () => {
  it("pull_request/synchronize is dropped and not forwarded to worker", async () => {
    await registerReady(taskModel, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    // Register PR for the task (now also forwarded as event_notification — consume it)
    routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Closes #42"));
    await nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "pull_request");

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
    // Allow async processing to complete
    await new Promise((r) => setTimeout(r, 50));
    expect((await taskModel.getTaskForIssue(42))?.status).toBe("pending");

    // Remove the label — pending task should be dequeued
    routeEvent("evt-unlabeled", "issues", {
      action: "unlabeled",
      label: { name: "brunel:ready" },
      issue: { number: 42, title: "Issue 42", body: "Body", labels: [] },
      repository: { html_url: "https://github.com/owner/repo" },
    });
    // Allow async processing to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(await taskModel.getTaskForIssue(42)).toBeNull();
  });

  it('issues/unlabeled with task label does not remove an already-assigned task', async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await waitUntil(() => !!registry.get("w1"));

    const reply = nextMsgWhere(ws, (m) => m.type === "task_assigned");
    routeEvent("evt-labeled", "issues", labeledPayload(42, "brunel:ready"));
    await reply; // task_assigned

    expect((await taskModel.getTaskForIssue(42))?.status).toBe("assigned");

    // Removing the label should leave the assigned task intact
    routeEvent("evt-unlabeled", "issues", {
      action: "unlabeled",
      label: { name: "brunel:ready" },
      issue: { number: 42, title: "Issue 42", body: "Body", labels: [] },
      repository: { html_url: "https://github.com/owner/repo" },
    });
    // Allow async processing
    await new Promise((r) => setTimeout(r, 50));

    expect((await taskModel.getTaskForIssue(42))?.status).toBe("assigned");
  });

  it('issues/unlabeled with non-task label does not remove a pending task', async () => {
    routeEvent("evt-labeled", "issues", labeledPayload(42, "brunel:ready"));
    // Allow async processing to complete
    await new Promise((r) => setTimeout(r, 50));
    expect((await taskModel.getTaskForIssue(42))?.status).toBe("pending");

    routeEvent("evt-unlabeled", "issues", {
      action: "unlabeled",
      label: { name: "some-other-label" },
      issue: { number: 42, title: "Issue 42", body: "Body", labels: [{ name: "brunel:ready" }] },
      repository: { html_url: "https://github.com/owner/repo" },
    });
    // Allow async processing
    await new Promise((r) => setTimeout(r, 50));

    expect(await taskModel.getTaskForIssue(42)).toBeDefined();
  });

  it("issues/labeled with task label does not enqueue if issue is closed", async () => {
    // Bug #489: delayed/retried webhooks for closed issues should not create tasks.
    // A closed issue re-labeled brunel:ready would otherwise upsert the DB row,
    // resetting status to pending and potentially overwriting title with a blank.
    routeEvent("evt-1", "issues", {
      action: "labeled",
      label: { name: "brunel:ready" },
      issue: {
        number: 42,
        title: "Issue 42",
        body: "Body",
        state: "closed",
        labels: [{ name: "brunel:ready" }],
      },
      repository: { html_url: "https://github.com/owner/repo" },
    });
    // Allow async processing
    await new Promise((r) => setTimeout(r, 50));

    expect(await taskModel.getTaskForIssue(42)).toBeNull();
  });
});
