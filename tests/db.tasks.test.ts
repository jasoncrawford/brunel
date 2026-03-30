import { describe, it, expect, beforeEach } from "vitest";
import { createTaskStore, createNullTaskStore } from "../src/db.js";
import { createTestSupabase } from "./helpers/db.js";

const supabase = createTestSupabase();

// Task IDs owned by this test file — only these are cleaned up in beforeEach.
const OWN_IDS = ["1", "2", "3", "42"];

beforeEach(async () => {
  await supabase.from("tasks").delete().in("task_id", OWN_IDS);
});

/** Filter listTasks() results to only the rows this file owns. */
function ownTasks<T extends { taskId: string }>(rows: T[]): T[] {
  return rows.filter((r) => OWN_IDS.includes(r.taskId));
}

// ── Tests: createTaskStore ─────────────────────────────────────────────────────

describe("createTaskStore", () => {
  it("upsertTask stores a row with status=pending", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("42", 42, "owner/repo", "Fix the bug");

    const tasks = ownTasks(await store.listTasks());
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskId: "42",
      issueNumber: 42,
      repo: "owner/repo",
      title: "Fix the bug",
      status: "pending",
      workerId: null,
      prNumber: null,
      branch: null,
    });
    expect(tasks[0].createdAt).toBeTruthy();
    expect(tasks[0].assignedAt).toBeNull();
    expect(tasks[0].completedAt).toBeNull();
  });

  it("upsertTask is idempotent — duplicate task_id does not throw or duplicate", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("42", 42, "owner/repo", "Fix the bug");
    // Should not throw (ignoreDuplicates: true)
    await expect(store.upsertTask("42", 42, "owner/repo", "Fix the bug")).resolves.toBeUndefined();

    const tasks = ownTasks(await store.listTasks());
    expect(tasks).toHaveLength(1);
  });

  it("upsertTask does not overwrite an existing row (ignoreDuplicates)", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("42", 42, "owner/repo", "Original title");
    await store.markAssigned("42", "worker-1");
    // Second upsert with same task_id should be ignored
    await store.upsertTask("42", 42, "owner/repo", "New title");

    const tasks = ownTasks(await store.listTasks());
    const task = tasks.find((t) => t.taskId === "42")!;
    expect(task.title).toBe("Original title");
    expect(task.status).toBe("assigned"); // status was not reset to pending
  });

  it("markAssigned updates status, worker_id, and sets assigned_at", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("42", 42, "owner/repo", "Fix the bug");
    await store.markAssigned("42", "worker-1");

    const task = ownTasks(await store.listTasks()).find((t) => t.taskId === "42")!;
    expect(task.status).toBe("assigned");
    expect(task.workerId).toBe("worker-1");
    expect(task.assignedAt).toBeTruthy();
  });

  it("markComplete updates status and sets completed_at", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("42", 42, "owner/repo", "Fix the bug");
    await store.markAssigned("42", "worker-1");
    await store.markComplete("42");

    const task = ownTasks(await store.listTasks()).find((t) => t.taskId === "42")!;
    expect(task.status).toBe("complete");
    expect(task.completedAt).toBeTruthy();
  });

  it("markPending reverts status to pending and clears worker_id", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("42", 42, "owner/repo", "Fix the bug");
    await store.markAssigned("42", "worker-1");
    await store.markPending("42");

    const task = ownTasks(await store.listTasks()).find((t) => t.taskId === "42")!;
    expect(task.status).toBe("pending");
    expect(task.workerId).toBeNull();
  });

  it("updateTaskPr stores pr_number and branch", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("42", 42, "owner/repo", "Fix the bug");
    await store.updateTaskPr("42", 10, "fix-issue-42");

    const task = ownTasks(await store.listTasks()).find((t) => t.taskId === "42")!;
    expect(task.prNumber).toBe(10);
    expect(task.branch).toBe("fix-issue-42");
  });

  it("updateTaskPr stores null branch when branch is null", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("42", 42, "owner/repo", "Fix the bug");
    await store.updateTaskPr("42", 10, null);

    const task = ownTasks(await store.listTasks()).find((t) => t.taskId === "42")!;
    expect(task.prNumber).toBe(10);
    expect(task.branch).toBeNull();
  });

  it("listTasks returns rows in descending created_at order", async () => {
    const store = createTaskStore(supabase);
    // Insert with explicit timestamps so order is predictable
    await supabase.from("tasks").insert({
      task_id: "1", issue_number: 1, repo: "r/r", title: "First",
      status: "pending", created_at: "2026-03-27T01:00:00Z",
    });
    await supabase.from("tasks").insert({
      task_id: "2", issue_number: 2, repo: "r/r", title: "Second",
      status: "pending", created_at: "2026-03-27T03:00:00Z",
    });
    await supabase.from("tasks").insert({
      task_id: "3", issue_number: 3, repo: "r/r", title: "Third",
      status: "pending", created_at: "2026-03-27T02:00:00Z",
    });

    const tasks = ownTasks(await store.listTasks());
    expect(tasks.map((t) => t.taskId)).toEqual(["2", "3", "1"]);
  });

  it("listTasks returns empty array when no rows", async () => {
    const store = createTaskStore(supabase);
    expect(ownTasks(await store.listTasks())).toEqual([]);
  });

  it("listTasks filters by status when provided", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("1", 1, "r/r", "Pending task");
    await store.upsertTask("2", 2, "r/r", "Complete task");
    await store.markAssigned("2", "w1");
    await store.markComplete("2");

    const pending = ownTasks(await store.listTasks({ status: "pending" }));
    expect(pending).toHaveLength(1);
    expect(pending[0].taskId).toBe("1");

    const complete = ownTasks(await store.listTasks({ status: "complete" }));
    expect(complete).toHaveLength(1);
    expect(complete[0].taskId).toBe("2");
  });

  it("listTasks returns all statuses when status not provided", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("1", 1, "r/r", "Pending");
    await store.upsertTask("2", 2, "r/r", "Assigned");
    await store.markAssigned("2", "w1");

    const all = ownTasks(await store.listTasks());
    expect(all).toHaveLength(2);
  });

  it("listTasks handles null nullable fields", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("1", 1, "r/r", "T");

    const task = ownTasks(await store.listTasks()).find((t) => t.taskId === "1")!;
    expect(task.workerId).toBeNull();
    expect(task.prNumber).toBeNull();
    expect(task.branch).toBeNull();
    expect(task.assignedAt).toBeNull();
    expect(task.completedAt).toBeNull();
  });
});

// ── Tests: createTaskStore — blocked status ────────────────────────────────────

describe("createTaskStore — blocked status", () => {
  it("markBlocked sets status to blocked", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("42", 42, "owner/repo", "Fix the bug");
    await store.markBlocked("42");

    const task = ownTasks(await store.listTasks()).find((t) => t.taskId === "42")!;
    expect(task.status).toBe("blocked");
    expect(task.workerId).toBeNull();
  });

  it("listTasks filters by status=blocked", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("1", 1, "r/r", "Pending");
    await store.upsertTask("2", 2, "r/r", "Blocked");
    await store.markBlocked("2");

    const blocked = ownTasks(await store.listTasks({ status: "blocked" }));
    expect(blocked).toHaveLength(1);
    expect(blocked[0].taskId).toBe("2");
  });

  it("listTasks returns blocked tasks when no filter", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("1", 1, "r/r", "Pending");
    await store.upsertTask("2", 2, "r/r", "Blocked");
    await store.markBlocked("2");

    const all = ownTasks(await store.listTasks());
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.status)).toEqual(expect.arrayContaining(["pending", "blocked"]));
  });
});

// ── Tests: createNullTaskStore ─────────────────────────────────────────────────

describe("createNullTaskStore", () => {
  it("upsertTask resolves without error", async () => {
    const store = createNullTaskStore();
    await expect(store.upsertTask("42", 42, "r/r", "title")).resolves.toBeUndefined();
  });

  it("markAssigned resolves without error", async () => {
    const store = createNullTaskStore();
    await expect(store.markAssigned("42", "w1")).resolves.toBeUndefined();
  });

  it("markComplete resolves without error", async () => {
    const store = createNullTaskStore();
    await expect(store.markComplete("42")).resolves.toBeUndefined();
  });

  it("markPending resolves without error", async () => {
    const store = createNullTaskStore();
    await expect(store.markPending("42")).resolves.toBeUndefined();
  });

  it("markBlocked resolves without error", async () => {
    const store = createNullTaskStore();
    await expect(store.markBlocked("42")).resolves.toBeUndefined();
  });

  it("updateTaskPr resolves without error", async () => {
    const store = createNullTaskStore();
    await expect(store.updateTaskPr("42", 10, "fix")).resolves.toBeUndefined();
  });

  it("listTasks returns empty array", async () => {
    const store = createNullTaskStore();
    expect(await store.listTasks()).toEqual([]);
  });
});
