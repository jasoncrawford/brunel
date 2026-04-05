/**
 * Tests for snapshot-broadcasting behavior: reactive dispatch, debounce, and
 * prNumber propagation when a PR is opened.
 *
 * The per-event-type log-entry format tests were removed in issue #383 — they
 * are covered by foreman.logging.test.ts (pure-function) and by the Playwright
 * admin-dashboard tests (end-to-end). What remains are edge cases that neither
 * of those suites exercises:
 *   - snapshot debounce: burst mutations collapse to one broadcast
 *   - reactive wiring: snapshot fires automatically on state change, not via
 *     manual callsites
 *   - prNumber propagation: opening a PR updates the task's prNumber in the
 *     snapshot
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "net";
import { WorkerRegistry } from "../src/foreman/worker-registry.js";
import { createForemanWss } from "../src/foreman/wss.js";
import { TaskModel } from "../src/foreman/task-model.js";
import { loadDefaultConfig } from "../src/config.js";
const defaultCfg = await loadDefaultConfig();
import type { AdminWss, AdminSnapshot, LogEntry } from "../src/foreman/admin-ws.js";
import { waitUntil } from "./helpers.js";

// ── Mock AdminWss ─────────────────────────────────────────────────────────────

function makeMockAdminWss(): AdminWss {
  return {
    broadcastSnapshot() {},
    broadcastLogEvent() {},
  };
}

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

function send(ws: WebSocket, msg: object) {
  ws.send(JSON.stringify(msg));
}

// ── Test harness ──────────────────────────────────────────────────────────────

let taskModel: TaskModel;
let registry: WorkerRegistry;
let httpServer: http.Server;
let wss: WebSocketServer;
let adminWss: AdminWss;
let routeEvent: (id: string, name: string, payload: unknown) => Promise<void>;
let port: number;
const openClients: WebSocket[] = [];

function connect(): Promise<WebSocket> {
  return connectWorker(port).then((ws) => { openClients.push(ws); return ws; });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  process.env.GITHUB_REPO = "owner/repo";
  process.env.GITHUB_TOKEN = "token";

  taskModel = new TaskModel();
  registry = new WorkerRegistry();
  adminWss = makeMockAdminWss();
  httpServer = http.createServer();
  ({ wss, routeEvent } = createForemanWss(taskModel, registry, httpServer, defaultCfg, { adminWss }));

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

describe("foreman admin broadcast — snapshot on PR registration", () => {
  it("broadcasts updated snapshot with prNumber when a PR is opened for a task", async () => {
    await registerReady(taskModel, "42", 42, "owner/repo", "Fix the bug", "", []);

    const snapshots: AdminSnapshot[] = [];
    adminWss.broadcastSnapshot = (snapshot) => snapshots.push(snapshot);

    routeEvent("evt-1", "pull_request", {
      action: "opened",
      pull_request: {
        number: 101,
        body: "Closes #42",
        head: { ref: "fix-the-bug" },
      },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    await waitUntil(() => snapshots.length > 0);
    const task = snapshots[snapshots.length - 1].tasks.find((t) => t.taskId === "42");
    expect(task?.prNumber).toBe(101);
  });
});

describe("foreman admin broadcast — reactive snapshot pipeline", () => {
  it("broadcasts snapshot when a worker connects (reactive, not manual callsite)", async () => {
    const snapshots: AdminSnapshot[] = [];
    adminWss.broadcastSnapshot = (snapshot) => snapshots.push(snapshot);

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "worker-abc", status: "idle" });
    await waitUntil(() => snapshots.some((s) => s.workers.some((w) => w.workerId === "worker-abc")));

    const last = snapshots[snapshots.length - 1];
    expect(last.workers.find((w) => w.workerId === "worker-abc")).toBeDefined();
  });

  it("collapses burst mutations into a single snapshot broadcast", async () => {
    const snapshots: AdminSnapshot[] = [];
    adminWss.broadcastSnapshot = (snapshot) => snapshots.push(snapshot);

    await taskModel.register("1", 1, "owner/repo", "T1", "", []);
    await taskModel.register("2", 2, "owner/repo", "T2", "", []);
    await taskModel.register("3", 3, "owner/repo", "T3", "", []);

    await waitUntil(() => snapshots.length > 0);
    // All three register calls are within the same tick, so debounce collapses them
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].tasks).toHaveLength(3);
  });
});

describe("foreman admin broadcast — hello_ack log event summary", () => {
  it("hello_ack idle includes status in summary", async () => {
    const logEntries: LogEntry[] = [];
    adminWss.broadcastLogEvent = (entry) => logEntries.push(entry);

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "worker-abc", status: "idle" });
    await waitUntil(() => logEntries.some((e) => e.summary.includes("hello_ack")));

    const entry = logEntries.find((e) => e.summary.includes("hello_ack"));
    expect(entry?.summary).toContain("idle");
  });

  it("hello_ack busy includes status and taskId in summary", async () => {
    await registerReady(taskModel, "42", 42, "owner/repo", "Fix the bug", "", []);
    await taskModel.assign("42", "worker-abc");

    const logEntries: LogEntry[] = [];
    adminWss.broadcastLogEvent = (entry) => logEntries.push(entry);

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "worker-abc", status: "busy", taskId: "42" });
    await waitUntil(() => logEntries.some((e) => e.summary.includes("hello_ack")));

    const entry = logEntries.find((e) => e.summary.includes("hello_ack"));
    expect(entry?.summary).toContain("busy");
    expect(entry?.summary).toContain("42");
  });

  it("hello_ack with task transfer shows cancelled status in summary", async () => {
    await registerReady(taskModel, "42", 42, "owner/repo", "Fix the bug", "", []);
    await taskModel.assign("42", "worker-xyz");
    await taskModel.assign("42", "worker-abc");

    const logEntries: LogEntry[] = [];
    adminWss.broadcastLogEvent = (entry) => logEntries.push(entry);

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "worker-xyz", status: "busy", taskId: "42" });
    await waitUntil(() => logEntries.some((e) => e.summary.includes("hello_ack")));

    const entry = logEntries.find((e) => e.summary.includes("hello_ack"));
    expect(entry?.summary).toContain("cancelled");
    expect(entry?.summary).toContain("42");
  });
});
