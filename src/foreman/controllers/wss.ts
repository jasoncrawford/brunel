import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import * as Wire from "../../wire.js";
import { MessageLog } from "../models/message-log.js";
import { WebhookEvent } from "../models/webhook-event.js";
import type { AdminWss } from "../admin-ws.js";
import { fmtEvent } from "../event-fmt.js";
import { fmtError } from "../../utils.js";
import { shortWorkerId } from "../../../shared/utils.js";
import type { BrunelConfig } from "../../config.js";
import type { TaskManager } from "../models/task-manager.js";
import { Task } from "../models/task.js";
import { Worker } from "../models/worker-registry.js";
import { doRouteEvent, isMutedEvent, summaryEvent, forwardEvent } from "./event-router.js";
import type { EventRouterDeps } from "./event-router.js";

type R = Record<string, unknown>;

function debounce(fn: () => void | Promise<void>, delayMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void fn(); }, delayMs);
  };
}

// ── WebSocket server factory ──────────────────────────────────────────────────

export interface ForemanWss {
  wss: WebSocketServer;
  routeEvent(id: string, name: string, payload: unknown): Promise<void>;
  reconcile(): Promise<void>;
  /** Close all connected worker clients with code 1001 and wait for their close events to fire. */
  shutdown(): Promise<void>;
}

export function createForemanWss(
  taskManager: TaskManager,
  server: http.Server,
  config: Pick<BrunelConfig, "taskLabel" | "githubRepo" | "githubToken" | "githubApiUrl" | "workerSecret" | "pingIntervalMs">,
  deps?: {
    adminWss?: AdminWss;
  },
): ForemanWss {
  const taskLabel = config.taskLabel;
  const repo = config.githubRepo;
  const token = config.githubToken;
  const githubApiUrl = config.githubApiUrl;
  const adminWss = deps?.adminWss;
  const workerSecret = config.workerSecret;

  // Incrementing counter for unique broadcast IDs (React uses these as keys).
  let nextBroadcastId = 1;

  function flog(msg: string) {
    console.log(`${new Date().toISOString()} ${msg}`);
  }

  function broadcastMessageEvent(data: { direction: string; workerId: string | null; taskId: string | null; msgType: string; payload?: Record<string, unknown> }) {
    if (!adminWss) return;
    const summary = MessageLog.buildSummary(data.direction, data.msgType, data.taskId, data.payload ?? {});
    adminWss.broadcastLogEvent({
      kind: "message",
      id: nextBroadcastId++,
      timestamp: new Date().toISOString(),
      taskId: data.taskId,
      workerId: data.workerId,
      summary,
    });
  }

  function sendMsg(workerId: string, msg: Wire.ForemanMessage, logTaskId?: string): void {
    const taskId = logTaskId ?? (("taskId" in msg ? msg.taskId : null) ?? null);
    Worker.get(workerId)?.send(msg);
    const msgPayload = msg as unknown as Record<string, unknown>;
    MessageLog.log({ direction: "sent", workerId, taskId, msgType: msg.type, payload: msgPayload });
    broadcastMessageEvent({ direction: "sent", workerId, taskId, msgType: msg.type, payload: msgPayload });
  }

  function log(wid: string, line: string) {
    flog(`[worker ${shortWorkerId(wid)}] ${line}`);
  }

  async function broadcastSnapshot() {
    if (!adminWss) return;
    adminWss.broadcastSnapshot({
      tasks: await taskManager.getTaskSnapshots(),
      workers: Worker.all().map((w) => w.toSnapshot()),
    });
  }

  const debouncedBroadcast = debounce(broadcastSnapshot, 10);
  taskManager.on("changed", debouncedBroadcast);
  Worker.events.on("changed", debouncedBroadcast);

  // Mutex that ensures at most one assignIdleWorkers() runs at a time.
  // Without this, two concurrent webhook events can each call assignIdleWorkers()
  // and both see the same pending task before either writes an assignment. (Issue #577)
  let assignLock = Promise.resolve();

  async function assignIdleWorkers(): Promise<void> {
    assignLock = assignLock.then(async () => {
      // Sequential (not concurrent) to prevent double-assignment: each tryAssignWork
      // must complete its DB write before the next one calls nextPending(), otherwise
      // two workers can both see the same pending task. (Issue #563)
      for (const w of Worker.getIdle()) {
        await tryAssignWork(w.workerId).catch(err => flog(`ERROR tryAssignWork: ${fmtError(err)}`));
      }
    });
    await assignLock;
  }

  async function tryAssignWork(workerId: string): Promise<void> {
    const task = await taskManager.nextPending(
      (t) => t.blockersLoaded && t.status === "pending",
    );
    if (task) {
      const worker = Worker.get(workerId);
      worker?.assign(task.taskId);
      try {
        await task.assign(workerId);
      } catch (err) {
        flog(`ERROR Failed to persist assignment for task #${task.taskId}: ${fmtError(err)}`);
        worker?.release();
        log(workerId, "→ idle (DB write failed)");
        return;
      }

      const queued = taskManager.drainEvents(task.taskId);
      const assignMsg: Wire.ForemanMessage = {
        type: "task_assigned",
        taskId: task.taskId,
        issue: {
          number: task.issueNumber,
          title: task.title,
          body: task.body,
          labels: task.labels,
          repoUrl: task.repoUrl,
        },
      };
      sendMsg(workerId, assignMsg);
      log(workerId, `→ task_assigned #${task.issueNumber} "${task.title}"`);
      for (const evt of queued) {
        const evtMsg: Wire.ForemanMessage = { type: "event_notification", taskId: task.taskId, event: evt.toWorkerPayload() };
        sendMsg(workerId, evtMsg);
        log(workerId, `→ event_notification #${task.issueNumber} ${evt.eventName} (queued)`);
      }
    }
  }

  // Build the event router deps object
  const routerDeps: EventRouterDeps = {
    taskManager,
    repo,
    token,
    githubApiUrl,
    taskLabel,
    sendMsg,
    flog,
    assignIdleWorkers,
  };

  async function routeEvent(id: string, name: string, payload: unknown) {
    const p = payload as Record<string, unknown>;
    const evt = WebhookEvent.fromIncoming(id, name, p);

    const { taskId, workerId } = await doRouteEvent(routerDeps, name, p, evt);

    const action = typeof p.action === "string" ? p.action : null;
    const webhookIssueNumber = typeof (p.issue as R | undefined)?.number === "number" ? (p.issue as R).number as number : null;
    const webhookPrNumber = typeof (p.pull_request as R | undefined)?.number === "number" ? (p.pull_request as R).number as number : null;
    WebhookEvent.log({
      deliveryId: id,
      eventName: name,
      action,
      repo: typeof (p.repository as R | undefined)?.full_name === "string" ? (p.repository as R).full_name as string : null,
      sender: typeof (p.sender as R | undefined)?.login === "string" ? (p.sender as R).login as string : null,
      issueNumber: webhookIssueNumber,
      prNumber: webhookPrNumber,
      branch: null,
      taskId,
      workerId,
      payload: p,
    });
    adminWss?.broadcastLogEvent({
      kind: "webhook",
      id: nextBroadcastId++,
      timestamp: new Date().toISOString(),
      taskId,
      workerId,
      summary: fmtEvent({ name: evt.eventName, payload: evt.payload }),
    });
  }

  const wss = new WebSocketServer({ noServer: true });

  const pingTimer = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.ping();
    }
  }, config.pingIntervalMs);
  wss.on("close", () => clearInterval(pingTimer));

  wss.on("connection", (ws) => {
    let workerId = "";

    async function handleWorkerHello(msg: Extract<Wire.WorkerMessage, { type: "worker_hello" }>) {
      if (workerSecret && msg.workerSecret !== workerSecret) {
        ws.close(4001, "unauthorized");
        return;
      }

      workerId = msg.workerId;

      function flushQueuedEvents(taskId: string, issueRef: string | number) {
        for (const evt of taskManager.drainEvents(taskId)) {
          sendMsg(workerId, { type: "event_notification", taskId, event: evt.toWorkerPayload() });
          log(workerId, `→ event_notification #${issueRef} ${evt.eventName} (queued)`);
        }
      }

      function cancelWorker(taskId?: string) {
        Worker.register(workerId, ws);
        sendMsg(workerId, { type: "hello_ack", workerId, status: "cancelled" }, taskId);
      }

      async function reclaimWorker(task: Task) {
        const w = Worker.register(workerId, ws);
        w.assign(task.taskId);
        // Only call assign if task is not already complete (to preserve task status)
        if (task.status !== "complete") {
          await task.assign(workerId);
        }
        // For complete tasks, the task stays complete while worker finishes cleanup/finalization work
        sendMsg(workerId, { type: "hello_ack", workerId, status: "busy" }, task.taskId);
        flushQueuedEvents(task.taskId, task.issueNumber);
      }

      if (msg.status === "busy" && msg.taskId) {
        const existing = await Task.get(msg.taskId);

        if (!existing) {
          log(workerId, `hello busy task=#${msg.taskId} — unknown task, respecting busy status`);
          // Create a placeholder so the worker can complete normally
          const issueNumber = parseInt(msg.taskId, 10);
          let placeholderTask: Task | null = null;
          if (!isNaN(issueNumber)) {
            placeholderTask = await Task.upsert(msg.taskId, issueNumber, "", "", "", []);
          }
          if (placeholderTask) {
            await reclaimWorker(placeholderTask);
          } else {
            cancelWorker(msg.taskId);
          }
        } else if (existing.status === "complete") {
          if (existing.workerId && existing.workerId !== workerId) {
            log(workerId, `hello busy task=#${msg.taskId} — task complete but owned by another worker, cancelling`);
            cancelWorker(msg.taskId);
          } else {
            log(workerId, `hello busy task=#${msg.taskId} — task already complete, reclaiming for finalization`);
            await reclaimWorker(existing);
          }
        } else if (existing.workerId && existing.workerId !== workerId) {
          log(workerId, `hello busy task=#${msg.taskId} — task taken by another worker`);
          cancelWorker(msg.taskId);
        } else {
          log(workerId, `hello busy task=#${msg.taskId} — reclaimed`);
          await reclaimWorker(existing);
        }
      } else {
        const priorTask = await Task.getByWorker(workerId);
        if (priorTask) {
          await priorTask.revert().catch((err: unknown) =>
            flog(`ERROR Failed to revert task #${priorTask.taskId} to pending: ${fmtError(err)}`)
          );
          log(workerId, `hello idle (had task #${priorTask.taskId}) — reverting task to pending`);
        } else {
          log(workerId, "hello idle");
        }
        Worker.register(workerId, ws);
        sendMsg(workerId, { type: "hello_ack", workerId, status: "idle" });
      }
    }

    async function handleTaskComplete(msg: Extract<Wire.WorkerMessage, { type: "task_complete" }>) {
      log(workerId, `task_complete #${msg.taskId}`);
      const task = await Task.get(msg.taskId);
      if (task && task.workerId !== workerId) {
        log(workerId, `task_complete #${msg.taskId} ignored — owned by ${task.workerId ?? "nobody"}`);
        return;
      }
      if (task) {
        await task.complete().catch((err: unknown) =>
          flog(`ERROR Failed to mark task #${msg.taskId} complete: ${fmtError(err)}`)
        );
      }
      Worker.get(workerId)?.release();
    }

    async function handleWorkerGoodbye(msg: Extract<Wire.WorkerMessage, { type: "worker_goodbye" }>) {
      log(workerId, `worker_goodbye (task=${msg.taskId ?? "none"})`);
      if (msg.taskId) {
        const task = await Task.get(msg.taskId);
        if (task) {
          log(workerId, `reverting task #${task.issueNumber} to pending (worker_goodbye)`);
          await task.revert().catch((err: unknown) =>
            flog(`ERROR Failed to revert task #${msg.taskId} to pending: ${fmtError(err)}`)
          );
        }
      }
      Worker.get(workerId)?.remove();
    }

    ws.on("message", (data) => {
      void (async () => {
        let msg: Wire.WorkerMessage;
        try { msg = JSON.parse(data.toString()); } catch { return; }

        const rcvWorkerId = workerId || ((msg as { workerId?: string }).workerId ?? null);
        const rcvTaskId = (msg as { taskId?: string }).taskId ?? null;
        const rcvPayload = msg as unknown as Record<string, unknown>;
        MessageLog.log({
          direction: "received",
          workerId: rcvWorkerId,
          taskId: rcvTaskId,
          msgType: msg.type,
          payload: rcvPayload,
        });
        broadcastMessageEvent({ direction: "received", workerId: rcvWorkerId, taskId: rcvTaskId, msgType: msg.type, payload: rcvPayload });

        if (msg.type === "worker_hello") await handleWorkerHello(msg);
        else if (msg.type === "task_complete") await handleTaskComplete(msg);
        else if (msg.type === "worker_goodbye") await handleWorkerGoodbye(msg);
        else { flog(`[worker ${workerId}] unknown message type: ${(msg as R).type}`); return; }
        await assignIdleWorkers();
      })().catch(err => flog(`ERROR handling worker message: ${fmtError(err)}`));
    });

    ws.on("close", (code, reason) => {
      if (workerId) {
        const currentWorker = Worker.get(workerId);
        if (currentWorker && !currentWorker.isCurrentSocket(ws)) return;

        const reasonStr = reason?.length ? `: ${reason}` : "";
        log(workerId, `disconnected (code ${code}${reasonStr})`);
        const taskId = currentWorker?.currentTaskId ?? null;
        const disconnPayload = { code, reason: reason?.toString() ?? null };
        MessageLog.log({
          direction: "received",
          workerId,
          taskId,
          msgType: "worker_disconnected",
          payload: disconnPayload,
        });
        broadcastMessageEvent({ direction: "received", workerId, taskId, msgType: "worker_disconnected", payload: disconnPayload });
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

  function shutdown(): Promise<void> {
    return new Promise((resolve) => {
      if (wss.clients.size === 0) { resolve(); return; }
      let remaining = wss.clients.size;
      for (const client of wss.clients) {
        client.once("close", () => { if (--remaining === 0) resolve(); });
        client.close(1001, "Server shutting down");
      }
    });
  }

  return {
    wss,
    routeEvent,
    reconcile: assignIdleWorkers,
    shutdown,
  };
}
