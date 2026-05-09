import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { Webhooks } from "@octokit/webhooks";
import * as Wire from "../../../shared/wire.js";
import { ForemanMessage } from "../models/foreman-message.js";
import { Worker } from "../models/worker.js";
import { Repo } from "../models/repo.js";
import type { AdminWss } from "./admin-ws.js";
import { WorkerMessenger } from "./worker-messenger.js";
import { ForemanWorkerController } from "./foreman-worker-controller.js";
import { WebhookController } from "./webhook-controller.js";
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

// ── WorkerMsgRouter ───────────────────────────────────────────────────────────

type WorkerMsgHandler = (workerId: string, ws: WebSocket, msg: Wire.WorkerMessage) => Promise<void>;

function buildWorkerMsgRouter(controller: ForemanWorkerController): Map<Wire.WorkerMessage["type"], WorkerMsgHandler> {
  const map = new Map<Wire.WorkerMessage["type"], WorkerMsgHandler>();

  map.set("worker_hello", async (workerId, ws, msg) => {
    await controller.handleWorkerHello(workerId, ws, msg as Extract<Wire.WorkerMessage, { type: "worker_hello" }>);
  });
  map.set("task_complete", async (workerId, _ws, msg) => {
    await controller.handleTaskComplete(workerId, msg as Extract<Wire.WorkerMessage, { type: "task_complete" }>);
  });
  map.set("worker_goodbye", async (workerId, _ws, msg) => {
    await controller.handleWorkerGoodbye(workerId, msg as Extract<Wire.WorkerMessage, { type: "worker_goodbye" }>);
  });
  map.set("activate_repo", async (workerId, ws, _msg) => {
    await controller.handleActivateRepo(workerId, ws);
  });
  map.set("claim_task", async (workerId, _ws, msg) => {
    await controller.handleClaimTask(workerId, msg as Extract<Wire.WorkerMessage, { type: "claim_task" }>);
  });
  map.set("worker_ready", async (workerId, _ws, _msg) => {
    await controller.handleWorkerReady(workerId);
  });
  map.set("worker_reserved", async (workerId, _ws, _msg) => {
    await controller.handleWorkerReserve(workerId);
  });

  return map;
}

// ── ForemanWss class ──────────────────────────────────────────────────────────

export class ForemanWss {
  readonly wss: WebSocketServer;
  private readonly workerController: ForemanWorkerController;
  private readonly webhookController: WebhookController;
  /** Exposed for callers (e.g., tests and index.ts) that want to send directly. */
  readonly messenger: WorkerMessenger;

  constructor({ config, server, webhooks, adminWss }: ForemanWssOptions) {
    const resolvedWebhooks = webhooks ?? new Webhooks({ secret: "dev-mode-placeholder" });
    this.messenger = new WorkerMessenger({ adminWss });
    this.workerController = new ForemanWorkerController({ config, messenger: this.messenger });
    this.webhookController = new WebhookController({
      webhooks: resolvedWebhooks,
      config,
      messenger: this.messenger,
      assignWork: () => this.workerController.assignWork(),
    });

    const router = buildWorkerMsgRouter(this.workerController);

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
          this.messenger.broadcastLogEvent({
            kind: "message",
            timestamp: new Date().toISOString(),
            taskId: rcvTaskId,
            workerId: rcvWorkerId,
            repo: rcvRepo,
            summary: ForemanMessage.buildSummary("received", msg.type, rcvTaskId, rcvPayload),
          });

          // Route to handler.
          const handler = router.get(msg.type);
          if (handler) {
            await handler(workerId, ws, msg);
          } else {
            log(`[worker ${workerId}] unknown message type: ${(msg as Record<string, unknown>).type}`);
            return;
          }

          await this.workerController.assignWork();
        })().catch(err => {
          log(`ERROR handling worker message: ${fmtError(err)}`);
          this.messenger.sendError(ws, `Internal error: ${fmtError(err)}`, false, workerId || null, Worker.fromRegistry(workerId)?.repo.id ?? null);
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
          this.messenger.broadcastLogEvent({
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

  /** Convenience method for tests and dev-mode: route an event directly without webhook verification. */
  async routeEvent(id: string, name: string, payload: unknown): Promise<void> {
    await this.webhookController.handleEvent(id, name, payload);
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

  /** Expose sendMsg for backwards compatibility with tests that spy on it. Delegates to messenger.send. */
  sendMsg(worker: Worker, msg: Wire.ForemanMessage, opts: { logTaskId?: string; onError?: (err: Error) => void } = {}): boolean {
    return this.messenger.send(worker, msg, opts);
  }

  /** Proxy for integration tests that call handleAssignedHello directly. */
  async handleAssignedHello(workerId: string, claimedTaskId: string, ws: WebSocket, repo: Repo, lastSeenEventSeqId?: number): Promise<void> {
    return this.workerController.handleAssignedHello(workerId, claimedTaskId, ws, repo, lastSeenEventSeqId);
  }
}
