import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import * as Wire from "../../../shared/wire.js";
import { ForemanMessage } from "../models/foreman-message.js";
import { WebhookEvent } from "../models/webhook-event.js";
import type { AdminWss } from "../admin-ws.js";
import { fmtEvent } from "../event-fmt.js";
import { fmtError } from "../../utils.js";
import { shortWorkerId } from "../../../shared/utils.js";
import type { BrunelConfig } from "../../config.js";
import type { TaskManager } from "../models/task-manager.js";
import { Task } from "../models/task.js";
import { Worker } from "../models/worker.js";

type R = Record<string, unknown>;

function debounce(fn: () => void | Promise<void>, delayMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void fn(); }, delayMs);
  };
}

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

function extractLinkedIssueNumber(body: string): number | null {
  const match = /(?:closes|fixes|resolves)\s+#(\d+)/i.exec(body);
  return match ? parseInt(match[1], 10) : null;
}

export interface RouteResult { taskId: string | null; workerId: string | null; }

// ── Busy/idle hello handlers (exported for unit testing) ─────────────────────

export interface BusyHelloDeps {
  ws: WebSocket;
  taskManager: TaskManager;
  sendMsg: (workerId: string, msg: Wire.ForemanMessage, logTaskId?: string) => void;
  log: (workerId: string, line: string) => void;
  flog: (msg: string) => void;
}

export interface IdleHelloDeps {
  ws: WebSocket;
  sendMsg: (workerId: string, msg: Wire.ForemanMessage, logTaskId?: string) => void;
  log: (workerId: string, line: string) => void;
  flog: (msg: string) => void;
}

function flushQueuedEvents(
  workerId: string,
  taskId: string,
  issueRef: string | number,
  deps: Pick<BusyHelloDeps, "taskManager" | "sendMsg" | "log">,
): void {
  const { taskManager, sendMsg, log } = deps;
  for (const evt of taskManager.drainEvents(taskId)) {
    sendMsg(workerId, { type: "event_notification", taskId, event: evt.toWorkerPayload() });
    log(workerId, `→ event_notification #${issueRef} ${evt.eventName} (queued)`);
  }
}

function cancelWorker(
  workerId: string,
  taskId: string | undefined,
  deps: Pick<BusyHelloDeps, "ws" | "sendMsg">,
): void {
  Worker.register(workerId, deps.ws);
  deps.sendMsg(workerId, { type: "hello_ack", workerId, status: "cancelled" }, taskId);
}

async function reclaimWorker(
  workerId: string,
  task: Task,
  deps: BusyHelloDeps,
): Promise<void> {
  const { ws, sendMsg } = deps;
  const w = Worker.register(workerId, ws);
  w.assign(task.taskId);
  // Only call assign if task is not already complete (to preserve task status)
  if (task.status !== "complete") {
    await task.assign(workerId);
  }
  // For complete tasks, the task stays complete while worker finishes cleanup/finalization work
  sendMsg(workerId, { type: "hello_ack", workerId, status: "busy" }, task.taskId);
  flushQueuedEvents(workerId, task.taskId, task.issueNumber, deps);
}

/**
 * Handles the "busy" branch of a worker_hello — the worker is reconnecting
 * and claims to be mid-task. Decides among five cases:
 *
 * 1. Unknown task (numeric taskId) → create placeholder, reclaim
 * 2. Unknown task (non-numeric taskId) → cancel
 * 3. Complete task, same worker → reclaim for finalization
 * 4. Complete task, different worker → cancel
 * 5. Live task, different worker → cancel
 * 6. Otherwise (live task, same or no worker) → reclaim
 */
export async function handleBusyHello(
  workerId: string,
  claimedTaskId: string,
  deps: BusyHelloDeps,
): Promise<void> {
  const { log } = deps;
  const existing = await Task.get(claimedTaskId);

  if (!existing) {
    log(workerId, `hello busy task=#${claimedTaskId} — unknown task, respecting busy status`);
    const issueNumber = parseInt(claimedTaskId, 10);
    let placeholderTask: Task | null = null;
    if (!isNaN(issueNumber)) {
      placeholderTask = await Task.upsert(claimedTaskId, issueNumber, "", "", "", []);
    }
    if (placeholderTask) {
      await reclaimWorker(workerId, placeholderTask, deps);
    } else {
      cancelWorker(workerId, claimedTaskId, deps);
    }
  } else if (existing.status === "complete") {
    if (existing.workerId && existing.workerId !== workerId) {
      log(workerId, `hello busy task=#${claimedTaskId} — task complete but owned by another worker, cancelling`);
      cancelWorker(workerId, claimedTaskId, deps);
    } else {
      log(workerId, `hello busy task=#${claimedTaskId} — task already complete, reclaiming for finalization`);
      await reclaimWorker(workerId, existing, deps);
    }
  } else if (existing.workerId && existing.workerId !== workerId) {
    log(workerId, `hello busy task=#${claimedTaskId} — task taken by another worker`);
    cancelWorker(workerId, claimedTaskId, deps);
  } else {
    log(workerId, `hello busy task=#${claimedTaskId} — reclaimed`);
    await reclaimWorker(workerId, existing, deps);
  }
}

/**
 * Handles the "idle" branch of a worker_hello — the worker is connecting
 * fresh (or restarting without a task). Reverts any stale prior assignment,
 * registers the worker, and sends an idle hello_ack.
 */
export async function handleIdleHello(
  workerId: string,
  deps: IdleHelloDeps,
): Promise<void> {
  const { ws, sendMsg, log, flog } = deps;
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

// ── ForemanWss class ──────────────────────────────────────────────────────────

type ForemanWssOptions = {
  config: Pick<BrunelConfig, "taskLabel" | "githubRepo" | "githubToken" | "githubApiUrl" | "workerSecret" | "pingIntervalMs">;
  taskManager: TaskManager;
  server: http.Server;
  adminWss?: AdminWss;
};

export class ForemanWss {
  readonly wss: WebSocketServer;
  private readonly taskManager: TaskManager;
  private readonly repo: string;
  private readonly token: string;
  private readonly githubApiUrl?: string;
  private readonly taskLabel: string;
  private readonly adminWss?: AdminWss;
  private nextBroadcastId = 1;

  constructor({ config, server, taskManager, adminWss }: ForemanWssOptions) {
    this.taskManager = taskManager;
    this.repo = config.githubRepo;
    this.token = config.githubToken;
    this.githubApiUrl = config.githubApiUrl;
    this.taskLabel = config.taskLabel;
    this.adminWss = adminWss;

    const debouncedBroadcast = debounce(() => this.broadcastSnapshot(), 10);
    taskManager.on("changed", debouncedBroadcast);
    Worker.events.on("changed", debouncedBroadcast);

    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    const pingTimer = setInterval(() => {
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.ping();
      }
    }, config.pingIntervalMs);
    wss.on("close", () => clearInterval(pingTimer));

    wss.on("connection", (ws) => {
      let workerId = "";

      const handleWorkerHello = async (msg: Extract<Wire.WorkerMessage, { type: "worker_hello" }>) => {
        if (config.workerSecret && msg.workerSecret !== config.workerSecret) {
          ws.close(4001, "unauthorized");
          return;
        }

        workerId = msg.workerId;

        if (msg.status === "busy" && msg.taskId) {
          await handleBusyHello(workerId, msg.taskId, {
            ws,
            taskManager: this.taskManager,
            sendMsg: this.sendMsg.bind(this),
            log: this.log.bind(this),
            flog: this.flog.bind(this),
          });
        } else {
          await handleIdleHello(workerId, {
            ws,
            sendMsg: this.sendMsg.bind(this),
            log: this.log.bind(this),
            flog: this.flog.bind(this),
          });
        }
      };

      const handleTaskComplete = async (msg: Extract<Wire.WorkerMessage, { type: "task_complete" }>) => {
        this.log(workerId, `task_complete #${msg.taskId}`);
        const task = await Task.get(msg.taskId);
        if (task && task.workerId !== workerId) {
          this.log(workerId, `task_complete #${msg.taskId} ignored — owned by ${task.workerId ?? "nobody"}`);
          return;
        }
        if (task) {
          await task.complete().catch((err: unknown) =>
            this.flog(`ERROR Failed to mark task #${msg.taskId} complete: ${fmtError(err)}`)
          );
        }
        Worker.get(workerId)?.release();
      };

      const handleWorkerGoodbye = async (msg: Extract<Wire.WorkerMessage, { type: "worker_goodbye" }>) => {
        this.log(workerId, `worker_goodbye (task=${msg.taskId ?? "none"})`);
        if (msg.taskId) {
          const task = await Task.get(msg.taskId);
          if (task) {
            this.log(workerId, `reverting task #${task.issueNumber} to pending (worker_goodbye)`);
            await task.revert().catch((err: unknown) =>
              this.flog(`ERROR Failed to revert task #${msg.taskId} to pending: ${fmtError(err)}`)
            );
          }
        }
        Worker.get(workerId)?.remove();
      };

      ws.on("message", (data) => {
        void (async () => {
          let msg: Wire.WorkerMessage;
          try { msg = JSON.parse(data.toString()); } catch { return; }

          const rcvWorkerId = workerId || ((msg as { workerId?: string }).workerId ?? null);
          const rcvTaskId = (msg as { taskId?: string }).taskId ?? null;
          const rcvPayload = msg as unknown as Record<string, unknown>;
          void ForemanMessage.log({
            direction: "received",
            workerId: rcvWorkerId,
            taskId: rcvTaskId,
            msgType: msg.type,
            payload: rcvPayload,
          });
          this.broadcastMessageEvent({ direction: "received", workerId: rcvWorkerId, taskId: rcvTaskId, msgType: msg.type, payload: rcvPayload });

          if (msg.type === "worker_hello") await handleWorkerHello(msg);
          else if (msg.type === "task_complete") await handleTaskComplete(msg);
          else if (msg.type === "worker_goodbye") await handleWorkerGoodbye(msg);
          else { this.flog(`[worker ${workerId}] unknown message type: ${(msg as R).type}`); return; }
          await this.assignWork();
        })().catch(err => this.flog(`ERROR handling worker message: ${fmtError(err)}`));
      });

      ws.on("close", (code, reason) => {
        if (workerId) {
          const currentWorker = Worker.get(workerId);
          if (currentWorker && !currentWorker.isCurrentSocket(ws)) return;

          const reasonStr = reason?.length ? `: ${reason}` : "";
          this.log(workerId, `disconnected (code ${code}${reasonStr})`);
          const taskId = currentWorker?.currentTaskId ?? null;
          const disconnPayload = { code, reason: reason?.toString() ?? null };
          void ForemanMessage.log({
            direction: "received",
            workerId,
            taskId,
            msgType: "worker_disconnected",
            payload: disconnPayload,
          });
          this.broadcastMessageEvent({ direction: "received", workerId, taskId, msgType: "worker_disconnected", payload: disconnPayload });
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
    if (!evt.isMuted()) this.flog(evt.summary());

    let taskId: string | null = null;
    let workerId: string | null = null;

    if (name === "pull_request") {
      ({ taskId, workerId } = await this.routePrEvent(p, evt));
    } else if (name === "pull_request_review" || name === "pull_request_review_comment") {
      ({ taskId, workerId } = await this.routePrReviewEvent(p, evt));
    } else if (name === "check_run" || name === "check_suite") {
      ({ taskId, workerId } = await this.routeCheckEvent(p, evt, name));
    } else {
      const issue = p.issue as R | undefined;
      const issueNumber = numProp(issue, "number");
      if (issueNumber !== null) {
        ({ taskId, workerId } = await this.routeIssueEvent(p, evt, issue!, issueNumber));
      }
    }

    const action = typeof p.action === "string" ? p.action : null;
    const webhookIssueNumber = typeof (p.issue as R | undefined)?.number === "number" ? (p.issue as R).number as number : null;
    const webhookPrNumber = typeof (p.pull_request as R | undefined)?.number === "number" ? (p.pull_request as R).number as number : null;
    void WebhookEvent.log({
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
    this.adminWss?.broadcastLogEvent({
      kind: "webhook",
      id: this.nextBroadcastId++,
      timestamp: new Date().toISOString(),
      taskId,
      workerId,
      summary: fmtEvent({ name: evt.eventName, payload: evt.payload }),
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

  flog(msg: string): void {
    console.log(`${new Date().toISOString()} ${msg}`);
  }

  sendMsg(workerId: string, msg: Wire.ForemanMessage, logTaskId?: string): void {
    const taskId = logTaskId ?? (("taskId" in msg ? msg.taskId : null) ?? null);
    Worker.get(workerId)?.send(msg);
    const msgPayload = msg as unknown as Record<string, unknown>;
    void ForemanMessage.log({ direction: "sent", workerId, taskId, msgType: msg.type, payload: msgPayload });
    this.broadcastMessageEvent({ direction: "sent", workerId, taskId, msgType: msg.type, payload: msgPayload });
  }

  private broadcastMessageEvent(data: { direction: string; workerId: string | null; taskId: string | null; msgType: string; payload?: Record<string, unknown> }): void {
    if (!this.adminWss) return;
    const summary = ForemanMessage.buildSummary(data.direction, data.msgType, data.taskId, data.payload ?? {});
    this.adminWss.broadcastLogEvent({
      kind: "message",
      id: this.nextBroadcastId++,
      timestamp: new Date().toISOString(),
      taskId: data.taskId,
      workerId: data.workerId,
      summary,
    });
  }

  private async broadcastSnapshot(): Promise<void> {
    if (!this.adminWss) return;
    this.adminWss.broadcastSnapshot({
      tasks: await this.taskManager.getTasksForBroadcast(),
      workers: Worker.all().map((w) => w.toWire()),
    });
  }

  private log(wid: string, line: string): void {
    this.flog(`[worker ${shortWorkerId(wid)}] ${line}`);
  }

  // ── Routing ─────────────────────────────────────────────────────────────────

  forwardEvent(task: Task, evt: WebhookEvent, ref: string): void {
    if (task.workerId) {
      const worker = Worker.get(task.workerId);
      if (worker && worker.currentTaskId !== task.taskId) {
        this.flog(`[task ${ref}] ${evt.eventName} dropped — worker ${shortWorkerId(task.workerId)} is now on a different task`);
        return;
      }
      if (worker?.status === "disconnected") {
        this.taskManager.queueEvent(task.taskId, evt);
        this.flog(`[task ${ref}] ${evt.eventName} queued (worker ${shortWorkerId(task.workerId)} disconnected)`);
      } else if (worker) {
        this.sendMsg(task.workerId, { type: "event_notification", taskId: task.taskId, event: evt.toWorkerPayload() });
        this.flog(`[worker ${shortWorkerId(task.workerId)}] → event_notification ${ref} ${evt.eventName}`);
      } else {
        this.flog(`[task ${ref}] ${evt.eventName} DROPPED — worker ${shortWorkerId(task.workerId)} not in registry (disconnected?)`);
      }
    } else if (task.status === "pending" || task.status === "blocked") {
      this.taskManager.queueEvent(task.taskId, evt);
      this.flog(`[task ${ref}] ${evt.eventName} queued (no worker assigned)`);
    }
  }

  async assignWork(): Promise<void> {
    for (const outcome of await this.taskManager.assignIdleWorkers()) {
      if (!outcome.ok) {
        this.flog(`ERROR Failed to persist assignment: ${fmtError(outcome.err)}`);
        this.flog(`[worker ${shortWorkerId(outcome.workerId)}] → idle (DB write failed)`);
        continue;
      }
      const { task, queued, workerId: wid } = outcome;
      this.sendMsg(wid, {
        type: "task_assigned",
        taskId: task.taskId,
        issue: {
          number: task.issueNumber,
          title: task.title,
          body: task.body,
          labels: task.labels,
          repoUrl: task.repoUrl,
        },
      });
      this.flog(`[worker ${shortWorkerId(wid)}] → task_assigned #${task.issueNumber} "${task.title}"`);
      for (const evt of queued) {
        this.sendMsg(wid, { type: "event_notification", taskId: task.taskId, event: evt.toWorkerPayload() });
        this.flog(`[worker ${shortWorkerId(wid)}] → event_notification #${task.issueNumber} ${evt.eventName} (queued)`);
      }
    }
  }

  private startDepsLoad(issueNumber: number, body: string): void {
    this.taskManager.fetchAndLoadDeps(issueNumber, body, { repo: this.repo, token: this.token, apiUrl: this.githubApiUrl })
      .then(() => this.assignWork())
      .catch((err) => this.flog(`ERROR fetching deps for #${issueNumber}: ${fmtError(err)}`));
  }

  async routePrEvent(p: R, evt: WebhookEvent): Promise<RouteResult> {
    function result(task: { taskId: string; workerId: string | null } | null | undefined): RouteResult {
      return { taskId: task?.taskId ?? null, workerId: task?.workerId ?? null };
    }

    const pr = p.pull_request as R | undefined;
    const prNumber = numProp(pr, "number");
    if (prNumber === null) return result(null);

    if (p.action === "synchronize") return result(await Task.getByPr(prNumber));

    if (p.action === "opened" && pr) {
      const linkedIssue = extractLinkedIssueNumber(String(pr.body ?? ""));
      if (linkedIssue !== null) {
        const linkedTask = await Task.getByIssue(linkedIssue);
        if (linkedTask) {
          const branch = strProp(pr.head, "ref");
          if (branch) this.taskManager.registerBranch(branch, linkedTask.taskId);
          await linkedTask.registerPr(prNumber, branch ?? null).catch((err: unknown) =>
            this.flog(`ERROR Failed to register PR for task #${linkedTask.taskId}: ${fmtError(err)}`)
          );
          this.flog(`[task #${linkedIssue}] PR #${prNumber} registered`);
        }
      }
    }

    if (p.action === "closed" && pr && !pr.merged) {
      const task = await Task.getByPr(prNumber);
      if (task) {
        this.flog(`[task #${task.issueNumber}] PR #${prNumber} unregistered (closed without merging)`);
        await task.unregisterPr().catch((err: unknown) =>
          this.flog(`ERROR Failed to unregister PR #${prNumber}: ${fmtError(err)}`)
        );
        this.forwardEvent(task, evt, `PR #${prNumber}`);
        return result(task);
      }
      return result(null);
    }

    if (p.action === "closed" && pr && pr.merged) {
      const task = await Task.getByPr(prNumber);
      if (task) {
        this.flog(`[task #${task.issueNumber}] PR #${prNumber} merged`);
        await task.mergePr().catch((err: unknown) =>
          this.flog(`ERROR Failed to record PR #${prNumber} merge: ${fmtError(err)}`)
        );
        this.forwardEvent(task, evt, `PR #${prNumber}`);
        return result(task);
      }
      return result(null);
    }

    const task = await Task.getByPr(prNumber);
    if (task) this.forwardEvent(task, evt, `PR #${prNumber}`);
    return result(task);
  }

  async routePrReviewEvent(p: R, evt: WebhookEvent): Promise<RouteResult> {
    function result(task: { taskId: string; workerId: string | null } | null | undefined): RouteResult {
      return { taskId: task?.taskId ?? null, workerId: task?.workerId ?? null };
    }

    const pr = p.pull_request as R | undefined;
    const prNumber = numProp(pr, "number");
    if (prNumber === null) return result(null);
    const task = await Task.getByPr(prNumber);
    if (task) this.forwardEvent(task, evt, `PR #${prNumber}`);
    return result(task);
  }

  async routeCheckEvent(p: R, evt: WebhookEvent, name: string): Promise<RouteResult> {
    function result(task: { taskId: string; workerId: string | null } | null | undefined): RouteResult {
      return { taskId: task?.taskId ?? null, workerId: task?.workerId ?? null };
    }

    const inner = (name === "check_run" ? p.check_run : p.check_suite) as R | undefined;
    const prs = inner?.pull_requests as Array<{ number: number }> | undefined;

    if (prs && prs.length > 0) {
      const task = await Task.getByPr(prs[0].number);
      if (task) { this.forwardEvent(task, evt, `PR #${prs[0].number}`); return result(task); }
    }

    const headBranch = name === "check_run"
      ? strProp(inner?.check_suite, "head_branch") ?? ""
      : strProp(inner, "head_branch") ?? "";
    if (headBranch) {
      const task = await this.taskManager.getTaskForBranch(headBranch);
      if (task) { this.forwardEvent(task, evt, `branch ${headBranch}`); return result(task); }
    }
    return result(null);
  }

  async routeIssueEvent(p: R, evt: WebhookEvent, issue: R, issueNumber: number): Promise<RouteResult> {
    function result(task: { taskId: string; workerId: string | null } | null | undefined): RouteResult {
      return { taskId: task?.taskId ?? null, workerId: task?.workerId ?? null };
    }

    let task = await Task.getByIssue(issueNumber);
    // GitHub issue_comment events on PRs have the PR number in issue.number.
    if (!task) task = await Task.getByPr(issueNumber);

    // If the issue isn't queued yet, check if this webhook should enqueue it.
    if (!task) {
      const action = p.action as string | undefined;
      const labeledNow =
        action === "labeled" &&
        (p.label as R | undefined)?.name === this.taskLabel;
      const openedWithLabel =
        action === "opened" &&
        (issue.labels as Array<{ name: string }> | undefined)?.some((l) => l.name === this.taskLabel);

      if (labeledNow || openedWithLabel) {
        const issueState = String(issue.state ?? "open");
        if (issueState === "closed") {
          this.flog(`[task #${issueNumber}] issues/${action}: ignoring — issue is closed (title: ${JSON.stringify(String(issue.title ?? ""))})`);
          return result(null);
        }

        const labels = (issue.labels as Array<{ name: string }> | undefined)?.map((l) => l.name) ?? [];
        // Track as open and persist to DB.
        await this.taskManager.enqueueIssue(String(issueNumber), issueNumber, this.repo, String(issue.title ?? ""), String(issue.body ?? ""), labels)
          .catch((err: unknown) => this.flog(`ERROR Failed to persist task #${issueNumber}: ${fmtError(err)}`));

        this.startDepsLoad(issueNumber, String(issue.body ?? ""));
        await this.assignWork();
        this.flog(`[task #${issueNumber}] enqueued via issues/${action}`);
        return { taskId: String(issueNumber), workerId: null };
      }
    }

    // ── Dependency graph updates ─────────────────────────────────────────────
    const action = p.action as string | undefined;

    if (
      action === "unlabeled" &&
      (p.label as R | undefined)?.name === this.taskLabel
    ) {
      await this.taskManager.dequeueIssue(issueNumber)
        .catch((err: unknown) => this.flog(`ERROR Failed to dequeue task #${issueNumber}: ${fmtError(err)}`));
      this.flog(`[task #${issueNumber}] dequeued (label removed)`);
      await this.assignWork();
      return result(task);
    }

    if (action === "closed") {
      await this.taskManager.closeIssue(issueNumber).catch((err: unknown) =>
        this.flog(`ERROR Failed to close issue #${issueNumber}: ${fmtError(err)}`)
      );
      await this.assignWork();
      return result(task);
    }

    if (action === "reopened") {
      await this.taskManager.reopenIssue(issueNumber).catch((err: unknown) =>
        this.flog(`ERROR Failed to reopen issue #${issueNumber}: ${fmtError(err)}`)
      );
      await this.assignWork();
      return result(task);
    }

    if (action === "edited") {
      const changes = p.changes as R | undefined;
      if (changes?.body) {
        const trackedTask = await Task.getByIssue(issueNumber);
        if (trackedTask) {
          const newBody = String(issue.body ?? "");
          this.taskManager.resetBlockers(issueNumber);
          this.startDepsLoad(issueNumber, newBody);
        }
      }
    }

    if (!task) return result(null);
    this.forwardEvent(task, evt, `#${issueNumber}`);
    return result(task);
  }

}
