import { WebSocket } from "ws";
import * as Wire from "../../../shared/wire.js";
import { WorkerMessenger } from "./worker-messenger.js";
import { Task } from "../models/task.js";
import { Worker } from "../models/worker.js";
import { Repo } from "../models/repo.js";
import { WebhookEvent } from "../models/webhook-event.js";
import { TaskManager } from "../models/task-manager.js";
import { GithubClient } from "../clients/github.js";
import { fmtError, log } from "../../utils.js";
import { shortWorkerId } from "../../../shared/utils.js";
import { getConfig } from "../../config.js";
import type { BrunelConfig } from "../../config.js";

type WorkerControllerOptions = {
  config: Pick<BrunelConfig, "taskLabel" | "githubToken" | "githubApiUrl" | "workerSecret" | "pingIntervalMs">;
  messenger: WorkerMessenger;
};

type MsgHandler = (workerId: string, ws: WebSocket, msg: Wire.WorkerMessage) => Promise<void>;

export class WorkerController {
  private readonly config: Pick<BrunelConfig, "taskLabel" | "githubToken" | "githubApiUrl" | "workerSecret" | "pingIntervalMs">;
  readonly messenger: WorkerMessenger;
  private readonly handlers = new Map<Wire.WorkerMessage["type"], MsgHandler>();

  constructor({ config, messenger }: WorkerControllerOptions) {
    this.config = config;
    this.messenger = messenger;

    this.handlers.set("worker_hello", async (workerId, ws, msg) => {
      await this.handleWorkerHello(workerId, ws, msg as Extract<Wire.WorkerMessage, { type: "worker_hello" }>);
    });
    this.handlers.set("task_complete", async (workerId, _ws, msg) => {
      await this.handleTaskComplete(workerId, msg as Extract<Wire.WorkerMessage, { type: "task_complete" }>);
    });
    this.handlers.set("worker_goodbye", async (workerId, _ws, msg) => {
      await this.handleWorkerGoodbye(workerId, msg as Extract<Wire.WorkerMessage, { type: "worker_goodbye" }>);
    });
    this.handlers.set("activate_repo", async (workerId, ws) => {
      await this.handleActivateRepo(workerId, ws);
    });
    this.handlers.set("claim_task", async (workerId, _ws, msg) => {
      await this.handleClaimTask(workerId, msg as Extract<Wire.WorkerMessage, { type: "claim_task" }>);
    });
    this.handlers.set("worker_ready", async (workerId) => {
      await this.handleWorkerReady(workerId);
    });
    this.handlers.set("worker_reserved", async (workerId) => {
      await this.handleWorkerReserve(workerId);
    });

    TaskManager.events.on("deps_loaded", (taskManager: TaskManager) => {
      this.assignWorkForRepo(taskManager).catch((err) => log(`ERROR assignWork after deps_loaded: ${fmtError(err)}`));
    });
  }

  async dispatch(workerId: string, ws: WebSocket, msg: Wire.WorkerMessage): Promise<void> {
    const handler = this.handlers.get(msg.type);
    if (handler) {
      await handler(workerId, ws, msg);
    } else {
      log(`[worker ${workerId}] unknown message type: ${(msg as Record<string, unknown>).type}`);
    }
  }

  async reconcile(): Promise<void> {
    await this.assignWork();
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
      const baseSeqId = await WebhookEvent.currentMaxId();
      this.messenger.send(worker, {
        type: "task_assigned",
        taskId: task.taskId,
        issue: task.toAssignmentPayload(),
        baseSeqId,
      });
      log(`[worker ${shortWorkerId(worker.workerId)}] → task_assigned #${task.issueNumber} "${task.title}"`);
    }
  }

  // ── Hello handlers ───────────────────────────────────────────────────────────

  private cancelWorker(worker: Worker, task: Task | null): void {
    this.messenger.send(worker, { type: "hello_ack", workerId: worker.workerId, status: "cancelled", repoStatus: worker.repo.status }, { logTaskId: task?.taskId });
  }

  private async replayMissedEvents(worker: Worker, task: Task, lastSeenEventSeqId: number): Promise<void> {
    let missed: import("../models/webhook-event.js").WebhookEvent[];
    try {
      missed = await WebhookEvent.queryMissedFor(task.taskId, lastSeenEventSeqId);
    } catch (err) {
      this._workerLog(worker.workerId, `ERROR querying missed events for #${task.issueNumber}: ${fmtError(err)}`);
      return;
    }
    for (const evt of missed) {
      const seqId = evt.id ?? undefined;
      this.messenger.send(
        worker,
        { type: "event_notification", taskId: task.taskId, event: evt.toWorkerPayload(), ...(seqId !== undefined && { seqId }) },
      );
      this._workerLog(worker.workerId, `→ event_notification #${task.issueNumber} ${evt.eventName} (replay seqId=${seqId})`);
    }
  }

  private async reclaimWorker(worker: Worker, task: Task, lastSeenEventSeqId?: number): Promise<void> {
    worker.assign(task);
    // Only call assign if task is not already complete (to preserve task status)
    if (task.status !== "complete") {
      await task.assign(worker);
    }
    // For complete tasks, the task stays complete while worker finishes cleanup/finalization work
    this.messenger.send(worker, { type: "hello_ack", workerId: worker.workerId, status: "assigned", repoStatus: worker.repo.status }, { logTaskId: task.taskId });
    if (lastSeenEventSeqId !== undefined) {
      await this.replayMissedEvents(worker, task, lastSeenEventSeqId);
    }
  }

  async handleWorkerHello(workerId: string, ws: WebSocket, msg: Extract<Wire.WorkerMessage, { type: "worker_hello" }>): Promise<void> {
    if (!msg.repo) {
      log(`[worker ${shortWorkerId(workerId)}] worker_hello missing required repo field — rejecting`);
      this.messenger.sendError(ws, "worker_hello must include a repo field", true, workerId, null);
      return;
    }

    let repo: Repo;
    try {
      repo = await Repo.findOrCreate(msg.repo);
    } catch (err) {
      log(`[worker ${shortWorkerId(workerId)}] failed to resolve repo ${msg.repo}: ${fmtError(err)}`);
      this.messenger.sendError(ws, `Failed to resolve repo ${msg.repo}: ${fmtError(err)}`, true, workerId, null);
      return;
    }

    const { appId, appPrivateKey } = getConfig();

    if (msg.githubToken && appId && appPrivateKey) {
      if (repo.installationId === null) {
        log(`[worker ${shortWorkerId(workerId)}] App not installed on ${msg.repo} — rejecting`);
        this.messenger.sendError(ws, `Brunel is not installed on ${msg.repo}.\nInstall it at: https://github.com/apps/brunel\nThen run brunel again.`, true, workerId, repo.id);
        return;
      }
      let authorized: boolean;
      try {
        const installation = await repo.installation;
        if (!installation) throw new Error("Installation record not found");
        const client = new GithubClient(msg.repo, installation.githubId);
        const username = await client.fetchUserLogin(msg.githubToken!);
        authorized = await client.verifyPushAccess(username);
      } catch (err) {
        log(`[worker ${shortWorkerId(workerId)}] GitHub token auth error: ${fmtError(err)}`);
        this.messenger.sendError(ws, `GitHub token auth failed: ${fmtError(err)}`, true, workerId, repo.id);
        return;
      }
      if (!authorized) {
        log(`[worker ${shortWorkerId(workerId)}] GitHub token auth rejected — insufficient repo access`);
        this.messenger.sendError(ws, "Insufficient repository access — push or admin permission required", true, workerId, repo.id);
        return;
      }
    } else {
      if (this.config.workerSecret && msg.workerSecret !== this.config.workerSecret) {
        log(`[worker ${shortWorkerId(workerId)}] worker secret mismatch — rejecting`);
        this.messenger.sendError(ws, "Unauthorized: invalid worker secret", true, workerId, repo.id);
        return;
      }
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
    this._workerLog(workerId, `task_complete #${msg.taskId} (nextState=${msg.nextState ?? "ready"})`);
    const task = await Task.get(msg.taskId);
    if (task && task.workerId !== workerId) {
      this._workerLog(workerId, `task_complete #${msg.taskId} ignored — owned by ${task.workerId ?? "nobody"}`);
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
    this._workerLog(workerId, `worker_goodbye (task=${msg.taskId ?? "none"}, complete=${msg.task_complete ?? false})`);
    if (msg.taskId) {
      const task = await Task.get(msg.taskId);
      if (task) {
        if (msg.task_complete) {
          this._workerLog(workerId, `completing task #${task.issueNumber} via worker_goodbye`);
          await task.complete(msg.stats).catch((err: unknown) =>
            log(`ERROR Failed to complete task #${msg.taskId}: ${fmtError(err)}`)
          );
        } else {
          this._workerLog(workerId, `reverting task #${task.issueNumber} to pending (worker_goodbye)`);
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
        this._workerLog(workerId, `hello busy task=#${claimedTaskId} — unknown task, respecting busy status`);
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
        this._workerLog(workerId, `hello busy task=#${claimedTaskId} — task belongs to repo ${existing.repo}, worker is from ${repo.fullName}`);
        this.cancelWorker(worker, existing);
      } else if (existing.status === "complete") {
        if (existing.workerId && existing.workerId !== workerId) {
          this._workerLog(workerId, `hello busy task=#${claimedTaskId} — task complete but owned by another worker, cancelling`);
          this.cancelWorker(worker, existing);
        } else {
          this._workerLog(workerId, `hello busy task=#${claimedTaskId} — task already complete, reclaiming for finalization`);
          await this.reclaimWorker(worker, existing, lastSeenEventSeqId);
        }
      } else if (existing.workerId && existing.workerId !== workerId) {
        this._workerLog(workerId, `hello busy task=#${claimedTaskId} — task taken by another worker`);
        this.cancelWorker(worker, existing);
      } else {
        this._workerLog(workerId, `hello busy task=#${claimedTaskId} — reclaimed`);
        await this.reclaimWorker(worker, existing, lastSeenEventSeqId);
      }
    } catch (err) {
      log(`ERROR handleAssignedHello ${workerId}: ${fmtError(err)}`);
      // DB error during task lookup or reclaim — recoverable: DB may be temporarily down.
      // Worker retries on reconnect and the operation succeeds once the DB recovers.
      this.messenger.sendError(ws, `Internal error during reconnection: ${fmtError(err)}`, false, workerId, repo.id);
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
        this._workerLog(workerId, `reverted stale task #${priorTask.taskId} to pending`);
      } catch (err) {
        log(`ERROR Failed to revert task #${priorTask.taskId} to pending: ${fmtError(err)}`);
        // DB error reverting prior task — recoverable: task stays assigned so the
        // failure is visible; a new idle assignment would create a double assignment.
        // Worker retries on reconnect and the revert succeeds once the DB recovers.
        this.messenger.sendError(ws, `Failed to revert prior task to pending: ${fmtError(err)}`, false, workerId, repo.id, priorTask.taskId);
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
      this._workerLog(workerId, "hello ready");
      this.messenger.send(worker, { type: "hello_ack", workerId: worker.workerId, status: "ready", repoStatus: repo.status });
    } catch (err) {
      log(`ERROR handleReadyHello ${workerId}: ${fmtError(err)}`);
      // DB error during worker lookup — recoverable: DB may be temporarily down.
      this.messenger.sendError(ws, `Internal error during ready hello: ${fmtError(err)}`, false, workerId, repo.id);
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
      this._workerLog(workerId, "hello reserved");
      worker.markReserved();
      this.messenger.send(worker, { type: "hello_ack", workerId: worker.workerId, status: "reserved", repoStatus: repo.status });
    } catch (err) {
      log(`ERROR handleReservedHello ${workerId}: ${fmtError(err)}`);
      this.messenger.sendError(ws, `Internal error during reserved hello: ${fmtError(err)}`, false, workerId, repo.id);
    }
  }

  async handleWorkerReady(workerId: string): Promise<void> {
    const worker = Worker.fromRegistry(workerId);
    if (!worker) {
      log(`[worker ${shortWorkerId(workerId)}] worker_ready received but worker not in registry — ignoring`);
      return;
    }
    this._workerLog(workerId, "worker_ready");
    await worker.becomeReady();
  }

  async handleWorkerReserve(workerId: string): Promise<void> {
    const worker = Worker.fromRegistry(workerId);
    if (!worker) {
      log(`[worker ${shortWorkerId(workerId)}] worker_reserved received but worker not in registry — ignoring`);
      return;
    }
    this._workerLog(workerId, "worker_reserved");
    worker.markReserved();
  }

  async handleActivateRepo(workerId: string, ws: WebSocket): Promise<void> {
    this._workerLog(workerId, "activate_repo");
    const worker = Worker.fromRegistry(workerId);
    if (!worker) {
      log(`[worker ${shortWorkerId(workerId)}] activate_repo received but worker not registered — ignoring`);
      return;
    }
    const repo = worker.repo;
    try {
      await repo.activate();
      this._workerLog(workerId, `repo ${repo.fullName} activated`);
    } catch (err) {
      log(`ERROR Failed to activate repo ${repo.fullName}: ${fmtError(err)}`);
      this.messenger.sendError(ws, `Failed to activate repo: ${fmtError(err)}`, false, workerId, repo.id);
      return;
    }
    try {
      await repo.taskManager.loadIssuesFromGithub();
      this._workerLog(workerId, `loaded issues for ${repo.fullName}`);
    } catch (err) {
      log(`ERROR Failed to load issues for ${repo.fullName}: ${fmtError(err)}`);
      // Non-fatal: repo is active, tasks can still be created via webhooks.
    }
    this.messenger.send(worker, { type: "repo_activated", workerId: worker.workerId });
  }

  async handleClaimTask(workerId: string, msg: Extract<Wire.WorkerMessage, { type: "claim_task" }>): Promise<void> {
    const worker = Worker.fromRegistry(workerId);
    if (!worker) {
      log(`[worker ${shortWorkerId(workerId)}] claim_task received but worker not in registry`);
      return;
    }
    this._workerLog(workerId, `claim_task #${msg.taskId}`);
    const outcome = await worker.repo.taskManager.claimTask(worker, msg.taskId);
    if (!outcome.ok) {
      this.messenger.send(worker, { type: "foreman_error", message: outcome.error, fatal: false }, { logTaskId: msg.taskId });
      return;
    }
    const { task } = outcome;
    const baseSeqId = await WebhookEvent.currentMaxId();
    this.messenger.send(worker, { type: "task_assigned", taskId: task.taskId, issue: task.toAssignmentPayload(), baseSeqId });
    this._workerLog(workerId, `→ claim task_assigned #${task.issueNumber} "${task.title}"`);
  }

  private _workerLog(wid: string, line: string): void {
    log(`[worker ${shortWorkerId(wid)}] ${line}`);
  }
}
