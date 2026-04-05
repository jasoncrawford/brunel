import { describe, it, expect, beforeEach } from "vitest";
import { createTaskStore, createMemoryTaskStore } from "../src/foreman/db.js";
import { createTestSupabase } from "./helpers/db.js";

const supabase = createTestSupabase();

// All task IDs in this file use the "dbt-" prefix and issue numbers in the
// 9000 range so we don't collide with pipeline.test.ts (which uses issue
// numbers 42, 55, 70, 80, 91, 92, 100) running in a parallel Vitest worker.
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
    await store.upsertTask("dbt-42", 9042, "owner/repo", "Fix the bug", "Issue body", ["bug", "brunel:ready"]);

    const tasks = own(await store.listTasks());
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskId: "dbt-42",
      issueNumber: 9042,
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
    await store.upsertTask("dbt-42", 9042, "owner/repo", "Fix the bug", "", []);
    await expect(store.upsertTask("dbt-42", 42, "owner/repo", "Fix the bug", "", [])).resolves.toBeUndefined();

    const tasks = own(await store.listTasks());
    expect(tasks).toHaveLength(1);
  });

  it("upsertTask on re-label resets an existing row back to pending and refreshes content", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-42", 9042, "owner/repo", "Original title", "Original body", ["v1"]);
    await store.markAssigned("dbt-42", "worker-1");
    await store.markComplete("dbt-42");

    // Re-label: upsert should reset to pending and update title/body/labels
    await store.upsertTask("dbt-42", 9042, "owner/repo", "New title", "New body", ["v2"]);

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
    await store.upsertTask("dbt-42", 9042, "owner/repo", "Fix the bug", "", []);
    await store.markAssigned("dbt-42", "worker-1");

    const tasks = own(await store.listTasks());
    expect(tasks[0].status).toBe("assigned");
    expect(tasks[0].workerId).toBe("worker-1");
    expect(tasks[0].assignedAt).toBeTruthy();
  });

  it("markComplete updates status and sets completed_at", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-42", 9042, "owner/repo", "Fix the bug", "", []);
    await store.markAssigned("dbt-42", "worker-1");
    await store.markComplete("dbt-42");

    const tasks = own(await store.listTasks());
    expect(tasks[0].status).toBe("complete");
    expect(tasks[0].completedAt).toBeTruthy();
  });

  it("markPending reverts status to pending and clears worker_id", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-42", 9042, "owner/repo", "Fix the bug", "", []);
    await store.markAssigned("dbt-42", "worker-1");
    await store.markPending("dbt-42");

    const tasks = own(await store.listTasks());
    expect(tasks[0].status).toBe("pending");
    expect(tasks[0].workerId).toBeNull();
  });

  it("updateTaskPr stores pr_number and branch", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-42", 9042, "owner/repo", "Fix the bug", "", []);
    await store.updateTaskPr("dbt-42", 10, "fix-issue-42");

    const tasks = own(await store.listTasks());
    expect(tasks[0].prNumber).toBe(10);
    expect(tasks[0].branch).toBe("fix-issue-42");
  });

  it("updateTaskPr stores null branch when branch is null", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-42", 9042, "owner/repo", "Fix the bug", "", []);
    await store.updateTaskPr("dbt-42", 10, null);

    const tasks = own(await store.listTasks());
    expect(tasks[0].prNumber).toBe(10);
    expect(tasks[0].branch).toBeNull();
  });

  it("listTasks returns rows in descending created_at order", async () => {
    const store = createTaskStore(supabase);
    // Insert with explicit timestamps so order is predictable
    await supabase.from("tasks").insert({
      task_id: "dbt-1", issue_number: 9001, repo: "r/r", title: "First",
      status: "pending", created_at: "2026-03-27T01:00:00Z",
    });
    await supabase.from("tasks").insert({
      task_id: "dbt-2", issue_number: 9002, repo: "r/r", title: "Second",
      status: "pending", created_at: "2026-03-27T03:00:00Z",
    });
    await supabase.from("tasks").insert({
      task_id: "dbt-3", issue_number: 9003, repo: "r/r", title: "Third",
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
    await store.upsertTask("dbt-1", 9001, "r/r", "Pending task", "", []);
    await store.upsertTask("dbt-2", 9002, "r/r", "Complete task", "", []);
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
    await store.upsertTask("dbt-1", 9001, "r/r", "Pending", "", []);
    await store.upsertTask("dbt-2", 9002, "r/r", "Assigned", "", []);
    await store.markAssigned("dbt-2", "w1");

    const all = own(await store.listTasks());
    expect(all).toHaveLength(2);
  });

  it("listTasks handles null nullable fields", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-1", 9001, "r/r", "T", "", []);

    const tasks = own(await store.listTasks());
    expect(tasks[0].workerId).toBeNull();
    expect(tasks[0].prNumber).toBeNull();
    expect(tasks[0].branch).toBeNull();
    expect(tasks[0].assignedAt).toBeNull();
    expect(tasks[0].completedAt).toBeNull();
  });

  it("listTasks returns body and labels stored by upsertTask", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-1", 9001, "r/r", "T", "the body", ["label-a", "label-b"]);

    const tasks = own(await store.listTasks());
    expect(tasks[0].body).toBe("the body");
    expect(tasks[0].labels).toEqual(["label-a", "label-b"]);
  });
});

// ── Tests: createTaskStore — deleteTask ───────────────────────────────────────

describe("createTaskStore — deleteTask", () => {
  it("deletes a never-assigned pending row", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-42", 9042, "owner/repo", "Fix", "", []);
    await store.deleteTask("dbt-42");

    expect(own(await store.listTasks())).toHaveLength(0);
  });

  it("does NOT delete a row that was previously assigned (assigned_at is set)", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-42", 9042, "owner/repo", "Fix", "", []);
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
    await store.upsertTask("dbt-42", 9042, "owner/repo", "Fix the bug", "", []);
    await store.markBlocked("dbt-42");

    const task = own(await store.listTasks()).find((t) => t.taskId === "dbt-42")!;
    expect(task.status).toBe("blocked");
    expect(task.workerId).toBeNull();
  });

  it("listTasks filters by status=blocked", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-1", 9001, "r/r", "Pending", "", []);
    await store.upsertTask("dbt-2", 9002, "r/r", "Blocked", "", []);
    await store.markBlocked("dbt-2");

    const blocked = own(await store.listTasks({ status: "blocked" }));
    expect(blocked).toHaveLength(1);
    expect(blocked[0].taskId).toBe("dbt-2");
  });

  it("listTasks returns blocked tasks when no filter", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-1", 9001, "r/r", "Pending", "", []);
    await store.upsertTask("dbt-2", 9002, "r/r", "Blocked", "", []);
    await store.markBlocked("dbt-2");

    const all = own(await store.listTasks());
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.status)).toEqual(expect.arrayContaining(["pending", "blocked"]));
  });
});

// ── Tests: createMemoryTaskStore ───────────────────────────────────────────────

describe("createMemoryTaskStore", () => {
  it("upsertTask stores a task that can be retrieved", async () => {
    const store = createMemoryTaskStore();
    await store.upsertTask("dbt-42", 9042, "r/r", "title", "", []);
    const task = await store.getTask("dbt-42");
    expect(task).not.toBeNull();
    expect(task?.taskId).toBe("dbt-42");
    expect(task?.status).toBe("pending");
  });

  it("markAssigned updates status and workerId", async () => {
    const store = createMemoryTaskStore();
    await store.upsertTask("dbt-42", 9042, "r/r", "title", "", []);
    await store.markAssigned("dbt-42", "w1");
    const task = await store.getTask("dbt-42");
    expect(task?.status).toBe("assigned");
    expect(task?.workerId).toBe("w1");
  });

  it("markComplete updates status", async () => {
    const store = createMemoryTaskStore();
    await store.upsertTask("dbt-42", 9042, "r/r", "title", "", []);
    await store.markComplete("dbt-42");
    const task = await store.getTask("dbt-42");
    expect(task?.status).toBe("complete");
  });

  it("markPending reverts status and clears workerId", async () => {
    const store = createMemoryTaskStore();
    await store.upsertTask("dbt-42", 9042, "r/r", "title", "", []);
    await store.markAssigned("dbt-42", "w1");
    await store.markPending("dbt-42");
    const task = await store.getTask("dbt-42");
    expect(task?.status).toBe("pending");
    expect(task?.workerId).toBeNull();
  });

  it("markBlocked updates status", async () => {
    const store = createMemoryTaskStore();
    await store.upsertTask("dbt-42", 9042, "r/r", "title", "", []);
    await store.markBlocked("dbt-42");
    const task = await store.getTask("dbt-42");
    expect(task?.status).toBe("blocked");
  });

  it("updateTaskPr stores prNumber and branch", async () => {
    const store = createMemoryTaskStore();
    await store.upsertTask("dbt-42", 9042, "r/r", "title", "", []);
    await store.updateTaskPr("dbt-42", 10, "fix");
    const task = await store.getTask("dbt-42");
    expect(task?.prNumber).toBe(10);
    expect(task?.branch).toBe("fix");
  });

  it("deleteTask removes a never-assigned task", async () => {
    const store = createMemoryTaskStore();
    await store.upsertTask("dbt-42", 9042, "r/r", "title", "", []);
    await store.deleteTask("dbt-42");
    expect(await store.getTask("dbt-42")).toBeNull();
  });

  it("deleteTask preserves a previously-assigned task", async () => {
    const store = createMemoryTaskStore();
    await store.upsertTask("dbt-42", 9042, "r/r", "title", "", []);
    await store.markAssigned("dbt-42", "w1");
    await store.markPending("dbt-42");
    await store.deleteTask("dbt-42");
    // Row must still exist because it has history (assignedAt is set)
    expect(await store.getTask("dbt-42")).not.toBeNull();
  });

  it("listTasks returns stored tasks", async () => {
    const store = createMemoryTaskStore();
    await store.upsertTask("dbt-1", 9001, "r/r", "T1", "", []);
    await store.upsertTask("dbt-2", 9002, "r/r", "T2", "", []);
    const tasks = await store.listTasks();
    expect(tasks).toHaveLength(2);
  });

  it("listTasks filters by status", async () => {
    const store = createMemoryTaskStore();
    await store.upsertTask("dbt-1", 9001, "r/r", "T1", "", []);
    await store.upsertTask("dbt-2", 9002, "r/r", "T2", "", []);
    await store.markBlocked("dbt-2");
    const pending = await store.listTasks({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].taskId).toBe("dbt-1");
  });

  it("getTaskByIssue finds task by issue number", async () => {
    const store = createMemoryTaskStore();
    await store.upsertTask("dbt-42", 9042, "r/r", "title", "", []);
    const task = await store.getTaskByIssue(9042);
    expect(task?.taskId).toBe("dbt-42");
  });

  it("getTaskByPr finds task by PR number", async () => {
    const store = createMemoryTaskStore();
    await store.upsertTask("dbt-42", 9042, "r/r", "title", "", []);
    await store.updateTaskPr("dbt-42", 10, "fix");
    const task = await store.getTaskByPr(10);
    expect(task?.taskId).toBe("dbt-42");
  });

  it("getTaskByWorker finds assigned task for worker", async () => {
    const store = createMemoryTaskStore();
    await store.upsertTask("dbt-42", 9042, "r/r", "title", "", []);
    await store.markAssigned("dbt-42", "w1");
    const task = await store.getTaskByWorker("w1");
    expect(task?.taskId).toBe("dbt-42");
  });
});
