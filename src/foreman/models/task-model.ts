import { EventEmitter } from "events";
import type { GitHubEvent, LabeledIssueState, TaskIssue } from "../../types.js";
import { isBlocked } from "../dependencies.js";
import type { DependencyGraph } from "../dependencies.js";
import type { TaskSnapshot } from "../admin-ws.js";
import { loadIssuesToQueue } from "../github.js";
import { Task } from "./task.js";


// ── TaskManager ────────────────────────────────────────────────────────────────
// Owns all ephemeral in-memory state (event queues, branch mappings, issue
// tracking) that has no DB backing.  DB reads/writes go through Task statics
// and instance methods.
//
// Emits "changed" (via the initTask onChange callback) after every write so
// the admin dashboard can refresh.

export class TaskManager extends EventEmitter {
  // ── Ephemeral in-memory state (no DB backing) ────────────────────────────
  private eventQueues = new Map<string, GitHubEvent[]>();
  private branchToTaskId = new Map<string, string>();

  // ── GitHub issue state ────────────────────────────────────────────────────
  private _labeledIssues: Map<number, LabeledIssueState>;
  private _openIssues: Set<number>;

  constructor() {
    super();
    this._labeledIssues = new Map();
    this._openIssues = new Set();
  }

  // ── Read operations (async — always reads from Task statics) ──────────────

  async getTaskForBranch(branch: string): Promise<Task | null> {
    const taskId = this.branchToTaskId.get(branch);
    if (taskId) {
      return Task.get(taskId);
    }
    return null;
  }

  async nextPending(isReady?: (t: Task) => boolean): Promise<Task | null> {
    const tasks = await Task.list({ cancelable: true });
    for (const task of tasks) {
      if (isReady === undefined || isReady(task)) return task;
    }
    return null;
  }

  /** All active (non-complete) tasks — used by the dashboard task list API and dependency resolution. */
  async listActiveTasks(): Promise<Task[]> {
    const tasks = await Task.list();
    return tasks.filter((t) => !t.completedAt);
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
    const tasks = await Task.list();
    return tasks.filter((t) => !t.completedAt).map((t) => t.toSnapshot(graph, this._openIssues));
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

  /** Called when issues/closed fires: mark the issue as closed. */
  async closeIssue(issueNumber: number): Promise<void> {
    this._labeledIssues.delete(issueNumber);
    this._openIssues.delete(issueNumber);
    const task = await Task.getByIssue(issueNumber);
    if (task && task.status !== "complete") {
      await task.close();
    }
  }

  /** Called when issues/reopened fires: mark the issue open again. */
  async reopenIssue(issueNumber: number): Promise<void> {
    this._openIssues.add(issueNumber);
    const task = await Task.getByIssue(issueNumber);
    if (task) {
      await task.reopen();
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
    const tasks = await Task.list();
    for (const task of tasks) {
      if (task.completedAt) continue;
      if (task.branch) this.branchToTaskId.set(task.branch, task.taskId);
      flog(`[startup] restored task #${task.taskId} (${task.status})`);
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
}

