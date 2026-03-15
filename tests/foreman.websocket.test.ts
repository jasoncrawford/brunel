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
let port: number;
const openClients: WebSocket[] = [];

function connect(): Promise<WebSocket> {
  return connectWorker(port).then((ws) => { openClients.push(ws); return ws; });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  process.env.GITHUB_REPO = "owner/repo";
  process.env.GITHUB_TOKEN = "token";
  process.env.DONE_LABEL = "brunel:done";

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

describe("foreman WebSocket protocol", () => {
  it("idle worker with no tasks receives standby", async () => {
    const ws = await connect();
    const reply = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    expect(await reply).toEqual({ type: "standby" });
    expect(registry.get("w1")?.status).toBe("idle");
  });

  it("idle worker with pending task receives task_assigned", async () => {
    queue.addTask(makeTask(1));
    const ws = await connect();
    const reply = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    const msg = await reply;
    expect(msg.type).toBe("task_assigned");
    expect((msg as any).issue.number).toBe(1);
    expect((msg as any).taskId).toBe("1");
    expect(queue.get("1")?.status).toBe("assigned");
    expect(registry.get("w1")?.status).toBe("busy");
  });

  it("second idle worker gets standby when only task is already assigned", async () => {
    queue.addTask(makeTask(1));
    const ws1 = await connect();
    const ws2 = await connect();
    send(ws1, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws1); // task_assigned
    const reply2 = nextMsg(ws2);
    send(ws2, { type: "worker_hello", workerId: "w2", status: "idle" });
    expect(await reply2).toEqual({ type: "standby" });
  });

  it("task_complete triggers labelIssueDone and assigns next task", async () => {
    queue.addTask(makeTask(1));
    queue.addTask(makeTask(2));
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    const first = await nextMsg(ws);
    expect(first.type).toBe("task_assigned");
    expect((first as any).issue.number).toBe(1);

    const second = nextMsg(ws);
    send(ws, { type: "task_complete", workerId: "w1", taskId: "1" });
    const msg = await second;
    expect(msg.type).toBe("task_assigned");
    expect((msg as any).issue.number).toBe(2);

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/issues/1/labels"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(queue.get("1")?.status).toBe("complete");
  });

  it("task_complete with no further tasks sends standby", async () => {
    queue.addTask(makeTask(1));
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned
    const reply = nextMsg(ws);
    send(ws, { type: "task_complete", workerId: "w1", taskId: "1" });
    expect(await reply).toEqual({ type: "standby" });
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

  it("worker reconnects as busy with unknown taskId gets standby", async () => {
    const ws = await connect();
    const reply = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", taskId: "nonexistent", status: "busy" });
    expect(await reply).toEqual({ type: "standby" });
  });

  it("routeEventToWorker sends event_notification to assigned worker", async () => {
    queue.addTask(makeTask(1));
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned

    const reply = nextMsg(ws);
    routeEvent("evt-1", "issue_comment", { issue: { number: 1 }, comment: { body: "hi" } });
    const msg = await reply;
    expect(msg.type).toBe("event_notification");
    expect((msg as any).taskId).toBe("1");
    expect((msg as any).event.name).toBe("issue_comment");
  });

  it("routeEventToWorker queues event when no worker is assigned", () => {
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
    const reply = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    expect(await reply).toEqual({ type: "standby" });
  });

  it("only the task's original owner can reclaim it on reconnect", async () => {
    queue.addTask(makeTask(1));
    // Worker A gets assigned
    const wsA = await connect();
    send(wsA, { type: "worker_hello", workerId: "worker-a", status: "idle" });
    await nextMsg(wsA); // task_assigned
    await closeClient(wsA);

    // Worker B tries to claim the same taskId — should get standby
    const wsB = await connect();
    const replyB = nextMsg(wsB);
    send(wsB, { type: "worker_hello", workerId: "worker-b", taskId: "1", status: "busy" });
    expect(await replyB).toEqual({ type: "standby" });

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
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Network error"));
    queue.addTask(makeTask(1));
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    await nextMsg(ws); // task_assigned
    const reply = nextMsg(ws);
    send(ws, { type: "task_complete", workerId: "w1", taskId: "1" });
    expect(await reply).toEqual({ type: "standby" });
    expect(queue.get("1")?.status).toBe("complete");
  });

  it("worker reconnects as busy with a completed taskId gets standby", async () => {
    queue.addTask(makeTask(1));
    // Mark task as complete directly (simulates another path completing it while worker was disconnected)
    queue.assignTask("1", "w1");
    queue.completeTask("1");

    const ws = await connect();
    const reply = nextMsg(ws);
    send(ws, { type: "worker_hello", workerId: "w1", taskId: "1", status: "busy" });
    expect(await reply).toEqual({ type: "standby" });
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
  it("worker client connects to foreman and completes handshake", async () => {
    const server = http.createServer();
    const { wss } = createForemanWss(new TaskQueue(), new WorkerRegistry(), server);
    const testPort = await new Promise<number>((resolve) => {
      server.listen(0, () => resolve((server.address() as AddressInfo).port));
    });

    const ws = makeConnectToForeman(testPort);

    const msg = await new Promise<ForemanMessage>((resolve, reject) => {
      ws.on("message", (data) => resolve(JSON.parse(data.toString())));
      ws.on("error", reject);
    });

    expect(msg.type).toBe("standby");

    ws.close();
    await new Promise<void>((resolve) => wss.close(() => server.close(resolve)));
  });

  it("foreman rejects connections not at /worker path (regression guard)", async () => {
    const server = http.createServer();
    const { wss } = createForemanWss(new TaskQueue(), new WorkerRegistry(), server);
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
