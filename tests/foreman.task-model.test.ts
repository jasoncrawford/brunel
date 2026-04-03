import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskQueue, TaskModel } from "../src/foreman.js";
import type { TaskStore } from "../src/db.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStore(): TaskStore {
  return {
    upsertTask: vi.fn().mockResolvedValue(undefined),
    markAssigned: vi.fn().mockResolvedValue(undefined),
    markComplete: vi.fn().mockResolvedValue(undefined),
    markPending: vi.fn().mockResolvedValue(undefined),
    markBlocked: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    updateTaskPr: vi.fn().mockResolvedValue(undefined),
    listTasks: vi.fn().mockResolvedValue([]),
  };
}

const baseTask = {
  taskId: "42",
  issueNumber: 42,
  title: "Fix the bug",
  body: "It is broken",
  labels: ["brunel:ready"],
  repoUrl: "https://github.com/test/repo",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TaskModel.complete", () => {
  let queue: TaskQueue;
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(() => {
    queue = new TaskQueue();
    store = makeStore();
    model = new TaskModel(queue, store, () => {});
    queue.addTask(baseTask);
    queue.assignTask("42", "w1");
  });

  it("marks the task complete in memory", () => {
    model.complete("42");
    expect(queue.get("42")?.status).toBe("complete");
  });

  it("calls store.markComplete", async () => {
    model.complete("42");
    // allow microtasks to flush
    await Promise.resolve();
    expect(store.markComplete).toHaveBeenCalledWith("42");
  });
});

describe("TaskModel.revert", () => {
  let queue: TaskQueue;
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(() => {
    queue = new TaskQueue();
    store = makeStore();
    model = new TaskModel(queue, store, () => {});
    queue.addTask(baseTask);
    queue.assignTask("42", "w1");
  });

  it("reverts the task to pending in memory", () => {
    model.revert("42");
    expect(queue.get("42")?.status).toBe("pending");
    expect(queue.get("42")?.assignedWorkerId).toBeUndefined();
  });

  it("calls store.markPending", async () => {
    model.revert("42");
    await Promise.resolve();
    expect(store.markPending).toHaveBeenCalledWith("42");
  });
});

describe("TaskModel.block", () => {
  let queue: TaskQueue;
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(() => {
    queue = new TaskQueue();
    store = makeStore();
    model = new TaskModel(queue, store, () => {});
    queue.addTask(baseTask); // pending
  });

  it("marks the task blocked in memory", () => {
    model.block("42");
    expect(queue.get("42")?.status).toBe("blocked");
  });

  it("calls store.markBlocked", async () => {
    model.block("42");
    await Promise.resolve();
    expect(store.markBlocked).toHaveBeenCalledWith("42");
  });
});

describe("TaskModel.unblock", () => {
  let queue: TaskQueue;
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(() => {
    queue = new TaskQueue();
    store = makeStore();
    model = new TaskModel(queue, store, () => {});
    queue.addTask({ ...baseTask, status: "blocked" });
  });

  it("marks the task pending in memory", async () => {
    await model.unblock("42");
    expect(queue.get("42")?.status).toBe("pending");
  });

  it("awaits store.markPending before resolving", async () => {
    let resolved = false;
    (store.markPending as ReturnType<typeof vi.fn>).mockImplementation(() =>
      new Promise<void>((r) => setTimeout(() => { resolved = true; r(); }, 10))
    );
    const p = model.unblock("42");
    expect(resolved).toBe(false);
    await p;
    expect(resolved).toBe(true);
  });

  it("propagates store errors to the caller", async () => {
    (store.markPending as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB down"));
    await expect(model.unblock("42")).rejects.toThrow("DB down");
  });
});

describe("TaskModel.register", () => {
  let queue: TaskQueue;
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(() => {
    queue = new TaskQueue();
    store = makeStore();
    model = new TaskModel(queue, store, () => {});
  });

  it("adds the task to memory", () => {
    model.register("42", 42, "owner/repo", "Title", "Body", ["label"], "https://github.com/owner/repo");
    expect(queue.get("42")?.status).toBe("pending");
    expect(queue.get("42")?.title).toBe("Title");
  });

  it("calls store.upsertTask with the repo slug", async () => {
    model.register("42", 42, "owner/repo", "Title", "Body", ["label"], "https://github.com/owner/repo");
    await Promise.resolve();
    expect(store.upsertTask).toHaveBeenCalledWith("42", 42, "owner/repo", "Title", "Body", ["label"]);
  });

  it("respects the depsLoaded flag", () => {
    model.register("42", 42, "owner/repo", "Title", "Body", [], "https://github.com/owner/repo", false);
    expect(queue.get("42")?.depsLoaded).toBe(false);
  });
});

describe("TaskModel.assign", () => {
  let queue: TaskQueue;
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(() => {
    queue = new TaskQueue();
    store = makeStore();
    model = new TaskModel(queue, store, () => {});
    queue.addTask(baseTask);
  });

  it("returns true and marks task assigned on success", async () => {
    const ok = await model.assign("42", "w1");
    expect(ok).toBe(true);
    expect(queue.get("42")?.status).toBe("assigned");
    expect(queue.get("42")?.assignedWorkerId).toBe("w1");
  });

  it("awaits store.markAssigned before resolving", async () => {
    let storeWritten = false;
    (store.markAssigned as ReturnType<typeof vi.fn>).mockImplementation(() =>
      new Promise<void>((r) => setTimeout(() => { storeWritten = true; r(); }, 10))
    );
    await model.assign("42", "w1");
    expect(storeWritten).toBe(true);
  });

  it("returns false and reverts memory when store.markAssigned throws", async () => {
    (store.markAssigned as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB down"));
    const ok = await model.assign("42", "w1");
    expect(ok).toBe(false);
    expect(queue.get("42")?.status).toBe("pending");
    expect(queue.get("42")?.assignedWorkerId).toBeUndefined();
  });
});

describe("TaskModel.cancel", () => {
  let queue: TaskQueue;
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(() => {
    queue = new TaskQueue();
    store = makeStore();
    model = new TaskModel(queue, store, () => {});
    queue.addTask(baseTask); // pending
  });

  it("removes the task from memory", () => {
    model.cancel("42");
    expect(queue.get("42")).toBeUndefined();
  });

  it("calls store.deleteTask", async () => {
    model.cancel("42");
    await Promise.resolve();
    expect(store.deleteTask).toHaveBeenCalledWith("42");
  });
});

describe("TaskModel.logError callback", () => {
  it("fires on store.markComplete failure", async () => {
    const queue = new TaskQueue();
    const store = makeStore();
    const errors: string[] = [];
    const model = new TaskModel(queue, store, (msg) => errors.push(msg));
    queue.addTask(baseTask);
    queue.assignTask("42", "w1");
    (store.markComplete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("oops"));

    model.complete("42");
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/42/);
  });

  it("fires on store.markPending failure (revert)", async () => {
    const queue = new TaskQueue();
    const store = makeStore();
    const errors: string[] = [];
    const model = new TaskModel(queue, store, (msg) => errors.push(msg));
    queue.addTask(baseTask);
    queue.assignTask("42", "w1");
    (store.markPending as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("oops"));

    model.revert("42");
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/42/);
  });

  it("fires on store.markBlocked failure", async () => {
    const queue = new TaskQueue();
    const store = makeStore();
    const errors: string[] = [];
    const model = new TaskModel(queue, store, (msg) => errors.push(msg));
    queue.addTask(baseTask);
    (store.markBlocked as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("oops"));

    model.block("42");
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/42/);
  });

  it("fires on store.deleteTask failure (cancel)", async () => {
    const queue = new TaskQueue();
    const store = makeStore();
    const errors: string[] = [];
    const model = new TaskModel(queue, store, (msg) => errors.push(msg));
    queue.addTask(baseTask);
    (store.deleteTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("oops"));

    model.cancel("42");
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/42/);
  });

  it("fires on store.upsertTask failure (register)", async () => {
    const queue = new TaskQueue();
    const store = makeStore();
    const errors: string[] = [];
    const model = new TaskModel(queue, store, (msg) => errors.push(msg));
    (store.upsertTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("oops"));

    model.register("42", 42, "owner/repo", "T", "B", [], "url");
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/42/);
  });
});
