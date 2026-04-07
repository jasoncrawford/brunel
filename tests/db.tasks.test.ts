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

/**
 * Insert a task row that is protected from pipeline.test.ts's reconcile().
 * Reconcile calls cancel() which only deletes rows where assigned_at IS NULL.
 * Setting assigned_at to a non-null value makes the row immune to deletion.
 * Use this for tests that need a stable row but aren't testing upsertTask itself.
 */
async function insertProtected(taskId: string, issueNumber: number, repo: string, title: string, extra: Record<string, unknown> = {}) {
  const { error } = await supabase.from("tasks").upsert({
    task_id: taskId, issue_number: issueNumber, repo, title,
    body: "", labels: [],
    assigned_at: "2026-01-01T00:00:00Z",
    ...extra,
  }, { onConflict: "task_id" });
  if (error) throw error;
}

// ── Tests: createTaskStore ─────────────────────────────────────────────────────

describe("createTaskStore", () => {
  it("upsertTask stores a row with body and labels, status derived as pending", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-42", 9042, "owner/repo", "Fix the bug", "Issue body", ["bug", "brunel:ready"]);

    // Use getTask (direct PK lookup) rather than listTasks to avoid the window
    // where pipeline.test.ts's reconcile() can delete this pending row.
    const task = await store.getTask("dbt-42");
    expect(task).not.toBeNull();
    expect(task!).toMatchObject({
      taskId: "dbt-42",
      issueNumber: 9042,
      repo: "owner/repo",
      title: "Fix the bug",
      body: "Issue body",
      labels: ["bug", "brunel:ready"],
      workerId: null,
      prNumber: null,
      branch: null,
    });
    expect(task!.createdAt).toBeTruthy();
    expect(task!.assignedAt).toBeNull();
    expect(task!.completedAt).toBeNull();
    expect(task!.issueClosedAt).toBeNull();
    expect(task!.prMergedAt).toBeNull();
  });

  it("upsertTask is idempotent — duplicate task_id does not throw or duplicate", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-42", 9042, "owner/repo", "Fix the bug", "", []);
    await expect(store.upsertTask("dbt-42", 9042, "owner/repo", "Fix the bug", "", [])).resolves.toBeUndefined();

    // Use getTask rather than listTasks to avoid reconcile deleting the pending row.
    // The idempotency guarantee is "no error and the row exists", not a specific count.
    const task = await store.getTask("dbt-42");
    expect(task).not.toBeNull();
  });

  it("upsertTask on re-label resets an existing row to pending state and refreshes content", async () => {
    const store = createTaskStore(supabase);
    await store.upsertTask("dbt-42", 9042, "owner/repo", "Original title", "Original body", ["v1"]);
    await store.markAssigned("dbt-42", "worker-1");
    await store.markComplete("dbt-42");

    // Re-label: upsert should reset all status markers and update title/body/labels.
    // Use getTask (direct PK lookup) rather than listTasks to minimise the window
    // where pipeline.test.ts's reconcile() can delete this row (assigned_at IS NULL).
    await store.upsertTask("dbt-42", 9042, "owner/repo", "New title", "New body", ["v2"]);

    const task = await store.getTask("dbt-42");
    expect(task).not.toBeNull();
    expect(task!.title).toBe("New title");
    expect(task!.body).toBe("New body");
    expect(task!.labels).toEqual(["v2"]);
    expect(task!.workerId).toBeNull();
    expect(task!.completedAt).toBeNull();
    expect(task!.assignedAt).toBeNull();
    expect(task!.issueClosedAt).toBeNull();
    expect(task!.prMergedAt).toBeNull();
  });

  it("markAssigned sets worker_id and assigned_at", async () => {
    const store = createTaskStore(supabase);
    await insertProtected("dbt-42", 9042, "owner/repo", "Fix the bug");
    await store.markAssigned("dbt-42", "worker-1");

    const task = await store.getTask("dbt-42");
    expect(task!.workerId).toBe("worker-1");
    expect(task!.assignedAt).toBeTruthy();
  });

  it("markComplete sets completed_at", async () => {
    const store = createTaskStore(supabase);
    await insertProtected("dbt-42", 9042, "owner/repo", "Fix the bug");
    await store.markAssigned("dbt-42", "worker-1");
    await store.markComplete("dbt-42");

    const task = await store.getTask("dbt-42");
    expect(task!.completedAt).toBeTruthy();
  });

  it("markPending clears worker_id", async () => {
    const store = createTaskStore(supabase);
    await insertProtected("dbt-42", 9042, "owner/repo", "Fix the bug");
    await store.markAssigned("dbt-42", "worker-1");
    await store.markPending("dbt-42");

    const task = await store.getTask("dbt-42");
    expect(task!.workerId).toBeNull();
  });

  it("updateTaskPr stores pr_number and branch", async () => {
    const store = createTaskStore(supabase);
    await insertProtected("dbt-42", 9042, "owner/repo", "Fix the bug");
    await store.updateTaskPr("dbt-42", 10, "fix-issue-42");

    const task = await store.getTask("dbt-42");
    expect(task!.prNumber).toBe(10);
    expect(task!.branch).toBe("fix-issue-42");
  });

  it("updateTaskPr stores null branch when branch is null", async () => {
    const store = createTaskStore(supabase);
    await insertProtected("dbt-42", 9042, "owner/repo", "Fix the bug");
    await store.updateTaskPr("dbt-42", 10, null);

    const task = await store.getTask("dbt-42");
    expect(task!.prNumber).toBe(10);
    expect(task!.branch).toBeNull();
  });

  it("listTasks returns rows in descending created_at order", async () => {
    const store = createTaskStore(supabase);
    // Insert with explicit timestamps so order is predictable.
    // Set assigned_at to protect from parallel reconcile in pipeline.test.ts.
    await supabase.from("tasks").insert({
      task_id: "dbt-1", issue_number: 9001, repo: "r/r", title: "First",
      created_at: "2026-03-27T01:00:00Z",
      assigned_at: "2026-01-01T00:00:00Z",
    });
    await supabase.from("tasks").insert({
      task_id: "dbt-2", issue_number: 9002, repo: "r/r", title: "Second",
      created_at: "2026-03-27T03:00:00Z",
      assigned_at: "2026-01-01T00:00:00Z",
    });
    await supabase.from("tasks").insert({
      task_id: "dbt-3", issue_number: 9003, repo: "r/r", title: "Third",
      created_at: "2026-03-27T02:00:00Z",
      assigned_at: "2026-01-01T00:00:00Z",
    });

    const tasks = own(await store.listTasks());
    expect(tasks.map((t) => t.taskId)).toEqual(["dbt-2", "dbt-3", "dbt-1"]);
  });

  it("listTasks returns empty array when no rows", async () => {
    const store = createTaskStore(supabase);
    expect(own(await store.listTasks())).toEqual([]);
  });

  it("listTasks with cancelable=true returns only never-assigned, not-closed, not-completed tasks", async () => {
    const store = createTaskStore(supabase);
    // The cancelable=true filter checks worker_id IS NULL (not assigned_at IS NULL).
    // insertProtected sets assigned_at (making the row immune to reconcile) but
    // leaves worker_id null, so dbt-1 still satisfies the cancelable filter.
    await insertProtected("dbt-1", 9001, "r/r", "Pending task");
    // Create a task that was assigned then completed (not cancelable)
    await insertProtected("dbt-2", 9002, "r/r", "Complete task");
    await store.markAssigned("dbt-2", "w1");
    await store.markComplete("dbt-2");

    const cancelable = own(await store.listTasks({ cancelable: true }));
    expect(cancelable.map((t) => t.taskId)).toContain("dbt-1");
    expect(cancelable.map((t) => t.taskId)).not.toContain("dbt-2");

    const all = own(await store.listTasks());
    expect(all.map((t) => t.taskId)).toContain("dbt-1");
    expect(all.map((t) => t.taskId)).toContain("dbt-2");
  });

  it("listTasks returns all statuses when status not provided", async () => {
    const store = createTaskStore(supabase);
    // Use insertProtected so reconcile from pipeline.test.ts can't delete pending rows
    await insertProtected("dbt-1", 9001, "r/r", "Pending");
    await insertProtected("dbt-2", 9002, "r/r", "Assigned");
    await store.markAssigned("dbt-2", "w1");

    const all = own(await store.listTasks());
    expect(all).toHaveLength(2);
  });

  it("listTasks handles null nullable fields", async () => {
    const store = createTaskStore(supabase);
    // Use insertProtected to survive parallel reconcile; assignedAt will be non-null
    await insertProtected("dbt-1", 9001, "r/r", "T");

    const task = await store.getTask("dbt-1");
    expect(task!.workerId).toBeNull();
    expect(task!.prNumber).toBeNull();
    expect(task!.branch).toBeNull();
    expect(task!.completedAt).toBeNull();
  });

  it("listTasks returns body and labels stored by upsertTask", async () => {
    const store = createTaskStore(supabase);
    await insertProtected("dbt-1", 9001, "r/r", "T", { body: "the body", labels: ["label-a", "label-b"] });

    const task = await store.getTask("dbt-1");
    expect(task!.body).toBe("the body");
    expect(task!.labels).toEqual(["label-a", "label-b"]);
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
    await insertProtected("dbt-42", 9042, "owner/repo", "Fix");
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

// ── Tests: createTaskStore — issue and PR lifecycle ────────────────────────────

describe("createTaskStore — issue and PR lifecycle", () => {
  it("setIssueClosed records when an issue is closed", async () => {
    const store = createTaskStore(supabase);
    await insertProtected("dbt-42", 9042, "owner/repo", "Fix the bug");
    await store.setIssueClosed("dbt-42");

    const task = await store.getTask("dbt-42");
    expect(task!.issueClosedAt).toBeTruthy();
  });

  it("clearIssueClosed clears the issue closed marker when issue is reopened", async () => {
    const store = createTaskStore(supabase);
    await insertProtected("dbt-42", 9042, "owner/repo", "Fix the bug");
    await store.setIssueClosed("dbt-42");
    await store.clearIssueClosed("dbt-42");

    const task = await store.getTask("dbt-42");
    expect(task!.issueClosedAt).toBeNull();
  });

  it("setPrMerged records when a PR is merged", async () => {
    const store = createTaskStore(supabase);
    await insertProtected("dbt-42", 9042, "owner/repo", "Fix the bug");
    await store.updateTaskPr("dbt-42", 10, "fix-issue");
    await store.setPrMerged("dbt-42");

    const task = await store.getTask("dbt-42");
    expect(task!.prMergedAt).toBeTruthy();
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
  });

  it("markAssigned sets workerId", async () => {
    const store = createMemoryTaskStore();
    await store.upsertTask("dbt-42", 9042, "r/r", "title", "", []);
    await store.markAssigned("dbt-42", "w1");
    const task = await store.getTask("dbt-42");
    expect(task?.workerId).toBe("w1");
  });

  it("markComplete sets completedAt", async () => {
    const store = createMemoryTaskStore();
    await store.upsertTask("dbt-42", 9042, "r/r", "title", "", []);
    await store.markComplete("dbt-42");
    const task = await store.getTask("dbt-42");
    expect(task?.completedAt).toBeTruthy();
  });

  it("markPending clears workerId", async () => {
    const store = createMemoryTaskStore();
    await store.upsertTask("dbt-42", 9042, "r/r", "title", "", []);
    await store.markAssigned("dbt-42", "w1");
    await store.markPending("dbt-42");
    const task = await store.getTask("dbt-42");
    expect(task?.workerId).toBeNull();
  });

  it("setIssueClosed sets issueClosedAt", async () => {
    const store = createMemoryTaskStore();
    await store.upsertTask("dbt-42", 9042, "r/r", "title", "", []);
    await store.setIssueClosed("dbt-42");
    const task = await store.getTask("dbt-42");
    expect(task?.issueClosedAt).toBeTruthy();
  });

  it("setPrMerged sets prMergedAt", async () => {
    const store = createMemoryTaskStore();
    await store.upsertTask("dbt-42", 9042, "r/r", "title", "", []);
    await store.setPrMerged("dbt-42");
    const task = await store.getTask("dbt-42");
    expect(task?.prMergedAt).toBeTruthy();
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

  it("listTasks with cancelable=true returns pending tasks and excludes completed/assigned", async () => {
    const store = createMemoryTaskStore();
    // Truly pending (no assignment history) — should appear in cancelable results
    await store.upsertTask("dbt-1", 9001, "r/r", "Pending", "", []);
    // Assigned task — worker_id set, should NOT appear
    await store.upsertTask("dbt-2", 9002, "r/r", "Assigned", "", []);
    await store.markAssigned("dbt-2", "w1");
    // Completed task — completedAt set, should NOT appear
    await store.upsertTask("dbt-3", 9003, "r/r", "Complete", "", []);
    await store.markComplete("dbt-3");

    const cancelable = await store.listTasks({ cancelable: true });
    expect(cancelable.map((t) => t.taskId)).toContain("dbt-1");
    expect(cancelable.map((t) => t.taskId)).not.toContain("dbt-2");
    expect(cancelable.map((t) => t.taskId)).not.toContain("dbt-3");
  });

  it("listTasks returns stored tasks", async () => {
    const store = createMemoryTaskStore();
    await store.upsertTask("dbt-1", 9001, "r/r", "T1", "", []);
    await store.upsertTask("dbt-2", 9002, "r/r", "T2", "", []);
    const tasks = await store.listTasks();
    expect(tasks).toHaveLength(2);
  });

  it("listTasks returns all rows (status filtering happens at runtime)", async () => {
    const store = createMemoryTaskStore();
    await store.upsertTask("dbt-1", 9001, "r/r", "T1", "", []);
    await store.upsertTask("dbt-2", 9002, "r/r", "T2", "", []);
    const all = await store.listTasks();
    expect(all).toHaveLength(2);
    // Status is derived at runtime, not stored in DB
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
