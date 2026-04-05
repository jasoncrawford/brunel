import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskModel } from "../src/foreman/task-model.js";
import type { TaskStore } from "../src/foreman/db.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStore(): TaskStore {
  return {
    upsertTask: vi.fn().mockResolvedValue(undefined),
    updateTaskContent: vi.fn().mockResolvedValue(undefined),
    markAssigned: vi.fn().mockResolvedValue(undefined),
    markComplete: vi.fn().mockResolvedValue(undefined),
    markPending: vi.fn().mockResolvedValue(undefined),
    markBlocked: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    updateTaskPr: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
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
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(() => {
    store = makeStore();
    model = new TaskModel(store);
    model.loadTask(baseTask);
    model.assignInMemory("42", "w1");
  });

  it("marks the task complete in memory and awaits store.markComplete", async () => {
    await model.complete("42");
    expect(model.get("42")?.status).toBe("complete");
    expect(store.markComplete).toHaveBeenCalledWith("42");
  });

  it("propagates store errors to the caller", async () => {
    (store.markComplete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB down"));
    await expect(model.complete("42")).rejects.toThrow("DB down");
    // memory is updated even on DB failure
    expect(model.get("42")?.status).toBe("complete");
  });
});

describe("TaskModel.revert", () => {
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(() => {
    store = makeStore();
    model = new TaskModel(store);
    model.loadTask(baseTask);
    model.assignInMemory("42", "w1");
  });

  it("reverts the task to pending in memory and awaits store.markPending", async () => {
    await model.revert("42");
    expect(model.get("42")?.status).toBe("pending");
    expect(model.get("42")?.assignedWorkerId).toBeUndefined();
    expect(store.markPending).toHaveBeenCalledWith("42");
  });

  it("propagates store errors to the caller", async () => {
    (store.markPending as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB down"));
    await expect(model.revert("42")).rejects.toThrow("DB down");
    expect(model.get("42")?.status).toBe("pending");
  });
});

describe("TaskModel.block", () => {
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(() => {
    store = makeStore();
    model = new TaskModel(store);
    model.loadTask(baseTask); // pending
  });

  it("marks the task blocked in memory and awaits store.markBlocked", async () => {
    await model.block("42");
    expect(model.get("42")?.status).toBe("blocked");
    expect(store.markBlocked).toHaveBeenCalledWith("42");
  });

  it("propagates store errors to the caller", async () => {
    (store.markBlocked as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB down"));
    await expect(model.block("42")).rejects.toThrow("DB down");
    expect(model.get("42")?.status).toBe("blocked");
  });
});

describe("TaskModel.unblock", () => {
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(() => {
    store = makeStore();
    model = new TaskModel(store);
    model.loadTask({ ...baseTask, status: "blocked" });
  });

  it("marks the task pending in memory", async () => {
    await model.unblock("42");
    expect(model.get("42")?.status).toBe("pending");
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
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(() => {
    store = makeStore();
    model = new TaskModel(store);
  });

  it("adds the task to memory", () => {
    model.register("42", 42, "owner/repo", "Title", "Body", ["label"], "https://github.com/owner/repo");
    expect(model.get("42")?.status).toBe("pending");
    expect(model.get("42")?.title).toBe("Title");
  });

  it("calls store.upsertTask with the repo slug", async () => {
    await model.register("42", 42, "owner/repo", "Title", "Body", ["label"], "https://github.com/owner/repo");
    expect(store.upsertTask).toHaveBeenCalledWith("42", 42, "owner/repo", "Title", "Body", ["label"]);
  });

  it("respects the depsLoaded flag", () => {
    model.register("42", 42, "owner/repo", "Title", "Body", [], "https://github.com/owner/repo", false);
    expect(model.get("42")?.depsLoaded).toBe(false);
  });

  it("propagates store errors to the caller", async () => {
    (store.upsertTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("oops"));
    await expect(model.register("42", 42, "owner/repo", "T", "B", [], "url")).rejects.toThrow("oops");
  });
});

describe("TaskModel.assign", () => {
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(() => {
    store = makeStore();
    model = new TaskModel(store);
    model.loadTask(baseTask);
  });

  it("returns true and marks task assigned on success", async () => {
    const ok = await model.assign("42", "w1");
    expect(ok).toBe(true);
    expect(model.get("42")?.status).toBe("assigned");
    expect(model.get("42")?.assignedWorkerId).toBe("w1");
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
    expect(model.get("42")?.status).toBe("pending");
    expect(model.get("42")?.assignedWorkerId).toBeUndefined();
  });
});

describe("TaskModel.cancel", () => {
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(() => {
    store = makeStore();
    model = new TaskModel(store);
    model.loadTask(baseTask); // pending
  });

  it("removes the task from memory and awaits store.deleteTask", async () => {
    await model.cancel("42");
    expect(model.get("42")).toBeUndefined();
    expect(store.deleteTask).toHaveBeenCalledWith("42");
  });

  it("propagates store errors to the caller", async () => {
    (store.deleteTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB down"));
    await expect(model.cancel("42")).rejects.toThrow("DB down");
    expect(model.get("42")).toBeUndefined(); // memory still updated
  });
});

describe("TaskModel.refreshContent", () => {
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(() => {
    store = makeStore();
    model = new TaskModel(store);
  });

  it("awaits store.updateTaskContent", async () => {
    await model.refreshContent("42", "New Title", "New Body", ["bug"]);
    expect(store.updateTaskContent).toHaveBeenCalledWith("42", "New Title", "New Body", ["bug"]);
  });

  it("updates in-memory task fields", async () => {
    model.loadTask(baseTask);
    await model.refreshContent("42", "New Title", "New Body", ["bug"], true);
    const t = model.get("42");
    expect(t?.title).toBe("New Title");
    expect(t?.body).toBe("New Body");
    expect(t?.labels).toEqual(["bug"]);
    expect(t?.depsLoaded).toBe(true);
  });

  it("propagates store errors to the caller", async () => {
    (store.updateTaskContent as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB down"));
    await expect(model.refreshContent("42", "T", "B", [])).rejects.toThrow("DB down");
  });
});

describe("TaskModel.registerPr", () => {
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(() => {
    store = makeStore();
    model = new TaskModel(store);
    model.loadTask(baseTask);
  });

  it("registers PR in memory and awaits store.updateTaskPr", async () => {
    await model.registerPr("42", 10, "fix-branch");
    expect(model.getTaskForPr(10)?.taskId).toBe("42");
    expect(store.updateTaskPr).toHaveBeenCalledWith("42", 10, "fix-branch");
  });

  it("propagates store errors to the caller", async () => {
    (store.updateTaskPr as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB down"));
    await expect(model.registerPr("42", 10, "fix-branch")).rejects.toThrow("DB down");
  });
});

describe("TaskModel.unregisterPr", () => {
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(() => {
    store = makeStore();
    model = new TaskModel(store);
    model.loadTask(baseTask);
    model.registerPr("42", 10, null);
  });

  it("unregisters PR in memory and awaits store.updateTaskPr", async () => {
    await model.unregisterPr(10);
    expect(model.getTaskForPr(10)).toBeUndefined();
    expect(store.updateTaskPr).toHaveBeenCalledWith("42", null, null);
  });

  it("propagates store errors to the caller", async () => {
    (store.updateTaskPr as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB down"));
    await expect(model.unregisterPr(10)).rejects.toThrow("DB down");
  });
});

describe("TaskModel.listTasks", () => {
  it("delegates to store.listTasks", async () => {
    const rows = [{ taskId: "1", issueNumber: 1, status: "pending" }];
    const store = makeStore();
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue(rows);
    const model = new TaskModel(store);
    const result = await model.listTasks({ status: "pending" });
    expect(result).toEqual(rows);
    expect(store.listTasks).toHaveBeenCalledWith({ status: "pending" });
  });
});
