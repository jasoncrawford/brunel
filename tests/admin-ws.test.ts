import { describe, it, expect, afterEach } from "vitest";
import http from "http";
import net from "net";
import { WebSocket } from "ws";
import type { AddressInfo } from "net";
import { createAdminWss } from "../src/foreman/controllers/admin-ws.js";
import type { AdminMessage, LogEntry, AdminSnapshot } from "../shared/wire.js";

function startServer(): Promise<{ server: http.Server; port: number; adminWss: ReturnType<typeof createAdminWss> }> {
  return new Promise((resolve) => {
    const server = http.createServer();
    const adminWss = createAdminWss(server);
    server.listen(0, () => {
      resolve({ server, port: (server.address() as AddressInfo).port, adminWss });
    });
  });
}

function startServerWithSnapshot(getSnapshot: () => AdminSnapshot): Promise<{ server: http.Server; port: number; adminWss: ReturnType<typeof createAdminWss> }> {
  return new Promise((resolve) => {
    const server = http.createServer();
    const adminWss = createAdminWss(server, getSnapshot);
    server.listen(0, () => {
      resolve({ server, port: (server.address() as AddressInfo).port, adminWss });
    });
  });
}

function connectAdmin(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/admin/ws`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMsg(ws: WebSocket): Promise<AdminMessage> {
  return new Promise((resolve) => {
    ws.once("message", (d) => resolve(JSON.parse(d.toString())));
  });
}

/** Collects all messages until one matching `type` is found, then resolves with it.
 *  Must be registered BEFORE the connection opens to avoid missing early messages. */
function waitForMsgType<T extends AdminMessage["type"]>(ws: WebSocket, type: T): Promise<Extract<AdminMessage, { type: T }>> {
  return new Promise((resolve) => {
    function handler(d: Buffer | string) {
      const msg = JSON.parse(d.toString()) as AdminMessage;
      if (msg.type === type) {
        ws.off("message", handler);
        resolve(msg as Extract<AdminMessage, { type: T }>);
      }
    }
    ws.on("message", handler);
  });
}

/** Collects the first N messages.
 *  Must be registered BEFORE the connection opens to avoid missing early messages. */
function collectFirstN(ws: WebSocket, n: number): Promise<AdminMessage[]> {
  return new Promise((resolve) => {
    const msgs: AdminMessage[] = [];
    function handler(d: Buffer | string) {
      msgs.push(JSON.parse(d.toString()) as AdminMessage);
      if (msgs.length >= n) {
        ws.off("message", handler);
        resolve(msgs);
      }
    }
    ws.on("message", handler);
  });
}

function closeAll(...ws: WebSocket[]): Promise<void> {
  return Promise.all(ws.map((w) => new Promise<void>((r) => {
    if (w.readyState === WebSocket.CLOSED) { r(); return; }
    w.once("close", r);
    w.close();
  }))).then(() => {});
}

const sampleEntry: LogEntry = {
  kind: "webhook", id: 1, timestamp: "2026-01-01T00:00:00Z",
  taskId: null, workerId: null, summary: "issues/labeled #1",
};

describe("createAdminWss", () => {
  const servers: http.Server[] = [];
  afterEach(() => {
    const s = servers.splice(0);
    return Promise.all(s.map((srv) => new Promise<void>((r) => srv.close(() => r()))));
  });

  it("broadcasts snapshot to connected clients", async () => {
    const { server, port, adminWss } = await startServer();
    servers.push(server);
    const ws = await connectAdmin(port);
    const msgP = waitForMsgType(ws, "snapshot");
    adminWss.broadcastSnapshot({ tasks: [], workers: [] });
    const msg = await msgP;
    expect(msg).toEqual({ type: "snapshot", tasks: [], workers: [] });
    await closeAll(ws);
  });

  it("broadcasts log_event to connected clients", async () => {
    const { server, port, adminWss } = await startServer();
    servers.push(server);
    const ws = await connectAdmin(port);
    const msgP = waitForMsgType(ws, "log_event");
    adminWss.broadcastLogEvent(sampleEntry);
    const msg = await msgP;
    expect(msg).toEqual({ type: "log_event", entry: sampleEntry });
    await closeAll(ws);
  });

  it("broadcasts to multiple connected clients", async () => {
    const { server, port, adminWss } = await startServer();
    servers.push(server);
    const [ws1, ws2] = await Promise.all([connectAdmin(port), connectAdmin(port)]);
    const [p1, p2] = [waitForMsgType(ws1, "snapshot"), waitForMsgType(ws2, "snapshot")];
    adminWss.broadcastSnapshot({ tasks: [], workers: [] });
    const [m1, m2] = await Promise.all([p1, p2]);
    expect(m1.type).toBe("snapshot");
    expect(m2.type).toBe("snapshot");
    await closeAll(ws1, ws2);
  });

  it("sends current snapshot immediately to a newly connected client", async () => {
    const snapshot = { tasks: [{ taskId: "t1", issueNumber: 1, title: "Test", status: "pending" as const }], workers: [] };
    const { server, port } = await startServerWithSnapshot(() => snapshot);
    servers.push(server);
    // Register message listener before opening so the immediate snapshot isn't missed
    const ws = new WebSocket(`ws://localhost:${port}/admin/ws`);
    const msgP = nextMsg(ws);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const msg = await msgP;
    expect(msg).toEqual({ type: "snapshot", ...snapshot });
    await closeAll(ws);
  });

  it("sends initial_log with empty entries to a newly connected client when no events have been broadcast", async () => {
    const { server, port } = await startServer();
    servers.push(server);
    const ws = new WebSocket(`ws://localhost:${port}/admin/ws`);
    const msgP = waitForMsgType(ws, "initial_log");
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const msg = await msgP;
    expect(msg).toEqual({ type: "initial_log", entries: [] });
    await closeAll(ws);
  });

  it("sends initial_log with recently broadcast events to a newly connected client", async () => {
    const { server, port, adminWss } = await startServer();
    servers.push(server);
    // Broadcast events before any client connects — they go into the buffer
    adminWss.broadcastLogEvent(sampleEntry);
    const ws = new WebSocket(`ws://localhost:${port}/admin/ws`);
    const msgP = waitForMsgType(ws, "initial_log");
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const msg = await msgP;
    expect(msg).toEqual({ type: "initial_log", entries: [sampleEntry] });
    await closeAll(ws);
  });

  it("initial_log buffer is capped at 30 entries (newest first)", async () => {
    const { server, port, adminWss } = await startServer();
    servers.push(server);
    // Broadcast 35 events — only last 30 should appear in initial_log
    for (let i = 1; i <= 35; i++) {
      adminWss.broadcastLogEvent({ kind: "webhook", id: i, timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`, taskId: null, workerId: null, summary: `event ${i}` });
    }
    const ws = new WebSocket(`ws://localhost:${port}/admin/ws`);
    const msgP = waitForMsgType(ws, "initial_log");
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const msg = await msgP;
    expect(msg.entries).toHaveLength(30);
    // Newest event (id 35) should be first
    expect(msg.entries[0].id).toBe(35);
    // Oldest in buffer (id 6) should be last
    expect(msg.entries[29].id).toBe(6);
    await closeAll(ws);
  });

  it("sends initial_log after snapshot when getSnapshot is provided", async () => {
    const snapshot = { tasks: [], workers: [] };
    const { server, port } = await startServerWithSnapshot(() => snapshot);
    servers.push(server);
    const ws = new WebSocket(`ws://localhost:${port}/admin/ws`);
    const msgsP = collectFirstN(ws, 2);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const msgs = await msgsP;
    expect(msgs[0]).toEqual({ type: "snapshot", ...snapshot });
    expect(msgs[1]).toEqual({ type: "initial_log", entries: [] });
    await closeAll(ws);
  });

  it("ignores requests to /worker path (does not hijack worker upgrade)", async () => {
    const { server, port } = await startServer();
    // Capture the raw upgrade socket so we can destroy it after the test.
    // Admin-ws does not handle /worker, so the socket is left open — we must
    // close it ourselves to allow server.close() to complete promptly.
    const upgradeSockets: net.Socket[] = [];
    server.once("upgrade", (_req, socket) => { upgradeSockets.push(socket); });

    const ws = new WebSocket(`ws://localhost:${port}/worker`);
    // Wait briefly — no upgrade response is sent, so the connection is never opened.
    await Promise.race([
      new Promise<void>((r) => ws.once("error", r)),
      new Promise<void>((r) => setTimeout(r, 50)),
    ]);
    expect(ws.readyState).not.toBe(WebSocket.OPEN);

    // Destroy captured upgrade sockets so server.close() can complete.
    for (const s of upgradeSockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });
});
