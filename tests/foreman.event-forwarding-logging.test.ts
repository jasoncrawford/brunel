/**
 * Tests that event_notification messages forwarded to active workers are logged
 * to the DB and broadcast to the admin dashboard.
 *
 * Covers issue #341: event_notification messages sent via forwardEvent were
 * missing from both DB foreman_messages and the admin real-time event log,
 * causing worker detail pages to show no webhook events at all.
 *
 * Also covers the reconnect path (worker_hello busy) where queued events are
 * drained to a reconnecting worker — the same logging was missing there too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "net";
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

// ── Reconnect path tests (real WebSocket needed) ──────────────────────────────
//
// When a worker reconnects as "busy", the foreman drains queued events and
// sends them via event_notification. These should also be logged.

describe("worker reconnect — DB logging of queued event_notification messages", () => {
  let wss: WebSocketServer;
  let reconnectQueue: TaskQueue;
  let reconnectRegistry: WorkerRegistry;
  let reconnectDbLogger: ReturnType<typeof makeMockDbLogger>;
  let reconnectAdminWss: ReturnType<typeof makeMockAdminWss>;
  let port: number;
  const openClients: WebSocket[] = [];

  beforeEach(() => {
    reconnectQueue = new TaskQueue();
    reconnectRegistry = new WorkerRegistry();
    reconnectDbLogger = makeMockDbLogger();
    reconnectAdminWss = makeMockAdminWss();
    const httpServer = http.createServer();
    ({ wss } = createForemanWss(reconnectQueue, reconnectRegistry, httpServer, {
      taskLabel: defaultCfg.taskLabel,
      reclaimTimeoutMs: defaultCfg.workerReclaimTimeoutMs,
      dbLogger: reconnectDbLogger,
      adminWss: reconnectAdminWss,
    }));
    return new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        port = (httpServer.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterEach(() => {
    return new Promise<void>((resolve) => {
      const clients = openClients.splice(0);
      const alive = clients.filter((c) => c.readyState !== WebSocket.CLOSED);
      if (alive.length === 0) { wss.close(resolve); return; }
      let pending = alive.length;
      for (const c of alive) {
        c.once("close", () => { if (--pending === 0) wss.close(resolve); });
        c.close();
      }
    });
  });

  function connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/worker`);
      ws.once("open", () => { openClients.push(ws); resolve(ws); });
      ws.once("error", reject);
    });
  }

  function nextMsg(ws: WebSocket): Promise<unknown> {
    return new Promise((resolve) => ws.once("message", (d) => resolve(JSON.parse(d.toString()))));
  }

  it("logs queued event_notification to DB when worker reconnects as busy", async () => {
    // Set up task with a queued event (no worker connected yet)
    reconnectQueue.addTask({
      taskId: "42", issueNumber: 42, title: "Fix", body: "", labels: [],
      repoUrl: "https://github.com/owner/repo",
    });
    reconnectQueue.assignTask("42", "worker-abc");
    reconnectQueue.queueEvent("42", { id: "evt-1", name: "issue_comment", payload: { action: "created" } });

    // Worker reconnects as busy claiming the task
    const ws = await connect();
    ws.send(JSON.stringify({ type: "worker_hello", workerId: "worker-abc", taskId: "42", status: "busy" }));
    // Drain the event_notification message the foreman sends
    await nextMsg(ws);

    const evtMsg = reconnectDbLogger.messageCalls.find((c) => c.msgType === "event_notification");
    expect(evtMsg).toBeDefined();
    expect(evtMsg?.workerId).toBe("worker-abc");
    expect(evtMsg?.taskId).toBe("42");
    expect(evtMsg?.direction).toBe("sent");
  });

  it("broadcasts queued event_notification to admin when worker reconnects as busy", async () => {
    reconnectQueue.addTask({
      taskId: "42", issueNumber: 42, title: "Fix", body: "", labels: [],
      repoUrl: "https://github.com/owner/repo",
    });
    reconnectQueue.assignTask("42", "worker-abc");
    reconnectQueue.queueEvent("42", { id: "evt-1", name: "issue_comment", payload: { action: "created" } });

    const ws = await connect();
    reconnectAdminWss.logEntries.length = 0;
    ws.send(JSON.stringify({ type: "worker_hello", workerId: "worker-abc", taskId: "42", status: "busy" }));
    await nextMsg(ws);

    const evtEntry = reconnectAdminWss.logEntries.find(
      (e) => e.kind === "message" && e.summary.includes("event_notification"),
    );
    expect(evtEntry).toBeDefined();
    expect(evtEntry?.taskId).toBe("42");
    expect(evtEntry?.workerId).toBe("worker-abc");
  });
});
