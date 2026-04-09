import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../database.types.js";
import type { TaskStatus } from "../../types.js";

let db: SupabaseClient<Database>;
let onChange: (() => void) | undefined;

export function initTask(supabase: SupabaseClient<Database>, onTaskChanged?: () => void): void {
  db = supabase;
  onChange = onTaskChanged;
}

type DbRow = Database["public"]["Tables"]["tasks"]["Row"];

export class Task {
  readonly taskId: string;
  issueNumber: number;
  repo: string;
  title: string;
  body: string;
  labels: string[];
  workerId: string | null;
  prNumber: number | null;
  branch: string | null;
  readonly createdAt: string;
  assignedAt: string | null;
  completedAt: string | null;
  issueClosedAt: string | null;
  prMergedAt: string | null;

  private constructor(row: DbRow) {
    this.taskId = row.task_id;
    this.issueNumber = row.issue_number;
    this.repo = row.repo;
    this.title = row.title;
    this.body = row.body;
    this.labels = row.labels;
    this.workerId = row.worker_id;
    this.prNumber = row.pr_number;
    this.branch = row.branch;
    this.createdAt = row.created_at;
    this.assignedAt = row.assigned_at;
    this.completedAt = row.completed_at;
    this.issueClosedAt = row.issue_closed_at;
    this.prMergedAt = row.pr_merged_at;
  }

  get status(): TaskStatus {
    if (this.completedAt) return "complete";
    if (this.issueClosedAt) return "closed";
    if (this.prMergedAt) return "merged";
    if (this.prNumber !== null) return "pushed";
    if (this.workerId) return "assigned";
    return "pending";
  }

  get repoUrl(): string {
    return `https://github.com/${this.repo}`;
  }

  static fromTest(fields: Partial<DbRow> & { task_id: string; issue_number: number }): Task {
    const row: DbRow = {
      repo: "",
      title: "",
      body: "",
      labels: [],
      worker_id: null,
      pr_number: null,
      branch: null,
      created_at: new Date().toISOString(),
      assigned_at: null,
      completed_at: null,
      issue_closed_at: null,
      pr_merged_at: null,
      ...fields,
    };
    return new Task(row);
  }

  static async get(taskId: string): Promise<Task | null> {
    const { data, error } = await db.from("tasks").select("*").eq("task_id", taskId).maybeSingle();
    if (error) throw error;
    return data ? new Task(data) : null;
  }

  static async getByIssue(issueNumber: number): Promise<Task | null> {
    const { data, error } = await db.from("tasks").select("*").eq("issue_number", issueNumber).maybeSingle();
    if (error) throw error;
    return data ? new Task(data) : null;
  }

  static async getByPr(prNumber: number): Promise<Task | null> {
    const { data, error } = await db.from("tasks").select("*").eq("pr_number", prNumber).maybeSingle();
    if (error) throw error;
    return data ? new Task(data) : null;
  }

  static async getByWorker(workerId: string): Promise<Task | null> {
    const { data, error } = await db.from("tasks").select("*").eq("worker_id", workerId).is("completed_at", null).maybeSingle();
    if (error) throw error;
    return data ? new Task(data) : null;
  }

  static async list(opts?: { cancelable?: boolean; limit?: number }): Promise<Task[]> {
    if (!db) return [];
    const limit = opts?.limit ?? 200;
    let q = db.from("tasks").select("*");
    if (opts?.cancelable) {
      q = q.is("worker_id", null).is("completed_at", null).is("issue_closed_at", null).is("pr_merged_at", null);
    }
    const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return (data ?? []).map((row) => new Task(row));
  }

  static async upsert(taskId: string, issueNumber: number, repo: string, title: string, body: string, labels: string[]): Promise<Task> {
    const { data, error } = await db.from("tasks").upsert(
      { task_id: taskId, issue_number: issueNumber, repo, title, body, labels, worker_id: null, assigned_at: null, completed_at: null, issue_closed_at: null, pr_merged_at: null },
      { onConflict: "task_id" },
    ).select().maybeSingle();
    if (error) throw error;
    onChange?.();
    return new Task(data!);
  }

  async assign(workerId: string): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await db.from("tasks").update({ worker_id: workerId, assigned_at: now }).eq("task_id", this.taskId);
    if (error) throw error;
    this.workerId = workerId;
    this.assignedAt = now;
    onChange?.();
  }

  async complete(): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await db.from("tasks").update({ completed_at: now }).eq("task_id", this.taskId);
    if (error) throw error;
    this.completedAt = now;
    onChange?.();
  }

  async revert(): Promise<void> {
    const { error } = await db.from("tasks").update({ worker_id: null }).eq("task_id", this.taskId);
    if (error) throw error;
    this.workerId = null;
    onChange?.();
  }

  async close(): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await db.from("tasks").update({ issue_closed_at: now }).eq("task_id", this.taskId);
    if (error) throw error;
    this.issueClosedAt = now;
    onChange?.();
  }

  async reopen(): Promise<void> {
    const { error } = await db.from("tasks").update({ issue_closed_at: null }).eq("task_id", this.taskId);
    if (error) throw error;
    this.issueClosedAt = null;
    onChange?.();
  }

  async registerPr(prNumber: number, branch: string | null): Promise<void> {
    const { error } = await db.from("tasks").update({ pr_number: prNumber, branch }).eq("task_id", this.taskId);
    if (error) throw error;
    this.prNumber = prNumber;
    this.branch = branch;
    onChange?.();
  }

  async unregisterPr(): Promise<void> {
    const { error } = await db.from("tasks").update({ pr_number: null, branch: null }).eq("task_id", this.taskId);
    if (error) throw error;
    this.prNumber = null;
    this.branch = null;
    onChange?.();
  }

  async mergePr(): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await db.from("tasks").update({ pr_merged_at: now }).eq("task_id", this.taskId);
    if (error) throw error;
    this.prMergedAt = now;
    onChange?.();
  }

  async updateContent(title: string, body: string, labels: string[]): Promise<void> {
    const { error } = await db.from("tasks").update({ title, body, labels }).eq("task_id", this.taskId);
    if (error) throw error;
    this.title = title;
    this.body = body;
    this.labels = labels;
    onChange?.();
  }

  async delete(): Promise<void> {
    const { error } = await db.from("tasks").delete().eq("task_id", this.taskId).is("assigned_at", null);
    if (error) throw error;
    onChange?.();
  }
}
