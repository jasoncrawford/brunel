import { Webhooks } from "@octokit/webhooks";
import http from "http";
import "dotenv/config";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import { WebSocketServer, WebSocket } from "ws";
import type { WebSocket as WsSocket } from "ws";
import { EventEmitter } from "events";
import type { WorkerMessage, ForemanMessage, GitHubEvent, TaskIssue, LabeledIssueState, TaskStatus } from "./types.js";
import { fmtTimestamp, fmtEvent, setVerbose } from "./display.js";
import { loadConfig } from "./config.js";
import { setBlockers, fetchBlockers } from "./dependencies.js";
import { fetchIssueStates } from "./github.js";
import type { DependencyGraph } from "./dependencies.js";
import { type DbLogger, type TaskStore, createDbLogger, createTaskStore, createNullDbLogger, createNullTaskStore, buildMessageSummary } from "./db.js";
import type { AdminWss, WorkerSnapshot } from "./admin-ws.js";
import { fmtError } from "./utils.js";
import { shortWorkerId } from "../shared/utils.js";
import { TaskModel } from "./task-model.js";
import type { Task } from "./task-model.js";

function flog(msg: string) {
  console.log(`${fmtTimestamp()} ${msg}`);
}

type R = Record<string, unknown>;


// ── WorkerRegistry ────────────────────────────────────────────────────────────

interface WorkerState {
  workerId: string;
  ws: WsSocket;
  status: "idle" | "busy" | "disconnected";
  currentTaskId?: string;
  disconnectedAt?: Date;
  disconnectTimer?: ReturnType<typeof setTimeout>;
}

export class WorkerRegistry extends EventEmitter {
  private workers = new Map<string, WorkerState>();

  register(workerId: string, ws: WsSocket, status: "idle" | "busy", taskId?: string): void {
    this.workers.set(workerId, { workerId, ws, status, currentTaskId: taskId });
    this.emit("changed");
  }

  get(workerId: string): WorkerState | undefined {
    return this.workers.get(workerId);
  }

  remove(workerId: string) {
    this.workers.delete(workerId);
    this.emit("changed");
  }

  markDisconnected(workerId: string) {
    const w = this.workers.get(workerId);
    if (!w) return;
    w.status = "disconnected";
    w.disconnectedAt = new Date();
    this.emit("changed");
  }

  getIdleWorker(): WorkerState | null {
    for (const w of this.workers.values()) {
      if (w.status === "idle") return w;
    }
    return null;
  }

  getIdleWorkers(): WorkerState[] {
    return [...this.workers.values()].filter((w) => w.status === "idle");
  }

  getWorkerForTask(taskId: string): WorkerState | null {
    for (const w of this.workers.values()) {
      if (w.currentTaskId === taskId) return w;
    }
    return null;
  }

  assignTask(workerId: string, taskId: string) {
    const w = this.workers.get(workerId);
    if (!w) return;
    w.status = "busy";
    w.currentTaskId = taskId;
    this.emit("changed");
  }

  releaseWorker(workerId: string) {
    const w = this.workers.get(workerId);
    if (!w) return;
    w.status = "idle";
    w.currentTaskId = undefined;
    this.emit("changed");
  }

  startReclaimTimer(workerId: string, timeoutMs: number, onReclaim: () => void): void {
    const w = this.workers.get(workerId);
    if (!w) return;
    if (w.disconnectTimer) clearTimeout(w.disconnectTimer);
    w.disconnectTimer = setTimeout(onReclaim, timeoutMs);
  }

  cancelReclaimTimer(workerId: string): void {
    const w = this.workers.get(workerId);
    if (!w?.disconnectTimer) return;
    clearTimeout(w.disconnectTimer);
    w.disconnectTimer = undefined;
  }

  send(workerId: string, msg: ForemanMessage) {
    const w = this.workers.get(workerId);
    if (w?.ws.readyState === 1 /* OPEN */) {
      w.ws.send(JSON.stringify(msg));
    }
  }

  getWorkerSnapshots(): WorkerSnapshot[] {
    return [...this.workers.values()].map((w) => ({
      workerId: w.workerId,
      status: w.status,
      currentTaskId: w.currentTaskId,
    }));
  }
}

// TaskModel and Task are re-exported from src/task-model.ts for backwards compatibility.
export { TaskModel, type Task } from "./task-model.js";


function debounce(fn: () => void, delayMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(); }, delayMs);
  };
}

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

function truncTitle(title: unknown, max = 50): string {
  const s = String(title ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function summaryEvent(id: string, name: string, payload: unknown): string {
  const p = payload as Record<string, unknown>;
  const action = typeof p.action === "string" ? `/${p.action}` : "";
  const repo = (p.repository as Record<string, unknown> | undefined)?.full_name;
  const sender = (p.sender as Record<string, unknown> | undefined)?.login;

  let detail = "";
  const issue = p.issue as Record<string, unknown> | undefined;
  const pr = p.pull_request as Record<string, unknown> | undefined;

  if (issue) {
    detail = ` #${issue.number} "${truncTitle(issue.title)}"`;
  } else if (pr) {
    detail = ` #${pr.number} "${truncTitle(pr.title)}"`;
  } else if (name === "push") {
    const ref = String(p.ref ?? "");
    const count = (p.commits as unknown[] | undefined)?.length ?? 0;
    detail = ` ${ref} (${count} commit${count === 1 ? "" : "s"})`;
  } else if (name === "delete") {
    const ref = String(p.ref ?? "");
    if (ref) detail = ` ${ref}`;
  } else if (name === "check_run" || name === "check_suite" || name === "workflow_run" || name === "workflow_job") {
    const inner = p[name] as Record<string, unknown> | undefined;
    const prs = inner?.pull_requests as Array<{ number: number }> | undefined;
    if (prs && prs.length > 0) {
      detail = ` PR #${prs[0].number}`;
    } else {
      const headBranch = name === "check_run"
        ? String((inner?.check_suite as Record<string, unknown> | undefined)?.head_branch ?? "")
        : String(inner?.head_branch ?? "");
      if (headBranch) detail = ` ${headBranch}`;
    }
  }

  const parts: string[] = [`${name}${action}${detail}`];
  if (sender) parts.push(`by ${sender}`);
  if (repo) parts.push(`(${repo})`);

  return `[event] ${parts.join(" ")}`;
}

export function isMutedEvent(name: string): boolean {
  return name === "workflow_job" || name === "workflow_run";
}

function printEvent(id: string, name: string, payload: unknown) {
  if (isMutedEvent(name)) return;
  flog(summaryEvent(id, name, payload));
}

// ── HTTP server factory ───────────────────────────────────────────────────────

export function createHttpServer(
  webhooks: InstanceType<typeof Webhooks> | null,
  routeEvent: (id: string, name: string, payload: unknown) => void | Promise<void>,
  dbLogger?: DbLogger,
  taskStore?: TaskStore,
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
      const status = c.req.query("status") as "pending" | "assigned" | "complete" | undefined;
      const tasks = taskStore ? await taskStore.listTasks(status ? { status } : undefined) : [];
      return c.json(tasks);
    } catch (err) {
      flog(`ERROR API query failed: ${fmtError(err)}`);
      return c.json({ error: "internal error" }, 500);
    }
  });

  // ── Static files (React SPA) ───────────────────────────────────────────────
  // Serve dist/ for all other routes. Falls back to index.html for SPA routing.
  // Only active when dist/ exists (production build); in dev, Vite serves the frontend.
  app.use("*", async (c) => {
    const { createReadStream, existsSync } = await import("fs");
    const { join, extname } = await import("path");
    const { fileURLToPath } = await import("url");
    const root = join(fileURLToPath(import.meta.url), "../../dist");

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
  options: {
    taskLabel: string;
    graph?: DependencyGraph;
    repo?: string;
    token?: string;
    githubApiUrl?: string;
    dbLogger?: DbLogger;
    adminWss?: AdminWss;
    workerSecret?: string;
    pingIntervalMs: number;
    reclaimTimeoutMs: number;
  },
): ForemanWss {
  const taskLabel = options.taskLabel;
  const graph = options.graph ?? new Map<number, Set<number>>();
  // repo and token default to "" for unit tests, which don't exercise GitHub-calling paths
  const repo = options.repo ?? "";
  const token = options.token ?? "";
  const githubApiUrl = options.githubApiUrl;
  const dbLogger = options.dbLogger;
  const adminWss = options.adminWss;
  const workerSecret = options.workerSecret;
  const reclaimTimeoutMs = options.reclaimTimeoutMs;

  // Incrementing counter for unique broadcast IDs (React uses these as keys).
  let nextBroadcastId = 1;

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

  function broadcastSnapshot() {
    if (!adminWss) return;
    adminWss.broadcastSnapshot({
      tasks: taskModel.getTaskSnapshots(graph),
      workers: registry.getWorkerSnapshots(),
    });
  }

  const debouncedBroadcast = debounce(broadcastSnapshot, 10);
  taskModel.on("changed", debouncedBroadcast);
  registry.on("changed", debouncedBroadcast);

  function extractLinkedIssueNumber(body: string): number | null {
    const match = /(?:closes|fixes|resolves)\s+#(\d+)/i.exec(body);
    return match ? parseInt(match[1], 10) : null;
  }

  function forwardEvent(task: Task, evt: GitHubEvent, ref: string) {
    if (task.status === "assigned" && task.assignedWorkerId) {
      const worker = registry.get(task.assignedWorkerId);
      if (worker?.status === "disconnected") {
        taskModel.queueEvent(task.taskId, evt);
        flog(`[task ${ref}] ${evt.name} queued (worker ${shortWorkerId(task.assignedWorkerId)} disconnected)`);
      } else if (worker) {
        const evtMsg: ForemanMessage = { type: "event_notification", taskId: task.taskId, event: evt };
        sendMsg(task.assignedWorkerId, evtMsg);
        log(task.assignedWorkerId, `→ event_notification ${ref} ${evt.name}`);
      } else {
        flog(`[task ${ref}] ${evt.name} DROPPED — worker ${shortWorkerId(task.assignedWorkerId)} not in registry (disconnected?)`);
      }
    } else if (task.status === "pending") {
      taskModel.queueEvent(task.taskId, evt);
      flog(`[task ${ref}] ${evt.name} queued (no worker assigned)`);
    }
  }

  interface RouteResult { taskId: string | null; workerId: string | null; }

  // Routes the event to the appropriate worker and returns the associated task
  // and worker IDs. Separating this from logging ensures we always log exactly
  // once with the correct taskId and workerId.
  async function doRouteEvent(name: string, p: Record<string, unknown>, evt: GitHubEvent): Promise<RouteResult> {
    function result(task: { taskId: string; assignedWorkerId?: string } | null | undefined): RouteResult {
      return { taskId: task?.taskId ?? null, workerId: task?.assignedWorkerId ?? null };
    }

    // ── PR events: route by PR number ────────────────────────────────────────

    if (name === "pull_request") {
      const pr = p.pull_request as Record<string, unknown> | undefined;
      const prNumber = numProp(pr, "number");
      if (prNumber === null) return result(null);

      // Drop synchronize events — the worker pushed these commits itself.
      if (p.action === "synchronize") return result(taskModel.getTaskForPr(prNumber));

      // When a PR is opened, register it against a task if the body links an issue.
      // The worker opened the PR itself, so don't forward this event back to it.
      if (p.action === "opened" && pr) {
        const linkedIssue = extractLinkedIssueNumber(String(pr.body ?? ""));
        if (linkedIssue !== null) {
          const linkedTask = taskModel.getTaskForIssue(linkedIssue);
          if (linkedTask) {
            const branch = strProp(pr.head, "ref");
            if (branch) taskModel.registerBranch(branch, linkedTask.taskId);
            await taskModel.registerPr(linkedTask.taskId, prNumber, branch ?? null).catch((err: unknown) =>
              flog(`ERROR Failed to register PR for task #${linkedTask.taskId}: ${fmtError(err)}`)
            );
            flog(`[task #${linkedIssue}] PR #${prNumber} registered`);
            // Fall through to forward the event to the worker
          }
        }
        // Fall through: the PR is now registered (if linked), forward event below
      }

      // When a PR is closed without merging, clear it from the task so the issue
      // goes back to having no PR associated.
      if (p.action === "closed" && pr && !pr.merged) {
        const task = taskModel.getTaskForPr(prNumber);
        if (task) {
          flog(`[task #${task.issueNumber}] PR #${prNumber} unregistered (closed without merging)`);
          await taskModel.unregisterPr(prNumber).catch((err: unknown) =>
            flog(`ERROR Failed to unregister PR #${prNumber}: ${fmtError(err)}`)
          );
          forwardEvent(task, evt, `PR #${prNumber}`);
          return result(task);
        }
        return result(null);
      }

      const task = taskModel.getTaskForPr(prNumber);
      if (task) forwardEvent(task, evt, `PR #${prNumber}`);
      return result(task);
    }

    if (name === "pull_request_review" || name === "pull_request_review_comment") {
      const pr = p.pull_request as Record<string, unknown> | undefined;
      const prNumber = numProp(pr, "number");
      if (prNumber === null) return result(null);
      const task = taskModel.getTaskForPr(prNumber);
      if (task) forwardEvent(task, evt, `PR #${prNumber}`);
      return result(task);
    }

    if (name === "check_run" || name === "check_suite") {
      const inner = (name === "check_run" ? p.check_run : p.check_suite) as Record<string, unknown> | undefined;
      const prs = inner?.pull_requests as Array<{ number: number }> | undefined;

      // Try PR-number lookup first (sometimes populated), fall back to head_branch
      if (prs && prs.length > 0) {
        const task = taskModel.getTaskForPr(prs[0].number);
        if (task) { forwardEvent(task, evt, `PR #${prs[0].number}`); return result(task); }
      }

      // GitHub often sends empty pull_requests for branch-push-triggered checks;
      // use head_branch as the reliable fallback.
      const headBranch = name === "check_run"
        ? strProp(inner?.check_suite, "head_branch") ?? ""
        : strProp(inner, "head_branch") ?? "";
      if (headBranch) {
        const task = taskModel.getTaskForBranch(headBranch);
        if (task) { forwardEvent(task, evt, `branch ${headBranch}`); return result(task); }
      }
      return result(null);
    }

    // ── Issue events: route by issue number ──────────────────────────────────

    const issue = p.issue as Record<string, unknown> | undefined;
    const issueNumber = numProp(issue, "number");
    if (issueNumber === null) return result(null);

    let task = taskModel.getTaskForIssue(issueNumber);

    // GitHub issue_comment events on PRs have the PR number in issue.number.
    // Fall back to PR lookup so comments on worker-opened PRs are forwarded.
    if (!task) task = taskModel.getTaskForPr(issueNumber);

    // If the issue isn't queued yet, check if this webhook should enqueue it.
    if (!task && name === "issues" && issue) {
      const action = p.action as string | undefined;
      const labeledNow =
        action === "labeled" &&
        (p.label as Record<string, unknown> | undefined)?.name === taskLabel;
      const openedWithLabel =
        action === "opened" &&
        (issue.labels as Array<{ name: string }> | undefined)?.some((l) => l.name === taskLabel);

      if (labeledNow || openedWithLabel) {
        // Bug #489: delayed/retried webhooks for closed issues must not create tasks.
        // A closed issue re-labeled brunel:ready would otherwise upsert the DB row,
        // resetting status to pending and potentially overwriting title with a blank.
        const issueState = String(issue.state ?? "open");
        if (issueState === "closed") {
          flog(`[task #${issueNumber}] issues/${action}: ignoring — issue is closed (title: ${JSON.stringify(String(issue.title ?? ""))})`);
          return result(null);
        }

        const repoUrl = strProp(p.repository, "html_url") ?? "";
        const labels =
          (issue.labels as Array<{ name: string }> | undefined)?.map((l) => l.name) ?? [];
        const issueData: TaskIssue = {
          number: issueNumber,
          title: String(issue.title ?? ""),
          body: String(issue.body ?? ""),
          labels,
          repoUrl,
        };
        taskModel.trackIssue(issueNumber, issueData);
        startDepsLoad(issueNumber, issueData.body);
        await reconcile();
        flog(`[task #${issueNumber}] enqueued via ${name}/${action}`);
        // task is pending here (no worker yet); taskId is String(issueNumber)
        return { taskId: String(issueNumber), workerId: null };
      }
    }

    // ── Dependency graph updates ───────────────────────────────────────────────

    if (name === "issues" && issue) {
      const action = p.action as string | undefined;

      if (
        action === "unlabeled" &&
        (p.label as Record<string, unknown> | undefined)?.name === taskLabel
      ) {
        taskModel.untrackIssue(issueNumber);
        flog(`[task #${issueNumber}] dequeued (label removed)`);
        await reconcile();
        return result(task);
      }

      if (action === "closed") {
        // Remove from tracking and mark any assigned task complete atomically.
        await taskModel.closeIssue(issueNumber).catch((err: unknown) =>
          flog(`ERROR Failed to close issue #${issueNumber}: ${fmtError(err)}`)
        );

        // Close this issue as a blocker for any tasks that depend on it.
        // If unblocking a task, transition it from blocked → pending.
        const unblockPromises: Promise<void>[] = [];
        for (const [depIssueNum, blockers] of graph) {
          if (blockers.has(issueNumber)) {
            const blockedTask = taskModel.getTaskForIssue(depIssueNum);
            if (blockedTask && blockedTask.status === "blocked") {
              if (!taskModel.isBlocked(depIssueNum, graph)) {
                unblockPromises.push(
                  taskModel.unblock(blockedTask.taskId).catch((err: unknown) =>
                    flog(`ERROR Failed to unblock task #${blockedTask.taskId}: ${fmtError(err)}`)
                  )
                );
              }
            }
          }
        }

        // Await unblock DB writes before reconcile — ensures markPending lands
        // before markAssigned (which tryAssignWork awaits).
        await Promise.all(unblockPromises);
        await reconcile();
        return result(task);
      }

      if (action === "reopened") {
        taskModel.reopenIssue(issueNumber);
        await reconcile();
        return result(task);
      }

      if (action === "edited") {
        const changes = p.changes as Record<string, unknown> | undefined;
        if (changes?.body && taskModel.isTracked(issueNumber)) {
          const newBody = String(issue.body ?? "");
          taskModel.resetIssueDeps(issueNumber, newBody);
          startDepsLoad(issueNumber, newBody);
        }
        // fall through: let forwardEvent run for assigned tasks
      }
    }

    if (!task) return result(null);
    forwardEvent(task, evt, `#${issueNumber}`);
    return result(task);
  }

  async function routeEvent(id: string, name: string, payload: unknown) {
    const p = payload as Record<string, unknown>;
    const evt: GitHubEvent = { id, name, payload: p };

    const { taskId, workerId } = await doRouteEvent(name, p, evt);

    // Log webhook event to DB and broadcast to admin GUI with the resolved
    // taskId and workerId so events appear in task/worker history.
    const action = strProp(p, "action");
    const webhookIssueNumber = numProp(p.issue, "number");
    const webhookPrNumber = numProp(p.pull_request, "number");
    dbLogger?.logWebhookEvent({
      deliveryId: id,
      eventName: name,
      action,
      repo: strProp(p.repository, "full_name"),
      sender: strProp(p.sender, "login"),
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

  async function assignIdleWorkers(): Promise<void> {
    await Promise.all(
      registry.getIdleWorkers().map(w =>
        tryAssignWork(w.workerId).catch(err => flog(`ERROR tryAssignWork: ${fmtError(err)}`))
      )
    );
  }

  async function tryAssignWork(workerId: string): Promise<void> {
    const task = taskModel.nextPending(
      (t) => t.depsLoaded && !taskModel.isBlocked(t.issueNumber, graph),
    );
    if (task) {
      // Reserve in memory first to prevent concurrent double-assignment in the reconcile loop.
      registry.assignTask(workerId, task.taskId);
      const ok = await taskModel.assign(task.taskId, workerId);
      if (!ok) {
        flog(`ERROR Failed to persist assignment for task #${task.taskId}`);
        // Revert in-memory state — worker returns to idle.
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

  const wss = new WebSocketServer({ noServer: true });

  const pingTimer = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.ping();
    }
  }, options.pingIntervalMs);
  wss.on("close", () => clearInterval(pingTimer));

  wss.on("connection", (ws) => {
    let workerId = "";

    async function handleWorkerHello(msg: Extract<WorkerMessage, { type: "worker_hello" }>) {
      // Reject if workerSecret is configured and the message's secret doesn't match
      if (workerSecret && msg.workerSecret !== workerSecret) {
        ws.close(4001, "unauthorized");
        return;
      }

      workerId = msg.workerId;

      // Cancel any pending reclaim timer — worker has reconnected.
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

      function reclaimWorker(taskId: string, issueRef: string | number) {
        registry.register(workerId, ws, "busy", taskId);
        taskModel.assignInMemory(taskId, workerId);
        sendMsg(workerId, { type: "hello_ack", workerId, status: "busy" }, taskId);
        flushQueuedEvents(taskId, issueRef);
      }

      if (msg.status === "busy" && msg.taskId) {
        const existing = taskModel.get(msg.taskId);

        if (!existing) {
          // Task not in queue — issue may have been closed (marking the task complete in DB,
          // which startup skips) or the label may have been removed while worker was disconnected.
          // Restore from DB so title/body/labels are preserved on the dashboard.
          const issueNumber = parseInt(msg.taskId, 10);
          if (!isNaN(issueNumber)) {
            log(workerId, `hello busy task=#${msg.taskId} — task not in queue, restoring from DB for event forwarding`);
            await taskModel.restoreFromDb(msg.taskId, issueNumber);
          } else {
            log(workerId, `hello busy task=#${msg.taskId} — unknown task, respecting busy status`);
          }
          reclaimWorker(msg.taskId, msg.taskId);
        } else if (existing.status === "complete") {
          // Issue was closed (task marked done in memory). Cancel the worker — resuming work
          // on a closed issue would be incorrect. Finalize the DB record since the worker's
          // buffered task_complete will be discarded on cancelled.
          log(workerId, `hello busy task=#${msg.taskId} — task complete (issue closed), cancelling`);
          await taskModel.complete(msg.taskId).catch((err: unknown) =>
            flog(`ERROR Failed to mark task #${msg.taskId} complete: ${fmtError(err)}`)
          );
          cancelWorker(msg.taskId);
        } else if (existing.assignedWorkerId && existing.assignedWorkerId !== workerId) {
          // Task is assigned to a different worker — cancel.
          log(workerId, `hello busy task=#${msg.taskId} — task taken by another worker`);
          cancelWorker(msg.taskId);
        } else {
          // Task is pending or assigned to this worker — reclaim.
          log(workerId, `hello busy task=#${msg.taskId} — reclaimed`);
          reclaimWorker(msg.taskId, existing.issueNumber);
        }
      } else {
        // If the queue has a task assigned to this worker (from a prior foreman
        // session loaded from DB, or a disconnect during this session), revert it.
        const priorTask = taskModel.getAssignedTaskForWorker(workerId);
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
      const task = taskModel.get(msg.taskId);
      // Belt-and-suspenders ownership check: ignore if this worker doesn't own the task.
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

        // Log all received messages
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
        // Guard against stale close events from a previous connection. If the worker
        // has already reconnected with a new WebSocket, the old socket's close event
        // fires after the registry was updated to the new socket — ignore it.
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
          // Keep registry entry so queued events can be delivered on reconnect.
          registry.markDisconnected(workerId);
          // Start reclaim timer — if the worker doesn't reconnect in time, revert its task.
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
      // Destroy connections to unknown paths; /admin/ws is handled by a separate upgrade listener
      socket.destroy();
    }
  });

  function startDepsLoad(issueNumber: number, body: string): void {
    fetchBlockers(issueNumber, body, { repo, token, apiUrl: githubApiUrl })
      .then(async (blockers) => {
        setBlockers(issueNumber, blockers, graph);
        if (blockers.length > 0) {
          const states = await fetchIssueStates(blockers, { repo, token });
          for (const [num, state] of states) {
            taskModel.setIssueOpenState(num, state === "open");
          }
        }
        taskModel.markIssueDepsLoaded(issueNumber);
        // If the task is currently pending and is now blocked, persist blocked status.
        const task = taskModel.getTaskForIssue(issueNumber);
        if (task && task.status === "pending" && taskModel.isBlocked(issueNumber, graph)) {
          await taskModel.block(task.taskId);
        }
        await reconcile();
      })
      .catch((err) => flog(`ERROR fetching deps for #${issueNumber}: ${fmtError(err)}`));
  }

  async function reconcile() {
    const labeledIssues = taskModel.getLabeledIssues();

    // Step 1: materialise tasks for new labeledIssues entries.
    // Collect register promises — each fires an upsertTask that must land in the
    // DB before assignIdleWorkers can markAssigned on the same row.
    const registerPromises: Promise<void>[] = [];
    for (const [num, { issue, depsLoaded }] of labeledIssues) {
      if (!taskModel.getTaskForIssue(num)) {
        // Persist task record; on re-label of a completed issue, resets to pending.
        flog(`[task #${num}] reconcile: creating task (title: ${JSON.stringify(issue.title)})`);
        registerPromises.push(
          taskModel.register(String(num), num, repo, issue.title, issue.body, issue.labels, issue.repoUrl, depsLoaded)
            .catch((err: unknown) => flog(`ERROR Failed to persist task #${num}: ${fmtError(err)}`))
        );
      }
    }

    // Step 2: sync title/body/labels/depsLoaded from labeledIssues to existing tasks.
    // Tasks restored from the DB at startup need their content refreshed from GitHub
    // data once loadIssuesToQueue has run.
    const refreshPromises: Promise<void>[] = [];
    for (const [num, { issue, depsLoaded }] of labeledIssues) {
      const t = taskModel.getTaskForIssue(num);
      if (t) {
        refreshPromises.push(
          taskModel.refreshContent(t.taskId, issue.title, issue.body, issue.labels, depsLoaded)
            .catch((err: unknown) => flog(`ERROR Failed to refresh content for task #${t.taskId}: ${fmtError(err)}`))
        );
      }
    }

    // Step 3: remove pending/blocked tasks whose issue no longer has the label
    const cancelPromises: Promise<void>[] = [];
    for (const t of taskModel.getPendingAndBlockedTasks()) {
      if (!labeledIssues.has(t.issueNumber)) {
        cancelPromises.push(
          taskModel.cancel(t.taskId)
            .catch((err: unknown) => flog(`ERROR Failed to delete task #${t.taskId} from DB: ${fmtError(err)}`))
        );
      }
    }

    // Step 4: await all DB writes before assigning — ensures rows exist/are updated
    // before markAssigned runs on the same rows.
    await Promise.all([...registerPromises, ...refreshPromises, ...cancelPromises]);

    // Step 5: try assignment for all idle workers
    await assignIdleWorkers();
  }

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

  return { wss, routeEvent, reconcile, shutdown };
}

// Only start listening when run directly (not when imported by tests)
import { fileURLToPath } from "url";
import { loadIssuesToQueue } from "./github.js";
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const config = await loadConfig(process.argv);
  setVerbose(config.verbose);

  const registry = new WorkerRegistry();
  const graph: DependencyGraph = new Map();
  const openIssues = new Set<number>();
  const labeledIssues = new Map<number, LabeledIssueState>();
  const webhooks = config.webhookSecret
    ? new Webhooks({ secret: config.webhookSecret })
    : null;

  // Setup DB logger and task store (share the same Supabase client if configured)
  let dbLogger: DbLogger;
  let taskStore: TaskStore;
  if (config.supabaseUrl && config.supabaseSecretKey) {
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(config.supabaseUrl, config.supabaseSecretKey);
    dbLogger = createDbLogger(supabase);
    taskStore = createTaskStore(supabase);
    flog("Supabase logging enabled");
  } else {
    dbLogger = createNullDbLogger();
    taskStore = createNullTaskStore();
  }

  const taskModel = new TaskModel(taskStore, labeledIssues, openIssues);

  let foremanWss: ForemanWss;
  const server = createHttpServer(webhooks, (id, name, payload) => foremanWss.routeEvent(id, name, payload), dbLogger, taskStore);

  // Admin WebSocket broadcaster
  const { createAdminWss } = await import("./admin-ws.js");
  const adminWss = createAdminWss(server, () => ({
    tasks: taskModel.getTaskSnapshots(graph),
    workers: registry.getWorkerSnapshots(),
  }));

  foremanWss = createForemanWss(
    taskModel, registry, server,
    {
      graph,
      taskLabel: config.taskLabel,
      repo: config.githubRepo,
      token: config.githubToken,
      githubApiUrl: config.githubApiUrl,
      dbLogger,
      adminWss,
      workerSecret: config.workerSecret,
      reclaimTimeoutMs: config.workerReclaimTimeoutMs,
      pingIntervalMs: config.pingIntervalMs,
    },
  );

  if (webhooks) {
    webhooks.onAny(async ({ id, name, payload }) => {
      printEvent(id, name as string, payload);
      await foremanWss.routeEvent(id, name as string, payload);
    });
  }

  // Load all state before accepting WebSocket connections.

  // Step 1: Load active tasks from DB (primary source of truth).
  // Restores pending, assigned, and blocked tasks; skips complete.
  flog("[startup] step 1: loading active tasks from DB...");
  try {
    const activeTasks = await taskStore.listTasks();
    for (const row of activeTasks) {
      if (row.status === "complete") continue;
      taskModel.loadTask({
        taskId: row.taskId,
        issueNumber: row.issueNumber,
        title: row.title,
        body: row.body,
        labels: row.labels,
        repoUrl: `https://github.com/${row.repo}`,
        status: row.status as TaskStatus,
        workerId: row.workerId,
        prNumber: row.prNumber,
        branch: row.branch,
        depsLoaded: true,
      });
      flog(`[startup] restored task #${row.taskId} (${row.status})`);
    }
  } catch (err) {
    flog(`ERROR Failed to load tasks from DB: ${fmtError(err)}`);
    process.exit(1);
  }

  // Step 2: Fetch brunel:ready issues from GitHub for reconciliation.
  // Adds new tasks not yet in the DB; removes tasks whose label was removed.
  // Also rebuilds the in-memory dependency graph (derived state — not stored in DB).
  flog("[startup] step 2: fetching brunel:ready issues from GitHub for reconciliation...");
  try {
    await loadIssuesToQueue(labeledIssues, graph, openIssues, {
      repo: config.githubRepo,
      token: config.githubToken,
      taskLabel: config.taskLabel,
      apiUrl: config.githubApiUrl,
    });

    // After rebuilding the graph from GitHub, reconcile blocked status for tasks
    // that were loaded from DB. If a blocker closed while the foreman was down,
    // the DB still shows 'blocked' but the graph no longer reflects it.
    const startupPromises: Promise<void>[] = [];
    for (const t of taskModel.getPendingAndBlockedTasks()) {
      const shouldBeBlocked = taskModel.isBlocked(t.issueNumber, graph);
      if (t.status === "blocked" && !shouldBeBlocked) {
        startupPromises.push(
          taskModel.unblock(t.taskId).catch((err) =>
            flog(`ERROR Failed to mark task #${t.taskId} pending on startup: ${fmtError(err)}`)
          )
        );
      } else if (t.status === "pending" && shouldBeBlocked) {
        startupPromises.push(
          taskModel.block(t.taskId).catch((err) =>
            flog(`ERROR Failed to mark task #${t.taskId} blocked on startup: ${fmtError(err)}`)
          )
        );
      }
    }
    await Promise.all(startupPromises);
    await foremanWss.reconcile();
  } catch (err) {
    flog(`ERROR Failed to load issues from GitHub: ${fmtError(err)}`);
    process.exit(1);
  }

  // Step 3: start listening — state is fully loaded
  const httpBase = config.foremanUrl.replace(/^ws:\/\//, "http://").replace(/^wss:\/\//, "https://").replace(/\/$/, "");
  const wsBase = config.foremanUrl.replace(/\/$/, "");
  server.listen(config.port, () => {
    flog(`Listening on ${httpBase}/webhook`);
    flog(`WebSocket workers: ${wsBase}/worker`);
    flog(`Admin WebSocket: ${wsBase}/admin/ws`);
    flog("Waiting for events...");
  });

  // Graceful shutdown on SIGTERM: close all worker connections so their close
  // handlers fire and persist disconnect events to DB, then wait briefly for
  // the fire-and-forget Supabase writes to complete before exiting.
  process.on("SIGTERM", () => {
    flog("SIGTERM received, shutting down gracefully...");
    void foremanWss.shutdown().then(() => {
      setTimeout(() => {
        flog("Shutdown complete.");
        process.exit(0);
      }, 2000);
    });
  });
}
