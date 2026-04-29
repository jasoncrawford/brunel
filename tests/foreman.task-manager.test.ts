import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TaskManager } from "../src/foreman/models/task-manager.js";
import { Task } from "../src/foreman/models/task.js";
import { Repo } from "../src/foreman/models/repo.js";
import { Worker } from "../src/foreman/models/worker.js";
import { fakeRepo, resetDb, createTestTaskManager, seedTask } from "./helpers/task.js";
import { getConfig } from "../src/config.js";

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
    await t!.assign(Worker.register("w1", fakeWs, fakeRepo()));
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
    await t!.assign(Worker.register("w1", fakeWs, fakeRepo()));
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
    await t!.assign(Worker.register("w1", fakeWs, fakeRepo()));
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
    await t!.assign(Worker.register("w1", fakeWs, fakeRepo()));
    expect(assignWritten).toBe(true);
  });

  it("throws when assign fails", async () => {
    const t = await Task.get("42");
    vi.spyOn(t!, "assign").mockRejectedValue(new Error("DB down"));
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await expect(t!.assign(Worker.register("w1", fakeWs, fakeRepo()))).rejects.toThrow("DB down");
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
    await t!.assign(Worker.register("w1", fakeWs, fakeRepo()));
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
    const repo = await Repo.findOrCreate(REPO);
    const byPr = await Task.getByRepoPr(repo.id, 10);
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
    const repo = await Repo.findOrCreate(REPO);
    const t = await Task.getByRepoPr(repo.id, 10);
    await t!.unregisterPr();
    expect(await Task.getByRepoPr(repo.id, 10)).toBeNull();
  });

  it("propagates errors to the caller", async () => {
    const repo = await Repo.findOrCreate(REPO);
    const t = await Task.getByRepoPr(repo.id, 10);
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

// ── TaskManager.loadActiveTasksFromDb ─────────────────────────────────────────

describe("TaskManager.loadActiveTasksFromDb", () => {
  beforeEach(() => {
    resetDb();
  });

  it("calls Task.list with its own repoId", async () => {
    const manager = await createTestTaskManager("owner/repo-a");
    const spy = vi.spyOn(Task, "list");
    await manager.loadActiveTasksFromDb();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ repoId: manager.repo.id }));
  });

  it("does not register branches from other repos", async () => {
    const managerA = await createTestTaskManager("owner/repo-a");
    const repoB = await createTestTaskManager("owner/repo-b");

    // Seed a task with a branch belonging to repo-b
    await seedTask({
      task_id: "task-b",
      issue_number: 2,
      repo: "owner/repo-b",
      repo_id: repoB.repo.id,
      branch: "fix/task-b",
    });

    await managerA.loadActiveTasksFromDb();

    // managerA must not have registered the branch from repo-b
    expect(await managerA.getTaskForBranch("fix/task-b")).toBeNull();
  });

  it("registers branches from its own repo", async () => {
    const managerA = await createTestTaskManager("owner/repo-a");

    await seedTask({
      task_id: "task-a",
      issue_number: 1,
      repo: "owner/repo-a",
      repo_id: managerA.repo.id,
      branch: "fix/task-a",
    });

    await managerA.loadActiveTasksFromDb();

    expect(await managerA.getTaskForBranch("fix/task-a")).not.toBeNull();
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
    Worker.register("worker-1", fakeWs, fakeRepo());
    const outcomes = await manager.assignIdleWorkers();
    expect(outcomes).toHaveLength(0);
  });

  it("returns a success outcome with task, queued events, and workerId", async () => {
    await Task.upsert("42", 42, REPO, "Fix the bug", "Body", ["brunel:ready"]);
    manager.markBlockersLoaded(42);
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    Worker.register("worker-1", fakeWs, fakeRepo(REPO, manager.repo.id, "active"));

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
    const worker = Worker.register("worker-1", fakeWs, fakeRepo(REPO, manager.repo.id, "active"));

    await manager.assignIdleWorkers();
    expect(worker.currentTaskId).toBe("42");
  });

  it("serialises concurrent calls — only one worker gets the task", async () => {
    await Task.upsert("42", 42, REPO, "Fix the bug", "Body", ["brunel:ready"]);
    manager.markBlockersLoaded(42);
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    Worker.register("worker-1", fakeWs, fakeRepo(REPO, manager.repo.id, "active"));
    Worker.register("worker-2", fakeWs, fakeRepo(REPO, manager.repo.id, "active"));

    // Fire both concurrently — only one worker should win the task.
    const [r1, r2] = await Promise.all([manager.assignIdleWorkers(), manager.assignIdleWorkers()]);
    expect([...r1, ...r2].filter(o => o.ok)).toHaveLength(1);
  });

  it("returns a failure outcome and releases the worker when DB write fails", async () => {
    await Task.upsert("42", 42, REPO, "Fix the bug", "Body", ["brunel:ready"]);
    manager.markBlockersLoaded(42);
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    Worker.register("worker-1", fakeWs, fakeRepo(REPO, manager.repo.id, "active"));

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
    Worker.register("worker-1", fakeWs, fakeRepo(REPO, manager.repo.id, "active"));

    vi.spyOn(Task.prototype, "assign").mockRejectedValue(new Error("DB down"));

    // Both calls should resolve (not hang), even though assignment fails.
    await manager.assignIdleWorkers();
    await manager.assignIdleWorkers();
  });

  it("skips assignment when worker's repo is not active", async () => {
    await Task.upsert("42", 42, REPO, "Fix the bug", "Body", ["brunel:ready"]);
    manager.markBlockersLoaded(42);
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    Worker.register("worker-1", fakeWs, fakeRepo(REPO, manager.repo.id, "new"));

    const outcomes = await manager.assignIdleWorkers();
    expect(outcomes).toHaveLength(0);
  });

  it("skips assignment when worker's repo id does not match task's repo id", async () => {
    await Task.upsert("42", 42, REPO, "Fix the bug", "Body", ["brunel:ready"]);
    manager.markBlockersLoaded(42);
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    // Worker belongs to a different repo (id 999)
    Worker.register("worker-1", fakeWs, fakeRepo("other/repo", 999, "active"));

    const outcomes = await manager.assignIdleWorkers();
    expect(outcomes).toHaveLength(0);
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
    expect(await Task.getByRepoIssue(manager.repo.id,42)).not.toBeNull();
  });

  it("returns null and does not enqueue when issue is closed", async () => {
    const task = await manager.handleIssueLabeledEvent(42, "Fix it", "Body", [], "closed");
    expect(task).toBeNull();
    expect(await Task.getByRepoIssue(manager.repo.id,42)).toBeNull();
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
    await seedTask({
      task_id: "42",
      issue_number: 42,
      repo: REPO,
      repo_id: manager.repo.id,
      title: "Fix the bug",
      body: "Body",
      labels: ["brunel:ready"],
      worker_id: "w1",
      assigned_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers branch and PR when body links an issue", async () => {
    const task = await manager.handlePrOpenedEvent(10, "Closes #42", "fix-branch");
    expect(task?.taskId).toBe("42");
    expect(task?.prNumber).toBe(10);
    expect(task?.branch).toBe("fix-branch");
    expect(await Task.getByRepoPr(manager.repo.id,10)).not.toBeNull();
  });

  it("returns null when no linked issue in body", async () => {
    const task = await manager.handlePrOpenedEvent(10, "no link", "branch");
    expect(task).toBeNull();
    expect(await Task.getByRepoPr(manager.repo.id,10)).toBeNull();
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

  it("returns null when the linked task is not assigned", async () => {
    // #99 is pending (no worker); the current code would return it, but shouldn't
    await Task.upsert("99", 99, REPO, "Another task", "Body", ["brunel:ready"]);
    const task = await manager.handlePrOpenedEvent(10, "Closes #99", "branch");
    expect(task).toBeNull();
  });

  it("finds the correct task when an inline issue mention appears before the closing keyword", async () => {
    // #916 appears inline but has no task; #42 is the real closing keyword
    const body = "## Summary\n\n- fix (fixes #916): some detail\n\nCloses #42.";
    const task = await manager.handlePrOpenedEvent(10, body, "fix-branch");
    expect(task?.taskId).toBe("42");
    expect(await Task.getByRepoPr(manager.repo.id, 10)).not.toBeNull();
  });

  it("skips a pending task match and returns the assigned one", async () => {
    // #916 has a pending task; #42 (from beforeEach) is assigned
    await Task.upsert("916", 916, REPO, "Unrelated task", "Body", ["brunel:ready"]);
    const body = "## Summary\n\n- fix (fixes #916): some detail\n\nCloses #42.";
    const task = await manager.handlePrOpenedEvent(10, body, "fix-branch");
    expect(task?.taskId).toBe("42");
  });
});

// ── TaskManager.handlePrEditedEvent ──────────────────────────────────────────

describe("TaskManager.handlePrEditedEvent", () => {
  let manager: TaskManager;

  beforeEach(async () => {
    Worker._reset();
    resetDb();
    manager = await createTestTaskManager();
    await seedTask({
      task_id: "42",
      issue_number: 42,
      repo: REPO,
      repo_id: manager.repo.id,
      title: "Fix the bug",
      body: "Body",
      labels: ["brunel:ready"],
      worker_id: "w1",
      assigned_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers branch and PR when body links an issue", async () => {
    const task = await manager.handlePrEditedEvent(10, "Closes #42", "fix-branch");
    expect(task?.taskId).toBe("42");
    expect(await Task.getByRepoPr(manager.repo.id, 10)).not.toBeNull();
  });

  it("returns null when no linked issue in body", async () => {
    const task = await manager.handlePrEditedEvent(10, "no link", "branch");
    expect(task).toBeNull();
  });

  it("returns null when linked issue has no corresponding task", async () => {
    const task = await manager.handlePrEditedEvent(10, "Closes #999", "branch");
    expect(task).toBeNull();
  });

  it("returns null when the linked task is not assigned", async () => {
    await Task.upsert("99", 99, REPO, "Another task", "Body", ["brunel:ready"]);
    const task = await manager.handlePrEditedEvent(10, "Closes #99", "branch");
    expect(task).toBeNull();
  });

  it("finds the correct task when an inline issue mention appears before the closing keyword", async () => {
    const body = "## Summary\n\n- fix (fixes #916): some detail\n\nCloses #42.";
    const task = await manager.handlePrEditedEvent(10, body, "fix-branch");
    expect(task?.taskId).toBe("42");
    expect(await Task.getByRepoPr(manager.repo.id, 10)).not.toBeNull();
  });

  it("skips a pending task match and returns the assigned one", async () => {
    await Task.upsert("916", 916, REPO, "Unrelated task", "Body", ["brunel:ready"]);
    const body = "## Summary\n\n- fix (fixes #916): some detail\n\nCloses #42.";
    const task = await manager.handlePrEditedEvent(10, body, "fix-branch");
    expect(task?.taskId).toBe("42");
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
    expect(await Task.getByRepoPr(manager.repo.id,10)).toBeNull();
  });

  it("records merge when merged=true and keeps PR association", async () => {
    const task = await manager.handlePrClosedEvent(10, true);
    expect(task?.taskId).toBe("42");
    expect(task?.prMergedAt).toBeTruthy();
    expect(await Task.getByRepoPr(manager.repo.id,10)).not.toBeNull();
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
    expect(task.toAssignmentPayload()).toMatchObject({
      number: 42,
      title: "Fix the bug",
      body: "It is broken",
      labels: ["bug", "brunel:ready"],
      repoUrl: "https://github.com/owner/repo",
      status: "pending",
      prNumber: null,
      branch: null,
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

// ── loadIssuesFromGithub ──────────────────────────────────────────────────────

describe("loadIssuesFromGithub", () => {
  const mockIssues = [
    { number: 1, title: "First issue", body: "body 1", labels: [{ name: "brunel:ready" }] },
    { number: 2, title: "Second issue", body: null, labels: [{ name: "brunel:ready" }] },
  ];

  beforeEach(() => {
    Worker._reset();
    vi.stubGlobal("fetch", vi.fn());
    getConfig().githubToken = "token";
    getConfig().taskLabel = "brunel:ready";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches issues and populates the task manager", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => mockIssues } as any);

    resetDb();
    const taskManager = await createTestTaskManager("owner/repo");
    vi.spyOn(taskManager, "fetchBlockers").mockResolvedValue([]);

    await taskManager.loadIssuesFromGithub();

    expect((await Task.getByRepoIssue(taskManager.repo.id, 1))?.title).toBe("First issue");
    expect((await Task.getByRepoIssue(taskManager.repo.id, 2))?.body).toBe(""); // null coerced to ""
  });

  it("throws on non-ok GitHub response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 403 } as any);
    resetDb();
    const taskManager = await createTestTaskManager("owner/repo");
    await expect(taskManager.loadIssuesFromGithub()).rejects.toThrow("403");
  });

  it("preserves existing task assignment (fix for issue #600)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => [{ number: 1, title: "Updated title", body: "Updated body", labels: [{ name: "brunel:ready" }] }],
    } as any);

    resetDb();
    const taskManager = await createTestTaskManager("owner/repo");
    vi.spyOn(taskManager, "fetchBlockers").mockResolvedValue([]);

    await Task.upsert("1", 1, "owner/repo", "Original title", "Original body", ["brunel:ready"]);
    const t = await Task.getByRepoIssue(taskManager.repo.id, 1);
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("worker-abc", fakeWs, fakeRepo()));

    await taskManager.loadIssuesFromGithub();

    const task = await Task.getByRepoIssue(taskManager.repo.id, 1);
    expect(task?.title).toBe("Updated title");
    expect(task?.workerId).toBe("worker-abc"); // MUST NOT be reset to null
  });

  it("does not delete pending tasks from other repos during cleanup", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => [{ number: 1, title: "Issue 1", body: "", labels: [{ name: "brunel:ready" }] }],
    } as any);

    resetDb();
    const tmA = await createTestTaskManager("owner/repo-a");
    const tmB = await createTestTaskManager("owner/repo-b");
    vi.spyOn(tmA, "fetchBlockers").mockResolvedValue([]);

    await Task.upsert("repo-b-7", 7, "owner/repo-b", "Repo B issue", "", ["brunel:ready"]);
    expect(await Task.getByRepoIssue(tmB.repo.id, 7)).not.toBeNull();

    await tmA.loadIssuesFromGithub();

    expect(await Task.getByRepoIssue(tmB.repo.id, 7)).not.toBeNull();
  });

  it("still deletes stale tasks from the current repo", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => [{ number: 1, title: "Issue 1", body: "", labels: [{ name: "brunel:ready" }] }],
    } as any);

    resetDb();
    const tmA = await createTestTaskManager("owner/repo-a");
    vi.spyOn(tmA, "fetchBlockers").mockResolvedValue([]);

    await Task.upsert("repo-a-99", 99, "owner/repo-a", "Stale issue", "", []);
    expect(await Task.getByRepoIssue(tmA.repo.id, 99)).not.toBeNull();

    await tmA.loadIssuesFromGithub();

    expect(await Task.getByRepoIssue(tmA.repo.id, 99)).toBeNull();
  });

  it("populates blocker state from fetchBlockers result", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ number: 1, title: "Do thing", body: "Depends on #99", labels: [{ name: "brunel:ready" }] }],
      } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ number: 99, state: "open" }) } as any);

    resetDb();
    const taskManager = await createTestTaskManager("owner/repo");
    vi.spyOn(taskManager, "fetchBlockers").mockResolvedValueOnce([99]);

    await taskManager.loadIssuesFromGithub();

    expect(taskManager.isBlockersLoaded(1)).toBe(true);
    expect(taskManager.isBlocked(1)).toBe(true);
  });

  it("does not mark closed blocker as blocking", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ number: 2, title: "Another", body: "Depends on #50", labels: [{ name: "brunel:ready" }] }],
      } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ number: 50, state: "closed" }) } as any);

    resetDb();
    const taskManager = await createTestTaskManager("owner/repo");
    vi.spyOn(taskManager, "fetchBlockers").mockResolvedValueOnce([50]);

    await taskManager.loadIssuesFromGithub();

    expect(taskManager.isBlocked(2)).toBe(false);
  });
});
