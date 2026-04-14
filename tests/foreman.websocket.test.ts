import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import http from "http";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "net";
import { Worker } from "../src/foreman/models/worker.js";
import { ForemanWss } from "../src/foreman/controllers/wss.js";
import { TaskManager } from "../src/foreman/models/task-manager.js";
import { Task } from "../src/foreman/models/task.js";
import { setupInMemoryTasks } from "./helpers/task.js";
import { loadDefaultConfig } from "../src/config.js";
const defaultCfg = await loadDefaultConfig();
import * as Wire from "../shared/wire.js";
import { ForemanMessage } from "../src/foreman/models/foreman-message.js";
import { waitUntil } from "./helpers.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/** FIFO queue that buffers all messages — safe against hello_ack + task_assigned in same TCP packet. */
function makeQueue(ws: WebSocket): { next: () => Promise<Wire.ForemanMessage> } {
  const pending: Wire.ForemanMessage[] = [];
  const waiters: Array<(m: Wire.ForemanMessage) => void> = [];
  ws.on("message", (data: Buffer | string) => {
    const msg = JSON.parse(data.toString()) as Wire.ForemanMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else pending.push(msg);
  });
  return {
    next(): Promise<Wire.ForemanMessage> {
      if (pending.length > 0) return Promise.resolve(pending.shift()!);
      return new Promise((r) => waiters.push(r));
    },
  };
}

function send(ws: WebSocket, msg: object) {
  ws.send(JSON.stringify(msg));
}

async function makeTask(tm: TaskManager, n: number) {
  const taskId = String(n);
  const title = `Issue ${n}`;
  const body = `Body of issue ${n}`;
  const labels: string[] = [];
  const repoSlug = "owner/repo";
  await Task.upsert(taskId, n, repoSlug, title, body, labels);
  tm.trackIssue(n);
  tm.markBlockersLoaded(n);
}

function closeClient(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.once("close", resolve);
    ws.close();
  });
}

// ── Test harness ──────────────────────────────────────────────────────────────

let taskManager: TaskManager;
let httpServer: http.Server;
let wss: WebSocketServer;
let foremanWss: ForemanWss;
let port: number;
const openClients: WebSocket[] = [];

function connect(): Promise<WebSocket> {
  return connectWorker(port).then((ws) => { openClients.push(ws); return ws; });
}

beforeEach(() => {
  Worker._reset();
  taskManager = new TaskManager();
  setupInMemoryTasks(taskManager);
  httpServer = http.createServer();
  foremanWss = new ForemanWss({ taskManager, server: httpServer, config: defaultCfg });
  ({ wss } = foremanWss);

  return new Promise<void>((resolve) => {
    httpServer.listen(0, () => {
      port = (httpServer.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
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
    expect(Worker.get("w1")?.status).toBe("idle");
  });

  it("idle worker with pending task receives task_assigned", async () => {
    await makeTask(taskManager, 1);
    const ws = await connect();
    const q = makeQueue(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await q.next(); // hello_ack
    const msg = await q.next();
    assert(msg.type === "task_assigned");
    expect(msg.issue.number).toBe(1);
    expect(msg.taskId).toBe("1");
    expect((await Task.get("1"))?.status).toBe("assigned");
    expect(Worker.get("w1")?.status).toBe("busy");
  });

  it("second idle worker gets no message when only task is already assigned", async () => {
    await makeTask(taskManager, 1);
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

  it("two idle workers: only one gets task_assigned when reconcile runs (no double-assignment)", async () => {
    const ws1 = await connect();
    const ws2 = await connect();
    const q1 = makeQueue(ws1);
    const q2 = makeQueue(ws2);
    send(ws1, { type: "worker_hello", workerId: "w1", status: "idle" });
    await q1.next(); // hello_ack (no task yet)
    send(ws2, { type: "worker_hello", workerId: "w2", status: "idle" });
    await q2.next(); // hello_ack (no task yet)

    await makeTask(taskManager, 42);
    await foremanWss.reconcile();

    const w1Status = Worker.get("w1")?.status;
    const w2Status = Worker.get("w2")?.status;
    const busyCount = [w1Status, w2Status].filter((s) => s === "busy").length;
    expect(busyCount).toBe(1);

    const task = await Task.get("42");
    expect(task?.status).toBe("assigned");
    expect(task?.workerId).toBeTruthy();
  });

  it("two concurrent reconcile() calls don't double-assign the same task (issue #577)", async () => {
    const ws1 = await connect();
    const ws2 = await connect();
    const q1 = makeQueue(ws1);
    const q2 = makeQueue(ws2);
    send(ws1, { type: "worker_hello", workerId: "w1", status: "idle" });
    await q1.next(); // hello_ack (no task yet)
    send(ws2, { type: "worker_hello", workerId: "w2", status: "idle" });
    await q2.next(); // hello_ack (no task yet)

    await makeTask(taskManager, 99);
    await Promise.all([foremanWss.reconcile(), foremanWss.reconcile()]);

    const w1Status = Worker.get("w1")?.status;
    const w2Status = Worker.get("w2")?.status;
    const busyCount = [w1Status, w2Status].filter((s) => s === "busy").length;
    expect(busyCount).toBe(1);

    const task = await Task.get("99");
    expect(task?.status).toBe("assigned");
    expect(task?.workerId).toBeTruthy();
  });

  it("task_complete completes task and assigns next task", async () => {
    await makeTask(taskManager, 1001);
    await new Promise(r => setTimeout(r, 10));
    await makeTask(taskManager, 1002);
    const ws = await connect();
    const q = makeQueue(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await q.next(); // hello_ack
    const first = await q.next();
    assert(first.type === "task_assigned");
    expect(first.issue.number).toBe(1002);

    const second = q.next();
    send(ws, { type: "task_complete", workerId: "w1", taskId: "1002" });
    const msg = await second;
    assert(msg.type === "task_assigned");
    expect(msg.issue.number).toBe(1001);

    expect((await Task.get("1002"))?.status).toBe("complete");
  });

  it("task_complete with no further tasks sends no message", async () => {
    await makeTask(taskManager, 1);
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
    await makeTask(taskManager, 1);
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
    expect(Worker.get("w1")?.status).toBe("busy");
    expect(Worker.get("w1")?.currentTaskId).toBe("1");
    expect((await Task.get("1"))?.status).toBe("assigned");
  });

  it("routeEvent sends event_notification to assigned worker", async () => {
    await makeTask(taskManager, 1);
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned

    const reply = nextMsg(ws);
    foremanWss.routeEvent("evt-1", "issue_comment", { issue: { number: 1 }, comment: { body: "hi" } });
    const msg = await reply;
    assert(msg.type === "event_notification");
    expect(msg.taskId).toBe("1");
    expect(msg.event.name).toBe("issue_comment");
  });

  it("routeEvent queues event when no worker is assigned", async () => {
    await makeTask(taskManager, 1);
    await foremanWss.routeEvent("evt-1", "issue_comment", { issue: { number: 1 } });
    const t = await Task.get("1");
    const events = taskManager.drainEvents(t!);
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe("issue_comment");
  });

  it("invalid JSON from worker does not crash the server", async () => {
    const ws = await connect();
    ws.send("not valid json {{{");
    await new Promise((r) => setTimeout(r, 20));
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
    await makeTask(taskManager, 1);
    const wsA = await connect();
    const qA = makeQueue(wsA);
    send(wsA, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await qA.next(); // hello_ack
    await qA.next(); // task_assigned
    await closeClient(wsA);

    const wsB = await connect();
    const ackPB = nextMsg(wsB);
    send(wsB, { type: "worker_hello", workerId: "worker-b", taskId: "1", status: "busy" });
    await ackPB; // hello_ack (status: cancelled — task belongs to A)
    const raceResultB = await Promise.race([
      nextMsg(wsB).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResultB).toBe("timeout");

    const wsA2 = await connect();
    const ackPA2 = nextMsg(wsA2);
    send(wsA2, { type: "worker_hello", workerId: "worker-a", taskId: "1", status: "busy" });
    await ackPA2; // hello_ack (status: busy)
    const raceResult2 = await Promise.race([
      nextMsg(wsA2).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult2).toBe("timeout");
    expect(Worker.get("worker-a")?.status).toBe("busy");
  });

  it("task_complete releases worker to idle", async () => {
    await makeTask(taskManager, 1);
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned
    send(ws, { type: "task_complete", workerId: "w1", taskId: "1" });
    await waitUntil(() => Worker.get("w1")?.status === "idle");
    expect((await Task.get("1"))?.status).toBe("complete");
  });

  it("worker reconnects as busy with its own completed taskId is allowed to reclaim (finalization)", async () => {
    await makeTask(taskManager, 1);
    const t = await Task.get("1");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    const w1 = Worker.register("w1", fakeWs);
    await t!.assign(w1);
    w1.remove(); // deregister so waitUntil below detects the real reconnect
    await t!.complete();

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", taskId: "1", status: "busy" });
    await waitUntil(() => Worker.get("w1") !== undefined);
    expect(Worker.get("w1")?.status).toBe("busy");
    expect(Worker.get("w1")?.currentTaskId).toBe("1");
  });

  it("events are routed to the correct worker when multiple workers have different tasks", async () => {
    await makeTask(taskManager, 53);
    await makeTask(taskManager, 55);

    const wsA = await connect();
    const qA = makeQueue(wsA);
    send(wsA, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await qA.next(); // hello_ack
    const msgA = await qA.next();
    assert(msgA.type === "task_assigned");
    const taskA = msgA.issue.number;
    expect([53, 55]).toContain(taskA);

    const wsB = await connect();
    const qB = makeQueue(wsB);
    send(wsB, { type: "worker_hello", workerId: "worker-b", status: "idle" });
    await qB.next(); // hello_ack
    const msgB = await qB.next();
    assert(msgB.type === "task_assigned");
    const taskB = msgB.issue.number;
    expect([53, 55]).toContain(taskB);
    expect(taskA).not.toBe(taskB);

    const replyA = nextMsg(wsA);
    const noMsgB = Promise.race([
      nextMsg(wsB).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    foremanWss.routeEvent("evt-1", "issue_comment", { issue: { number: taskA }, comment: { body: "update" } });
    expect(await replyA).toMatchObject({ type: "event_notification", taskId: String(taskA) });
    expect(await noMsgB).toBe("timeout");

    const replyB = nextMsg(wsB);
    const noMsgA = Promise.race([
      nextMsg(wsA).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    foremanWss.routeEvent("evt-2", "issue_comment", { issue: { number: taskB }, comment: { body: "update" } });
    expect(await replyB).toMatchObject({ type: "event_notification", taskId: String(taskB) });
    expect(await noMsgA).toBe("timeout");
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
    await makeTask(taskManager, 1);
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
    await makeTask(taskManager, 1);
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
    expect(Worker.get("worker-b")?.status).toBe("idle");
  });

  it("worker reconnecting busy with nonexistent taskId receives cancelled status", async () => {
    const ws = await connect();
    const ackPromise = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", taskId: "nonexistent", status: "busy" });
    const ack = await ackPromise;
    expect(ack).toEqual({ type: "hello_ack", workerId: "w1", status: "cancelled" });
    expect(Worker.get("w1")?.status).toBe("idle");
  });

  it("allows worker to reclaim task even if complete (issue closed, same worker)", async () => {
    await makeTask(taskManager, 1);
    const t = await Task.get("1");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs));
    await t!.complete();

    const ws = await connect();
    const ackPromise = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", taskId: "1", status: "busy" });
    const ack = await ackPromise;
    expect(ack).toEqual({ type: "hello_ack", workerId: "w1", status: "busy" });
    expect(Worker.get("w1")?.status).toBe("busy");
    expect(Worker.get("w1")?.currentTaskId).toBe("1");
  });

  it("cancels worker when task is assigned to a different worker", async () => {
    await makeTask(taskManager, 1);
    const t = await Task.get("1");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs));
    await t!.assign(Worker.register("w2", fakeWs));

    const ws = await connect();
    const ackPromise = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", taskId: "1", status: "busy" });
    const ack = await ackPromise;
    expect(ack).toEqual({ type: "hello_ack", workerId: "w1", status: "cancelled" });
    expect(Worker.get("w1")?.status).toBe("idle");
  });

  it("queued events are sent after hello_ack on reclaim", async () => {
    await makeTask(taskManager, 1);
    const t = await Task.get("1");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    { const w = Worker.register("w1", fakeWs); await t!.assign(w); w.assign(t!); w.markDisconnected(); }
    await foremanWss.routeEvent("evt-1", "issue_comment", { issue: { number: 1 } });

    const ws = await connect();
    const messages: Wire.ForemanMessage[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    send(ws, { type: "worker_hello", workerId: "w1", taskId: "1", status: "busy" });
    await waitUntil(() => messages.length >= 2);
    expect(messages[0]).toMatchObject({ type: "hello_ack", status: "busy" });
    expect(messages[1]).toMatchObject({ type: "event_notification" });
  });

  it("ignores task_complete from a worker that does not own the task", async () => {
    await makeTask(taskManager, 1);
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

    expect((await Task.get("1"))?.status).toBe("assigned");
    expect((await Task.get("1"))?.workerId).toBe("worker-a");
  });
});

describe("dependency-aware task assignment", () => {
  it("idle worker gets no message when the only pending task is blocked", async () => {
    await makeTask(taskManager, 42);
    taskManager.setIssueOpenState(10, true); // blocker is open
    taskManager.setBlockers(42, [10]);

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
    await makeTask(taskManager, 42);
    taskManager.setBlockers(42, [10]);
    // openIssues does NOT contain 10 — blocker is closed

    const ws = await connect();
    const q = makeQueue(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await q.next(); // hello_ack
    const msg = await q.next();
    expect(msg.type).toBe("task_assigned");
  });

  it("issues/closed event unblocks a waiting task and sends task_assigned to idle worker", async () => {
    await makeTask(taskManager, 42);
    taskManager.setIssueOpenState(10, true);
    taskManager.setBlockers(42, [10]);

    const ws = await connect();
    const ackP = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await ackP; // hello_ack (no task yet — task is blocked)

    const reply = nextMsg(ws);
    foremanWss.routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 10, title: "Blocker", body: "", labels: [] },
    });
    expect(await reply).toMatchObject({ type: "task_assigned", taskId: "42" });
  });

  it("issues/reopened re-blocks subsequent task assignments", async () => {
    await makeTask(taskManager, 43);
    taskManager.setBlockers(43, [10]);

    foremanWss.routeEvent("evt-1", "issues", {
      action: "reopened",
      issue: { number: 10, title: "Blocker", body: "", labels: [] },
    });

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
    await makeTask(taskManager, 1); // blocked
    await makeTask(taskManager, 2); // unblocked
    taskManager.setIssueOpenState(99, true);
    taskManager.setBlockers(1, [99]);

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
    const tm = new TaskManager();
    setupInMemoryTasks(tm);
    const { wss: secretWss } = new ForemanWss({ taskManager: tm, server, config: { ...defaultCfg, workerSecret: secret } });
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
      await new Promise((r) => setTimeout(r, 20));
      ws.close();
    } finally {
      await new Promise<void>((r) => secretWss.close(() => server.close(r)));
    }
  });

  it("accepts any worker when workerSecret is not configured", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await waitUntil(() => Worker.get("w1")?.status === "idle");
    expect(Worker.get("w1")?.status).toBe("idle");
  });
});

describe("worker WebSocket connection", () => {
  it("worker client connects to foreman successfully", async () => {
    const server = http.createServer();
    const tm = new TaskManager();
    setupInMemoryTasks(tm);
    const { wss } = new ForemanWss({ taskManager: tm, server, config: defaultCfg });
    const testPort = await new Promise<number>((resolve) => {
      server.listen(0, () => resolve((server.address() as AddressInfo).port));
    });

    const ws = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });

    const ackP = new Promise<void>((r) => ws.once("message", () => r()));
    ws.send(JSON.stringify({ type: "worker_hello", workerId: "test-worker-id", status: "idle" }));
    await ackP;

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
    const tm = new TaskManager();
    setupInMemoryTasks(tm);
    const { wss } = new ForemanWss({ taskManager: tm, server, config: defaultCfg });
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

describe("worker disconnect DB logging", () => {
  it("calls ForemanMessage.log with worker_disconnected when a registered worker disconnects", async () => {
    const logSpy = vi.spyOn(ForemanMessage, "log").mockReturnValue(undefined);

    const server = http.createServer();
    const localTm = new TaskManager();
    setupInMemoryTasks(localTm);
    const { wss: testWss } = new ForemanWss({ taskManager: localTm, server, config: defaultCfg });
    const testPort = await new Promise<number>((r) => server.listen(0, () => r((server.address() as AddressInfo).port)));

    const ws = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "worker_hello", workerId: "w-disc-1", status: "idle" }));
    await waitUntil(() => !!Worker.get("w-disc-1"));

    await new Promise<void>((resolve) => {
      ws.once("close", resolve);
      ws.close();
    });
    await waitUntil(() => !Worker.get("w-disc-1") || Worker.get("w-disc-1")?.status === "disconnected");

    const calls = logSpy.mock.calls;
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
    const logSpy = vi.spyOn(ForemanMessage, "log").mockReturnValue(undefined);

    const localTm = new TaskManager();
    setupInMemoryTasks(localTm);
    await Task.upsert("42", 42, "owner/repo", "Some task", "Body", []);
    localTm.trackIssue(42);
    localTm.markBlockersLoaded(42);

    const server = http.createServer();
    const { wss: testWss } = new ForemanWss({ taskManager: localTm, server, config: defaultCfg });
    const testPort = await new Promise<number>((r) => server.listen(0, () => r((server.address() as AddressInfo).port)));

    const ws = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "worker_hello", workerId: "w-disc-2", status: "idle" }));
    // Wait for task_assigned reply (after hello_ack)
    await new Promise<void>((resolve) => {
      let count = 0;
      ws.on("message", () => { count++; if (count >= 2) resolve(); });
    });

    await new Promise<void>((resolve) => {
      ws.once("close", resolve);
      ws.close();
    });
    await waitUntil(() => Worker.get("w-disc-2")?.status === "disconnected");

    const calls = logSpy.mock.calls;
    const disconnectCall = calls.find((c) => c[0].msgType === "worker_disconnected");
    expect(disconnectCall).toBeDefined();
    expect(disconnectCall![0].taskId).toBe("42");

    await new Promise<void>((r) => testWss.close(() => server.close(r)));
  });
});

describe("disconnected worker state", () => {
  it("worker with active task is marked disconnected (not removed) on close", async () => {
    await makeTask(taskManager, 1);
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned

    await closeClient(ws);
    await waitUntil(() => Worker.get("w1")?.status === "disconnected");

    const entry = Worker.get("w1");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("disconnected");
    expect(entry!.currentTaskId).toBe("1");
    expect((await Task.get("1"))?.status).toBe("assigned");
  });

  it("idle worker is removed from registry on close", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await waitUntil(() => !!Worker.get("w1"));

    await closeClient(ws);
    await waitUntil(() => !Worker.get("w1"));

    expect(Worker.get("w1")).toBeUndefined();
  });

  it("events are queued (not dropped) when assigned worker is disconnected", async () => {
    await makeTask(taskManager, 1);
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned

    await closeClient(ws);
    await waitUntil(() => Worker.get("w1")?.status === "disconnected");

    await foremanWss.routeEvent("evt-1", "issue_comment", { issue: { number: 1 }, comment: { body: "hi" } });

    const t = await Task.get("1");
    const queued = taskManager.drainEvents(t!);
    expect(queued).toHaveLength(1);
    expect(queued[0].eventName).toBe("issue_comment");
  });

  it("reconnecting worker (busy) from disconnected state drains queued events", async () => {
    await makeTask(taskManager, 1);
    const ws1 = await connect();
    send(ws1, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws1); // hello_ack (task is assigned server-side regardless)

    await closeClient(ws1);
    await waitUntil(() => Worker.get("w1")?.status === "disconnected");

    await foremanWss.routeEvent("evt-1", "issue_comment", { issue: { number: 1 }, comment: { body: "hi" } });

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

    expect(Worker.get("w1")?.status).toBe("busy");
    expect((await Task.get("1"))?.status).toBe("assigned");
  });

  it("reconnecting worker (idle) from disconnected state reverts task to pending", async () => {
    await makeTask(taskManager, 1);
    const ws1 = await connect();
    send(ws1, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws1); // hello_ack (task is assigned server-side regardless)

    await closeClient(ws1);
    await waitUntil(() => Worker.get("w1")?.status === "disconnected");

    const ws2 = await connect();
    const q2 = makeQueue(ws2);
    send(ws2, { type: "worker_hello", workerId: "w1", status: "idle" });
    await q2.next(); // hello_ack
    const msg = await q2.next();
    expect(msg.type).toBe("task_assigned");
    if (msg.type === "task_assigned") expect(msg.taskId).toBe("1");

    expect(Worker.get("w1")?.status).toBe("busy");
    expect((await Task.get("1"))?.status).toBe("assigned");
    expect((await Task.get("1"))?.workerId).toBe("w1");
  });

  it("a different idle worker can pick up the reverted task when disconnected worker reconnects as idle", async () => {
    await makeTask(taskManager, 1);

    const wsA = await connect();
    send(wsA, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await nextMsg(wsA); // hello_ack (task is assigned server-side regardless)

    await closeClient(wsA);
    await waitUntil(() => Worker.get("worker-a")?.status === "disconnected");

    const wsB = await connect();
    const ackPB = nextMsg(wsB);
    send(wsB, { type: "worker_hello", workerId: "worker-b", status: "idle" });
    await ackPB; // hello_ack (no task available yet — assigned to disconnected worker-a)

    const wsA2 = await connect();
    const qA2 = makeQueue(wsA2);
    send(wsA2, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await qA2.next(); // hello_ack
    const msg = await qA2.next();
    expect(msg.type).toBe("task_assigned");
    expect((await Task.get("1"))?.status).toBe("assigned");
  });
});

describe("worker_goodbye", () => {
  it("removes worker from registry and reverts task to pending", async () => {
    await makeTask(taskManager, 1);
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned

    send(ws, { type: "worker_goodbye", workerId: "w1", taskId: "1" });
    await waitUntil(() => !Worker.get("w1"));

    expect(Worker.get("w1")).toBeUndefined();
    expect((await Task.get("1"))?.status).toBe("pending");
  });

  it("removes idle worker from registry when goodbye has no taskId", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await waitUntil(() => !!Worker.get("w1"));

    send(ws, { type: "worker_goodbye", workerId: "w1" });
    await waitUntil(() => !Worker.get("w1"));

    expect(Worker.get("w1")).toBeUndefined();
  });

  it("reverted task is immediately assigned to a waiting idle worker", async () => {
    await makeTask(taskManager, 1);

    const wsA = await connect();
    const qA = makeQueue(wsA);
    send(wsA, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await qA.next(); // hello_ack
    await qA.next(); // task_assigned

    const wsB = await connect();
    const ackPB = nextMsg(wsB);
    send(wsB, { type: "worker_hello", workerId: "worker-b", status: "idle" });
    await ackPB; // hello_ack (no task — still assigned to worker-a)

    const replyB = nextMsg(wsB);
    send(wsA, { type: "worker_goodbye", workerId: "worker-a", taskId: "1" });
    const msg = await replyB;
    expect(msg.type).toBe("task_assigned");
    if (msg.type === "task_assigned") expect(msg.taskId).toBe("1");

    expect(Worker.get("worker-a")).toBeUndefined();
    expect((await Task.get("1"))?.status).toBe("assigned");
    expect((await Task.get("1"))?.workerId).toBe("worker-b");
  });
});

describe("worker_goodbye — revert persistence", () => {
  it("calls task.revert when goodbye carries a taskId", async () => {
    await makeTask(taskManager, 1);
    // Wait for the task to be created and get the spy-equipped task
    const t = await Task.get("1");
    const spyRevert = vi.spyOn(t!, "revert");

    // Also spy on Task.get to return our spy-equipped task
    vi.spyOn(Task, "get").mockImplementation(async (id) => {
      if (id === "1") return t!;
      return null;
    });

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await waitUntil(() => Worker.get("w1")?.status === "busy");

    send(ws, { type: "worker_goodbye", workerId: "w1", taskId: "1" });
    await waitUntil(() => Worker.get("w1") === undefined);

    expect(spyRevert).toHaveBeenCalled();
  });

  it("does not call task.revert when goodbye has no taskId", async () => {
    const spyGet = vi.spyOn(Task, "get");

    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await waitUntil(() => Worker.get("w1") !== undefined);

    send(ws, { type: "worker_goodbye", workerId: "w1" });
    await waitUntil(() => Worker.get("w1") === undefined);

    // Task.get should not be called for goodbye without taskId
    expect(spyGet).not.toHaveBeenCalled();
  });
});

describe("issues/closed — close persistence", () => {
  it("calls task.close when an issue is closed while a worker is active", async () => {
    await Task.upsert("1", 1, "test/repo", "T", "b", []);
    const t = await Task.get("1");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs));
    const spyClose = vi.spyOn(t!, "close");
    vi.spyOn(Task, "getByIssue").mockResolvedValue(t!);

    taskManager.trackIssue(1);
    taskManager.markBlockersLoaded(1);

    await foremanWss.routeEvent("evt-1", "issues", { action: "closed", issue: { number: 1, title: "T", body: "", labels: [] } });

    await waitUntil(() => spyClose.mock.calls.length > 0);
    expect(spyClose).toHaveBeenCalled();
  });
});

describe("worker_hello — reclaim complete task for finalization work", () => {
  it("allows worker to reclaim complete task", async () => {
    await Task.upsert("1", 1, "test/repo", "T", "b", []);
    const t = await Task.get("1");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs));
    await t!.complete();

    const ws = await connect();
    const ackPromise = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", taskId: "1", status: "busy" });
    const ack = await ackPromise;
    expect(ack).toEqual({ type: "hello_ack", workerId: "w1", status: "busy" });
    expect(Worker.get("w1")?.status).toBe("busy");
    expect(Worker.get("w1")?.currentTaskId).toBe("1");
  });
});

describe("keepalive ping", () => {
  it("sends WebSocket ping to connected clients on interval", async () => {
    const tm = new TaskManager();
    setupInMemoryTasks(tm);
    const srv = http.createServer();
    const { wss: testWss } = new ForemanWss({ taskManager: tm, server: srv, config: { ...defaultCfg, pingIntervalMs: 50 } });
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

describe("stale close from old connection", () => {
  it("does not corrupt registry when worker has already reconnected", async () => {
    const wsA = await connect();
    await makeTask(taskManager, 1);
    const qA = makeQueue(wsA);
    send(wsA, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await qA.next(); // hello_ack
    await qA.next(); // task_assigned
    await waitUntil(() => Worker.get("worker-a")?.status === "busy");

    const wsA2 = await connect();
    const qA2 = makeQueue(wsA2);
    send(wsA2, { type: "worker_hello", workerId: "worker-a", taskId: "1", status: "busy" });
    const busyAck = await qA2.next(); // hello_ack busy
    expect(busyAck).toMatchObject({ type: "hello_ack", status: "busy" });

    wsA.close();
    await new Promise<void>((r) => wsA.once("close", r));
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    expect(Worker.get("worker-a")?.status).toBe("busy");
    expect(Worker.get("worker-a")?.currentTaskId).toBe("1");

    wsA2.close();
    await new Promise<void>((r) => wsA2.once("close", r));
  });
});

describe("graceful shutdown", () => {
  it("resolves immediately when no workers are connected", async () => {
    await expect(foremanWss.shutdown()).resolves.toBeUndefined();
  });

  it("closes all connected workers with close code 1001", async () => {
    const ws1 = await connect();
    const ws2 = await connect();
    send(ws1, { type: "worker_hello", workerId: "w1", status: "idle" });
    send(ws2, { type: "worker_hello", workerId: "w2", status: "idle" });
    await waitUntil(() => !!Worker.get("w1") && !!Worker.get("w2"));

    const close1 = new Promise<number>((resolve) => { ws1.once("close", (code) => resolve(code)); });
    const close2 = new Promise<number>((resolve) => { ws2.once("close", (code) => resolve(code)); });

    void foremanWss.shutdown();
    const [code1, code2] = await Promise.all([close1, close2]);
    expect(code1).toBe(1001);
    expect(code2).toBe(1001);
  });

  it("logs worker_disconnected with code 1001 when shutdown closes a registered worker", async () => {
    const logSpy = vi.spyOn(ForemanMessage, "log").mockReturnValue(undefined);
    const srv = http.createServer();
    const localTm = new TaskManager();
    setupInMemoryTasks(localTm);
    const localForemanWss = new ForemanWss({ taskManager: localTm, server: srv, config: defaultCfg });
    const { wss: testWss } = localForemanWss;
    const testPort = await new Promise<number>((r) => srv.listen(0, () => r((srv.address() as AddressInfo).port)));

    const ws = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "worker_hello", workerId: "w-shutdown", status: "idle" }));
    await waitUntil(() => !!Worker.get("w-shutdown"));

    await localForemanWss.shutdown();

    const calls = logSpy.mock.calls;
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
