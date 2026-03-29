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
import {
  TaskQueue,
  WorkerRegistry,
  createForemanWss,
  createHttpServer,
} from "../../src/foreman.js";
import { createAdminWss } from "../../src/admin-ws.js";
import { loadDefaultConfig } from "../../src/config.js";
import type { DependencyGraph } from "../../src/dependencies.js";
import type { LabeledIssueState } from "../../src/types.js";

const PORT = parseInt(process.env.PORT ?? "14567", 10);

const cfg = await loadDefaultConfig();

// ── Foreman state ─────────────────────────────────────────────────────────────

const queue = new TaskQueue();
const registry = new WorkerRegistry();
const graph: DependencyGraph = new Map();
const openIssues = new Set<number>();
const labeledIssues = new Map<number, LabeledIssueState>();

// Mock workers managed by /test/connect-worker and /test/workers/:id
const mockWorkers = new Map<string, WebSocket>();

// ── HTTP server ───────────────────────────────────────────────────────────────

let foremanWss: ReturnType<typeof createForemanWss>;

// Build the foreman HTTP server (handles /webhook, /health, /api/*, static dist/)
const server = createHttpServer(
  null,
  (id, name, payload) => foremanWss.routeEvent(id, name, payload),
);

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
          ws.send(JSON.stringify({ type: "worker_hello", workerId, status: "idle" }));
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
  // Closes the mock worker connection.
  const workerMatch = /^\/test\/workers\/(.+)$/.exec(url);
  if (req.method === "DELETE" && workerMatch) {
    const id = workerMatch[1];
    const ws = mockWorkers.get(id);
    if (ws) {
      ws.close();
      mockWorkers.delete(id);
    }
    res.writeHead(200);
    res.end("OK");
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
}

// ── Admin WebSocket ───────────────────────────────────────────────────────────

const adminWss = createAdminWss(server, () => ({
  tasks: queue.getTaskSnapshots(graph, openIssues),
  workers: registry.getWorkerSnapshots(),
}));

// ── Foreman WebSocket ─────────────────────────────────────────────────────────

foremanWss = createForemanWss(queue, registry, server, {
  taskLabel: cfg.taskLabel,
  reclaimTimeoutMs: cfg.workerReclaimTimeoutMs,
  graph,
  openIssues,
  labeledIssues,
  adminWss,
});

// ── Start ─────────────────────────────────────────────────────────────────────

await new Promise<void>((resolve) => server.listen(PORT, resolve));
console.log(`Listening on ${(server.address() as AddressInfo).port}`);
