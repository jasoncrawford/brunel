import { describe, it, expect, vi } from "vitest";
import { createTaskAssignmentStore, createNullTaskAssignmentStore } from "../src/db.js";

// ── Fake Supabase builder ──────────────────────────────────────────────────────

function makeSupabase(seedRows: Record<string, unknown>[] = []) {
  const rows = [...seedRows];

  const upsertFn = vi.fn().mockResolvedValue({ error: null });
  const updateFn = vi.fn().mockReturnThis();
  const deleteFn = vi.fn().mockReturnThis();
  const eqFn = vi.fn().mockResolvedValue({ error: null });
  const selectFn = vi.fn().mockReturnThis();
  const thenFn = vi.fn().mockImplementation(
    (cb: (v: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve(cb({ data: rows, error: null }))
  );

  const supabase = {
    from: vi.fn().mockReturnValue({
      upsert: upsertFn,
      update: updateFn,
      delete: deleteFn,
      eq: eqFn,
      select: selectFn,
      then: thenFn,
    }),
    _upsertFn: upsertFn,
    _updateFn: updateFn,
    _deleteFn: deleteFn,
    _eqFn: eqFn,
    _selectFn: selectFn,
  };
  return supabase;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("createTaskAssignmentStore", () => {
  it("upsertAssignment calls supabase upsert on task_assignments", async () => {
    const sb = makeSupabase();
    const store = createTaskAssignmentStore(sb as never);
    await store.upsertAssignment("42", "worker-1");
    expect(sb.from).toHaveBeenCalledWith("task_assignments");
    expect(sb._upsertFn).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: "42", worker_id: "worker-1" }),
      expect.objectContaining({ onConflict: "task_id" }),
    );
  });

  it("upsertAssignment throws if supabase returns an error", async () => {
    const sb = makeSupabase();
    sb._upsertFn.mockResolvedValue({ error: new Error("db down") });
    const store = createTaskAssignmentStore(sb as never);
    await expect(store.upsertAssignment("42", "w1")).rejects.toThrow("db down");
  });

  it("updatePr calls supabase update with pr_number and branch", async () => {
    const sb = makeSupabase();
    const store = createTaskAssignmentStore(sb as never);
    await store.updatePr("42", 10, "fix-issue-42");
    expect(sb.from).toHaveBeenCalledWith("task_assignments");
    expect(sb._updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ pr_number: 10, branch: "fix-issue-42" }),
    );
  });

  it("updatePr passes null branch when branch is null", async () => {
    const sb = makeSupabase();
    const store = createTaskAssignmentStore(sb as never);
    await store.updatePr("42", 10, null);
    expect(sb._updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ pr_number: 10, branch: null }),
    );
  });

  it("deleteAssignment calls supabase delete filtered by task_id", async () => {
    const sb = makeSupabase();
    const store = createTaskAssignmentStore(sb as never);
    await store.deleteAssignment("42");
    expect(sb.from).toHaveBeenCalledWith("task_assignments");
    expect(sb._deleteFn).toHaveBeenCalled();
    expect(sb._eqFn).toHaveBeenCalledWith("task_id", "42");
  });

  it("listAssignments returns mapped rows", async () => {
    const sb = makeSupabase([
      { task_id: "42", worker_id: "w1", pr_number: 10, branch: "fix-42" },
    ]);
    const store = createTaskAssignmentStore(sb as never);
    const rows = await store.listAssignments();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ taskId: "42", workerId: "w1", prNumber: 10, branch: "fix-42" });
  });

  it("listAssignments handles null pr_number and branch", async () => {
    const sb = makeSupabase([
      { task_id: "42", worker_id: "w1", pr_number: null, branch: null },
    ]);
    const store = createTaskAssignmentStore(sb as never);
    const rows = await store.listAssignments();
    expect(rows[0]).toEqual({ taskId: "42", workerId: "w1", prNumber: null, branch: null });
  });

  it("listAssignments returns empty array when no rows", async () => {
    const sb = makeSupabase([]);
    const store = createTaskAssignmentStore(sb as never);
    expect(await store.listAssignments()).toEqual([]);
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
