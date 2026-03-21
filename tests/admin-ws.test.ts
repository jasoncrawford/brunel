import { describe, it, expect, afterEach } from "vitest";
import http from "http";
import net from "net";
import { WebSocket } from "ws";
import type { AddressInfo } from "net";
import { createAdminWss } from "../src/admin-ws.js";
import type { AdminMessage } from "../src/admin-ws.js";

function startServer(): Promise<{ server: http.Server; port: number; adminWss: ReturnType<typeof createAdminWss> }> {
  return new Promise((resolve) => {
    const server = http.createServer();
    const adminWss = createAdminWss(server);
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

function closeAll(...ws: WebSocket[]): Promise<void> {
  return Promise.all(ws.map((w) => new Promise<void>((r) => {
    if (w.readyState === WebSocket.CLOSED) { r(); return; }
    w.once("close", r);
    w.close();
  }))).then(() => {});
}

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
    const msgP = nextMsg(ws);
    adminWss.broadcastSnapshot({ tasks: [], workers: [] });
    const msg = await msgP;
    expect(msg).toEqual({ type: "snapshot", tasks: [], workers: [] });
    await closeAll(ws);
  });

  it("broadcasts log_event to connected clients", async () => {
    const { server, port, adminWss } = await startServer();
    servers.push(server);
    const ws = await connectAdmin(port);
    const msgP = nextMsg(ws);
    adminWss.broadcastLogEvent({ kind: "webhook", id: 1, timestamp: "2026-01-01T00:00:00Z", taskId: null, workerId: null, summary: "issues/labeled #1" });
    const msg = await msgP;
    expect(msg).toEqual({ type: "log_event", entry: { kind: "webhook", id: 1, timestamp: "2026-01-01T00:00:00Z", taskId: null, workerId: null, summary: "issues/labeled #1" } });
    await closeAll(ws);
  });

  it("broadcasts to multiple connected clients", async () => {
    const { server, port, adminWss } = await startServer();
    servers.push(server);
    const [ws1, ws2] = await Promise.all([connectAdmin(port), connectAdmin(port)]);
    const [p1, p2] = [nextMsg(ws1), nextMsg(ws2)];
    adminWss.broadcastSnapshot({ tasks: [], workers: [] });
    const [m1, m2] = await Promise.all([p1, p2]);
    expect(m1.type).toBe("snapshot");
    expect(m2.type).toBe("snapshot");
    await closeAll(ws1, ws2);
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
