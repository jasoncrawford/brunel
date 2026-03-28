/**
 * Tests that verify the foreman logs concise one-liners for every message
 * sent to or received from a worker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "net";
import { TaskQueue, WorkerRegistry, createForemanWss } from "../src/foreman.js";
import { loadConfig } from "../src/config.js";
const defaultCfg = await loadConfig([], { githubRepo: "owner/repo", githubToken: "tok" });
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
  ({ wss, routeEventToWorker: routeEvent } = createForemanWss(queue, registry, httpServer, { taskLabel: defaultCfg.taskLabel, reclaimTimeoutMs: defaultCfg.workerReclaimTimeoutMs }));

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

// ── Scenarios ─────────────────────────────────────────────────────────────────

describe("foreman worker message logging", () => {
  it("logs worker_hello (idle) as a one-liner", async () => {
    const ws = await connect();
    const reply = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "worker-abc123", status: "idle" });
    await reply;

    // Log format: "<timestamp> [worker <first-8-chars>] ..."
    const workerLogs = logLines.filter(l => l.includes("[worker "));
    expect(workerLogs.length).toBeGreaterThan(0);
    // Each log line must be a single line (no embedded newlines)
    for (const line of workerLogs) {
      expect(line).not.toContain("\n");
    }
  });

  it("logs standby sent to worker as a one-liner", async () => {
    const ws = await connect();
    const reply = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "worker-abc123", status: "idle" });
    await reply; // standby

    const standbyLog = logLines.find(l => l.includes("standby"));
    expect(standbyLog).toBeDefined();
    expect(standbyLog).not.toContain("\n");
  });

  it("logs task_assigned sent to worker as a one-liner", async () => {
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
    await reply; // task_assigned

    const taskLog = logLines.find(l => l.includes("task_assigned"));
    expect(taskLog).toBeDefined();
    expect(taskLog).not.toContain("\n");
    // Should include issue number for context
    expect(taskLog).toMatch(/#1/);
  });

  it("logs task_complete received from worker as a one-liner", async () => {
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

    logLines.length = 0; // reset to focus on task_complete log
    send(ws, { type: "task_complete", workerId: "worker-abc123", taskId: "1" });
    await nextMsg(ws); // standby

    const completeLog = logLines.find(l => l.includes("task_complete"));
    expect(completeLog).toBeDefined();
    expect(completeLog).not.toContain("\n");
  });

  it("logs DROPPED when event arrives for assigned task with disconnected worker", () => {
    queue.addTask({
      taskId: "99",
      issueNumber: 99,
      title: "Disconnected task",
      body: "Body",
      labels: [],
      repoUrl: "https://github.com/owner/repo",
    });
    queue.assignTask("99", "disconnected-worker-id-12345");

    logLines.length = 0;
    routeEvent("evt-1", "issue_comment", { issue: { number: 99 }, comment: { body: "hi" } });

    const droppedLog = logLines.find(l => l.includes("DROPPED"));
    expect(droppedLog).toBeDefined();
    expect(droppedLog).toContain("issue_comment");
    expect(droppedLog).toContain("disconne"); // first 8 chars of "disconnected-worker-id-12345"
    expect(droppedLog).toContain("not in registry");
  });

  it("logs event_notification sent to worker as a one-liner", async () => {
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

    const eventLog = logLines.find(l => l.includes("event_notification"));
    expect(eventLog).toBeDefined();
    expect(eventLog).not.toContain("\n");
  });

  it("logs disconnect with close code as a one-liner", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "worker-abc123", status: "idle" });
    await nextMsg(ws); // standby

    logLines.length = 0;
    await new Promise<void>((resolve) => {
      ws.once("close", resolve);
      ws.close();
    });
    // Give the server-side close handler time to run
    await new Promise((r) => setTimeout(r, 20));

    const disconnectLog = logLines.find(l => l.includes("disconnected"));
    expect(disconnectLog).toBeDefined();
    expect(disconnectLog).toMatch(/code \d+/);
    expect(disconnectLog).not.toContain("\n");
  });
});
