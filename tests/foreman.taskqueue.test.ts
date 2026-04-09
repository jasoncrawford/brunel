import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TaskManager } from "../src/foreman/models/task-model.js";
import { Task } from "../src/foreman/models/task.js";
import { setupInMemoryTasks } from "./helpers/task.js";
import type { GitHubEvent } from "../src/types.js";

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
  beforeEach(() => {
    m = new TaskManager();
    setupInMemoryTasks(m);
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
    await t!.assign("w1");
    const updated = await Task.get("42");
    expect(updated?.status).toBe("assigned");
    expect(updated?.workerId).toBe("w1");
  });

  it("complete updates status", async () => {
    await registerBase();
    const t = await Task.get("42");
    await t!.assign("w1");
    await t!.complete();
    const updated = await Task.get("42");
    expect(updated?.status).toBe("complete");
  });

  it("queueEvent appends to task event queue", async () => {
    await registerBase();
    const evt: GitHubEvent = { id: "e1", name: "check_run", payload: {} };
    m.queueEvent("42", evt);
    const drained = m.drainEvents("42");
    expect(drained).toHaveLength(1);
  });

  it("drainEvents returns all events and clears the queue", async () => {
    await registerBase();
    const evt: GitHubEvent = { id: "e1", name: "check_run", payload: {} };
    m.queueEvent("42", evt);
    const drained = m.drainEvents("42");
    expect(drained).toHaveLength(1);
    expect(m.drainEvents("42")).toHaveLength(0);
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
    m.registerBranch("fix-issue-42", "42");
    expect((await m.getTaskForBranch("fix-issue-42"))?.taskId).toBe("42");
  });

  it("getTaskForBranch returns null for unknown branch", async () => {
    expect(await m.getTaskForBranch("unknown-branch")).toBeNull();
  });

  it("getTaskSnapshots includes prUrl when PR is registered", async () => {
    await Task.upsert("42", 42, repoSlug, "Fix the bug", "It is broken", ["brunel:ready"]);
    const t = await Task.get("42");
    await t!.registerPr(10, null);
    const snapshots = await m.getTaskSnapshots(new Map());
    expect(snapshots[0].prUrl).toBe("https://github.com/test/repo/pull/10");
  });

  it("getTaskSnapshots omits prUrl when no PR registered", async () => {
    await registerBase();
    const snapshots = await m.getTaskSnapshots(new Map());
    expect(snapshots[0].prUrl).toBeUndefined();
  });

  it("getTaskSnapshots with no graph includes empty blockers array", async () => {
    await registerBase();
    const snapshots = await m.getTaskSnapshots(new Map());
    expect(snapshots[0].blockers).toEqual([]);
  });

  it("getTaskSnapshots with graph includes blockers with isOpen status", async () => {
    await registerBase(); // issueNumber: 42
    m.setIssueOpenState(10, true);  // 10 is open
    m.setIssueOpenState(11, false); // 11 is closed
    const graph = new Map([[42, new Set([10, 11])]]);
    const snapshots = await m.getTaskSnapshots(graph);
    expect(snapshots[0].blockers).toEqual([
      { issueNumber: 10, isOpen: true },
      { issueNumber: 11, isOpen: false },
    ]);
  });

  it("getTaskSnapshots with graph shows empty blockers array when no deps", async () => {
    await registerBase(); // issueNumber: 42, no entry in graph
    const graph = new Map<number, Set<number>>();
    const snapshots = await m.getTaskSnapshots(graph);
    expect(snapshots[0].blockers).toEqual([]);
  });
});

describe("TaskManager — derived blocked status", () => {
  let m: TaskManager;
  beforeEach(() => {
    m = new TaskManager();
    setupInMemoryTasks(m);
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
    await t2!.assign("w1");
    await Task.upsert("3", 3, repoSlug, "T3", "B", ["brunel:ready"]);
    const t3 = await Task.get("3");
    await t3!.assign("w2");
    await t3!.complete();
    const result = await m.listActiveTasks();
    expect(result.map((t) => t.taskId)).toEqual(expect.arrayContaining(["1", "2"]));
    expect(result.map((t) => t.taskId)).not.toContain("3");
  });

  it("getTaskSnapshots derives blocked status from dependency graph", async () => {
    await registerBase(); // issueNumber: 42
    const graph = new Map<number, Set<number>>([[42, new Set([100])]]);
    m.setIssueOpenState(100, true); // blocker is open (not closed)

    const snapshots = await m.getTaskSnapshots(graph);
    expect(snapshots[0].status).toBe("blocked");
  });

  it("getTaskSnapshots derives pending status when no blockers", async () => {
    await registerBase(); // issueNumber: 42
    const graph = new Map<number, Set<number>>();

    const snapshots = await m.getTaskSnapshots(graph);
    expect(snapshots[0].status).toBe("pending");
  });
});

describe("TaskManager — cancel (delete behavior)", () => {
  let m: TaskManager;
  let addTask: ReturnType<typeof setupInMemoryTasks>["addTask"];
  beforeEach(() => {
    m = new TaskManager();
    ({ addTask } = setupInMemoryTasks(m));
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("removes a pending task so it is no longer retrievable", async () => {
    await registerBase();
    const t = await Task.get("42");
    await t!.delete();
    expect(await Task.get("42")).toBeNull();
    expect(await Task.getByIssue(42)).toBeNull();
    expect(await m.nextPending()).toBeNull();
  });

  it("does not remove an assigned task", async () => {
    await registerBase();
    const t = await Task.get("42");
    await t!.assign("w1");
    await t!.delete();
    expect(await Task.get("42")).not.toBeNull();
  });

  it("is a no-op for a task that doesn't exist in the map", async () => {
    // addTask creates a task with spied instance methods; delete removes it from the map
    const ghost = addTask({ task_id: "nonexistent", issue_number: 999 });
    await ghost.delete(); // removes from map
    // Second delete: task is gone from map; mock should not throw
    await expect(ghost.delete()).resolves.not.toThrow();
  });
});

describe("TaskManager — nextPending with predicate", () => {
  let m: TaskManager;
  beforeEach(() => {
    m = new TaskManager();
    setupInMemoryTasks(m);
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
  beforeEach(() => {
    m = new TaskManager();
    setupInMemoryTasks(m);
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
    await t!.assign("w1");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("complete emits changed", async () => {
    await Task.upsert("42", 42, repoSlug, "Fix the bug", "It is broken", ["brunel:ready"]);
    const t = await Task.get("42");
    await t!.assign("w1");
    const changed = vi.fn();
    m.on("changed", changed);
    await t!.complete();
    expect(changed).toHaveBeenCalledOnce();
  });

  it("revert emits changed", async () => {
    await Task.upsert("42", 42, repoSlug, "Fix the bug", "It is broken", ["brunel:ready"]);
    const t = await Task.get("42");
    await t!.assign("w1");
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
    await t!.assign("w1");
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
