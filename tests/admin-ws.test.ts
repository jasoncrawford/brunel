import { describe, it, expect, afterEach, beforeEach } from "vitest";
import http from "http";
import net from "net";
import { WebSocket } from "ws";
import type { AddressInfo } from "net";
import { AdminWss } from "../src/foreman/servers/admin-ws.js";
import type { AdminMessage, LogEntry } from "../shared/wire.js";
import { TaskManager } from "../src/foreman/models/task-manager.js";
import { Worker } from "../src/foreman/models/worker.js";
import { Repo } from "../src/foreman/models/repo.js";
import { Task } from "../src/foreman/models/task.js";
import { resetDb, createTestTaskManager } from "./helpers/task.js";

function startServer(): Promise<{ server: http.Server; port: number; adminWss: AdminWss }> {
  return new Promise((resolve) => {
    const server = http.createServer();
    const adminWss = new AdminWss(server);
    server.listen(0, () => {
      resolve({ server, port: (server.address() as AddressInfo).port, adminWss });
    });
  });
}

/**
 * Opens an admin WebSocket and buffers all messages from the start (before "open"
 * fires) so early arrivals like the initial snapshot+log are never lost.
 */
function openAdmin(port: number): Promise<{ ws: WebSocket; recv: () => Promise<AdminMessage> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/admin/ws`);
    const queue: AdminMessage[] = [];
    const waiting: Array<(msg: AdminMessage) => void> = [];

    ws.on("message", (d) => {
      const msg = JSON.parse(d.toString()) as AdminMessage;
      if (waiting.length > 0) waiting.shift()!(msg);
      else queue.push(msg);
    });

    function recv(): Promise<AdminMessage> {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      return new Promise((r) => waiting.push(r));
    }

    ws.once("open", () => resolve({ ws, recv }));
    ws.once("error", reject);
  });
}

function closeAll(...ws: WebSocket[]): Promise<void> {
  return Promise.all(ws.map((w) => new Promise<void>((r) => {
    if (w.readyState === WebSocket.CLOSED) { r(); return; }
    w.once("close", r);
    w.close();
  }))).then(() => {});
}

/** Polls until predicate returns true, yielding to the event loop. */
async function waitUntil(pred: () => boolean): Promise<void> {
  while (!pred()) await new Promise((r) => setImmediate(r));
}

const sampleEntry: LogEntry = {
  kind: "webhook", id: 1, timestamp: "2026-01-01T00:00:00Z",
  taskId: null, workerId: null, summary: "issues/labeled #1",
};

describe("AdminWss", () => {
  const servers: http.Server[] = [];

  beforeEach(() => {
    resetDb();
    Worker._reset();
  });

  afterEach(() => {
    const s = servers.splice(0);
    return Promise.all(s.map((srv) => new Promise<void>((r) => srv.close(() => r()))));
  });

  it("sends snapshot and initial_log to a newly connected client", async () => {
    const { server, port } = await startServer();
    servers.push(server);
    const { ws, recv } = await openAdmin(port);
    const first = await recv();
    const second = await recv();
    expect(first.type).toBe("snapshot");
    expect(second.type).toBe("initial_log");
    await closeAll(ws);
  });

  it("snapshot sent on connection includes tasks, workers, and repos", async () => {
    await createTestTaskManager("owner/repo");
    const repo = await Repo.findOrCreate("owner/repo");
    await repo.activate();
    await Task.upsert("1", 1, "owner/repo", "Fix bug", "", []);
    const fakeWs = { send: () => {}, readyState: 1, on: () => {}, once: () => {} } as unknown as WebSocket;
    Worker.register("w1", fakeWs as unknown as import("ws").WebSocket, repo);

    const { server, port } = await startServer();
    servers.push(server);
    const { ws, recv } = await openAdmin(port);
    const msg = await recv();
    expect(msg.type).toBe("snapshot");
    if (msg.type === "snapshot") {
      expect(msg.tasks.length).toBeGreaterThan(0);
      expect(msg.workers.length).toBeGreaterThan(0);
      expect(msg.repos.length).toBeGreaterThan(0);
    }
    await closeAll(ws);
    Worker._reset();
  });

  it("broadcasts log_event to connected clients", async () => {
    const { server, port, adminWss } = await startServer();
    servers.push(server);
    const { ws, recv } = await openAdmin(port);
    await recv(); // snapshot
    await recv(); // initial_log
    const logP = new Promise<AdminMessage>((r) => {
      function handler(d: Buffer | string) {
        const msg = JSON.parse(d.toString()) as AdminMessage;
        if (msg.type === "log_event") { ws.off("message", handler); r(msg); }
      }
      ws.on("message", handler);
    });
    adminWss.broadcastLogEvent(sampleEntry);
    const msg = await logP;
    expect(msg).toEqual({ type: "log_event", entry: sampleEntry });
    await closeAll(ws);
  });

  it("broadcasts log_event to multiple connected clients", async () => {
    const { server, port, adminWss } = await startServer();
    servers.push(server);
    const [c1, c2] = await Promise.all([openAdmin(port), openAdmin(port)]);
    // drain initial messages for both
    await Promise.all([c1.recv(), c1.recv(), c2.recv(), c2.recv()]);
    const makeLogP = (c: typeof c1) => new Promise<AdminMessage>((r) => {
      function handler(d: Buffer | string) {
        const msg = JSON.parse(d.toString()) as AdminMessage;
        if (msg.type === "log_event") { c.ws.off("message", handler); r(msg); }
      }
      c.ws.on("message", handler);
    });
    const [p1, p2] = [makeLogP(c1), makeLogP(c2)];
    adminWss.broadcastLogEvent(sampleEntry);
    const [m1, m2] = await Promise.all([p1, p2]);
    expect(m1.type).toBe("log_event");
    expect(m2.type).toBe("log_event");
    await closeAll(c1.ws, c2.ws);
  });

  it("sends initial_log with empty entries when no events have been broadcast", async () => {
    const { server, port } = await startServer();
    servers.push(server);
    const { ws, recv } = await openAdmin(port);
    await recv(); // snapshot
    const msg = await recv(); // initial_log
    expect(msg).toEqual({ type: "initial_log", entries: [] });
    await closeAll(ws);
  });

  it("sends initial_log with recently broadcast events to a newly connected client", async () => {
    const { server, port, adminWss } = await startServer();
    servers.push(server);
    adminWss.broadcastLogEvent(sampleEntry);
    const { ws, recv } = await openAdmin(port);
    await recv(); // snapshot
    const msg = await recv(); // initial_log
    expect(msg).toEqual({ type: "initial_log", entries: [sampleEntry] });
    await closeAll(ws);
  });

  it("initial_log buffer is capped at 30 entries (newest first)", async () => {
    const { server, port, adminWss } = await startServer();
    servers.push(server);
    for (let i = 1; i <= 35; i++) {
      adminWss.broadcastLogEvent({ kind: "webhook", id: i, timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`, taskId: null, workerId: null, summary: `event ${i}` });
    }
    const { ws, recv } = await openAdmin(port);
    await recv(); // snapshot
    const msg = await recv(); // initial_log
    if (msg.type !== "initial_log") throw new Error("expected initial_log");
    expect(msg.entries).toHaveLength(30);
    expect(msg.entries[0].id).toBe(35);
    expect(msg.entries[29].id).toBe(6);
    await closeAll(ws);
  });

  it("snapshot always sent before initial_log on connection", async () => {
    const { server, port } = await startServer();
    servers.push(server);
    const { ws, recv } = await openAdmin(port);
    const first = await recv();
    const second = await recv();
    expect(first.type).toBe("snapshot");
    expect(second.type).toBe("initial_log");
    await closeAll(ws);
  });

  it("broadcasts snapshot when TaskManager events fire", async () => {
    const { server, port } = await startServer();
    servers.push(server);
    const { ws, recv } = await openAdmin(port);
    await recv(); // snapshot
    await recv(); // initial_log

    const snapshotP = new Promise<AdminMessage>((r) => {
      function handler(d: Buffer | string) {
        const msg = JSON.parse(d.toString()) as AdminMessage;
        if (msg.type === "snapshot") { ws.off("message", handler); r(msg); }
      }
      ws.on("message", handler);
    });
    await Task.upsert("99", 99, "owner/repo", "Event-triggered", "", []);
    const msg = await snapshotP;
    expect(msg.type).toBe("snapshot");
    await closeAll(ws);
  });

  it("broadcasts snapshot when Worker events fire", async () => {
    const { server, port } = await startServer();
    servers.push(server);
    const { ws, recv } = await openAdmin(port);
    await recv(); // snapshot
    await recv(); // initial_log

    const snapshotP = new Promise<AdminMessage>((r) => {
      function handler(d: Buffer | string) {
        const msg = JSON.parse(d.toString()) as AdminMessage;
        if (msg.type === "snapshot") { ws.off("message", handler); r(msg); }
      }
      ws.on("message", handler);
    });
    Worker.events.emit("changed");
    const msg = await snapshotP;
    expect(msg.type).toBe("snapshot");
    await closeAll(ws);
  });

  it("broadcasts snapshot when Repo events fire", async () => {
    const { server, port } = await startServer();
    servers.push(server);
    const { ws, recv } = await openAdmin(port);
    await recv(); // snapshot
    await recv(); // initial_log

    const snapshotP = new Promise<AdminMessage>((r) => {
      function handler(d: Buffer | string) {
        const msg = JSON.parse(d.toString()) as AdminMessage;
        if (msg.type === "snapshot") { ws.off("message", handler); r(msg); }
      }
      ws.on("message", handler);
    });
    Repo.events.emit("changed");
    const msg = await snapshotP;
    expect(msg.type).toBe("snapshot");
    await closeAll(ws);
  });

  it("debounces burst changes into a single snapshot broadcast", async () => {
    const { server, port } = await startServer();
    servers.push(server);
    const { ws, recv } = await openAdmin(port);
    await recv(); // snapshot
    await recv(); // initial_log

    const snapshots: AdminMessage[] = [];
    ws.on("message", (d) => {
      const msg = JSON.parse(d.toString()) as AdminMessage;
      if (msg.type === "snapshot") snapshots.push(msg);
    });

    for (let i = 0; i < 5; i++) TaskManager.events.emit("changed");

    await waitUntil(() => snapshots.length > 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(snapshots.length).toBe(1);
    await closeAll(ws);
  });

  it("ignores requests to /worker path (does not hijack worker upgrade)", async () => {
    const { server, port } = await startServer();
    const upgradeSockets: net.Socket[] = [];
    server.once("upgrade", (_req, socket) => { upgradeSockets.push(socket); });

    const ws = new WebSocket(`ws://localhost:${port}/worker`);
    await Promise.race([
      new Promise<void>((r) => ws.once("error", r)),
      new Promise<void>((r) => setTimeout(r, 50)),
    ]);
    expect(ws.readyState).not.toBe(WebSocket.OPEN);

    for (const s of upgradeSockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });
});
