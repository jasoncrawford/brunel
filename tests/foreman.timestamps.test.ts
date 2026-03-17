/**
 * Tests that every foreman log line starts with a fixed-width ISO 8601 timestamp.
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

// ISO 8601 timestamp prefix: e.g. "2026-03-17T22:48:59.123Z "
const ISO_TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

// ── Test harness ──────────────────────────────────────────────────────────────

let queue: TaskQueue;
let registry: WorkerRegistry;
let httpServer: http.Server;
let wss: WebSocketServer;
let routeEvent: (id: string, name: string, payload: unknown) => void;
let port: number;
let logLines: string[];
const openClients: WebSocket[] = [];

function connect(): Promise<WebSocket> {
  return connectWorker(port).then((ws) => { openClients.push(ws); return ws; });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  process.env.GITHUB_REPO = "owner/repo";
  process.env.GITHUB_TOKEN = "token";
  process.env.DONE_LABEL = "brunel:done";

  logLines = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logLines.push(args.join(" "));
  });

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
  vi.restoreAllMocks();
  delete process.env.GITHUB_REPO;
  delete process.env.GITHUB_TOKEN;
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("foreman log timestamps", () => {
  it("worker hello/standby log lines start with ISO 8601 timestamp", async () => {
    const ws = await connect();
    const reply = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "worker-abc123", status: "idle" });
    await reply;

    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      expect(line).toMatch(ISO_TIMESTAMP_PREFIX);
    }
  });

  it("task_assigned log line starts with ISO 8601 timestamp", async () => {
    queue.addTask({
      taskId: "1",
      issueNumber: 1,
      title: "Fix the thing",
      body: "Body",
      labels: [],
      repoUrl: "https://github.com/owner/repo",
    });

    const ws = await connect();
    const reply = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "worker-abc123", status: "idle" });
    await reply;

    for (const line of logLines) {
      expect(line).toMatch(ISO_TIMESTAMP_PREFIX);
    }
  });

  it("event_notification log line starts with ISO 8601 timestamp", async () => {
    queue.addTask({
      taskId: "1",
      issueNumber: 1,
      title: "Fix the thing",
      body: "Body",
      labels: [],
      repoUrl: "https://github.com/owner/repo",
    });

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "worker-abc123", status: "idle" });
    await nextMsg(ws); // task_assigned

    logLines.length = 0;
    const reply = nextMsg(ws);
    routeEvent("evt-1", "issue_comment", { issue: { number: 1 }, comment: { body: "hi" } });
    await reply;

    for (const line of logLines) {
      expect(line).toMatch(ISO_TIMESTAMP_PREFIX);
    }
  });

  it("task enqueue log line starts with ISO 8601 timestamp", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "worker-abc123", status: "idle" });
    await nextMsg(ws); // standby

    logLines.length = 0;
    routeEvent("evt-1", "issues", {
      action: "labeled",
      label: { name: "brunel:ready" },
      issue: { number: 5, title: "Do something", body: "", labels: [{ name: "brunel:ready" }] },
      repository: { html_url: "https://github.com/owner/repo" },
    });
    // give a tick for async processing
    await new Promise((r) => setTimeout(r, 10));

    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      expect(line).toMatch(ISO_TIMESTAMP_PREFIX);
    }
  });
});
