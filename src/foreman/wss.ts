import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { WorkerMessage, ForemanMessage, GitHubEvent } from "../types.js";
import type { DependencyGraph } from "./dependencies.js";
import { type DbLogger, buildMessageSummary } from "./db.js";
import type { AdminWss } from "./admin-ws.js";
import { fmtEvent } from "./event-fmt.js";
import { fmtError } from "../utils.js";
import { shortWorkerId } from "../../shared/utils.js";
import type { BrunelConfig } from "../config.js";
import type { TaskModel } from "./task-model.js";
import type { WorkerRegistry } from "./worker-registry.js";
import { doRouteEvent, reconcile, isMutedEvent, summaryEvent, forwardEvent } from "./event-router.js";
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
  taskModel: TaskModel,
  registry: WorkerRegistry,
  server: http.Server,
  config: Pick<BrunelConfig, "taskLabel" | "githubRepo" | "githubToken" | "githubApiUrl" | "workerSecret" | "pingIntervalMs" | "workerReclaimTimeoutMs">,
  deps?: {
    graph?: DependencyGraph;
    dbLogger?: DbLogger;
    adminWss?: AdminWss;
  },
): ForemanWss {
  const taskLabel = config.taskLabel;
  const graph = deps?.graph ?? new Map<number, Set<number>>();
  const repo = config.githubRepo;
  const token = config.githubToken;
  const githubApiUrl = config.githubApiUrl;
  const dbLogger = deps?.dbLogger;
  const adminWss = deps?.adminWss;
  const workerSecret = config.workerSecret;
  const reclaimTimeoutMs = config.workerReclaimTimeoutMs;

  // Incrementing counter for unique broadcast IDs (React uses these as keys).
  let nextBroadcastId = 1;

  function flog(msg: string) {
    console.log(`${new Date().toISOString()} ${msg}`);
  }

  function broadcastMessageEvent(data: { direction: string; workerId: string | null; taskId: string | null; msgType: string; payload?: Record<string, unknown> }) {
    if (!adminWss) return;
    const summary = buildMessageSummary(data.direction, data.msgType, data.taskId, data.payload ?? {});
    adminWss.broadcastLogEvent({
      kind: "message",
      id: nextBroadcastId++,
      timestamp: new Date().toISOString(),
      taskId: data.taskId,
      workerId: data.workerId,
      summary,
    });
  }

  function sendMsg(workerId: string, msg: ForemanMessage, logTaskId?: string): void {
    const taskId = logTaskId ?? (("taskId" in msg ? msg.taskId : null) ?? null);
    registry.send(workerId, msg);
    const msgPayload = msg as unknown as Record<string, unknown>;
    dbLogger?.logForemanMessage({ direction: "sent", workerId, taskId, msgType: msg.type, payload: msgPayload });
    broadcastMessageEvent({ direction: "sent", workerId, taskId, msgType: msg.type, payload: msgPayload });
  }

  function log(wid: string, line: string) {
    flog(`[worker ${shortWorkerId(wid)}] ${line}`);
  }

  async function broadcastSnapshot() {
    if (!adminWss) return;
    adminWss.broadcastSnapshot({
      tasks: await taskModel.getTaskSnapshots(graph),
      workers: registry.getWorkerSnapshots(),
    });
  }

  const debouncedBroadcast = debounce(broadcastSnapshot, 10);
  taskModel.on("changed", debouncedBroadcast);
  registry.on("changed", debouncedBroadcast);

  async function assignIdleWorkers(): Promise<void> {
    await Promise.all(
      registry.getIdleWorkers().map(w =>
        tryAssignWork(w.workerId).catch(err => flog(`ERROR tryAssignWork: ${fmtError(err)}`))
      )
    );
  }

  async function tryAssignWork(workerId: string): Promise<void> {
    const task = await taskModel.nextPending(
      (t) => taskModel.isDepsLoaded(t.issueNumber) && !taskModel.isBlocked(t.issueNumber, graph),
    );
    if (task) {
      registry.assignTask(workerId, task.taskId);
      const ok = await taskModel.assign(task.taskId, workerId);
      if (!ok) {
        flog(`ERROR Failed to persist assignment for task #${task.taskId}`);
        registry.releaseWorker(workerId);
        log(workerId, "→ idle (DB write failed)");
        return;
      }

      const queued = taskModel.drainEvents(task.taskId);
      const assignMsg: ForemanMessage = {
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
        const evtMsg: ForemanMessage = { type: "event_notification", taskId: task.taskId, event: evt };
        sendMsg(workerId, evtMsg);
        log(workerId, `→ event_notification #${task.issueNumber} ${evt.name} (queued)`);
      }

    }
  }

  // Build the event router deps object
  const routerDeps: EventRouterDeps = {
    taskModel,
    registry,
    graph,
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
    const evt: GitHubEvent = { id, name, payload: p };

    const { taskId, workerId } = await doRouteEvent(routerDeps, name, p, evt);

    const action = typeof p.action === "string" ? p.action : null;
    const webhookIssueNumber = typeof (p.issue as R | undefined)?.number === "number" ? (p.issue as R).number as number : null;
    const webhookPrNumber = typeof (p.pull_request as R | undefined)?.number === "number" ? (p.pull_request as R).number as number : null;
    dbLogger?.logWebhookEvent({
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
      summary: fmtEvent(evt),
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

    async function handleWorkerHello(msg: Extract<WorkerMessage, { type: "worker_hello" }>) {
      if (workerSecret && msg.workerSecret !== workerSecret) {
        ws.close(4001, "unauthorized");
        return;
      }

      workerId = msg.workerId;
      registry.cancelReclaimTimer(workerId);

      function flushQueuedEvents(taskId: string, issueRef: string | number) {
        for (const evt of taskModel.drainEvents(taskId)) {
          sendMsg(workerId, { type: "event_notification", taskId, event: evt });
          log(workerId, `→ event_notification #${issueRef} ${evt.name} (queued)`);
        }
      }

      function cancelWorker(taskId?: string) {
        registry.register(workerId, ws, "idle");
        sendMsg(workerId, { type: "hello_ack", workerId, status: "cancelled" }, taskId);
      }

      async function reclaimWorker(taskId: string, issueRef: string | number) {
        registry.register(workerId, ws, "busy", taskId);
        await taskModel.assign(taskId, workerId);
        sendMsg(workerId, { type: "hello_ack", workerId, status: "busy" }, taskId);
        flushQueuedEvents(taskId, issueRef);
      }

      if (msg.status === "busy" && msg.taskId) {
        const existing = await taskModel.get(msg.taskId);

        if (!existing) {
          log(workerId, `hello busy task=#${msg.taskId} — unknown task, respecting busy status`);
          // Create a placeholder so the worker can complete normally
          const issueNumber = parseInt(msg.taskId, 10);
          if (!isNaN(issueNumber)) {
            await taskModel.register(msg.taskId, issueNumber, "", "", "", []);
          }
          await reclaimWorker(msg.taskId, msg.taskId);
        } else if (existing.status === "complete") {
          log(workerId, `hello busy task=#${msg.taskId} — task complete (issue closed), cancelling`);
          cancelWorker(msg.taskId);
        } else if (existing.assignedWorkerId && existing.assignedWorkerId !== workerId) {
          log(workerId, `hello busy task=#${msg.taskId} — task taken by another worker`);
          cancelWorker(msg.taskId);
        } else {
          log(workerId, `hello busy task=#${msg.taskId} — reclaimed`);
          await reclaimWorker(msg.taskId, existing.issueNumber);
        }
      } else {
        const priorTask = await taskModel.getAssignedTaskForWorker(workerId);
        if (priorTask) {
          await taskModel.revert(priorTask.taskId).catch((err: unknown) =>
            flog(`ERROR Failed to revert task #${priorTask.taskId} to pending: ${fmtError(err)}`)
          );
          log(workerId, `hello idle (had task #${priorTask.taskId}) — reverting task to pending`);
        } else {
          log(workerId, "hello idle");
        }
        registry.register(workerId, ws, "idle");
        sendMsg(workerId, { type: "hello_ack", workerId, status: "idle" });
      }
    }

    async function handleTaskComplete(msg: Extract<WorkerMessage, { type: "task_complete" }>) {
      log(workerId, `task_complete #${msg.taskId}`);
      const task = await taskModel.get(msg.taskId);
      if (task && task.assignedWorkerId !== workerId) {
        log(workerId, `task_complete #${msg.taskId} ignored — owned by ${task.assignedWorkerId ?? "nobody"}`);
        return;
      }
      if (task) {
        await taskModel.complete(msg.taskId).catch((err: unknown) =>
          flog(`ERROR Failed to mark task #${msg.taskId} complete: ${fmtError(err)}`)
        );
      }
      registry.releaseWorker(workerId);
    }

    async function handleWorkerGoodbye(msg: Extract<WorkerMessage, { type: "worker_goodbye" }>) {
      log(workerId, `worker_goodbye (task=${msg.taskId ?? "none"})`);
      if (msg.taskId) {
        await taskModel.revert(msg.taskId).catch((err: unknown) =>
          flog(`ERROR Failed to revert task #${msg.taskId} to pending: ${fmtError(err)}`)
        );
      }
      registry.remove(workerId);
    }

    ws.on("message", (data) => {
      void (async () => {
        let msg: WorkerMessage;
        try { msg = JSON.parse(data.toString()); } catch { return; }

        const rcvWorkerId = workerId || ((msg as { workerId?: string }).workerId ?? null);
        const rcvTaskId = (msg as { taskId?: string }).taskId ?? null;
        const rcvPayload = msg as unknown as Record<string, unknown>;
        dbLogger?.logForemanMessage({
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
        const currentState = registry.get(workerId);
        if (currentState && currentState.ws !== ws) return;

        const reasonStr = reason?.length ? `: ${reason}` : "";
        log(workerId, `disconnected (code ${code}${reasonStr})`);
        const taskId = currentState?.currentTaskId ?? null;
        const disconnPayload = { code, reason: reason?.toString() ?? null };
        dbLogger?.logForemanMessage({
          direction: "received",
          workerId,
          taskId,
          msgType: "worker_disconnected",
          payload: disconnPayload,
        });
        broadcastMessageEvent({ direction: "received", workerId, taskId, msgType: "worker_disconnected", payload: disconnPayload });
        if (taskId) {
          registry.markDisconnected(workerId);
          registry.startReclaimTimer(workerId, reclaimTimeoutMs, () => {
            const w = registry.get(workerId);
            if (!w || w.status !== "disconnected") return;
            log(workerId, `reclaim timer fired — reverting task #${taskId} to pending`);
            void (async () => {
              await taskModel.revert(taskId).catch((err: unknown) =>
                flog(`ERROR Failed to revert task #${taskId} to pending: ${fmtError(err)}`)
              );
              registry.remove(workerId);
              await assignIdleWorkers();
            })().catch(err => flog(`ERROR reclaim timer: ${fmtError(err)}`));
          });
        } else {
          registry.remove(workerId);
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
    reconcile: () => reconcile(routerDeps),
    shutdown,
  };
}
