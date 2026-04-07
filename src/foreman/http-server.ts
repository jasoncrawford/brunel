import { Webhooks } from "@octokit/webhooks";
import http from "http";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import type { DbLogger } from "./db.js";
import type { TaskModel } from "./task-model.js";
import { rowToTask } from "./task-model.js";
import type { TaskStatus } from "../types.js";
import { fmtError } from "../utils.js";
import { summaryEvent, isMutedEvent } from "./event-router.js";

function flog(msg: string) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

function printEvent(id: string, name: string, payload: unknown) {
  if (isMutedEvent(name)) return;
  flog(summaryEvent(id, name, payload));
}

export function createHttpServer(
  webhooks: InstanceType<typeof Webhooks> | null,
  routeEvent: (id: string, name: string, payload: unknown) => void | Promise<void>,
  dbLogger?: DbLogger,
  taskModel?: TaskModel,
): http.Server {
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
        printEvent(id, name, parsed);
        await routeEvent(id, name, parsed);
      }
      return c.text("OK", 200);
    } catch (err) {
      flog(`ERROR Webhook processing error: ${fmtError(err)}`);
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
      const entries = dbLogger ? await dbLogger.queryLog({ limit: 100 }) : [];
      return c.json(entries);
    } catch (err) {
      flog(`ERROR API query failed: ${fmtError(err)}`);
      return c.json({ error: "internal error" }, 500);
    }
  });

  app.get("/api/tasks/:id/events", async (c) => {
    try {
      const entries = dbLogger ? await dbLogger.queryTaskEvents(c.req.param("id")) : [];
      return c.json(entries);
    } catch (err) {
      flog(`ERROR API query failed: ${fmtError(err)}`);
      return c.json({ error: "internal error" }, 500);
    }
  });

  app.get("/api/workers/:id/messages", async (c) => {
    try {
      const entries = dbLogger ? await dbLogger.queryWorkerMessages(c.req.param("id")) : [];
      return c.json(entries);
    } catch (err) {
      flog(`ERROR API query failed: ${fmtError(err)}`);
      return c.json({ error: "internal error" }, 500);
    }
  });

  app.get("/api/tasks", async (c) => {
    try {
      const statusFilter = c.req.query("status") as TaskStatus | undefined;
      const rows = taskModel ? await taskModel.listTasks() : [];

      const tasks = rows.map((row) => rowToTask(row));

      if (statusFilter) {
        return c.json(tasks.filter((t) => t.status === statusFilter));
      }
      return c.json(tasks);
    } catch (err) {
      flog(`ERROR API query failed: ${fmtError(err)}`);
      return c.json({ error: "internal error" }, 500);
    }
  });

  // ── Static files (React SPA) ───────────────────────────────────────────────
  app.use("*", async (c) => {
    const { createReadStream, existsSync } = await import("fs");
    const { join, extname } = await import("path");
    const { fileURLToPath } = await import("url");
    const root = join(fileURLToPath(import.meta.url), "../../../dist");

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
