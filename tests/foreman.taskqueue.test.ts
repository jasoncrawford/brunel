import { describe, it, expect, beforeEach } from "vitest";
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
