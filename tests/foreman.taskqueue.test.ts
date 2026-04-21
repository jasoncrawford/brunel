import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TaskManager } from "../src/foreman/models/task-manager.js";
import { Task } from "../src/foreman/models/task.js";
import { Worker } from "../src/foreman/models/worker.js";
import { resetDb, createTestTaskManager } from "./helpers/task.js";
import { WebhookEvent } from "../src/foreman/models/webhook-event.js";

const repoSlug = "test/repo";

async function registerBase(overrides: { taskId?: string; issueNumber?: number; title?: string; body?: string; labels?: string[] } = {}) {
  const taskId = overrides.taskId ?? "42";
  const issueNumber = overrides.issueNumber ?? 42;
  const title = overrides.title ?? "Fix the bug";
  const body = overrides.body ?? "It is broken";
  const labels = overrides.labels ?? ["brunel:ready"];
  await Task.upsert(taskId, issueNumber, repoSlug, title, body, labels);
}

describe("TaskManager — queue operations", () => {
  let m: TaskManager;
  beforeEach(async () => {
    Worker._reset();
    m = await createTestTaskManager();
    resetDb();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("upsert makes task pending by default", async () => {
    await registerBase();
    expect((await Task.get("42"))?.status).toBe("pending");
  });

  it("nextPending returns first pending task", async () => {
    await registerBase();
    const t = await m.nextPending();
    expect(t?.taskId).toBe("42");
  });

  it("nextPending returns null when no pending tasks", async () => {
    expect(await m.nextPending()).toBeNull();
  });

  it("assign updates status and workerId", async () => {
    await registerBase();
    const t = await Task.get("42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs));
    const updated = await Task.get("42");
    expect(updated?.status).toBe("assigned");
    expect(updated?.workerId).toBe("w1");
  });

  it("complete updates status", async () => {
    await registerBase();
    const t = await Task.get("42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs));
    await t!.complete();
    const updated = await Task.get("42");
    expect(updated?.status).toBe("complete");
  });

  it("queueEvent appends to task event queue", async () => {
    await registerBase();
    const t = await Task.get("42");
    const evt = WebhookEvent.fromIncoming("e1", "check_run", {});
    m.queueEvent(t!, evt);
    const drained = m.drainEvents(t!);
    expect(drained).toHaveLength(1);
  });

  it("drainEvents returns all events and clears the queue", async () => {
    await registerBase();
    const t = await Task.get("42");
    const evt = WebhookEvent.fromIncoming("e1", "check_run", {});
    m.queueEvent(t!, evt);
    const drained = m.drainEvents(t!);
    expect(drained).toHaveLength(1);
    expect(m.drainEvents(t!)).toHaveLength(0);
  });

  it("Task.getByIssue looks up by issueNumber", async () => {
    await registerBase();
    expect((await Task.getByIssue(42))?.taskId).toBe("42");
  });

  it("registerPr + Task.getByPr looks up task by PR number", async () => {
    await registerBase();
    const t = await Task.get("42");
    await t!.registerPr(10, null);
    expect((await Task.getByPr(10))?.taskId).toBe("42");
  });

  it("registerPr stores prNumber on the task", async () => {
    await registerBase();
    const t = await Task.get("42");
    await t!.registerPr(10, null);
    expect((await Task.get("42"))?.prNumber).toBe(10);
  });

  it("Task.getByPr returns null for unknown PR number", async () => {
    expect(await Task.getByPr(999)).toBeNull();
  });

  it("registerBranch + getTaskForBranch looks up task by branch name", async () => {
    await registerBase();
    const t = await Task.get("42");
    m.registerBranch("fix-issue-42", t!);
    expect((await m.getTaskForBranch("fix-issue-42"))?.taskId).toBe("42");
  });

  it("getTaskForBranch returns null for unknown branch", async () => {
    expect(await m.getTaskForBranch("unknown-branch")).toBeNull();
  });

  it("getTasksForBroadcast includes prUrl when PR is registered", async () => {
    await Task.upsert("42", 42, repoSlug, "Fix the bug", "It is broken", ["brunel:ready"]);
    const t = await Task.get("42");
    await t!.registerPr(10, null);
    const snapshots = await m.getTasksForBroadcast();
    expect(snapshots[0].prUrl).toBe("https://github.com/test/repo/pull/10");
  });

  it("getTasksForBroadcast omits prUrl when no PR registered", async () => {
    await registerBase();
    const snapshots = await m.getTasksForBroadcast();
    expect(snapshots[0].prUrl).toBeUndefined();
  });

  it("getTasksForBroadcast includes empty blockers array when no blockers set", async () => {
    await registerBase();
    const snapshots = await m.getTasksForBroadcast();
    expect(snapshots[0].blockers).toEqual([]);
  });

  it("getTasksForBroadcast includes blockers with isOpen status", async () => {
    await registerBase(); // issueNumber: 42
    m.setBlockers(42, [10, 11]);
    m.setIssueOpenState(10, true);  // 10 is open
    m.setIssueOpenState(11, false); // 11 is closed
    const snapshots = await m.getTasksForBroadcast();
    expect(snapshots[0].blockers).toEqual([
      { issueNumber: 10, isOpen: true },
      { issueNumber: 11, isOpen: false },
    ]);
  });

  it("getTasksForBroadcast shows empty blockers array when no deps set", async () => {
    await registerBase(); // issueNumber: 42, no blockers set
    const snapshots = await m.getTasksForBroadcast();
    expect(snapshots[0].blockers).toEqual([]);
  });
});

describe("TaskManager — derived blocked status", () => {
  let m: TaskManager;
  beforeEach(async () => {
    m = await createTestTaskManager();
    resetDb();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("nextPending with isReady callback can skip blocked tasks", async () => {
    await registerBase();
    const task1 = await m.nextPending(() => true);
    expect(task1?.taskId).toBe("42");

    const task2 = await m.nextPending(() => false);
    expect(task2).toBeNull();
  });

  it("listActiveTasks returns pending and assigned but not complete", async () => {
    await Task.upsert("1", 1, repoSlug, "T1", "B", ["brunel:ready"]);
    await Task.upsert("2", 2, repoSlug, "T2", "B", ["brunel:ready"]);
    const t2 = await Task.get("2");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t2!.assign(Worker.register("w1", fakeWs));
    await Task.upsert("3", 3, repoSlug, "T3", "B", ["brunel:ready"]);
    const t3 = await Task.get("3");
    await t3!.assign(Worker.register("w2", fakeWs));
    await t3!.complete();
    const result = await m.listActiveTasks();
    expect(result.map((t) => t.taskId)).toEqual(expect.arrayContaining(["1", "2"]));
    expect(result.map((t) => t.taskId)).not.toContain("3");
  });

  it("getTasksForBroadcast derives blocked status when blocker is open", async () => {
    await registerBase(); // issueNumber: 42
    m.trackIssue(42);
    m.setBlockers(42, [100]);
    m.markBlockersLoaded(42);
    m.setIssueOpenState(100, true); // blocker is open (not closed)

    const snapshots = await m.getTasksForBroadcast();
    expect(snapshots[0].status).toBe("blocked");
  });

  it("getTasksForBroadcast derives pending status when no blockers", async () => {
    await registerBase(); // issueNumber: 42, no blockers

    const snapshots = await m.getTasksForBroadcast();
    expect(snapshots[0].status).toBe("pending");
  });
});

describe("TaskManager — cancel (delete behavior)", () => {
  let m: TaskManager;
  beforeEach(async () => {
    Worker._reset();
    m = await createTestTaskManager();
    resetDb();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("removes a pending task so it is no longer retrievable", async () => {
    await registerBase();
    const t = await Task.get("42");
    await t!.deleteIfUnassigned();
    expect(await Task.get("42")).toBeNull();
    expect(await Task.getByIssue(42)).toBeNull();
    expect(await m.nextPending()).toBeNull();
  });

  it("does not remove an assigned task", async () => {
    await registerBase();
    const t = await Task.get("42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs));
    await t!.deleteIfUnassigned();
    expect(await Task.get("42")).not.toBeNull();
  });

  it("is a no-op for a task that no longer exists in the DB", async () => {
    await Task.upsert("nonexistent", 999, repoSlug, "Ghost", "body", []);
    const ghost = await Task.get("nonexistent");
    await ghost!.delete(); // removes from DB
    // Second delete: task is gone; should not throw
    await expect(ghost!.delete()).resolves.not.toThrow();
  });
});

describe("TaskManager — nextPending with predicate", () => {
  let m: TaskManager;
  beforeEach(async () => {
    m = await createTestTaskManager();
    resetDb();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns null when all pending tasks fail the predicate", async () => {
    await Task.upsert("1", 1, repoSlug, "T1", "B", []);
    await Task.upsert("2", 2, repoSlug, "T2", "B", []);
    expect(await m.nextPending(() => false)).toBeNull();
  });

  it("skips tasks that fail predicate and returns first that passes", async () => {
    await Task.upsert("1", 1, repoSlug, "T1", "B", []);
    await Task.upsert("2", 2, repoSlug, "T2", "B", []);
    const t = await m.nextPending((task) => task.issueNumber === 2);
    expect(t?.taskId).toBe("2");
  });

  it("no predicate returns first pending", async () => {
    await Task.upsert("1", 1, repoSlug, "T1", "B", []);
    await Task.upsert("2", 2, repoSlug, "T2", "B", []);
    // list sorts by createdAt desc, so "2" was upserted last → appears first
    expect((await m.nextPending())?.taskId).toBeDefined();
  });
});

describe("TaskManager changed events", () => {
  let m: TaskManager;
  beforeEach(async () => {
    Worker._reset();
    m = await createTestTaskManager();
    resetDb();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("upsert emits changed", async () => {
    const changed = vi.fn();
    m.on("changed", changed);
    await Task.upsert("42", 42, repoSlug, "Fix the bug", "It is broken", ["brunel:ready"]);
    expect(changed).toHaveBeenCalled();
  });

  it("assign emits changed", async () => {
    await Task.upsert("42", 42, repoSlug, "Fix the bug", "It is broken", ["brunel:ready"]);
    const changed = vi.fn();
    m.on("changed", changed);
    const t = await Task.get("42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs));
    expect(changed).toHaveBeenCalledOnce();
  });

  it("complete emits changed", async () => {
    await Task.upsert("42", 42, repoSlug, "Fix the bug", "It is broken", ["brunel:ready"]);
    const t = await Task.get("42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs));
    const changed = vi.fn();
    m.on("changed", changed);
    await t!.complete();
    expect(changed).toHaveBeenCalledOnce();
  });

  it("revert emits changed", async () => {
    await Task.upsert("42", 42, repoSlug, "Fix the bug", "It is broken", ["brunel:ready"]);
    const t = await Task.get("42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs));
    const changed = vi.fn();
    m.on("changed", changed);
    await t!.revert();
    expect(changed).toHaveBeenCalledOnce();
  });

  it("delete emits changed when task removed", async () => {
    await Task.upsert("42", 42, repoSlug, "Fix the bug", "It is broken", ["brunel:ready"]);
    const changed = vi.fn();
    m.on("changed", changed);
    const t = await Task.get("42");
    await t!.delete();
    expect(changed).toHaveBeenCalledOnce();
  });

  it("delete emits changed even for assigned task (row preserved)", async () => {
    await Task.upsert("42", 42, repoSlug, "Fix the bug", "It is broken", ["brunel:ready"]);
    const t = await Task.get("42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs));
    const changed = vi.fn();
    m.on("changed", changed);
    await t!.delete(); // row not deleted (assignedAt set), but changed still emits
    expect(changed).toHaveBeenCalledOnce();
  });

  it("registerPr emits changed", async () => {
    await Task.upsert("42", 42, repoSlug, "Fix the bug", "It is broken", ["brunel:ready"]);
    const changed = vi.fn();
    m.on("changed", changed);
    const t = await Task.get("42");
    await t!.registerPr(10, null);
    expect(changed).toHaveBeenCalled();
  });

  it("unregisterPr clears prNumber from the task", async () => {
    await Task.upsert("42", 42, repoSlug, "Fix the bug", "It is broken", ["brunel:ready"]);
    const t = await Task.get("42");
    await t!.registerPr(10, null);
    await t!.unregisterPr();
    expect((await Task.get("42"))?.prNumber).toBeNull();
  });

  it("unregisterPr removes PR from routing so Task.getByPr returns null", async () => {
    await Task.upsert("42", 42, repoSlug, "Fix the bug", "It is broken", ["brunel:ready"]);
    const t = await Task.get("42");
    await t!.registerPr(10, null);
    await t!.unregisterPr();
    expect(await Task.getByPr(10)).toBeNull();
  });

  it("unregisterPr emits changed", async () => {
    await Task.upsert("42", 42, repoSlug, "Fix the bug", "It is broken", ["brunel:ready"]);
    const t = await Task.get("42");
    await t!.registerPr(10, null);
    const changed = vi.fn();
    m.on("changed", changed);
    await t!.unregisterPr();
    expect(changed).toHaveBeenCalled();
  });

  it("unregisterPr on already-null PR is a no-op (no-throw)", async () => {
    await Task.upsert("42", 42, repoSlug, "Fix the bug", "It is broken", ["brunel:ready"]);
    const t = await Task.get("42");
    // prNumber is already null, unregisterPr should not throw
    await expect(t!.unregisterPr()).resolves.not.toThrow();
  });
});
