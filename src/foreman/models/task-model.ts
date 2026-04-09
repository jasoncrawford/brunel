import { EventEmitter } from "events";
import type { GitHubEvent, LabeledIssueState, TaskIssue, TaskStatus } from "../../types.js";
import type { TaskStore, TaskRow, ListTasksOpts } from "../db.js";
import { createMemoryTaskStore, createTaskStore } from "../db.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isBlocked } from "../dependencies.js";
import type { DependencyGraph } from "../dependencies.js";
import type { TaskSnapshot } from "../admin-ws.js";
import { loadIssuesToQueue } from "../github.js";
import { fmtError } from "../../utils.js";


// ── Status derivation ─────────────────────────────────────────────────────────
// Status is derived from timestamps and task properties, not stored in DB.

export function deriveStatus(row: TaskRow, isBlockedByDeps = false): TaskStatus {
  if (row.completedAt) return "complete";
  if (row.issueClosedAt) return "closed";
  if (row.prMergedAt) return "merged";
  if (row.prNumber) return "pushed";
  if (row.workerId) return "assigned";
  if (isBlockedByDeps) return "blocked";
  return "pending";
}


// ── Task ──────────────────────────────────────────────────────────────────────
// Read-only view of a task, constructed from a TaskRow.  Callers receive this
// from TaskModel read methods; mutations go through TaskModel write methods.

export interface Task {
  taskId: string;
  issueNumber: number;
  title: string;
  body: string;
  labels: string[];
  repoUrl: string;
  status: TaskStatus;
  assignedWorkerId?: string;
  prNumber?: number;
  branch?: string;
}

export function rowToTask(row: TaskRow): Task {
  return {
    taskId: row.taskId,
    issueNumber: row.issueNumber,
    title: row.title,
    body: row.body,
    labels: row.labels,
    repoUrl: `https://github.com/${row.repo}`,
    status: deriveStatus(row),
    assignedWorkerId: row.workerId ?? undefined,
    prNumber: row.prNumber ?? undefined,
    branch: row.branch ?? undefined,
  };
}


// ── TaskModel ─────────────────────────────────────────────────────────────────
// Single owner of all task state.  Reads and writes go through the TaskStore
// (Supabase in production, in-memory store for local dev / tests).  There is no
// in-memory cache — the store IS the source of truth.
//
// The only in-memory state is ephemeral data with no DB backing:
//   - Event queues: buffered GitHub events for pending/disconnected workers
//   - Branch mappings: branch→taskId for routing check_run/check_suite events
//   - GitHub issue tracking: labeledIssues + openIssues for dependency resolution
//
// Emits "changed" after every write so the admin dashboard can refresh.

export class TaskModel extends EventEmitter {
  // ── Persistent store (sole source of truth for task data) ─────────────────
  private store: TaskStore;

  // ── Ephemeral in-memory state (no DB backing) ────────────────────────────
  private eventQueues = new Map<string, GitHubEvent[]>();
  private branchToTaskId = new Map<string, string>();

  // ── GitHub issue state ────────────────────────────────────────────────────
  private _labeledIssues: Map<number, LabeledIssueState>;
  private _openIssues: Set<number>;

  static create(supabase?: SupabaseClient): TaskModel {
    const store = supabase ? createTaskStore(supabase) : createMemoryTaskStore();
    return new TaskModel(store);
  }

  constructor(store?: TaskStore) {
    super();
    this.store = store ?? createMemoryTaskStore();
    this._labeledIssues = new Map();
    this._openIssues = new Set();
  }

  // ── Read operations (async — always reads from store) ─────────────────────

  async get(taskId: string): Promise<Task | null> {
    const row = await this.store.getTask(taskId);
    return row ? rowToTask(row) : null;
  }

  async getTaskForIssue(issueNumber: number): Promise<Task | null> {
    const row = await this.store.getTaskByIssue(issueNumber);
    return row ? rowToTask(row) : null;
  }

  async getTaskForPr(prNumber: number): Promise<Task | null> {
    const row = await this.store.getTaskByPr(prNumber);
    return row ? rowToTask(row) : null;
  }

  async getTaskForBranch(branch: string): Promise<Task | null> {
    // Branch mapping is ephemeral (set before DB write completes).
    // Check ephemeral map first, fall back to DB query.
    const taskId = this.branchToTaskId.get(branch);
    if (taskId) {
      const row = await this.store.getTask(taskId);
      return row ? rowToTask(row) : null;
    }
    return null;
  }

  async getAssignedTaskForWorker(workerId: string): Promise<Task | null> {
    const row = await this.store.getTaskByWorker(workerId);
    return row ? rowToTask(row) : null;
  }

  async nextPending(isReady?: (t: Task) => boolean): Promise<Task | null> {
    const rows = await this.store.listTasks({ cancelable: true });
    for (const row of rows) {
      const task = rowToTask(row);
      if (isReady === undefined || isReady(task)) return task;
    }
    return null;
  }

  /** All active (non-complete) tasks — used by the dashboard task list API and dependency resolution. */
  async listActiveTasks(): Promise<Task[]> {
    const rows = await this.store.listTasks();
    return rows.filter((row) => !row.completedAt).map(rowToTask);
  }

  // ── Memory-only write operations (ephemeral data) ─────────────────────────

  queueEvent(taskId: string, event: GitHubEvent): void {
    let queue = this.eventQueues.get(taskId);
    if (!queue) { queue = []; this.eventQueues.set(taskId, queue); }
    queue.push(event);
  }

  drainEvents(taskId: string): GitHubEvent[] {
    const queue = this.eventQueues.get(taskId);
    if (!queue || queue.length === 0) return [];
    this.eventQueues.delete(taskId);
    return queue;
  }

  registerBranch(branch: string, taskId: string): void {
    this.branchToTaskId.set(branch, taskId);
  }

  // ── Issue-lifecycle methods ───────────────────────────────────────────────

  /** Whether the issue is currently tracked (has the brunel:ready label). */
  isTracked(issueNumber: number): boolean { return this._labeledIssues.has(issueNumber); }

  /** Read-only view of tracked labeled issues — used by reconcile() for iteration. */
  getLabeledIssues(): ReadonlyMap<number, LabeledIssueState> { return this._labeledIssues; }

  /** Whether deps have been loaded for this issue. */
  isDepsLoaded(issueNumber: number): boolean {
    const entry = this._labeledIssues.get(issueNumber);
    return entry?.depsLoaded ?? false;
  }

  /** Whether the issue is blocked by an open dependency. */
  isBlocked(issueNumber: number, graph: DependencyGraph): boolean {
    return isBlocked(issueNumber, graph, this._openIssues);
  }

  /** Task snapshots with open-issue state baked in — for admin broadcasts.
   *  Complete tasks are excluded: the dashboard only shows active tasks. */
  async getTaskSnapshots(graph: DependencyGraph): Promise<TaskSnapshot[]> {
    const rows = await this.store.listTasks();
    return rows.filter((row) => !row.completedAt).map((row) => {
      const isBlockedByDeps = graph !== undefined && this.isBlocked(row.issueNumber, graph);
      const snapshot: TaskSnapshot = {
        taskId: row.taskId,
        issueNumber: row.issueNumber,
        title: row.title,
        status: deriveStatus(row, isBlockedByDeps),
        assignedWorkerId: row.workerId ?? undefined,
        prNumber: row.prNumber ?? undefined,
        prUrl: row.prNumber != null ? `https://github.com/${row.repo}/pull/${row.prNumber}` : undefined,
      };
      if (graph !== undefined) {
        const blockerSet = graph.get(row.issueNumber) ?? new Set<number>();
        snapshot.blockers = Array.from(blockerSet).map((n) => ({
          issueNumber: n,
          isOpen: this._openIssues.has(n),
        }));
      }
      return snapshot;
    });
  }

  /** Called when issues/labeled fires: begin tracking the issue. */
  trackIssue(issueNumber: number, issue: TaskIssue, depsLoaded = false): void {
    this._labeledIssues.set(issueNumber, { issue, depsLoaded });
    this._openIssues.add(issueNumber);
  }

  /** Called when the brunel:ready label is removed: stop tracking the issue. */
  untrackIssue(issueNumber: number): void {
    this._labeledIssues.delete(issueNumber);
    this._openIssues.delete(issueNumber);
  }

  /** Called when issues/closed fires: mark the issue as closed.
   *  Handles pending and blocked tasks too — not just assigned ones — so that DB rows
   *  are always finalised regardless of whether a worker was active. (Bug #489) */
  async closeIssue(issueNumber: number): Promise<void> {
    this._labeledIssues.delete(issueNumber);
    this._openIssues.delete(issueNumber);
    const task = await this.getTaskForIssue(issueNumber);
    if (task && task.status !== "complete") {
      await this.store.setIssueClosed(task.taskId);
      this.emit("changed");
    }
  }

  /** Called when issues/reopened fires: mark the issue open again. */
  async reopenIssue(issueNumber: number): Promise<void> {
    this._openIssues.add(issueNumber);
    const task = await this.getTaskForIssue(issueNumber);
    if (task) {
      await this.store.clearIssueClosed(task.taskId);
      this.emit("changed");
    }
  }

  /** Called when issues/edited fires with a body change: reset deps and update body. */
  resetIssueDeps(issueNumber: number, newBody: string): void {
    const entry = this._labeledIssues.get(issueNumber);
    if (entry) {
      entry.depsLoaded = false;
      entry.issue = { ...entry.issue, body: newBody };
    }
  }

  /** Called after fetchBlockers resolves: mark deps as fully loaded. */
  markIssueDepsLoaded(issueNumber: number): void {
    const entry = this._labeledIssues.get(issueNumber);
    if (entry) entry.depsLoaded = true;
  }

  /** Update the open/closed state of any referenced issue (used by fetchBlockers). */
  setIssueOpenState(issueNumber: number, isOpen: boolean): void {
    if (isOpen) this._openIssues.add(issueNumber);
    else this._openIssues.delete(issueNumber);
  }

  // ── Startup methods ────────────────────────────────────────────────────────

  /** Register ephemeral branch mappings from DB at startup. */
  async loadActiveTasksFromDb(flog: (msg: string) => void): Promise<void> {
    const activeTasks = await this.listTasks();
    for (const row of activeTasks) {
      if (row.completedAt) continue;
      if (row.branch) this.branchToTaskId.set(row.branch, row.taskId);
      const status = deriveStatus(row);
      flog(`[startup] restored task #${row.taskId} (${status})`);
    }
  }

  /** Fetch brunel:ready issues from GitHub and load deps.
   *  Called at startup after loadActiveTasksFromDb. */
  async loadIssuesFromGithub(
    graph: DependencyGraph,
    config: { githubRepo: string; githubToken: string; taskLabel: string; githubApiUrl?: string },
    flog: (msg: string) => void,
  ): Promise<void> {
    await loadIssuesToQueue(this, graph, config);
  }

  // ── Task-lifecycle methods (write to store, emit changed) ─────────────────

  async complete(taskId: string): Promise<void> {
    await this.store.markComplete(taskId);
    this.emit("changed");
  }

  async revert(taskId: string): Promise<void> {
    await this.store.markPending(taskId);
    this.emit("changed");
  }

  async refreshContent(taskId: string, title: string, body: string, labels: string[]): Promise<void> {
    await this.store.updateTaskContent(taskId, title, body, labels);
    this.emit("changed");
  }

  async register(
    taskId: string,
    issueNumber: number,
    repoSlug: string,
    title: string,
    body: string,
    labels: string[],
  ): Promise<void> {
    await this.store.upsertTask(taskId, issueNumber, repoSlug, title, body, labels);
    this.emit("changed");
  }

  async cancel(taskId: string): Promise<void> {
    await this.store.deleteTask(taskId);
    this.emit("changed");
  }

  async registerPr(taskId: string, prNumber: number, branch: string | null): Promise<void> {
    await this.store.updateTaskPr(taskId, prNumber, branch);
    this.emit("changed");
  }

  async unregisterPr(prNumber: number): Promise<void> {
    const task = await this.getTaskForPr(prNumber);
    if (task) {
      await this.store.updateTaskPr(task.taskId, null, null);
      this.emit("changed");
    }
  }

  async registerPrMerge(prNumber: number): Promise<void> {
    const task = await this.getTaskForPr(prNumber);
    if (task) {
      await this.store.setPrMerged(task.taskId);
      this.emit("changed");
    }
  }

  async listTasks(opts?: ListTasksOpts): Promise<TaskRow[]> {
    return this.store.listTasks(opts);
  }

  /** Assigns a task to a worker. Returns false if the DB write fails. */
  async assign(taskId: string, workerId: string): Promise<boolean> {
    try {
      await this.store.markAssigned(taskId, workerId);
      this.emit("changed");
      return true;
    } catch {
      return false;
    }
  }
}
