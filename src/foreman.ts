import { Webhooks } from "@octokit/webhooks";
import http from "http";
import "dotenv/config";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import { WebSocketServer, WebSocket } from "ws";
import type { WebSocket as WsSocket } from "ws";
import type { WorkerMessage, ForemanMessage, GitHubEvent, TaskIssue, LabeledIssueState } from "./types.js";
import { labelIssueDone } from "./github.js";
import { fmtTimestamp, setVerbose } from "./display.js";
import { loadConfig } from "./config.js";
import { isBlocked, setBlockers, fetchBlockers } from "./dependencies.js";
import { fetchIssueStates } from "./github.js";
import type { DependencyGraph } from "./dependencies.js";
import type { DbLogger, TaskAssignmentStore } from "./db.js";
import type { AdminWss, TaskSnapshot, WorkerSnapshot } from "./admin-ws.js";

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
}

export class WorkerRegistry {
  private workers = new Map<string, WorkerState>();

  register(workerId: string, ws: WsSocket, status: "idle" | "busy", taskId?: string): void {
    this.workers.set(workerId, { workerId, ws, status, currentTaskId: taskId });
  }

  get(workerId: string): WorkerState | undefined {
    return this.workers.get(workerId);
  }

  remove(workerId: string) {
    this.workers.delete(workerId);
  }

  markDisconnected(workerId: string) {
    const w = this.workers.get(workerId);
    if (!w) return;
    w.status = "disconnected";
    w.disconnectedAt = new Date();
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
  }

  releaseWorker(workerId: string) {
    const w = this.workers.get(workerId);
    if (!w) return;
    w.status = "idle";
    w.currentTaskId = undefined;
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

// ── TaskQueue ─────────────────────────────────────────────────────────────────

interface Task {
  taskId: string;
  issueNumber: number;
  title: string;
  body: string;
  labels: string[];
  repoUrl: string;
  status: "pending" | "assigned" | "complete";
  assignedWorkerId?: string;
  eventQueue: GitHubEvent[];
  /** True once fetchBlockers has resolved and the dependency graph is populated. */
  depsLoaded: boolean;
}

export class TaskQueue {
  private tasks = new Map<string, Task>();
  private prToTaskId = new Map<number, string>();
  private branchToTaskId = new Map<string, string>();

  addTask(t: Omit<Task, "status" | "assignedWorkerId" | "eventQueue" | "depsLoaded"> & Partial<Pick<Task, "status" | "eventQueue" | "depsLoaded">>) {
    this.tasks.set(t.taskId, {
      ...t,
      status: t.status ?? "pending",
      eventQueue: t.eventQueue ?? [],
      depsLoaded: t.depsLoaded ?? true,
    });
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  getTaskForIssue(issueNumber: number): Task | undefined {
    for (const t of this.tasks.values()) {
      if (t.issueNumber === issueNumber) return t;
    }
    return undefined;
  }

  nextPending(isReady?: (t: Task) => boolean): Task | null {
    for (const t of this.tasks.values()) {
      if (t.status === "pending" && (isReady === undefined || isReady(t))) return t;
    }
    return null;
  }

  assignTask(taskId: string, workerId: string) {
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.status = "assigned";
    t.assignedWorkerId = workerId;
  }

  completeTask(taskId: string) {
    const t = this.tasks.get(taskId);
    if (t) t.status = "complete";
  }

  revertTask(taskId: string) {
    const t = this.tasks.get(taskId);
    if (!t || t.status !== "assigned") return;
    t.status = "pending";
    t.assignedWorkerId = undefined;
  }

  queueEvent(taskId: string, event: GitHubEvent) {
    const t = this.tasks.get(taskId);
    if (t) t.eventQueue.push(event);
  }

  drainEvents(taskId: string): GitHubEvent[] {
    const t = this.tasks.get(taskId);
    if (!t) return [];
    const events = t.eventQueue.slice();
    t.eventQueue = [];
    return events;
  }

  registerPr(prNumber: number, taskId: string) {
    this.prToTaskId.set(prNumber, taskId);
  }

  getTaskForPr(prNumber: number): Task | undefined {
    const taskId = this.prToTaskId.get(prNumber);
    return taskId ? this.tasks.get(taskId) : undefined;
  }

  registerBranch(branch: string, taskId: string) {
    this.branchToTaskId.set(branch, taskId);
  }

  getTaskForBranch(branch: string): Task | undefined {
    const taskId = this.branchToTaskId.get(branch);
    return taskId ? this.tasks.get(taskId) : undefined;
  }

  removeTask(taskId: string) {
    const t = this.tasks.get(taskId);
    if (!t || t.status !== "pending") return;
    this.tasks.delete(taskId);
  }

  getPendingTasks(): Task[] {
    return [...this.tasks.values()].filter((t) => t.status === "pending");
  }

  markDepsLoaded(issueNumbers: number[]) {
    for (const n of issueNumbers) {
      const t = this.tasks.get(String(n));
      if (t) t.depsLoaded = true;
    }
  }

  getTaskSnapshots(): TaskSnapshot[] {
    return [...this.tasks.values()].map((t) => ({
      taskId: t.taskId,
      issueNumber: t.issueNumber,
      title: t.title,
      status: t.status,
      assignedWorkerId: t.assignedWorkerId,
    }));
  }
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
  routeEvent: (id: string, name: string, payload: unknown) => void,
  dbLogger?: DbLogger,
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
        routeEvent(id, name, parsed);
      }
      return c.text("OK", 200);
    } catch (err) {
      flog(`ERROR Webhook processing error: ${err}`);
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
      flog(`ERROR API query failed: ${err}`);
      return c.json({ error: "internal error" }, 500);
    }
  });

  app.get("/api/tasks/:id/events", async (c) => {
    try {
      const entries = dbLogger ? await dbLogger.queryTaskEvents(c.req.param("id")) : [];
      return c.json(entries);
    } catch (err) {
      flog(`ERROR API query failed: ${err}`);
      return c.json({ error: "internal error" }, 500);
    }
  });

  app.get("/api/workers/:id/messages", async (c) => {
    try {
      const entries = dbLogger ? await dbLogger.queryWorkerMessages(c.req.param("id")) : [];
      return c.json(entries);
    } catch (err) {
      flog(`ERROR API query failed: ${err}`);
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

export function createForemanWss(
  taskQueue: TaskQueue,
  registry: WorkerRegistry,
  server: http.Server,
  options: {
    taskLabel: string;
    labelDone?: (issueNumber: number) => Promise<void>;
    graph?: DependencyGraph;
    openIssues?: Set<number>;
    repo?: string;
    token?: string;
    dbLogger?: DbLogger;
    adminWss?: AdminWss;
    workerSecret?: string;
    labeledIssues?: Map<number, LabeledIssueState>;
    pingIntervalMs?: number;
    assignStore?: TaskAssignmentStore;
  },
): { wss: WebSocketServer; routeEventToWorker: (id: string, name: string, payload: unknown) => void; reconcile: () => void; startupDisconnected: Map<string, string> } {
  const taskLabel = options.taskLabel;
  const labelDone = options.labelDone ?? (() => Promise.resolve());
  const graph = options.graph ?? new Map<number, Set<number>>();
  const openIssues = options.openIssues ?? new Set<number>();
  const labeledIssues = options.labeledIssues ?? new Map<number, LabeledIssueState>();
  // repo and token default to "" for unit tests, which don't exercise GitHub-calling paths
  const repo = options.repo ?? "";
  const token = options.token ?? "";
  const dbLogger = options.dbLogger;
  const adminWss = options.adminWss;
  const workerSecret = options.workerSecret;
  const assignStore: TaskAssignmentStore = options.assignStore ?? {
    async upsertAssignment() {},
    async updatePr() {},
    async deleteAssignment() {},
    async listAssignments() { return []; },
  };
  // workerId → taskId for workers that had assignments before the last foreman restart.
  // Populated by the caller (main block) from the task_assignments DB table at startup.
  const startupDisconnected = new Map<string, string>();

  function log(wid: string, line: string) {
    flog(`[worker ${wid.slice(0, 8)}] ${line}`);
  }

  function broadcastSnapshot() {
    if (!adminWss) return;
    adminWss.broadcastSnapshot({
      tasks: taskQueue.getTaskSnapshots(),
      workers: registry.getWorkerSnapshots(),
    });
  }

  function extractLinkedIssueNumber(body: string): number | null {
    const match = /(?:closes|fixes|resolves)\s+#(\d+)/i.exec(body);
    return match ? parseInt(match[1], 10) : null;
  }

  function forwardEvent(task: Task, evt: GitHubEvent, ref: string) {
    if (task.status === "assigned" && task.assignedWorkerId) {
      const worker = registry.get(task.assignedWorkerId);
      if (worker?.status === "disconnected") {
        taskQueue.queueEvent(task.taskId, evt);
        flog(`[task ${ref}] ${evt.name} queued (worker ${task.assignedWorkerId.slice(0, 8)} disconnected)`);
      } else if (worker) {
        registry.send(task.assignedWorkerId, { type: "event_notification", taskId: task.taskId, event: evt });
        log(task.assignedWorkerId, `→ event_notification ${ref} ${evt.name}`);
      } else {
        flog(`[task ${ref}] ${evt.name} DROPPED — worker ${task.assignedWorkerId.slice(0, 8)} not in registry (disconnected?)`);
      }
    } else if (task.status === "pending") {
      taskQueue.queueEvent(task.taskId, evt);
      flog(`[task ${ref}] ${evt.name} queued (no worker assigned)`);
    }
  }

  interface RouteResult { taskId: string | null; workerId: string | null; }

  // Routes the event to the appropriate worker and returns the associated task
  // and worker IDs. Separating this from logging ensures we always log exactly
  // once with the correct taskId and workerId.
  function doRouteEvent(name: string, p: Record<string, unknown>, evt: GitHubEvent): RouteResult {
    function result(task: { taskId: string; assignedWorkerId?: string } | null | undefined): RouteResult {
      return { taskId: task?.taskId ?? null, workerId: task?.assignedWorkerId ?? null };
    }

    // ── PR events: route by PR number ────────────────────────────────────────

    if (name === "pull_request") {
      const pr = p.pull_request as Record<string, unknown> | undefined;
      const prNumber = numProp(pr, "number");
      if (prNumber === null) return result(null);

      // Drop synchronize events — the worker pushed these commits itself.
      if (p.action === "synchronize") return result(taskQueue.getTaskForPr(prNumber));

      // When a PR is opened, register it against a task if the body links an issue.
      // The worker opened the PR itself, so don't forward this event back to it.
      if (p.action === "opened" && pr) {
        const linkedIssue = extractLinkedIssueNumber(String(pr.body ?? ""));
        if (linkedIssue !== null) {
          const linkedTask = taskQueue.getTaskForIssue(linkedIssue);
          if (linkedTask) {
            taskQueue.registerPr(prNumber, linkedTask.taskId);
            const branch = strProp(pr.head, "ref");
            if (branch) taskQueue.registerBranch(branch, linkedTask.taskId);
            // Persist PR number and branch so routing survives a foreman restart.
            assignStore.updatePr(linkedTask.taskId, prNumber, branch ?? null).catch(err =>
              flog(`ERROR Failed to update PR for task #${linkedTask.taskId}: ${err}`)
            );
            flog(`[task #${linkedIssue}] PR #${prNumber} registered`);
            return result(linkedTask);
          }
        }
        return result(null);
      }

      const task = taskQueue.getTaskForPr(prNumber);
      if (task) forwardEvent(task, evt, `PR #${prNumber}`);
      return result(task);
    }

    if (name === "pull_request_review" || name === "pull_request_review_comment") {
      const pr = p.pull_request as Record<string, unknown> | undefined;
      const prNumber = numProp(pr, "number");
      if (prNumber === null) return result(null);
      const task = taskQueue.getTaskForPr(prNumber);
      if (task) forwardEvent(task, evt, `PR #${prNumber}`);
      return result(task);
    }

    if (name === "check_run" || name === "check_suite") {
      const inner = (name === "check_run" ? p.check_run : p.check_suite) as Record<string, unknown> | undefined;
      const prs = inner?.pull_requests as Array<{ number: number }> | undefined;

      // Try PR-number lookup first (sometimes populated), fall back to head_branch
      if (prs && prs.length > 0) {
        const task = taskQueue.getTaskForPr(prs[0].number);
        if (task) { forwardEvent(task, evt, `PR #${prs[0].number}`); return result(task); }
      }

      // GitHub often sends empty pull_requests for branch-push-triggered checks;
      // use head_branch as the reliable fallback.
      const headBranch = name === "check_run"
        ? strProp(inner?.check_suite, "head_branch") ?? ""
        : strProp(inner, "head_branch") ?? "";
      if (headBranch) {
        const task = taskQueue.getTaskForBranch(headBranch);
        if (task) { forwardEvent(task, evt, `branch ${headBranch}`); return result(task); }
      }
      return result(null);
    }

    // ── Issue events: route by issue number ──────────────────────────────────

    const issue = p.issue as Record<string, unknown> | undefined;
    const issueNumber = numProp(issue, "number");
    if (issueNumber === null) return result(null);

    let task = taskQueue.getTaskForIssue(issueNumber);

    // GitHub issue_comment events on PRs have the PR number in issue.number.
    // Fall back to PR lookup so comments on worker-opened PRs are forwarded.
    if (!task) task = taskQueue.getTaskForPr(issueNumber);

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
        labeledIssues.set(issueNumber, { issue: issueData, depsLoaded: false });
        openIssues.add(issueNumber);
        startDepsLoad(issueNumber, issueData.body);
        reconcile();
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
        labeledIssues.delete(issueNumber);
        openIssues.delete(issueNumber);
        flog(`[task #${issueNumber}] dequeued (label removed)`);
        reconcile();
        return result(task);
      }

      if (action === "closed") {
        openIssues.delete(issueNumber);
        reconcile();
        return result(task);
      }

      if (action === "reopened") {
        openIssues.add(issueNumber);
        reconcile();
        return result(task);
      }

      if (action === "edited") {
        const changes = p.changes as Record<string, unknown> | undefined;
        if (changes?.body) {
          const newBody = String(issue.body ?? "");
          const entry = labeledIssues.get(issueNumber);
          if (entry) {
            entry.depsLoaded = false;
            entry.issue = { ...entry.issue, body: newBody };
            startDepsLoad(issueNumber, newBody);
          }
        }
        // fall through: let forwardEvent run for assigned tasks
      }
    }

    if (!task) return result(null);
    forwardEvent(task, evt, `#${issueNumber}`);
    return result(task);
  }

  function routeEvent(id: string, name: string, payload: unknown) {
    const p = payload as Record<string, unknown>;
    const evt: GitHubEvent = { id, name, payload: p };

    const { taskId, workerId } = doRouteEvent(name, p, evt);

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
      id: 0,
      timestamp: new Date().toISOString(),
      taskId,
      workerId,
      summary: `${name}${action ? `/${action}` : ""}${webhookIssueNumber ? ` #${webhookIssueNumber}` : ""}`,
    });
  }

  async function tryAssignWork(workerId: string): Promise<void> {
    const task = taskQueue.nextPending(
      (t) => t.depsLoaded && !isBlocked(t.issueNumber, graph, openIssues),
    );
    if (task) {
      // Reserve in memory first to prevent concurrent double-assignment in the reconcile loop.
      taskQueue.assignTask(task.taskId, workerId);
      registry.assignTask(workerId, task.taskId);
      broadcastSnapshot();

      // Persist to DB before sending task_assigned to the worker.
      try {
        await assignStore.upsertAssignment(task.taskId, workerId);
      } catch (err) {
        flog(`ERROR Failed to persist assignment for task #${task.taskId}: ${err}`);
        // Revert in-memory state — worker gets standby instead.
        taskQueue.revertTask(task.taskId);
        registry.releaseWorker(workerId);
        broadcastSnapshot();
        const standbyMsg: ForemanMessage = { type: "standby" };
        registry.send(workerId, standbyMsg);
        dbLogger?.logForemanMessage({ direction: "sent", workerId, taskId: null, msgType: standbyMsg.type, payload: standbyMsg as unknown as Record<string, unknown> });
        log(workerId, "→ standby (DB write failed)");
        return;
      }

      const queued = taskQueue.drainEvents(task.taskId);
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
      registry.send(workerId, assignMsg);
      dbLogger?.logForemanMessage({ direction: "sent", workerId, taskId: task.taskId, msgType: assignMsg.type, payload: assignMsg as unknown as Record<string, unknown> });
      log(workerId, `→ task_assigned #${task.issueNumber} "${task.title}"`);
      for (const evt of queued) {
        const evtMsg: ForemanMessage = { type: "event_notification", taskId: task.taskId, event: evt };
        registry.send(workerId, evtMsg);
        dbLogger?.logForemanMessage({ direction: "sent", workerId, taskId: task.taskId, msgType: evtMsg.type, payload: evtMsg as unknown as Record<string, unknown> });
        log(workerId, `→ event_notification #${task.issueNumber} ${evt.name} (queued)`);
      }
    } else {
      const standbyMsg: ForemanMessage = { type: "standby" };
      registry.send(workerId, standbyMsg);
      dbLogger?.logForemanMessage({ direction: "sent", workerId, taskId: null, msgType: standbyMsg.type, payload: standbyMsg as unknown as Record<string, unknown> });
      log(workerId, "→ standby");
    }
  }

  const wss = new WebSocketServer({ noServer: true });

  const PING_INTERVAL_MS = options.pingIntervalMs ?? 25_000;
  const pingTimer = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.ping();
    }
  }, PING_INTERVAL_MS);
  wss.on("close", () => clearInterval(pingTimer));

  wss.on("connection", (ws) => {
    let workerId = "";

    function handleWorkerHello(msg: Extract<WorkerMessage, { type: "worker_hello" }>) {
      // Reject if workerSecret is configured and the message's secret doesn't match
      if (workerSecret && msg.workerSecret !== workerSecret) {
        ws.close(4001, "unauthorized");
        return;
      }

      workerId = msg.workerId;

      if (msg.status === "busy" && msg.taskId) {
        // Clear from startup disconnected map — worker is reclaiming its task.
        startupDisconnected.delete(workerId);
        const existing = taskQueue.get(msg.taskId);
        if (existing && existing.status !== "complete" && (existing.status !== "assigned" || existing.assignedWorkerId === workerId)) {
          // Task is pending/assigned to this worker — reclaim.
          log(workerId, `hello busy task=#${msg.taskId} — reclaimed`);
          registry.register(workerId, ws, "busy", msg.taskId);
          taskQueue.assignTask(msg.taskId, workerId);
          broadcastSnapshot();
          const queued = taskQueue.drainEvents(msg.taskId);
          for (const evt of queued) {
            registry.send(workerId, { type: "event_notification", taskId: msg.taskId, event: evt });
            log(workerId, `→ event_notification #${existing.issueNumber} ${evt.name} (queued)`);
          }
        } else if (!existing) {
          log(workerId, `hello busy task=#${msg.taskId} — unknown task, respecting busy status`);
          registry.register(workerId, ws, "busy", msg.taskId);
          broadcastSnapshot();
        } else {
          // Task is assigned to a different worker — standby
          log(workerId, `hello busy task=#${msg.taskId} — task taken by another worker`);
          registry.register(workerId, ws, "idle");
          broadcastSnapshot();
          const standbyMsg: ForemanMessage = { type: "standby" };
          registry.send(workerId, standbyMsg);
          dbLogger?.logForemanMessage({ direction: "sent", workerId, taskId: null, msgType: standbyMsg.type, payload: standbyMsg as unknown as Record<string, unknown> });
          log(workerId, "→ standby");
        }
      } else {
        // Check if this worker had an assignment before the last foreman restart.
        const startupTaskId = startupDisconnected.get(workerId);
        if (startupTaskId) {
          startupDisconnected.delete(workerId);
          taskQueue.revertTask(startupTaskId);
          assignStore.deleteAssignment(startupTaskId).catch(err =>
            flog(`ERROR Failed to delete assignment for #${startupTaskId}: ${err}`)
          );
          log(workerId, `hello idle (startup assignment for task #${startupTaskId}) — reverting to pending`);
        } else {
          // Mid-session reconnect: check registry for an in-session disconnected assignment.
          const existing = registry.get(workerId);
          if (existing?.currentTaskId) {
            log(workerId, `hello idle (had task #${existing.currentTaskId}) — reverting task to pending`);
            taskQueue.revertTask(existing.currentTaskId);
            assignStore.deleteAssignment(existing.currentTaskId).catch(err =>
              flog(`ERROR Failed to delete assignment for #${existing.currentTaskId}: ${err}`)
            );
          } else {
            log(workerId, "hello idle");
          }
        }
        registry.register(workerId, ws, "idle");
        broadcastSnapshot();
        tryAssignWork(workerId).catch(err => flog(`ERROR tryAssignWork: ${err}`));
      }
    }

    function handleTaskComplete(msg: Extract<WorkerMessage, { type: "task_complete" }>) {
      log(workerId, `task_complete #${msg.taskId}`);
      const task = taskQueue.get(msg.taskId);
      if (task) {
        taskQueue.completeTask(msg.taskId);
        assignStore.deleteAssignment(msg.taskId).catch(err =>
          flog(`ERROR Failed to delete assignment for #${msg.taskId}: ${err}`)
        );
        labelDone(task.issueNumber).catch(err =>
          flog(`ERROR Failed to label issue done: ${err}`)
        );
      }
      registry.releaseWorker(workerId);
      broadcastSnapshot();
      tryAssignWork(workerId).catch(err => flog(`ERROR tryAssignWork: ${err}`));
    }

    function handleWorkerGoodbye(msg: Extract<WorkerMessage, { type: "worker_goodbye" }>) {
      log(workerId, `worker_goodbye (task=${msg.taskId ?? "none"})`);
      if (msg.taskId) {
        taskQueue.revertTask(msg.taskId);
      }
      registry.remove(workerId);
      broadcastSnapshot();
      // Try to assign the reverted task to any already-idle workers.
      for (const w of registry.getIdleWorkers()) {
        tryAssignWork(w.workerId).catch(err => flog(`ERROR tryAssignWork: ${err}`));
      }
    }

    ws.on("message", (data) => {
      let msg: WorkerMessage;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      // Log all received messages
      dbLogger?.logForemanMessage({
        direction: "received",
        workerId: workerId || ((msg as { workerId?: string }).workerId ?? null),
        taskId: (msg as { taskId?: string }).taskId ?? null,
        msgType: msg.type,
        payload: msg as unknown as Record<string, unknown>,
      });

      if (msg.type === "worker_hello") handleWorkerHello(msg);
      else if (msg.type === "task_complete") handleTaskComplete(msg);
      else if (msg.type === "worker_goodbye") handleWorkerGoodbye(msg);
      else flog(`[worker ${workerId}] unknown message type: ${(msg as R).type}`);
    });

    ws.on("close", (code, reason) => {
      if (workerId) {
        const reasonStr = reason?.length ? `: ${reason}` : "";
        log(workerId, `disconnected (code ${code}${reasonStr})`);
        const taskId = registry.get(workerId)?.currentTaskId ?? null;
        dbLogger?.logForemanMessage({
          direction: "received",
          workerId,
          taskId,
          msgType: "worker_disconnected",
          payload: { code, reason: reason?.toString() ?? null },
        });
        if (taskId) {
          // Keep registry entry so queued events can be delivered on reconnect.
          registry.markDisconnected(workerId);
        } else {
          registry.remove(workerId);
        }
        broadcastSnapshot();
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
    fetchBlockers(issueNumber, body, { repo, token })
      .then((blockers) => {
        setBlockers(issueNumber, blockers, graph);
        return blockers.length > 0
          ? fetchIssueStates(blockers, { repo, token })
          : Promise.resolve(new Map<number, "open" | "closed">());
      })
      .then((states) => {
        for (const [num, state] of states) {
          if (state === "open") openIssues.add(num);
          else openIssues.delete(num);
        }
        const entry = labeledIssues.get(issueNumber);
        if (entry) entry.depsLoaded = true;
        reconcile();
      })
      .catch((err) => flog(`ERROR fetching deps for #${issueNumber}: ${err}`));
  }

  function reconcile() {
    // Step 1: materialise tasks for new labeledIssues entries
    for (const [num, { issue, depsLoaded }] of labeledIssues) {
      if (!taskQueue.getTaskForIssue(num)) {
        taskQueue.addTask({
          taskId: String(num),
          issueNumber: num,
          title: issue.title,
          body: issue.body,
          labels: issue.labels,
          repoUrl: issue.repoUrl,
          depsLoaded,
        });
      }
    }

    // Step 2: sync depsLoaded from labeledIssues to existing tasks (both directions)
    for (const [num, { depsLoaded }] of labeledIssues) {
      const t = taskQueue.getTaskForIssue(num);
      if (t) t.depsLoaded = depsLoaded;
    }

    // Step 3: remove pending tasks whose issue no longer has the label
    for (const t of taskQueue.getPendingTasks()) {
      if (!labeledIssues.has(t.issueNumber)) {
        taskQueue.removeTask(t.taskId);
      }
    }

    // Step 4: try assignment for all idle workers
    // Note: tryAssignWork calls broadcastSnapshot() internally when a task is assigned.
    // We call it once at the end to cover the case where no assignment happened
    // (e.g. all workers got standby). This may result in a redundant snapshot on
    // assignment, which is harmless — snapshots are idempotent.
    for (const w of registry.getIdleWorkers()) {
      tryAssignWork(w.workerId).catch(err => flog(`ERROR tryAssignWork: ${err}`));
    }
    broadcastSnapshot();
  }

  return { wss, routeEventToWorker: routeEvent, reconcile, startupDisconnected };
}

// Only start listening when run directly (not when imported by tests)
import { fileURLToPath } from "url";
import { loadIssuesToQueue } from "./github.js";
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const config = await loadConfig(process.argv);
  setVerbose(config.verbose);

  const registry = new WorkerRegistry();
  const taskQueue = new TaskQueue();
  const graph: DependencyGraph = new Map();
  const openIssues = new Set<number>();
  const labeledIssues = new Map<number, LabeledIssueState>();
  const webhooks = config.webhookSecret
    ? new Webhooks({ secret: config.webhookSecret })
    : null;

  // Setup DB logger and assignment store (share the same Supabase client if configured)
  let dbLogger: DbLogger;
  let assignStore: TaskAssignmentStore;
  if (config.supabaseUrl && config.supabaseSecretKey) {
    const { createClient } = await import("@supabase/supabase-js");
    const { createDbLogger, createTaskAssignmentStore } = await import("./db.js");
    const supabase = createClient(config.supabaseUrl, config.supabaseSecretKey);
    dbLogger = createDbLogger(supabase);
    assignStore = createTaskAssignmentStore(supabase);
    flog("Supabase logging enabled");
  } else {
    const { createNullDbLogger, createNullTaskAssignmentStore } = await import("./db.js");
    dbLogger = createNullDbLogger();
    assignStore = createNullTaskAssignmentStore();
  }

  let routeEvent: (id: string, name: string, payload: unknown) => void = () => {};
  let reconcile: () => void = () => {};
  let startupDisconnected = new Map<string, string>();
  const server = createHttpServer(webhooks, (id, name, payload) => routeEvent(id, name, payload), dbLogger);

  // Admin WebSocket broadcaster
  const { createAdminWss } = await import("./admin-ws.js");
  const adminWss = createAdminWss(server, () => ({
    tasks: taskQueue.getTaskSnapshots(),
    workers: registry.getWorkerSnapshots(),
  }));

  ({ routeEventToWorker: routeEvent, reconcile, startupDisconnected } = createForemanWss(
    taskQueue, registry, server,
    {
      graph,
      openIssues,
      labeledIssues,
      taskLabel: config.taskLabel,
      repo: config.githubRepo,
      token: config.githubToken,
      dbLogger,
      adminWss,
      workerSecret: config.workerSecret,
      assignStore,
      labelDone: (issueNumber) =>
        labelIssueDone(issueNumber, {
          repo: config.githubRepo,
          token: config.githubToken,
          doneLabel: config.doneLabel,
        }),
    },
  ));

  if (webhooks) {
    webhooks.onAny(({ id, name, payload }) => {
      printEvent(id, name as string, payload);
      routeEvent(id, name as string, payload);
    });
  }

  // Load all state before accepting WebSocket connections.
  // Step 1: fetch brunel:ready issues from GitHub → all tasks start pending
  try {
    await loadIssuesToQueue(labeledIssues, graph, openIssues, {
      repo: config.githubRepo,
      token: config.githubToken,
      taskLabel: config.taskLabel,
    });
    reconcile();
  } catch (err) {
    flog(`WARNING Failed to load issues from GitHub: ${err}`);
  }

  // Step 2: read task_assignments table and seed in-memory state
  try {
    const assignments = await assignStore.listAssignments();
    for (const row of assignments) {
      const task = taskQueue.get(row.taskId);
      if (!task) {
        // Orphaned row: issue was closed, label removed, or task already completed.
        flog(`[startup] orphaned assignment for task #${row.taskId}, deleting`);
        assignStore.deleteAssignment(row.taskId).catch(err =>
          flog(`ERROR Failed to delete orphaned assignment: ${err}`)
        );
        continue;
      }
      // Restore assigned state from DB
      taskQueue.assignTask(row.taskId, row.workerId);
      if (row.prNumber !== null) taskQueue.registerPr(row.prNumber, row.taskId);
      if (row.branch) taskQueue.registerBranch(row.branch, row.taskId);
      // Track so idle-reconnecting workers can revert their prior task
      startupDisconnected.set(row.workerId, row.taskId);
      flog(`[startup] loaded assignment: task #${row.taskId} → worker ${row.workerId.slice(0, 8)}`);
    }
  } catch (err) {
    flog(`WARNING Failed to load task assignments: ${err}`);
  }

  // Step 3: start listening — state is fully loaded
  server.listen(config.port, () => {
    flog(`Listening on http://localhost:${config.port}/webhook`);
    flog(`WebSocket workers: ws://localhost:${config.port}/worker`);
    flog(`Admin WebSocket: ws://localhost:${config.port}/admin/ws`);
    flog("Waiting for events...");
  });
}
