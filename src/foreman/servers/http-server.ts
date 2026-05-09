import { Webhooks } from "@octokit/webhooks";
import http from "http";
import { createReadStream, existsSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import { ApiController } from "../controllers/api-controller.js";
import { fmtError, log } from "../../utils.js";

export interface HttpServerOptions {
  webhookSecret?: string;
}

export class HttpServer {
  readonly server: http.Server;
  readonly webhooks: InstanceType<typeof Webhooks>;

  constructor({ webhookSecret }: HttpServerOptions = {}) {
    const verifySignature = !!webhookSecret;
    this.webhooks = new Webhooks({ secret: webhookSecret ?? "no-secret" });
    const webhooks = this.webhooks;
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
      if (verifySignature) {
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
        // receive() expects a parsed payload object (not raw string); the name
        // string is dynamically typed at runtime so we cast the function.
        await (webhooks.receive as (event: { id: string; name: string; payload: unknown }) => Promise<void>)({
          id,
          name,
          payload: JSON.parse(rawBody),
        });
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
  new ApiController().register(app);

  // ── Static files (React SPA) ───────────────────────────────────────────────
  app.use("*", async (c) => {
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

    this.server = http.createServer(getRequestListener(app.fetch));
  }
}
