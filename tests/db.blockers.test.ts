import { describe, it, expect, beforeEach } from "vitest";
import { createTaskBlockerStore, createNullTaskBlockerStore, createTaskStore } from "../src/db.js";
import { createTestSupabase } from "./helpers/db.js";

const supabase = createTestSupabase();

beforeEach(async () => {
  await supabase.from("task_blockers").delete().neq("task_id", "");
  await supabase.from("tasks").delete().neq("task_id", "");
});

describe("createTaskBlockerStore", () => {
  it("upsertBlockers inserts rows for each blocker", async () => {
    const taskStore = createTaskStore(supabase);
    await taskStore.upsertTask("42", 42, "r/r", "Test");
    const store = createTaskBlockerStore(supabase);

    await store.upsertBlockers("42", [10, 11]);

    const rows = await store.listTaskBlockers("42");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.blockerIssueNumber)).toEqual(expect.arrayContaining([10, 11]));
    expect(rows.every((r) => r.closedAt === null)).toBe(true);
  });

  it("upsertBlockers is idempotent — duplicate call does not add extra rows", async () => {
    const taskStore = createTaskStore(supabase);
    await taskStore.upsertTask("42", 42, "r/r", "Test");
    const store = createTaskBlockerStore(supabase);

    await store.upsertBlockers("42", [10, 11]);
    await store.upsertBlockers("42", [10, 11]);

    const rows = await store.listTaskBlockers("42");
    expect(rows).toHaveLength(2);
  });

  it("upsertBlockers with empty array does nothing", async () => {
    const taskStore = createTaskStore(supabase);
    await taskStore.upsertTask("42", 42, "r/r", "Test");
    const store = createTaskBlockerStore(supabase);

    await expect(store.upsertBlockers("42", [])).resolves.toBeUndefined();
    const rows = await store.listTaskBlockers("42");
    expect(rows).toHaveLength(0);
  });

  it("closeBlocker sets closed_at on the matching row", async () => {
    const taskStore = createTaskStore(supabase);
    await taskStore.upsertTask("42", 42, "r/r", "Test");
    const store = createTaskBlockerStore(supabase);

    await store.upsertBlockers("42", [10, 11]);
    await store.closeBlocker("42", 10);

    const rows = await store.listTaskBlockers("42");
    const row10 = rows.find((r) => r.blockerIssueNumber === 10)!;
    const row11 = rows.find((r) => r.blockerIssueNumber === 11)!;
    expect(row10.closedAt).toBeTruthy();
    expect(row11.closedAt).toBeNull();
  });

  it("listAllOpenBlockers returns rows where closed_at is null", async () => {
    const taskStore = createTaskStore(supabase);
    await taskStore.upsertTask("42", 42, "r/r", "Test A");
    await taskStore.upsertTask("43", 43, "r/r", "Test B");
    const store = createTaskBlockerStore(supabase);

    await store.upsertBlockers("42", [10]); // open
    await store.upsertBlockers("43", [11]); // will be closed
    await store.closeBlocker("43", 11);

    const open = await store.listAllOpenBlockers();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ taskId: "42", blockerIssueNumber: 10 });
  });

  it("listTaskBlockers returns empty array for task with no blockers", async () => {
    const taskStore = createTaskStore(supabase);
    await taskStore.upsertTask("42", 42, "r/r", "Test");
    const store = createTaskBlockerStore(supabase);

    const rows = await store.listTaskBlockers("42");
    expect(rows).toEqual([]);
  });
});

describe("createNullTaskBlockerStore", () => {
  it("upsertBlockers resolves without error", async () => {
    const store = createNullTaskBlockerStore();
    await expect(store.upsertBlockers("42", [10])).resolves.toBeUndefined();
  });

  it("closeBlocker resolves without error", async () => {
    const store = createNullTaskBlockerStore();
    await expect(store.closeBlocker("42", 10)).resolves.toBeUndefined();
  });

  it("listTaskBlockers returns empty array", async () => {
    const store = createNullTaskBlockerStore();
    expect(await store.listTaskBlockers("42")).toEqual([]);
  });

  it("listAllOpenBlockers returns empty array", async () => {
    const store = createNullTaskBlockerStore();
    expect(await store.listAllOpenBlockers()).toEqual([]);
  });
});
