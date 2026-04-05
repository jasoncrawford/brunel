import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskModel } from "../src/foreman/task-model.js";
import type { GitHubEvent } from "../src/types.js";

const repoSlug = "test/repo";

async function registerBase(m: TaskModel, overrides: { taskId?: string; issueNumber?: number; title?: string; body?: string; labels?: string[] } = {}) {
  const taskId = overrides.taskId ?? "42";
  const issueNumber = overrides.issueNumber ?? 42;
  const title = overrides.title ?? "Fix the bug";
  const body = overrides.body ?? "It is broken";
  const labels = overrides.labels ?? ["brunel:ready"];
  await m.register(taskId, issueNumber, repoSlug, title, body, labels);
}

describe("TaskModel — queue operations", () => {
  let m: TaskModel;
  beforeEach(() => { m = new TaskModel(); });

  it("register makes task pending by default", async () => {
    await registerBase(m);
    expect((await m.get("42"))?.status).toBe("pending");
  });

  it("nextPending returns first pending task", async () => {
    await registerBase(m);
    const t = await m.nextPending();
    expect(t?.taskId).toBe("42");
  });

  it("nextPending returns null when no pending tasks", async () => {
    expect(await m.nextPending()).toBeNull();
  });

  it("assign updates status and assignedWorkerId", async () => {
    await registerBase(m);
    await m.nextPending();
    await m.assign("42", "w1");
    expect((await m.get("42"))?.status).toBe("assigned");
    expect((await m.get("42"))?.assignedWorkerId).toBe("w1");
  });

  it("complete updates status", async () => {
    await registerBase(m);
    await m.assign("42", "w1");
    await m.complete("42");
    expect((await m.get("42"))?.status).toBe("complete");
  });

  it("queueEvent appends to task event queue", async () => {
    await registerBase(m);
    const evt: GitHubEvent = { id: "e1", name: "check_run", payload: {} };
    m.queueEvent("42", evt);
    const drained = m.drainEvents("42");
    expect(drained).toHaveLength(1);
  });

  it("drainEvents returns all events and clears the queue", async () => {
    await registerBase(m);
    const evt: GitHubEvent = { id: "e1", name: "check_run", payload: {} };
    m.queueEvent("42", evt);
    const drained = m.drainEvents("42");
    expect(drained).toHaveLength(1);
    expect(m.drainEvents("42")).toHaveLength(0);
  });

  it("getTaskForIssue looks up by issueNumber", async () => {
    await registerBase(m);
    expect((await m.getTaskForIssue(42))?.taskId).toBe("42");
  });

  it("registerPr + getTaskForPr looks up task by PR number", async () => {
    await registerBase(m);
    await m.registerPr("42", 10, null);
    expect((await m.getTaskForPr(10))?.taskId).toBe("42");
  });

  it("registerPr stores prNumber on the task", async () => {
    await registerBase(m);
    await m.registerPr("42", 10, null);
    expect((await m.get("42"))?.prNumber).toBe(10);
  });

  it("getTaskForPr returns null for unknown PR number", async () => {
    expect(await m.getTaskForPr(999)).toBeNull();
  });

  it("registerBranch + getTaskForBranch looks up task by branch name", async () => {
    await registerBase(m);
    m.registerBranch("fix-issue-42", "42");
    expect((await m.getTaskForBranch("fix-issue-42"))?.taskId).toBe("42");
  });

  it("getTaskForBranch returns null for unknown branch", async () => {
    expect(await m.getTaskForBranch("unknown-branch")).toBeNull();
  });

  it("getTaskSnapshots includes prUrl when PR is registered", async () => {
    await registerBase(m);
    await m.registerPr("42", 10, null);
    const snapshots = await m.getTaskSnapshots(new Map());
    expect(snapshots[0].prUrl).toBe("https://github.com/test/repo/pull/10");
  });

  it("getTaskSnapshots omits prUrl when no PR registered", async () => {
    await registerBase(m);
    const snapshots = await m.getTaskSnapshots(new Map());
    expect(snapshots[0].prUrl).toBeUndefined();
  });

  it("getTaskSnapshots with no graph omits blockers field", async () => {
    // getTaskSnapshots always takes a graph via TaskModel, so passing empty
    // graph still includes an empty blockers array
    await registerBase(m);
    const snapshots = await m.getTaskSnapshots(new Map());
    expect(snapshots[0].blockers).toEqual([]);
  });

  it("getTaskSnapshots with graph includes blockers with isOpen status", async () => {
    await registerBase(m); // issueNumber: 42
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
    await registerBase(m); // issueNumber: 42, no entry in graph
    const graph = new Map<number, Set<number>>();
    const snapshots = await m.getTaskSnapshots(graph);
    expect(snapshots[0].blockers).toEqual([]);
  });
});

describe("TaskModel — blocked status", () => {
  let m: TaskModel;
  beforeEach(() => { m = new TaskModel(); });

  it("block after register creates a blocked task", async () => {
    await registerBase(m);
    await m.block("42");
    expect((await m.get("42"))?.status).toBe("blocked");
  });

  it("block transitions pending → blocked", async () => {
    await registerBase(m);
    await m.block("42");
    expect((await m.get("42"))?.status).toBe("blocked");
  });

  it("block sets status to blocked even on assigned tasks", async () => {
    await registerBase(m);
    await m.assign("42", "w1");
    await m.block("42");
    expect((await m.get("42"))?.status).toBe("blocked");
  });

  it("unblock transitions blocked → pending", async () => {
    await registerBase(m);
    await m.block("42");
    await m.unblock("42");
    expect((await m.get("42"))?.status).toBe("pending");
  });

  it("unblock sets status to pending even on non-blocked tasks", async () => {
    await registerBase(m);
    await m.unblock("42");
    expect((await m.get("42"))?.status).toBe("pending"); // unchanged
  });

  it("nextPending does not return blocked tasks", async () => {
    await registerBase(m);
    await m.block("42");
    expect(await m.nextPending()).toBeNull();
  });

  it("block emits changed", async () => {
    await registerBase(m);
    const changed = vi.fn();
    m.on("changed", changed);
    await m.block("42");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("unblock emits changed", async () => {
    await registerBase(m);
    await m.block("42");
    const changed = vi.fn();
    m.on("changed", changed);
    await m.unblock("42");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("getPendingAndBlockedTasks returns pending and blocked but not assigned/complete", async () => {
    await registerBase(m, { taskId: "1", issueNumber: 1 }); // pending
    await registerBase(m, { taskId: "2", issueNumber: 2 }); // will be blocked
    await m.block("2");
    await registerBase(m, { taskId: "3", issueNumber: 3 }); // will be assigned
    await m.assign("3", "w1");
    const result = await m.getPendingAndBlockedTasks();
    expect(result.map((t) => t.taskId)).toEqual(expect.arrayContaining(["1", "2"]));
    expect(result.map((t) => t.taskId)).not.toContain("3");
  });

  it("getTaskSnapshots includes blocked status", async () => {
    await registerBase(m);
    await m.block("42");
    const snapshots = await m.getTaskSnapshots(new Map());
    expect(snapshots[0].status).toBe("blocked");
  });
});

describe("TaskModel — cancel (removeTask behavior)", () => {
  let m: TaskModel;
  beforeEach(() => { m = new TaskModel(); });

  it("removes a pending task so it is no longer retrievable", async () => {
    await registerBase(m);
    await m.cancel("42");
    expect(await m.get("42")).toBeNull();
    expect(await m.getTaskForIssue(42)).toBeNull();
    expect(await m.nextPending()).toBeNull();
  });

  it("removes a blocked task (label was removed while task was blocked)", async () => {
    await registerBase(m);
    await m.block("42");
    await m.cancel("42");
    expect(await m.get("42")).toBeNull();
  });

  it("does not remove an assigned task", async () => {
    await registerBase(m);
    await m.assign("42", "w1");
    await m.cancel("42");
    expect(await m.get("42")).not.toBeNull();
  });

  it("is a no-op for unknown taskId", async () => {
    await expect(m.cancel("nonexistent")).resolves.not.toThrow();
  });
});

describe("TaskModel — nextPending with predicate", () => {
  let m: TaskModel;
  beforeEach(() => { m = new TaskModel(); });

  it("returns null when all pending tasks fail the predicate", async () => {
    await registerBase(m, { taskId: "1", issueNumber: 1 });
    await registerBase(m, { taskId: "2", issueNumber: 2 });
    expect(await m.nextPending(() => false)).toBeNull();
  });

  it("skips tasks that fail predicate and returns first that passes", async () => {
    await registerBase(m, { taskId: "1", issueNumber: 1 });
    await registerBase(m, { taskId: "2", issueNumber: 2 });
    const t = await m.nextPending((task) => task.issueNumber === 2);
    expect(t?.taskId).toBe("2");
  });

  it("no predicate behaves as before (returns first pending)", async () => {
    await registerBase(m, { taskId: "1", issueNumber: 1 });
    await registerBase(m, { taskId: "2", issueNumber: 2 });
    expect((await m.nextPending())?.taskId).toBe("1");
  });
});

describe("TaskModel changed events", () => {
  let m: TaskModel;
  beforeEach(() => { m = new TaskModel(); });

  it("register emits changed", async () => {
    const changed = vi.fn();
    m.on("changed", changed);
    await registerBase(m);
    expect(changed).toHaveBeenCalled();
  });

  it("assign emits changed", async () => {
    await registerBase(m);
    const changed = vi.fn();
    m.on("changed", changed);
    await m.assign("42", "w1");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("complete emits changed", async () => {
    await registerBase(m);
    await m.assign("42", "w1");
    const changed = vi.fn();
    m.on("changed", changed);
    await m.complete("42");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("revert emits changed", async () => {
    await registerBase(m);
    await m.assign("42", "w1");
    const changed = vi.fn();
    m.on("changed", changed);
    await m.revert("42");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("cancel emits changed when task removed", async () => {
    await registerBase(m);
    const changed = vi.fn();
    m.on("changed", changed);
    await m.cancel("42");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("cancel emits changed even for assigned task (store preserves the row)", async () => {
    await registerBase(m);
    await m.assign("42", "w1");
    const changed = vi.fn();
    m.on("changed", changed);
    await m.cancel("42"); // row not deleted (assignedAt set), but changed still emits
    expect(changed).toHaveBeenCalledOnce();
  });

  it("registerPr emits changed", async () => {
    await registerBase(m);
    const changed = vi.fn();
    m.on("changed", changed);
    await m.registerPr("42", 10, null);
    expect(changed).toHaveBeenCalled();
  });

  it("unregisterPr clears prNumber from the task", async () => {
    await registerBase(m);
    await m.registerPr("42", 10, null);
    await m.unregisterPr(10);
    expect((await m.get("42"))?.prNumber).toBeUndefined();
  });

  it("unregisterPr removes PR from routing so getTaskForPr returns null", async () => {
    await registerBase(m);
    await m.registerPr("42", 10, null);
    await m.unregisterPr(10);
    expect(await m.getTaskForPr(10)).toBeNull();
  });

  it("unregisterPr emits changed", async () => {
    await registerBase(m);
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
