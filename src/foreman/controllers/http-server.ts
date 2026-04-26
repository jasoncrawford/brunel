import { Webhooks } from "@octokit/webhooks";
import http from "http";
import { createReadStream, existsSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import { Task } from "../models/task.js";
import { Repo } from "../models/repo.js";
import { Worker } from "../models/worker.js";
import { queryActivityLog } from "../models/activity-log.js";
import type { TaskStatus } from "../../../shared/wire.js";
import { fmtError, log } from "../../utils.js";

export interface HttpServerOptions {
  webhooks: InstanceType<typeof Webhooks> | null;
  routeEvent: (id: string, name: string, payload: unknown) => void | Promise<void>;
}

export function createHttpServer({ webhooks, routeEvent }: HttpServerOptions): http.Server {
  const app = new Hono();

  // ── Webhook ────────────────────────────────────────────────────────────────
  app.post("/webhook", async (c) => {
    const rawBody = await c.req.text();
    const id = c.req.header("x-github-delivery") ?? "unknown";
    const name = c.req.header("x-github-event");
    const signature = c.req.header("x-hub-signature-256");

    if (!name) {
      return c.text("Missing x-github-event header", 400);
    }

    try {
      if (webhooks) {
        if (!signature) {
          return c.text("Missing signature", 401);
        }
        await webhooks.verifyAndReceive({
          id,
          name: name as Parameters<typeof webhooks.verifyAndReceive>[0]["name"],
          signature,
          payload: rawBody,
        });
      } else {
        const parsed = JSON.parse(rawBody) as unknown;
        await routeEvent(id, name, parsed);
      }
      return c.text("OK", 200);
    } catch (err) {
      log(`ERROR Webhook processing error: ${fmtError(err)}`);
      return c.text("Bad Request", 400);
    }
  });

  // ── Health check ───────────────────────────────────────────────────────────
  app.get("/health", (c) =>
    c.text("GitHub webhook listener running. POST events to /webhook"),
  );

  // ── REST API ───────────────────────────────────────────────────────────────
  app.get("/api/log", async (c) => {
    try {
      const entries = await queryActivityLog({ limit: 100 });
      return c.json(entries);
    } catch (err) {
      log(`ERROR API query failed: ${fmtError(err)}`);
      return c.json({ error: "internal error" }, 500);
    }
  });

  app.get("/api/tasks/:id", async (c) => {
    try {
      const task = await Task.get(c.req.param("id"));
      if (!task) return c.json({ error: "not found" }, 404);
      return c.json(task.toWire());
    } catch (err) {
      log(`ERROR API query failed: ${fmtError(err)}`);
      return c.json({ error: "internal error" }, 500);
    }
  });

  app.get("/api/tasks/:id/events", async (c) => {
    try {
      const taskId = c.req.param("id");
      const entries = await queryActivityLog({ taskId });
      return c.json(entries);
    } catch (err) {
      log(`ERROR API query failed: ${fmtError(err)}`);
      return c.json({ error: "internal error" }, 500);
    }
  });

  app.get("/api/workers/:id", async (c) => {
    try {
      const workerId = c.req.param("id");
      const worker = await Worker.get(workerId);
      if (!worker) return c.json({ error: "not found" }, 404);
      return c.json(worker.toWire());
    } catch (err) {
      log(`ERROR API query failed: ${fmtError(err)}`);
      return c.json({ error: "internal error" }, 500);
    }
  });

  app.get("/api/workers/:id/messages", async (c) => {
    try {
      const workerId = c.req.param("id");
      const entries = await queryActivityLog({ workerId });
      return c.json(entries);
    } catch (err) {
      log(`ERROR API query failed: ${fmtError(err)}`);
      return c.json({ error: "internal error" }, 500);
    }
  });

  app.get("/api/tasks", async (c) => {
    try {
      const statusFilter = c.req.query("status") as TaskStatus | undefined;
      const tasks = await Task.list();
      const filtered = statusFilter
        ? tasks.filter((t) => t.status === statusFilter)
        : tasks.filter((t) => t.status !== "complete");
      return c.json(filtered.map((t) => t.toWire()));
    } catch (err) {
      log(`ERROR API query failed: ${fmtError(err)}`);
      return c.json({ error: "internal error" }, 500);
    }
  });

  app.get("/api/repos", async (c) => {
    try {
      const repos = await Repo.list();
      return c.json(repos.map((r) => r.toWire()));
    } catch (err) {
      log(`ERROR API query failed: ${fmtError(err)}`);
      return c.json({ error: "internal error" }, 500);
    }
  });

  app.get("/api/repos/:id", async (c) => {
    try {
      const repo = await Repo.get(Number(c.req.param("id")));
      if (!repo) return c.json({ error: "not found" }, 404);
      return c.json(repo.toWire());
    } catch (err) {
      log(`ERROR API query failed: ${fmtError(err)}`);
      return c.json({ error: "internal error" }, 500);
    }
  });

  app.get("/api/repos/:id/log", async (c) => {
    try {
      const repoId = Number(c.req.param("id"));
      const entries = await queryActivityLog({ repoId });
      return c.json(entries);
    } catch (err) {
      log(`ERROR API query failed: ${fmtError(err)}`);
      return c.json({ error: "internal error" }, 500);
    }
  });

  // ── Static files (React SPA) ───────────────────────────────────────────────
  app.use("*", async (c) => {
    const root = join(fileURLToPath(import.meta.url), "../../../../dist");

    if (!existsSync(root)) {
      return c.text("Not Found", 404);
    }

    const safePath = c.req.path;
    const filePath = join(root, safePath);
    const target =
      existsSync(filePath) && !safePath.endsWith("/")
        ? filePath
        : join(root, "index.html");
    const mime: Record<string, string> = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
    };
    const stream = createReadStream(target);
    return new Response(stream as unknown as ReadableStream, {
      headers: { "Content-Type": mime[extname(target)] ?? "application/octet-stream" },
    });
  });

  return http.createServer(getRequestListener(app.fetch));
}
