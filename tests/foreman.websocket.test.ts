import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import http from "http";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "net";
import { TaskQueue, WorkerRegistry, createForemanWss } from "../src/foreman.js";
import { loadDefaultConfig } from "../src/config.js";
const defaultCfg = await loadDefaultConfig();
import type { ForemanMessage, LabeledIssueState } from "../src/types.js";
import { setBlockers } from "../src/dependencies.js";
import type { DependencyGraph } from "../src/dependencies.js";
import type { DbLogger } from "../src/db.js";
import { waitUntil } from "./helpers.js";

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

function makeTask(n: number) {
  return {
    taskId: String(n),
    issueNumber: n,
    title: `Issue ${n}`,
    body: `Body of issue ${n}`,
    labels: [],
    repoUrl: "https://github.com/owner/repo",
  };
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
let shutdown: () => Promise<void>;
let labelDone: ReturnType<typeof vi.fn>;
let port: number;
let graph: DependencyGraph;
let openIssues: Set<number>;
let labeledIssues: Map<number, LabeledIssueState>;
const openClients: WebSocket[] = [];

function connect(): Promise<WebSocket> {
  return connectWorker(port).then((ws) => { openClients.push(ws); return ws; });
}

beforeEach(() => {
  labelDone = vi.fn().mockResolvedValue(undefined);

  queue = new TaskQueue();
  registry = new WorkerRegistry();
  graph = new Map();
  openIssues = new Set();
  labeledIssues = new Map();
  httpServer = http.createServer();
  ({ wss, routeEvent, shutdown } = createForemanWss(queue, registry, httpServer, { taskLabel: defaultCfg.taskLabel, reclaimTimeoutMs: defaultCfg.workerReclaimTimeoutMs, labelDone, graph, openIssues, labeledIssues }));

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

describe("foreman WebSocket protocol", () => {
  it("idle worker with no tasks receives no message", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
    expect(registry.get("w1")?.status).toBe("idle");
  });

  it("idle worker with pending task receives task_assigned", async () => {
    queue.addTask(makeTask(1));
    const ws = await connect();
    const reply = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    const msg = await reply;
    assert(msg.type === "task_assigned");
    expect(msg.issue.number).toBe(1);
    expect(msg.taskId).toBe("1");
    expect(queue.get("1")?.status).toBe("assigned");
    expect(registry.get("w1")?.status).toBe("busy");
  });

  it("second idle worker gets no message when only task is already assigned", async () => {
    queue.addTask(makeTask(1));
    const ws1 = await connect();
    const ws2 = await connect();
    send(ws1, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws1); // task_assigned
    send(ws2, { type: "worker_hello", workerId: "w2", status: "idle" });
    const raceResult = await Promise.race([
      nextMsg(ws2).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it("task_complete triggers labelIssueDone and assigns next task", async () => {
    queue.addTask(makeTask(1));
    queue.addTask(makeTask(2));
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    const first = await nextMsg(ws);
    assert(first.type === "task_assigned");
    expect(first.issue.number).toBe(1);

    const second = nextMsg(ws);
    send(ws, { type: "task_complete", workerId: "w1", taskId: "1" });
    const msg = await second;
    assert(msg.type === "task_assigned");
    expect(msg.issue.number).toBe(2);

    expect(labelDone).toHaveBeenCalledWith(1);
    expect(queue.get("1")?.status).toBe("complete");
  });

  it("task_complete with no further tasks sends no message", async () => {
    queue.addTask(makeTask(1));
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned
    send(ws, { type: "task_complete", workerId: "w1", taskId: "1" });
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it("worker reconnects as busy and reclaims its own task (no task_assigned sent)", async () => {
    queue.addTask(makeTask(1));
    const ws1 = await connect();
    send(ws1, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws1); // task_assigned
    await closeClient(ws1);

    const ws2 = await connect();
    send(ws2, { type: "worker_hello", workerId: "w1", taskId: "1", status: "busy" });
    const raceResult = await Promise.race([
      nextMsg(ws2).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);

    expect(raceResult).toBe("timeout"); // no task_assigned (would reset in-progress session)
    expect(registry.get("w1")?.status).toBe("busy");
    expect(registry.get("w1")?.currentTaskId).toBe("1");
    expect(queue.get("1")?.status).toBe("assigned");
  });

  it("worker reconnects as busy with unknown taskId is registered busy and not interrupted", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", taskId: "nonexistent", status: "busy" });
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout"); // no message — worker continues its existing work
    expect(registry.get("w1")?.status).toBe("busy");
    expect(registry.get("w1")?.currentTaskId).toBe("nonexistent");
  });

  it("worker with pending tasks reconnects as busy with unknown taskId does not receive task_assigned", async () => {
    queue.addTask(makeTask(1));
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", taskId: "nonexistent", status: "busy" });
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout"); // must NOT receive task_assigned
    expect(registry.get("w1")?.status).toBe("busy");
    // pending task remains available for other workers
    expect(queue.get("1")?.status).toBe("pending");
  });

  it("routeEvent sends event_notification to assigned worker", async () => {
    queue.addTask(makeTask(1));
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned

    const reply = nextMsg(ws);
    routeEvent("evt-1", "issue_comment", { issue: { number: 1 }, comment: { body: "hi" } });
    const msg = await reply;
    assert(msg.type === "event_notification");
    expect(msg.taskId).toBe("1");
    expect(msg.event.name).toBe("issue_comment");
  });

  it("routeEvent queues event when no worker is assigned", () => {
    queue.addTask(makeTask(1));
    routeEvent("evt-1", "issue_comment", { issue: { number: 1 } });
    const events = queue.drainEvents("1");
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("issue_comment");
  });

  it("invalid JSON from worker does not crash the server", async () => {
    const ws = await connect();
    ws.send("not valid json {{{");
    await new Promise((r) => setTimeout(r, 20));
    // Connection still usable after bad message
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it("only the task's original owner can reclaim it on reconnect", async () => {
    queue.addTask(makeTask(1));
    // Worker A gets assigned
    const wsA = await connect();
    send(wsA, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await nextMsg(wsA); // task_assigned
    await closeClient(wsA);

    // Worker B tries to claim the same taskId — task belongs to A, so B gets no message
    const wsB = await connect();
    send(wsB, { type: "worker_hello", workerId: "worker-b", taskId: "1", status: "busy" });
    const raceResultB = await Promise.race([
      nextMsg(wsB).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResultB).toBe("timeout");

    // Worker A reconnects — should reclaim silently
    const wsA2 = await connect();
    send(wsA2, { type: "worker_hello", workerId: "worker-a", taskId: "1", status: "busy" });
    const raceResult2 = await Promise.race([
      nextMsg(wsA2).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult2).toBe("timeout");
    expect(registry.get("worker-a")?.status).toBe("busy");
  });

  it("labelIssueDone failure does not break task_complete flow", async () => {
    labelDone.mockRejectedValueOnce(new Error("Network error"));
    queue.addTask(makeTask(1));
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned
    send(ws, { type: "task_complete", workerId: "w1", taskId: "1" });
    await waitUntil(() => registry.get("w1")?.status === "idle");
    expect(queue.get("1")?.status).toBe("complete");
  });

  it("worker reconnects as busy with a completed taskId is registered idle", async () => {
    queue.addTask(makeTask(1));
    // Mark task as complete directly (simulates another path completing it while worker was disconnected)
    queue.assignTask("1", "w1");
    queue.completeTask("1");

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", taskId: "1", status: "busy" });
    await waitUntil(() => registry.get("w1")?.status === "idle");
    expect(registry.get("w1")?.status).toBe("idle");
  });

  it("events are routed to the correct worker when multiple workers have different tasks", async () => {
    // Two tasks pre-loaded
    queue.addTask(makeTask(53));
    queue.addTask(makeTask(55));

    // Worker A connects and gets task 53
    const wsA = await connect();
    send(wsA, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    const msgA = await nextMsg(wsA);
    assert(msgA.type === "task_assigned");
    expect(msgA.issue.number).toBe(53);

    // Worker B connects and gets task 55
    const wsB = await connect();
    send(wsB, { type: "worker_hello", workerId: "worker-b", status: "idle" });
    const msgB = await nextMsg(wsB);
    assert(msgB.type === "task_assigned");
    expect(msgB.issue.number).toBe(55);

    // Event for issue 55 should go ONLY to worker B
    const replyB = nextMsg(wsB);
    const noMsgA = Promise.race([
      nextMsg(wsA).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    routeEvent("evt-1", "issue_comment", { issue: { number: 55 }, comment: { body: "update" } });
    expect(await replyB).toMatchObject({ type: "event_notification", taskId: "55" });
    expect(await noMsgA).toBe("timeout");

    // Event for issue 53 should go ONLY to worker A
    const replyA = nextMsg(wsA);
    const noMsgB = Promise.race([
      nextMsg(wsB).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    routeEvent("evt-2", "issue_comment", { issue: { number: 53 }, comment: { body: "update" } });
    expect(await replyA).toMatchObject({ type: "event_notification", taskId: "53" });
    expect(await noMsgB).toBe("timeout");
  });
});

describe("dependency-aware task assignment", () => {
  it("idle worker gets no message when the only pending task is blocked", async () => {
    queue.addTask(makeTask(42));
    openIssues.add(10); // blocker is open
    setBlockers(42, [10], graph);

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it("idle worker gets task_assigned when task has no open blockers", async () => {
    queue.addTask(makeTask(42));
    setBlockers(42, [10], graph);
    // openIssues does NOT contain 10 — blocker is closed

    const ws = await connect();
    const reply = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    const msg = await reply;
    expect(msg.type).toBe("task_assigned");
  });

  it("issues/closed event unblocks a waiting task and sends task_assigned to idle worker", async () => {
    const task42 = makeTask(42);
    labeledIssues.set(42, { issue: { number: 42, title: task42.title, body: task42.body, labels: task42.labels, repoUrl: task42.repoUrl }, depsLoaded: true });
    queue.addTask(task42);
    openIssues.add(10);
    setBlockers(42, [10], graph);

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await waitUntil(() => !!registry.get("w1"));

    const reply = nextMsg(ws);
    routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 10, title: "Blocker", body: "", labels: [] },
    });
    expect(await reply).toMatchObject({ type: "task_assigned", taskId: "42" });
  });

  it("issues/reopened re-blocks subsequent task assignments", async () => {
    queue.addTask(makeTask(43));
    setBlockers(43, [10], graph);
    // openIssues does not have 10 — starts unblocked

    // Blocker 10 reopens — openIssues now contains 10
    routeEvent("evt-1", "issues", {
      action: "reopened",
      issue: { number: 10, title: "Blocker", body: "", labels: [] },
    });

    // Worker connects — task 43 is now blocked, so worker gets no message
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it("worker gets first unblocked task when queue has mixed blocked/unblocked tasks", async () => {
    queue.addTask(makeTask(1)); // blocked
    queue.addTask(makeTask(2)); // unblocked
    openIssues.add(99);
    setBlockers(1, [99], graph);
    // task 2 has no blockers

    const ws = await connect();
    const reply = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    const msg = await reply;
    expect(msg.type).toBe("task_assigned");
    if (msg.type === "task_assigned") expect(msg.issue.number).toBe(2);
  });
});

describe("worker secret enforcement", () => {
  async function makeSecretServer(secret: string): Promise<{ server: http.Server; secretWss: WebSocketServer; port: number }> {
    const server = http.createServer();
    const { wss: secretWss } = createForemanWss(
      new TaskQueue(), new WorkerRegistry(), server,
      { taskLabel: defaultCfg.taskLabel, reclaimTimeoutMs: defaultCfg.workerReclaimTimeoutMs, workerSecret: secret },
    );
    const p = await new Promise<number>((r) => server.listen(0, () => r((server.address() as AddressInfo).port)));
    return { server, secretWss, port: p };
  }

  it("rejects worker_hello with wrong secret when workerSecret is configured", async () => {
    const { server, secretWss, port } = await makeSecretServer("correct-secret");
    try {
      const ws = await connectWorker(port);
      send(ws, { type: "worker_hello", workerId: "w1", status: "idle", workerSecret: "wrong" });
      await new Promise<void>((resolve) => ws.once("close", resolve));
      expect(ws.readyState).toBe(WebSocket.CLOSED);
    } finally {
      await new Promise<void>((r) => secretWss.close(() => server.close(r)));
    }
  });

  it("accepts worker_hello with correct secret", async () => {
    const { server, secretWss, port } = await makeSecretServer("correct-secret");
    try {
      const ws = await connectWorker(port);
      send(ws, { type: "worker_hello", workerId: "w1", status: "idle", workerSecret: "correct-secret" });
      await new Promise((r) => setTimeout(r, 20)); // connection accepted, no message expected
      ws.close();
    } finally {
      await new Promise<void>((r) => secretWss.close(() => server.close(r)));
    }
  });

  it("accepts any worker when workerSecret is not configured", async () => {
    // Default setup (no workerSecret) — already tested elsewhere, just assert no regression
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await waitUntil(() => registry.get("w1")?.status === "idle");
    expect(registry.get("w1")?.status).toBe("idle");
  });
});

// ── Worker WebSocket connection integration tests ─────────────────────────────
// Moved from tests/repl.worker.test.ts — guard real network behavior.

function makeConnectToForeman(port: number) {
  const ws = new WebSocket(`ws://localhost:${port}/worker`);
  ws.on("open", () => {
    ws.send(JSON.stringify({
      type: "worker_hello",
      workerId: "test-worker-id",
      status: "idle",
    }));
  });
  return ws;
}

describe("worker WebSocket connection", () => {
  it("worker client connects to foreman successfully", async () => {
    const server = http.createServer();
    const { wss } = createForemanWss(new TaskQueue(), new WorkerRegistry(), server, { taskLabel: defaultCfg.taskLabel, reclaimTimeoutMs: defaultCfg.workerReclaimTimeoutMs });
    const testPort = await new Promise<number>((resolve) => {
      server.listen(0, () => resolve((server.address() as AddressInfo).port));
    });

    const ws = makeConnectToForeman(testPort);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });

    // No message expected when no tasks are available
    const raceResult = await Promise.race([
      new Promise<"message">((r) => ws.once("message", () => r("message"))),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");

    ws.close();
    await new Promise<void>((resolve) => wss.close(() => server.close(resolve)));
  });

  it("foreman rejects connections not at /worker path (regression guard)", async () => {
    const server = http.createServer();
    const { wss } = createForemanWss(new TaskQueue(), new WorkerRegistry(), server, { taskLabel: defaultCfg.taskLabel, reclaimTimeoutMs: defaultCfg.workerReclaimTimeoutMs });
    const testPort = await new Promise<number>((resolve) => {
      server.listen(0, () => resolve((server.address() as AddressInfo).port));
    });

    const ws = new WebSocket(`ws://localhost:${testPort}`);
    await expect(
      new Promise<void>((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      })
    ).rejects.toThrow();

    await new Promise<void>((resolve) => wss.close(() => server.close(resolve)));
  });
});

// ── Disconnect DB logging ──────────────────────────────────────────────────────

describe("worker disconnect DB logging", () => {
  it("calls dbLogger.logForemanMessage with worker_disconnected when a registered worker disconnects", async () => {
    const mockDbLogger: DbLogger = {
      logWebhookEvent: vi.fn(),
      logForemanMessage: vi.fn(),
      queryLog: vi.fn().mockResolvedValue([]),
      queryTaskEvents: vi.fn().mockResolvedValue([]),
      queryWorkerMessages: vi.fn().mockResolvedValue([]),
    };

    const localRegistry1 = new WorkerRegistry();
    const server = http.createServer();
    const { wss: testWss } = createForemanWss(
      new TaskQueue(), localRegistry1, server,
      { taskLabel: defaultCfg.taskLabel, reclaimTimeoutMs: defaultCfg.workerReclaimTimeoutMs, dbLogger: mockDbLogger },
    );
    const testPort = await new Promise<number>((r) => server.listen(0, () => r((server.address() as AddressInfo).port)));

    const ws = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "worker_hello", workerId: "w-disc-1", status: "idle" }));
    await waitUntil(() => !!localRegistry1.get("w-disc-1"));

    await new Promise<void>((resolve) => {
      ws.once("close", resolve);
      ws.close();
    });
    await waitUntil(() => !localRegistry1.get("w-disc-1") || localRegistry1.get("w-disc-1")?.status === "disconnected");

    const calls = (mockDbLogger.logForemanMessage as ReturnType<typeof vi.fn>).mock.calls;
    const disconnectCall = calls.find((c) => c[0].msgType === "worker_disconnected");
    expect(disconnectCall).toBeDefined();
    expect(disconnectCall![0]).toMatchObject({
      direction: "received",
      workerId: "w-disc-1",
      taskId: null,
      msgType: "worker_disconnected",
    });
    expect(typeof disconnectCall![0].payload.code).toBe("number");

    await new Promise<void>((r) => testWss.close(() => server.close(r)));
  });

  it("includes the current taskId in the disconnect event when worker had an active task", async () => {
    const mockDbLogger: DbLogger = {
      logWebhookEvent: vi.fn(),
      logForemanMessage: vi.fn(),
      queryLog: vi.fn().mockResolvedValue([]),
      queryTaskEvents: vi.fn().mockResolvedValue([]),
      queryWorkerMessages: vi.fn().mockResolvedValue([]),
    };

    const taskQueue = new TaskQueue();
    taskQueue.addTask({
      taskId: "42",
      issueNumber: 42,
      title: "Some task",
      body: "Body",
      labels: [],
      repoUrl: "https://github.com/owner/repo",
    });

    const localRegistry2 = new WorkerRegistry();
    const server = http.createServer();
    const { wss: testWss } = createForemanWss(
      taskQueue, localRegistry2, server,
      { taskLabel: defaultCfg.taskLabel, reclaimTimeoutMs: defaultCfg.workerReclaimTimeoutMs, dbLogger: mockDbLogger },
    );
    const testPort = await new Promise<number>((r) => server.listen(0, () => r((server.address() as AddressInfo).port)));

    const ws = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "worker_hello", workerId: "w-disc-2", status: "idle" }));
    // Wait for task_assigned reply
    await new Promise<void>((resolve) => ws.once("message", resolve));

    await new Promise<void>((resolve) => {
      ws.once("close", resolve);
      ws.close();
    });
    await waitUntil(() => localRegistry2.get("w-disc-2")?.status === "disconnected");

    const calls = (mockDbLogger.logForemanMessage as ReturnType<typeof vi.fn>).mock.calls;
    const disconnectCall = calls.find((c) => c[0].msgType === "worker_disconnected");
    expect(disconnectCall).toBeDefined();
    expect(disconnectCall![0].taskId).toBe("42");

    await new Promise<void>((r) => testWss.close(() => server.close(r)));
  });
});

// ── Disconnected worker state ──────────────────────────────────────────────────

describe("disconnected worker state", () => {
  it("worker with active task is marked disconnected (not removed) on close", async () => {
    queue.addTask(makeTask(1));
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned

    await closeClient(ws);
    await waitUntil(() => registry.get("w1")?.status === "disconnected");

    const entry = registry.get("w1");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("disconnected");
    expect(entry!.currentTaskId).toBe("1");
    expect(queue.get("1")?.status).toBe("assigned");
  });

  it("idle worker is removed from registry on close", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await waitUntil(() => !!registry.get("w1"));

    await closeClient(ws);
    await waitUntil(() => !registry.get("w1"));

    expect(registry.get("w1")).toBeUndefined();
  });

  it("events are queued (not dropped) when assigned worker is disconnected", async () => {
    queue.addTask(makeTask(1));
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned

    await closeClient(ws);
    await waitUntil(() => registry.get("w1")?.status === "disconnected");

    // Route an event while the worker is disconnected
    routeEvent("evt-1", "issue_comment", { issue: { number: 1 }, comment: { body: "hi" } });

    // Event should be in the task queue, not dropped
    const queued = queue.drainEvents("1");
    expect(queued).toHaveLength(1);
    expect(queued[0].name).toBe("issue_comment");
  });

  it("reconnecting worker (busy) from disconnected state drains queued events", async () => {
    queue.addTask(makeTask(1));
    const ws1 = await connect();
    send(ws1, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws1); // task_assigned

    await closeClient(ws1);
    await waitUntil(() => registry.get("w1")?.status === "disconnected");

    // Queue an event while disconnected
    routeEvent("evt-1", "issue_comment", { issue: { number: 1 }, comment: { body: "hi" } });

    // Worker reconnects as busy
    const ws2 = await connect();
    const reply = nextMsg(ws2);
    send(ws2, { type: "worker_hello", workerId: "w1", taskId: "1", status: "busy" });

    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    if (msg.type === "event_notification") {
      expect(msg.taskId).toBe("1");
      expect(msg.event.name).toBe("issue_comment");
    }

    expect(registry.get("w1")?.status).toBe("busy");
    expect(queue.get("1")?.status).toBe("assigned");
  });

  it("reconnecting worker (idle) from disconnected state reverts task to pending", async () => {
    queue.addTask(makeTask(1));
    const ws1 = await connect();
    send(ws1, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws1); // task_assigned

    await closeClient(ws1);
    await waitUntil(() => registry.get("w1")?.status === "disconnected");

    // Worker reconnects as idle (process restarted, no session context)
    const ws2 = await connect();
    const reply = nextMsg(ws2);
    send(ws2, { type: "worker_hello", workerId: "w1", status: "idle" });

    // Worker should get the task reassigned (task was reverted to pending)
    const msg = await reply;
    expect(msg.type).toBe("task_assigned");
    if (msg.type === "task_assigned") expect(msg.taskId).toBe("1");

    expect(registry.get("w1")?.status).toBe("busy");
    expect(queue.get("1")?.status).toBe("assigned");
    expect(queue.get("1")?.assignedWorkerId).toBe("w1");
  });

  it("a different idle worker can pick up the reverted task when disconnected worker reconnects as idle", async () => {
    queue.addTask(makeTask(1));

    // Worker A gets the task
    const wsA = await connect();
    send(wsA, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await nextMsg(wsA); // task_assigned

    await closeClient(wsA);
    await waitUntil(() => registry.get("worker-a")?.status === "disconnected");

    // Worker B is already connected and idle
    const wsB = await connect();
    send(wsB, { type: "worker_hello", workerId: "worker-b", status: "idle" });
    await waitUntil(() => registry.get("worker-b")?.status === "idle");

    // Worker A reconnects as idle (crashed and restarted)
    const wsA2 = await connect();
    // No need to wait — just sending the hello. Worker A might or might not get the task.
    // The important assertion: task reverts to pending, someone gets it.
    send(wsA2, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    const msg = await nextMsg(wsA2);
    expect(msg.type).toBe("task_assigned");
    expect(queue.get("1")?.status).toBe("assigned");
  });
});

// ── worker_goodbye ────────────────────────────────────────────────────────────

describe("worker_goodbye", () => {
  it("removes worker from registry and reverts task to pending", async () => {
    queue.addTask(makeTask(1));
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned

    send(ws, { type: "worker_goodbye", workerId: "w1", taskId: "1" });
    await waitUntil(() => !registry.get("w1"));

    expect(registry.get("w1")).toBeUndefined();
    expect(queue.get("1")?.status).toBe("pending");
  });

  it("removes idle worker from registry when goodbye has no taskId", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await waitUntil(() => !!registry.get("w1"));

    send(ws, { type: "worker_goodbye", workerId: "w1" });
    await waitUntil(() => !registry.get("w1"));

    expect(registry.get("w1")).toBeUndefined();
  });

  it("reverted task is immediately assigned to a waiting idle worker", async () => {
    queue.addTask(makeTask(1));

    // Worker A gets task 1
    const wsA = await connect();
    send(wsA, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await nextMsg(wsA); // task_assigned

    // Worker B connects idle
    const wsB = await connect();
    send(wsB, { type: "worker_hello", workerId: "worker-b", status: "idle" });
    await waitUntil(() => registry.get("worker-b")?.status === "idle");

    // Worker A says goodbye — task should revert and be assigned to B
    const replyB = nextMsg(wsB);
    send(wsA, { type: "worker_goodbye", workerId: "worker-a", taskId: "1" });
    const msg = await replyB;
    expect(msg.type).toBe("task_assigned");
    if (msg.type === "task_assigned") expect(msg.taskId).toBe("1");

    expect(registry.get("worker-a")).toBeUndefined();
    expect(queue.get("1")?.status).toBe("assigned");
    expect(queue.get("1")?.assignedWorkerId).toBe("worker-b");
  });
});

// ── Keepalive ping ─────────────────────────────────────────────────────────────

describe("keepalive ping", () => {
  it("sends WebSocket ping to connected clients on interval", async () => {
    const q = new TaskQueue();
    const r = new WorkerRegistry();
    const srv = http.createServer();
    const { wss: testWss } = createForemanWss(q, r, srv, {
      taskLabel: defaultCfg.taskLabel,
      reclaimTimeoutMs: defaultCfg.workerReclaimTimeoutMs,
      labelDone: vi.fn().mockResolvedValue(undefined),
      pingIntervalMs: 50,
    });
    await new Promise<void>((resolve) => srv.listen(0, resolve));
    const testPort = (srv.address() as AddressInfo).port;

    const ws = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });

    await new Promise<void>((resolve) => ws.once("ping", () => resolve()));

    ws.close();
    await new Promise<void>((resolve) => ws.once("close", resolve));
    await new Promise<void>((resolve) => testWss.close(() => srv.close(resolve)));
  });
});

// ── Reclaim timer ──────────────────────────────────────────────────────────────

describe("reclaim timer (fake timers)", () => {
  // Use fake timers within each test; reset after
  afterEach(() => { vi.useRealTimers(); });

  it("task reverts to pending and idle worker picks it up when reclaim timer fires", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reclaimTimeoutMs = 500;

    const q = new TaskQueue();
    const r = new WorkerRegistry();
    const srv = http.createServer();
    const { wss: testWss } = createForemanWss(q, r, srv, {
      taskLabel: defaultCfg.taskLabel,
      labelDone: vi.fn().mockResolvedValue(undefined),
      reclaimTimeoutMs,
    });
    await new Promise<void>((resolve) => srv.listen(0, resolve));
    const testPort = (srv.address() as AddressInfo).port;

    // Add a task and assign it via worker A
    q.addTask(makeTask(1));
    const wsA = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { wsA.once("open", resolve); wsA.once("error", reject); });
    send(wsA, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await new Promise<void>((resolve) => wsA.once("message", resolve)); // task_assigned

    // Worker A disconnects (crash)
    await new Promise<void>((resolve) => { wsA.once("close", resolve); wsA.close(); });
    await waitUntil(() => r.get("worker-a")?.status === "disconnected");

    // Task should still be assigned (timer hasn't fired)
    expect(q.get("1")?.status).toBe("assigned");
    expect(r.get("worker-a")?.status).toBe("disconnected");

    // Connect worker B (idle) — task is still assigned to A, so B gets no message yet
    const wsB = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { wsB.once("open", resolve); wsB.once("error", reject); });
    const msgB2Promise = nextMsg(wsB);
    send(wsB, { type: "worker_hello", workerId: "worker-b", status: "idle" });
    await waitUntil(() => r.get("worker-b")?.status === "idle");

    // Advance time past the reclaim timeout
    vi.advanceTimersByTime(reclaimTimeoutMs + 100);

    // Worker B should get a task_assigned after the reclaim
    const msgB2 = await msgB2Promise;
    expect(msgB2.type).toBe("task_assigned");
    if (msgB2.type === "task_assigned") expect(msgB2.taskId).toBe("1");

    // Worker A should be removed from registry
    expect(r.get("worker-a")).toBeUndefined();

    // Task is now assigned to worker B
    expect(q.get("1")?.status).toBe("assigned");
    expect(q.get("1")?.assignedWorkerId).toBe("worker-b");

    wsB.close();
    await new Promise<void>((r) => wsB.once("close", r));
    await new Promise<void>((r) => testWss.close(() => srv.close(r)));
  });

  it("reconnecting before timer fires cancels the timer and keeps the task", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reclaimTimeoutMs = 5000;

    const q = new TaskQueue();
    const r = new WorkerRegistry();
    const srv = http.createServer();
    const { wss: testWss } = createForemanWss(q, r, srv, {
      taskLabel: defaultCfg.taskLabel,
      labelDone: vi.fn().mockResolvedValue(undefined),
      reclaimTimeoutMs,
    });
    await new Promise<void>((resolve) => srv.listen(0, resolve));
    const testPort = (srv.address() as AddressInfo).port;

    q.addTask(makeTask(1));
    const wsA = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { wsA.once("open", resolve); wsA.once("error", reject); });
    send(wsA, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await new Promise<void>((resolve) => wsA.once("message", resolve)); // task_assigned

    // Disconnect
    await new Promise<void>((resolve) => { wsA.once("close", resolve); wsA.close(); });
    await waitUntil(() => r.get("worker-a")?.status === "disconnected");

    // Reconnect before timer fires
    const wsA2 = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { wsA2.once("open", resolve); wsA2.once("error", reject); });
    send(wsA2, { type: "worker_hello", workerId: "worker-a", taskId: "1", status: "busy" });
    await waitUntil(() => r.get("worker-a")?.status === "busy");

    // Advance time past original timeout — timer should have been cancelled
    vi.advanceTimersByTime(reclaimTimeoutMs + 100);
    await new Promise((r) => setTimeout(r, 20));

    // Task should still be assigned to worker-a
    expect(q.get("1")?.status).toBe("assigned");
    expect(r.get("worker-a")?.status).toBe("busy");

    wsA2.close();
    await new Promise<void>((r) => wsA2.once("close", r));
    await new Promise<void>((r) => testWss.close(() => srv.close(r)));
  });

  it("late reconnect after timer fires can reclaim pending task", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reclaimTimeoutMs = 500;

    const q = new TaskQueue();
    const r = new WorkerRegistry();
    const srv = http.createServer();
    const { wss: testWss } = createForemanWss(q, r, srv, {
      taskLabel: defaultCfg.taskLabel,
      labelDone: vi.fn().mockResolvedValue(undefined),
      reclaimTimeoutMs,
    });
    await new Promise<void>((resolve) => srv.listen(0, resolve));
    const testPort = (srv.address() as AddressInfo).port;

    q.addTask(makeTask(1));
    const wsA = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { wsA.once("open", resolve); wsA.once("error", reject); });
    send(wsA, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await new Promise<void>((resolve) => wsA.once("message", resolve)); // task_assigned

    // Disconnect
    await new Promise<void>((resolve) => { wsA.once("close", resolve); wsA.close(); });
    await waitUntil(() => r.get("worker-a")?.status === "disconnected");

    // Let the timer fire
    vi.advanceTimersByTime(reclaimTimeoutMs + 100);
    await waitUntil(() => q.get("1")?.status === "pending");

    // Task is now pending
    expect(q.get("1")?.status).toBe("pending");

    // Original worker reconnects as busy (late reconnect)
    const wsA2 = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { wsA2.once("open", resolve); wsA2.once("error", reject); });
    // No message expected for successful reclaim
    send(wsA2, { type: "worker_hello", workerId: "worker-a", taskId: "1", status: "busy" });
    const raceResult = await Promise.race([
      new Promise<ForemanMessage>((resolve) => wsA2.once("message", (d) => resolve(JSON.parse(d.toString())))).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 100)),
    ]);

    // No message sent — reclaimed silently
    expect(raceResult).toBe("timeout");
    expect(q.get("1")?.status).toBe("assigned");
    expect(r.get("worker-a")?.status).toBe("busy");

    wsA2.close();
    await new Promise<void>((r) => wsA2.once("close", r));
    await new Promise<void>((r) => testWss.close(() => srv.close(r)));
  });
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────

describe("graceful shutdown", () => {
  it("resolves immediately when no workers are connected", async () => {
    await expect(shutdown()).resolves.toBeUndefined();
  });

  it("closes all connected workers with close code 1001", async () => {
    const ws1 = await connect();
    const ws2 = await connect();
    send(ws1, { type: "worker_hello", workerId: "w1", status: "idle" });
    send(ws2, { type: "worker_hello", workerId: "w2", status: "idle" });
    await waitUntil(() => !!registry.get("w1") && !!registry.get("w2"));

    const close1 = new Promise<number>((resolve) => { ws1.once("close", (code) => resolve(code)); });
    const close2 = new Promise<number>((resolve) => { ws2.once("close", (code) => resolve(code)); });

    void shutdown();
    const [code1, code2] = await Promise.all([close1, close2]);
    expect(code1).toBe(1001);
    expect(code2).toBe(1001);
  });

  it("logs worker_disconnected with code 1001 when shutdown closes a registered worker", async () => {
    const mockDbLogger: DbLogger = {
      logWebhookEvent: vi.fn(),
      logForemanMessage: vi.fn(),
      queryLog: vi.fn().mockResolvedValue([]),
      queryTaskEvents: vi.fn().mockResolvedValue([]),
      queryWorkerMessages: vi.fn().mockResolvedValue([]),
    };
    const localRegistry = new WorkerRegistry();
    const srv = http.createServer();
    const { wss: testWss, shutdown: localShutdown } = createForemanWss(
      new TaskQueue(), localRegistry, srv,
      { taskLabel: defaultCfg.taskLabel, reclaimTimeoutMs: defaultCfg.workerReclaimTimeoutMs, dbLogger: mockDbLogger },
    );
    const testPort = await new Promise<number>((r) => srv.listen(0, () => r((srv.address() as AddressInfo).port)));

    const ws = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "worker_hello", workerId: "w-shutdown", status: "idle" }));
    await waitUntil(() => !!localRegistry.get("w-shutdown"));

    // Await shutdown() — it resolves only after server-side close events fire,
    // which means the close handler has already logged the disconnect to DB.
    await localShutdown();

    const calls = (mockDbLogger.logForemanMessage as ReturnType<typeof vi.fn>).mock.calls;
    const disconnectCall = calls.find((c) => c[0].msgType === "worker_disconnected");
    expect(disconnectCall).toBeDefined();
    expect(disconnectCall![0]).toMatchObject({
      direction: "received",
      workerId: "w-shutdown",
      msgType: "worker_disconnected",
    });
    expect(disconnectCall![0].payload.code).toBe(1001);

    await new Promise<void>((r) => testWss.close(() => srv.close(r)));
  });
});
