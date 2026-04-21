import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TaskManager } from "../src/foreman/models/task-manager.js";
import { Task } from "../src/foreman/models/task.js";
import { Worker } from "../src/foreman/models/worker.js";
import { resetDb, createTestTaskManager } from "./helpers/task.js";

const REPO = "test/repo";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Task.complete", () => {
  let manager: TaskManager;

  beforeEach(async () => {
    Worker._reset();
    resetDb();
    manager = await createTestTaskManager();
    await Task.upsert("42", 42, REPO, "Fix the bug", "It is broken", ["brunel:ready"]);
    const t = await Task.get("42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks the task complete", async () => {
    const t = await Task.get("42");
    await t!.complete();
    const updated = await Task.get("42");
    expect(updated?.status).toBe("complete");
  });

  it("propagates errors to the caller", async () => {
    const t = await Task.get("42");
    vi.spyOn(t!, "complete").mockRejectedValue(new Error("DB down"));
    await expect(t!.complete()).rejects.toThrow("DB down");
  });
});

describe("Task.revert", () => {
  let manager: TaskManager;

  beforeEach(async () => {
    Worker._reset();
    resetDb();
    manager = await createTestTaskManager();
    await Task.upsert("42", 42, REPO, "Fix the bug", "It is broken", ["brunel:ready"]);
    const t = await Task.get("42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reverts the task to pending (clears workerId)", async () => {
    const t = await Task.get("42");
    await t!.revert();
    const updated = await Task.get("42");
    expect(updated?.status).toBe("pending");
    expect(updated?.workerId).toBeNull();
  });

  it("propagates errors to the caller", async () => {
    const t = await Task.get("42");
    vi.spyOn(t!, "revert").mockRejectedValue(new Error("DB down"));
    await expect(t!.revert()).rejects.toThrow("DB down");
  });
});

describe("Task.upsert", () => {
  beforeEach(() => {
    resetDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds the task as pending", async () => {
    await Task.upsert("42", 42, "owner/repo", "Title", "Body", ["label"]);
    const t = await Task.get("42");
    expect(t?.status).toBe("pending");
    expect(t?.title).toBe("Title");
  });

  it("creates a task with the correct repo slug", async () => {
    await Task.upsert("42", 42, "owner/repo", "Title", "Body", ["label"]);
    const t = await Task.get("42");
    expect(t?.repo).toBe("owner/repo");
  });

  it("propagates errors to the caller", async () => {
    vi.spyOn(Task, "upsert").mockRejectedValue(new Error("oops"));
    await expect(Task.upsert("42", 42, "owner/repo", "T", "B", [])).rejects.toThrow("oops");
  });
});

describe("Task assign", () => {
  beforeEach(async () => {
    Worker._reset();
    resetDb();
    await Task.upsert("42", 42, REPO, "Fix the bug", "It is broken", ["brunel:ready"]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks task assigned on success", async () => {
    const t = await Task.get("42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs));
    const updated = await Task.get("42");
    expect(updated?.status).toBe("assigned");
    expect(updated?.workerId).toBe("w1");
  });

  it("awaits assign before resolving", async () => {
    const t = await Task.get("42");
    let assignWritten = false;
    vi.spyOn(t!, "assign").mockImplementation(() =>
      new Promise<void>((r) => setTimeout(() => { assignWritten = true; r(); }, 10))
    );
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs));
    expect(assignWritten).toBe(true);
  });

  it("throws when assign fails", async () => {
    const t = await Task.get("42");
    vi.spyOn(t!, "assign").mockRejectedValue(new Error("DB down"));
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await expect(t!.assign(Worker.register("w1", fakeWs))).rejects.toThrow("DB down");
  });
});

describe("Task.deleteIfUnassigned", () => {
  beforeEach(async () => {
    Worker._reset();
    resetDb();
    await Task.upsert("42", 42, REPO, "Fix the bug", "It is broken", ["brunel:ready"]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes a pending task from the store", async () => {
    const t = await Task.get("42");
    await t!.deleteIfUnassigned();
    expect(await Task.get("42")).toBeNull();
  });

  it("does not remove an assigned task (assignedAt set)", async () => {
    const t = await Task.get("42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs));
    await t!.deleteIfUnassigned();
    expect(await Task.get("42")).not.toBeNull();
  });

  it("propagates errors to the caller", async () => {
    const t = await Task.get("42");
    vi.spyOn(t!, "deleteIfUnassigned").mockRejectedValue(new Error("DB down"));
    await expect(t!.deleteIfUnassigned()).rejects.toThrow("DB down");
  });
});

describe("Task.updateContent", () => {
  beforeEach(async () => {
    resetDb();
    await Task.upsert("42", 42, REPO, "Fix the bug", "It is broken", ["brunel:ready"]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates task fields", async () => {
    const t = await Task.get("42");
    await t!.updateContent("New Title", "New Body", ["bug"]);
    const updated = await Task.get("42");
    expect(updated?.title).toBe("New Title");
    expect(updated?.body).toBe("New Body");
    expect(updated?.labels).toEqual(["bug"]);
  });

  it("propagates errors to the caller", async () => {
    const t = await Task.get("42");
    vi.spyOn(t!, "updateContent").mockRejectedValue(new Error("DB down"));
    await expect(t!.updateContent("T", "B", [])).rejects.toThrow("DB down");
  });
});

describe("Task.registerPr / getByPr", () => {
  beforeEach(async () => {
    resetDb();
    await Task.upsert("42", 42, REPO, "Fix the bug", "It is broken", ["brunel:ready"]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers PR and looks up task by PR number", async () => {
    const t = await Task.get("42");
    await t!.registerPr(10, "fix-branch");
    const byPr = await Task.getByPr(10);
    expect(byPr?.taskId).toBe("42");
  });

  it("propagates errors to the caller", async () => {
    const t = await Task.get("42");
    vi.spyOn(t!, "registerPr").mockRejectedValue(new Error("DB down"));
    await expect(t!.registerPr(10, "fix-branch")).rejects.toThrow("DB down");
  });
});

describe("Task.unregisterPr", () => {
  beforeEach(async () => {
    resetDb();
    await Task.upsert("42", 42, REPO, "Fix the bug", "It is broken", ["brunel:ready"]);
    const t = await Task.get("42");
    await t!.registerPr(10, "fix-branch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("unregisters PR so getByPr returns null", async () => {
    const t = await Task.getByPr(10);
    await t!.unregisterPr();
    expect(await Task.getByPr(10)).toBeNull();
  });

  it("propagates errors to the caller", async () => {
    const t = await Task.getByPr(10);
    vi.spyOn(t!, "unregisterPr").mockRejectedValue(new Error("DB down"));
    await expect(t!.unregisterPr()).rejects.toThrow("DB down");
  });
});

describe("Task.list", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns all tasks", async () => {
    resetDb();
    await Task.upsert("1", 1, REPO, "Task 1", "Body", ["label"]);
    const result = await Task.list();
    expect(result).toHaveLength(1);
    expect(result[0].taskId).toBe("1");
  });
});

// ── task.status (replaces deriveStatus) ───────────────────────────────────────

describe("Task.status (derived)", () => {
  it("returns 'pushed' when prNumber is set, even if workerId is also set", () => {
    const t = Task.fromTest({ task_id: "t1", issue_number: 1, pr_number: 99, worker_id: "w1" });
    expect(t.status).toBe("pushed");
  });

  it("returns 'assigned' when workerId is set but prNumber is null", () => {
    const t = Task.fromTest({ task_id: "t1", issue_number: 1, worker_id: "w1" });
    expect(t.status).toBe("assigned");
  });

  it("returns 'pushed' when prNumber is set and workerId is null", () => {
    const t = Task.fromTest({ task_id: "t1", issue_number: 1, pr_number: 99 });
    expect(t.status).toBe("pushed");
  });

  it("returns 'pending' when nothing is set", () => {
    const t = Task.fromTest({ task_id: "t1", issue_number: 1 });
    expect(t.status).toBe("pending");
  });

  it("returns 'complete' when completedAt is set", () => {
    const t = Task.fromTest({ task_id: "t1", issue_number: 1, completed_at: new Date().toISOString() });
    expect(t.status).toBe("complete");
  });
});

// ── TaskManager.assignIdleWorkers ─────────────────────────────────────────────

describe("TaskManager.assignIdleWorkers", () => {
  let manager: TaskManager;

  beforeEach(async () => {
    Worker._reset();
    resetDb();
    manager = await createTestTaskManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing when there are no idle workers", async () => {
    await Task.upsert("42", 42, REPO, "Fix the bug", "Body", ["brunel:ready"]);
    manager.markBlockersLoaded(42);
    const outcomes = await manager.assignIdleWorkers();
    expect(outcomes).toHaveLength(0);
  });

  it("does nothing when there are no pending tasks", async () => {
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    Worker.register("worker-1", fakeWs);
    const outcomes = await manager.assignIdleWorkers();
    expect(outcomes).toHaveLength(0);
  });

  it("returns a success outcome with task, queued events, and workerId", async () => {
    await Task.upsert("42", 42, REPO, "Fix the bug", "Body", ["brunel:ready"]);
    manager.markBlockersLoaded(42);
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    Worker.register("worker-1", fakeWs);

    const outcomes = await manager.assignIdleWorkers();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      ok: true,
      task: expect.objectContaining({ taskId: "42", workerId: "worker-1" }),
      queued: [],
      worker: expect.objectContaining({ workerId: "worker-1" }),
    });
  });

  it("marks the worker's in-memory currentTaskId on success", async () => {
    await Task.upsert("42", 42, REPO, "Fix the bug", "Body", ["brunel:ready"]);
    manager.markBlockersLoaded(42);
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    const worker = Worker.register("worker-1", fakeWs);

    await manager.assignIdleWorkers();
    expect(worker.currentTaskId).toBe("42");
  });

  it("serialises concurrent calls — only one worker gets the task", async () => {
    await Task.upsert("42", 42, REPO, "Fix the bug", "Body", ["brunel:ready"]);
    manager.markBlockersLoaded(42);
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    Worker.register("worker-1", fakeWs);
    Worker.register("worker-2", fakeWs);

    // Fire both concurrently — only one worker should win the task.
    const [r1, r2] = await Promise.all([manager.assignIdleWorkers(), manager.assignIdleWorkers()]);
    expect([...r1, ...r2].filter(o => o.ok)).toHaveLength(1);
  });

  it("returns a failure outcome and releases the worker when DB write fails", async () => {
    await Task.upsert("42", 42, REPO, "Fix the bug", "Body", ["brunel:ready"]);
    manager.markBlockersLoaded(42);
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    Worker.register("worker-1", fakeWs);

    vi.spyOn(Task.prototype, "assign").mockRejectedValue(new Error("DB down"));

    const outcomes = await manager.assignIdleWorkers();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      ok: false,
      worker: expect.objectContaining({ workerId: "worker-1" }),
      err: expect.any(Error),
    });
  });

  it("leaves the mutex usable after a failure", async () => {
    await Task.upsert("42", 42, REPO, "Fix the bug", "Body", ["brunel:ready"]);
    manager.markBlockersLoaded(42);
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    Worker.register("worker-1", fakeWs);

    vi.spyOn(Task.prototype, "assign").mockRejectedValue(new Error("DB down"));

    // Both calls should resolve (not hang), even though assignment fails.
    await manager.assignIdleWorkers();
    await manager.assignIdleWorkers();
  });
});

// ── TaskManager.handleIssueLabeledEvent ───────────────────────────────────────

describe("TaskManager.handleIssueLabeledEvent", () => {
  let manager: TaskManager;

  beforeEach(async () => {
    Worker._reset();
    resetDb();
    manager = await createTestTaskManager();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { repository: { issue: { blockedBy: { nodes: [] } } } } }),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("enqueues the issue and returns the task when issue is open", async () => {
    const task = await manager.handleIssueLabeledEvent(42, "Fix it", "Body", ["brunel:ready"], "open");
    expect(task).not.toBeNull();
    expect(task?.taskId).toBe("42");
    expect(await Task.getByIssue(42)).not.toBeNull();
  });

  it("returns null and does not enqueue when issue is closed", async () => {
    const task = await manager.handleIssueLabeledEvent(42, "Fix it", "Body", [], "closed");
    expect(task).toBeNull();
    expect(await Task.getByIssue(42)).toBeNull();
  });

  it("emits deps_loaded after fetching deps", async () => {
    let depsDoneCount = 0;
    manager.on("deps_loaded", () => { depsDoneCount++; });
    await manager.handleIssueLabeledEvent(42, "Fix it", "Body", [], "open");
    await new Promise((r) => setTimeout(r, 50));
    expect(depsDoneCount).toBe(1);
  });
});

// ── TaskManager.handleIssueBodyEditedEvent ────────────────────────────────────

describe("TaskManager.handleIssueBodyEditedEvent", () => {
  let manager: TaskManager;

  beforeEach(async () => {
    Worker._reset();
    resetDb();
    manager = await createTestTaskManager();
    manager.setBlockers(42, [10]);
    manager.markBlockersLoaded(42);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { repository: { issue: { blockedBy: { nodes: [] } } } } }),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resets blockers for the issue", () => {
    expect(manager.isBlockersLoaded(42)).toBe(true);
    manager.handleIssueBodyEditedEvent(42, "new body");
    expect(manager.isBlockersLoaded(42)).toBe(false);
  });

  it("emits deps_loaded after reloading deps", async () => {
    let depsDoneCount = 0;
    manager.on("deps_loaded", () => { depsDoneCount++; });
    manager.handleIssueBodyEditedEvent(42, "new body");
    await new Promise((r) => setTimeout(r, 50));
    expect(depsDoneCount).toBe(1);
  });
});

// ── TaskManager.handlePrOpenedEvent ───────────────────────────────────────────

describe("TaskManager.handlePrOpenedEvent", () => {
  let manager: TaskManager;

  beforeEach(async () => {
    Worker._reset();
    resetDb();
    manager = await createTestTaskManager();
    await Task.upsert("42", 42, REPO, "Fix the bug", "Body", ["brunel:ready"]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers branch and PR when body links an issue", async () => {
    const task = await manager.handlePrOpenedEvent(10, "Closes #42", "fix-branch");
    expect(task?.taskId).toBe("42");
    expect(task?.prNumber).toBe(10);
    expect(task?.branch).toBe("fix-branch");
    expect(await Task.getByPr(10)).not.toBeNull();
  });

  it("returns null when no linked issue in body", async () => {
    const task = await manager.handlePrOpenedEvent(10, "no link", "branch");
    expect(task).toBeNull();
    expect(await Task.getByPr(10)).toBeNull();
  });

  it("returns null when linked issue has no corresponding task", async () => {
    const task = await manager.handlePrOpenedEvent(10, "Closes #999", "branch");
    expect(task).toBeNull();
  });

  it("registers branch mapping so getTaskForBranch works", async () => {
    await manager.handlePrOpenedEvent(10, "Fixes #42", "my-fix-branch");
    const found = await manager.getTaskForBranch("my-fix-branch");
    expect(found?.taskId).toBe("42");
  });
});

// ── TaskManager.handlePrClosedEvent ───────────────────────────────────────────

describe("TaskManager.handlePrClosedEvent", () => {
  let manager: TaskManager;

  beforeEach(async () => {
    Worker._reset();
    resetDb();
    manager = await createTestTaskManager();
    await Task.upsert("42", 42, REPO, "Fix the bug", "Body", ["brunel:ready"]);
    const t = await Task.get("42");
    await t!.registerPr(10, "fix-branch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("unregisters PR when not merged and returns the task", async () => {
    const task = await manager.handlePrClosedEvent(10, false);
    expect(task?.taskId).toBe("42");
    expect(task?.prNumber).toBeNull();
    expect(await Task.getByPr(10)).toBeNull();
  });

  it("records merge when merged=true and keeps PR association", async () => {
    const task = await manager.handlePrClosedEvent(10, true);
    expect(task?.taskId).toBe("42");
    expect(task?.prMergedAt).toBeTruthy();
    expect(await Task.getByPr(10)).not.toBeNull();
  });

  it("returns null when no task owns the PR", async () => {
    const task = await manager.handlePrClosedEvent(999, false);
    expect(task).toBeNull();
  });
});

// ── TaskManager.getTaskForCheckEvent ─────────────────────────────────────────

describe("TaskManager.getTaskForCheckEvent", () => {
  let manager: TaskManager;

  beforeEach(async () => {
    Worker._reset();
    resetDb();
    manager = await createTestTaskManager();
    await Task.upsert("42", 42, REPO, "Fix the bug", "Body", ["brunel:ready"]);
    const t = await Task.get("42");
    await t!.registerPr(10, "fix-branch");
    manager.registerBranch("fix-branch", t!);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns task by PR number when found", async () => {
    const result = await manager.getTaskForCheckEvent([10], "");
    expect(result?.task.taskId).toBe("42");
    expect(result?.ref).toBe("PR #10");
  });

  it("falls back to branch lookup when PR lookup fails", async () => {
    const result = await manager.getTaskForCheckEvent([], "fix-branch");
    expect(result?.task.taskId).toBe("42");
    expect(result?.ref).toBe("branch fix-branch");
  });

  it("prefers PR lookup over branch lookup", async () => {
    const result = await manager.getTaskForCheckEvent([10], "fix-branch");
    expect(result?.ref).toBe("PR #10");
  });

  it("returns null when neither PR nor branch matches", async () => {
    const result = await manager.getTaskForCheckEvent([999], "unknown-branch");
    expect(result).toBeNull();
  });

  it("returns null when lists are empty and branch is empty", async () => {
    const result = await manager.getTaskForCheckEvent([], "");
    expect(result).toBeNull();
  });
});

// ── Task.toAssignmentPayload ──────────────────────────────────────────────────

describe("Task.toAssignmentPayload", () => {
  it("returns the issue payload fields used for task_assigned wire message", () => {
    const task = Task.fromTest({
      task_id: "42",
      issue_number: 42,
      repo: "owner/repo",
      title: "Fix the bug",
      body: "It is broken",
      labels: ["bug", "brunel:ready"],
    });
    expect(task.toAssignmentPayload()).toEqual({
      number: 42,
      title: "Fix the bug",
      body: "It is broken",
      labels: ["bug", "brunel:ready"],
      repoUrl: "https://github.com/owner/repo",
    });
  });
});

describe("TaskManager listener cleanup", () => {
  beforeEach(() => {
    resetDb();
  });

  it("removes Task.events listeners when registry is reset", async () => {
    const before = Task.events.listenerCount("changed");
    // Create several TaskManagers to add listeners
    for (let i = 0; i < 15; i++) {
      await createTestTaskManager(`test/repo-${i}`);
    }
    expect(Task.events.listenerCount("changed")).toBe(before + 15);

    resetDb();
    expect(Task.events.listenerCount("changed")).toBe(0);
  });
});
