import { describe, it, expect, beforeEach } from "vitest";
import { createTaskAssignmentStore, createNullTaskAssignmentStore } from "../src/db.js";
import { createTestSupabase, truncateTables } from "./helpers/db.js";

const supabase = createTestSupabase();

beforeEach(async () => {
  await truncateTables(supabase);
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("createTaskAssignmentStore", () => {
  it("upsertAssignment stores a row in task_assignments", async () => {
    const store = createTaskAssignmentStore(supabase);
    await store.upsertAssignment("42", "worker-1");

    const assignments = await store.listAssignments();
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      taskId: "42",
      workerId: "worker-1",
      prNumber: null,
      branch: null,
    });
  });

  it("upsertAssignment replaces an existing row for the same task_id (on conflict)", async () => {
    const store = createTaskAssignmentStore(supabase);
    await store.upsertAssignment("42", "worker-1");
    await store.upsertAssignment("42", "worker-2");

    const assignments = await store.listAssignments();
    expect(assignments).toHaveLength(1);
    expect(assignments[0].workerId).toBe("worker-2");
  });

  it("updatePr stores pr_number and branch for the task", async () => {
    const store = createTaskAssignmentStore(supabase);
    await store.upsertAssignment("42", "worker-1");
    await store.updatePr("42", 10, "fix-issue-42");

    const assignments = await store.listAssignments();
    expect(assignments[0].prNumber).toBe(10);
    expect(assignments[0].branch).toBe("fix-issue-42");
  });

  it("updatePr stores null branch when branch is null", async () => {
    const store = createTaskAssignmentStore(supabase);
    await store.upsertAssignment("42", "worker-1");
    await store.updatePr("42", 10, null);

    const assignments = await store.listAssignments();
    expect(assignments[0].prNumber).toBe(10);
    expect(assignments[0].branch).toBeNull();
  });

  it("deleteAssignment removes the row from task_assignments", async () => {
    const store = createTaskAssignmentStore(supabase);
    await store.upsertAssignment("42", "worker-1");
    await store.upsertAssignment("99", "worker-2");
    await store.deleteAssignment("42");

    const assignments = await store.listAssignments();
    expect(assignments).toHaveLength(1);
    expect(assignments[0].taskId).toBe("99");
  });

  it("listAssignments returns mapped rows", async () => {
    const store = createTaskAssignmentStore(supabase);
    await store.upsertAssignment("42", "w1");
    await store.updatePr("42", 10, "fix-42");

    const rows = await store.listAssignments();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ taskId: "42", workerId: "w1", prNumber: 10, branch: "fix-42" });
  });

  it("listAssignments handles null pr_number and branch", async () => {
    const store = createTaskAssignmentStore(supabase);
    await store.upsertAssignment("42", "w1");

    const rows = await store.listAssignments();
    expect(rows[0]).toEqual({ taskId: "42", workerId: "w1", prNumber: null, branch: null });
  });

  it("listAssignments returns empty array when no rows", async () => {
    const store = createTaskAssignmentStore(supabase);
    expect(await store.listAssignments()).toEqual([]);
  });

  it("listAssignments returns multiple rows", async () => {
    const store = createTaskAssignmentStore(supabase);
    await store.upsertAssignment("1", "worker-a");
    await store.upsertAssignment("2", "worker-b");

    const rows = await store.listAssignments();
    expect(rows).toHaveLength(2);
    const taskIds = rows.map((r) => r.taskId).sort();
    expect(taskIds).toEqual(["1", "2"]);
  });
});

describe("createNullTaskAssignmentStore", () => {
  it("upsertAssignment resolves without error", async () => {
    const store = createNullTaskAssignmentStore();
    await expect(store.upsertAssignment("42", "w1")).resolves.toBeUndefined();
  });

  it("deleteAssignment resolves without error", async () => {
    const store = createNullTaskAssignmentStore();
    await expect(store.deleteAssignment("42")).resolves.toBeUndefined();
  });

  it("updatePr resolves without error", async () => {
    const store = createNullTaskAssignmentStore();
    await expect(store.updatePr("42", 10, "fix")).resolves.toBeUndefined();
  });

  it("listAssignments returns empty array", async () => {
    const store = createNullTaskAssignmentStore();
    expect(await store.listAssignments()).toEqual([]);
  });
});
