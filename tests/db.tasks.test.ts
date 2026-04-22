import { describe, it, expect, vi, beforeEach } from "vitest";
import { Task } from "../src/foreman/models/task.js";
import { Repo } from "../src/foreman/models/repo.js";
import { Worker } from "../src/foreman/models/worker.js";
import { initDb } from "../src/foreman/clients/db-client.js";
import { createTestSupabase } from "./helpers/db.js";
import { fakeRepo } from "./helpers/task.js";

const supabase = createTestSupabase();
initDb(supabase);

// All task IDs in this file use the "dbt-" prefix and issue numbers in the
// 9000 range so we don't collide with pipeline.test.ts (which uses issue
// numbers 42, 55, 70, 80, 91, 92, 100) running in a parallel Vitest worker.
const OWN_IDS = ["dbt-42", "dbt-1", "dbt-2", "dbt-3"];

beforeEach(async () => {
  Worker._reset();
  await supabase.from("tasks").delete().in("task_id", OWN_IDS);
});

/** Filter a Task[] result to only rows this file owns. */
function own(tasks: Task[]) {
  return tasks.filter((t) => t.taskId.startsWith("dbt-"));
}

/**
 * Insert a task row that is protected from pipeline.test.ts's reconcile().
 * Reconcile calls task.deleteIfUnassigned() which only deletes rows where assigned_at IS NULL.
 * Setting assigned_at to a non-null value makes the row immune to deletion.
 * Use this for tests that need a stable row but aren't testing upsert itself.
 */
async function insertProtected(taskId: string, issueNumber: number, repo: string, title: string, extra: Record<string, unknown> = {}) {
  const repoRecord = await Repo.findOrCreate(repo);
  const { error } = await supabase.from("tasks").upsert({
    task_id: taskId, issue_number: issueNumber, repo, repo_id: repoRecord.id, title,
    body: "", labels: [],
    assigned_at: "2026-01-01T00:00:00Z",
    ...extra,
  }, { onConflict: "task_id" });
  if (error) throw error;
}

// ── Tests: Task (Supabase) ────────────────────────────────────────────────────

describe("Task.upsert (Supabase)", () => {
  it("stores a row with body and labels, status derived as pending", async () => {
    await Task.upsert("dbt-42", 9042, "owner/repo", "Fix the bug", "Issue body", ["bug", "brunel:ready"]);

    // Use Task.get (direct PK lookup) rather than Task.list to avoid the window
    // where pipeline.test.ts's reconcile() can delete this pending row.
    const task = await Task.get("dbt-42");
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

  it("is idempotent — duplicate task_id does not throw or duplicate", async () => {
    await Task.upsert("dbt-42", 9042, "owner/repo", "Fix the bug", "", []);
    await expect(Task.upsert("dbt-42", 9042, "owner/repo", "Fix the bug", "", [])).resolves.toBeDefined();

    // Use Task.get rather than Task.list to avoid reconcile deleting the pending row.
    const task = await Task.get("dbt-42");
    expect(task).not.toBeNull();
  });

  it("on conflict updates content fields only — status fields are preserved", async () => {
    await Task.upsert("dbt-42", 9042, "owner/repo", "Original title", "Original body", ["v1"]);
    const t = await Task.get("dbt-42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("worker-1", fakeWs, fakeRepo()));
    await t!.complete();

    // Upsert again (e.g. startup sync): must update content but PRESERVE status fields.
    // Use Task.get (direct PK lookup) rather than Task.list to minimise the window
    // where pipeline.test.ts's reconcile() can delete this row (assigned_at IS NULL).
    await Task.upsert("dbt-42", 9042, "owner/repo", "New title", "New body", ["v2"]);

    const task = await Task.get("dbt-42");
    expect(task).not.toBeNull();
    expect(task!.title).toBe("New title");
    expect(task!.body).toBe("New body");
    expect(task!.labels).toEqual(["v2"]);
    // Status fields must be preserved — not reset to null.
    expect(task!.workerId).toBe("worker-1");
    expect(task!.completedAt).toBeTruthy();
    expect(task!.assignedAt).toBeTruthy();
  });
});

describe("Task.assign (Supabase)", () => {
  it("sets worker_id and assigned_at", async () => {
    await insertProtected("dbt-42", 9042, "owner/repo", "Fix the bug");
    const t = await Task.get("dbt-42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("worker-1", fakeWs, fakeRepo()));

    const task = await Task.get("dbt-42");
    expect(task!.workerId).toBe("worker-1");
    expect(task!.assignedAt).toBeTruthy();
  });
});

describe("Task.complete (Supabase)", () => {
  it("sets completed_at", async () => {
    await insertProtected("dbt-42", 9042, "owner/repo", "Fix the bug");
    const t = await Task.get("dbt-42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("worker-1", fakeWs, fakeRepo()));
    await t!.complete();

    const task = await Task.get("dbt-42");
    expect(task!.completedAt).toBeTruthy();
  });
});

describe("Task.revert (Supabase)", () => {
  it("clears worker_id", async () => {
    await insertProtected("dbt-42", 9042, "owner/repo", "Fix the bug");
    const t = await Task.get("dbt-42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("worker-1", fakeWs, fakeRepo()));
    await t!.revert();

    const task = await Task.get("dbt-42");
    expect(task!.workerId).toBeNull();
  });
});

describe("Task.registerPr (Supabase)", () => {
  it("stores pr_number and branch", async () => {
    await insertProtected("dbt-42", 9042, "owner/repo", "Fix the bug");
    const t = await Task.get("dbt-42");
    await t!.registerPr(10, "fix-issue-42");

    const task = await Task.get("dbt-42");
    expect(task!.prNumber).toBe(10);
    expect(task!.branch).toBe("fix-issue-42");
  });

  it("stores null branch when branch is null", async () => {
    await insertProtected("dbt-42", 9042, "owner/repo", "Fix the bug");
    const t = await Task.get("dbt-42");
    await t!.registerPr(10, null);

    const task = await Task.get("dbt-42");
    expect(task!.prNumber).toBe(10);
    expect(task!.branch).toBeNull();
  });
});

describe("Task.list (Supabase)", () => {
  it("returns rows in descending created_at order", async () => {
    // Insert with explicit timestamps so order is predictable.
    // Set assigned_at to protect from parallel reconcile in pipeline.test.ts.
    const rrRepo = await Repo.findOrCreate("r/r");
    await supabase.from("tasks").insert({
      task_id: "dbt-1", issue_number: 9001, repo: "r/r", repo_id: rrRepo.id, title: "First",
      body: "", labels: [],
      created_at: "2026-03-27T01:00:00Z",
      assigned_at: "2026-01-01T00:00:00Z",
    });
    await supabase.from("tasks").insert({
      task_id: "dbt-2", issue_number: 9002, repo: "r/r", repo_id: rrRepo.id, title: "Second",
      body: "", labels: [],
      created_at: "2026-03-27T03:00:00Z",
      assigned_at: "2026-01-01T00:00:00Z",
    });
    await supabase.from("tasks").insert({
      task_id: "dbt-3", issue_number: 9003, repo: "r/r", repo_id: rrRepo.id, title: "Third",
      body: "", labels: [],
      created_at: "2026-03-27T02:00:00Z",
      assigned_at: "2026-01-01T00:00:00Z",
    });

    const tasks = own(await Task.list());
    expect(tasks.map((t) => t.taskId)).toEqual(["dbt-2", "dbt-3", "dbt-1"]);
  });

  it("returns empty array when no rows", async () => {
    expect(own(await Task.list())).toEqual([]);
  });

  it("with cancelable=true returns only never-assigned, not-closed, not-completed tasks", async () => {
    // The cancelable=true filter checks worker_id IS NULL (not assigned_at IS NULL).
    // insertProtected sets assigned_at (making the row immune to reconcile) but
    // leaves worker_id null, so dbt-1 still satisfies the cancelable filter.
    await insertProtected("dbt-1", 9001, "r/r", "Pending task");
    // Create a task that was assigned then completed (not cancelable)
    await insertProtected("dbt-2", 9002, "r/r", "Complete task");
    const t2 = await Task.get("dbt-2");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t2!.assign(Worker.register("w1", fakeWs, fakeRepo()));
    await t2!.complete();

    const cancelable = own(await Task.list({ cancelable: true }));
    expect(cancelable.map((t) => t.taskId)).toContain("dbt-1");
    expect(cancelable.map((t) => t.taskId)).not.toContain("dbt-2");

    const all = own(await Task.list());
    expect(all.map((t) => t.taskId)).toContain("dbt-1");
    expect(all.map((t) => t.taskId)).toContain("dbt-2");
  });

  it("returns all statuses when status not provided", async () => {
    // Use insertProtected so reconcile from pipeline.test.ts can't delete pending rows
    await insertProtected("dbt-1", 9001, "r/r", "Pending");
    await insertProtected("dbt-2", 9002, "r/r", "Assigned");
    const t2 = await Task.get("dbt-2");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t2!.assign(Worker.register("w1", fakeWs, fakeRepo()));

    const all = own(await Task.list());
    expect(all).toHaveLength(2);
  });

  it("handles null nullable fields", async () => {
    // Use insertProtected to survive parallel reconcile; assignedAt will be non-null
    await insertProtected("dbt-1", 9001, "r/r", "T");

    const task = await Task.get("dbt-1");
    expect(task!.workerId).toBeNull();
    expect(task!.prNumber).toBeNull();
    expect(task!.branch).toBeNull();
    expect(task!.completedAt).toBeNull();
  });

  it("returns body and labels stored by upsert", async () => {
    await insertProtected("dbt-1", 9001, "r/r", "T", { body: "the body", labels: ["label-a", "label-b"] });

    const task = await Task.get("dbt-1");
    expect(task!.body).toBe("the body");
    expect(task!.labels).toEqual(["label-a", "label-b"]);
  });
});

// ── Tests: Task.deleteIfUnassigned (Supabase) ─────────────────────────────────

describe("Task.deleteIfUnassigned (Supabase)", () => {
  it("deletes a never-assigned pending row", async () => {
    await Task.upsert("dbt-42", 9042, "owner/repo", "Fix", "", []);
    const t = await Task.get("dbt-42");
    await t!.deleteIfUnassigned();

    expect(own(await Task.list())).toHaveLength(0);
  });

  it("does NOT delete a row that was previously assigned (assigned_at is set)", async () => {
    await insertProtected("dbt-42", 9042, "owner/repo", "Fix");
    const t = await Task.get("dbt-42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("worker-1", fakeWs, fakeRepo()));
    await t!.revert(); // revert (e.g. worker_goodbye) — assigned_at stays set

    await t!.deleteIfUnassigned();

    // Row must still exist because it has history
    const tasks = own(await Task.list());
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskId).toBe("dbt-42");
  });

  it("is a no-op when the row does not exist", async () => {
    const ghost = Task.fromTest({ task_id: "dbt-42", issue_number: 9042 });
    await expect(ghost.deleteIfUnassigned()).resolves.toBeUndefined();
  });
});

// ── Tests: Task issue and PR lifecycle ────────────────────────────────────────

describe("Task issue and PR lifecycle (Supabase)", () => {
  it("close records when an issue is closed", async () => {
    await insertProtected("dbt-42", 9042, "owner/repo", "Fix the bug");
    const t = await Task.get("dbt-42");
    await t!.close();

    const task = await Task.get("dbt-42");
    expect(task!.issueClosedAt).toBeTruthy();
  });

  it("reopen clears the issue closed marker when issue is reopened", async () => {
    await insertProtected("dbt-42", 9042, "owner/repo", "Fix the bug");
    const t = await Task.get("dbt-42");
    await t!.close();
    await t!.reopen();

    const task = await Task.get("dbt-42");
    expect(task!.issueClosedAt).toBeNull();
  });

  it("mergePr records when a PR is merged", async () => {
    await insertProtected("dbt-42", 9042, "owner/repo", "Fix the bug");
    const t = await Task.get("dbt-42");
    await t!.registerPr(10, "fix-issue");
    await t!.mergePr();

    const task = await Task.get("dbt-42");
    expect(task!.prMergedAt).toBeTruthy();
  });
});

// ── Tests: Task.getByRepoIssue, Task.getByRepoPr, Task.getByWorker ──────────

describe("Task lookup methods (Supabase)", () => {
  it("getByRepoIssue finds task by repo and issue number", async () => {
    await insertProtected("dbt-42", 9042, "r/r", "title");
    const repo = await Repo.findOrCreate("r/r");
    const task = await Task.getByRepoIssue(repo.id, 9042);
    expect(task?.taskId).toBe("dbt-42");
  });

  it("getByRepoPr finds task by repo and PR number", async () => {
    await insertProtected("dbt-42", 9042, "r/r", "title");
    const repo = await Repo.findOrCreate("r/r");
    const t = await Task.get("dbt-42");
    await t!.registerPr(10, "fix");
    const task = await Task.getByRepoPr(repo.id, 10);
    expect(task?.taskId).toBe("dbt-42");
  });

  it("getByWorker finds assigned task for worker", async () => {
    await insertProtected("dbt-42", 9042, "r/r", "title");
    const t = await Task.get("dbt-42");
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("w1", fakeWs, fakeRepo()));
    const task = await Task.getByWorker("w1");
    expect(task?.taskId).toBe("dbt-42");
  });
});

// ── Tests: UNIQUE(issue_number, repo_id) constraint ───────────────────────────

describe("Task.upsert UNIQUE(issue_number, repo_id)", () => {
  const EXTRA_IDS = ["dbt-r1-9042", "dbt-r2-9042"];

  beforeEach(async () => {
    await supabase.from("tasks").delete().in("task_id", EXTRA_IDS);
  });

  it("allows the same issue_number in two different repos", async () => {
    await Task.upsert("dbt-r1-9042", 9042, "dbt-owner/repo-1", "Title 1", "", []);
    await expect(
      Task.upsert("dbt-r2-9042", 9042, "dbt-owner/repo-2", "Title 2", "", []),
    ).resolves.toBeDefined();
  });

  it("stores repoId on the task", async () => {
    const task = await Task.upsert("dbt-42", 9042, "owner/repo", "Title", "", []);
    expect(task.repoId).toBeGreaterThan(0);
  });
});
