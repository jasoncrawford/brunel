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
import { Worker } from "../src/foreman/models/worker.js";
import { ForemanWss } from "../src/foreman/controllers/wss.js";
import { TaskManager } from "../src/foreman/models/task-manager.js";
import { Task } from "../src/foreman/models/task.js";
import { resetDb, createTestTaskManager } from "./helpers/task.js";
import { loadDefaultConfig } from "../src/config.js";
const defaultCfg = await loadDefaultConfig();
import * as Wire from "../shared/wire.js";
import { waitUntil } from "./helpers.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Register a task and mark its deps as loaded so tryAssignWork will pick it up. */
async function registerReady(
  tm: TaskManager,
  taskId: string,
  issueNumber: number,
  repoSlug: string,
  title: string,
  body: string,
  labels: string[],
): Promise<void> {
  await Task.upsert(taskId, issueNumber, repoSlug, title, body, labels);
  tm.trackIssue(issueNumber);
  tm.markBlockersLoaded(issueNumber);
}

function connectWorker(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/worker`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMsg(ws: WebSocket): Promise<Wire.ForemanMessage> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

/** Collects messages until predicate returns true; resolves with the matching message. */
function nextMsgWhere(ws: WebSocket, predicate: (msg: Wire.ForemanMessage) => boolean): Promise<Wire.ForemanMessage> {
  return new Promise((resolve) => {
    const handler = (data: Buffer | string) => {
      const msg: Wire.ForemanMessage = JSON.parse(data.toString());
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
    repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
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
    repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
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
    repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
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
    repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
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
    repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
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
    repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
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
    repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
  };
}

function prEditedPayload(prNumber: number, newBody: string, headBranch = `branch-for-pr-${prNumber}`) {
  return {
    action: "edited",
    pull_request: {
      number: prNumber,
      title: `PR ${prNumber}`,
      body: newBody,
      head: { ref: headBranch },
    },
    changes: { body: { from: "old body without closing keyword" } },
    repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
  };
}

function prReviewPayload(prNumber: number) {
  return {
    action: "submitted",
    pull_request: { number: prNumber, title: "PR title" },
    review: { state: "changes_requested", body: "Please fix this." },
    repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
  };
}

function prReviewCommentPayload(prNumber: number) {
  return {
    action: "created",
    pull_request: { number: prNumber, title: "PR title" },
    comment: { body: "Nit: rename this", path: "src/foo.ts" },
    repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
  };
}

function issueCommentPayload(prOrIssueNumber: number, body = "LGTM") {
  return {
    action: "created",
    issue: { number: prOrIssueNumber, title: `Issue/PR ${prOrIssueNumber}`, pull_request: {} },
    comment: { body, user: { login: "reviewer" } },
    repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
  };
}

function checkSuitePayload(prNumber: number, conclusion: string) {
  return {
    action: "completed",
    check_suite: {
      conclusion,
      pull_requests: [{ number: prNumber }],
    },
    repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
  };
}

// ── Test harness ──────────────────────────────────────────────────────────────

let taskManager: TaskManager;
let httpServer: http.Server;
let foremanWss: ForemanWss;
let wss: WebSocketServer;

let port: number;
const openClients: WebSocket[] = [];

function connect(): Promise<WebSocket> {
  return connectWorker(port).then((ws) => { openClients.push(ws); return ws; });
}

beforeEach(async () => {
  Worker._reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { repository: { issue: { blockedBy: { nodes: [] } } } } }) }));
  process.env.GITHUB_REPO = "owner/repo";
  process.env.GITHUB_TOKEN = "token";
  process.env.TASK_LABEL = "brunel:ready";

  resetDb();
  taskManager = await createTestTaskManager("owner/repo");
  await taskManager.repo.activate();
  httpServer = http.createServer();
  foremanWss = new ForemanWss({ server: httpServer, config: defaultCfg });
  ({ wss } = foremanWss);

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
    const done = () => {
      httpServer.close(() => {
        vi.restoreAllMocks();
        resolve();
      });
    };
    if (alive.length === 0) {
      wss.close(done);
      return;
    }
    let pending = alive.length;
    for (const c of alive) {
      c.once("close", () => {
        if (--pending === 0) wss.close(done);
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
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await waitUntil(() => !!Worker.fromRegistry("w1"));

    // Webhook fires: issue #42 gets labeled brunel:ready.
    // then startDepsLoad completes async → reconcile() assigns the task.
    // Use nextMsgWhere in case startDepsLoad resolves asynchronously before task_assigned.
    const reply = nextMsgWhere(ws, (m) => m.type === "task_assigned");
    foremanWss.routeEvent("evt-1", "issues", labeledPayload(42, "brunel:ready"));

    const msg = await reply;
    expect(msg.type).toBe("task_assigned");
    expect((msg as any).issue.number).toBe(42);
    expect((msg as any).issue.title).toBe("Issue 42");
    expect((msg as any).issue.repoUrl).toBe("https://github.com/owner/repo");
    expect((await Task.get("42"))?.status).toBe("assigned");
    expect(Worker.fromRegistry("w1")?.status).toBe("busy");
  });

  it("issues/labeled with non-task label does not enqueue or assign", async () => {
    const ws = await connect();
    const ackP = nextMsg(ws);
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await ackP; // consume hello_ack (worker is now registered)

    // No message should arrive after an unrelated label event
    foremanWss.routeEvent("evt-1", "issues", labeledPayload(42, "some-other-label"));
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);

    expect(raceResult).toBe("timeout");
    expect(await Task.getByRepoIssue(taskManager.repo.id,42)).toBeNull();
  });

  it("issues/labeled with task label enqueues task when no idle worker available", async () => {
    // No worker connected at all
    foremanWss.routeEvent("evt-1", "issues", labeledPayload(42, "brunel:ready"));

    // Allow async processing to complete
    await new Promise((r) => setTimeout(r, 50));

    const task = await Task.getByRepoIssue(taskManager.repo.id,42);
    expect(task).toBeDefined();
    expect(task?.status).toBe("pending");
    expect(task?.issueNumber).toBe(42);
    expect(task?.repoUrl).toBe("https://github.com/owner/repo");
  });

  it("pending task from webhook gets assigned when worker later connects", async () => {
    // Webhook fires before any worker is available
    foremanWss.routeEvent("evt-1", "issues", labeledPayload(42, "brunel:ready"));

    // Allow async processing to complete
    await new Promise((r) => setTimeout(r, 50));
    expect((await Task.getByRepoIssue(taskManager.repo.id,42))?.status).toBe("pending");

    // Worker connects afterwards — use nextMsgWhere to skip hello_ack and get task_assigned
    const ws = await connect();
    const reply = nextMsgWhere(ws, (m) => m.type === "task_assigned");
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });

    const msg = await reply;
    expect(msg.type).toBe("task_assigned");
    expect((msg as any).issue.number).toBe(42);
    expect((await Task.get("42"))?.status).toBe("assigned");
  });

  it("issues/labeled does not enqueue duplicate if issue already in queue", async () => {
    // Pre-populate the queue with this issue (with deps loaded so it's assignable)
    await registerReady(taskManager, "42", 42, "owner/repo", "Existing Issue", "Body", ["brunel:ready"]);

    foremanWss.routeEvent("evt-1", "issues", labeledPayload(42, "brunel:ready"));

    // Allow async processing to complete
    await new Promise((r) => setTimeout(r, 50));

    // Only one task should exist, and it should still be pending
    expect((await Task.get("42"))?.status).toBe("pending");
  });

  it("issues/opened with task label in issue labels assigns task to idle worker", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await waitUntil(() => !!Worker.fromRegistry("w1"));

    // Webhook fires: issue #99 opened with task label.
    // then startDepsLoad completes async → reconcile() assigns the task.
    // Use nextMsgWhere in case startDepsLoad resolves asynchronously before task_assigned.
    const reply = nextMsgWhere(ws, (m) => m.type === "task_assigned");
    foremanWss.routeEvent("evt-1", "issues", openedPayload(99, ["brunel:ready", "bug"]));

    const msg = await reply;
    expect(msg.type).toBe("task_assigned");
    expect((msg as any).issue.number).toBe(99);
    expect((await Task.get("99"))?.status).toBe("assigned");
    expect(Worker.fromRegistry("w1")?.status).toBe("busy");
  });

  it("issues/opened without task label does not enqueue", async () => {
    const ws = await connect();
    const ackP = nextMsg(ws);
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await ackP; // consume hello_ack

    foremanWss.routeEvent("evt-1", "issues", openedPayload(99, ["bug", "enhancement"]));
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);

    expect(raceResult).toBe("timeout");
    expect(await Task.getByRepoIssue(taskManager.repo.id,99)).toBeNull();
  });

  it("busy worker is not interrupted when new task arrives via webhook", async () => {
    // Give worker an existing task
    await registerReady(taskManager, "1", 1, "owner/repo", "First Issue", "Body", ["brunel:ready"]);
    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned"); // task_assigned for issue 1

    // New issue arrives via webhook
    foremanWss.routeEvent("evt-1", "issues", labeledPayload(2, "brunel:ready"));

    // Worker should NOT receive a new task_assigned while still busy
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");

    // But issue 2 should be pending, ready for when the worker finishes
    expect((await Task.getByRepoIssue(taskManager.repo.id,2))?.status).toBe("pending");
  });
});

describe("PR event forwarding to workers", () => {
  it("pull_request/opened with closing keyword registers PR and routes check_run to worker", async () => {
    // Set up a task for issue 42
    await registerReady(taskManager, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    // Worker connects and receives the task
    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    // Worker opens a PR that closes issue #42
    await foremanWss.routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Fixes #42\n\nSome description."));

    // check_run for that PR should now be forwarded to the worker
    const reply = nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "check_run");
    foremanWss.routeEvent("evt-cr", "check_run", checkRunPayload(10, "failure"));

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("check_run");
  });

  it("pull_request_review for a registered PR is forwarded to the worker", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    await foremanWss.routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Closes #42"));

    const reply = nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "pull_request_review");
    foremanWss.routeEvent("evt-rev", "pull_request_review", prReviewPayload(10));

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("pull_request_review");
  });

  it("pull_request_review_comment for a registered PR is forwarded to the worker", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    await foremanWss.routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Resolves #42"));

    const reply = nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "pull_request_review_comment");
    foremanWss.routeEvent("evt-cmt", "pull_request_review_comment", prReviewCommentPayload(10));

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("pull_request_review_comment");
  });

  it("pull_request/opened without linked issue does not crash and is not forwarded", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    // PR with no linked issue — should be silently ignored
    foremanWss.routeEvent("evt-pr", "pull_request", prOpenedPayload(99, "A new PR with no issue reference."));

    // check_run for that PR should not be forwarded
    foremanWss.routeEvent("evt-cr", "check_run", checkRunPayload(99, "failure"));
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it("pull_request/edited with closing keyword added registers PR and forwards event to worker", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    // PR opened without closing keyword — not linked
    await foremanWss.routeEvent("evt-pr-open", "pull_request", prOpenedPayload(10, "A PR with no issue reference."));
    expect((await Task.getByRepoIssue(taskManager.repo.id,42))?.prNumber).toBeNull();

    // Body edited to add closing keyword — should now link the PR
    const reply = nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "pull_request");
    await foremanWss.routeEvent("evt-pr-edit", "pull_request", prEditedPayload(10, "Closes #42\n\nSome description."));

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("pull_request");

    // PR should now be registered on the task
    const task = await Task.getByRepoIssue(taskManager.repo.id,42);
    expect(task?.prNumber).toBe(10);
  });

  it("pull_request/edited with closing keyword enables check_run routing to worker", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    // PR opened without closing keyword — not linked
    await foremanWss.routeEvent("evt-pr-open", "pull_request", prOpenedPayload(10, "No issue link."));
    // Body edited to add closing keyword — links the PR
    await foremanWss.routeEvent("evt-pr-edit", "pull_request", prEditedPayload(10, "Closes #42"));
    // Consume the edit event forwarded to the worker
    await nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "pull_request");

    // check_run for the now-linked PR should be forwarded to the worker
    const reply = nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "check_run");
    foremanWss.routeEvent("evt-cr", "check_run", checkRunPayload(10, "success"));
    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("check_run");
  });

  it("pull_request/edited without body change does not link PR (passthrough)", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    // PR opened with closing keyword — linked
    await foremanWss.routeEvent("evt-pr-open", "pull_request", prOpenedPayload(10, "Closes #42"));
    // Consume the opened event forwarded to worker
    await nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "pull_request");

    // Edited event with no body change (e.g. title changed) — still forwarded to worker
    const reply = nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "pull_request");
    foremanWss.routeEvent("evt-pr-edit", "pull_request", {
      action: "edited",
      pull_request: { number: 10, title: "PR 10 (updated title)", body: "Closes #42", head: { ref: "branch-for-pr-10" } },
      changes: { title: { from: "PR 10" } }, // no body change
      repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
    });
    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    // PR is still registered (unchanged)
    const task = await Task.getByRepoIssue(taskManager.repo.id,42);
    expect(task?.prNumber).toBe(10);
  });

  it("check_run for unknown PR is silently dropped", async () => {
    const ws = await connect();
    const ackP = nextMsg(ws);
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await ackP; // consume hello_ack

    foremanWss.routeEvent("evt-cr", "check_run", checkRunPayload(999, "failure"));
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it("check_suite/completed for a registered PR is forwarded to the worker", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    await foremanWss.routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Closes #42"));

    const reply = nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "check_suite");
    foremanWss.routeEvent("evt-cs", "check_suite", checkSuitePayload(10, "failure"));

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("check_suite");
  });

  it("check_suite for unknown PR is silently dropped", async () => {
    const ws = await connect();
    const ackP = nextMsg(ws);
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await ackP; // consume hello_ack

    foremanWss.routeEvent("evt-cs", "check_suite", checkSuitePayload(999, "failure"));
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it("check_suite with empty pull_requests is routed by head_branch", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);
    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    await foremanWss.routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Closes #42", "fix-issue-42"));

    const reply = nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "check_suite");
    foremanWss.routeEvent("evt-cs", "check_suite", checkSuitePayloadByBranch("fix-issue-42", "failure"));

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("check_suite");
  });

  it("check_run with empty pull_requests is routed by head_branch", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);
    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    await foremanWss.routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Closes #42", "fix-issue-42"));

    const reply = nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "check_run");
    foremanWss.routeEvent("evt-cr", "check_run", checkRunPayloadByBranch("fix-issue-42", "failure"));

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("check_run");
  });

  it("check_suite with empty pull_requests and unknown branch is silently dropped", async () => {
    const ws = await connect();
    const ackP = nextMsg(ws);
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await ackP; // consume hello_ack

    foremanWss.routeEvent("evt-cs", "check_suite", checkSuitePayloadByBranch("unknown-branch", "failure"));
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it("pull_request/closed without merging clears PR from task in TaskQueue", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    foremanWss.routeEvent("evt-pr-open", "pull_request", prOpenedPayload(10, "Closes #42"));
    // Wait for async PR registration
    await new Promise((r) => setTimeout(r, 50));
    expect((await Task.getByRepoPr(taskManager.repo.id,10))?.taskId).toBe("42");
    expect((await Task.get("42"))?.prNumber).toBe(10);

    foremanWss.routeEvent("evt-pr-close", "pull_request", prClosedPayload(10, false));
    // Wait for async PR unregistration
    await new Promise((r) => setTimeout(r, 50));
    expect(await Task.getByRepoPr(taskManager.repo.id,10)).toBeNull();
    expect((await Task.get("42"))?.prNumber).toBeNull();
  });

  it("pull_request/closed without merging still forwards the event to the worker", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    foremanWss.routeEvent("evt-pr-open", "pull_request", prOpenedPayload(10, "Closes #42"));
    await nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "pull_request");

    const reply = nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "pull_request");
    foremanWss.routeEvent("evt-pr-close", "pull_request", prClosedPayload(10, false));
    const msg = await reply;
    expect((msg as any).event.payload.action).toBe("closed");
  });

  it("pull_request/closed with merge does NOT clear PR from task in TaskQueue", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    foremanWss.routeEvent("evt-pr-open", "pull_request", prOpenedPayload(10, "Closes #42"));
    // Wait for async PR registration
    await new Promise((r) => setTimeout(r, 50));
    expect((await Task.get("42"))?.prNumber).toBe(10);

    foremanWss.routeEvent("evt-pr-close", "pull_request", prClosedPayload(10, true));
    // Wait for async processing
    await new Promise((r) => setTimeout(r, 50));
    // Merged PR: keep the association (issue will close → task completes)
    expect((await Task.get("42"))?.prNumber).toBe(10);
    expect((await Task.getByRepoPr(taskManager.repo.id,10))?.taskId).toBe("42");
  });
});

  it("issue_comment/created on a PR is forwarded to the worker handling that issue", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    // Worker opens PR #10 that closes issue #42
    await foremanWss.routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Closes #42"));

    // User posts a top-level comment on PR #10 — issue.number = 10 (the PR number)
    const reply = nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "issue_comment");
    foremanWss.routeEvent("evt-cmt", "issue_comment", issueCommentPayload(10, "Please address the nit above."));

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).event.name).toBe("issue_comment");
  });

describe("foreman event filtering", () => {
  it("pull_request/synchronize is dropped and not forwarded to worker", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    // Register PR for the task (now also forwarded as event_notification — consume it)
    foremanWss.routeEvent("evt-pr", "pull_request", prOpenedPayload(10, "Closes #42"));
    await nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "pull_request");

    // synchronize event should be silently dropped
    foremanWss.routeEvent("evt-sync", "pull_request", {
      action: "synchronize",
      pull_request: { number: 10, title: "PR 10", body: "Closes #42", head: { ref: "branch" } },
      repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
    });

    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it('issues/unlabeled with task label removes a pending task from the queue', async () => {
    // Enqueue task via webhook (no worker connected, so it stays pending)
    foremanWss.routeEvent("evt-labeled", "issues", labeledPayload(42, "brunel:ready"));
    // Allow async processing to complete
    await new Promise((r) => setTimeout(r, 50));
    expect((await Task.getByRepoIssue(taskManager.repo.id,42))?.status).toBe("pending");

    // Remove the label — pending task should be dequeued
    foremanWss.routeEvent("evt-unlabeled", "issues", {
      action: "unlabeled",
      label: { name: "brunel:ready" },
      issue: { number: 42, title: "Issue 42", body: "Body", labels: [] },
      repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
    });
    // Allow async processing to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(await Task.getByRepoIssue(taskManager.repo.id,42)).toBeNull();
  });

  it('issues/unlabeled with task label does not remove an already-assigned task', async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await waitUntil(() => !!Worker.fromRegistry("w1"));

    const reply = nextMsgWhere(ws, (m) => m.type === "task_assigned");
    foremanWss.routeEvent("evt-labeled", "issues", labeledPayload(42, "brunel:ready"));
    await reply; // task_assigned

    expect((await Task.getByRepoIssue(taskManager.repo.id,42))?.status).toBe("assigned");

    // Removing the label should leave the assigned task intact
    foremanWss.routeEvent("evt-unlabeled", "issues", {
      action: "unlabeled",
      label: { name: "brunel:ready" },
      issue: { number: 42, title: "Issue 42", body: "Body", labels: [] },
      repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
    });
    // Allow async processing
    await new Promise((r) => setTimeout(r, 50));

    expect((await Task.getByRepoIssue(taskManager.repo.id,42))?.status).toBe("assigned");
  });

  it('issues/unlabeled with non-task label does not remove a pending task', async () => {
    foremanWss.routeEvent("evt-labeled", "issues", labeledPayload(42, "brunel:ready"));
    // Allow async processing to complete
    await new Promise((r) => setTimeout(r, 50));
    expect((await Task.getByRepoIssue(taskManager.repo.id,42))?.status).toBe("pending");

    foremanWss.routeEvent("evt-unlabeled", "issues", {
      action: "unlabeled",
      label: { name: "some-other-label" },
      issue: { number: 42, title: "Issue 42", body: "Body", labels: [{ name: "brunel:ready" }] },
      repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
    });
    // Allow async processing
    await new Promise((r) => setTimeout(r, 50));

    expect(await Task.getByRepoIssue(taskManager.repo.id,42)).toBeDefined();
  });

  it("issues/labeled with task label does not enqueue if issue is closed", async () => {
    // Bug #489: delayed/retried webhooks for closed issues should not create tasks.
    // A closed issue re-labeled brunel:ready would otherwise upsert the DB row,
    // resetting status to pending and potentially overwriting title with a blank.
    foremanWss.routeEvent("evt-1", "issues", {
      action: "labeled",
      label: { name: "brunel:ready" },
      issue: {
        number: 42,
        title: "Issue 42",
        body: "Body",
        state: "closed",
        labels: [{ name: "brunel:ready" }],
      },
      repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
    });
    // Allow async processing
    await new Promise((r) => setTimeout(r, 50));

    expect(await Task.getByRepoIssue(taskManager.repo.id,42)).toBeNull();
  });

  it("issues/closed is forwarded to the assigned worker", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    const reply = nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "issues");
    foremanWss.routeEvent("evt-closed", "issues", {
      action: "closed",
      issue: { number: 42, title: "Issue 42", body: "Body", labels: [{ name: "brunel:ready" }] },
      repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
    });
    const msg = await reply;
    expect((msg as any).event.payload.action).toBe("closed");
  });

  it("issues/reopened is forwarded to the assigned worker", async () => {
    await registerReady(taskManager, "42", 42, "owner/repo", "Issue 42", "Body", ["brunel:ready"]);

    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    const reply = nextMsgWhere(ws, m => m.type === "event_notification" && (m as any).event.name === "issues");
    foremanWss.routeEvent("evt-reopened", "issues", {
      action: "reopened",
      issue: { number: 42, title: "Issue 42", body: "Body", labels: [{ name: "brunel:ready" }] },
      repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
    });
    const msg = await reply;
    expect((msg as any).event.payload.action).toBe("reopened");
  });
});
