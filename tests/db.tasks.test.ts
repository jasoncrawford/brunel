import { describe, it, expect, beforeEach } from "vitest";
import { createTaskStore, createNullTaskStore } from "../src/db.js";
import { createTestSupabase } from "./helpers/db.js";

const supabase = createTestSupabase();

// All task IDs in this file use the "dbt-" prefix so the beforeEach can
// delete only rows this file owns, without racing against pipeline.test.ts
// which runs in a parallel Vitest worker and writes its own numeric task IDs.
const OWN_IDS = ["dbt-42", "dbt-1", "dbt-2", "dbt-3"];

beforeEach(async () => {
  await supabase.from("tasks").delete().in("task_id", OWN_IDS);
});

/** Filter a listTasks() result to only rows this file owns. */
function own(tasks: { taskId: string }[]) {
  return tasks.filter((t) => t.taskId.startsWith("dbt-"));
}

// ── Tests: createTaskStore ─────────────────────────────────────────────────────

describe("createTaskStore", () => {
  it("upsertTask stores a row with status=pending, body, and labels", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-42", 42, "owner/repo", "Fix the bug", "Issue body", ["bug", "brunel:ready"]);

    const tasks = own(await store.listTasks());
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskId: "dbt-42",
      issueNumber: 42,
      repo: "owner/repo",
      title: "Fix the bug",
      body: "Issue body",
      labels: ["bug", "brunel:ready"],
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
    await store.upsertTask("dbt-42", 42, "owner/repo", "Fix the bug", "", []);
    await expect(store.upsertTask("dbt-42", 42, "owner/repo", "Fix the bug", "", [])).resolves.toBeUndefined();

    const tasks = own(await store.listTasks());
    expect(tasks).toHaveLength(1);
  });

  it("upsertTask on re-label resets an existing row back to pending and refreshes content", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-42", 42, "owner/repo", "Original title", "Original body", ["v1"]);
    await store.markAssigned("dbt-42", "worker-1");
    await store.markComplete("dbt-42");

    // Re-label: upsert should reset to pending and update title/body/labels
    await store.upsertTask("dbt-42", 42, "owner/repo", "New title", "New body", ["v2"]);

    const tasks = own(await store.listTasks());
    expect(tasks[0].title).toBe("New title");
    expect(tasks[0].body).toBe("New body");
    expect(tasks[0].labels).toEqual(["v2"]);
    expect(tasks[0].status).toBe("pending");
    expect(tasks[0].workerId).toBeNull();
    expect(tasks[0].completedAt).toBeNull();
    expect(tasks[0].assignedAt).toBeNull();
  });

  it("markAssigned updates status, worker_id, and sets assigned_at", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-42", 42, "owner/repo", "Fix the bug", "", []);
    await store.markAssigned("dbt-42", "worker-1");

    const tasks = own(await store.listTasks());
    expect(tasks[0].status).toBe("assigned");
    expect(tasks[0].workerId).toBe("worker-1");
    expect(tasks[0].assignedAt).toBeTruthy();
  });

  it("markComplete updates status and sets completed_at", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-42", 42, "owner/repo", "Fix the bug", "", []);
    await store.markAssigned("dbt-42", "worker-1");
    await store.markComplete("dbt-42");

    const tasks = own(await store.listTasks());
    expect(tasks[0].status).toBe("complete");
    expect(tasks[0].completedAt).toBeTruthy();
  });

  it("markPending reverts status to pending and clears worker_id", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-42", 42, "owner/repo", "Fix the bug", "", []);
    await store.markAssigned("dbt-42", "worker-1");
    await store.markPending("dbt-42");

    const tasks = own(await store.listTasks());
    expect(tasks[0].status).toBe("pending");
    expect(tasks[0].workerId).toBeNull();
  });

  it("updateTaskPr stores pr_number and branch", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-42", 42, "owner/repo", "Fix the bug", "", []);
    await store.updateTaskPr("dbt-42", 10, "fix-issue-42");

    const tasks = own(await store.listTasks());
    expect(tasks[0].prNumber).toBe(10);
    expect(tasks[0].branch).toBe("fix-issue-42");
  });

  it("updateTaskPr stores null branch when branch is null", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-42", 42, "owner/repo", "Fix the bug", "", []);
    await store.updateTaskPr("dbt-42", 10, null);

    const tasks = own(await store.listTasks());
    expect(tasks[0].prNumber).toBe(10);
    expect(tasks[0].branch).toBeNull();
  });

  it("listTasks returns rows in descending created_at order", async () => {
    const store = createTaskStore(supabase);
    // Insert with explicit timestamps so order is predictable
    await supabase.from("tasks").insert({
      task_id: "dbt-1", issue_number: 1, repo: "r/r", title: "First",
      status: "pending", created_at: "2026-03-27T01:00:00Z",
    });
    await supabase.from("tasks").insert({
      task_id: "dbt-2", issue_number: 2, repo: "r/r", title: "Second",
      status: "pending", created_at: "2026-03-27T03:00:00Z",
    });
    await supabase.from("tasks").insert({
      task_id: "dbt-3", issue_number: 3, repo: "r/r", title: "Third",
      status: "pending", created_at: "2026-03-27T02:00:00Z",
    });

    const tasks = own(await store.listTasks());
    expect(tasks.map((t) => t.taskId)).toEqual(["dbt-2", "dbt-3", "dbt-1"]);
  });

  it("listTasks returns empty array when no rows", async () => {
    const store = createTaskStore(supabase);
    expect(own(await store.listTasks())).toEqual([]);
  });

  it("listTasks filters by status when provided", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-1", 1, "r/r", "Pending task", "", []);
    await store.upsertTask("dbt-2", 2, "r/r", "Complete task", "", []);
    await store.markAssigned("dbt-2", "w1");
    await store.markComplete("dbt-2");

    const pending = own(await store.listTasks({ status: "pending" }));
    expect(pending).toHaveLength(1);
    expect(pending[0].taskId).toBe("dbt-1");

    const complete = own(await store.listTasks({ status: "complete" }));
    expect(complete).toHaveLength(1);
    expect(complete[0].taskId).toBe("dbt-2");
  });

  it("listTasks returns all statuses when status not provided", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-1", 1, "r/r", "Pending", "", []);
    await store.upsertTask("dbt-2", 2, "r/r", "Assigned", "", []);
    await store.markAssigned("dbt-2", "w1");

    const all = own(await store.listTasks());
    expect(all).toHaveLength(2);
  });

  it("listTasks handles null nullable fields", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-1", 1, "r/r", "T", "", []);

    const tasks = own(await store.listTasks());
    expect(tasks[0].workerId).toBeNull();
    expect(tasks[0].prNumber).toBeNull();
    expect(tasks[0].branch).toBeNull();
    expect(tasks[0].assignedAt).toBeNull();
    expect(tasks[0].completedAt).toBeNull();
  });

  it("listTasks returns body and labels stored by upsertTask", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-1", 1, "r/r", "T", "the body", ["label-a", "label-b"]);

    const tasks = own(await store.listTasks());
    expect(tasks[0].body).toBe("the body");
    expect(tasks[0].labels).toEqual(["label-a", "label-b"]);
  });
});

// ── Tests: createTaskStore — deleteTask ───────────────────────────────────────

describe("createTaskStore — deleteTask", () => {
  it("deletes a never-assigned pending row", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-42", 42, "owner/repo", "Fix", "", []);
    await store.deleteTask("dbt-42");

    expect(own(await store.listTasks())).toHaveLength(0);
  });

  it("does NOT delete a row that was previously assigned (assigned_at is set)", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-42", 42, "owner/repo", "Fix", "", []);
    await store.markAssigned("dbt-42", "worker-1");
    await store.markPending("dbt-42"); // revert (e.g. worker_goodbye) — assigned_at stays set

    await store.deleteTask("dbt-42");

    // Row must still exist because it has history
    const tasks = own(await store.listTasks());
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskId).toBe("dbt-42");
  });

  it("is a no-op when the row does not exist", async () => {
    const store = createTaskStore(supabase);
    await expect(store.deleteTask("dbt-42")).resolves.toBeUndefined();
  });
});

// ── Tests: createTaskStore — blocked status ────────────────────────────────────

describe("createTaskStore — blocked status", () => {
  it("markBlocked sets status to blocked", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-42", 42, "owner/repo", "Fix the bug", "", []);
    await store.markBlocked("dbt-42");

    const task = own(await store.listTasks()).find((t) => t.taskId === "dbt-42")!;
    expect(task.status).toBe("blocked");
    expect(task.workerId).toBeNull();
  });

  it("listTasks filters by status=blocked", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-1", 1, "r/r", "Pending", "", []);
    await store.upsertTask("dbt-2", 2, "r/r", "Blocked", "", []);
    await store.markBlocked("dbt-2");

    const blocked = own(await store.listTasks({ status: "blocked" }));
    expect(blocked).toHaveLength(1);
    expect(blocked[0].taskId).toBe("dbt-2");
  });

  it("listTasks returns blocked tasks when no filter", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-1", 1, "r/r", "Pending", "", []);
    await store.upsertTask("dbt-2", 2, "r/r", "Blocked", "", []);
    await store.markBlocked("dbt-2");

    const all = own(await store.listTasks());
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.status)).toEqual(expect.arrayContaining(["pending", "blocked"]));
  });
});

// ── Tests: createNullTaskStore ─────────────────────────────────────────────────

describe("createNullTaskStore", () => {
  it("upsertTask resolves without error", async () => {
    const store = createNullTaskStore();
    await expect(store.upsertTask("dbt-42", 42, "r/r", "title", "", [])).resolves.toBeUndefined();
  });

  it("markAssigned resolves without error", async () => {
    const store = createNullTaskStore();
    await expect(store.markAssigned("dbt-42", "w1")).resolves.toBeUndefined();
  });

  it("markComplete resolves without error", async () => {
    const store = createNullTaskStore();
    await expect(store.markComplete("dbt-42")).resolves.toBeUndefined();
  });

  it("markPending resolves without error", async () => {
    const store = createNullTaskStore();
    await expect(store.markPending("dbt-42")).resolves.toBeUndefined();
  });

  it("markBlocked resolves without error", async () => {
    const store = createNullTaskStore();
    await expect(store.markBlocked("dbt-42")).resolves.toBeUndefined();
  });

  it("updateTaskPr resolves without error", async () => {
    const store = createNullTaskStore();
    await expect(store.updateTaskPr("dbt-42", 10, "fix")).resolves.toBeUndefined();
  });

  it("deleteTask resolves without error", async () => {
    const store = createNullTaskStore();
    await expect(store.deleteTask("dbt-42")).resolves.toBeUndefined();
  });

  it("listTasks returns empty array", async () => {
    const store = createNullTaskStore();
    expect(await store.listTasks()).toEqual([]);
  });
});
