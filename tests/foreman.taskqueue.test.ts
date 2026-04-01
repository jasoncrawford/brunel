import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskQueue } from "../src/foreman.js";
import type { GitHubEvent } from "../src/types.js";

const baseTask = {
  taskId: "42",
  issueNumber: 42,
  title: "Fix the bug",
  body: "It is broken",
  labels: ["brunel:ready"],
  repoUrl: "https://github.com/test/repo",
};

describe("TaskQueue", () => {
  let q: TaskQueue;
  beforeEach(() => { q = new TaskQueue(); });

  it("addTask makes task pending", () => {
    q.addTask(baseTask);
    expect(q.get("42")?.status).toBe("pending");
  });

  it("nextPending returns first pending task and removes it from pending", () => {
    q.addTask(baseTask);
    const t = q.nextPending();
    expect(t?.taskId).toBe("42");
    // Still in map but status changes when assigned
  });

  it("nextPending returns null when no pending tasks", () => {
    expect(q.nextPending()).toBeNull();
  });

  it("assignTask updates status and assignedWorkerId", () => {
    q.addTask(baseTask);
    q.nextPending();
    q.assignTask("42", "w1");
    expect(q.get("42")?.status).toBe("assigned");
    expect(q.get("42")?.assignedWorkerId).toBe("w1");
  });

  it("completeTask updates status", () => {
    q.addTask(baseTask);
    q.assignTask("42", "w1");
    q.completeTask("42");
    expect(q.get("42")?.status).toBe("complete");
  });

  it("queueEvent appends to task eventQueue", () => {
    q.addTask(baseTask);
    const evt: GitHubEvent = { id: "e1", name: "check_run", payload: {} };
    q.queueEvent("42", evt);
    expect(q.get("42")?.eventQueue).toHaveLength(1);
  });

  it("drainEvents returns all events and clears the queue", () => {
    q.addTask(baseTask);
    const evt: GitHubEvent = { id: "e1", name: "check_run", payload: {} };
    q.queueEvent("42", evt);
    const drained = q.drainEvents("42");
    expect(drained).toHaveLength(1);
    expect(q.get("42")?.eventQueue).toHaveLength(0);
  });

  it("getTaskForIssue looks up by issueNumber", () => {
    q.addTask(baseTask);
    expect(q.getTaskForIssue(42)?.taskId).toBe("42");
  });

  it("registerPr + getTaskForPr looks up task by PR number", () => {
    q.addTask(baseTask);
    q.registerPr(10, "42");
    expect(q.getTaskForPr(10)?.taskId).toBe("42");
  });

  it("registerPr stores prNumber on the task", () => {
    q.addTask(baseTask);
    q.registerPr(10, "42");
    expect(q.get("42")?.prNumber).toBe(10);
  });

  it("getTaskForPr returns undefined for unknown PR number", () => {
    expect(q.getTaskForPr(999)).toBeUndefined();
  });

  it("registerPr for unknown taskId returns no task from getTaskForPr", () => {
    q.registerPr(10, "nonexistent");
    expect(q.getTaskForPr(10)).toBeUndefined();
  });

  it("registerBranch + getTaskForBranch looks up task by branch name", () => {
    q.addTask(baseTask);
    q.registerBranch("fix-issue-42", "42");
    expect(q.getTaskForBranch("fix-issue-42")?.taskId).toBe("42");
  });

  it("getTaskForBranch returns undefined for unknown branch", () => {
    expect(q.getTaskForBranch("unknown-branch")).toBeUndefined();
  });

  it("getTaskSnapshots includes prUrl when PR is registered", () => {
    q.addTask(baseTask);
    q.registerPr(10, "42");
    const snapshots = q.getTaskSnapshots();
    expect(snapshots[0].prUrl).toBe("https://github.com/test/repo/pull/10");
  });

  it("getTaskSnapshots omits prUrl when no PR registered", () => {
    q.addTask(baseTask);
    const snapshots = q.getTaskSnapshots();
    expect(snapshots[0].prUrl).toBeUndefined();
  });

  it("getTaskSnapshots with no graph/openIssues omits blockers field", () => {
    q.addTask(baseTask);
    const snapshots = q.getTaskSnapshots();
    expect(snapshots[0].blockers).toBeUndefined();
  });

  it("getTaskSnapshots with graph includes blockers with isOpen status", () => {
    q.addTask(baseTask); // issueNumber: 42
    const graph = new Map([[42, new Set([10, 11])]]);
    const openIssues = new Set([10]); // 10 is open, 11 is closed
    const snapshots = q.getTaskSnapshots(graph, openIssues);
    expect(snapshots[0].blockers).toEqual([
      { issueNumber: 10, isOpen: true },
      { issueNumber: 11, isOpen: false },
    ]);
  });

  it("getTaskSnapshots with graph shows empty blockers array when no deps", () => {
    q.addTask(baseTask); // issueNumber: 42, no entry in graph
    const graph = new Map<number, Set<number>>();
    const openIssues = new Set<number>();
    const snapshots = q.getTaskSnapshots(graph, openIssues);
    expect(snapshots[0].blockers).toEqual([]);
  });
});

describe("TaskQueue — blocked status", () => {
  let q: TaskQueue;
  beforeEach(() => { q = new TaskQueue(); });

  it("addTask with status=blocked creates a blocked task", () => {
    q.addTask({ ...baseTask, status: "blocked" });
    expect(q.get("42")?.status).toBe("blocked");
  });

  it("setBlocked transitions pending → blocked", () => {
    q.addTask(baseTask);
    q.setBlocked("42");
    expect(q.get("42")?.status).toBe("blocked");
  });

  it("setBlocked is a no-op on non-pending tasks", () => {
    q.addTask(baseTask);
    q.assignTask("42", "w1");
    q.setBlocked("42");
    expect(q.get("42")?.status).toBe("assigned");
  });

  it("setUnblocked transitions blocked → pending", () => {
    q.addTask({ ...baseTask, status: "blocked" });
    q.setUnblocked("42");
    expect(q.get("42")?.status).toBe("pending");
  });

  it("setUnblocked is a no-op on non-blocked tasks", () => {
    q.addTask(baseTask);
    q.setUnblocked("42");
    expect(q.get("42")?.status).toBe("pending"); // unchanged
  });

  it("nextPending does not return blocked tasks", () => {
    q.addTask({ ...baseTask, status: "blocked" });
    expect(q.nextPending()).toBeNull();
  });

  it("setBlocked emits changed", () => {
    q.addTask(baseTask);
    const changed = vi.fn();
    q.on("changed", changed);
    q.setBlocked("42");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("setUnblocked emits changed", () => {
    q.addTask({ ...baseTask, status: "blocked" });
    const changed = vi.fn();
    q.on("changed", changed);
    q.setUnblocked("42");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("getPendingAndBlockedTasks returns pending and blocked but not assigned/complete", () => {
    q.addTask({ ...baseTask, taskId: "1", issueNumber: 1 }); // pending
    q.addTask({ ...baseTask, taskId: "2", issueNumber: 2, status: "blocked" }); // blocked
    q.addTask({ ...baseTask, taskId: "3", issueNumber: 3 }); // will be assigned
    q.assignTask("3", "w1");
    const result = q.getPendingAndBlockedTasks();
    expect(result.map((t) => t.taskId)).toEqual(expect.arrayContaining(["1", "2"]));
    expect(result.map((t) => t.taskId)).not.toContain("3");
  });

  it("getTaskSnapshots includes blocked status", () => {
    q.addTask({ ...baseTask, status: "blocked" });
    const snapshots = q.getTaskSnapshots();
    expect(snapshots[0].status).toBe("blocked");
  });
});

describe("removeTask", () => {
  let q: TaskQueue;
  beforeEach(() => { q = new TaskQueue(); });

  it("removes a pending task so it is no longer retrievable", () => {
    q.addTask(baseTask);
    q.removeTask("42");
    expect(q.get("42")).toBeUndefined();
    expect(q.getTaskForIssue(42)).toBeUndefined();
    expect(q.nextPending()).toBeNull();
  });

  it("removes a blocked task (label was removed while task was blocked)", () => {
    q.addTask({ ...baseTask, status: "blocked" });
    q.removeTask("42");
    expect(q.get("42")).toBeUndefined();
  });

  it("does not remove an assigned task", () => {
    q.addTask(baseTask);
    q.assignTask("42", "w1");
    q.removeTask("42");
    expect(q.get("42")).toBeDefined();
  });

  it("is a no-op for unknown taskId", () => {
    expect(() => q.removeTask("nonexistent")).not.toThrow();
  });
});

describe("nextPending with predicate", () => {
  let q: TaskQueue;
  beforeEach(() => { q = new TaskQueue(); });

  it("returns null when all pending tasks fail the predicate", () => {
    q.addTask({ ...baseTask, taskId: "1", issueNumber: 1 });
    q.addTask({ ...baseTask, taskId: "2", issueNumber: 2 });
    expect(q.nextPending(() => false)).toBeNull();
  });

  it("skips tasks that fail predicate and returns first that passes", () => {
    q.addTask({ ...baseTask, taskId: "1", issueNumber: 1 });
    q.addTask({ ...baseTask, taskId: "2", issueNumber: 2 });
    const t = q.nextPending((task) => task.issueNumber === 2);
    expect(t?.taskId).toBe("2");
  });

  it("no predicate behaves as before (returns first pending)", () => {
    q.addTask({ ...baseTask, taskId: "1", issueNumber: 1 });
    q.addTask({ ...baseTask, taskId: "2", issueNumber: 2 });
    expect(q.nextPending()?.taskId).toBe("1");
  });
});

describe("TaskQueue changed events", () => {
  let q: TaskQueue;
  beforeEach(() => { q = new TaskQueue(); });

  it("addTask emits changed", () => {
    const changed = vi.fn();
    q.on("changed", changed);
    q.addTask(baseTask);
    expect(changed).toHaveBeenCalledOnce();
  });

  it("assignTask emits changed", () => {
    q.addTask(baseTask);
    const changed = vi.fn();
    q.on("changed", changed);
    q.assignTask("42", "w1");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("completeTask emits changed", () => {
    q.addTask(baseTask);
    q.assignTask("42", "w1");
    const changed = vi.fn();
    q.on("changed", changed);
    q.completeTask("42");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("revertTask emits changed", () => {
    q.addTask(baseTask);
    q.assignTask("42", "w1");
    const changed = vi.fn();
    q.on("changed", changed);
    q.revertTask("42");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("removeTask emits changed when task removed", () => {
    q.addTask(baseTask);
    const changed = vi.fn();
    q.on("changed", changed);
    q.removeTask("42");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("removeTask does not emit changed for assigned task", () => {
    q.addTask(baseTask);
    q.assignTask("42", "w1");
    const changed = vi.fn();
    q.on("changed", changed);
    q.removeTask("42"); // no-op for assigned tasks
    expect(changed).not.toHaveBeenCalled();
  });

  it("registerPr emits changed", () => {
    q.addTask(baseTask);
    const changed = vi.fn();
    q.on("changed", changed);
    q.registerPr(10, "42");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("markDepsLoaded emits changed", () => {
    q.addTask({ ...baseTask, depsLoaded: false });
    const changed = vi.fn();
    q.on("changed", changed);
    q.markDepsLoaded([42]);
    expect(changed).toHaveBeenCalledOnce();
  });
});
