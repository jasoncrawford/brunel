/**
 * Tests that event_notification messages forwarded to active workers are logged
 * to the DB and broadcast to the admin dashboard.
 *
 * Covers issue #341: event_notification messages sent via forwardEvent were
 * missing from both DB foreman_messages and the admin real-time event log,
 * causing worker detail pages to show no webhook events at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import http from "http";
import type { WebSocket as WsSocket } from "ws";
import { TaskQueue, WorkerRegistry, createForemanWss } from "../src/foreman.js";
import { loadDefaultConfig } from "../src/config.js";
const defaultCfg = await loadDefaultConfig();
import type { DbLogger, ForemanMessageData } from "../src/db.js";
import type { AdminWss, LogEntry } from "../src/admin-ws.js";

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeMockWs(): WsSocket {
  return { readyState: 1, send: vi.fn() } as unknown as WsSocket;
}

function makeMockDbLogger(): DbLogger & { messageCalls: ForemanMessageData[] } {
  const messageCalls: ForemanMessageData[] = [];
  return {
    messageCalls,
    logWebhookEvent() {},
    logForemanMessage(data) { messageCalls.push(data); },
    async queryLog() { return []; },
    async queryTaskEvents() { return []; },
    async queryWorkerMessages() { return []; },
  };
}

function makeMockAdminWss(): AdminWss & { logEntries: LogEntry[] } {
  const logEntries: LogEntry[] = [];
  return {
    logEntries,
    broadcastSnapshot() {},
    broadcastLogEvent(entry) { logEntries.push({ ...entry }); },
  };
}

// ── Test harness ──────────────────────────────────────────────────────────────

let queue: TaskQueue;
let registry: WorkerRegistry;
let dbLogger: ReturnType<typeof makeMockDbLogger>;
let adminWss: ReturnType<typeof makeMockAdminWss>;
let routeEvent: (id: string, name: string, payload: unknown) => void;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: { repository: { issue: { blockedBy: { nodes: [] } } } } }),
  }));
  process.env.GITHUB_REPO = "owner/repo";
  process.env.GITHUB_TOKEN = "token";

  queue = new TaskQueue();
  registry = new WorkerRegistry();
  dbLogger = makeMockDbLogger();
  adminWss = makeMockAdminWss();

  const httpServer = http.createServer();
  ({ routeEvent } = createForemanWss(queue, registry, httpServer, {
    taskLabel: defaultCfg.taskLabel,
    reclaimTimeoutMs: defaultCfg.workerReclaimTimeoutMs,
    dbLogger,
    adminWss,
  }));

  return () => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_REPO;
    delete process.env.GITHUB_TOKEN;
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function setupAssignedWorker(taskId: string, workerId: string) {
  queue.addTask({
    taskId,
    issueNumber: parseInt(taskId),
    title: "Fix the bug",
    body: "Body",
    labels: [],
    repoUrl: "https://github.com/owner/repo",
  });
  queue.assignTask(taskId, workerId);
  const ws = makeMockWs();
  registry.register(workerId, ws, "busy", taskId);
  return ws;
}

// ── DB logging tests ──────────────────────────────────────────────────────────

describe("forwardEvent — DB logging of event_notification messages", () => {
  it("logs event_notification to DB when forwarding issue_comment to an active worker", () => {
    setupAssignedWorker("42", "worker-abc");

    routeEvent("evt-1", "issue_comment", {
      action: "created",
      issue: { number: 42, title: "Fix the bug" },
      comment: { body: "LGTM" },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    const evtMsg = dbLogger.messageCalls.find((c) => c.msgType === "event_notification");
    expect(evtMsg).toBeDefined();
  });

  it("logs event_notification with correct workerId and taskId", () => {
    setupAssignedWorker("42", "worker-abc");

    routeEvent("evt-1", "issue_comment", {
      action: "created",
      issue: { number: 42, title: "Fix the bug" },
      comment: { body: "LGTM" },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    const evtMsg = dbLogger.messageCalls.find((c) => c.msgType === "event_notification");
    expect(evtMsg?.workerId).toBe("worker-abc");
    expect(evtMsg?.taskId).toBe("42");
    expect(evtMsg?.direction).toBe("sent");
  });

  it("logs event_notification when forwarding a check_suite to an active worker", () => {
    setupAssignedWorker("42", "worker-abc");

    // Register a PR for the task so check_suite can be routed to the task
    routeEvent("evt-pr", "pull_request", {
      action: "opened",
      pull_request: { number: 10, title: "Fix", body: "Closes #42", head: { ref: "fix-42" } },
      repository: { html_url: "https://github.com/owner/repo" },
    });
    dbLogger.messageCalls.length = 0;

    routeEvent("evt-1", "check_suite", {
      action: "completed",
      check_suite: {
        conclusion: "success",
        head_branch: "fix-42",
        pull_requests: [{ number: 10 }],
      },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    const evtMsg = dbLogger.messageCalls.find((c) => c.msgType === "event_notification");
    expect(evtMsg).toBeDefined();
    expect(evtMsg?.workerId).toBe("worker-abc");
    expect(evtMsg?.taskId).toBe("42");
  });
});

// ── Admin broadcast tests ─────────────────────────────────────────────────────

describe("forwardEvent — admin broadcast of event_notification messages", () => {
  it("broadcasts event_notification as kind='message' when forwarding to an active worker", () => {
    setupAssignedWorker("42", "worker-abc");

    adminWss.logEntries.length = 0;

    routeEvent("evt-1", "issue_comment", {
      action: "created",
      issue: { number: 42, title: "Fix the bug" },
      comment: { body: "LGTM" },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    const evtEntry = adminWss.logEntries.find(
      (e) => e.kind === "message" && e.summary.includes("event_notification"),
    );
    expect(evtEntry).toBeDefined();
  });

  it("broadcasts event_notification with correct taskId and workerId", () => {
    setupAssignedWorker("42", "worker-abc");

    adminWss.logEntries.length = 0;

    routeEvent("evt-1", "issue_comment", {
      action: "created",
      issue: { number: 42, title: "Fix the bug" },
      comment: { body: "LGTM" },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    const evtEntry = adminWss.logEntries.find(
      (e) => e.kind === "message" && e.summary.includes("event_notification"),
    );
    expect(evtEntry?.taskId).toBe("42");
    expect(evtEntry?.workerId).toBe("worker-abc");
  });
});
