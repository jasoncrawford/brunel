import { Webhooks } from "@octokit/webhooks";
import http from "http";
import "dotenv/config";
import { WebSocketServer } from "ws";
import type { WebSocket as WsSocket } from "ws";
import type { WorkerMessage, ForemanMessage, GitHubEvent } from "./types.js";
export { summaryEvent } from "./display.js";

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
}

// ── GitHub API helpers ────────────────────────────────────────────────────────
// Read env vars inside function bodies (not at module load) so that tests can
// set process.env values before calling the function.

function ghEnv() {
  return {
    repo:       process.env.GITHUB_REPO ?? "",
    token:      process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "",
    taskLabel:  process.env.TASK_LABEL ?? "brunel:ready",
    doneLabel:  process.env.DONE_LABEL ?? "brunel:done",
  };
}

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function loadIssuesToQueue(queue: TaskQueue): Promise<void> {
  const { repo, token, taskLabel } = ghEnv();
  const [owner, repoName] = repo.split("/");
  const url = `https://api.github.com/repos/${owner}/${repoName}/issues?labels=${encodeURIComponent(taskLabel)}&state=open&per_page=100`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const issues = await res.json() as Array<{ number: number; title: string; body: string | null; labels: Array<{ name: string }> }>;
  for (const issue of issues) {
    queue.addTask({
      taskId: String(issue.number),
      issueNumber: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      labels: issue.labels.map(l => l.name),
      repoUrl: `https://github.com/${owner}/${repoName}`,
    });
  }
}

export async function labelIssueDone(issueNumber: number): Promise<void> {
  const { repo, token, doneLabel } = ghEnv();
  const [owner, repoName] = repo.split("/");
  const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}/labels`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ labels: [doneLabel] }),
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
}

// ── Module-level wiring ───────────────────────────────────────────────────────

const registry = new WorkerRegistry();
const taskQueue = new TaskQueue();
// Placeholder — assigned synchronously by createForemanWss before any requests arrive
let routeEventToWorker: (id: string, name: string, payload: unknown) => void = () => {};

// ── Webhook handler ───────────────────────────────────────────────────────────

const webhooks = WEBHOOK_SECRET ? new Webhooks({ secret: WEBHOOK_SECRET }) : null;

if (webhooks) {
  webhooks.onAny(({ id, name, payload }) => {
    printEvent(id, name as string, payload);
    routeEventToWorker(id, name as string, payload);
  });
}

function printEvent(id: string, name: string, payload: unknown) {
  console.log(summaryEvent(id, name, payload));
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
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
        routeEventToWorker(id, name, parsed);
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

// ── WebSocket server factory ──────────────────────────────────────────────────

export function createForemanWss(
  taskQueue: TaskQueue,
  registry: WorkerRegistry,
  server: http.Server,
): { wss: WebSocketServer; routeEventToWorker: (id: string, name: string, payload: unknown) => void } {
  function log(wid: string, line: string) {
    console.log(`[worker ${wid.slice(0, 8)}] ${line}`);
  }

  function routeEvent(id: string, name: string, payload: unknown) {
    const p = payload as Record<string, unknown>;
    const issue = (p.issue ?? p.pull_request) as Record<string, unknown> | undefined;
    const issueNumber = typeof issue?.number === "number" ? issue.number : null;
    if (issueNumber === null) return;

    const evt: GitHubEvent = { id, name, payload: p };
    const task = taskQueue.getTaskForIssue(issueNumber);
    if (!task) return;

    if (task.status === "assigned" && task.assignedWorkerId) {
      registry.send(task.assignedWorkerId, { type: "event_notification", taskId: task.taskId, event: evt });
      log(task.assignedWorkerId, `→ event_notification #${issueNumber} ${name}`);
    } else if (task.status === "pending") {
      taskQueue.queueEvent(task.taskId, evt);
      console.log(`[task #${issueNumber}] ${name} queued (no worker assigned)`);
    }
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
          labelIssueDone(task.issueNumber).catch(err =>
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
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  ({ routeEventToWorker } = createForemanWss(taskQueue, registry, server));
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
