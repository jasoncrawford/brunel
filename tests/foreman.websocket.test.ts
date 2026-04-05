import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import http from "http";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "net";
import { WorkerRegistry } from "../src/foreman/worker-registry.js";
import { createForemanWss } from "../src/foreman/wss.js";
import { TaskModel } from "../src/foreman/task-model.js";
import { loadDefaultConfig } from "../src/config.js";
const defaultCfg = await loadDefaultConfig();
import type { ForemanMessage } from "../src/types.js";
import { setBlockers } from "../src/foreman/dependencies.js";
import type { DependencyGraph } from "../src/foreman/dependencies.js";
import type { DbLogger, TaskStore } from "../src/foreman/db.js";
import { createMemoryTaskStore } from "../src/foreman/db.js";
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

/** FIFO queue that buffers all messages — safe against hello_ack + task_assigned in same TCP packet. */
function makeQueue(ws: WebSocket): { next: () => Promise<ForemanMessage> } {
  const pending: ForemanMessage[] = [];
  const waiters: Array<(m: ForemanMessage) => void> = [];
  ws.on("message", (data: Buffer | string) => {
    const msg = JSON.parse(data.toString()) as ForemanMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else pending.push(msg);
  });
  return {
    next(): Promise<ForemanMessage> {
      if (pending.length > 0) return Promise.resolve(pending.shift()!);
      return new Promise((r) => waiters.push(r));
    },
  };
}

function send(ws: WebSocket, msg: object) {
  ws.send(JSON.stringify(msg));
}

async function makeTask(tm: TaskModel, n: number) {
  const taskId = String(n);
  const title = `Issue ${n}`;
  const body = `Body of issue ${n}`;
  const labels: string[] = [];
  const repoSlug = "owner/repo";
  const repoUrl = `https://github.com/${repoSlug}`;
  await tm.register(taskId, n, repoSlug, title, body, labels);
  tm.trackIssue(n, { number: n, title, body, labels, repoUrl });
  tm.markIssueDepsLoaded(n);
}

function closeClient(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.once("close", resolve);
    ws.close();
  });
}

// ── Test harness ──────────────────────────────────────────────────────────────

let taskModel: TaskModel;
let registry: WorkerRegistry;
let httpServer: http.Server;
let wss: WebSocketServer;
let routeEvent: (id: string, name: string, payload: unknown) => Promise<void>;
let shutdown: () => Promise<void>;
let port: number;
let graph: DependencyGraph;
const openClients: WebSocket[] = [];

function connect(): Promise<WebSocket> {
  return connectWorker(port).then((ws) => { openClients.push(ws); return ws; });
}

beforeEach(() => {
  taskModel = new TaskModel();
  registry = new WorkerRegistry();
  graph = new Map();
  httpServer = http.createServer();
  ({ wss, routeEvent, shutdown } = createForemanWss(taskModel, registry, httpServer, defaultCfg, { graph }));

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
    const ackP = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await ackP; // consume hello_ack
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
    expect(registry.get("w1")?.status).toBe("idle");
  });

  it("idle worker with pending task receives task_assigned", async () => {
    await makeTask(taskModel, 1);
    const ws = await connect();
    const q = makeQueue(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await q.next(); // hello_ack
    const msg = await q.next();
    assert(msg.type === "task_assigned");
    expect(msg.issue.number).toBe(1);
    expect(msg.taskId).toBe("1");
    expect((await taskModel.get("1"))?.status).toBe("assigned");
    expect(registry.get("w1")?.status).toBe("busy");
  });

  it("second idle worker gets no message when only task is already assigned", async () => {
    await makeTask(taskModel, 1);
    const ws1 = await connect();
    const ws2 = await connect();
    const q1 = makeQueue(ws1);
    send(ws1, { type: "worker_hello", workerId: "w1", status: "idle" });
    await q1.next(); // hello_ack
    await q1.next(); // task_assigned
    const ackP2 = nextMsg(ws2);
    send(ws2, { type: "worker_hello", workerId: "w2", status: "idle" });
    await ackP2; // hello_ack
    const raceResult = await Promise.race([
      nextMsg(ws2).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it("task_complete completes task and assigns next task", async () => {
    // Create tasks in reverse order so task 1 is assigned first (tasks are ordered newest to oldest)
    await makeTask(taskModel, 2);
    await makeTask(taskModel, 1);
    const ws = await connect();
    const q = makeQueue(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await q.next(); // hello_ack
    const first = await q.next();
    assert(first.type === "task_assigned");
    expect(first.issue.number).toBe(1);

    const second = q.next();
    send(ws, { type: "task_complete", workerId: "w1", taskId: "1" });
    const msg = await second;
    assert(msg.type === "task_assigned");
    expect(msg.issue.number).toBe(2);

    expect((await taskModel.get("1"))?.status).toBe("complete");
  });

  it("task_complete with no further tasks sends no message", async () => {
    await makeTask(taskModel, 1);
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
    await makeTask(taskModel, 1);
    const ws1 = await connect();
    const q1 = makeQueue(ws1);
    send(ws1, { type: "worker_hello", workerId: "w1", status: "idle" });
    await q1.next(); // hello_ack
    await q1.next(); // task_assigned
    await closeClient(ws1);

    const ws2 = await connect();
    const ackP = nextMsg(ws2);
    send(ws2, { type: "worker_hello", workerId: "w1", taskId: "1", status: "busy" });
    await ackP; // hello_ack (status: busy)
    const raceResult = await Promise.race([
      nextMsg(ws2).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);

    expect(raceResult).toBe("timeout"); // no task_assigned (would reset in-progress session)
    expect(registry.get("w1")?.status).toBe("busy");
    expect(registry.get("w1")?.currentTaskId).toBe("1");
    expect((await taskModel.get("1"))?.status).toBe("assigned");
  });

  it("worker reconnects as busy with unknown taskId is registered busy and not interrupted", async () => {
    const ws = await connect();
    const ackP = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", taskId: "nonexistent", status: "busy" });
    await ackP; // hello_ack (status: busy)
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout"); // no message — worker continues its existing work
    expect(registry.get("w1")?.status).toBe("busy");
    expect(registry.get("w1")?.currentTaskId).toBe("nonexistent");
  });

  it("worker with pending tasks reconnects as busy with unknown taskId does not receive task_assigned", async () => {
    await makeTask(taskModel, 1);
    const ws = await connect();
    const ackP = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", taskId: "nonexistent", status: "busy" });
    await ackP; // hello_ack (status: busy)
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout"); // must NOT receive task_assigned
    expect(registry.get("w1")?.status).toBe("busy");
    // pending task remains available for other workers
    expect((await taskModel.get("1"))?.status).toBe("pending");
  });

  it("routeEvent sends event_notification to assigned worker", async () => {
    await makeTask(taskModel, 1);
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

  it("routeEvent queues event when no worker is assigned", async () => {
    await makeTask(taskModel, 1);
    await routeEvent("evt-1", "issue_comment", { issue: { number: 1 } });
    const events = taskModel.drainEvents("1");
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("issue_comment");
  });

  it("invalid JSON from worker does not crash the server", async () => {
    const ws = await connect();
    ws.send("not valid json {{{");
    await new Promise((r) => setTimeout(r, 20));
    // Connection still usable after bad message
    const ackP = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await ackP; // hello_ack
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it("only the task's original owner can reclaim it on reconnect", async () => {
    await makeTask(taskModel, 1);
    // Worker A gets assigned
    const wsA = await connect();
    const qA = makeQueue(wsA);
    send(wsA, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await qA.next(); // hello_ack
    await qA.next(); // task_assigned
    await closeClient(wsA);

    // Worker B tries to claim the same taskId — task belongs to A, so B gets no message
    const wsB = await connect();
    const ackPB = nextMsg(wsB);
    send(wsB, { type: "worker_hello", workerId: "worker-b", taskId: "1", status: "busy" });
    await ackPB; // hello_ack (status: cancelled — task belongs to A)
    const raceResultB = await Promise.race([
      nextMsg(wsB).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResultB).toBe("timeout");

    // Worker A reconnects — should reclaim silently
    const wsA2 = await connect();
    const ackPA2 = nextMsg(wsA2);
    send(wsA2, { type: "worker_hello", workerId: "worker-a", taskId: "1", status: "busy" });
    await ackPA2; // hello_ack (status: busy)
    const raceResult2 = await Promise.race([
      nextMsg(wsA2).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult2).toBe("timeout");
    expect(registry.get("worker-a")?.status).toBe("busy");
  });

  it("task_complete releases worker to idle", async () => {
    await makeTask(taskModel, 1);
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned
    send(ws, { type: "task_complete", workerId: "w1", taskId: "1" });
    await waitUntil(() => registry.get("w1")?.status === "idle");
    expect((await taskModel.get("1"))?.status).toBe("complete");
  });

  it("worker reconnects as busy with its own completed taskId is allowed to reclaim (finalization)", async () => {
    await makeTask(taskModel, 1);
    // Simulate: issue was closed, foreman marked task complete, worker briefly disconnects
    // Worker should be able to reclaim and do finalization work (doc updates, etc.)
    await taskModel.assign("1", "w1");
    await taskModel.complete("1");

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", taskId: "1", status: "busy" });
    await waitUntil(() => registry.get("w1") !== undefined);
    // Worker is reclaimed — it can do finalization work on a closed issue
    expect(registry.get("w1")?.status).toBe("busy");
    expect(registry.get("w1")?.currentTaskId).toBe("1");
  });

  it("events are routed to the correct worker when multiple workers have different tasks", async () => {
    // Two tasks pre-loaded
    await makeTask(taskModel, 53);
    await makeTask(taskModel, 55);

    // Worker A connects and gets task 53
    const wsA = await connect();
    const qA = makeQueue(wsA);
    send(wsA, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await qA.next(); // hello_ack
    const msgA = await qA.next();
    assert(msgA.type === "task_assigned");
    expect(msgA.issue.number).toBe(53);

    // Worker B connects and gets task 55
    const wsB = await connect();
    const qB = makeQueue(wsB);
    send(wsB, { type: "worker_hello", workerId: "worker-b", status: "idle" });
    await qB.next(); // hello_ack
    const msgB = await qB.next();
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

describe("hello_ack handshake", () => {
  it("sends hello_ack with status idle when worker has no task", async () => {
    const ws = await connect();
    const ackPromise = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    const ack = await ackPromise;
    expect(ack).toEqual({ type: "hello_ack", workerId: "w1", status: "idle" });
  });

  it("sends hello_ack with status busy when worker reclaims its own task", async () => {
    await makeTask(taskModel, 1);
    const ws1 = await connect();
    const q1 = makeQueue(ws1);
    send(ws1, { type: "worker_hello", workerId: "w1", status: "idle" });
    const first = await q1.next(); // hello_ack
    expect(first.type).toBe("hello_ack");
    await q1.next(); // task_assigned
    await closeClient(ws1);

    const ws2 = await connect();
    const ackPromise = nextMsg(ws2);
    send(ws2, { type: "worker_hello", workerId: "w1", taskId: "1", status: "busy" });
    const ack = await ackPromise;
    expect(ack).toEqual({ type: "hello_ack", workerId: "w1", status: "busy" });
  });

  it("sends hello_ack with status cancelled when task was taken by another worker", async () => {
    await makeTask(taskModel, 1);
    const wsA = await connect();
    const qA = makeQueue(wsA);
    send(wsA, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await qA.next(); // hello_ack
    await qA.next(); // task_assigned
    await closeClient(wsA);

    const wsB = await connect();
    const ackPromise = nextMsg(wsB);
    send(wsB, { type: "worker_hello", workerId: "worker-b", taskId: "1", status: "busy" });
    const ack = await ackPromise;
    expect(ack).toEqual({ type: "hello_ack", workerId: "worker-b", status: "cancelled" });
    expect(registry.get("worker-b")?.status).toBe("idle");
  });

  it("sends hello_ack with status busy for an unknown taskId", async () => {
    const ws = await connect();
    const ackPromise = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", taskId: "nonexistent", status: "busy" });
    const ack = await ackPromise;
    expect(ack).toEqual({ type: "hello_ack", workerId: "w1", status: "busy" });
  });

  it("worker reconnecting busy with unlabeled taskId still receives event notifications for that issue", async () => {
    // Simulate: worker was working on issue 42, label was removed (task no longer in queue),
    // worker disconnects and reconnects claiming busy for taskId "42"
    const ws = await connect();
    const q = makeQueue(ws);
    send(ws, { type: "worker_hello", workerId: "w1", taskId: "42", status: "busy" });
    const ack = await q.next();
    expect(ack).toEqual({ type: "hello_ack", workerId: "w1", status: "busy" });

    // A webhook event arrives for that issue — foreman must forward it to the worker
    routeEvent("evt-1", "issue_comment", { issue: { number: 42 }, comment: { body: "review" } });

    const msg = await q.next();
    assert(msg.type === "event_notification");
    expect(msg.taskId).toBe("42");
    expect(msg.event.name).toBe("issue_comment");
  });

  it("allows worker to reclaim task even if complete (issue closed, same worker)", async () => {
    await makeTask(taskModel, 1);
    await taskModel.assign("1", "w1");
    await taskModel.complete("1");

    const ws = await connect();
    const ackPromise = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", taskId: "1", status: "busy" });
    const ack = await ackPromise;
    expect(ack).toEqual({ type: "hello_ack", workerId: "w1", status: "busy" });
    expect(registry.get("w1")?.status).toBe("busy");
    expect(registry.get("w1")?.currentTaskId).toBe("1");
  });

  it("cancels worker when task is assigned to a different worker", async () => {
    await makeTask(taskModel, 1);
    await taskModel.assign("1", "w1");
    await taskModel.assign("1", "w2");

    const ws = await connect();
    const ackPromise = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", taskId: "1", status: "busy" });
    const ack = await ackPromise;
    expect(ack).toEqual({ type: "hello_ack", workerId: "w1", status: "cancelled" });
    expect(registry.get("w1")?.status).toBe("idle");
  });

  it("queued events are sent after hello_ack on reclaim", async () => {
    await makeTask(taskModel, 1);
    await taskModel.assign("1", "w1");
    registry.register("w1", {} as ReturnType<typeof connect> extends Promise<infer T> ? T : never, "busy", "1");
    registry.markDisconnected("w1");
    await routeEvent("evt-1", "issue_comment", { issue: { number: 1 } });

    const ws = await connect();
    const messages: ForemanMessage[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    send(ws, { type: "worker_hello", workerId: "w1", taskId: "1", status: "busy" });
    await waitUntil(() => messages.length >= 2);
    expect(messages[0]).toMatchObject({ type: "hello_ack", status: "busy" });
    expect(messages[1]).toMatchObject({ type: "event_notification" });
  });

  it("ignores task_complete from a worker that does not own the task", async () => {
    await makeTask(taskModel, 1);
    const wsA = await connect();
    const qA = makeQueue(wsA);
    send(wsA, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await qA.next(); // hello_ack
    await qA.next(); // task_assigned

    const wsB = await connect();
    send(wsB, { type: "worker_hello", workerId: "worker-b", status: "idle" });
    await nextMsg(wsB); // hello_ack (no task to assign)

    send(wsB, { type: "task_complete", workerId: "worker-b", taskId: "1" });
    await new Promise((r) => setTimeout(r, 20));

    expect((await taskModel.get("1"))?.status).toBe("assigned");
    expect((await taskModel.get("1"))?.assignedWorkerId).toBe("worker-a");
  });
});

describe("dependency-aware task assignment", () => {
  it("idle worker gets no message when the only pending task is blocked", async () => {
    await makeTask(taskModel, 42);
    taskModel.setIssueOpenState(10, true); // blocker is open
    setBlockers(42, [10], graph);

    const ws = await connect();
    const ackP = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await ackP; // hello_ack
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it("idle worker gets task_assigned when task has no open blockers", async () => {
    await makeTask(taskModel, 42);
    setBlockers(42, [10], graph);
    // openIssues does NOT contain 10 — blocker is closed

    const ws = await connect();
    const q = makeQueue(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await q.next(); // hello_ack
    const msg = await q.next();
    expect(msg.type).toBe("task_assigned");
  });

  it("issues/closed event unblocks a waiting task and sends task_assigned to idle worker", async () => {
    await makeTask(taskModel, 42);
    taskModel.setIssueOpenState(10, true);
    setBlockers(42, [10], graph);

    const ws = await connect();
    const ackP = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await ackP; // hello_ack (no task yet — task is blocked)

    const reply = nextMsg(ws);
    routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 10, title: "Blocker", body: "", labels: [] },
    });
    expect(await reply).toMatchObject({ type: "task_assigned", taskId: "42" });
  });

  it("issues/reopened re-blocks subsequent task assignments", async () => {
    await makeTask(taskModel, 43);
    setBlockers(43, [10], graph);
    // openIssues does not have 10 — starts unblocked

    // Blocker 10 reopens — openIssues now contains 10
    routeEvent("evt-1", "issues", {
      action: "reopened",
      issue: { number: 10, title: "Blocker", body: "", labels: [] },
    });

    // Worker connects — task 43 is now blocked, so worker gets no message
    const ws = await connect();
    const ackP = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await ackP; // hello_ack
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it("worker gets first unblocked task when queue has mixed blocked/unblocked tasks", async () => {
    await makeTask(taskModel, 1); // blocked
    await makeTask(taskModel, 2); // unblocked
    taskModel.setIssueOpenState(99, true);
    setBlockers(1, [99], graph);
    // task 2 has no blockers

    const ws = await connect();
    const q = makeQueue(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await q.next(); // hello_ack
    const msg = await q.next();
    expect(msg.type).toBe("task_assigned");
    if (msg.type === "task_assigned") expect(msg.issue.number).toBe(2);
  });
});

describe("worker secret enforcement", () => {
  async function makeSecretServer(secret: string): Promise<{ server: http.Server; secretWss: WebSocketServer; port: number }> {
    const server = http.createServer();
    const { wss: secretWss } = createForemanWss(
      new TaskModel(), new WorkerRegistry(), server,
      { ...defaultCfg, workerSecret: secret },
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
    const { wss } = createForemanWss(new TaskModel(), new WorkerRegistry(), server, defaultCfg);
    const testPort = await new Promise<number>((resolve) => {
      server.listen(0, () => resolve((server.address() as AddressInfo).port));
    });

    // Connect manually so we can register hello_ack listener before sending hello
    const ws = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });

    const ackP = new Promise<void>((r) => ws.once("message", () => r()));
    ws.send(JSON.stringify({ type: "worker_hello", workerId: "test-worker-id", status: "idle" }));
    await ackP; // consume hello_ack

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
    const { wss } = createForemanWss(new TaskModel(), new WorkerRegistry(), server, defaultCfg);
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
      new TaskModel(), localRegistry1, server,
      defaultCfg, { dbLogger: mockDbLogger },
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

    const localTaskModel = new TaskModel();
    await localTaskModel.register("42", 42, "owner/repo", "Some task", "Body", []);
    localTaskModel.trackIssue(42, { number: 42, title: "Some task", body: "Body", labels: [], repoUrl: "https://github.com/owner/repo" });
    localTaskModel.markIssueDepsLoaded(42);

    const localRegistry2 = new WorkerRegistry();
    const server = http.createServer();
    const { wss: testWss } = createForemanWss(
      localTaskModel, localRegistry2, server,
      defaultCfg, { dbLogger: mockDbLogger },
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
    await makeTask(taskModel, 1);
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned

    await closeClient(ws);
    await waitUntil(() => registry.get("w1")?.status === "disconnected");

    const entry = registry.get("w1");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("disconnected");
    expect(entry!.currentTaskId).toBe("1");
    expect((await taskModel.get("1"))?.status).toBe("assigned");
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
    await makeTask(taskModel, 1);
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned

    await closeClient(ws);
    await waitUntil(() => registry.get("w1")?.status === "disconnected");

    // Route an event while the worker is disconnected
    await routeEvent("evt-1", "issue_comment", { issue: { number: 1 }, comment: { body: "hi" } });

    // Event should be in the task queue, not dropped
    const queued = taskModel.drainEvents("1");
    expect(queued).toHaveLength(1);
    expect(queued[0].name).toBe("issue_comment");
  });

  it("reconnecting worker (busy) from disconnected state drains queued events", async () => {
    await makeTask(taskModel, 1);
    const ws1 = await connect();
    send(ws1, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws1); // hello_ack (task is assigned server-side regardless)

    await closeClient(ws1);
    await waitUntil(() => registry.get("w1")?.status === "disconnected");

    // Queue an event while disconnected
    await routeEvent("evt-1", "issue_comment", { issue: { number: 1 }, comment: { body: "hi" } });

    // Worker reconnects as busy — use makeQueue to get hello_ack then event_notification
    const ws2 = await connect();
    const q2 = makeQueue(ws2);
    send(ws2, { type: "worker_hello", workerId: "w1", taskId: "1", status: "busy" });
    await q2.next(); // hello_ack (status: busy)
    const msg = await q2.next();
    expect(msg.type).toBe("event_notification");
    if (msg.type === "event_notification") {
      expect(msg.taskId).toBe("1");
      expect(msg.event.name).toBe("issue_comment");
    }

    expect(registry.get("w1")?.status).toBe("busy");
    expect((await taskModel.get("1"))?.status).toBe("assigned");
  });

  it("reconnecting worker (idle) from disconnected state reverts task to pending", async () => {
    await makeTask(taskModel, 1);
    const ws1 = await connect();
    send(ws1, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws1); // hello_ack (task is assigned server-side regardless)

    await closeClient(ws1);
    await waitUntil(() => registry.get("w1")?.status === "disconnected");

    // Worker reconnects as idle (process restarted, no session context)
    // hello_ack + task_assigned arrive together — use makeQueue
    const ws2 = await connect();
    const q2 = makeQueue(ws2);
    send(ws2, { type: "worker_hello", workerId: "w1", status: "idle" });
    await q2.next(); // hello_ack
    const msg = await q2.next();
    expect(msg.type).toBe("task_assigned");
    if (msg.type === "task_assigned") expect(msg.taskId).toBe("1");

    expect(registry.get("w1")?.status).toBe("busy");
    expect((await taskModel.get("1"))?.status).toBe("assigned");
    expect((await taskModel.get("1"))?.assignedWorkerId).toBe("w1");
  });

  it("a different idle worker can pick up the reverted task when disconnected worker reconnects as idle", async () => {
    await makeTask(taskModel, 1);

    // Worker A gets the task
    const wsA = await connect();
    send(wsA, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await nextMsg(wsA); // hello_ack (task is assigned server-side regardless)

    await closeClient(wsA);
    await waitUntil(() => registry.get("worker-a")?.status === "disconnected");

    // Worker B is already connected and idle
    const wsB = await connect();
    const ackPB = nextMsg(wsB);
    send(wsB, { type: "worker_hello", workerId: "worker-b", status: "idle" });
    await ackPB; // hello_ack (no task available yet — assigned to disconnected worker-a)

    // Worker A reconnects as idle — task reverts to pending, gets reassigned (to worker-a first in registry order)
    const wsA2 = await connect();
    const qA2 = makeQueue(wsA2);
    send(wsA2, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await qA2.next(); // hello_ack
    const msg = await qA2.next();
    expect(msg.type).toBe("task_assigned");
    expect((await taskModel.get("1"))?.status).toBe("assigned");
  });
});

// ── worker_goodbye ────────────────────────────────────────────────────────────

describe("worker_goodbye", () => {
  it("removes worker from registry and reverts task to pending", async () => {
    await makeTask(taskModel, 1);
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned

    send(ws, { type: "worker_goodbye", workerId: "w1", taskId: "1" });
    await waitUntil(() => !registry.get("w1"));

    expect(registry.get("w1")).toBeUndefined();
    expect((await taskModel.get("1"))?.status).toBe("pending");
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
    await makeTask(taskModel, 1);

    // Worker A gets task 1
    const wsA = await connect();
    const qA = makeQueue(wsA);
    send(wsA, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await qA.next(); // hello_ack
    await qA.next(); // task_assigned

    // Worker B connects idle — consume hello_ack before registering for task_assigned from goodbye
    const wsB = await connect();
    const ackPB = nextMsg(wsB);
    send(wsB, { type: "worker_hello", workerId: "worker-b", status: "idle" });
    await ackPB; // hello_ack (no task — still assigned to worker-a)

    // Worker A says goodbye — task should revert and be assigned to B
    const replyB = nextMsg(wsB);
    send(wsA, { type: "worker_goodbye", workerId: "worker-a", taskId: "1" });
    const msg = await replyB;
    expect(msg.type).toBe("task_assigned");
    if (msg.type === "task_assigned") expect(msg.taskId).toBe("1");

    expect(registry.get("worker-a")).toBeUndefined();
    expect((await taskModel.get("1"))?.status).toBe("assigned");
    expect((await taskModel.get("1"))?.assignedWorkerId).toBe("worker-b");
  });
});

// ── worker_goodbye — DB persistence ──────────────────────────────────────────

describe("worker_goodbye — DB persistence", () => {
  it("calls markPending when goodbye carries a taskId", async () => {
    const realStore = createMemoryTaskStore();
    const spiedStore: TaskStore = {
      ...realStore,
      markPending: vi.fn(realStore.markPending),
      markAssigned: vi.fn(realStore.markAssigned),
    };

    const q = new TaskModel(spiedStore);
    const r = new WorkerRegistry();
    const srv = http.createServer();
    const { wss: testWss } = createForemanWss(q, r, srv, defaultCfg);

    await q.register("1", 1, "test/repo", "T", "b", []);
    q.trackIssue(1, { number: 1, title: "T", body: "b", labels: [], repoUrl: "https://github.com/test/repo" });
    q.markIssueDepsLoaded(1);

    await new Promise<void>((resolve) => srv.listen(0, resolve));
    const testPort = (srv.address() as AddressInfo).port;

    const ws = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    // Wait for hello_ack + task_assigned
    await waitUntil(() => r.get("w1")?.status === "busy");

    send(ws, { type: "worker_goodbye", workerId: "w1", taskId: "1" });
    await waitUntil(() => r.get("w1") === undefined);

    expect(spiedStore.markPending).toHaveBeenCalledWith("1");

    ws.close();
    await new Promise<void>((resolve) => ws.once("close", resolve));
    await new Promise<void>((resolve) => testWss.close(() => srv.close(resolve)));
  });

  it("does not call markPending when goodbye has no taskId", async () => {
    const realStore = createMemoryTaskStore();
    const spiedStore: TaskStore = {
      ...realStore,
      markPending: vi.fn(realStore.markPending),
    };

    const q = new TaskModel(spiedStore);
    const r = new WorkerRegistry();
    const srv = http.createServer();
    const { wss: testWss } = createForemanWss(q, r, srv, defaultCfg);

    await new Promise<void>((resolve) => srv.listen(0, resolve));
    const testPort = (srv.address() as AddressInfo).port;

    const ws = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await waitUntil(() => r.get("w1") !== undefined);

    send(ws, { type: "worker_goodbye", workerId: "w1" });
    await waitUntil(() => r.get("w1") === undefined);

    expect(spiedStore.markPending).not.toHaveBeenCalled();

    ws.close();
    await new Promise<void>((resolve) => ws.once("close", resolve));
    await new Promise<void>((resolve) => testWss.close(() => srv.close(resolve)));
  });
});

// ── issues/closed — DB persistence ───────────────────────────────────────────

describe("issues/closed — DB persistence", () => {
  it("calls markComplete immediately when an issue is closed while a worker is active", async () => {
    const realStore = createMemoryTaskStore();
    const spiedStore: TaskStore = {
      ...realStore,
      markComplete: vi.fn(realStore.markComplete),
    };

    const q = new TaskModel(spiedStore);
    const r = new WorkerRegistry();
    const srv = http.createServer();
    const { wss: testWss, routeEvent: testRouteEvent } = createForemanWss(q, r, srv, defaultCfg);

    await q.register("1", 1, "test/repo", "T", "b", []);
    q.trackIssue(1, { number: 1, title: "T", body: "b", labels: [], repoUrl: "https://github.com/test/repo" });
    q.markIssueDepsLoaded(1);
    await q.assign("1", "w1");

    testRouteEvent("evt-1", "issues", { action: "closed", issue: { number: 1, title: "T", body: "", labels: [] } });

    // closeIssue is async, wait for it
    await waitUntil(() => (spiedStore.markComplete as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    expect(spiedStore.markComplete).toHaveBeenCalledWith("1");

    await new Promise<void>((resolve) => testWss.close(() => srv.close(resolve)));
  });
});

// ── worker_hello — DB persistence ────────────────────────────────────────────

describe("worker_hello — DB persistence", () => {
  it("allows worker to reclaim complete task for finalization work", async () => {
    const realStore = createMemoryTaskStore();
    const spiedStore: TaskStore = {
      ...realStore,
      assign: vi.fn(realStore.assign),
    };

    const q = new TaskModel(spiedStore);
    const r = new WorkerRegistry();
    const srv = http.createServer();
    const { wss: testWss } = createForemanWss(q, r, srv, defaultCfg);

    await q.register("1", 1, "test/repo", "T", "b", []);
    q.trackIssue(1, { number: 1, title: "T", body: "b", labels: [], repoUrl: "https://github.com/test/repo" });
    q.markIssueDepsLoaded(1);
    await q.assign("1", "w1");
    await q.complete("1");

    await new Promise<void>((resolve) => srv.listen(0, resolve));
    const testPort = (srv.address() as AddressInfo).port;

    const ws = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    const ackPromise = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", taskId: "1", status: "busy" });
    const ack = await ackPromise;
    expect(ack).toEqual({ type: "hello_ack", workerId: "w1", status: "busy" });
    // Worker is reclaimed to allow finalization work
    expect(r.get("w1")?.status).toBe("busy");
    expect(r.get("w1")?.currentTaskId).toBe("1");

    ws.close();
    await new Promise<void>((resolve) => ws.once("close", resolve));
    await new Promise<void>((resolve) => testWss.close(() => srv.close(resolve)));
  });
});

// ── Keepalive ping ─────────────────────────────────────────────────────────────

describe("keepalive ping", () => {
  it("sends WebSocket ping to connected clients on interval", async () => {
    const q = new TaskModel();
    const r = new WorkerRegistry();
    const srv = http.createServer();
    const { wss: testWss } = createForemanWss(q, r, srv, { ...defaultCfg, pingIntervalMs: 50 });
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

    const q = new TaskModel();
    const r = new WorkerRegistry();
    const srv = http.createServer();
    const { wss: testWss } = createForemanWss(q, r, srv, { ...defaultCfg, workerReclaimTimeoutMs: reclaimTimeoutMs });
    await new Promise<void>((resolve) => srv.listen(0, resolve));
    const testPort = (srv.address() as AddressInfo).port;

    // Add a task and assign it via worker A
    await makeTask(q, 1);
    const wsA = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { wsA.once("open", resolve); wsA.once("error", reject); });
    send(wsA, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await new Promise<void>((resolve) => wsA.once("message", resolve)); // task_assigned

    // Worker A disconnects (crash)
    await new Promise<void>((resolve) => { wsA.once("close", resolve); wsA.close(); });
    await waitUntil(() => r.get("worker-a")?.status === "disconnected");

    // Task should still be assigned (timer hasn't fired)
    expect((await q.get("1"))?.status).toBe("assigned");
    expect(r.get("worker-a")?.status).toBe("disconnected");

    // Connect worker B (idle) — task is still assigned to A, so B gets no message yet
    const wsB = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { wsB.once("open", resolve); wsB.once("error", reject); });
    const qB = makeQueue(wsB);
    send(wsB, { type: "worker_hello", workerId: "worker-b", status: "idle" });
    await waitUntil(() => r.get("worker-b")?.status === "idle");
    await qB.next(); // hello_ack (no task yet — still assigned to disconnected worker-a)

    // Advance time past the reclaim timeout
    vi.advanceTimersByTime(reclaimTimeoutMs + 100);

    // Worker B should get a task_assigned after the reclaim
    const msgB2 = await qB.next();
    expect(msgB2.type).toBe("task_assigned");
    if (msgB2.type === "task_assigned") expect(msgB2.taskId).toBe("1");

    // Worker A should be removed from registry
    expect(r.get("worker-a")).toBeUndefined();

    // Task is now assigned to worker B
    expect((await q.get("1"))?.status).toBe("assigned");
    expect((await q.get("1"))?.assignedWorkerId).toBe("worker-b");

    wsB.close();
    await new Promise<void>((r) => wsB.once("close", r));
    await new Promise<void>((r) => testWss.close(() => srv.close(r)));
  });

  it("reconnecting before timer fires cancels the timer and keeps the task", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reclaimTimeoutMs = 5000;

    const q = new TaskModel();
    const r = new WorkerRegistry();
    const srv = http.createServer();
    const { wss: testWss } = createForemanWss(q, r, srv, { ...defaultCfg, workerReclaimTimeoutMs: reclaimTimeoutMs });
    await new Promise<void>((resolve) => srv.listen(0, resolve));
    const testPort = (srv.address() as AddressInfo).port;

    await makeTask(q, 1);
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
    expect((await q.get("1"))?.status).toBe("assigned");
    expect(r.get("worker-a")?.status).toBe("busy");

    wsA2.close();
    await new Promise<void>((r) => wsA2.once("close", r));
    await new Promise<void>((r) => testWss.close(() => srv.close(r)));
  });

  it("late reconnect after timer fires can reclaim pending task", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reclaimTimeoutMs = 500;

    const q = new TaskModel();
    const r = new WorkerRegistry();
    const srv = http.createServer();
    const { wss: testWss } = createForemanWss(q, r, srv, { ...defaultCfg, workerReclaimTimeoutMs: reclaimTimeoutMs });
    await new Promise<void>((resolve) => srv.listen(0, resolve));
    const testPort = (srv.address() as AddressInfo).port;

    await makeTask(q, 1);
    const wsA = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { wsA.once("open", resolve); wsA.once("error", reject); });
    send(wsA, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await new Promise<void>((resolve) => wsA.once("message", resolve)); // task_assigned

    // Disconnect
    await new Promise<void>((resolve) => { wsA.once("close", resolve); wsA.close(); });
    await waitUntil(() => r.get("worker-a")?.status === "disconnected");

    // Let the timer fire
    vi.advanceTimersByTime(reclaimTimeoutMs + 100);
    // Wait for the reclaim to process (worker-a removed from registry)
    await waitUntil(() => r.get("worker-a") === undefined);

    // Task is now pending
    expect((await q.get("1"))?.status).toBe("pending");

    // Original worker reconnects as busy (late reconnect)
    const wsA2 = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { wsA2.once("open", resolve); wsA2.once("error", reject); });
    // Consume hello_ack before checking for no further messages
    const ackPA2 = new Promise<void>((res) => wsA2.once("message", () => res()));
    send(wsA2, { type: "worker_hello", workerId: "worker-a", taskId: "1", status: "busy" });
    await ackPA2; // hello_ack
    const raceResult = await Promise.race([
      new Promise<ForemanMessage>((resolve) => wsA2.once("message", (d) => resolve(JSON.parse(d.toString())))).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 100)),
    ]);

    // No message sent — reclaimed silently
    expect(raceResult).toBe("timeout");
    expect((await q.get("1"))?.status).toBe("assigned");
    expect(r.get("worker-a")?.status).toBe("busy");

    wsA2.close();
    await new Promise<void>((r) => wsA2.once("close", r));
    await new Promise<void>((r) => testWss.close(() => srv.close(r)));
  });

  it("stale close from old connection does not corrupt registry when worker has already reconnected", async () => {
    // Bug: if ws1's close event fires AFTER ws2 has already reconnected and registered,
    // the foreman was incorrectly marking ws2's registry entry as "disconnected" and
    // starting a reclaim timer. This would eventually cancel a legitimately working worker.

    // Connect wsA and get a task
    const wsA = await connect();
    await makeTask(taskModel, 1);
    const qA = makeQueue(wsA);
    send(wsA, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await qA.next(); // hello_ack
    await qA.next(); // task_assigned
    await waitUntil(() => registry.get("worker-a")?.status === "busy");

    // Worker reconnects with a NEW connection (wsA2) claiming the task,
    // BEFORE wsA's close event fires on the server.
    const wsA2 = await connect();
    const qA2 = makeQueue(wsA2);
    send(wsA2, { type: "worker_hello", workerId: "worker-a", taskId: "1", status: "busy" });
    const busyAck = await qA2.next(); // hello_ack busy
    expect(busyAck).toMatchObject({ type: "hello_ack", status: "busy" });
    // wsA2's hello has been processed — registry now points to wsA2's server socket

    // Simulate stale close: wsA closes AFTER wsA2 has registered
    wsA.close();
    await new Promise<void>((r) => wsA.once("close", r));
    // Give server a few event-loop ticks to process the close
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    // The stale close must be ignored — registry stays "busy", no reclaim timer
    expect(registry.get("worker-a")?.status).toBe("busy");
    expect(registry.get("worker-a")?.currentTaskId).toBe("1");

    wsA2.close();
    await new Promise<void>((r) => wsA2.once("close", r));
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
      new TaskModel(), localRegistry, srv,
      defaultCfg, { dbLogger: mockDbLogger },
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
