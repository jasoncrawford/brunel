import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import * as Wire from "../../../shared/wire.js";
import { ForemanMessage } from "../models/foreman-message.js";
import { WebhookEvent } from "../models/webhook-event.js";
import type { AdminWss } from "./admin-ws.js";

type AdminWssLike = Pick<AdminWss, "broadcastLogEvent">;
import { fmtError, log } from "../../utils.js";
import { shortWorkerId } from "../../../shared/utils.js";
import type { BrunelConfig } from "../../config.js";
import { TaskManager } from "../models/task-manager.js";
import { Repo } from "../models/repo.js";
import { Task } from "../models/task.js";
import { Worker } from "../models/worker.js";

type R = Record<string, unknown>;

// ── Routing helpers ───────────────────────────────────────────────────────────

function strProp(obj: unknown, key: string): string | null {
  if (typeof obj !== "object" || obj === null) return null;
  const val = (obj as Record<string, unknown>)[key];
  return typeof val === "string" ? val : null;
}

function numProp(obj: unknown, key: string): number | null {
  if (typeof obj !== "object" || obj === null) return null;
  const val = (obj as Record<string, unknown>)[key];
  return typeof val === "number" ? val : null;
}

/**
 * The task and human-readable ref returned by per-event-type routing functions.
 * `forward` controls whether the event should be forwarded to the worker
 * (defaults to true when task is non-null). Set to false to log the task_id
 * without notifying the worker (e.g. pull_request/synchronize).
 */
export interface RouteResult { task: Task | null; ref: string; forward?: boolean; }

// ── ForemanWss class ──────────────────────────────────────────────────────────

type ForemanWssOptions = {
  config: Pick<BrunelConfig, "taskLabel" | "githubToken" | "githubApiUrl" | "workerSecret" | "pingIntervalMs">;
  server: http.Server;
  adminWss?: AdminWssLike;
};

export class ForemanWss {
  readonly wss: WebSocketServer;
  private readonly config: Pick<BrunelConfig, "taskLabel" | "githubToken" | "githubApiUrl" | "workerSecret" | "pingIntervalMs">;
  private readonly adminWss?: AdminWssLike;
  private nextBroadcastId = 1;

  constructor({ config, server, adminWss }: ForemanWssOptions) {
    this.config = config;
    this.adminWss = adminWss;

    TaskManager.events.on("deps_loaded", (taskManager: TaskManager) => {
      this.assignWorkForRepo(taskManager).catch((err) => log(`ERROR assignWork after deps_loaded: ${fmtError(err)}`));
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
          this.broadcastMessageEvent({ direction: "received", workerId: rcvWorkerId, taskId: rcvTaskId, msgType: msg.type, payload: rcvPayload, repo: rcvRepo });

          if (msg.type === "worker_hello") {
            workerId = msg.workerId;
            await this.handleWorkerHello(workerId, ws, msg);
          } else if (msg.type === "task_complete") {
            await this.handleTaskComplete(workerId, msg);
          } else if (msg.type === "worker_goodbye") {
            await this.handleWorkerGoodbye(workerId, msg);
          } else if (msg.type === "activate_repo") {
            await this.handleActivateRepo(workerId, ws);
          } else if (msg.type === "claim_task") {
            await this.handleClaimTask(workerId, msg);
          } else if (msg.type === "worker_ready") {
            await this.handleWorkerReady(workerId);
          } else if (msg.type === "worker_reserved") {
            await this.handleWorkerReserve(workerId);
          } else {
            log(`[worker ${workerId}] unknown message type: ${(msg as R).type}`);
            return;
          }
          await this.assignWork();
        })().catch(err => {
          log(`ERROR handling worker message: ${fmtError(err)}`);
          this.sendError(ws, `Internal error: ${fmtError(err)}`, false, workerId || null, Worker.fromRegistry(workerId)?.repo.id ?? null);
        });
      });

      ws.on("close", (code, reason) => {
        if (workerId) {
          const currentWorker = Worker.fromRegistry(workerId);
          if (currentWorker && !currentWorker.isCurrentSocket(ws)) return;

          const reasonStr = reason?.length ? `: ${reason}` : "";
          this.workerLog(workerId, `disconnected (code ${code}${reasonStr})`);
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
          this.broadcastMessageEvent({ direction: "received", workerId, taskId, msgType: "worker_disconnected", payload: disconnPayload, repo: currentWorker?.repo.fullName });
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

  async routeEvent(id: string, name: string, payload: unknown): Promise<void> {
    const p = payload as R;
    const evt = WebhookEvent.fromIncoming(id, name, p);
    if (!evt.isMuted()) log(evt.summary());

    // Find or create a Repo record for every webhook that carries a repository.
    // Routing always proceeds regardless of repo status — events must still be
    // forwarded to any worker that has a task assigned from this repo.
    const repoFullName = strProp(p.repository, "full_name");
    let repoId: number | null = null;
    if (repoFullName) {
      repoId = (await Repo.findOrCreate(repoFullName)).id;
    }

    // Step 1: determine task (side effects, DB lookups) — no forwarding yet.
    let task: Task | null = null;
    let ref = "";
    let forward = true;
    if (name === "pull_request") {
      ({ task, ref, forward = true } = await this.routePrEvent(p, evt));
    } else if (name === "pull_request_review" || name === "pull_request_review_comment") {
      ({ task, ref } = await this.routePrReviewEvent(p, evt));
    } else if (name === "check_run" || name === "check_suite") {
      ({ task, ref } = await this.routeCheckEvent(p, evt, name));
    } else {
      const issue = p.issue as R | undefined;
      const issueNumber = numProp(issue, "number");
      if (issueNumber !== null) {
        ({ task, ref } = await this.routeIssueEvent(p, evt, issue!, issueNumber));
      }
    }

    const taskId = task?.taskId ?? null;
    const workerId = task?.workerId ?? null;
    const action = typeof p.action === "string" ? p.action : null;
    const webhookIssueNumber = typeof (p.issue as R | undefined)?.number === "number" ? (p.issue as R).number as number : null;
    const webhookPrNumber = typeof (p.pull_request as R | undefined)?.number === "number" ? (p.pull_request as R).number as number : null;

    // Step 2: log to DB and obtain the durable sequence id.
    const seqId = await WebhookEvent.log({
      deliveryId: id,
      eventName: name,
      action,
      repoId,
      sender: typeof (p.sender as R | undefined)?.login === "string" ? (p.sender as R).login as string : null,
      issueNumber: webhookIssueNumber,
      prNumber: webhookPrNumber,
      branch: null,
      taskId,
      workerId,
      payload: p,
    });

    // Step 3: forward to the worker with the sequence id (unless explicitly suppressed).
    if (task && forward) this.forwardEvent(task, evt, ref, seqId ?? undefined);

    this.adminWss?.broadcastLogEvent({
      kind: "webhook",
      id: this.nextBroadcastId++,
      timestamp: new Date().toISOString(),
      taskId,
      workerId,
      repo: repoFullName ?? undefined,
      summary: evt.format(),
    });
  }

  async reconcile(): Promise<void> {
    await this.assignWork();
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

  sendMsg(worker: Worker, msg: Wire.ForemanMessage, opts: { logTaskId?: string; onError?: (err: Error) => void } = {}): boolean {
    const taskId = opts.logTaskId ?? (("taskId" in msg ? msg.taskId : null) ?? null);
    const sent = worker.send(msg, opts.onError);
    if (sent) {
      this.logAndBroadcastSent(worker.workerId, taskId, msg.type, msg as unknown as Record<string, unknown>, worker.repo.id, worker.repo.fullName);
    }
    return sent;
  }

  private logAndBroadcastSent(workerId: string | null, taskId: string | null, msgType: string, payload: Record<string, unknown>, repoId: number | null, repo?: string): void {
    void ForemanMessage.log({ direction: "sent", workerId, taskId, repoId, msgType, payload });
    this.broadcastMessageEvent({ direction: "sent", workerId, taskId, msgType, payload, repo });
  }

  private broadcastMessageEvent(data: { direction: string; workerId: string | null; taskId: string | null; msgType: string; payload?: Record<string, unknown>; repo?: string }): void {
    if (!this.adminWss) return;
    const summary = ForemanMessage.buildSummary(data.direction, data.msgType, data.taskId, data.payload ?? {});
    this.adminWss.broadcastLogEvent({
      kind: "message",
      id: this.nextBroadcastId++,
      timestamp: new Date().toISOString(),
      taskId: data.taskId,
      workerId: data.workerId,
      repo: data.repo,
      summary,
    });
  }

  private workerLog(wid: string, line: string): void {
    log(`[worker ${shortWorkerId(wid)}] ${line}`);
  }

  /**
   * Send a foreman_error message directly to a WebSocket connection.
   * Used when a catastrophic error occurs during hello handling or message
   * processing — gives the worker an explanation instead of a silent drop.
   * Also persists the error to foreman_messages so it appears in the activity log.
   */
  private sendError(ws: WebSocket, message: string, fatal: boolean, workerId: string | null, repoId: number | null, taskId: string | null = null): void {
    const payload: Wire.ForemanMessage = { type: "foreman_error", message, fatal };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
    this.logAndBroadcastSent(workerId, taskId, payload.type, payload as unknown as Record<string, unknown>, repoId);
  }

  // ── Hello handlers ───────────────────────────────────────────────────────────

  private flushQueuedEvents(worker: Worker, task: Task): void {
    for (const evt of task.drainEvents()) {
      const seqId = evt.id ?? undefined;
      const sent = this.sendMsg(
        worker,
        { type: "event_notification", taskId: task.taskId, event: evt.toWorkerPayload(), ...(seqId !== undefined && { seqId }) },
        { onError: (err) => {
          task.queueEvent(evt);
          this.workerLog(worker.workerId, `✗ event_notification send error — requeued #${task.issueNumber} ${evt.eventName}: ${fmtError(err)}`);
        } },
      );
      if (sent) {
        this.workerLog(worker.workerId, `→ event_notification #${task.issueNumber} ${evt.eventName} (queued)`);
      } else {
        task.queueEvent(evt);
        this.workerLog(worker.workerId, `✗ event_notification send failed — requeued #${task.issueNumber} ${evt.eventName}`);
      }
    }
  }

  private cancelWorker(worker: Worker, task: Task | null): void {
    this.sendMsg(worker, { type: "hello_ack", workerId: worker.workerId, status: "cancelled", repoStatus: worker.repo.status }, { logTaskId: task?.taskId });
  }

  private async replayMissedEvents(worker: Worker, task: Task, lastSeenEventSeqId: number): Promise<void> {
    let missed: import("../models/webhook-event.js").WebhookEvent[];
    try {
      missed = await WebhookEvent.queryMissedFor(task.taskId, lastSeenEventSeqId);
    } catch (err) {
      this.workerLog(worker.workerId, `ERROR querying missed events for #${task.issueNumber}: ${fmtError(err)}`);
      return;
    }
    for (const evt of missed) {
      const seqId = evt.id ?? undefined;
      this.sendMsg(
        worker,
        { type: "event_notification", taskId: task.taskId, event: evt.toWorkerPayload(), ...(seqId !== undefined && { seqId }) },
      );
      this.workerLog(worker.workerId, `→ event_notification #${task.issueNumber} ${evt.eventName} (replay seqId=${seqId})`);
    }
  }

  private async reclaimWorker(worker: Worker, task: Task, lastSeenEventSeqId?: number): Promise<void> {
    worker.assign(task);
    // Only call assign if task is not already complete (to preserve task status)
    if (task.status !== "complete") {
      await task.assign(worker);
    }
    // For complete tasks, the task stays complete while worker finishes cleanup/finalization work
    this.sendMsg(worker, { type: "hello_ack", workerId: worker.workerId, status: "assigned", repoStatus: worker.repo.status }, { logTaskId: task.taskId });
    this.flushQueuedEvents(worker, task);
    // DB replay: send any events the worker missed while disconnected (covers zombie window
    // and foreman restart scenarios). Runs after the in-memory flush; duplicates are acceptable.
    if (lastSeenEventSeqId !== undefined) {
      await this.replayMissedEvents(worker, task, lastSeenEventSeqId);
    }
  }

  async handleWorkerHello(workerId: string, ws: WebSocket, msg: Extract<Wire.WorkerMessage, { type: "worker_hello" }>): Promise<void> {
    if (this.config.workerSecret && msg.workerSecret !== this.config.workerSecret) {
      ws.close(4001, "unauthorized");
      return;
    }

    if (!msg.repo) {
      log(`[worker ${shortWorkerId(workerId)}] worker_hello missing required repo field — rejecting`);
      this.sendError(ws, "worker_hello must include a repo field", true, workerId, null);
      return;
    }

    let repo: Repo;
    try {
      repo = await Repo.findOrCreate(msg.repo);
    } catch (err) {
      log(`[worker ${shortWorkerId(workerId)}] failed to resolve repo ${msg.repo}: ${fmtError(err)}`);
      this.sendError(ws, `Failed to resolve repo ${msg.repo}: ${fmtError(err)}`, true, workerId, null);
      return;
    }

    if (msg.status === "assigned" && msg.taskId) {
      await this.handleAssignedHello(workerId, msg.taskId, ws, repo, msg.lastSeenEventSeqId);
    } else if (msg.status === "reserved") {
      await this.handleReservedHello(workerId, ws, repo);
    } else {
      await this.handleReadyHello(workerId, ws, repo);
    }
  }

  async handleTaskComplete(workerId: string, msg: Extract<Wire.WorkerMessage, { type: "task_complete" }>): Promise<void> {
    this.workerLog(workerId, `task_complete #${msg.taskId} (nextState=${msg.nextState ?? "ready"})`);
    const task = await Task.get(msg.taskId);
    if (task && task.workerId !== workerId) {
      this.workerLog(workerId, `task_complete #${msg.taskId} ignored — owned by ${task.workerId ?? "nobody"}`);
      return;
    }
    if (task) {
      try {
        await task.complete(msg.stats);
      } catch (err) {
        log(`ERROR Failed to mark task #${msg.taskId} complete: ${fmtError(err)}`);
        return; // don't release — keeps task assigned so the failure is visible
      }
    }
    const worker = Worker.fromRegistry(workerId);
    if (msg.nextState === "reserved") {
      worker?.releaseReserved();
    } else {
      worker?.release();
    }
  }

  async handleWorkerGoodbye(workerId: string, msg: Extract<Wire.WorkerMessage, { type: "worker_goodbye" }>): Promise<void> {
    this.workerLog(workerId, `worker_goodbye (task=${msg.taskId ?? "none"}, complete=${msg.task_complete ?? false})`);
    if (msg.taskId) {
      const task = await Task.get(msg.taskId);
      if (task) {
        if (msg.task_complete) {
          this.workerLog(workerId, `completing task #${task.issueNumber} via worker_goodbye`);
          await task.complete(msg.stats).catch((err: unknown) =>
            log(`ERROR Failed to complete task #${msg.taskId}: ${fmtError(err)}`)
          );
        } else {
          this.workerLog(workerId, `reverting task #${task.issueNumber} to pending (worker_goodbye)`);
          await task.revert().catch((err: unknown) =>
            log(`ERROR Failed to revert task #${msg.taskId} to pending: ${fmtError(err)}`)
          );
        }
      }
    }
    Worker.fromRegistry(workerId)?.remove();
  }

  /**
   * Handles the "assigned" branch of a worker_hello — the worker is reconnecting
   * and claims to be mid-task. Decides among seven cases:
   *
   * 1. Unknown task (numeric taskId) → create placeholder, reclaim
   * 2. Unknown task (non-numeric taskId) → cancel
   * 3. Task belongs to a different repo → cancel
   * 4. Complete task, same worker → reclaim for finalization
   * 5. Complete task, different worker → cancel
   * 6. Live task, different worker → cancel
   * 7. Otherwise (live task, same or no worker) → reclaim
   */
  async handleAssignedHello(workerId: string, claimedTaskId: string, ws: WebSocket, repo: Repo, lastSeenEventSeqId?: number): Promise<void> {
    try {
      const existing = await Task.get(claimedTaskId);
      const worker = Worker.register(workerId, ws, repo);

      if (!existing) {
        this.workerLog(workerId, `hello busy task=#${claimedTaskId} — unknown task, respecting busy status`);
        const issueNumber = parseInt(claimedTaskId, 10);
        let placeholderTask: Task | null = null;
        if (!isNaN(issueNumber)) {
          placeholderTask = await Task.upsert(claimedTaskId, issueNumber, "", "", "", []);
        }
        if (placeholderTask) {
          await this.reclaimWorker(worker, placeholderTask, lastSeenEventSeqId);
        } else {
          this.cancelWorker(worker, null);
        }
      } else if (existing.repoId !== repo.id) {
        this.workerLog(workerId, `hello busy task=#${claimedTaskId} — task belongs to repo ${existing.repo}, worker is from ${repo.fullName}`);
        this.cancelWorker(worker, existing);
      } else if (existing.status === "complete") {
        if (existing.workerId && existing.workerId !== workerId) {
          this.workerLog(workerId, `hello busy task=#${claimedTaskId} — task complete but owned by another worker, cancelling`);
          this.cancelWorker(worker, existing);
        } else {
          this.workerLog(workerId, `hello busy task=#${claimedTaskId} — task already complete, reclaiming for finalization`);
          await this.reclaimWorker(worker, existing, lastSeenEventSeqId);
        }
      } else if (existing.workerId && existing.workerId !== workerId) {
        this.workerLog(workerId, `hello busy task=#${claimedTaskId} — task taken by another worker`);
        this.cancelWorker(worker, existing);
      } else {
        this.workerLog(workerId, `hello busy task=#${claimedTaskId} — reclaimed`);
        await this.reclaimWorker(worker, existing, lastSeenEventSeqId);
      }
    } catch (err) {
      log(`ERROR handleAssignedHello ${workerId}: ${fmtError(err)}`);
      // DB error during task lookup or reclaim — recoverable: DB may be temporarily down.
      // Worker retries on reconnect and the operation succeeds once the DB recovers.
      this.sendError(ws, `Internal error during reconnection: ${fmtError(err)}`, false, workerId, repo.id);
    }
  }

  /**
   * Shared registration logic for workers connecting fresh (no task).
   * Reverts any stale prior assignment, registers the worker.
   * Returns the registered Worker, or null if an error was sent to ws.
   */
  private async _registerFresh(workerId: string, ws: WebSocket, repo: Repo): Promise<Worker | null> {
    // DB error here is transient — recoverable: worker retries on reconnect.
    const priorTask = await Task.getByWorker(workerId);
    if (priorTask) {
      try {
        await priorTask.revert();
        this.workerLog(workerId, `reverted stale task #${priorTask.taskId} to pending`);
      } catch (err) {
        log(`ERROR Failed to revert task #${priorTask.taskId} to pending: ${fmtError(err)}`);
        // DB error reverting prior task — recoverable: task stays assigned so the
        // failure is visible; a new idle assignment would create a double assignment.
        // Worker retries on reconnect and the revert succeeds once the DB recovers.
        this.sendError(ws, `Failed to revert prior task to pending: ${fmtError(err)}`, false, workerId, repo.id, priorTask.taskId);
        return null; // don't register — task stays assigned, worker retries on reconnect
      }
    }
    return Worker.register(workerId, ws, repo);
  }

  /**
   * Handles the "ready" branch of a worker_hello — the worker is connecting
   * fresh, available for auto-assignment. Reverts any stale prior assignment,
   * registers the worker, and sends a ready hello_ack.
   */
  async handleReadyHello(workerId: string, ws: WebSocket, repo: Repo): Promise<void> {
    try {
      const worker = await this._registerFresh(workerId, ws, repo);
      if (!worker) return; // error already sent
      this.workerLog(workerId, "hello ready");
      this.sendMsg(worker, { type: "hello_ack", workerId: worker.workerId, status: "ready", repoStatus: repo.status });
    } catch (err) {
      log(`ERROR handleReadyHello ${workerId}: ${fmtError(err)}`);
      // DB error during worker lookup — recoverable: DB may be temporarily down.
      this.sendError(ws, `Internal error during ready hello: ${fmtError(err)}`, false, workerId, repo.id);
    }
  }

  /**
   * Handles the "reserved" branch of a worker_hello — the worker is connecting
   * but NOT available for auto-assignment. Registers, marks as reserved, and
   * sends hello_ack { status: "reserved" }. The worker will send claim_task
   * separately after receiving the ack.
   */
  async handleReservedHello(workerId: string, ws: WebSocket, repo: Repo): Promise<void> {
    try {
      const worker = await this._registerFresh(workerId, ws, repo);
      if (!worker) return; // error already sent
      this.workerLog(workerId, "hello reserved");
      worker.markReserved();
      this.sendMsg(worker, { type: "hello_ack", workerId: worker.workerId, status: "reserved", repoStatus: repo.status });
    } catch (err) {
      log(`ERROR handleReservedHello ${workerId}: ${fmtError(err)}`);
      this.sendError(ws, `Internal error during reserved hello: ${fmtError(err)}`, false, workerId, repo.id);
    }
  }

  async handleWorkerReady(workerId: string): Promise<void> {
    const worker = Worker.fromRegistry(workerId);
    if (!worker) {
      log(`[worker ${shortWorkerId(workerId)}] worker_ready received but worker not in registry — ignoring`);
      return;
    }
    this.workerLog(workerId, "worker_ready");
    await worker.becomeReady();
  }

  async handleWorkerReserve(workerId: string): Promise<void> {
    const worker = Worker.fromRegistry(workerId);
    if (!worker) {
      log(`[worker ${shortWorkerId(workerId)}] worker_reserved received but worker not in registry — ignoring`);
      return;
    }
    this.workerLog(workerId, "worker_reserved");
    worker.markReserved();
  }

  async handleActivateRepo(workerId: string, ws: WebSocket): Promise<void> {
    this.workerLog(workerId, "activate_repo");
    const worker = Worker.fromRegistry(workerId);
    if (!worker) {
      log(`[worker ${shortWorkerId(workerId)}] activate_repo received but worker not registered — ignoring`);
      return;
    }
    const repo = worker.repo;
    try {
      await repo.activate();
      this.workerLog(workerId, `repo ${repo.fullName} activated`);
    } catch (err) {
      log(`ERROR Failed to activate repo ${repo.fullName}: ${fmtError(err)}`);
      this.sendError(ws, `Failed to activate repo: ${fmtError(err)}`, false, workerId, repo.id);
      return;
    }
    try {
      await repo.taskManager.loadIssuesFromGithub();
      this.workerLog(workerId, `loaded issues for ${repo.fullName}`);
    } catch (err) {
      log(`ERROR Failed to load issues for ${repo.fullName}: ${fmtError(err)}`);
      // Non-fatal: repo is active, tasks can still be created via webhooks.
    }
    this.sendMsg(worker, { type: "repo_activated", workerId: worker.workerId });
  }

  async handleClaimTask(workerId: string, msg: Extract<Wire.WorkerMessage, { type: "claim_task" }>): Promise<void> {
    const worker = Worker.fromRegistry(workerId);
    if (!worker) {
      log(`[worker ${shortWorkerId(workerId)}] claim_task received but worker not in registry`);
      return;
    }
    this.workerLog(workerId, `claim_task #${msg.taskId}`);
    const outcome = await worker.repo.taskManager.claimTask(worker, msg.taskId);
    if (!outcome.ok) {
      this.sendMsg(worker, { type: "foreman_error", message: outcome.error, fatal: false }, { logTaskId: msg.taskId });
      return;
    }
    const { task } = outcome;
    this.sendMsg(worker, { type: "task_assigned", taskId: task.taskId, issue: task.toAssignmentPayload() });
    this.workerLog(workerId, `→ claim task_assigned #${task.issueNumber} "${task.title}"`);
  }

  // ── Routing ─────────────────────────────────────────────────────────────────

  forwardEvent(task: Task, evt: WebhookEvent, ref: string, seqId?: number): void {
    if (task.workerId) {
      const worker = Worker.fromRegistry(task.workerId);
      if (worker && worker.currentTask?.taskId !== task.taskId) {
        log(`[task ${ref}] ${evt.eventName} dropped — worker ${shortWorkerId(task.workerId)} is now on a different task`);
        return;
      }
      if (worker?.status === "disconnected") {
        task.queueEvent(evt);
        log(`[task ${ref}] ${evt.eventName} queued (worker ${shortWorkerId(task.workerId)} disconnected)`);
      } else if (worker) {
        const sent = this.sendMsg(
          worker,
          { type: "event_notification", taskId: task.taskId, event: evt.toWorkerPayload(), ...(seqId !== undefined && { seqId }) },
          { onError: (err) => {
            task.queueEvent(evt);
            log(`[task ${ref}] ${evt.eventName} requeued (send error: ${fmtError(err)})`);
          } },
        );
        if (sent) {
          log(`[worker ${shortWorkerId(task.workerId)}] → event_notification ${ref} ${evt.eventName}`);
        } else {
          task.queueEvent(evt);
          log(`[task ${ref}] ${evt.eventName} queued (worker send failed)`);
        }
      } else {
        // Worker not in registry — treat as disconnected and queue for reconnect.
        task.queueEvent(evt);
        log(`[task ${ref}] ${evt.eventName} queued — worker ${shortWorkerId(task.workerId)} not in registry`);
      }
    }
  }

  async assignWork(): Promise<void> {
    for (const taskManager of TaskManager.all()) {
      await this.assignWorkForRepo(taskManager);
    }
  }

  private async assignWorkForRepo(taskManager: TaskManager): Promise<void> {
    for (const outcome of await taskManager.assignIdleWorkers()) {
      if (!outcome.ok) {
        log(`ERROR Failed to persist assignment: ${fmtError(outcome.err)}`);
        log(`[worker ${shortWorkerId(outcome.worker.workerId)}] → idle (DB write failed)`);
        continue;
      }
      const { task, worker } = outcome;
      this.sendMsg(worker, {
        type: "task_assigned",
        taskId: task.taskId,
        issue: task.toAssignmentPayload(),
      });
      log(`[worker ${shortWorkerId(worker.workerId)}] → task_assigned #${task.issueNumber} "${task.title}"`);
    }
  }

  /** Resolve the Repo from a webhook payload's repository.full_name, creating it if needed. */
  private async resolveRepo(p: R): Promise<Repo> {
    const repoFullName = strProp(p.repository, "full_name");
    if (!repoFullName) throw new Error("Webhook payload missing repository.full_name");
    return Repo.findOrCreate(repoFullName);
  }

  async routePrEvent(p: R, evt: WebhookEvent): Promise<RouteResult> {
    const pr = p.pull_request as R | undefined;
    const prNumber = numProp(pr, "number");
    if (prNumber === null) return { task: null, ref: "" };

    const repo = await this.resolveRepo(p);
    const manager = repo.taskManager;
    const ref = `PR #${prNumber}`;

    if (p.action === "synchronize") return { task: await repo.getTaskByPr(prNumber), ref, forward: false };

    if (p.action === "opened" && pr) {
      return { task: await manager.handlePrOpenedEvent(prNumber, String(pr.body ?? ""), strProp(pr.head, "ref")), ref };
    }

    if (p.action === "closed" && pr) {
      return { task: await manager.handlePrClosedEvent(prNumber, !!pr.merged), ref };
    }

    if (p.action === "edited" && pr) {
      const changes = p.changes as R | undefined;
      let task: Task | null = null;
      if (changes?.body) {
        task = await manager.handlePrEditedEvent(prNumber, String(pr.body ?? ""), strProp(pr.head, "ref"));
      }
      if (!task) task = await repo.getTaskByPr(prNumber);
      return { task, ref };
    }

    return { task: await repo.getTaskByPr(prNumber), ref };
  }

  async routePrReviewEvent(p: R, evt: WebhookEvent): Promise<RouteResult> {
    const pr = p.pull_request as R | undefined;
    const prNumber = numProp(pr, "number");
    if (prNumber === null) return { task: null, ref: "" };
    const repo = await this.resolveRepo(p);
    return { task: await repo.getTaskByPr(prNumber), ref: `PR #${prNumber}` };
  }

  async routeCheckEvent(p: R, evt: WebhookEvent, name: string): Promise<RouteResult> {
    const inner = (name === "check_run" ? p.check_run : p.check_suite) as R | undefined;
    const prs = inner?.pull_requests as Array<{ number: number }> | undefined;
    const headBranch = name === "check_run"
      ? strProp(inner?.check_suite, "head_branch") ?? ""
      : strProp(inner, "head_branch") ?? "";

    const repo = await this.resolveRepo(p);
    const found = await repo.taskManager.getTaskForCheckEvent(
      prs?.map((pr) => pr.number) ?? [],
      headBranch,
    );
    if (found) return { task: found.task, ref: found.ref };
    return { task: null, ref: "" };
  }

  /**
   * Phase 1: apply foreman-side effects for an issue event.
   * Returns the task to forward to the worker, or null to skip notification.
   * Returning null is an explicit signal: newly-enqueued tasks have no worker yet,
   * unlabeled doesn't need worker notification, and errors skip forwarding to avoid
   * notifying the worker of state the foreman failed to record.
   */
  private async applyIssueEffects(p: R, issue: R, issueNumber: number): Promise<Task | null> {
    const repo = await this.resolveRepo(p);
    const manager = repo.taskManager;

    let task = await repo.getTaskByIssue(issueNumber);
    // GitHub issue_comment events on PRs have the PR number in issue.number.
    if (!task) task = await repo.getTaskByPr(issueNumber);

    const action = p.action as string | undefined;

    if (!task) {
      // Check if this webhook should enqueue a new task.
      const labeledNow =
        action === "labeled" &&
        (p.label as R | undefined)?.name === this.config.taskLabel;
      const openedWithLabel =
        action === "opened" &&
        (issue.labels as Array<{ name: string }> | undefined)?.some((l) => l.name === this.config.taskLabel);

      if (labeledNow || openedWithLabel) {
        const labels = (issue.labels as Array<{ name: string }> | undefined)?.map((l) => l.name) ?? [];
        const enqueued = await manager.handleIssueLabeledEvent(
          issueNumber,
          String(issue.title ?? ""),
          String(issue.body ?? ""),
          labels,
          String(issue.state ?? "open"),
        ).catch((err: unknown) => {
          log(`ERROR Failed to persist task #${issueNumber}: ${fmtError(err)}`);
          return null;
        });
        if (!enqueued) return null;
        log(`[task #${issueNumber}] enqueued via issues/${action}`);
        return enqueued; // worker ignores labeled events; returned so task_id is logged in webhook_events
      }
      // No task found and not an enqueue event — still fall through so closed/reopened
      // can update blocker state (issue may be a dependency, not a task itself).
    }

    if (
      action === "unlabeled" &&
      (p.label as R | undefined)?.name === this.config.taskLabel
    ) {
      try {
        await manager.dequeueIssue(issueNumber);
        log(`[task #${issueNumber}] dequeued (label removed)`);
      } catch (err) {
        log(`ERROR Failed to dequeue task #${issueNumber}: ${fmtError(err)}`);
        return null; // error: skip notification
      }
      await this.assignWork();
      return null; // worker doesn't need to know the label was removed
    }

    if (action === "closed") {
      try {
        await manager.closeIssue(issueNumber);
      } catch (err) {
        log(`ERROR Failed to close issue #${issueNumber}: ${fmtError(err)}`);
        return null; // error: skip notification to avoid inconsistency
      }
      await this.assignWork();
    }

    if (action === "reopened") {
      try {
        await manager.reopenIssue(issueNumber);
      } catch (err) {
        log(`ERROR Failed to reopen issue #${issueNumber}: ${fmtError(err)}`);
        return null; // error: skip notification to avoid inconsistency
      }
      await this.assignWork();
    }

    if (action === "edited") {
      const changes = p.changes as R | undefined;
      if (task && (changes?.body || changes?.title)) {
        const newTitle = String(issue.title ?? task.title);
        const newBody = String(issue.body ?? task.body);
        const labels = (issue.labels as Array<{ name: string }> | undefined)?.map((l) => l.name) ?? task.labels;
        try {
          await task.updateContent(newTitle, newBody, labels);
        } catch (err) {
          log(`ERROR Failed to update content for task #${issueNumber}: ${fmtError(err)}`);
          return null;
        }
      }
      if (changes?.body && task) {
        manager.handleIssueBodyEditedEvent(
          issueNumber,
          String(issue.body ?? task.body),
        );
      }
    }

    return task; // null if no task (e.g., dependency issue — nothing to forward)
  }

  async routeIssueEvent(p: R, evt: WebhookEvent, issue: R, issueNumber: number): Promise<RouteResult> {
    return { task: await this.applyIssueEffects(p, issue, issueNumber), ref: `#${issueNumber}` };
  }

}
