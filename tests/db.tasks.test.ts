import { describe, it, expect, vi } from "vitest";
import { createTaskStore, createNullTaskStore } from "../src/db.js";

// ── Fake Supabase builder ──────────────────────────────────────────────────────

function makeSupabase(seedRows: Record<string, unknown>[] = []) {
  const rows = [...seedRows];

  const upsertFn = vi.fn().mockReturnThis();
  const updateFn = vi.fn().mockReturnThis();
  const selectFn = vi.fn().mockReturnThis();
  const orderFn = vi.fn().mockReturnThis();
  const limitFn = vi.fn().mockReturnThis();
  const eqFn = vi.fn().mockReturnThis();
  const thenFn = vi.fn().mockImplementation(
    (cb: (v: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve(cb({ data: rows, error: null }))
  );

  const builder = {
    upsert: upsertFn,
    update: updateFn,
    select: selectFn,
    order: orderFn,
    limit: limitFn,
    eq: eqFn,
    then: thenFn,
  };

  const supabase = {
    from: vi.fn().mockReturnValue(builder),
    _upsertFn: upsertFn,
    _updateFn: updateFn,
    _selectFn: selectFn,
    _orderFn: orderFn,
    _limitFn: limitFn,
    _eqFn: eqFn,
    _thenFn: thenFn,
  };
  return supabase;
}

// ── Tests: createTaskStore ─────────────────────────────────────────────────────

describe("createTaskStore", () => {
  it("upsertTask calls supabase upsert on tasks table", async () => {
    const sb = makeSupabase();
    const store = createTaskStore(sb as never);
    await store.upsertTask("42", 42, "owner/repo", "Fix the bug");
    expect(sb.from).toHaveBeenCalledWith("tasks");
    expect(sb._upsertFn).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: "42",
        issue_number: 42,
        repo: "owner/repo",
        title: "Fix the bug",
        status: "pending",
      }),
      expect.objectContaining({ onConflict: "task_id", ignoreDuplicates: false }),
    );
  });

  it("upsertTask throws if supabase returns an error", async () => {
    const sb = makeSupabase();
    sb._thenFn.mockImplementationOnce(
      (cb: (v: { data: null; error: Error }) => unknown) =>
        Promise.resolve(cb({ data: null, error: new Error("db down") }))
    );
    const store = createTaskStore(sb as never);
    await expect(store.upsertTask("42", 42, "owner/repo", "title")).rejects.toThrow("db down");
  });

  it("markAssigned updates status, worker_id, and assigned_at", async () => {
    const sb = makeSupabase();
    const store = createTaskStore(sb as never);
    await store.markAssigned("42", "worker-1");
    expect(sb.from).toHaveBeenCalledWith("tasks");
    expect(sb._updateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "assigned",
        worker_id: "worker-1",
        assigned_at: expect.any(String),
      }),
    );
    expect(sb._eqFn).toHaveBeenCalledWith("task_id", "42");
  });

  it("markAssigned throws if supabase returns an error", async () => {
    const sb = makeSupabase();
    sb._thenFn.mockImplementationOnce(
      (cb: (v: { data: null; error: Error }) => unknown) =>
        Promise.resolve(cb({ data: null, error: new Error("db error") }))
    );
    const store = createTaskStore(sb as never);
    await expect(store.markAssigned("42", "w1")).rejects.toThrow("db error");
  });

  it("markComplete updates status and completed_at", async () => {
    const sb = makeSupabase();
    const store = createTaskStore(sb as never);
    await store.markComplete("42");
    expect(sb._updateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "complete",
        completed_at: expect.any(String),
      }),
    );
    expect(sb._eqFn).toHaveBeenCalledWith("task_id", "42");
  });

  it("markComplete throws if supabase returns an error", async () => {
    const sb = makeSupabase();
    sb._thenFn.mockImplementationOnce(
      (cb: (v: { data: null; error: Error }) => unknown) =>
        Promise.resolve(cb({ data: null, error: new Error("conn error") }))
    );
    const store = createTaskStore(sb as never);
    await expect(store.markComplete("42")).rejects.toThrow("conn error");
  });

  it("markPending updates status and clears worker_id", async () => {
    const sb = makeSupabase();
    const store = createTaskStore(sb as never);
    await store.markPending("42");
    expect(sb._updateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        worker_id: null,
      }),
    );
    expect(sb._eqFn).toHaveBeenCalledWith("task_id", "42");
  });

  it("updateTaskPr updates pr_number and branch", async () => {
    const sb = makeSupabase();
    const store = createTaskStore(sb as never);
    await store.updateTaskPr("42", 10, "fix-issue-42");
    expect(sb._updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ pr_number: 10, branch: "fix-issue-42" }),
    );
    expect(sb._eqFn).toHaveBeenCalledWith("task_id", "42");
  });

  it("updateTaskPr passes null branch when branch is null", async () => {
    const sb = makeSupabase();
    const store = createTaskStore(sb as never);
    await store.updateTaskPr("42", 10, null);
    expect(sb._updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ pr_number: 10, branch: null }),
    );
  });

  it("listTasks returns mapped rows", async () => {
    const now = new Date().toISOString();
    const sb = makeSupabase([
      {
        task_id: "42", issue_number: 42, repo: "owner/repo",
        title: "Fix the bug", status: "complete",
        worker_id: "w1", pr_number: 10, branch: "fix-42",
        created_at: now, assigned_at: now, completed_at: now,
      },
    ]);
    const store = createTaskStore(sb as never);
    const rows = await store.listTasks();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      taskId: "42",
      issueNumber: 42,
      repo: "owner/repo",
      title: "Fix the bug",
      status: "complete",
      workerId: "w1",
      prNumber: 10,
      branch: "fix-42",
      createdAt: now,
      assignedAt: now,
      completedAt: now,
    });
  });

  it("listTasks returns empty array when no rows", async () => {
    const sb = makeSupabase([]);
    const store = createTaskStore(sb as never);
    expect(await store.listTasks()).toEqual([]);
  });

  it("listTasks handles null nullable fields", async () => {
    const now = new Date().toISOString();
    const sb = makeSupabase([
      {
        task_id: "1", issue_number: 1, repo: "r/r",
        title: "T", status: "pending",
        worker_id: null, pr_number: null, branch: null,
        created_at: now, assigned_at: null, completed_at: null,
      },
    ]);
    const store = createTaskStore(sb as never);
    const rows = await store.listTasks();
    expect(rows[0].workerId).toBeNull();
    expect(rows[0].prNumber).toBeNull();
    expect(rows[0].branch).toBeNull();
    expect(rows[0].assignedAt).toBeNull();
    expect(rows[0].completedAt).toBeNull();
  });

  it("listTasks queries tasks table with descending created_at order", async () => {
    const sb = makeSupabase([]);
    const store = createTaskStore(sb as never);
    await store.listTasks();
    expect(sb.from).toHaveBeenCalledWith("tasks");
    expect(sb._selectFn).toHaveBeenCalled();
    expect(sb._orderFn).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(sb._limitFn).toHaveBeenCalled();
  });

  it("listTasks filters by status when provided", async () => {
    const sb = makeSupabase([]);
    const store = createTaskStore(sb as never);
    await store.listTasks({ status: "complete" });
    expect(sb._eqFn).toHaveBeenCalledWith("status", "complete");
  });

  it("listTasks does not filter by status when not provided", async () => {
    const sb = makeSupabase([]);
    const store = createTaskStore(sb as never);
    await store.listTasks();
    expect(sb._eqFn).not.toHaveBeenCalledWith("status", expect.anything());
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

  it("updateTaskPr resolves without error", async () => {
    const store = createNullTaskStore();
    await expect(store.updateTaskPr("42", 10, "fix")).resolves.toBeUndefined();
  });

  it("listTasks returns empty array", async () => {
    const store = createNullTaskStore();
    expect(await store.listTasks()).toEqual([]);
  });
});
