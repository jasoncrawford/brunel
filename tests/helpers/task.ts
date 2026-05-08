import { initDb, db } from "../../src/foreman/clients/db-client.js";
import { createMemoryTaskDb } from "./memory-db.js";
import { Task } from "../../src/foreman/models/task.js";
import { Repo } from "../../src/foreman/models/repo.js";
import { TaskManager } from "../../src/foreman/models/task-manager.js";
import type { Database } from "../../src/database.types.js";

type DbRow = Database["public"]["Tables"]["tasks"]["Row"];
type WebhookRow = Database["public"]["Tables"]["webhook_events"]["Row"];

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

/** Returns a fake Repo object suitable for Worker.register() in tests. */
export function fakeRepo(fullName = "owner/repo", id = 1, status: "new" | "active" = "new"): Repo {
  return { id, fullName, status } as unknown as Repo;
}

/**
 * Seeds an installation and a repo linked to it in the in-memory DB.
 * Returns the Repo (with installationId set) and the installation's githubId.
 * The repo starts as "new"; call repo.activate() if needed for task assignment.
 */
export async function seedRepoWithInstallation(
  fullName: string,
  githubInstallationId: number,
): Promise<{ repo: Repo; githubInstallationId: number }> {
  const instResult = await (db as any).from("installations")
    .insert({ github_id: githubInstallationId, account_login: "test-account", account_type: "Organization" })
    .select().single();
  const installationDbId = instResult.data.id as number;
  await (db as any).from("repos")
    .insert({ full_name: fullName, installation_id: installationDbId })
    .select().single();
  const repo = await Repo.findOrCreate(fullName);
  return { repo, githubInstallationId };
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
/**
 * Seeds a webhook_event directly into the DB shim.
 * Accepts an optional `id` to set a specific sequence id (the real Supabase schema
 * auto-generates this, but tests often need deterministic ids for seqId assertions).
 */
export async function seedWebhookEvent(
  fields: Partial<WebhookRow> & { event_name: string },
): Promise<void> {
  await (db.from as any)("webhook_events").insert({
    payload: {},
    ...fields,
  }).single();
}

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
    input_tokens: null,
    output_tokens: null,
    cost_usd: null,
    ...fields,
  } as any, { onConflict: "task_id" }).select().maybeSingle();
  Task.events.emit("changed");
  const task = await Task.get(fields.task_id);
  if (!task) throw new Error(`seedTask: failed to find task ${fields.task_id} after insert`);
  return task;
}
