/**
 * Tests for log-event broadcasting behavior in ForemanWss.
 *
 * Snapshot-broadcasting tests (reactive dispatch, debounce, prNumber propagation,
 * complete task exclusion) moved to admin-ws.test.ts — AdminWss now owns the full
 * snapshot lifecycle via event subscriptions.
 *
 * What remains here: edge cases in the log-event summaries that ForemanWss emits
 * via adminWss.broadcastLogEvent() for hello_ack messages.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "net";
import { Worker } from "../src/foreman/models/worker.js";
import { ForemanWss } from "../src/foreman/controllers/wss.js";
import { TaskManager } from "../src/foreman/models/task-manager.js";
import { Task } from "../src/foreman/models/task.js";
import { fakeRepo, resetDb, createTestTaskManager } from "./helpers/task.js";
import { loadDefaultConfig } from "../src/config.js";
const defaultCfg = await loadDefaultConfig();
import type { AdminWss } from "../src/foreman/controllers/admin-ws.js";
import type { LogEntry } from "../shared/wire.js";
import { waitUntil } from "./helpers.js";

// ── Mock AdminWss ─────────────────────────────────────────────────────────────

function makeMockAdminWss(): Pick<AdminWss, "broadcastLogEvent"> {
  return {
    broadcastLogEvent() {},
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function connectWorker(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/worker`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function send(ws: WebSocket, msg: object) {
  ws.send(JSON.stringify(msg));
}

// ── Test harness ──────────────────────────────────────────────────────────────

let taskManager: TaskManager;

let httpServer: http.Server;
let wss: WebSocketServer;
let adminWss: Pick<AdminWss, "broadcastLogEvent">;
let foremanWss: ForemanWss;
let port: number;
const openClients: WebSocket[] = [];

function connect(): Promise<WebSocket> {
  return connectWorker(port).then((ws) => { openClients.push(ws); return ws; });
}

beforeEach(async () => {
  Worker._reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  process.env.GITHUB_REPO = "owner/repo";
  process.env.GITHUB_TOKEN = "token";

  resetDb();
  taskManager = await createTestTaskManager("owner/repo");

  adminWss = makeMockAdminWss();
  httpServer = http.createServer();
  foremanWss = new ForemanWss({ server: httpServer, config: defaultCfg, adminWss });
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

describe("foreman admin broadcast — hello_ack log event summary", () => {
  it("hello_ack idle includes status in summary", async () => {
    const logEntries: LogEntry[] = [];
    adminWss.broadcastLogEvent = (entry) => logEntries.push(entry);

    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "worker-abc", status: "ready" });
    await waitUntil(() => logEntries.some((e) => e.summary.includes("hello_ack")));

    const entry = logEntries.find((e) => e.summary.includes("hello_ack"));
    expect(entry?.summary).toContain("ready");
  });

  it("hello_ack busy includes status and taskId in summary", async () => {
    await Task.upsert("42", 42, "owner/repo", "Fix the bug", "", []);
    taskManager.trackIssue(42);
    taskManager.markBlockersLoaded(42);
    const t = await Task.get("42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("worker-abc", fakeWs, fakeRepo()));

    const logEntries: LogEntry[] = [];
    adminWss.broadcastLogEvent = (entry) => logEntries.push(entry);

    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "worker-abc", status: "assigned", taskId: "42" });
    await waitUntil(() => logEntries.some((e) => e.summary.includes("hello_ack")));

    const entry = logEntries.find((e) => e.summary.includes("hello_ack"));
    expect(entry?.summary).toContain("assigned");
    expect(entry?.summary).toContain("42");
  });

  it("hello_ack with task transfer shows cancelled status in summary", async () => {
    await Task.upsert("42", 42, "owner/repo", "Fix the bug", "", []);
    taskManager.trackIssue(42);
    taskManager.markBlockersLoaded(42);
    const t = await Task.get("42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("worker-xyz", fakeWs, fakeRepo()));
    await t!.assign(Worker.register("worker-abc", fakeWs, fakeRepo()));

    const logEntries: LogEntry[] = [];
    adminWss.broadcastLogEvent = (entry) => logEntries.push(entry);

    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "worker-xyz", status: "assigned", taskId: "42" });
    await waitUntil(() => logEntries.some((e) => e.summary.includes("hello_ack")));

    const entry = logEntries.find((e) => e.summary.includes("hello_ack"));
    expect(entry?.summary).toContain("cancelled");
    expect(entry?.summary).toContain("42");
  });
});
