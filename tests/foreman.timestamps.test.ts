/**
 * Tests that every foreman log line starts with a fixed-width ISO 8601 timestamp.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "net";
import { Worker } from "../src/foreman/models/worker.js";
import { ForemanWss } from "../src/foreman/servers/wss.js";
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

function send(ws: WebSocket, msg: object) {
  ws.send(JSON.stringify(msg));
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

// ISO 8601 timestamp prefix: e.g. "2026-03-17T22:48:59.123Z "
const ISO_TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

// ── Test harness ──────────────────────────────────────────────────────────────

let taskManager: TaskManager;
let httpServer: http.Server;
let wss: WebSocketServer;
let foremanWss: ForemanWss;
let port: number;
let logLines: string[];
const openClients: WebSocket[] = [];

function connect(): Promise<WebSocket> {
  return connectWorker(port).then((ws) => { openClients.push(ws); return ws; });
}

beforeEach(async () => {
  Worker._reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  process.env.GITHUB_REPO = "owner/repo";
  process.env.GITHUB_TOKEN = "token";

  logLines = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logLines.push(args.join(" "));
  });

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("foreman log timestamps", () => {
  it("worker hello log lines start with ISO 8601 timestamp", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "worker-abc123", status: "ready" });
    await waitUntil(() => !!Worker.fromRegistry("worker-abc123"));

    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      expect(line).toMatch(ISO_TIMESTAMP_PREFIX);
    }
  });

  it("task_assigned log line starts with ISO 8601 timestamp", async () => {
    await registerReady(taskManager, "1", 1, "owner/repo", "Fix the thing", "Body", []);

    const ws = await connect();
    const reply = nextMsgWhere(ws, (m) => m.type === "task_assigned");
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "worker-abc123", status: "ready" });
    await reply;

    for (const line of logLines) {
      expect(line).toMatch(ISO_TIMESTAMP_PREFIX);
    }
  });

  it("event_notification log line starts with ISO 8601 timestamp", async () => {
    await registerReady(taskManager, "1", 1, "owner/repo", "Fix the thing", "Body", []);

    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "worker-abc123", status: "ready" });
    await nextMsgWhere(ws, (m) => m.type === "task_assigned");

    logLines.length = 0;
    const reply = nextMsg(ws);
    foremanWss.webhookController.handleEvent("evt-1", "issue_comment", { issue: { number: 1 }, comment: { body: "hi" }, repository: { full_name: "owner/repo" } });
    await reply;

    for (const line of logLines) {
      expect(line).toMatch(ISO_TIMESTAMP_PREFIX);
    }
  });

  it("task enqueue log line starts with ISO 8601 timestamp", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "worker-abc123", status: "ready" });
    await waitUntil(() => !!Worker.fromRegistry("worker-abc123"));

    logLines.length = 0;
    foremanWss.webhookController.handleEvent("evt-1", "issues", {
      action: "labeled",
      label: { name: "brunel:ready" },
      issue: { number: 5, title: "Do something", body: "", labels: [{ name: "brunel:ready" }] },
      repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
    });
    // give a tick for async processing
    await new Promise((r) => setTimeout(r, 10));

    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      expect(line).toMatch(ISO_TIMESTAMP_PREFIX);
    }
  });
});
