/**
 * Unit tests for ForemanWss.handleClaimTask and TaskManager.claimTask.
 *
 * Verifies all claim outcomes: task not found, unassigned, assigned to
 * disconnected worker (allowed), and assigned to connected worker (rejected).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkerController } from "../src/foreman/controllers/worker-controller.js";
import { WorkerMessenger } from "../src/foreman/controllers/worker-messenger.js";
import { Worker } from "../src/foreman/models/worker.js";
import { Task } from "../src/foreman/models/task.js";
import { TaskManager } from "../src/foreman/models/task-manager.js";
import { WebhookEvent } from "../src/foreman/models/webhook-event.js";
import { fakeRepo, resetDb, seedTask, createTestTaskManager } from "./helpers/task.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function fakeWs() {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
}

function makeWss() {
  const messenger = new WorkerMessenger({});
  const wss = new WorkerController({
    config: { taskLabel: "brunel:ready", workerSecret: undefined, pingIntervalMs: 1e9 },
    messenger,
  });
  const sendMsg = vi.spyOn(messenger, "send").mockImplementation(() => true);
  return { wss, sendMsg };
}

function sentMsgOfType(sendMsg: ReturnType<typeof vi.spyOn>, type: string) {
  const call = sendMsg.mock.calls.find(([, msg]) => (msg as { type: string }).type === type);
  return call ? (call[1] as Record<string, unknown>) : undefined;
}

// ── Test setup ─────────────────────────────────────────────────────────────────

let taskManager: TaskManager;

beforeEach(async () => {
  Worker._reset();
  resetDb();
  taskManager = await createTestTaskManager();
  await taskManager.repo.activate();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── handleClaimTask ────────────────────────────────────────────────────────────

describe("handleClaimTask", () => {
  it("sends task_assigned when task is unassigned", async () => {
    const { wss, sendMsg } = makeWss();
    const repo = taskManager.repo;
    Worker.register("w1", fakeWs(), repo);
    await seedTask({ task_id: "10", issue_number: 10, repo_id: repo.id, repo: repo.fullName });

    await wss.handleClaimTask("w1", { type: "claim_task", workerId: "w1", taskId: "10" });

    const msg = sentMsgOfType(sendMsg, "task_assigned");
    expect(msg).toBeDefined();
    expect(msg?.taskId).toBe("10");
  });

  it("marks worker as busy with the claimed task", async () => {
    const { wss } = makeWss();
    const repo = taskManager.repo;
    Worker.register("w1", fakeWs(), repo);
    await seedTask({ task_id: "10", issue_number: 10, repo_id: repo.id, repo: repo.fullName });

    await wss.handleClaimTask("w1", { type: "claim_task", workerId: "w1", taskId: "10" });

    expect(Worker.fromRegistry("w1")?.currentTaskId).toBe("10");
    expect(Worker.fromRegistry("w1")?.status).toBe("assigned");
  });

  it("sends foreman_error (non-fatal) when task does not exist", async () => {
    const { wss, sendMsg } = makeWss();
    Worker.register("w1", fakeWs(), taskManager.repo);

    await wss.handleClaimTask("w1", { type: "claim_task", workerId: "w1", taskId: "999" });

    const msg = sentMsgOfType(sendMsg, "foreman_error");
    expect(msg).toBeDefined();
    expect(msg?.fatal).toBe(false);
    expect(msg?.message).toContain("999");
  });

  it("sends foreman_error when task is assigned to an active (idle) worker", async () => {
    const { wss, sendMsg } = makeWss();
    const repo = taskManager.repo;
    Worker.register("w1", fakeWs(), repo);
    const w2 = Worker.register("w2", fakeWs(), repo);
    const task = await seedTask({ task_id: "10", issue_number: 10, repo_id: repo.id, repo: repo.fullName, worker_id: "w2" });
    w2.assign(task);

    await wss.handleClaimTask("w1", { type: "claim_task", workerId: "w1", taskId: "10" });

    const msg = sentMsgOfType(sendMsg, "foreman_error");
    expect(msg).toBeDefined();
    expect(msg?.fatal).toBe(false);
  });

  it("reassigns task from a disconnected worker", async () => {
    const { wss, sendMsg } = makeWss();
    const repo = taskManager.repo;

    const w2 = Worker.register("w2", fakeWs(), repo);
    const task = await seedTask({ task_id: "10", issue_number: 10, repo_id: repo.id, repo: repo.fullName, worker_id: "w2" });
    w2.assign(task);
    w2.markDisconnected();

    Worker.register("w1", fakeWs(), repo);
    await wss.handleClaimTask("w1", { type: "claim_task", workerId: "w1", taskId: "10" });

    const msg = sentMsgOfType(sendMsg, "task_assigned");
    expect(msg).toBeDefined();
    expect(msg?.taskId).toBe("10");
    expect(Worker.fromRegistry("w1")?.currentTaskId).toBe("10");
  });

  it("reassigns task with no worker in registry (orphaned assignment)", async () => {
    const { wss, sendMsg } = makeWss();
    const repo = taskManager.repo;
    Worker.register("w1", fakeWs(), repo);
    // Seed task with a worker_id that is not in the registry
    await seedTask({ task_id: "10", issue_number: 10, repo_id: repo.id, repo: repo.fullName, worker_id: "ghost-worker" });

    await wss.handleClaimTask("w1", { type: "claim_task", workerId: "w1", taskId: "10" });

    const msg = sentMsgOfType(sendMsg, "task_assigned");
    expect(msg).toBeDefined();
  });

  it("does nothing when worker is not in registry", async () => {
    const { wss, sendMsg } = makeWss();
    await seedTask({ task_id: "10", issue_number: 10, repo_id: taskManager.repo.id, repo: taskManager.repo.fullName });

    await wss.handleClaimTask("unknown-worker", { type: "claim_task", workerId: "unknown-worker", taskId: "10" });

    expect(sendMsg).not.toHaveBeenCalled();
  });

  it("sends foreman_error when task belongs to a different repo", async () => {
    const { wss, sendMsg } = makeWss();
    const repo = taskManager.repo;
    Worker.register("w1", fakeWs(), repo);
    // Seed task with a different repo_id
    await seedTask({ task_id: "10", issue_number: 10, repo_id: 9999, repo: "other/repo" });

    await wss.handleClaimTask("w1", { type: "claim_task", workerId: "w1", taskId: "10" });

    const msg = sentMsgOfType(sendMsg, "foreman_error");
    expect(msg).toBeDefined();
    expect(msg?.fatal).toBe(false);
  });

  it("does not forward any event_notification messages — new worker reads state fresh", async () => {
    const { wss, sendMsg } = makeWss();
    const repo = taskManager.repo;
    Worker.register("w1", fakeWs(), repo);
    await seedTask({ task_id: "10", issue_number: 10, repo_id: repo.id, repo: repo.fullName });

    await wss.handleClaimTask("w1", { type: "claim_task", workerId: "w1", taskId: "10" });

    expect(sentMsgOfType(sendMsg, "event_notification")).toBeUndefined();
  });

  it("includes baseSeqId in task_assigned so the worker knows where to start DB replay", async () => {
    const { wss, sendMsg } = makeWss();
    const repo = taskManager.repo;
    Worker.register("w1", fakeWs(), repo);
    await seedTask({ task_id: "10", issue_number: 10, repo_id: repo.id, repo: repo.fullName });
    vi.spyOn(WebhookEvent, "currentMaxId").mockResolvedValue(55);

    await wss.handleClaimTask("w1", { type: "claim_task", workerId: "w1", taskId: "10" });

    const msg = sentMsgOfType(sendMsg, "task_assigned");
    expect(msg?.baseSeqId).toBe(55);
  });
});

// ── TaskManager.claimTask ──────────────────────────────────────────────────────

describe("TaskManager.claimTask", () => {
  it("returns ok:true for an unassigned task", async () => {
    const repo = taskManager.repo;
    const worker = Worker.register("w1", fakeWs(), repo);
    await seedTask({ task_id: "20", issue_number: 20, repo_id: repo.id, repo: repo.fullName });

    const result = await taskManager.claimTask(worker, "20");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.task.taskId).toBe("20");
  });

  it("returns ok:false for a non-existent task", async () => {
    const worker = Worker.register("w1", fakeWs(), taskManager.repo);
    const result = await taskManager.claimTask(worker, "no-such-task");
    expect(result.ok).toBe(false);
  });

  it("returns ok:false when task belongs to a different repo", async () => {
    const worker = Worker.register("w1", fakeWs(), taskManager.repo);
    await seedTask({ task_id: "20", issue_number: 20, repo_id: 9999, repo: "other/repo" });
    const result = await taskManager.claimTask(worker, "20");
    expect(result.ok).toBe(false);
  });

  it("returns ok:false when task is assigned to a connected worker", async () => {
    const repo = taskManager.repo;
    const w1 = Worker.register("w1", fakeWs(), repo);
    const w2 = Worker.register("w2", fakeWs(), repo);
    const task = await seedTask({ task_id: "20", issue_number: 20, repo_id: repo.id, repo: repo.fullName, worker_id: "w2" });
    w2.assign(task);

    const result = await taskManager.claimTask(w1, "20");
    expect(result.ok).toBe(false);
  });

  it("returns ok:true when task is assigned to a disconnected worker", async () => {
    const repo = taskManager.repo;
    const w2 = Worker.register("w2", fakeWs(), repo);
    const task = await seedTask({ task_id: "20", issue_number: 20, repo_id: repo.id, repo: repo.fullName, worker_id: "w2" });
    w2.assign(task);
    w2.markDisconnected();

    const w1 = Worker.register("w1", fakeWs(), repo);
    const result = await taskManager.claimTask(w1, "20");
    expect(result.ok).toBe(true);
  });

  it("respects the mutex — serial claims don't double-assign", async () => {
    const repo = taskManager.repo;
    const w1 = Worker.register("w1", fakeWs(), repo);
    const w2 = Worker.register("w2", fakeWs(), repo);
    await seedTask({ task_id: "20", issue_number: 20, repo_id: repo.id, repo: repo.fullName });

    const [r1, r2] = await Promise.all([
      taskManager.claimTask(w1, "20"),
      taskManager.claimTask(w2, "20"),
    ]);

    const successes = [r1, r2].filter(r => r.ok);
    expect(successes).toHaveLength(1);
  });
});
