/**
 * Tests that verify the foreman broadcasts BOTH webhook events AND foreman
 * messages to the admin dashboard via adminWss.broadcastLogEvent().
 *
 * Covers the bug in issue #249: only webhooks were broadcast; messages were
 * silently dropped from the real-time admin event log.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "net";
import { TaskQueue, WorkerRegistry, createForemanWss } from "../src/foreman.js";
import { loadDefaultConfig } from "../src/config.js";
const defaultCfg = await loadDefaultConfig();
import type { AdminWss, AdminSnapshot, LogEntry } from "../src/admin-ws.js";
import { waitUntil } from "./helpers.js";

// ── Mock AdminWss ─────────────────────────────────────────────────────────────

function makeMockAdminWss(): AdminWss & { logEntries: LogEntry[] } {
  const logEntries: LogEntry[] = [];
  return {
    logEntries,
    broadcastSnapshot() {},
    broadcastLogEvent(entry) { logEntries.push({ ...entry }); },
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

function nextMsg(ws: WebSocket): Promise<unknown> {
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
let adminWss: ReturnType<typeof makeMockAdminWss>;
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

  queue = new TaskQueue();
  registry = new WorkerRegistry();
  adminWss = makeMockAdminWss();
  httpServer = http.createServer();
  ({ wss, routeEvent } = createForemanWss(queue, registry, httpServer, {
    taskLabel: defaultCfg.taskLabel,
    reclaimTimeoutMs: defaultCfg.workerReclaimTimeoutMs,
    adminWss,
  }));

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

describe("foreman admin broadcast — webhook events", () => {
  it("broadcasts a webhook event as kind='webhook'", () => {
    routeEvent("evt-1", "issues", {
      action: "labeled",
      label: { name: defaultCfg.taskLabel },
      issue: { number: 42, title: "Fix the bug", body: "", labels: [] },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    expect(adminWss.logEntries).toHaveLength(1);
    expect(adminWss.logEntries[0].kind).toBe("webhook");
  });

  it("broadcasts webhook event with a non-zero unique id", () => {
    routeEvent("evt-1", "issues", { action: "labeled", label: { name: defaultCfg.taskLabel }, issue: { number: 1, title: "T", body: "", labels: [] }, repository: { html_url: "https://github.com/owner/repo" } });
    routeEvent("evt-2", "issues", { action: "labeled", label: { name: defaultCfg.taskLabel }, issue: { number: 2, title: "T", body: "", labels: [] }, repository: { html_url: "https://github.com/owner/repo" } });

    expect(adminWss.logEntries).toHaveLength(2);
    const [e1, e2] = adminWss.logEntries;
    expect(e1.id).toBeGreaterThan(0);
    expect(e2.id).toBeGreaterThan(0);
    expect(e1.id).not.toBe(e2.id);
  });

  it("broadcasts webhook event with summary and taskId", () => {
    queue.addTask({ taskId: "42", issueNumber: 42, title: "Fix", body: "", labels: [], repoUrl: "https://github.com/owner/repo" });

    routeEvent("evt-1", "issue_comment", {
      action: "created",
      issue: { number: 42 },
      comment: { body: "LGTM" },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    expect(adminWss.logEntries[0].taskId).toBe("42");
    expect(adminWss.logEntries[0].summary).toMatch(/issue_comment/);
  });

  it("broadcasts check_run event with name and conclusion", () => {
    routeEvent("evt-1", "check_run", {
      action: "completed",
      check_run: { name: "CI / build", conclusion: "success", pull_requests: [] },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    expect(adminWss.logEntries[0].summary).toContain("CI / build");
    expect(adminWss.logEntries[0].summary).toContain("success");
  });

  it("broadcasts issue_comment event with truncated comment text", () => {
    queue.addTask({ taskId: "42", issueNumber: 42, title: "Fix", body: "", labels: [], repoUrl: "https://github.com/owner/repo" });

    routeEvent("evt-1", "issue_comment", {
      action: "created",
      issue: { number: 42 },
      comment: { body: "Looks good to me!" },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    expect(adminWss.logEntries[0].summary).toContain("Looks good to me!");
  });

  it("broadcasts push event with branch", () => {
    routeEvent("evt-1", "push", {
      ref: "refs/heads/main",
      commits: [{}],
      repository: { html_url: "https://github.com/owner/repo" },
    });

    expect(adminWss.logEntries[0].summary).toContain("refs/heads/main");
  });

  it("broadcasts delete event with ref_type and ref", () => {
    routeEvent("evt-1", "delete", {
      ref_type: "branch",
      ref: "feature/old",
      repository: { html_url: "https://github.com/owner/repo" },
    });

    expect(adminWss.logEntries[0].summary).toContain("branch");
    expect(adminWss.logEntries[0].summary).toContain("feature/old");
  });

  it("broadcasts issues/labeled event with label name", () => {
    routeEvent("evt-1", "issues", {
      action: "labeled",
      label: { name: "wontfix" },
      issue: { number: 5, title: "Minor thing", body: "", labels: [] },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    expect(adminWss.logEntries[0].summary).toContain("wontfix");
  });
});

describe("foreman admin broadcast — sent messages", () => {
  it("broadcasts task_assigned sent to worker as kind='message'", async () => {
    queue.addTask({ taskId: "1", issueNumber: 1, title: "Fix", body: "", labels: [], repoUrl: "https://github.com/owner/repo" });

    const ws = await connect();
    const reply = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "worker-abc", status: "idle" });
    await reply; // task_assigned

    const msgEntries = adminWss.logEntries.filter((e) => e.kind === "message");
    const assigned = msgEntries.find((e) => e.summary.includes("task_assigned"));
    expect(assigned).toBeDefined();
    expect(assigned!.taskId).toBe("1");
  });
});

describe("foreman admin broadcast — received messages", () => {
  it("broadcasts received worker_hello as kind='message'", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "worker-abc", status: "idle" });
    await waitUntil(() => !!registry.get("worker-abc"));

    const received = adminWss.logEntries.filter(
      (e) => e.kind === "message" && e.summary.includes("received") && e.summary.includes("worker_hello"),
    );
    expect(received.length).toBeGreaterThan(0);
  });

  it("broadcasts worker_hello with 'idle' status in summary", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "worker-abc", status: "idle" });
    await waitUntil(() => !!registry.get("worker-abc"));

    const hello = adminWss.logEntries.find(
      (e) => e.kind === "message" && e.summary.includes("worker_hello"),
    );
    expect(hello?.summary).toContain("idle");
  });

  it("broadcasts received task_complete as kind='message'", async () => {
    queue.addTask({ taskId: "1", issueNumber: 1, title: "Fix", body: "", labels: [], repoUrl: "https://github.com/owner/repo" });

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "worker-abc", status: "idle" });
    await nextMsg(ws); // task_assigned

    adminWss.logEntries.length = 0; // reset
    send(ws, { type: "task_complete", workerId: "worker-abc", taskId: "1" });
    await waitUntil(() => registry.get("worker-abc")?.status === "idle");

    const received = adminWss.logEntries.filter(
      (e) => e.kind === "message" && e.summary.includes("task_complete"),
    );
    expect(received.length).toBeGreaterThan(0);
  });

  it("broadcasts disconnect event as kind='message' with workerId and close code in summary", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "worker-abc", status: "idle" });
    await waitUntil(() => !!registry.get("worker-abc"));

    adminWss.logEntries.length = 0;
    await closeClient(ws);
    await waitUntil(() => !registry.get("worker-abc"));

    const disconnected = adminWss.logEntries.find(
      (e) => e.kind === "message" && e.summary.includes("disconnected"),
    );
    expect(disconnected).toBeDefined();
    expect(disconnected!.workerId).toBe("worker-abc");
    expect(disconnected!.summary).toMatch(/code \d+/);
  });
});

describe("foreman admin broadcast — unique IDs across all event types", () => {
  it("assigns unique IDs to webhook and message broadcasts", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "worker-abc", status: "idle" });
    await waitUntil(() => !!registry.get("worker-abc"));

    routeEvent("evt-1", "issues", {
      action: "labeled",
      label: { name: defaultCfg.taskLabel },
      issue: { number: 99, title: "T", body: "", labels: [] },
      repository: { html_url: "https://github.com/owner/repo" },
    });

    const ids = adminWss.logEntries.map((e) => e.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
    expect(ids.every((id) => id > 0)).toBe(true);
  });
});

describe("foreman admin broadcast — snapshot on PR registration", () => {
  it("broadcasts updated snapshot with prNumber when a PR is opened for a task", () => {
    queue.addTask({ taskId: "42", issueNumber: 42, title: "Fix the bug", body: "", labels: [], repoUrl: "https://github.com/owner/repo" });

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

    expect(snapshots.length).toBeGreaterThan(0);
    const task = snapshots[snapshots.length - 1].tasks.find((t) => t.taskId === "42");
    expect(task?.prNumber).toBe(101);
  });
});
