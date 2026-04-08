import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskModel } from "../src/foreman/models/task-model.js";
import { createMemoryTaskStore } from "../src/foreman/db.js";
import type { TaskStore } from "../src/foreman/db.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a real in-memory store with spies on every method so we can assert
 *  both "store method was called" and have reads-after-writes work naturally. */
function makeStore(): TaskStore {
  const store = createMemoryTaskStore();
  vi.spyOn(store, "upsertTask");
  vi.spyOn(store, "updateTaskContent");
  vi.spyOn(store, "markAssigned");
  vi.spyOn(store, "markComplete");
  vi.spyOn(store, "markPending");
  vi.spyOn(store, "setIssueClosed");
  vi.spyOn(store, "clearIssueClosed");
  vi.spyOn(store, "setPrMerged");
  vi.spyOn(store, "deleteTask");
  vi.spyOn(store, "updateTaskPr");
  vi.spyOn(store, "getTask");
  vi.spyOn(store, "getTaskByIssue");
  vi.spyOn(store, "getTaskByPr");
  vi.spyOn(store, "getTaskByWorker");
  vi.spyOn(store, "listTasks");
  return store;
}

const REPO = "test/repo";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TaskModel.complete", () => {
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(async () => {
    store = makeStore();
    model = new TaskModel(store);
    await model.register("42", 42, REPO, "Fix the bug", "It is broken", ["brunel:ready"]);
    await model.assign("42", "w1");
  });

  it("marks the task complete and awaits store.markComplete", async () => {
    await model.complete("42");
    const t = await model.get("42");
    expect(t?.status).toBe("complete");
    expect(store.markComplete).toHaveBeenCalledWith("42");
  });

  it("propagates store errors to the caller", async () => {
    vi.spyOn(store, "markComplete").mockRejectedValue(new Error("DB down"));
    await expect(model.complete("42")).rejects.toThrow("DB down");
  });
});

describe("TaskModel.revert", () => {
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(async () => {
    store = makeStore();
    model = new TaskModel(store);
    await model.register("42", 42, REPO, "Fix the bug", "It is broken", ["brunel:ready"]);
    await model.assign("42", "w1");
  });

  it("reverts the task to pending and awaits store.markPending", async () => {
    await model.revert("42");
    const t = await model.get("42");
    expect(t?.status).toBe("pending");
    expect(t?.assignedWorkerId).toBeUndefined();
    expect(store.markPending).toHaveBeenCalledWith("42");
  });

  it("propagates store errors to the caller", async () => {
    vi.spyOn(store, "markPending").mockRejectedValue(new Error("DB down"));
    await expect(model.revert("42")).rejects.toThrow("DB down");
  });
});

describe("TaskModel.register", () => {
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(() => {
    store = makeStore();
    model = new TaskModel(store);
  });

  it("adds the task to the store as pending", async () => {
    await model.register("42", 42, "owner/repo", "Title", "Body", ["label"]);
    const t = await model.get("42");
    expect(t?.status).toBe("pending");
    expect(t?.title).toBe("Title");
  });

  it("calls store.upsertTask with the repo slug", async () => {
    await model.register("42", 42, "owner/repo", "Title", "Body", ["label"]);
    expect(store.upsertTask).toHaveBeenCalledWith("42", 42, "owner/repo", "Title", "Body", ["label"]);
  });

  it("propagates store errors to the caller", async () => {
    vi.spyOn(store, "upsertTask").mockRejectedValue(new Error("oops"));
    await expect(model.register("42", 42, "owner/repo", "T", "B", [])).rejects.toThrow("oops");
  });
});

describe("TaskModel.assign", () => {
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(async () => {
    store = makeStore();
    model = new TaskModel(store);
    await model.register("42", 42, REPO, "Fix the bug", "It is broken", ["brunel:ready"]);
  });

  it("returns true and marks task assigned on success", async () => {
    const ok = await model.assign("42", "w1");
    expect(ok).toBe(true);
    const t = await model.get("42");
    expect(t?.status).toBe("assigned");
    expect(t?.assignedWorkerId).toBe("w1");
  });

  it("awaits store.markAssigned before resolving", async () => {
    let storeWritten = false;
    vi.spyOn(store, "markAssigned").mockImplementation(() =>
      new Promise<void>((r) => setTimeout(() => { storeWritten = true; r(); }, 10))
    );
    await model.assign("42", "w1");
    expect(storeWritten).toBe(true);
  });

  it("returns false when store.markAssigned throws", async () => {
    vi.spyOn(store, "markAssigned").mockRejectedValue(new Error("DB down"));
    const ok = await model.assign("42", "w1");
    expect(ok).toBe(false);
  });
});

describe("TaskModel.cancel", () => {
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(async () => {
    store = makeStore();
    model = new TaskModel(store);
    await model.register("42", 42, REPO, "Fix the bug", "It is broken", ["brunel:ready"]);
  });

  it("removes the task from the store and awaits store.deleteTask", async () => {
    await model.cancel("42");
    const t = await model.get("42");
    expect(t).toBeNull();
    expect(store.deleteTask).toHaveBeenCalledWith("42");
  });

  it("propagates store errors to the caller", async () => {
    vi.spyOn(store, "deleteTask").mockRejectedValue(new Error("DB down"));
    await expect(model.cancel("42")).rejects.toThrow("DB down");
  });
});

describe("TaskModel.refreshContent", () => {
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(async () => {
    store = makeStore();
    model = new TaskModel(store);
    await model.register("42", 42, REPO, "Fix the bug", "It is broken", ["brunel:ready"]);
  });

  it("awaits store.updateTaskContent", async () => {
    await model.refreshContent("42", "New Title", "New Body", ["bug"]);
    expect(store.updateTaskContent).toHaveBeenCalledWith("42", "New Title", "New Body", ["bug"]);
  });

  it("updates task fields in the store", async () => {
    await model.refreshContent("42", "New Title", "New Body", ["bug"]);
    const t = await model.get("42");
    expect(t?.title).toBe("New Title");
    expect(t?.body).toBe("New Body");
    expect(t?.labels).toEqual(["bug"]);
  });

  it("propagates store errors to the caller", async () => {
    vi.spyOn(store, "updateTaskContent").mockRejectedValue(new Error("DB down"));
    await expect(model.refreshContent("42", "T", "B", [])).rejects.toThrow("DB down");
  });
});

describe("TaskModel.registerPr", () => {
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(async () => {
    store = makeStore();
    model = new TaskModel(store);
    await model.register("42", 42, REPO, "Fix the bug", "It is broken", ["brunel:ready"]);
  });

  it("registers PR in the store and awaits store.updateTaskPr", async () => {
    await model.registerPr("42", 10, "fix-branch");
    const t = await model.getTaskForPr(10);
    expect(t?.taskId).toBe("42");
    expect(store.updateTaskPr).toHaveBeenCalledWith("42", 10, "fix-branch");
  });

  it("propagates store errors to the caller", async () => {
    vi.spyOn(store, "updateTaskPr").mockRejectedValue(new Error("DB down"));
    await expect(model.registerPr("42", 10, "fix-branch")).rejects.toThrow("DB down");
  });
});

describe("TaskModel.unregisterPr", () => {
  let store: TaskStore;
  let model: TaskModel;

  beforeEach(async () => {
    store = makeStore();
    model = new TaskModel(store);
    await model.register("42", 42, REPO, "Fix the bug", "It is broken", ["brunel:ready"]);
    await model.registerPr("42", 10, "fix-branch");
  });

  it("unregisters PR in the store and awaits store.updateTaskPr", async () => {
    await model.unregisterPr(10);
    const t = await model.getTaskForPr(10);
    expect(t).toBeNull();
    expect(store.updateTaskPr).toHaveBeenCalledWith("42", null, null);
  });

  it("propagates store errors to the caller", async () => {
    vi.spyOn(store, "updateTaskPr").mockRejectedValue(new Error("DB down"));
    await expect(model.unregisterPr(10)).rejects.toThrow("DB down");
  });
});

describe("TaskModel.listTasks", () => {
  it("delegates to store.listTasks", async () => {
    const store = makeStore();
    const model = new TaskModel(store);
    await model.register("1", 1, REPO, "Task 1", "Body", ["label"]);
    const result = await model.listTasks({ status: "pending" });
    expect(result).toHaveLength(1);
    expect(result[0].taskId).toBe("1");
    expect(store.listTasks).toHaveBeenCalledWith({ status: "pending" });
  });
});
