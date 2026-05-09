/**
 * Integration and end-to-end tests for multi-repo support (GitHub issue #867).
 *
 * Issue numbers used: 60–65, 70–71.
 * Task IDs use "t<issue><repo>" prefix (e.g. "t60a", "t60b") to avoid
 * collisions with other test files (which reserve "42" and "55").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import type { AddressInfo } from "net";
import { Task } from "../src/foreman/models/task.js";
import { Worker } from "../src/foreman/models/worker.js";
import { TaskManager } from "../src/foreman/models/task-manager.js";
import { ForemanWss } from "../src/foreman/controllers/wss.js";
import { Repo } from "../src/foreman/models/repo.js";
import { resetDb, createTestTaskManager, seedTask, fakeRepo } from "./helpers/task.js";
import { loadDefaultConfig } from "../src/config.js";
import { waitUntil } from "./helpers.js";

const defaultCfg = await loadDefaultConfig();

// ── Shared WebSocket helpers ──────────────────────────────────────────────────

function makeQueue(ws: WebSocket): { next: () => Promise<object> } {
  const pending: object[] = [];
  const waiters: Array<(m: object) => void> = [];
  ws.on("message", (data: Buffer | string) => {
    const msg = JSON.parse(data.toString()) as object;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else pending.push(msg);
  });
  return {
    next(): Promise<object> {
      if (pending.length > 0) return Promise.resolve(pending.shift()!);
      return new Promise((r) => waiters.push(r));
    },
  };
}

function send(ws: WebSocket, msg: object): void {
  ws.send(JSON.stringify(msg));
}

function closeClient(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.once("close", resolve);
    ws.close();
  });
}

// ── Helper: register a task and mark blockers loaded so tryAssignWork picks it up ──

async function registerReady(
  tm: TaskManager,
  taskId: string,
  issueNumber: number,
  repoSlug: string,
): Promise<void> {
  await Task.upsert(taskId, issueNumber, repoSlug, `Task ${issueNumber}`, "body", ["brunel:ready"]);
  tm.trackIssue(issueNumber);
  tm.markBlockersLoaded(issueNumber);
}

// ════════════════════════════════════════════════════════════════════════════
// Section 1: Unit tests — in-memory DB shim only (no HTTP server)
// ════════════════════════════════════════════════════════════════════════════

describe("Task.list({ repoId }) filtering", () => {
  beforeEach(() => { resetDb(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns only tasks for the specified repo", async () => {
    const m1 = await createTestTaskManager("owner/repo-a");
    const m2 = await createTestTaskManager("owner/repo-b");

    await Task.upsert("t60a", 60, "owner/repo-a", "Task A", "body", []);
    await Task.upsert("t60b", 60, "owner/repo-b", "Task B", "body", []);

    const listA = await Task.list({ repoId: m1.repo.id });
    const listB = await Task.list({ repoId: m2.repo.id });

    expect(listA).toHaveLength(1);
    expect(listA[0].taskId).toBe("t60a");
    expect(listB).toHaveLength(1);
    expect(listB[0].taskId).toBe("t60b");
  });

  it("overlapping issue numbers do not cross-contaminate repo task lists", async () => {
    const m1 = await createTestTaskManager("owner/repo-a");
    const m2 = await createTestTaskManager("owner/repo-b");

    // Same issue number (61) in both repos
    await Task.upsert("t61a", 61, "owner/repo-a", "Task A", "body", []);
    await Task.upsert("t61b", 61, "owner/repo-b", "Task B", "body", []);
    // Extra task in repo-a only
    await Task.upsert("t62a", 62, "owner/repo-a", "Task A2", "body", []);

    const listA = await Task.list({ repoId: m1.repo.id });
    const listB = await Task.list({ repoId: m2.repo.id });

    expect(listA.map((t) => t.taskId).sort()).toEqual(["t61a", "t62a"]);
    expect(listB.map((t) => t.taskId)).toEqual(["t61b"]);
  });
});

describe("Task.getByRepoIssue cross-repo isolation", () => {
  beforeEach(() => { resetDb(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns the correct repo's task for overlapping issue numbers", async () => {
    const m1 = await createTestTaskManager("owner/repo-a");
    const m2 = await createTestTaskManager("owner/repo-b");

    await Task.upsert("t63a", 63, "owner/repo-a", "Task A", "body", []);
    await Task.upsert("t63b", 63, "owner/repo-b", "Task B", "body", []);

    const taskA = await Task.getByRepoIssue(m1.repo.id, 63);
    const taskB = await Task.getByRepoIssue(m2.repo.id, 63);

    expect(taskA?.taskId).toBe("t63a");
    expect(taskB?.taskId).toBe("t63b");
  });

  it("does not return the other repo's task", async () => {
    const m1 = await createTestTaskManager("owner/repo-a");
    const m2 = await createTestTaskManager("owner/repo-b");

    await Task.upsert("t64a", 64, "owner/repo-a", "Task A", "body", []);

    // Repo B has no task for issue #64
    const taskB = await Task.getByRepoIssue(m2.repo.id, 64);
    expect(taskB).toBeNull();
  });
});

describe("Task.getByRepoPr cross-repo isolation", () => {
  beforeEach(() => { resetDb(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns the correct repo's task for the same PR number in different repos", async () => {
    const m1 = await createTestTaskManager("owner/repo-a");
    const m2 = await createTestTaskManager("owner/repo-b");

    await Task.upsert("t65a", 65, "owner/repo-a", "Task A", "body", []);
    await Task.upsert("t65b", 65, "owner/repo-b", "Task B", "body", []);

    const ta = await Task.get("t65a");
    const tb = await Task.get("t65b");
    await ta!.registerPr(77, null);
    await tb!.registerPr(77, null);

    const prTaskA = await Task.getByRepoPr(m1.repo.id, 77);
    const prTaskB = await Task.getByRepoPr(m2.repo.id, 77);

    expect(prTaskA?.taskId).toBe("t65a");
    expect(prTaskB?.taskId).toBe("t65b");
  });
});

describe("Issue close/reopen isolation (TaskManager)", () => {
  beforeEach(() => { resetDb(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("closing issue in repo A does not affect repo B task with same issue number", async () => {
    const m1 = await createTestTaskManager("owner/repo-a");
    await createTestTaskManager("owner/repo-b");

    await Task.upsert("t70a", 70, "owner/repo-a", "Task A", "body", []);
    await Task.upsert("t70b", 70, "owner/repo-b", "Task B", "body", []);

    await m1.closeIssue(70);

    expect((await Task.get("t70a"))?.issueClosedAt).not.toBeNull();
    expect((await Task.get("t70b"))?.issueClosedAt).toBeNull();
  });

  it("reopening issue in repo A does not affect repo B task", async () => {
    const m1 = await createTestTaskManager("owner/repo-a");
    const m2 = await createTestTaskManager("owner/repo-b");

    // Seed as assigned so deleteIfUnassigned is a no-op, preserving the row after close.
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await Task.upsert("t71a", 71, "owner/repo-a", "Task A", "body", []);
    await Task.upsert("t71b", 71, "owner/repo-b", "Task B", "body", []);
    const ta = await Task.get("t71a");
    await ta!.assign(Worker.register("wTmp", fakeWs, fakeRepo("owner/repo-a", m1.repo.id)));

    await m1.closeIssue(71);
    expect((await Task.get("t71a"))?.issueClosedAt).not.toBeNull();

    await m1.reopenIssue(71);
    expect((await Task.get("t71a"))?.issueClosedAt).toBeNull();

    // Repo B's task is unaffected throughout.
    expect((await Task.get("t71b"))?.issueClosedAt).toBeNull();
  });
});

describe("loadActiveTasksFromDb — multi-repo branch isolation", () => {
  beforeEach(() => { resetDb(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("each TaskManager registers only its own repo's branches", async () => {
    const m1 = await createTestTaskManager("owner/repo-a");
    const m2 = await createTestTaskManager("owner/repo-b");

    await seedTask({
      task_id: "t70a", issue_number: 70,
      repo: "owner/repo-a", repo_id: m1.repo.id,
      branch: "fix-70-a",
    });
    await seedTask({
      task_id: "t70b", issue_number: 70,
      repo: "owner/repo-b", repo_id: m2.repo.id,
      branch: "fix-70-b",
    });

    await m1.loadActiveTasksFromDb();
    await m2.loadActiveTasksFromDb();

    expect((await m1.getTaskForBranch("fix-70-a"))?.taskId).toBe("t70a");
    expect(await m1.getTaskForBranch("fix-70-b")).toBeNull();

    expect((await m2.getTaskForBranch("fix-70-b"))?.taskId).toBe("t70b");
    expect(await m2.getTaskForBranch("fix-70-a")).toBeNull();
  });

  it("Task.list result for each repo contains only that repo's tasks after loadActiveTasksFromDb", async () => {
    const m1 = await createTestTaskManager("owner/repo-a");
    const m2 = await createTestTaskManager("owner/repo-b");

    await seedTask({ task_id: "t61a", issue_number: 61, repo: "owner/repo-a", repo_id: m1.repo.id });
    await seedTask({ task_id: "t61b", issue_number: 61, repo: "owner/repo-b", repo_id: m2.repo.id });

    await m1.loadActiveTasksFromDb();
    await m2.loadActiveTasksFromDb();

    const listA = await Task.list({ repoId: m1.repo.id });
    const listB = await Task.list({ repoId: m2.repo.id });

    expect(listA).toHaveLength(1);
    expect(listA[0].taskId).toBe("t61a");
    expect(listB).toHaveLength(1);
    expect(listB[0].taskId).toBe("t61b");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Section 2: Integration tests — HTTP server + ForemanWss
// ════════════════════════════════════════════════════════════════════════════

let httpServer: http.Server;
let wss: WebSocketServer;
let port: number;
const openClients: WebSocket[] = [];

function connectWorker(msg: object): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/worker`);
    ws.once("open", () => { ws.send(JSON.stringify(msg)); resolve(ws); });
    ws.once("error", reject);
  });
}

function connect(msg: object): Promise<WebSocket> {
  return connectWorker(msg).then((ws) => { openClients.push(ws); return ws; });
}

function startServer(): Promise<number> {
  return new Promise((resolve) => {
    httpServer.listen(0, () => resolve((httpServer.address() as AddressInfo).port));
  });
}

beforeEach(async () => {
  Worker._reset();
  resetDb();
  httpServer = http.createServer();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  return new Promise<void>((resolve) => {
    const clients = openClients.splice(0);
    const alive = clients.filter((c) => c.readyState !== WebSocket.CLOSED);
    const finish = () => {
      const cleanup = () => resolve();
      if (wss) {
        wss.close(() => httpServer.close(cleanup));
      } else {
        httpServer.close(cleanup);
      }
    };
    if (alive.length === 0) { finish(); return; }
    let pending = alive.length;
    for (const c of alive) {
      c.once("close", () => { if (--pending === 0) finish(); });
      c.close();
    }
  });
});

// ── Webhook routing isolation ─────────────────────────────────────────────────

describe("Webhook routing: issue-closed only affects the target repo", () => {
  it("closing issue #60 in repo-a does not close the same issue in repo-b", async () => {
    const m1 = await createTestTaskManager("owner/repo-a");
    const m2 = await createTestTaskManager("owner/repo-b");
    await m1.repo.activate();
    await m2.repo.activate();

    await Task.upsert("t60a", 60, "owner/repo-a", "Task A", "body", ["brunel:ready"]);
    await Task.upsert("t60b", 60, "owner/repo-b", "Task B", "body", ["brunel:ready"]);

    const foremanWss = new ForemanWss({ server: httpServer, config: defaultCfg });
    ({ wss } = foremanWss);
    port = await startServer();

    await foremanWss.routeEvent("evt-close", "issues", {
      action: "closed",
      issue: { number: 60, title: "Issue 60", body: "body", labels: [{ name: "brunel:ready" }] },
      repository: { full_name: "owner/repo-a" },
    });

    expect((await Task.get("t60a"))?.issueClosedAt).not.toBeNull();
    expect((await Task.get("t60b"))?.issueClosedAt).toBeNull();
  });
});

// ── Full activation → assignment flow ────────────────────────────────────────

describe("Full activation → assignment flow", () => {
  it("worker for new repo receives repo_activated then task_assigned for its own repo only", async () => {
    const m1 = await createTestTaskManager("owner/repo-a"); // starts "new"
    const m2 = await createTestTaskManager("owner/repo-b");
    await m2.repo.activate();

    // Pre-seed tasks for both repos. Repo-b's task is ready immediately.
    await registerReady(m2, "t70b", 70, "owner/repo-b");

    // Mock loadIssuesFromGithub so it sets up repo-a's task during activation.
    vi.spyOn(TaskManager.prototype, "loadIssuesFromGithub").mockImplementation(async function(this: TaskManager) {
      if (this.repo.fullName === "owner/repo-a") {
        await this.enqueueIssue("t60a", 60, "owner/repo-a", "Task A", "", ["brunel:ready"]);
        this.markBlockersLoaded(60);
      }
    });

    ({ wss } = new ForemanWss({ server: httpServer, config: defaultCfg }));
    port = await startServer();

    // Worker connects for repo-a (new repo).
    const ws = await connect({ type: "worker_hello", repo: "owner/repo-a", workerId: "w1", status: "ready" });
    const q = makeQueue(ws);

    const ack = await q.next() as { type: string; repoStatus: string };
    expect(ack.type).toBe("hello_ack");
    expect(ack.repoStatus).toBe("new");

    // Worker activates the repo.
    send(ws, { type: "activate_repo", workerId: "w1" });

    const activated = await q.next() as { type: string };
    expect(activated.type).toBe("repo_activated");

    const assigned = await q.next() as { type: string; issue: { number: number } };
    expect(assigned.type).toBe("task_assigned");
    expect(assigned.issue.number).toBe(60); // repo-a's task

    // Repo-b's task must remain pending.
    expect((await Task.get("t70b"))?.status).toBe("pending");
  });
});

// ── Multi-repo assignment isolation ──────────────────────────────────────────

describe("Multi-repo assignment isolation: two workers, two repos", () => {
  it("each worker is assigned only its own repo's task", async () => {
    const m1 = await createTestTaskManager("owner/repo-a");
    const m2 = await createTestTaskManager("owner/repo-b");
    await m1.repo.activate();
    await m2.repo.activate();

    await registerReady(m1, "t61a", 61, "owner/repo-a");
    await registerReady(m2, "t61b", 61, "owner/repo-b");

    ({ wss } = new ForemanWss({ server: httpServer, config: defaultCfg }));
    port = await startServer();

    // Connect both workers; set up queues immediately to avoid losing early messages.
    const wsA = await connect({ type: "worker_hello", repo: "owner/repo-a", workerId: "wA", status: "ready" });
    const qA = makeQueue(wsA);

    const wsB = await connect({ type: "worker_hello", repo: "owner/repo-b", workerId: "wB", status: "ready" });
    const qB = makeQueue(wsB);

    // Consume hello_acks then task_assigned for each worker.
    await qA.next(); // hello_ack for wA
    await qB.next(); // hello_ack for wB

    const [msgA, msgB] = await Promise.all([qA.next(), qB.next()]) as [
      { type: string; issue: { number: number } },
      { type: string; issue: { number: number } },
    ];

    expect(msgA.type).toBe("task_assigned");
    expect(msgA.issue.number).toBe(61);

    expect(msgB.type).toBe("task_assigned");
    expect(msgB.issue.number).toBe(61);

    // Verify each task is assigned to the correct worker.
    expect((await Task.get("t61a"))?.workerId).toBe("wA");
    expect((await Task.get("t61b"))?.workerId).toBe("wB");
  });

  it("worker from repo-a does not receive tasks from repo-b", async () => {
    const m1 = await createTestTaskManager("owner/repo-a");
    const m2 = await createTestTaskManager("owner/repo-b");
    await m1.repo.activate();
    await m2.repo.activate();

    // Only repo-b has a pending task.
    await registerReady(m2, "t62b", 62, "owner/repo-b");

    ({ wss } = new ForemanWss({ server: httpServer, config: defaultCfg }));
    port = await startServer();

    const ws = await connect({ type: "worker_hello", repo: "owner/repo-a", workerId: "wA", status: "ready" });
    const q = makeQueue(ws);
    await q.next(); // hello_ack

    // Give assignWork time to run — the worker should NOT receive a task.
    await waitUntil(() => Worker.fromRegistry("wA")?.status === "ready");

    // repo-b's task stays pending.
    expect((await Task.get("t62b"))?.status).toBe("pending");
    expect(Worker.fromRegistry("wA")?.status).toBe("ready");
  });
});

// ── Negative: cross-repo task claim ──────────────────────────────────────────

describe("Negative: worker from repo-a cannot claim task from repo-b", () => {
  it("handleBusyHello with a cross-repo taskId sends cancelled ack", async () => {
    // Create two repos; task belongs to repo-b.
    const m1 = await createTestTaskManager("owner/repo-a");
    const m2 = await createTestTaskManager("owner/repo-b");
    await m2.repo.activate();

    await Task.upsert("t63b", 63, "owner/repo-b", "Task B", "body", ["brunel:ready"]);

    // Invoke handleAssignedHello directly (same pattern as foreman.hello-handlers.test.ts).
    const foremanWss = new ForemanWss({ server: httpServer, config: defaultCfg });
    ({ wss } = foremanWss);
    const sendMsg = vi.spyOn(foremanWss.messenger, "send").mockImplementation(() => false);

    // Worker from repo-a claims task "t63b" which belongs to repo-b.
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await foremanWss.handleAssignedHello("wA", "t63b", fakeWs, m1.repo);

    const ackCall = sendMsg.mock.calls.find(([, msg]) => (msg as { type: string }).type === "hello_ack");
    expect(ackCall).toBeDefined();
    const ack = ackCall![1] as { type: string; status: string };
    expect(ack.status).toBe("cancelled");

    // Task must not be assigned to the cross-repo worker.
    expect((await Task.get("t63b"))?.workerId).toBeNull();
  });
});
