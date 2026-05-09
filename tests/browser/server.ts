/**
 * Playwright browser test server.
 *
 * Starts a real foreman (HTTP + WebSocket) using null DB and no webhook secret,
 * then exposes test-only endpoints for connecting/disconnecting mock workers.
 *
 * Run via: npx tsx tests/browser/server.ts
 * Listens on PORT env var (default 14567).
 */

// Mock global.fetch BEFORE importing any src/ modules so that
// fetchNativeBlockers (called during webhook ingestion to check GitHub's
// native dependency graph) returns immediately instead of making a real
// network call — which would cause long timeouts in sandboxed CI environments.
const _realFetch = globalThis.fetch;
(globalThis as Record<string, unknown>).fetch = async (
  url: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const urlStr = url.toString();
  let parsedHostname = "";
  try {
    parsedHostname = new URL(urlStr).hostname;
  } catch {
    // not a valid URL — leave parsedHostname empty
  }
  if (parsedHostname === "api.github.com") {
    return new Response(JSON.stringify({ data: { repository: null } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return _realFetch(url, init);
};

import http from "http";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import { ForemanWss } from "../../src/foreman/servers/wss.js";
import { HttpServer } from "../../src/foreman/servers/http-server.js";
import { initDb } from "../../src/foreman/clients/db-client.js";
import { createMemoryTaskDb } from "../helpers/memory-db.js";
import { createTestTaskManager } from "../helpers/task.js";
import { Installation } from "../../src/foreman/models/installation.js";
import { Repo } from "../../src/foreman/models/repo.js";
import { AdminWss } from "../../src/foreman/servers/admin-ws.js";
import { loadDefaultConfig } from "../../src/config.js";

const PORT = parseInt(process.env.PORT ?? "14567", 10);

const cfg = await loadDefaultConfig();

// ── Foreman state ─────────────────────────────────────────────────────────────

initDb(createMemoryTaskDb());
const taskModel = await createTestTaskManager("owner/repo");
await taskModel.repo.activate();

// Mock workers managed by /test/connect-worker and /test/workers/:id
const mockWorkers = new Map<string, WebSocket>();

// ── HTTP server ───────────────────────────────────────────────────────────────

let foremanWss: ForemanWss;

// Build the foreman HTTP server (handles /webhook, /health, /api/*, static dist/)
const httpServer = new HttpServer({});
const { server } = httpServer;

// Intercept the request event so we can add /test/* routes without touching
// the production createHttpServer factory.
const [foremanRequestHandler] = server.rawListeners("request") as Array<
  (req: http.IncomingMessage, res: http.ServerResponse) => void
>;
server.removeAllListeners("request");

server.on(
  "request",
  (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url?.startsWith("/test/")) {
      void handleTestRoute(req, res);
    } else {
      foremanRequestHandler(req, res);
    }
  },
);

// ── Test route handler ────────────────────────────────────────────────────────

async function handleTestRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = req.url ?? "";

  // POST /test/connect-worker
  // Connects a mock idle worker to the foreman WS and returns { workerId }.
  if (req.method === "POST" && url === "/test/connect-worker") {
    const workerId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      const ws = new WebSocket(`ws://localhost:${PORT}/worker`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => {
          ws.send(JSON.stringify({ type: "worker_hello", repo: "owner/repo", workerId, status: "ready" }));
          ws.once("message", () => resolve()); // hello_ack
        });
        ws.once("error", reject);
      });
      mockWorkers.set(workerId, ws);
      const body = JSON.stringify({ workerId });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal server error");
    }
    return;
  }

  // DELETE /test/workers/:id
  // Closes the mock worker connection and waits for the close handshake to
  // complete before responding, so the foreman has already broadcast
  // worker_disconnected by the time the caller's await resolves.
  const workerMatch = /^\/test\/workers\/(.+)$/.exec(url);
  if (req.method === "DELETE" && workerMatch) {
    const id = workerMatch[1];
    const ws = mockWorkers.get(id);
    if (ws) {
      await new Promise<void>((resolve) => {
        ws.once("close", resolve);
        ws.close();
      });
      mockWorkers.delete(id);
    }
    res.writeHead(200);
    res.end("OK");
    return;
  }

  // POST /test/link-installation
  // Body: { fullName, accountLogin, accountType? }
  // Creates an Installation record and links it to the named repo (creating the
  // repo if needed). Returns { ok: true }. Used by browser tests that need to
  // verify installation-status display without touching owner/repo (which would
  // break task-assignment tests by causing GithubClient to attempt App token auth).
  if (req.method === "POST" && url === "/test/link-installation") {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => resolve());
    });
    try {
      const { fullName, accountLogin, accountType = "Organization" } = JSON.parse(
        Buffer.concat(chunks).toString(),
      ) as { fullName: string; accountLogin: string; accountType?: string };
      const repo = await Repo.findOrCreate(fullName);
      const inst = await Installation.insert({
        github_id: Date.now(),
        account_login: accountLogin,
        account_type: accountType,
      });
      await repo.linkInstallation(inst.id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error("[test] link-installation failed:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal server error");
    }
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
}

// ── Admin WebSocket ───────────────────────────────────────────────────────────

const adminWss = new AdminWss(server);

// ── Foreman WebSocket ─────────────────────────────────────────────────────────

foremanWss = new ForemanWss({ server, config: cfg, adminWss, webhooks: httpServer.webhooks });

// ── Start ─────────────────────────────────────────────────────────────────────

await new Promise<void>((resolve) => server.listen(PORT, resolve));
console.log(`Listening on ${(server.address() as AddressInfo).port}`);
