import { initDb, db } from "../../src/foreman/clients/db-client.js";
import { createMemoryTaskDb } from "./memory-db.js";
import { Task } from "../../src/foreman/models/task.js";
import { Repo } from "../../src/foreman/models/repo.js";
import { TaskManager } from "../../src/foreman/models/task-manager.js";
import type { Database } from "../../src/database.types.js";

type DbRow = Database["public"]["Tables"]["tasks"]["Row"];

/**
 * Resets the in-memory DB and TaskManager registry to a fresh, empty state.
 * Call in beforeEach for per-test task isolation when using the DB shim.
 */
export function resetDb(): void {
  initDb(createMemoryTaskDb());
  TaskManager._resetRegistry();
}

/**
 * Creates (or finds) a Repo in the in-memory DB. Useful for test setup
 * when you need a Repo instance to create a TaskManager.
 */
export async function createTestRepo(fullName = "test/repo"): Promise<Repo> {
  return Repo.findOrCreate(fullName);
}

/**
 * Creates a per-repo TaskManager backed by a test Repo from the in-memory DB.
 * Shorthand for `(await createTestRepo(fullName)).taskManager`.
 */
export async function createTestTaskManager(fullName = "test/repo"): Promise<TaskManager> {
  const repo = await createTestRepo(fullName);
  return repo.taskManager;
}

/**
 * Seeds a task directly into the DB shim with arbitrary field values,
 * including status fields like worker_id, assigned_at, completed_at, etc.
 * Returns the Task instance retrieved from the DB after insertion.
 *
 * Use this in tests that need tasks pre-populated with specific state
 * that can't be set through the public Task API alone (e.g., an
 * already-assigned or already-completed task). Call resetDb() in
 * beforeEach before using seedTask() to ensure per-test isolation.
 */
export async function seedTask(
  fields: Partial<DbRow> & { task_id: string; issue_number: number },
): Promise<Task> {
  await db.from("tasks").upsert({
    repo: "",
    repo_id: 0,
    title: "",
    body: "",
    labels: [],
    worker_id: null,
    pr_number: null,
    branch: null,
    assigned_at: null,
    completed_at: null,
    issue_closed_at: null,
    pr_merged_at: null,
    ...fields,
  } as any, { onConflict: "task_id" }).select().maybeSingle();
  Task.events.emit("changed");
  const task = await Task.get(fields.task_id);
  if (!task) throw new Error(`seedTask: failed to find task ${fields.task_id} after insert`);
  return task;
}
