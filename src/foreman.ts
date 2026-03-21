import { Webhooks } from "@octokit/webhooks";
import http from "http";
import "dotenv/config";
import { WebSocketServer } from "ws";
import type { WebSocket as WsSocket } from "ws";
import type { WorkerMessage, ForemanMessage, GitHubEvent } from "./types.js";
import { labelIssueDone } from "./github.js";
import { fmtTimestamp, setVerbose } from "./display.js";
import { loadConfig, DEFAULT_TASK_LABEL } from "./config.js";
import { isBlocked, setBlockers, fetchBlockers } from "./dependencies.js";
import { fetchIssueStates } from "./github.js";
import type { DependencyGraph } from "./dependencies.js";

function flog(msg: string) {
  console.log(`${fmtTimestamp()} ${msg}`);
}

type R = Record<string, unknown>;


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

  markDepsLoaded(issueNumbers: number[]) {
    for (const n of issueNumbers) {
      const t = this.tasks.get(String(n));
      if (t) t.depsLoaded = true;
    }
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

export function isMutedEvent(name: string): boolean {
  return name === "workflow_job" || name === "workflow_run";
}

function printEvent(id: string, name: string, payload: unknown) {
  if (isMutedEvent(name)) return;
  flog(summaryEvent(id, name, payload));
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
        flog(`ERROR Webhook processing error: ${err}`);
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
    graph?: DependencyGraph;
    openIssues?: Set<number>;
    repo?: string;
    token?: string;
  },
): { wss: WebSocketServer; routeEventToWorker: (id: string, name: string, payload: unknown) => void } {
  const taskLabel = options?.taskLabel ?? DEFAULT_TASK_LABEL;
  const labelDone = options?.labelDone ?? (() => Promise.resolve());
  const graph = options?.graph ?? new Map<number, Set<number>>();
  const openIssues = options?.openIssues ?? new Set<number>();
  // repo and token default to "" for unit tests, which don't exercise GitHub-calling paths
  const repo = options?.repo ?? "";
  const token = options?.token ?? "";

  function log(wid: string, line: string) {
    flog(`[worker ${wid.slice(0, 8)}] ${line}`);
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
      flog(`[task ${ref}] ${evt.name} queued (no worker assigned)`);
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

      // Drop synchronize events — the worker pushed these commits itself.
      if (p.action === "synchronize") return;

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
            flog(`[task #${linkedIssue}] PR #${prNumber} registered`);
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
          depsLoaded: false,
        });
        // Track open state for newly-enqueued brunel:ready issues
        openIssues.add(issueNumber);
        flog(`[task #${issueNumber}] enqueued via ${name}/${action}`);
        task = taskQueue.getTaskForIssue(issueNumber)!;

        // Fetch deps before assigning (graph must be current)
        fetchBlockers(issueNumber, String(issue.body ?? ""), { repo, token })
          .then((blockers) => {
            setBlockers(issueNumber, blockers, graph);
            return blockers.length > 0 ? fetchIssueStates(blockers, { repo, token }) : Promise.resolve(new Map<number, "open" | "closed">());
          })
          .then((states) => {
            for (const [num, state] of states) {
              if (state === "open") openIssues.add(num);
            }
            // Mark deps as loaded so this task is now eligible for assignment.
            const t = taskQueue.get(String(issueNumber));
            if (t) t.depsLoaded = true;
            // Only one task was just enqueued, so assigning one idle worker is sufficient.
            const idle = registry.getIdleWorker();
            if (idle) tryAssignWork(idle.workerId);
          })
          .catch((err) => flog(`ERROR fetching deps for #${issueNumber}: ${err}`));
        return;
      }
    }

    // ── Dependency graph updates ───────────────────────────────────────────────

    if (name === "issues" && issue) {
      const action = p.action as string | undefined;

      if (action === "closed") {
        openIssues.delete(issueNumber);
        for (const w of registry.getIdleWorkers()) {
          tryAssignWork(w.workerId);
        }
        return;
      }

      if (action === "reopened") {
        openIssues.add(issueNumber);
        return;
      }

      if (action === "edited") {
        const changes = p.changes as Record<string, unknown> | undefined;
        if (changes?.body) {
          const body = String(issue.body ?? "");
          fetchBlockers(issueNumber, body, { repo, token })
            .then((blockers) => {
              setBlockers(issueNumber, blockers, graph);
              return fetchIssueStates(blockers, { repo, token });
            })
            .then((states) => {
              for (const [num, state] of states) {
                // Only update state for the newly-fetched blockers of this issue.
                // openIssues may contain entries from other tasks; we only touch
                // what fetchIssueStates returned, so other tasks' blockers are unaffected.
                if (state === "open") openIssues.add(num);
                else openIssues.delete(num);
              }
              for (const w of registry.getIdleWorkers()) {
                tryAssignWork(w.workerId);
              }
            })
            .catch((err) => flog(`ERROR updating deps for #${issueNumber}: ${err}`));
        }
        // fall through: let existing forwardEvent logic run for assigned tasks
      }
    }

    if (!task) return;
    forwardEvent(task, evt, `#${issueNumber}`);
  }

  function tryAssignWork(workerId: string) {
    const task = taskQueue.nextPending(
      (t) => t.depsLoaded && !isBlocked(t.issueNumber, graph, openIssues),
    );
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
            log(workerId, `hello busy task=#${msg.taskId} — unknown task, respecting busy status`);
            registry.register(workerId, ws, "busy", msg.taskId);
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
            flog(`ERROR Failed to label issue done: ${err}`)
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
  const config = await loadConfig(process.argv);
  setVerbose(config.verbose);

  const registry = new WorkerRegistry();
  const taskQueue = new TaskQueue();
  const graph: DependencyGraph = new Map();
  const openIssues = new Set<number>();
  const webhooks = config.webhookSecret
    ? new Webhooks({ secret: config.webhookSecret })
    : null;

  let routeEvent: (id: string, name: string, payload: unknown) => void = () => {};
  const server = createHttpServer(webhooks, (id, name, payload) => routeEvent(id, name, payload));
  ({ routeEventToWorker: routeEvent } = createForemanWss(
    taskQueue, registry, server,
    {
      graph,
      openIssues,
      taskLabel: config.taskLabel,
      repo: config.githubRepo,
      token: config.githubToken,
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

  server.listen(config.port, async () => {
    flog(`Listening on http://localhost:${config.port}/webhook`);
    flog(`WebSocket workers: ws://localhost:${config.port}/worker`);
    flog("Waiting for events...");
    try {
      await loadIssuesToQueue(taskQueue, graph, openIssues, {
        repo: config.githubRepo,
        token: config.githubToken,
        taskLabel: config.taskLabel,
      });
    } catch (err) {
      flog(`WARNING Failed to load issues from GitHub: ${err}`);
    }
  });
}
