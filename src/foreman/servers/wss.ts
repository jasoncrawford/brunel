import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { Webhooks } from "@octokit/webhooks";
import * as Wire from "../../../shared/wire.js";
import { ForemanMessage } from "../models/foreman-message.js";
import { Worker } from "../models/worker.js";
import type { AdminWss } from "./admin-ws.js";
import { WorkerMessenger } from "../controllers/worker-messenger.js";
import { WorkerController } from "../controllers/worker-controller.js";
import { WebhookController } from "../controllers/webhook-controller.js";
import { fmtError, log } from "../../utils.js";
import { shortWorkerId } from "../../../shared/utils.js";
import type { BrunelConfig } from "../../config.js";

type AdminWssLike = Pick<AdminWss, "broadcastLogEvent">;

type ForemanWssOptions = {
  config: Pick<BrunelConfig, "taskLabel" | "githubToken" | "githubApiUrl" | "workerSecret" | "pingIntervalMs">;
  server: http.Server;
  /** Webhooks registry for routing events. If omitted, a default instance is created. */
  webhooks?: InstanceType<typeof Webhooks>;
  adminWss?: AdminWssLike;
};

export class ForemanWss {
  readonly wss: WebSocketServer;
  readonly workerController: WorkerController;
  readonly webhookController: WebhookController;

  constructor({ config, server, webhooks, adminWss }: ForemanWssOptions) {
    const resolvedWebhooks = webhooks ?? new Webhooks({ secret: "no-secret" });
    const messenger = new WorkerMessenger({ adminWss });
    this.workerController = new WorkerController({ config, messenger });
    this.webhookController = new WebhookController({
      config,
      messenger,
      assignWork: () => this.workerController.assignWork(),
    });

    resolvedWebhooks.onAny(async ({ id, name, payload }) => {
      await this.webhookController.handleEvent(id, name as string, payload);
    });

    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    // Track pong responses per socket — detect zombie connections.
    const isAlive = new WeakMap<WebSocket, boolean>();

    const pingTimer = setInterval(() => {
      for (const client of wss.clients) {
        if (!isAlive.get(client)) {
          // No pong received since last ping — connection is zombie, terminate it.
          client.terminate();
          continue;
        }
        isAlive.set(client, false);
        if (client.readyState === WebSocket.OPEN) client.ping();
      }
    }, config.pingIntervalMs);
    wss.on("close", () => clearInterval(pingTimer));

    wss.on("connection", (ws) => {
      let workerId = "";
      isAlive.set(ws, true);
      ws.on("pong", () => isAlive.set(ws, true));

      ws.on("message", (data) => {
        void (async () => {
          let msg: Wire.WorkerMessage;
          try { msg = JSON.parse(data.toString()); } catch { return; }

          // Log and broadcast incoming message before routing.
          if (msg.type === "worker_hello") workerId = msg.workerId;
          const rcvWorkerId = workerId || ((msg as { workerId?: string }).workerId ?? null);
          const rcvTaskId = (msg as { taskId?: string }).taskId ?? null;
          const rcvPayload = msg as unknown as Record<string, unknown>;
          const rcvWorker = rcvWorkerId ? Worker.fromRegistry(rcvWorkerId) : undefined;
          const rcvRepoId = rcvWorker?.repo.id ?? null;
          const rcvRepo = rcvWorker?.repo.fullName;
          void ForemanMessage.log({
            direction: "received",
            workerId: rcvWorkerId,
            taskId: rcvTaskId,
            repoId: rcvRepoId,
            msgType: msg.type,
            payload: rcvPayload,
          });
          messenger.broadcastLogEvent({
            kind: "message",
            timestamp: new Date().toISOString(),
            taskId: rcvTaskId,
            workerId: rcvWorkerId,
            repo: rcvRepo,
            summary: ForemanMessage.buildSummary("received", msg.type, rcvTaskId, rcvPayload),
          });

          // Dispatch to handler.
          await this.workerController.dispatch(workerId, ws, msg);
          await this.workerController.assignWork();
        })().catch(err => {
          log(`ERROR handling worker message: ${fmtError(err)}`);
          messenger.sendError(ws, `Internal error: ${fmtError(err)}`, false, workerId || null, Worker.fromRegistry(workerId)?.repo.id ?? null);
        });
      });

      ws.on("close", (code, reason) => {
        if (workerId) {
          const currentWorker = Worker.fromRegistry(workerId);
          if (currentWorker && !currentWorker.isCurrentSocket(ws)) return;

          const reasonStr = reason?.length ? `: ${reason}` : "";
          log(`[worker ${shortWorkerId(workerId)}] disconnected (code ${code}${reasonStr})`);
          const taskId = currentWorker?.currentTaskId ?? null;
          const disconnPayload = { code, reason: reason?.toString() ?? null };
          void ForemanMessage.log({
            direction: "received",
            workerId,
            taskId,
            repoId: currentWorker?.repo.id ?? null,
            msgType: "worker_disconnected",
            payload: disconnPayload,
          });
          messenger.broadcastLogEvent({
            kind: "message",
            timestamp: new Date().toISOString(),
            taskId,
            workerId,
            repo: currentWorker?.repo.fullName,
            summary: ForemanMessage.buildSummary("received", "worker_disconnected", taskId, disconnPayload),
          });
          if (taskId) {
            currentWorker?.markDisconnected();
          } else {
            currentWorker?.remove();
          }
        }
      });
    });

    server.on("upgrade", (req, socket, head) => {
      if (req.url === "/worker") {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      } else if (req.url !== "/admin/ws") {
        socket.destroy();
      }
    });
  }

  async reconcile(): Promise<void> {
    await this.workerController.reconcile();
  }

  shutdown(): Promise<void> {
    return new Promise((resolve) => {
      if (this.wss.clients.size === 0) { resolve(); return; }
      let remaining = this.wss.clients.size;
      for (const client of this.wss.clients) {
        client.once("close", () => { if (--remaining === 0) resolve(); });
        client.close(1001, "Server shutting down");
      }
    });
  }
}
