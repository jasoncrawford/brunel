import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
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

beforeEach(async () => {
  Worker._reset();
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
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await ackP; // consume hello_ack
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
    expect(Worker.fromRegistry("w1")?.status).toBe("ready");
  });

  it("idle worker with pending task receives task_assigned", async () => {
    await makeTask(taskManager, 1);
    const ws = await connect();
    const q = makeQueue(ws);
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await q.next(); // hello_ack
    const msg = await q.next();
    assert(msg.type === "task_assigned");
    expect(msg.issue.number).toBe(1);
    expect(msg.taskId).toBe("1");
    expect((await Task.get("1"))?.status).toBe("assigned");
    expect(Worker.fromRegistry("w1")?.status).toBe("assigned");
  });

  it("second idle worker gets no message when only task is already assigned", async () => {
    await makeTask(taskManager, 1);
    const ws1 = await connect();
    const ws2 = await connect();
    const q1 = makeQueue(ws1);
    send(ws1, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await q1.next(); // hello_ack
    await q1.next(); // task_assigned
    const ackP2 = nextMsg(ws2);
    send(ws2, { type: "worker_hello", repo: "owner/repo", workerId: "w2", status: "ready" });
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
    send(ws1, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await q1.next(); // hello_ack (no task yet)
    send(ws2, { type: "worker_hello", repo: "owner/repo", workerId: "w2", status: "ready" });
    await q2.next(); // hello_ack (no task yet)

    await makeTask(taskManager, 42);
    await foremanWss.reconcile();

    const w1Status = Worker.fromRegistry("w1")?.status;
    const w2Status = Worker.fromRegistry("w2")?.status;
    const busyCount = [w1Status, w2Status].filter((s) => s === "assigned").length;
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
    send(ws1, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await q1.next(); // hello_ack (no task yet)
    send(ws2, { type: "worker_hello", repo: "owner/repo", workerId: "w2", status: "ready" });
    await q2.next(); // hello_ack (no task yet)

    await makeTask(taskManager, 99);
    await Promise.all([foremanWss.reconcile(), foremanWss.reconcile()]);

    const w1Status = Worker.fromRegistry("w1")?.status;
    const w2Status = Worker.fromRegistry("w2")?.status;
    const busyCount = [w1Status, w2Status].filter((s) => s === "assigned").length;
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
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
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
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsg(ws); // task_assigned
    send(ws, { type: "task_complete", workerId: "w1", taskId: "1" });
    const raceResult = await Promise.race([
      nextMsg(ws).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it("task_complete with stats persists token counts and cost on the task", async () => {
    await makeTask(taskManager, 3001);
    const ws = await connect();
    const q = makeQueue(ws);
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await q.next(); // hello_ack
    await q.next(); // task_assigned

    send(ws, { type: "task_complete", workerId: "w1", taskId: "3001", stats: { inputTokens: 1000, outputTokens: 500, costUsd: 0.05 } });
    await waitUntil(() => Worker.fromRegistry("w1")?.status === "ready");

    const task = await Task.get("3001");
    expect(task?.inputTokens).toBe(1000);
    expect(task?.outputTokens).toBe(500);
    expect(task?.costUsd).toBe(0.05);
  });

  it("worker reconnects as busy and reclaims its own task (no task_assigned sent)", async () => {
    await makeTask(taskManager, 1);
    const ws1 = await connect();
    const q1 = makeQueue(ws1);
    send(ws1, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await q1.next(); // hello_ack
    await q1.next(); // task_assigned
    await closeClient(ws1);

    const ws2 = await connect();
    const ackP = nextMsg(ws2);
    send(ws2, { type: "worker_hello", repo: "owner/repo", workerId: "w1", taskId: "1", status: "assigned" });
    await ackP; // hello_ack (status: busy)
    const raceResult = await Promise.race([
      nextMsg(ws2).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);

    expect(raceResult).toBe("timeout"); // no task_assigned (would reset in-progress session)
    expect(Worker.fromRegistry("w1")?.status).toBe("assigned");
    expect(Worker.fromRegistry("w1")?.currentTaskId).toBe("1");
    expect((await Task.get("1"))?.status).toBe("assigned");
  });

  it("routeEvent sends event_notification to assigned worker", async () => {
    await makeTask(taskManager, 1);
    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsg(ws); // task_assigned

    const reply = nextMsg(ws);
    foremanWss.routeEvent("evt-1", "issue_comment", { issue: { number: 1 }, comment: { body: "hi" }, repository: { full_name: "owner/repo" } });
    const msg = await reply;
    assert(msg.type === "event_notification");
    expect(msg.taskId).toBe("1");
    expect(msg.event.name).toBe("issue_comment");
  });

  it("routeEvent queues event when no worker is assigned", async () => {
    await makeTask(taskManager, 1);
    await foremanWss.routeEvent("evt-1", "issue_comment", { issue: { number: 1 }, repository: { full_name: "owner/repo" } });
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
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
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
    send(wsA, { type: "worker_hello", repo: "owner/repo", workerId: "worker-a", status: "ready" });
    await qA.next(); // hello_ack
    await qA.next(); // task_assigned
    await closeClient(wsA);

    const wsB = await connect();
    const ackPB = nextMsg(wsB);
    send(wsB, { type: "worker_hello", repo: "owner/repo", workerId: "worker-b", taskId: "1", status: "assigned" });
    await ackPB; // hello_ack (status: cancelled — task belongs to A)
    const raceResultB = await Promise.race([
      nextMsg(wsB).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResultB).toBe("timeout");

    const wsA2 = await connect();
    const ackPA2 = nextMsg(wsA2);
    send(wsA2, { type: "worker_hello", repo: "owner/repo", workerId: "worker-a", taskId: "1", status: "assigned" });
    await ackPA2; // hello_ack (status: busy)
    const raceResult2 = await Promise.race([
      nextMsg(wsA2).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult2).toBe("timeout");
    expect(Worker.fromRegistry("worker-a")?.status).toBe("assigned");
  });

  it("task_complete releases worker to idle", async () => {
    await makeTask(taskManager, 1);
    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsg(ws); // task_assigned
    send(ws, { type: "task_complete", workerId: "w1", taskId: "1" });
    await waitUntil(() => Worker.fromRegistry("w1")?.status === "ready");
    expect((await Task.get("1"))?.status).toBe("complete");
  });

  it("worker reconnects as busy with its own completed taskId is allowed to reclaim (finalization)", async () => {
    await makeTask(taskManager, 1);
    const t = await Task.get("1");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    const w1 = Worker.register("w1", fakeWs, fakeRepo());
    await t!.assign(w1);
    w1.remove(); // deregister so waitUntil below detects the real reconnect
    await t!.complete();

    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", taskId: "1", status: "assigned" });
    await waitUntil(() => Worker.fromRegistry("w1") !== undefined);
    expect(Worker.fromRegistry("w1")?.status).toBe("assigned");
    expect(Worker.fromRegistry("w1")?.currentTaskId).toBe("1");
  });

  it("events are routed to the correct worker when multiple workers have different tasks", async () => {
    await makeTask(taskManager, 53);
    await makeTask(taskManager, 55);

    const wsA = await connect();
    const qA = makeQueue(wsA);
    send(wsA, { type: "worker_hello", repo: "owner/repo", workerId: "worker-a", status: "ready" });
    await qA.next(); // hello_ack
    const msgA = await qA.next();
    assert(msgA.type === "task_assigned");
    const taskA = msgA.issue.number;
    expect([53, 55]).toContain(taskA);

    const wsB = await connect();
    const qB = makeQueue(wsB);
    send(wsB, { type: "worker_hello", repo: "owner/repo", workerId: "worker-b", status: "ready" });
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
    foremanWss.routeEvent("evt-1", "issue_comment", { issue: { number: taskA }, comment: { body: "update" }, repository: { full_name: "owner/repo" } });
    expect(await replyA).toMatchObject({ type: "event_notification", taskId: String(taskA) });
    expect(await noMsgB).toBe("timeout");

    const replyB = nextMsg(wsB);
    const noMsgA = Promise.race([
      nextMsg(wsA).then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    foremanWss.routeEvent("evt-2", "issue_comment", { issue: { number: taskB }, comment: { body: "update" }, repository: { full_name: "owner/repo" } });
    expect(await replyB).toMatchObject({ type: "event_notification", taskId: String(taskB) });
    expect(await noMsgA).toBe("timeout");
  });
});

describe("hello_ack handshake", () => {
  it("sends hello_ack with status idle when worker has no task", async () => {
    const ws = await connect();
    const ackPromise = nextMsg(ws);
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    const ack = await ackPromise;
    expect(ack).toMatchObject({ type: "hello_ack", workerId: "w1", status: "ready" });
  });

  it("sends hello_ack with status busy when worker reclaims its own task", async () => {
    await makeTask(taskManager, 1);
    const ws1 = await connect();
    const q1 = makeQueue(ws1);
    send(ws1, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    const first = await q1.next(); // hello_ack
    expect(first.type).toBe("hello_ack");
    await q1.next(); // task_assigned
    await closeClient(ws1);

    const ws2 = await connect();
    const ackPromise = nextMsg(ws2);
    send(ws2, { type: "worker_hello", repo: "owner/repo", workerId: "w1", taskId: "1", status: "assigned" });
    const ack = await ackPromise;
    expect(ack).toMatchObject({ type: "hello_ack", workerId: "w1", status: "assigned" });
  });

  it("sends hello_ack with status cancelled when task was taken by another worker", async () => {
    await makeTask(taskManager, 1);
    const wsA = await connect();
    const qA = makeQueue(wsA);
    send(wsA, { type: "worker_hello", repo: "owner/repo", workerId: "worker-a", status: "ready" });
    await qA.next(); // hello_ack
    await qA.next(); // task_assigned
    await closeClient(wsA);

    const wsB = await connect();
    const ackPromise = nextMsg(wsB);
    send(wsB, { type: "worker_hello", repo: "owner/repo", workerId: "worker-b", taskId: "1", status: "assigned" });
    const ack = await ackPromise;
    expect(ack).toMatchObject({ type: "hello_ack", workerId: "worker-b", status: "cancelled" });
    expect(Worker.fromRegistry("worker-b")?.status).toBe("ready");
  });

  it("worker reconnecting busy with nonexistent taskId receives cancelled status", async () => {
    const ws = await connect();
    const ackPromise = nextMsg(ws);
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", taskId: "nonexistent", status: "assigned" });
    const ack = await ackPromise;
    expect(ack).toMatchObject({ type: "hello_ack", workerId: "w1", status: "cancelled" });
    expect(Worker.fromRegistry("w1")?.status).toBe("ready");
  });

  it("allows worker to reclaim task even if complete (issue closed, same worker)", async () => {
    await makeTask(taskManager, 1);
    const t = await Task.get("1");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs, fakeRepo()));
    await t!.complete();

    const ws = await connect();
    const ackPromise = nextMsg(ws);
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", taskId: "1", status: "assigned" });
    const ack = await ackPromise;
    expect(ack).toMatchObject({ type: "hello_ack", workerId: "w1", status: "assigned" });
    expect(Worker.fromRegistry("w1")?.status).toBe("assigned");
    expect(Worker.fromRegistry("w1")?.currentTaskId).toBe("1");
  });

  it("cancels worker when task is assigned to a different worker", async () => {
    await makeTask(taskManager, 1);
    const t = await Task.get("1");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs, fakeRepo()));
    await t!.assign(Worker.register("w2", fakeWs, fakeRepo()));

    const ws = await connect();
    const ackPromise = nextMsg(ws);
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", taskId: "1", status: "assigned" });
    const ack = await ackPromise;
    expect(ack).toMatchObject({ type: "hello_ack", workerId: "w1", status: "cancelled" });
    expect(Worker.fromRegistry("w1")?.status).toBe("ready");
  });

  it("queued events are sent after hello_ack on reclaim", async () => {
    await makeTask(taskManager, 1);
    const t = await Task.get("1");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    { const w = Worker.register("w1", fakeWs, fakeRepo()); await t!.assign(w); w.assign(t!); w.markDisconnected(); }
    await foremanWss.routeEvent("evt-1", "issue_comment", { issue: { number: 1 }, repository: { full_name: "owner/repo" } });

    const ws = await connect();
    const messages: Wire.ForemanMessage[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", taskId: "1", status: "assigned" });
    await waitUntil(() => messages.length >= 2);
    expect(messages[0]).toMatchObject({ type: "hello_ack", status: "assigned" });
    expect(messages[1]).toMatchObject({ type: "event_notification" });
  });

  it("ignores task_complete from a worker that does not own the task", async () => {
    await makeTask(taskManager, 1);
    const wsA = await connect();
    const qA = makeQueue(wsA);
    send(wsA, { type: "worker_hello", repo: "owner/repo", workerId: "worker-a", status: "ready" });
    await qA.next(); // hello_ack
    await qA.next(); // task_assigned

    const wsB = await connect();
    send(wsB, { type: "worker_hello", repo: "owner/repo", workerId: "worker-b", status: "ready" });
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
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
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
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
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
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await ackP; // hello_ack (no task yet — task is blocked)

    const reply = nextMsg(ws);
    foremanWss.routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 10, title: "Blocker", body: "", labels: [] },
      repository: { full_name: "owner/repo" },
    });
    expect(await reply).toMatchObject({ type: "task_assigned", taskId: "42" });
  });

  it("issues/reopened re-blocks subsequent task assignments", async () => {
    await makeTask(taskManager, 43);
    taskManager.setBlockers(43, [10]);

    foremanWss.routeEvent("evt-1", "issues", {
      action: "reopened",
      issue: { number: 10, title: "Blocker", body: "", labels: [] },
      repository: { full_name: "owner/repo" },
    });

    const ws = await connect();
    const ackP = nextMsg(ws);
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
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
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await q.next(); // hello_ack
    const msg = await q.next();
    expect(msg.type).toBe("task_assigned");
    if (msg.type === "task_assigned") expect(msg.issue.number).toBe(2);
  });
});

describe("worker secret enforcement", () => {
  async function makeSecretServer(secret: string): Promise<{ server: http.Server; secretWss: WebSocketServer; port: number }> {
    const server = http.createServer();
    const tm = await createTestTaskManager();
    const { wss: secretWss } = new ForemanWss({ server, config: { ...defaultCfg, workerSecret: secret } });
    const p = await new Promise<number>((r) => server.listen(0, () => r((server.address() as AddressInfo).port)));
    return { server, secretWss, port: p };
  }

  it("rejects worker_hello with wrong secret when workerSecret is configured", async () => {
    const { server, secretWss, port } = await makeSecretServer("correct-secret");
    try {
      const ws = await connectWorker(port);
      send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready", workerSecret: "wrong" });
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
      send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready", workerSecret: "correct-secret" });
      await new Promise((r) => setTimeout(r, 20));
      ws.close();
    } finally {
      await new Promise<void>((r) => secretWss.close(() => server.close(r)));
    }
  });

  it("accepts any worker when workerSecret is not configured", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await waitUntil(() => Worker.fromRegistry("w1")?.status === "ready");
    expect(Worker.fromRegistry("w1")?.status).toBe("ready");
  });
});

describe("worker_hello — repo validation", () => {
  it("sends fatal foreman_error and does not register worker when repo field is missing", async () => {
    const ws = await connect();
    const q = makeQueue(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "ready" } as any);
    const msg = await q.next();
    expect(msg.type).toBe("foreman_error");
    assert(msg.type === "foreman_error");
    expect(msg.fatal).toBe(true);
    // Worker must not be registered — no repo means the foreman rejected the hello.
    expect(Worker.fromRegistry("w1")).toBeUndefined();
  });
});

describe("worker WebSocket connection", () => {
  it("worker client connects to foreman successfully", async () => {
    const server = http.createServer();
    const tm = await createTestTaskManager();
    const { wss } = new ForemanWss({ server, config: defaultCfg });
    const testPort = await new Promise<number>((resolve) => {
      server.listen(0, () => resolve((server.address() as AddressInfo).port));
    });

    const ws = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });

    const ackP = new Promise<void>((r) => ws.once("message", () => r()));
    ws.send(JSON.stringify({ type: "worker_hello", repo: "owner/repo", workerId: "test-worker-id", status: "ready" }));
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
    const tm = await createTestTaskManager();
    const { wss } = new ForemanWss({ server, config: defaultCfg });
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
    const localTm = await createTestTaskManager();
    const { wss: testWss } = new ForemanWss({ server, config: defaultCfg });
    const testPort = await new Promise<number>((r) => server.listen(0, () => r((server.address() as AddressInfo).port)));

    const ws = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "worker_hello", repo: "owner/repo", workerId: "w-disc-1", status: "ready" }));
    await waitUntil(() => !!Worker.fromRegistry("w-disc-1"));

    await new Promise<void>((resolve) => {
      ws.once("close", resolve);
      ws.close();
    });
    await waitUntil(() => !Worker.fromRegistry("w-disc-1") || Worker.fromRegistry("w-disc-1")?.status === "disconnected");

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

    await Task.upsert("42", 42, "owner/repo", "Some task", "Body", []);
    taskManager.trackIssue(42);
    taskManager.markBlockersLoaded(42);

    const server = http.createServer();
    const { wss: testWss } = new ForemanWss({ server, config: defaultCfg });
    const testPort = await new Promise<number>((r) => server.listen(0, () => r((server.address() as AddressInfo).port)));

    const ws = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "worker_hello", repo: "owner/repo", workerId: "w-disc-2", status: "ready" }));
    // Wait for task_assigned reply (after hello_ack)
    await new Promise<void>((resolve) => {
      let count = 0;
      ws.on("message", () => { count++; if (count >= 2) resolve(); });
    });

    await new Promise<void>((resolve) => {
      ws.once("close", resolve);
      ws.close();
    });
    await waitUntil(() => Worker.fromRegistry("w-disc-2")?.status === "disconnected");

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
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsg(ws); // task_assigned

    await closeClient(ws);
    await waitUntil(() => Worker.fromRegistry("w1")?.status === "disconnected");

    const entry = Worker.fromRegistry("w1");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("disconnected");
    expect(entry!.currentTaskId).toBe("1");
    expect((await Task.get("1"))?.status).toBe("assigned");
  });

  it("idle worker is removed from registry on close", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await waitUntil(() => !!Worker.fromRegistry("w1"));

    await closeClient(ws);
    await waitUntil(() => !Worker.fromRegistry("w1"));

    expect(Worker.fromRegistry("w1")).toBeUndefined();
  });

  it("events are queued (not dropped) when assigned worker is disconnected", async () => {
    await makeTask(taskManager, 1);
    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsg(ws); // task_assigned

    await closeClient(ws);
    await waitUntil(() => Worker.fromRegistry("w1")?.status === "disconnected");

    await foremanWss.routeEvent("evt-1", "issue_comment", { issue: { number: 1 }, comment: { body: "hi" }, repository: { full_name: "owner/repo" } });

    const t = await Task.get("1");
    const queued = taskManager.drainEvents(t!);
    expect(queued).toHaveLength(1);
    expect(queued[0].eventName).toBe("issue_comment");
  });

  it("reconnecting worker (busy) from disconnected state drains queued events", async () => {
    await makeTask(taskManager, 1);
    const ws1 = await connect();
    send(ws1, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsg(ws1); // hello_ack (task is assigned server-side regardless)

    await closeClient(ws1);
    await waitUntil(() => Worker.fromRegistry("w1")?.status === "disconnected");

    await foremanWss.routeEvent("evt-1", "issue_comment", { issue: { number: 1 }, comment: { body: "hi" }, repository: { full_name: "owner/repo" } });

    const ws2 = await connect();
    const q2 = makeQueue(ws2);
    send(ws2, { type: "worker_hello", repo: "owner/repo", workerId: "w1", taskId: "1", status: "assigned" });
    await q2.next(); // hello_ack (status: busy)
    const msg = await q2.next();
    expect(msg.type).toBe("event_notification");
    if (msg.type === "event_notification") {
      expect(msg.taskId).toBe("1");
      expect(msg.event.name).toBe("issue_comment");
    }

    expect(Worker.fromRegistry("w1")?.status).toBe("assigned");
    expect((await Task.get("1"))?.status).toBe("assigned");
  });

  it("reconnecting worker (idle) from disconnected state reverts task to pending", async () => {
    await makeTask(taskManager, 1);
    const ws1 = await connect();
    send(ws1, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsg(ws1); // hello_ack (task is assigned server-side regardless)

    await closeClient(ws1);
    await waitUntil(() => Worker.fromRegistry("w1")?.status === "disconnected");

    const ws2 = await connect();
    const q2 = makeQueue(ws2);
    send(ws2, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await q2.next(); // hello_ack
    const msg = await q2.next();
    expect(msg.type).toBe("task_assigned");
    if (msg.type === "task_assigned") expect(msg.taskId).toBe("1");

    expect(Worker.fromRegistry("w1")?.status).toBe("assigned");
    expect((await Task.get("1"))?.status).toBe("assigned");
    expect((await Task.get("1"))?.workerId).toBe("w1");
  });

  it("a different idle worker can pick up the reverted task when disconnected worker reconnects as idle", async () => {
    await makeTask(taskManager, 1);

    const wsA = await connect();
    send(wsA, { type: "worker_hello", repo: "owner/repo", workerId: "worker-a", status: "ready" });
    await nextMsg(wsA); // hello_ack (task is assigned server-side regardless)

    await closeClient(wsA);
    await waitUntil(() => Worker.fromRegistry("worker-a")?.status === "disconnected");

    const wsB = await connect();
    const ackPB = nextMsg(wsB);
    send(wsB, { type: "worker_hello", repo: "owner/repo", workerId: "worker-b", status: "ready" });
    await ackPB; // hello_ack (no task available yet — assigned to disconnected worker-a)

    const wsA2 = await connect();
    const qA2 = makeQueue(wsA2);
    send(wsA2, { type: "worker_hello", repo: "owner/repo", workerId: "worker-a", status: "ready" });
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
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsg(ws); // task_assigned

    send(ws, { type: "worker_goodbye", workerId: "w1", taskId: "1" });
    await waitUntil(() => !Worker.fromRegistry("w1"));

    expect(Worker.fromRegistry("w1")).toBeUndefined();
    expect((await Task.get("1"))?.status).toBe("pending");
  });

  it("removes idle worker from registry when goodbye has no taskId", async () => {
    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await waitUntil(() => !!Worker.fromRegistry("w1"));

    send(ws, { type: "worker_goodbye", workerId: "w1" });
    await waitUntil(() => !Worker.fromRegistry("w1"));

    expect(Worker.fromRegistry("w1")).toBeUndefined();
  });

  it("reverted task is immediately assigned to a waiting idle worker", async () => {
    await makeTask(taskManager, 1);

    const wsA = await connect();
    const qA = makeQueue(wsA);
    send(wsA, { type: "worker_hello", repo: "owner/repo", workerId: "worker-a", status: "ready" });
    await qA.next(); // hello_ack
    await qA.next(); // task_assigned

    const wsB = await connect();
    const ackPB = nextMsg(wsB);
    send(wsB, { type: "worker_hello", repo: "owner/repo", workerId: "worker-b", status: "ready" });
    await ackPB; // hello_ack (no task — still assigned to worker-a)

    const replyB = nextMsg(wsB);
    send(wsA, { type: "worker_goodbye", workerId: "worker-a", taskId: "1" });
    const msg = await replyB;
    expect(msg.type).toBe("task_assigned");
    if (msg.type === "task_assigned") expect(msg.taskId).toBe("1");

    expect(Worker.fromRegistry("worker-a")).toBeUndefined();
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
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await waitUntil(() => Worker.fromRegistry("w1")?.status === "assigned");

    send(ws, { type: "worker_goodbye", workerId: "w1", taskId: "1" });
    await waitUntil(() => Worker.fromRegistry("w1") === undefined);

    expect(spyRevert).toHaveBeenCalled();
  });

  it("does not call task.revert when goodbye has no taskId", async () => {
    const spyGet = vi.spyOn(Task, "get");

    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await waitUntil(() => Worker.fromRegistry("w1") !== undefined);

    send(ws, { type: "worker_goodbye", workerId: "w1" });
    await waitUntil(() => Worker.fromRegistry("w1") === undefined);

    // Task.get should not be called for goodbye without taskId
    expect(spyGet).not.toHaveBeenCalled();
  });
});

describe("worker_goodbye with task_complete: true", () => {
  it("marks the task complete instead of reverting it to pending", async () => {
    await makeTask(taskManager, 1);
    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsg(ws); // task_assigned

    send(ws, { type: "worker_goodbye", workerId: "w1", taskId: "1", task_complete: true });
    await waitUntil(() => !Worker.fromRegistry("w1"));

    expect(Worker.fromRegistry("w1")).toBeUndefined();
    expect((await Task.get("1"))?.status).toBe("complete");
  });

  it("persists stats when task_complete: true with stats provided", async () => {
    await makeTask(taskManager, 1);
    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await nextMsg(ws); // task_assigned

    send(ws, { type: "worker_goodbye", workerId: "w1", taskId: "1", task_complete: true, stats: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 } });
    await waitUntil(() => !Worker.fromRegistry("w1"));

    const task = await Task.get("1");
    expect(task?.status).toBe("complete");
    expect(task?.inputTokens).toBe(100);
    expect(task?.outputTokens).toBe(50);
    expect(task?.costUsd).toBe(0.01);
  });

  it("does not assign a new task to the completing worker (never enters idle pool)", async () => {
    await makeTask(taskManager, 1001);
    await new Promise(r => setTimeout(r, 10));
    await makeTask(taskManager, 1002);

    const ws = await connect();
    const q = makeQueue(ws);
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await q.next(); // hello_ack
    await q.next(); // task_assigned (task 1002, most recent)

    send(ws, { type: "worker_goodbye", workerId: "w1", taskId: "1002", task_complete: true });
    // Give assignWork() time to run — worker should NOT get a second task_assigned
    const raceResult = await Promise.race([
      q.next().then(() => "message" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 100)),
    ]);
    expect(raceResult).toBe("timeout");
    expect(Worker.fromRegistry("w1")).toBeUndefined();
  });

  it("calls task.complete when goodbye carries task_complete: true", async () => {
    await makeTask(taskManager, 1);
    const t = await Task.get("1");
    const spyComplete = vi.spyOn(t!, "complete");
    vi.spyOn(Task, "get").mockImplementation(async (id) => {
      if (id === "1") return t!;
      return null;
    });

    const ws = await connect();
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    await waitUntil(() => Worker.fromRegistry("w1")?.status === "assigned");

    send(ws, { type: "worker_goodbye", workerId: "w1", taskId: "1", task_complete: true });
    await waitUntil(() => Worker.fromRegistry("w1") === undefined);

    expect(spyComplete).toHaveBeenCalled();
  });
});

describe("issues/closed — close persistence", () => {
  it("calls task.close when an issue is closed while a worker is active", async () => {
    await Task.upsert("1", 1, "test/repo", "T", "b", []);
    const t = await Task.get("1");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs, fakeRepo()));
    const spyClose = vi.spyOn(t!, "close");
    vi.spyOn(Task, "getByRepoIssue").mockResolvedValue(t!);

    taskManager.trackIssue(1);
    taskManager.markBlockersLoaded(1);

    await foremanWss.routeEvent("evt-1", "issues", { action: "closed", issue: { number: 1, title: "T", body: "", labels: [] }, repository: { full_name: "owner/repo" } });

    await waitUntil(() => spyClose.mock.calls.length > 0);
    expect(spyClose).toHaveBeenCalled();
  });
});

describe("worker_hello — reclaim complete task for finalization work", () => {
  it("allows worker to reclaim complete task", async () => {
    await Task.upsert("1", 1, "owner/repo", "T", "b", []);
    const t = await Task.get("1");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs, fakeRepo()));
    await t!.complete();

    const ws = await connect();
    const ackPromise = nextMsg(ws);
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", taskId: "1", status: "assigned" });
    const ack = await ackPromise;
    expect(ack).toMatchObject({ type: "hello_ack", workerId: "w1", status: "assigned" });
    expect(Worker.fromRegistry("w1")?.status).toBe("assigned");
    expect(Worker.fromRegistry("w1")?.currentTaskId).toBe("1");
  });
});

describe("keepalive ping", () => {
  it("sends WebSocket ping to connected clients on interval", async () => {
    const tm = await createTestTaskManager();
    const srv = http.createServer();
    const { wss: testWss } = new ForemanWss({ server: srv, config: { ...defaultCfg, pingIntervalMs: 50 } });
    await new Promise<void>((resolve) => srv.listen(0, resolve));
    const testPort = (srv.address() as AddressInfo).port;

    const ws = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    send(ws, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });

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
    send(wsA, { type: "worker_hello", repo: "owner/repo", workerId: "worker-a", status: "ready" });
    await qA.next(); // hello_ack
    await qA.next(); // task_assigned
    await waitUntil(() => Worker.fromRegistry("worker-a")?.status === "assigned");

    const wsA2 = await connect();
    const qA2 = makeQueue(wsA2);
    send(wsA2, { type: "worker_hello", repo: "owner/repo", workerId: "worker-a", taskId: "1", status: "assigned" });
    const busyAck = await qA2.next(); // hello_ack busy
    expect(busyAck).toMatchObject({ type: "hello_ack", status: "assigned" });

    wsA.close();
    await new Promise<void>((r) => wsA.once("close", r));
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    expect(Worker.fromRegistry("worker-a")?.status).toBe("assigned");
    expect(Worker.fromRegistry("worker-a")?.currentTaskId).toBe("1");

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
    send(ws1, { type: "worker_hello", repo: "owner/repo", workerId: "w1", status: "ready" });
    send(ws2, { type: "worker_hello", repo: "owner/repo", workerId: "w2", status: "ready" });
    await waitUntil(() => !!Worker.fromRegistry("w1") && !!Worker.fromRegistry("w2"));

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
    const localTm = await createTestTaskManager();
    const localForemanWss = new ForemanWss({ server: srv, config: defaultCfg });
    const { wss: testWss } = localForemanWss;
    const testPort = await new Promise<number>((r) => srv.listen(0, () => r((srv.address() as AddressInfo).port)));

    const ws = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "worker_hello", repo: "owner/repo", workerId: "w-shutdown", status: "ready" }));
    await waitUntil(() => !!Worker.fromRegistry("w-shutdown"));

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

  it("terminates zombie connections that stop responding to pings", async () => {
    // Use a very short ping interval so the test runs quickly.
    const srv = http.createServer();
    const localForemanWss = new ForemanWss({
      server: srv,
      config: { ...defaultCfg, pingIntervalMs: 50 },
    });
    const testPort = await new Promise<number>((r) => srv.listen(0, () => r((srv.address() as AddressInfo).port)));

    // The ws library always auto-pongs when it receives a PING frame, so we can't
    // use a ws.WebSocket client here — it would keep the connection alive. Instead,
    // open a raw TCP socket that completes the WebSocket handshake but never sends
    // pong frames, simulating a zombie (silently-dead) connection.
    const { createConnection } = await import("net");
    const { randomBytes } = await import("crypto");
    const rawSocket = createConnection(testPort, "127.0.0.1");
    rawSocket.on("error", () => {}); // suppress ECONNRESET on terminate()

    await new Promise<void>((r) => rawSocket.once("connect", r));
    const wsKey = randomBytes(16).toString("base64");
    rawSocket.write(
      `GET /worker HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    // Wait for the 101 Switching Protocols response so the server-side ws is live.
    await new Promise<void>((r) => rawSocket.once("data", () => r()));

    // The foreman should terminate the zombie after two ping intervals:
    // first tick → marks isAlive=false and sends ping; second tick → no pong → terminate().
    const closed = new Promise<void>((r) => rawSocket.once("close", r));
    await closed;

    await new Promise<void>((r) => localForemanWss.wss.close(() => srv.close(r)));
  }, 2000);

  it("keeps connections alive when pongs are received", async () => {
    // Use a short ping interval; the ws library auto-pong keeps the connection alive.
    const srv = http.createServer();
    const localForemanWss = new ForemanWss({
      server: srv,
      config: { ...defaultCfg, pingIntervalMs: 30 },
    });
    const testPort = await new Promise<number>((r) => srv.listen(0, () => r((srv.address() as AddressInfo).port)));

    const liveWs = new WebSocket(`ws://localhost:${testPort}/worker`);
    await new Promise<void>((resolve, reject) => { liveWs.once("open", resolve); liveWs.once("error", reject); });

    // Let several ping intervals pass while the ws library auto-pongs.
    await new Promise<void>((r) => setTimeout(r, 150));

    // Connection should still be open.
    expect(liveWs.readyState).toBe(WebSocket.OPEN);

    liveWs.close();
    await new Promise<void>((r) => liveWs.once("close", r));
    await new Promise<void>((r) => localForemanWss.wss.close(() => srv.close(r)));
  });
});
