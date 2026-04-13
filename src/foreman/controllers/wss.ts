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

// ── Event routing (exported for unit testing via createRouter) ────────────────

export interface RouteResult { taskId: string | null; workerId: string | null; }

export interface RoutingDeps {
  taskManager: TaskManager;
  repo: string;
  token: string;
  githubApiUrl?: string;
  taskLabel: string;
}

export interface Router {
  forwardEvent(task: Task, evt: WebhookEvent, ref: string): void;
  assignWork(): Promise<void>;
  startDepsLoad(issueNumber: number, body: string): void;
  routeEvent(name: string, p: R, evt: WebhookEvent): Promise<RouteResult>;
  routePrEvent(p: R, evt: WebhookEvent): Promise<RouteResult>;
  routePrReviewEvent(p: R, evt: WebhookEvent): Promise<RouteResult>;
  routeCheckEvent(p: R, evt: WebhookEvent, name: string): Promise<RouteResult>;
  routeIssueEvent(p: R, evt: WebhookEvent, issue: R, issueNumber: number): Promise<RouteResult>;
}

export function createRouter(
  deps: RoutingDeps,
  sendMsg: (workerId: string, msg: Wire.ForemanMessage, logTaskId?: string) => void,
  flog: (msg: string) => void,
): Router {
  const { taskManager, repo, token, githubApiUrl, taskLabel } = deps;

  async function assignWork(): Promise<void> {
    for (const outcome of await taskManager.assignIdleWorkers()) {
      if (!outcome.ok) {
        flog(`ERROR Failed to persist assignment: ${fmtError(outcome.err)}`);
        flog(`[worker ${shortWorkerId(outcome.workerId)}] → idle (DB write failed)`);
        continue;
      }
      const { task, queued, workerId: wid } = outcome;
      sendMsg(wid, {
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
      flog(`[worker ${shortWorkerId(wid)}] → task_assigned #${task.issueNumber} "${task.title}"`);
      for (const evt of queued) {
        sendMsg(wid, { type: "event_notification", taskId: task.taskId, event: evt.toWorkerPayload() });
        flog(`[worker ${shortWorkerId(wid)}] → event_notification #${task.issueNumber} ${evt.eventName} (queued)`);
      }
    }
  }

  function forwardEvent(task: Task, evt: WebhookEvent, ref: string): void {
    if (task.workerId) {
      const worker = Worker.get(task.workerId);
      if (worker && worker.currentTaskId !== task.taskId) {
        flog(`[task ${ref}] ${evt.eventName} dropped — worker ${shortWorkerId(task.workerId)} is now on a different task`);
        return;
      }
      if (worker?.status === "disconnected") {
        taskManager.queueEvent(task.taskId, evt);
        flog(`[task ${ref}] ${evt.eventName} queued (worker ${shortWorkerId(task.workerId)} disconnected)`);
      } else if (worker) {
        sendMsg(task.workerId, { type: "event_notification", taskId: task.taskId, event: evt.toWorkerPayload() });
        flog(`[worker ${shortWorkerId(task.workerId)}] → event_notification ${ref} ${evt.eventName}`);
      } else {
        flog(`[task ${ref}] ${evt.eventName} DROPPED — worker ${shortWorkerId(task.workerId)} not in registry (disconnected?)`);
      }
    } else if (task.status === "pending" || task.status === "blocked") {
      taskManager.queueEvent(task.taskId, evt);
      flog(`[task ${ref}] ${evt.eventName} queued (no worker assigned)`);
    }
  }

  function startDepsLoad(issueNumber: number, body: string): void {
    taskManager.fetchAndLoadDeps(issueNumber, body, { repo, token, apiUrl: githubApiUrl })
      .then(() => assignWork())
      .catch((err) => flog(`ERROR fetching deps for #${issueNumber}: ${fmtError(err)}`));
  }

  async function routePrEvent(p: R, evt: WebhookEvent): Promise<RouteResult> {
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
          if (branch) taskManager.registerBranch(branch, linkedTask.taskId);
          await linkedTask.registerPr(prNumber, branch ?? null).catch((err: unknown) =>
            flog(`ERROR Failed to register PR for task #${linkedTask.taskId}: ${fmtError(err)}`)
          );
          flog(`[task #${linkedIssue}] PR #${prNumber} registered`);
        }
      }
    }

    if (p.action === "closed" && pr && !pr.merged) {
      const task = await Task.getByPr(prNumber);
      if (task) {
        flog(`[task #${task.issueNumber}] PR #${prNumber} unregistered (closed without merging)`);
        await task.unregisterPr().catch((err: unknown) =>
          flog(`ERROR Failed to unregister PR #${prNumber}: ${fmtError(err)}`)
        );
        forwardEvent(task, evt, `PR #${prNumber}`);
        return result(task);
      }
      return result(null);
    }

    if (p.action === "closed" && pr && pr.merged) {
      const task = await Task.getByPr(prNumber);
      if (task) {
        flog(`[task #${task.issueNumber}] PR #${prNumber} merged`);
        await task.mergePr().catch((err: unknown) =>
          flog(`ERROR Failed to record PR #${prNumber} merge: ${fmtError(err)}`)
        );
        forwardEvent(task, evt, `PR #${prNumber}`);
        return result(task);
      }
      return result(null);
    }

    const task = await Task.getByPr(prNumber);
    if (task) forwardEvent(task, evt, `PR #${prNumber}`);
    return result(task);
  }

  async function routePrReviewEvent(p: R, evt: WebhookEvent): Promise<RouteResult> {
    function result(task: { taskId: string; workerId: string | null } | null | undefined): RouteResult {
      return { taskId: task?.taskId ?? null, workerId: task?.workerId ?? null };
    }

    const pr = p.pull_request as R | undefined;
    const prNumber = numProp(pr, "number");
    if (prNumber === null) return result(null);
    const task = await Task.getByPr(prNumber);
    if (task) forwardEvent(task, evt, `PR #${prNumber}`);
    return result(task);
  }

  async function routeCheckEvent(p: R, evt: WebhookEvent, name: string): Promise<RouteResult> {
    function result(task: { taskId: string; workerId: string | null } | null | undefined): RouteResult {
      return { taskId: task?.taskId ?? null, workerId: task?.workerId ?? null };
    }

    const inner = (name === "check_run" ? p.check_run : p.check_suite) as R | undefined;
    const prs = inner?.pull_requests as Array<{ number: number }> | undefined;

    if (prs && prs.length > 0) {
      const task = await Task.getByPr(prs[0].number);
      if (task) { forwardEvent(task, evt, `PR #${prs[0].number}`); return result(task); }
    }

    const headBranch = name === "check_run"
      ? strProp(inner?.check_suite, "head_branch") ?? ""
      : strProp(inner, "head_branch") ?? "";
    if (headBranch) {
      const task = await taskManager.getTaskForBranch(headBranch);
      if (task) { forwardEvent(task, evt, `branch ${headBranch}`); return result(task); }
    }
    return result(null);
  }

  async function routeIssueEvent(p: R, evt: WebhookEvent, issue: R, issueNumber: number): Promise<RouteResult> {
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
        (p.label as R | undefined)?.name === taskLabel;
      const openedWithLabel =
        action === "opened" &&
        (issue.labels as Array<{ name: string }> | undefined)?.some((l) => l.name === taskLabel);

      if (labeledNow || openedWithLabel) {
        const issueState = String(issue.state ?? "open");
        if (issueState === "closed") {
          flog(`[task #${issueNumber}] issues/${action}: ignoring — issue is closed (title: ${JSON.stringify(String(issue.title ?? ""))})`);
          return result(null);
        }

        const labels = (issue.labels as Array<{ name: string }> | undefined)?.map((l) => l.name) ?? [];
        // Track as open and persist to DB.
        await taskManager.enqueueIssue(String(issueNumber), issueNumber, repo, String(issue.title ?? ""), String(issue.body ?? ""), labels)
          .catch((err: unknown) => flog(`ERROR Failed to persist task #${issueNumber}: ${fmtError(err)}`));

        startDepsLoad(issueNumber, String(issue.body ?? ""));
        await assignWork();
        flog(`[task #${issueNumber}] enqueued via issues/${action}`);
        return { taskId: String(issueNumber), workerId: null };
      }
    }

    // ── Dependency graph updates ─────────────────────────────────────────────
    const action = p.action as string | undefined;

    if (
      action === "unlabeled" &&
      (p.label as R | undefined)?.name === taskLabel
    ) {
      await taskManager.dequeueIssue(issueNumber)
        .catch((err: unknown) => flog(`ERROR Failed to dequeue task #${issueNumber}: ${fmtError(err)}`));
      flog(`[task #${issueNumber}] dequeued (label removed)`);
      await assignWork();
      return result(task);
    }

    if (action === "closed") {
      await taskManager.closeIssue(issueNumber).catch((err: unknown) =>
        flog(`ERROR Failed to close issue #${issueNumber}: ${fmtError(err)}`)
      );
      await assignWork();
      return result(task);
    }

    if (action === "reopened") {
      await taskManager.reopenIssue(issueNumber).catch((err: unknown) =>
        flog(`ERROR Failed to reopen issue #${issueNumber}: ${fmtError(err)}`)
      );
      await assignWork();
      return result(task);
    }

    if (action === "edited") {
      const changes = p.changes as R | undefined;
      if (changes?.body) {
        const trackedTask = await Task.getByIssue(issueNumber);
        if (trackedTask) {
          const newBody = String(issue.body ?? "");
          taskManager.resetBlockers(issueNumber);
          startDepsLoad(issueNumber, newBody);
        }
      }
    }

    if (!task) return result(null);
    forwardEvent(task, evt, `#${issueNumber}`);
    return result(task);
  }

  async function routeEvent(name: string, p: R, evt: WebhookEvent): Promise<RouteResult> {
    if (name === "pull_request") {
      return routePrEvent(p, evt);
    }

    if (name === "pull_request_review" || name === "pull_request_review_comment") {
      return routePrReviewEvent(p, evt);
    }

    if (name === "check_run" || name === "check_suite") {
      return routeCheckEvent(p, evt, name);
    }

    const issue = p.issue as R | undefined;
    const issueNumber = numProp(issue, "number");
    if (issueNumber === null) return { taskId: null, workerId: null };

    return routeIssueEvent(p, evt, issue!, issueNumber);
  }

  return { forwardEvent, assignWork, startDepsLoad, routeEvent, routePrEvent, routePrReviewEvent, routeCheckEvent, routeIssueEvent };
}

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

/** Runtime dependencies for ForemanWss (all optional except taskManager). */
export interface ForemanDeps {
  taskManager: TaskManager;
  adminWss?: AdminWss;
}

type ForemanWssOptions = ForemanDeps & {
  config: Pick<BrunelConfig, "taskLabel" | "githubRepo" | "githubToken" | "githubApiUrl" | "workerSecret" | "pingIntervalMs">;
  server: http.Server;
};

export class ForemanWss {
  readonly wss: WebSocketServer;

  constructor({ config, server, taskManager, adminWss }: ForemanWssOptions) {
    const taskLabel = config.taskLabel;
    const repo = config.githubRepo;
    const token = config.githubToken;
    const githubApiUrl = config.githubApiUrl;
    const workerSecret = config.workerSecret;

    // Incrementing counter for unique broadcast IDs (React uses these as keys).
    let nextBroadcastId = 1;

    function flog(msg: string) {
      console.log(`${new Date().toISOString()} ${msg}`);
    }

    function broadcastMessageEvent(data: { direction: string; workerId: string | null; taskId: string | null; msgType: string; payload?: Record<string, unknown> }) {
      if (!adminWss) return;
      const summary = ForemanMessage.buildSummary(data.direction, data.msgType, data.taskId, data.payload ?? {});
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
      void ForemanMessage.log({ direction: "sent", workerId, taskId, msgType: msg.type, payload: msgPayload });
      broadcastMessageEvent({ direction: "sent", workerId, taskId, msgType: msg.type, payload: msgPayload });
    }

    function log(wid: string, line: string) {
      flog(`[worker ${shortWorkerId(wid)}] ${line}`);
    }

    async function broadcastSnapshot() {
      if (!adminWss) return;
      adminWss.broadcastSnapshot({
        tasks: await taskManager.getTasksForBroadcast(),
        workers: Worker.all().map((w) => w.toWire()),
      });
    }

    const debouncedBroadcast = debounce(broadcastSnapshot, 10);
    taskManager.on("changed", debouncedBroadcast);
    Worker.events.on("changed", debouncedBroadcast);

    const router = createRouter({ taskManager, repo, token, githubApiUrl, taskLabel }, sendMsg, flog);

    this.routeEvent = async (id: string, name: string, payload: unknown) => {
      const p = payload as R;
      const evt = WebhookEvent.fromIncoming(id, name, p);
      if (!evt.isMuted()) flog(evt.summary());

      const { taskId, workerId } = await router.routeEvent(name, p, evt);

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
      adminWss?.broadcastLogEvent({
        kind: "webhook",
        id: nextBroadcastId++,
        timestamp: new Date().toISOString(),
        taskId,
        workerId,
        summary: fmtEvent({ name: evt.eventName, payload: evt.payload }),
      });
    };

    this.reconcile = async () => {
      await router.assignWork();
    };

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

      async function handleWorkerHello(msg: Extract<Wire.WorkerMessage, { type: "worker_hello" }>) {
        if (workerSecret && msg.workerSecret !== workerSecret) {
          ws.close(4001, "unauthorized");
          return;
        }

        workerId = msg.workerId;
        const helloDeps = { ws, taskManager, sendMsg, log, flog };

        if (msg.status === "busy" && msg.taskId) {
          await handleBusyHello(workerId, msg.taskId, helloDeps);
        } else {
          await handleIdleHello(workerId, helloDeps);
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
          void ForemanMessage.log({
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
          await router.assignWork();
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
          void ForemanMessage.log({
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

    this.shutdown = () => new Promise((resolve) => {
      if (wss.clients.size === 0) { resolve(); return; }
      let remaining = wss.clients.size;
      for (const client of wss.clients) {
        client.once("close", () => { if (--remaining === 0) resolve(); });
        client.close(1001, "Server shutting down");
      }
    });
  }

  readonly routeEvent: (id: string, name: string, payload: unknown) => Promise<void>;
  readonly reconcile: () => Promise<void>;
  /** Close all connected worker clients with code 1001 and wait for their close events to fire. */
  readonly shutdown: () => Promise<void>;
}
