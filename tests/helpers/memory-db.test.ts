import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryTaskDb } from "./memory-db.js";
import { initDb } from "../../src/foreman/clients/db-client.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/database.types.js";

// Use the tasks table (known to exist in memory-db) for most tests.
// A fresh db is created per test so state doesn't leak.

let db: SupabaseClient<Database>;

beforeEach(() => {
  db = createMemoryTaskDb();
  initDb(db);
});

const BASE = {
  task_id: "t1",
  issue_number: 1,
  repo: "owner/repo",
  repo_id: 1,
  title: "T1",
  body: "",
  labels: [],
  worker_id: null,
  pr_number: null,
  branch: null,
  assigned_at: null,
  completed_at: null,
  issue_closed_at: null,
  pr_merged_at: null,
  input_tokens: null,
  output_tokens: null,
  cost_usd: null,
  created_at: "2026-01-01T00:00:00Z",
};

async function seed(overrides: Partial<typeof BASE> & { task_id: string }) {
  await db.from("tasks").upsert({ ...BASE, ...overrides }, { onConflict: "task_id" });
}

describe("select + eq", () => {
  it("returns matching row", async () => {
    await seed({ task_id: "t1", title: "Hello" });
    const { data } = await db.from("tasks").select().eq("task_id", "t1").maybeSingle();
    expect(data).toMatchObject({ task_id: "t1", title: "Hello" });
  });

  it("returns null when no match", async () => {
    const { data } = await db.from("tasks").select().eq("task_id", "missing").maybeSingle();
    expect(data).toBeNull();
  });
});

describe("select + is (null check)", () => {
  it("finds rows where column IS NULL", async () => {
    await seed({ task_id: "t1", worker_id: null });
    await seed({ task_id: "t2", worker_id: "w1" });
    const { data } = await (db.from("tasks").select().is("worker_id", null) as any);
    expect(data).toHaveLength(1);
    expect(data[0].task_id).toBe("t1");
  });
});

describe("select + not (not null check)", () => {
  it("finds rows where column IS NOT NULL", async () => {
    await seed({ task_id: "t1", worker_id: null });
    await seed({ task_id: "t2", worker_id: "w1" });
    const { data } = await (db.from("tasks").select().not("worker_id", "is", null) as any);
    expect(data).toHaveLength(1);
    expect(data[0].task_id).toBe("t2");
  });
});

describe("select + comparison filters", () => {
  it("gt filters rows", async () => {
    await seed({ task_id: "t1", issue_number: 1 });
    await seed({ task_id: "t2", issue_number: 5 });
    const { data } = await (db.from("tasks").select().gt("issue_number", 3) as any);
    expect(data).toHaveLength(1);
    expect(data[0].task_id).toBe("t2");
  });

  it("lt filters rows", async () => {
    await seed({ task_id: "t1", issue_number: 1 });
    await seed({ task_id: "t2", issue_number: 5 });
    const { data } = await (db.from("tasks").select().lt("issue_number", 3) as any);
    expect(data).toHaveLength(1);
    expect(data[0].task_id).toBe("t1");
  });

  it("lte string comparison (for timestamps)", async () => {
    await seed({ task_id: "t1", created_at: "2026-01-01T00:00:00Z" });
    await seed({ task_id: "t2", created_at: "2026-06-01T00:00:00Z" });
    const { data } = await (db.from("tasks").select().lte("created_at", "2026-01-01T00:00:00Z") as any);
    expect(data).toHaveLength(1);
    expect(data[0].task_id).toBe("t1");
  });
});

describe("order + limit", () => {
  it("orders ascending", async () => {
    await seed({ task_id: "t1", issue_number: 10 });
    await seed({ task_id: "t2", issue_number: 1 });
    const { data } = await db.from("tasks").select().order("issue_number", { ascending: true }).limit(10);
    expect(data!.map((r: any) => r.task_id)).toEqual(["t2", "t1"]);
  });

  it("orders descending", async () => {
    await seed({ task_id: "t1", issue_number: 1 });
    await seed({ task_id: "t2", issue_number: 10 });
    const { data } = await db.from("tasks").select().order("issue_number", { ascending: false }).limit(10);
    expect(data!.map((r: any) => r.task_id)).toEqual(["t2", "t1"]);
  });

  it("limit truncates results", async () => {
    await seed({ task_id: "t1", issue_number: 1 });
    await seed({ task_id: "t2", issue_number: 2 });
    await seed({ task_id: "t3", issue_number: 3 });
    const { data } = await db.from("tasks").select().order("issue_number", { ascending: true }).limit(2);
    expect(data).toHaveLength(2);
  });
});

describe("await on select (then)", () => {
  it("returns all rows via then()", async () => {
    await seed({ task_id: "t1" });
    await seed({ task_id: "t2" });
    const { data } = await (db.from("tasks").select().eq("repo_id", 1) as any);
    expect(data).toHaveLength(2);
  });
});

describe("upsert", () => {
  it("inserts when no conflict", async () => {
    const { data } = await db.from("tasks")
      .upsert({ ...BASE, task_id: "new", title: "New" }, { onConflict: "task_id" })
      .select()
      .maybeSingle();
    expect(data).toMatchObject({ task_id: "new", title: "New" });
  });

  it("merges on conflict, updates provided fields", async () => {
    await seed({ task_id: "t1", title: "Old", worker_id: "w1" });
    await db.from("tasks").upsert({ ...BASE, task_id: "t1", title: "New" }, { onConflict: "task_id" });
    const { data } = await db.from("tasks").select().eq("task_id", "t1").maybeSingle();
    expect(data).toMatchObject({ title: "New" });
  });

  it("preserves created_at on conflict", async () => {
    const originalDate = "2026-01-01T00:00:00Z";
    await seed({ task_id: "t1", created_at: originalDate });
    await db.from("tasks").upsert(
      { ...BASE, task_id: "t1", created_at: "2026-09-01T00:00:00Z" },
      { onConflict: "task_id" },
    );
    const { data } = await db.from("tasks").select().eq("task_id", "t1").maybeSingle();
    expect((data as any).created_at).toBe(originalDate);
  });
});

describe("update", () => {
  it("updates matching rows", async () => {
    await seed({ task_id: "t1", title: "Before" });
    await db.from("tasks").update({ title: "After" } as any).eq("task_id", "t1");
    const { data } = await db.from("tasks").select().eq("task_id", "t1").maybeSingle();
    expect((data as any).title).toBe("After");
  });

  it("returns updated row via .select().single()", async () => {
    await seed({ task_id: "t1", title: "Before" });
    const { data } = await (db.from("tasks").update({ title: "After" } as any)
      .eq("task_id", "t1") as any)
      .select()
      .single();
    expect(data).toMatchObject({ task_id: "t1", title: "After" });
  });
});

describe("delete", () => {
  it("removes matching rows", async () => {
    await seed({ task_id: "t1", worker_id: null });
    await seed({ task_id: "t2", worker_id: "w1" });
    await (db.from("tasks").delete().eq("task_id", "t1").is("worker_id", null) as any);
    const { data } = await (db.from("tasks").select() as any);
    expect(data).toHaveLength(1);
    expect(data[0].task_id).toBe("t2");
  });
});

describe("unknown table", () => {
  it("returns empty results for unknown tables", async () => {
    const { data } = await (db.from("foreman_messages" as any).select().limit(10) as any);
    expect(data).toEqual([]);
  });
});

describe("repos join via workers", () => {
  it("attaches repo data when using join select", async () => {
    // Seed a repo row directly
    const repoRow = { id: 99, full_name: "join-test/repo", status: "active", created_at: "2026-01-01T00:00:00Z" };
    await (db.from("repos" as any).insert(repoRow as any) as any);

    // Seed a worker row that references it
    const workerRow = {
      worker_id: "w-join",
      repo_id: 99,
      status: "ready",
      current_task_id: null,
      first_connected_at: "2026-01-01T00:00:00Z",
      last_connected_at: "2026-01-01T00:00:00Z",
      num_connections: 1,
      disconnected_at: null,
      goodbye_at: null,
    };
    await (db.from("workers" as any).insert(workerRow as any) as any);

    const { data } = await (db.from("workers" as any).select("*, repos(full_name)").eq("worker_id", "w-join") as any);
    expect(data).toHaveLength(1);
    expect(data[0].repos).toEqual({ full_name: "join-test/repo" });
  });
});
