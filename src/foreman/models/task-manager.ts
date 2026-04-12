import { EventEmitter } from "events";
import type { WebhookEvent } from "./webhook-event.js";
import * as Wire from "../../../shared/wire.js";
import { loadIssuesToQueue } from "../github.js";
import { EventQueue } from "../event-queue.js";
import { Task } from "./task.js";


// ── TaskManager ────────────────────────────────────────────────────────────────
// Owns all ephemeral in-memory state (event queues, branch mappings, open-issue
// tracking, blocker state) that has no DB backing.  DB reads/writes go through
// Task statics and instance methods.
//
// Emits "changed" after every Task mutation (by subscribing to Task.events)
// and after every worker registry change so the admin dashboard can refresh.

export class TaskManager extends EventEmitter {
  // ── Ephemeral in-memory state (no DB backing) ────────────────────────────
  private eventQueue = new EventQueue();
  private branchToTaskId = new Map<string, string>();

  // ── GitHub issue state ────────────────────────────────────────────────────
  /** Open issues that are blockers (non-task issues whose open/closed state
   *  determines whether dependent tasks are blocked). Also includes labeled
   *  task issues so that a task blocking another task is tracked correctly. */
  private _openIssues: Set<number>;

  // ── Per-issue blocker state (replaces DependencyGraph + LabeledIssueState.depsLoaded) ──
  private _blockers: Map<number, number[]>;
  private _blockersLoaded: Set<number>;

  constructor() {
    super();
    this._openIssues = new Set();
    this._blockers = new Map();
    this._blockersLoaded = new Set();
    Task.events.on("changed", () => this.emit("changed"));
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
      this.hydrateBlockers(task);
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

  queueEvent(taskId: string, event: WebhookEvent): void {
    this.eventQueue.enqueue(taskId, event);
  }

  drainEvents(taskId: string): WebhookEvent[] {
    return this.eventQueue.drain(taskId);
  }

  registerBranch(branch: string, taskId: string): void {
    this.branchToTaskId.set(branch, taskId);
  }

  // ── Issue-lifecycle methods ───────────────────────────────────────────────

  /** Mark issue as open in memory (used for test setup and startup tracking). */
  trackIssue(issueNumber: number): void {
    this._openIssues.add(issueNumber);
  }

  /** Track issue as open and persist it to DB. Called when issues/labeled fires. */
  async enqueueIssue(taskId: string, issueNumber: number, repo: string, title: string, body: string, labels: string[]): Promise<void> {
    this._openIssues.add(issueNumber);
    await Task.upsert(taskId, issueNumber, repo, title, body, labels);
  }

  /** Stop tracking issue and remove it from DB. Called when brunel:ready label is removed. */
  async dequeueIssue(issueNumber: number): Promise<void> {
    this._openIssues.delete(issueNumber);
    this._blockers.delete(issueNumber);
    this._blockersLoaded.delete(issueNumber);
    const task = await Task.getByIssue(issueNumber);
    if (task) await task.delete();
  }

  /** Called when issues/closed fires: mark the issue as closed.
   *  Tasks that were ever assigned (assigned_at IS NOT NULL) are kept for historical purposes.
   *  Tasks that were never assigned are deleted — task.delete() is a no-op when assigned_at is set. */
  async closeIssue(issueNumber: number): Promise<void> {
    this._openIssues.delete(issueNumber);
    const task = await Task.getByIssue(issueNumber);
    if (!task || task.status === "complete") return;
    await task.close();
    await task.delete(); // no-op if ever assigned (assigned_at IS NOT NULL)
  }

  /** Called when issues/reopened fires: mark the issue open again. */
  async reopenIssue(issueNumber: number): Promise<void> {
    this._openIssues.add(issueNumber);
    const task = await Task.getByIssue(issueNumber);
    if (task) {
      await task.reopen();
    }
  }

  /** Update the open/closed state of any referenced issue (used by fetchBlockers). */
  setIssueOpenState(issueNumber: number, isOpen: boolean): void {
    if (isOpen) this._openIssues.add(issueNumber);
    else this._openIssues.delete(issueNumber);
  }

  // ── Blocker state management (replaces DependencyGraph + isDepsLoaded) ────

  /** Store the merged set of blockers for an issue (from body + GitHub native). */
  setBlockers(issueNumber: number, blockers: number[]): void {
    this._blockers.set(issueNumber, blockers);
  }

  /** Mark that all blockers have been fetched for this issue. */
  markBlockersLoaded(issueNumber: number): void {
    this._blockersLoaded.add(issueNumber);
  }

  /** Reset blocker state (called when issue body changes — deps must be re-fetched). */
  resetBlockers(issueNumber: number): void {
    this._blockers.delete(issueNumber);
    this._blockersLoaded.delete(issueNumber);
  }

  /** Whether blockers have been fully loaded for this issue. */
  isBlockersLoaded(issueNumber: number): boolean {
    return this._blockersLoaded.has(issueNumber);
  }

  /** Whether any blocker for this issue is currently open. */
  isBlocked(issueNumber: number): boolean {
    const blockers = this._blockers.get(issueNumber);
    if (!blockers || blockers.length === 0) return false;
    return blockers.some(b => this._openIssues.has(b));
  }

  /** Active tasks with open-issue state baked in — for admin broadcasts.
   *  Complete tasks are excluded: the dashboard only shows active tasks. */
  async getTasksForBroadcast(): Promise<Wire.Task[]> {
    const tasks = await Task.list();
    return tasks.filter((t) => !t.completedAt).map((t) => {
      this.hydrateBlockers(t);
      return t.toWire();
    });
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
    config: { githubRepo: string; githubToken: string; taskLabel: string; githubApiUrl?: string },
    flog: (msg: string) => void,
  ): Promise<void> {
    await loadIssuesToQueue(this, config);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Annotate a task with in-memory blocker state (including open/closed per blocker) before returning it. */
  private hydrateBlockers(task: Task): void {
    const nums = this._blockers.get(task.issueNumber) ?? [];
    task.blockers = nums.map(n => ({ issueNumber: n, isOpen: this._openIssues.has(n) }));
    task.blockersLoaded = this._blockersLoaded.has(task.issueNumber);
  }
}
