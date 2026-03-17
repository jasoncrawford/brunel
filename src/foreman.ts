import { Webhooks } from "@octokit/webhooks";
import http from "http";
import "dotenv/config";
import { WebSocketServer } from "ws";
import type { WebSocket as WsSocket } from "ws";
import type { WorkerMessage, ForemanMessage, GitHubEvent } from "./types.js";
import { labelIssueDone } from "./github.js";

type R = Record<string, unknown>;

const PORT = parseInt(process.env.PORT ?? "3000");
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// ── WorkerRegistry ────────────────────────────────────────────────────────────

interface WorkerState {
  workerId: string;
  ws: WsSocket;
  status: "idle" | "busy";
  currentTaskId?: string;
}

export class WorkerRegistry {
  private workers = new Map<string, WorkerState>();

  register(workerId: string, ws: WsSocket, status: "idle" | "busy", taskId?: string) {
    this.workers.set(workerId, { workerId, ws, status, currentTaskId: taskId });
  }

  get(workerId: string): WorkerState | undefined {
    return this.workers.get(workerId);
  }

  remove(workerId: string) {
    this.workers.delete(workerId);
  }

  getIdleWorker(): WorkerState | null {
    for (const w of this.workers.values()) {
      if (w.status === "idle") return w;
    }
    return null;
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
}

export class TaskQueue {
  private tasks = new Map<string, Task>();
  private prToTaskId = new Map<number, string>();
  private branchToTaskId = new Map<string, string>();

  addTask(t: Omit<Task, "status" | "assignedWorkerId" | "eventQueue"> & Partial<Pick<Task, "status" | "eventQueue">>) {
    this.tasks.set(t.taskId, {
      ...t,
      status: t.status ?? "pending",
      eventQueue: t.eventQueue ?? [],
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

  nextPending(): Task | null {
    for (const t of this.tasks.values()) {
      if (t.status === "pending") return t;
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

function printEvent(id: string, name: string, payload: unknown) {
  console.log(summaryEvent(id, name, payload));
}

// ── HTTP server factory ───────────────────────────────────────────────────────

function createHttpServer(
  webhooks: InstanceType<typeof Webhooks> | null,
  routeEvent: (id: string, name: string, payload: unknown) => void,
): http.Server {
  return http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/webhook") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const rawBody = Buffer.concat(chunks).toString();

      const id = (req.headers["x-github-delivery"] as string) ?? "unknown";
      const name = req.headers["x-github-event"] as string;
      const signature = req.headers["x-hub-signature-256"] as string;

      if (!name) {
        res.writeHead(400);
        res.end("Missing x-github-event header");
        return;
      }

      try {
        if (webhooks) {
          if (!signature) {
            res.writeHead(401);
            res.end("Missing signature");
            return;
          }
          await webhooks.verifyAndReceive({
            id,
            name: name as Parameters<typeof webhooks.verifyAndReceive>[0]["name"],
            signature,
            payload: rawBody,
          });
        } else {
          const parsed = JSON.parse(rawBody);
          printEvent(id, name, parsed);
          routeEvent(id, name, parsed);
        }
        res.writeHead(200);
        res.end("OK");
      } catch (err) {
        console.error("Webhook processing error:", err);
        res.writeHead(400);
        res.end("Bad Request");
      }
      return;
    }

    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("GitHub webhook listener running. POST events to /webhook");
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });
}

// ── WebSocket server factory ──────────────────────────────────────────────────

export function createForemanWss(
  taskQueue: TaskQueue,
  registry: WorkerRegistry,
  server: http.Server,
  options?: {
    taskLabel?: string;
    labelDone?: (issueNumber: number) => Promise<void>;
  },
): { wss: WebSocketServer; routeEventToWorker: (id: string, name: string, payload: unknown) => void } {
  const taskLabel = options?.taskLabel ?? process.env.TASK_LABEL ?? "brunel:ready";
  const labelDone = options?.labelDone ?? labelIssueDone;

  function log(wid: string, line: string) {
    console.log(`[worker ${wid.slice(0, 8)}] ${line}`);
  }

  function extractLinkedIssueNumber(body: string): number | null {
    const match = /(?:closes|fixes|resolves)\s+#(\d+)/i.exec(body);
    return match ? parseInt(match[1], 10) : null;
  }

  function forwardEvent(task: Task, evt: GitHubEvent, ref: string) {
    if (task.status === "assigned" && task.assignedWorkerId) {
      registry.send(task.assignedWorkerId, { type: "event_notification", taskId: task.taskId, event: evt });
      log(task.assignedWorkerId, `→ event_notification ${ref} ${evt.name}`);
    } else if (task.status === "pending") {
      taskQueue.queueEvent(task.taskId, evt);
      console.log(`[task ${ref}] ${evt.name} queued (no worker assigned)`);
    }
  }

  function routeEvent(id: string, name: string, payload: unknown) {
    const p = payload as Record<string, unknown>;
    const evt: GitHubEvent = { id, name, payload: p };

    // ── PR events: route by PR number ────────────────────────────────────────

    if (name === "pull_request") {
      const pr = p.pull_request as Record<string, unknown> | undefined;
      const prNumber = typeof pr?.number === "number" ? pr.number : null;
      if (prNumber === null) return;

      // When a PR is opened, register it against a task if the body links an issue.
      // The worker opened the PR itself, so don't forward this event back to it.
      if (p.action === "opened" && pr) {
        const linkedIssue = extractLinkedIssueNumber(String(pr.body ?? ""));
        if (linkedIssue !== null) {
          const linkedTask = taskQueue.getTaskForIssue(linkedIssue);
          if (linkedTask) {
            taskQueue.registerPr(prNumber, linkedTask.taskId);
            const branch = String((pr.head as Record<string, unknown> | undefined)?.ref ?? "");
            if (branch) taskQueue.registerBranch(branch, linkedTask.taskId);
            console.log(`[task #${linkedIssue}] PR #${prNumber} registered`);
          }
        }
        return;
      }

      const task = taskQueue.getTaskForPr(prNumber);
      if (task) forwardEvent(task, evt, `PR #${prNumber}`);
      return;
    }

    if (name === "pull_request_review" || name === "pull_request_review_comment") {
      const pr = p.pull_request as Record<string, unknown> | undefined;
      const prNumber = typeof pr?.number === "number" ? pr.number : null;
      if (prNumber === null) return;
      const task = taskQueue.getTaskForPr(prNumber);
      if (task) forwardEvent(task, evt, `PR #${prNumber}`);
      return;
    }

    if (name === "check_run" || name === "check_suite") {
      const inner = (name === "check_run" ? p.check_run : p.check_suite) as Record<string, unknown> | undefined;
      const prs = inner?.pull_requests as Array<{ number: number }> | undefined;

      // Try PR-number lookup first (sometimes populated), fall back to head_branch
      if (prs && prs.length > 0) {
        const task = taskQueue.getTaskForPr(prs[0].number);
        if (task) { forwardEvent(task, evt, `PR #${prs[0].number}`); return; }
      }

      // GitHub often sends empty pull_requests for branch-push-triggered checks;
      // use head_branch as the reliable fallback.
      const headBranch = name === "check_run"
        ? String((inner?.check_suite as Record<string, unknown> | undefined)?.head_branch ?? "")
        : String(inner?.head_branch ?? "");
      if (headBranch) {
        const task = taskQueue.getTaskForBranch(headBranch);
        if (task) forwardEvent(task, evt, `branch ${headBranch}`);
      }
      return;
    }

    // ── Issue events: route by issue number ──────────────────────────────────

    const issue = p.issue as Record<string, unknown> | undefined;
    const issueNumber = typeof issue?.number === "number" ? issue.number : null;
    if (issueNumber === null) return;

    let task = taskQueue.getTaskForIssue(issueNumber);

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
        const repoUrl =
          ((p.repository as Record<string, unknown> | undefined)?.html_url as string | undefined) ?? "";
        const labels =
          (issue.labels as Array<{ name: string }> | undefined)?.map((l) => l.name) ?? [];
        taskQueue.addTask({
          taskId: String(issueNumber),
          issueNumber,
          title: String(issue.title ?? ""),
          body: String(issue.body ?? ""),
          labels,
          repoUrl,
        });
        console.log(`[task #${issueNumber}] enqueued via ${name}/${action}`);
        task = taskQueue.getTaskForIssue(issueNumber)!;
        const idle = registry.getIdleWorker();
        if (idle) tryAssignWork(idle.workerId);
        return;
      }
    }

    if (!task) return;
    forwardEvent(task, evt, `#${issueNumber}`);
  }

  function tryAssignWork(workerId: string) {
    const task = taskQueue.nextPending();
    if (task) {
      taskQueue.assignTask(task.taskId, workerId);
      registry.assignTask(workerId, task.taskId);
      const queued = taskQueue.drainEvents(task.taskId);
      registry.send(workerId, {
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
      log(workerId, `→ task_assigned #${task.issueNumber} "${task.title}"`);
      for (const evt of queued) {
        registry.send(workerId, { type: "event_notification", taskId: task.taskId, event: evt });
        log(workerId, `→ event_notification #${task.issueNumber} ${evt.name} (queued)`);
      }
    } else {
      registry.send(workerId, { type: "standby" });
      log(workerId, "→ standby");
    }
  }

  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    let workerId = "";

    ws.on("message", (data) => {
      let msg: WorkerMessage;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === "worker_hello") {
        workerId = msg.workerId;

        if (msg.status === "busy" && msg.taskId) {
          const existing = taskQueue.get(msg.taskId);
          if (existing && existing.status !== "complete" && (existing.status !== "assigned" || existing.assignedWorkerId === workerId)) {
            // Task is pending/assigned to this worker — reclaim.
            log(workerId, `hello busy task=#${msg.taskId} — reclaimed`);
            registry.register(workerId, ws, "busy", msg.taskId);
            taskQueue.assignTask(msg.taskId, workerId);
            const queued = taskQueue.drainEvents(msg.taskId);
            for (const evt of queued) {
              registry.send(workerId, { type: "event_notification", taskId: msg.taskId, event: evt });
              log(workerId, `→ event_notification #${existing.issueNumber} ${evt.name} (queued)`);
            }
          } else if (!existing) {
            log(workerId, `hello busy task=#${msg.taskId} — unknown task, treating as idle`);
            registry.register(workerId, ws, "idle");
            tryAssignWork(workerId);
          } else {
            // Task is assigned to a different worker — standby
            log(workerId, `hello busy task=#${msg.taskId} — task taken by another worker`);
            registry.register(workerId, ws, "idle");
            registry.send(workerId, { type: "standby" });
            log(workerId, "→ standby");
          }
        } else {
          log(workerId, "hello idle");
          registry.register(workerId, ws, "idle");
          tryAssignWork(workerId);
        }
      }

      if (msg.type === "task_complete") {
        log(workerId, `task_complete #${msg.taskId}`);
        const task = taskQueue.get(msg.taskId);
        if (task) {
          taskQueue.completeTask(msg.taskId);
          labelDone(task.issueNumber).catch(err =>
            console.error("Failed to label issue done:", err)
          );
        }
        registry.releaseWorker(workerId);
        tryAssignWork(workerId);
      }
    });

    ws.on("close", () => {
      if (workerId) {
        log(workerId, "disconnected");
        registry.remove(workerId);
      }
    });
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/worker") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  return { wss, routeEventToWorker: routeEvent };
}

// Only start listening when run directly (not when imported by tests)
import { fileURLToPath } from "url";
import { loadIssuesToQueue } from "./github.js";
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const registry = new WorkerRegistry();
  const taskQueue = new TaskQueue();
  const webhooks = WEBHOOK_SECRET ? new Webhooks({ secret: WEBHOOK_SECRET }) : null;

  // Use a mutable reference so routeEvent can be wired after createForemanWss returns it.
  let routeEvent: (id: string, name: string, payload: unknown) => void = () => {};
  const server = createHttpServer(webhooks, (id, name, payload) => routeEvent(id, name, payload));
  ({ routeEventToWorker: routeEvent } = createForemanWss(taskQueue, registry, server));

  if (webhooks) {
    webhooks.onAny(({ id, name, payload }) => {
      printEvent(id, name as string, payload);
      routeEvent(id, name as string, payload);
    });
  }

  server.listen(PORT, async () => {
    console.log(`\nListening on http://localhost:${PORT}/webhook`);
    console.log("WebSocket workers: ws://localhost:" + PORT + "/worker");
    console.log("Waiting for events...\n");
    try {
      await loadIssuesToQueue(taskQueue);
    } catch (err) {
      console.error("Warning: failed to load issues from GitHub:", err);
    }
  });
}
