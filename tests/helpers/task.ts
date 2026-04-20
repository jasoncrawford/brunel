import { initDb, db } from "../../src/foreman/clients/db-client.js";
import { createMemoryTaskDb } from "./memory-db.js";
import { Task } from "../../src/foreman/models/task.js";
import type { Database } from "../../src/database.types.js";

type DbRow = Database["public"]["Tables"]["tasks"]["Row"];

/**
 * Resets the in-memory DB to a fresh, empty state.
 * Call in beforeEach for per-test task isolation when using the DB shim.
 */
export function resetDb(): void {
  initDb(createMemoryTaskDb());
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
