import { EventEmitter } from "node:events";
import type { TaskStatus, TaskRow } from "../../../shared/types.js";
import type { Row } from "../db.js";
import type { TaskSnapshot, BlockerInfo } from "../admin-ws.js";
import { fetchNativeBlockers } from "../github.js";
import { db } from "../db-client.js";

type DbRow = Row<"tasks">;

export class Task {
  static readonly events = new EventEmitter();

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

  // ── In-memory blocker state (not persisted to DB) ─────────────────────────
  /** Merged set of blockers with their current open/closed state — set by TaskManager.hydrateBlockers(). */
  blockers: BlockerInfo[] = [];
  /** Whether native blockers have been fetched from the GitHub API. */
  blockersLoaded: boolean = false;

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
    if (this.blockersLoaded && this.blockers.some(b => b.isOpen)) return "blocked";
    return "pending";
  }

  get repoUrl(): string {
    return `https://github.com/${this.repo}`;
  }

  toJSON(): TaskRow {
    return {
      taskId: this.taskId,
      issueNumber: this.issueNumber,
      repo: this.repo,
      title: this.title,
      body: this.body,
      labels: this.labels,
      status: this.status,
      workerId: this.workerId,
      prNumber: this.prNumber,
      branch: this.branch,
      createdAt: this.createdAt,
      assignedAt: this.assignedAt,
      completedAt: this.completedAt,
      issueClosedAt: this.issueClosedAt,
      prMergedAt: this.prMergedAt,
    };
  }

  toSnapshot(): TaskSnapshot {
    return {
      taskId: this.taskId,
      issueNumber: this.issueNumber,
      title: this.title,
      status: this.status,
      assignedWorkerId: this.workerId ?? undefined,
      prNumber: this.prNumber ?? undefined,
      prUrl: this.prNumber != null ? `https://github.com/${this.repo}/pull/${this.prNumber}` : undefined,
      blockers: this.blockers,
    };
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

  // ── Blocker parsing (moved from dependencies.ts) ─────────────────────────

  /**
   * Parse "Depends on #N" / "Blocked by #N" lines from an issue body.
   * Returns a deduplicated list of blocker issue numbers.
   */
  static parseBodyBlockers(body: string): number[] {
    const clausePattern = /(?:^|\s)\*{0,2}(?:depends\s+on|blocked\s+by)[\s:*]+(#\d+(?:\s*,\s*#\d+)*)/gi;
    const numbers = new Set<number>();
    let m: RegExpExecArray | null;
    while ((m = clausePattern.exec(body)) !== null) {
      const refPattern = /#(\d+)/g;
      let r: RegExpExecArray | null;
      while ((r = refPattern.exec(m[1])) !== null) {
        numbers.add(parseInt(r[1], 10));
      }
    }
    return Array.from(numbers);
  }

  /**
   * Fetch all blockers for an issue from both body text and GitHub native relationships.
   * Results are merged and deduplicated.
   */
  static async fetchBlockers(
    issueNumber: number,
    body: string,
    opts: { repo: string; token: string; apiUrl?: string },
  ): Promise<number[]> {
    const [bodyBlockers, nativeBlockers] = await Promise.all([
      Promise.resolve(Task.parseBodyBlockers(body)),
      fetchNativeBlockers(issueNumber, opts),
    ]);
    return Array.from(new Set([...bodyBlockers, ...nativeBlockers]));
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private static select() {
    return db.from("tasks").select("*");
  }

  private static async findOne(col: string, val: string | number): Promise<Task | null> {
    const { data, error } = await Task.select().eq(col, val).maybeSingle();
    if (error) throw error;
    return data ? new Task(data) : null;
  }

  private async save(changes: Partial<DbRow>): Promise<void> {
    const { error } = await db.from("tasks").update(changes).eq("task_id", this.taskId);
    if (error) throw error;
    if ("worker_id" in changes) this.workerId = changes.worker_id ?? null;
    if ("assigned_at" in changes) this.assignedAt = changes.assigned_at ?? null;
    if ("completed_at" in changes) this.completedAt = changes.completed_at ?? null;
    if ("issue_closed_at" in changes) this.issueClosedAt = changes.issue_closed_at ?? null;
    if ("pr_merged_at" in changes) this.prMergedAt = changes.pr_merged_at ?? null;
    if ("pr_number" in changes) this.prNumber = changes.pr_number ?? null;
    if ("branch" in changes) this.branch = changes.branch ?? null;
    if ("title" in changes) this.title = changes.title!;
    if ("body" in changes) this.body = changes.body!;
    if ("labels" in changes) this.labels = changes.labels!;
    Task.events.emit("changed");
  }

  // ── Static finders ──────────────────────────────────────────────────────────

  static async get(taskId: string): Promise<Task | null> {
    return Task.findOne("task_id", taskId);
  }

  static async getByIssue(issueNumber: number): Promise<Task | null> {
    return Task.findOne("issue_number", issueNumber);
  }

  static async getByPr(prNumber: number): Promise<Task | null> {
    return Task.findOne("pr_number", prNumber);
  }

  static async getByWorker(workerId: string): Promise<Task | null> {
    const { data, error } = await Task.select().eq("worker_id", workerId).is("completed_at", null).maybeSingle();
    if (error) throw error;
    return data ? new Task(data) : null;
  }

  static async list(opts?: { cancelable?: boolean; limit?: number }): Promise<Task[]> {
    if (!db) return [];
    const limit = opts?.limit ?? 200;
    let q = Task.select();
    if (opts?.cancelable) {
      q = q.is("worker_id", null).is("completed_at", null).is("issue_closed_at", null).is("pr_merged_at", null);
    }
    const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return (data ?? []).map((row) => new Task(row));
  }

  static async upsert(taskId: string, issueNumber: number, repo: string, title: string, body: string, labels: string[]): Promise<Task> {
    // On conflict (task already exists), only update content fields (title, body, labels, repo, issue_number).
    // Status fields (worker_id, assigned_at, completed_at, issue_closed_at, pr_merged_at) are intentionally
    // omitted so that existing assignments and status are preserved — e.g. during startup sync.
    // For new tasks, those columns default to null in the DB schema.
    const { data, error } = await db.from("tasks").upsert(
      { task_id: taskId, issue_number: issueNumber, repo, title, body, labels },
      { onConflict: "task_id" },
    ).select().maybeSingle();
    if (error) throw error;
    Task.events.emit("changed");
    return new Task(data!);
  }

  // ── Instance mutations ──────────────────────────────────────────────────────

  async assign(workerId: string): Promise<void> {
    await this.save({ worker_id: workerId, assigned_at: new Date().toISOString() });
  }

  async complete(): Promise<void> {
    await this.save({ completed_at: new Date().toISOString() });
  }

  async revert(): Promise<void> {
    await this.save({ worker_id: null });
  }

  async close(): Promise<void> {
    await this.save({ issue_closed_at: new Date().toISOString() });
  }

  async reopen(): Promise<void> {
    await this.save({ issue_closed_at: null });
  }

  async registerPr(prNumber: number, branch: string | null): Promise<void> {
    await this.save({ pr_number: prNumber, branch });
  }

  async unregisterPr(): Promise<void> {
    await this.save({ pr_number: null, branch: null });
  }

  async mergePr(): Promise<void> {
    await this.save({ pr_merged_at: new Date().toISOString() });
  }

  async updateContent(title: string, body: string, labels: string[]): Promise<void> {
    await this.save({ title, body, labels });
  }

  async delete(): Promise<void> {
    const { error } = await db.from("tasks").delete().eq("task_id", this.taskId).is("assigned_at", null);
    if (error) throw error;
    Task.events.emit("changed");
  }
}
