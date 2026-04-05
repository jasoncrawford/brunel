import { EventEmitter } from "events";
import type { GitHubEvent, LabeledIssueState, TaskIssue, TaskStatus } from "./types.js";
import type { TaskStore } from "./db.js";
import { createNullTaskStore } from "./db.js";
import { isBlocked } from "./dependencies.js";
import type { DependencyGraph } from "./dependencies.js";
import type { TaskSnapshot } from "./admin-ws.js";


// ── Task ──────────────────────────────────────────────────────────────────────

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
  eventQueue: GitHubEvent[];
  /** True once fetchBlockers has resolved and the dependency graph is populated. */
  depsLoaded: boolean;
}


// ── TaskQueue (internal) ──────────────────────────────────────────────────────

class TaskQueue extends EventEmitter {
  private tasks = new Map<string, Task>();
  private prToTaskId = new Map<number, string>();
  private branchToTaskId = new Map<string, string>();

  addTask(t: Omit<Task, "status" | "assignedWorkerId" | "eventQueue" | "depsLoaded"> & Partial<Pick<Task, "status" | "eventQueue" | "depsLoaded">>) {
    this.tasks.set(t.taskId, {
      ...t,
      status: t.status ?? "pending",
      eventQueue: t.eventQueue ?? [],
      depsLoaded: t.depsLoaded ?? true,
    });
    this.emit("changed");
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  getTaskForIssue(issueNumber: number): Task | undefined {
    for (const t of this.tasks.values()) {
      if (t.issueNumber === issueNumber) return t;
    }
    return undefined;
  }

  nextPending(isReady?: (t: Task) => boolean): Task | null {
    for (const t of this.tasks.values()) {
      if (t.status === "pending" && (isReady === undefined || isReady(t))) return t;
    }
    return null;
  }

  assignTask(taskId: string, workerId: string) {
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.status = "assigned";
    t.assignedWorkerId = workerId;
    this.emit("changed");
  }

  completeTask(taskId: string) {
    const t = this.tasks.get(taskId);
    if (t) {
      t.status = "complete";
      this.emit("changed");
    }
  }

  revertTask(taskId: string) {
    const t = this.tasks.get(taskId);
    if (!t || t.status !== "assigned") return;
    t.status = "pending";
    t.assignedWorkerId = undefined;
    this.emit("changed");
  }

  setBlocked(taskId: string) {
    const t = this.tasks.get(taskId);
    if (!t || t.status !== "pending") return;
    t.status = "blocked";
    this.emit("changed");
  }

  setUnblocked(taskId: string) {
    const t = this.tasks.get(taskId);
    if (!t || t.status !== "blocked") return;
    t.status = "pending";
    this.emit("changed");
  }

  queueEvent(taskId: string, event: GitHubEvent) {
    const t = this.tasks.get(taskId);
    if (t) t.eventQueue.push(event);
  }

  drainEvents(taskId: string): GitHubEvent[] {
    const t = this.tasks.get(taskId);
    if (!t) return [];
    const events = t.eventQueue.slice();
    t.eventQueue = [];
    return events;
  }

  registerPr(prNumber: number, taskId: string) {
    this.prToTaskId.set(prNumber, taskId);
    const t = this.tasks.get(taskId);
    if (t) t.prNumber = prNumber;
    this.emit("changed");
  }

  unregisterPr(prNumber: number) {
    const taskId = this.prToTaskId.get(prNumber);
    this.prToTaskId.delete(prNumber);
    if (taskId) {
      const t = this.tasks.get(taskId);
      if (t) t.prNumber = undefined;
    }
    this.emit("changed");
  }

  getTaskForPr(prNumber: number): Task | undefined {
    const taskId = this.prToTaskId.get(prNumber);
    return taskId ? this.tasks.get(taskId) : undefined;
  }

  registerBranch(branch: string, taskId: string) {
    this.branchToTaskId.set(branch, taskId);
  }

  getTaskForBranch(branch: string): Task | undefined {
    const taskId = this.branchToTaskId.get(branch);
    return taskId ? this.tasks.get(taskId) : undefined;
  }

  removeTask(taskId: string) {
    const t = this.tasks.get(taskId);
    if (!t || (t.status !== "pending" && t.status !== "blocked")) return;
    this.tasks.delete(taskId);
    this.emit("changed");
  }

  getPendingTasks(): Task[] {
    return [...this.tasks.values()].filter((t) => t.status === "pending");
  }

  getPendingAndBlockedTasks(): Task[] {
    return [...this.tasks.values()].filter((t) => t.status === "pending" || t.status === "blocked");
  }

  markDepsLoaded(issueNumbers: number[]) {
    for (const n of issueNumbers) {
      const t = this.tasks.get(String(n));
      if (t) t.depsLoaded = true;
    }
    this.emit("changed");
  }

  getAssignedTaskForWorker(workerId: string): Task | undefined {
    for (const t of this.tasks.values()) {
      if (t.status === "assigned" && t.assignedWorkerId === workerId) return t;
    }
    return undefined;
  }

  getTaskSnapshots(graph?: DependencyGraph, openIssues?: Set<number>): TaskSnapshot[] {
    return [...this.tasks.values()].map((t) => {
      const snapshot: TaskSnapshot = {
        taskId: t.taskId,
        issueNumber: t.issueNumber,
        title: t.title,
        status: t.status,
        assignedWorkerId: t.assignedWorkerId,
        prNumber: t.prNumber,
        prUrl: t.prNumber !== undefined ? `${t.repoUrl}/pull/${t.prNumber}` : undefined,
      };
      if (graph !== undefined && openIssues !== undefined) {
        const blockerSet = graph.get(t.issueNumber) ?? new Set<number>();
        snapshot.blockers = Array.from(blockerSet).map((n) => ({
          issueNumber: n,
          isOpen: openIssues.has(n),
        }));
      }
      return snapshot;
    });
  }
}


// ── TaskModel ─────────────────────────────────────────────────────────────────
// Encapsulates paired in-memory (TaskQueue) + persistent (TaskStore) updates so
// every state transition touches both stores atomically.
//
// Also owns labeledIssues and openIssues — the cached mirrors of GitHub issue
// state — and exposes atomic issue-lifecycle methods so callers never have to
// keep these two maps in sync manually.
//
// TaskQueue is an internal implementation detail — callers interact with tasks
// exclusively through TaskModel methods.

export class TaskModel extends EventEmitter {
  private queue: TaskQueue;
  private store: TaskStore;
  private _labeledIssues: Map<number, LabeledIssueState>;
  private _openIssues: Set<number>;

  constructor(
    store?: TaskStore,
    labeledIssues = new Map<number, LabeledIssueState>(),
    openIssues = new Set<number>(),
  ) {
    super();
    this.queue = new TaskQueue();
    this.store = store ?? createNullTaskStore();
    this._labeledIssues = labeledIssues;
    this._openIssues = openIssues;

    // Forward "changed" events from the internal queue
    this.queue.on("changed", () => this.emit("changed"));
  }

  // ── Read operations (proxy to TaskQueue) ──────────────────────────────────

  get(taskId: string): Task | undefined {
    return this.queue.get(taskId);
  }

  getTaskForIssue(issueNumber: number): Task | undefined {
    return this.queue.getTaskForIssue(issueNumber);
  }

  getTaskForPr(prNumber: number): Task | undefined {
    return this.queue.getTaskForPr(prNumber);
  }

  getTaskForBranch(branch: string): Task | undefined {
    return this.queue.getTaskForBranch(branch);
  }

  getAssignedTaskForWorker(workerId: string): Task | undefined {
    return this.queue.getAssignedTaskForWorker(workerId);
  }

  nextPending(isReady?: (t: Task) => boolean): Task | null {
    return this.queue.nextPending(isReady);
  }

  getPendingAndBlockedTasks(): Task[] {
    return this.queue.getPendingAndBlockedTasks();
  }

  // ── Memory-only write operations ──────────────────────────────────────────

  queueEvent(taskId: string, event: GitHubEvent): void {
    this.queue.queueEvent(taskId, event);
  }

  drainEvents(taskId: string): GitHubEvent[] {
    return this.queue.drainEvents(taskId);
  }

  registerBranch(branch: string, taskId: string): void {
    this.queue.registerBranch(branch, taskId);
  }

  /** Update in-memory assignment without touching DB (used for reconnection reclaim). */
  assignInMemory(taskId: string, workerId: string): void {
    this.queue.assignTask(taskId, workerId);
  }

  /** Load a task from a DB row into the in-memory queue (used at startup).
   *  Does NOT write to the DB — the row already exists. */
  loadTask(row: {
    taskId: string;
    issueNumber: number;
    title: string;
    body: string;
    labels: string[];
    repoUrl: string;
    status?: TaskStatus;
    workerId?: string | null;
    prNumber?: number | null;
    branch?: string | null;
    depsLoaded?: boolean;
  }): void {
    this.queue.addTask({
      taskId: row.taskId,
      issueNumber: row.issueNumber,
      title: row.title,
      body: row.body,
      labels: row.labels,
      repoUrl: row.repoUrl,
      status: row.status,
      depsLoaded: row.depsLoaded,
    });
    if (row.workerId) this.queue.assignTask(row.taskId, row.workerId);
    if (row.prNumber != null) this.queue.registerPr(row.prNumber, row.taskId);
    if (row.branch) this.queue.registerBranch(row.branch, row.taskId);
  }

  // ── Issue-lifecycle methods ───────────────────────────────────────────────

  /** Whether the issue is currently tracked (has the brunel:ready label). */
  isTracked(issueNumber: number): boolean { return this._labeledIssues.has(issueNumber); }

  /** Read-only view of tracked labeled issues — used by reconcile() for iteration. */
  getLabeledIssues(): ReadonlyMap<number, LabeledIssueState> { return this._labeledIssues; }

  /** Whether the issue is blocked by an open dependency. */
  isBlocked(issueNumber: number, graph: DependencyGraph): boolean {
    return isBlocked(issueNumber, graph, this._openIssues);
  }

  /** Task snapshots with open-issue state baked in — for admin broadcasts. */
  getTaskSnapshots(graph: DependencyGraph): TaskSnapshot[] {
    return this.queue.getTaskSnapshots(graph, this._openIssues);
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

  /** Called when issues/closed fires: stop tracking and mark any active task complete.
   *  Handles pending and blocked tasks too — not just assigned ones — so that DB rows
   *  are always finalised regardless of whether a worker was active. (Bug #489) */
  async closeIssue(issueNumber: number): Promise<void> {
    this._labeledIssues.delete(issueNumber);
    this._openIssues.delete(issueNumber);
    const task = this.queue.getTaskForIssue(issueNumber);
    if (task && task.status !== "complete") {
      await this.complete(task.taskId);
    }
  }

  /** Called when issues/reopened fires: mark the issue open again. */
  reopenIssue(issueNumber: number): void {
    this._openIssues.add(issueNumber);
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

  // ── Task-lifecycle methods (memory + DB) ──────────────────────────────────

  async complete(taskId: string): Promise<void> {
    this.queue.completeTask(taskId);
    await this.store.markComplete(taskId);
  }

  async revert(taskId: string): Promise<void> {
    this.queue.revertTask(taskId);
    await this.store.markPending(taskId);
  }

  async block(taskId: string): Promise<void> {
    this.queue.setBlocked(taskId);
    await this.store.markBlocked(taskId);
  }

  async unblock(taskId: string): Promise<void> {
    this.queue.setUnblocked(taskId);
    await this.store.markPending(taskId);
  }

  async refreshContent(taskId: string, title: string, body: string, labels: string[], depsLoaded?: boolean): Promise<void> {
    const t = this.queue.get(taskId);
    if (t) {
      t.title = title;
      t.body = body;
      t.labels = labels;
      if (depsLoaded !== undefined) t.depsLoaded = depsLoaded;
    }
    await this.store.updateTaskContent(taskId, title, body, labels);
  }

  async register(
    taskId: string,
    issueNumber: number,
    repoSlug: string,
    title: string,
    body: string,
    labels: string[],
    repoUrl: string,
    depsLoaded?: boolean,
  ): Promise<void> {
    this.queue.addTask({ taskId, issueNumber, title, body, labels, repoUrl, depsLoaded });
    await this.store.upsertTask(taskId, issueNumber, repoSlug, title, body, labels);
  }

  async cancel(taskId: string): Promise<void> {
    this.queue.removeTask(taskId);
    await this.store.deleteTask(taskId);
  }

  async registerPr(taskId: string, prNumber: number, branch: string | null): Promise<void> {
    this.queue.registerPr(prNumber, taskId);
    await this.store.updateTaskPr(taskId, prNumber, branch);
  }

  async unregisterPr(prNumber: number): Promise<void> {
    const task = this.queue.getTaskForPr(prNumber);
    this.queue.unregisterPr(prNumber);
    if (task) {
      await this.store.updateTaskPr(task.taskId, null, null);
    }
  }

  /** Restore a task into the in-memory queue from the DB record.
   *  Used when a worker reconnects claiming a task that's not in memory (e.g. issue
   *  was closed mid-task, marking the DB row complete, which startup skips).
   *  Falls back to empty placeholder if the DB row is missing. */
  async restoreFromDb(taskId: string, issueNumber: number): Promise<void> {
    const row = await this.store.getTask(taskId);
    this.queue.addTask({
      taskId,
      issueNumber: row?.issueNumber ?? issueNumber,
      title: row?.title ?? "",
      body: row?.body ?? "",
      labels: row?.labels ?? [],
      repoUrl: row ? `https://github.com/${row.repo}` : "",
    });
  }

  /** Assigns a task to a worker. Awaits the DB write; reverts memory and returns
   *  false if the write fails so the caller can release the worker. */
  async assign(taskId: string, workerId: string): Promise<boolean> {
    this.queue.assignTask(taskId, workerId);
    try {
      await this.store.markAssigned(taskId, workerId);
      return true;
    } catch {
      this.queue.revertTask(taskId);
      return false;
    }
  }
}
