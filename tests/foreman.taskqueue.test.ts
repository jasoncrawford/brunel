import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskModel } from "../src/foreman/task-model.js";
import type { GitHubEvent } from "../src/types.js";

const baseTask = {
  taskId: "42",
  issueNumber: 42,
  title: "Fix the bug",
  body: "It is broken",
  labels: ["brunel:ready"],
  repoUrl: "https://github.com/test/repo",
};

describe("TaskModel — queue operations", () => {
  let m: TaskModel;
  beforeEach(() => { m = new TaskModel(); });

  it("loadTask makes task pending by default", () => {
    m.loadTask(baseTask);
    expect(m.get("42")?.status).toBe("pending");
  });

  it("nextPending returns first pending task", () => {
    m.loadTask(baseTask);
    const t = m.nextPending();
    expect(t?.taskId).toBe("42");
  });

  it("nextPending returns null when no pending tasks", () => {
    expect(m.nextPending()).toBeNull();
  });

  it("assignInMemory updates status and assignedWorkerId", () => {
    m.loadTask(baseTask);
    m.nextPending();
    m.assignInMemory("42", "w1");
    expect(m.get("42")?.status).toBe("assigned");
    expect(m.get("42")?.assignedWorkerId).toBe("w1");
  });

  it("complete updates status", async () => {
    m.loadTask(baseTask);
    m.assignInMemory("42", "w1");
    await m.complete("42");
    expect(m.get("42")?.status).toBe("complete");
  });

  it("queueEvent appends to task eventQueue", () => {
    m.loadTask(baseTask);
    const evt: GitHubEvent = { id: "e1", name: "check_run", payload: {} };
    m.queueEvent("42", evt);
    expect(m.get("42")?.eventQueue).toHaveLength(1);
  });

  it("drainEvents returns all events and clears the queue", () => {
    m.loadTask(baseTask);
    const evt: GitHubEvent = { id: "e1", name: "check_run", payload: {} };
    m.queueEvent("42", evt);
    const drained = m.drainEvents("42");
    expect(drained).toHaveLength(1);
    expect(m.get("42")?.eventQueue).toHaveLength(0);
  });

  it("getTaskForIssue looks up by issueNumber", () => {
    m.loadTask(baseTask);
    expect(m.getTaskForIssue(42)?.taskId).toBe("42");
  });

  it("registerPr + getTaskForPr looks up task by PR number", async () => {
    m.loadTask(baseTask);
    await m.registerPr("42", 10, null);
    expect(m.getTaskForPr(10)?.taskId).toBe("42");
  });

  it("registerPr stores prNumber on the task", async () => {
    m.loadTask(baseTask);
    await m.registerPr("42", 10, null);
    expect(m.get("42")?.prNumber).toBe(10);
  });

  it("getTaskForPr returns undefined for unknown PR number", () => {
    expect(m.getTaskForPr(999)).toBeUndefined();
  });

  it("registerBranch + getTaskForBranch looks up task by branch name", () => {
    m.loadTask(baseTask);
    m.registerBranch("fix-issue-42", "42");
    expect(m.getTaskForBranch("fix-issue-42")?.taskId).toBe("42");
  });

  it("getTaskForBranch returns undefined for unknown branch", () => {
    expect(m.getTaskForBranch("unknown-branch")).toBeUndefined();
  });

  it("getTaskSnapshots includes prUrl when PR is registered", async () => {
    m.loadTask(baseTask);
    await m.registerPr("42", 10, null);
    const snapshots = m.getTaskSnapshots(new Map());
    expect(snapshots[0].prUrl).toBe("https://github.com/test/repo/pull/10");
  });

  it("getTaskSnapshots omits prUrl when no PR registered", () => {
    m.loadTask(baseTask);
    const snapshots = m.getTaskSnapshots(new Map());
    expect(snapshots[0].prUrl).toBeUndefined();
  });

  it("getTaskSnapshots with no graph omits blockers field", () => {
    // getTaskSnapshots always takes a graph via TaskModel, so passing empty
    // graph still includes an empty blockers array
    m.loadTask(baseTask);
    const snapshots = m.getTaskSnapshots(new Map());
    expect(snapshots[0].blockers).toEqual([]);
  });

  it("getTaskSnapshots with graph includes blockers with isOpen status", () => {
    m.loadTask(baseTask); // issueNumber: 42
    m.setIssueOpenState(10, true);  // 10 is open
    m.setIssueOpenState(11, false); // 11 is closed
    const graph = new Map([[42, new Set([10, 11])]]);
    const snapshots = m.getTaskSnapshots(graph);
    expect(snapshots[0].blockers).toEqual([
      { issueNumber: 10, isOpen: true },
      { issueNumber: 11, isOpen: false },
    ]);
  });

  it("getTaskSnapshots with graph shows empty blockers array when no deps", () => {
    m.loadTask(baseTask); // issueNumber: 42, no entry in graph
    const graph = new Map<number, Set<number>>();
    const snapshots = m.getTaskSnapshots(graph);
    expect(snapshots[0].blockers).toEqual([]);
  });
});

describe("TaskModel — blocked status", () => {
  let m: TaskModel;
  beforeEach(() => { m = new TaskModel(); });

  it("loadTask with status=blocked creates a blocked task", () => {
    m.loadTask({ ...baseTask, status: "blocked" });
    expect(m.get("42")?.status).toBe("blocked");
  });

  it("block transitions pending → blocked", async () => {
    m.loadTask(baseTask);
    await m.block("42");
    expect(m.get("42")?.status).toBe("blocked");
  });

  it("block is a no-op on non-pending tasks", () => {
    m.loadTask(baseTask);
    m.assignInMemory("42", "w1");
    m.block("42");
    expect(m.get("42")?.status).toBe("assigned");
  });

  it("unblock transitions blocked → pending", async () => {
    m.loadTask({ ...baseTask, status: "blocked" });
    await m.unblock("42");
    expect(m.get("42")?.status).toBe("pending");
  });

  it("unblock is a no-op on non-blocked tasks", () => {
    m.loadTask(baseTask);
    m.unblock("42");
    expect(m.get("42")?.status).toBe("pending"); // unchanged
  });

  it("nextPending does not return blocked tasks", () => {
    m.loadTask({ ...baseTask, status: "blocked" });
    expect(m.nextPending()).toBeNull();
  });

  it("block emits changed", async () => {
    m.loadTask(baseTask);
    const changed = vi.fn();
    m.on("changed", changed);
    await m.block("42");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("unblock emits changed", async () => {
    m.loadTask({ ...baseTask, status: "blocked" });
    const changed = vi.fn();
    m.on("changed", changed);
    await m.unblock("42");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("getPendingAndBlockedTasks returns pending and blocked but not assigned/complete", () => {
    m.loadTask({ ...baseTask, taskId: "1", issueNumber: 1 }); // pending
    m.loadTask({ ...baseTask, taskId: "2", issueNumber: 2, status: "blocked" }); // blocked
    m.loadTask({ ...baseTask, taskId: "3", issueNumber: 3 }); // will be assigned
    m.assignInMemory("3", "w1");
    const result = m.getPendingAndBlockedTasks();
    expect(result.map((t) => t.taskId)).toEqual(expect.arrayContaining(["1", "2"]));
    expect(result.map((t) => t.taskId)).not.toContain("3");
  });

  it("getTaskSnapshots includes blocked status", () => {
    m.loadTask({ ...baseTask, status: "blocked" });
    const snapshots = m.getTaskSnapshots(new Map());
    expect(snapshots[0].status).toBe("blocked");
  });
});

describe("TaskModel — cancel (removeTask behavior)", () => {
  let m: TaskModel;
  beforeEach(() => { m = new TaskModel(); });

  it("removes a pending task so it is no longer retrievable", async () => {
    m.loadTask(baseTask);
    await m.cancel("42");
    expect(m.get("42")).toBeUndefined();
    expect(m.getTaskForIssue(42)).toBeUndefined();
    expect(m.nextPending()).toBeNull();
  });

  it("removes a blocked task (label was removed while task was blocked)", async () => {
    m.loadTask({ ...baseTask, status: "blocked" });
    await m.cancel("42");
    expect(m.get("42")).toBeUndefined();
  });

  it("does not remove an assigned task", async () => {
    m.loadTask(baseTask);
    m.assignInMemory("42", "w1");
    await m.cancel("42");
    expect(m.get("42")).toBeDefined();
  });

  it("is a no-op for unknown taskId", async () => {
    await expect(m.cancel("nonexistent")).resolves.not.toThrow();
  });
});

describe("TaskModel — nextPending with predicate", () => {
  let m: TaskModel;
  beforeEach(() => { m = new TaskModel(); });

  it("returns null when all pending tasks fail the predicate", () => {
    m.loadTask({ ...baseTask, taskId: "1", issueNumber: 1 });
    m.loadTask({ ...baseTask, taskId: "2", issueNumber: 2 });
    expect(m.nextPending(() => false)).toBeNull();
  });

  it("skips tasks that fail predicate and returns first that passes", () => {
    m.loadTask({ ...baseTask, taskId: "1", issueNumber: 1 });
    m.loadTask({ ...baseTask, taskId: "2", issueNumber: 2 });
    const t = m.nextPending((task) => task.issueNumber === 2);
    expect(t?.taskId).toBe("2");
  });

  it("no predicate behaves as before (returns first pending)", () => {
    m.loadTask({ ...baseTask, taskId: "1", issueNumber: 1 });
    m.loadTask({ ...baseTask, taskId: "2", issueNumber: 2 });
    expect(m.nextPending()?.taskId).toBe("1");
  });
});

describe("TaskModel changed events", () => {
  let m: TaskModel;
  beforeEach(() => { m = new TaskModel(); });

  it("loadTask emits changed", () => {
    const changed = vi.fn();
    m.on("changed", changed);
    m.loadTask(baseTask);
    expect(changed).toHaveBeenCalled();
  });

  it("assignInMemory emits changed", () => {
    m.loadTask(baseTask);
    const changed = vi.fn();
    m.on("changed", changed);
    m.assignInMemory("42", "w1");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("complete emits changed", async () => {
    m.loadTask(baseTask);
    m.assignInMemory("42", "w1");
    const changed = vi.fn();
    m.on("changed", changed);
    await m.complete("42");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("revert emits changed", async () => {
    m.loadTask(baseTask);
    m.assignInMemory("42", "w1");
    const changed = vi.fn();
    m.on("changed", changed);
    await m.revert("42");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("cancel emits changed when task removed", async () => {
    m.loadTask(baseTask);
    const changed = vi.fn();
    m.on("changed", changed);
    await m.cancel("42");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("cancel does not emit changed for assigned task", async () => {
    m.loadTask(baseTask);
    m.assignInMemory("42", "w1");
    const changed = vi.fn();
    m.on("changed", changed);
    await m.cancel("42"); // no-op for assigned tasks
    expect(changed).not.toHaveBeenCalled();
  });

  it("registerPr emits changed", async () => {
    m.loadTask(baseTask);
    const changed = vi.fn();
    m.on("changed", changed);
    await m.registerPr("42", 10, null);
    expect(changed).toHaveBeenCalled();
  });

  it("unregisterPr clears prNumber from the task", async () => {
    m.loadTask(baseTask);
    await m.registerPr("42", 10, null);
    await m.unregisterPr(10);
    expect(m.get("42")?.prNumber).toBeUndefined();
  });

  it("unregisterPr removes PR from routing so getTaskForPr returns undefined", async () => {
    m.loadTask(baseTask);
    await m.registerPr("42", 10, null);
    await m.unregisterPr(10);
    expect(m.getTaskForPr(10)).toBeUndefined();
  });

  it("unregisterPr emits changed", async () => {
    m.loadTask(baseTask);
    await m.registerPr("42", 10, null);
    const changed = vi.fn();
    m.on("changed", changed);
    await m.unregisterPr(10);
    expect(changed).toHaveBeenCalled();
  });

  it("unregisterPr is a no-op for unknown PR number", async () => {
    await expect(m.unregisterPr(999)).resolves.not.toThrow();
  });
});
