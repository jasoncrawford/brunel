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

function prOpenedPayload(prNumber: number, body: string) {
  return {
    action: "opened",
    pull_request: {
      number: prNumber,
      title: `PR ${prNumber}`,
      body,
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
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  process.env.GITHUB_REPO = "owner/repo";
  process.env.GITHUB_TOKEN = "token";
  process.env.TASK_LABEL = "brunel:ready";
  process.env.DONE_LABEL = "brunel:done";

  queue = new TaskQueue();
  registry = new WorkerRegistry();
  httpServer = http.createServer();
  ({ wss, routeEventToWorker: routeEvent } = createForemanWss(queue, registry, httpServer));

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

    // Webhook fires: issue #42 gets labeled brunel:ready
    const reply = nextMsg(ws);
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

    const reply = nextMsg(ws);
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
});
