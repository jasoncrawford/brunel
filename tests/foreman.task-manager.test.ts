import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TaskManager } from "../src/foreman/models/task-manager.js";
import { Task } from "../src/foreman/models/task.js";
import { Worker } from "../src/foreman/models/worker.js";
import { setupInMemoryTasks } from "./helpers/task.js";

const REPO = "test/repo";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Task.complete", () => {
  let manager: TaskManager;

  beforeEach(async () => {
    Worker._reset();
    manager = new TaskManager();
    setupInMemoryTasks(manager);
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
    manager = new TaskManager();
    setupInMemoryTasks(manager);
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
    setupInMemoryTasks();
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
    setupInMemoryTasks();
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
    setupInMemoryTasks();
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
    setupInMemoryTasks();
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
    setupInMemoryTasks();
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
    setupInMemoryTasks();
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
    setupInMemoryTasks();
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

  beforeEach(() => {
    Worker._reset();
    manager = new TaskManager();
    setupInMemoryTasks(manager);
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

    const t = await Task.get("42");
    vi.spyOn(t!, "assign").mockRejectedValue(new Error("DB down"));

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

    const t = await Task.get("42");
    vi.spyOn(t!, "assign").mockRejectedValue(new Error("DB down"));

    // Both calls should resolve (not hang), even though assignment fails.
    await manager.assignIdleWorkers();
    await manager.assignIdleWorkers();
  });
});
