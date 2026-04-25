import { EventEmitter } from "node:events";
import type { WebhookEvent } from "./webhook-event.js";
import * as Wire from "../../../shared/wire.js";
import { loadIssuesToQueue, fetchIssueStates, fetchNativeBlockers } from "../clients/github.js";
import { EventQueue } from "./event-queue.js";
import { Task } from "./task.js";
import { Worker } from "./worker.js";
import { fmtError, log } from "../../utils.js";
import type { Repo } from "./repo.js";


// ── TaskManager ────────────────────────────────────────────────────────────────
// One instance per repo. Owns all ephemeral in-memory state (event queues,
// branch mappings, open-issue tracking, blocker state) scoped to a single repo.
// DB reads/writes go through Task statics and instance methods.
//
// Emits "changed" after every Task mutation (by subscribing to Task.events)
// and after every worker registry change so the admin dashboard can refresh.
// Static `events` emitter aggregates all per-instance events for cross-repo
// subscribers (e.g. admin dashboard, work assignment).

export type AssignOutcome =
  | { ok: true; task: Task; queued: WebhookEvent[]; worker: Worker }
  | { ok: false; worker: Worker; err: unknown };

export class TaskManager extends EventEmitter {
  // ── Static registry ──────────────────────────────────────────────────────
  private static registry = new Map<number, TaskManager>();
  static readonly events = new EventEmitter();

  /** Find or create the TaskManager for a given repo. */
  static forRepo(repo: Repo): TaskManager {
    let tm = TaskManager.registry.get(repo.id);
    if (!tm) {
      tm = new TaskManager(repo);
      TaskManager.registry.set(repo.id, tm);
    }
    return tm;
  }

  /** Look up the TaskManager for a repo ID. Throws if not registered — used by Task.manager
   *  where the TaskManager is guaranteed to exist (tasks can only be created via a TaskManager). */
  static forRepoId(repoId: number): TaskManager {
    const tm = TaskManager.registry.get(repoId);
    if (!tm) throw new Error(`No TaskManager registered for repo ID ${repoId}`);
    return tm;
  }

  /** All active TaskManager instances (one per known repo). */
  static all(): TaskManager[] {
    return Array.from(TaskManager.registry.values());
  }

  /** Aggregate active tasks from all repos for admin broadcast. */
  static async getAllTasksForBroadcast(): Promise<Wire.Task[]> {
    return (await Promise.all(TaskManager.all().map(tm => tm.getTasksForBroadcast()))).flat();
  }

  /** Reset the registry — for tests only. */
  static _resetRegistry(): void {
    for (const tm of TaskManager.registry.values()) {
      Task.events.off("changed", tm._onTaskChanged);
    }
    TaskManager.registry.clear();
    TaskManager.events.removeAllListeners();
  }

  // ── Instance state ───────────────────────────────────────────────────────
  readonly repo: Repo;

  // ── Ephemeral in-memory state (no DB backing) ────────────────────────────
  private eventQueue = new EventQueue();
  private branchToTaskId = new Map<string, string>();
  private assignLock = Promise.resolve();

  // ── GitHub issue state ────────────────────────────────────────────────────
  /** Open issues that are blockers (non-task issues whose open/closed state
   *  determines whether dependent tasks are blocked). Also includes labeled
   *  task issues so that a task blocking another task is tracked correctly. */
  private _openIssues: Set<number>;

  // ── Per-issue blocker state (replaces DependencyGraph + LabeledIssueState.depsLoaded) ──
  private _blockers: Map<number, number[]>;
  private _blockersLoaded: Set<number>;

  private _onTaskChanged = () => this.emit("changed");

  constructor(repo: Repo) {
    super();
    this.repo = repo;
    this._openIssues = new Set();
    this._blockers = new Map();
    this._blockersLoaded = new Set();
    Task.events.on("changed", this._onTaskChanged);
    // Forward instance events to static aggregator
    this.on("changed", () => TaskManager.events.emit("changed"));
    this.on("deps_loaded", () => TaskManager.events.emit("deps_loaded", this));
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

  /** Assign pending tasks to all idle workers.
   *  Uses a mutex (assignLock) to prevent concurrent calls from double-assigning.
   *  Returns the list of assignment outcomes for the caller to act on. */
  async assignIdleWorkers(): Promise<AssignOutcome[]> {
    return new Promise((resolve) => {
      this.assignLock = this.assignLock.then(async () => {
        const outcomes: AssignOutcome[] = [];
        for (const worker of Worker.getIdle()) {
          const outcome = await this.tryAssignWork(worker);
          if (outcome) outcomes.push(outcome);
        }
        resolve(outcomes);
      });
    });
  }

  private async tryAssignWork(worker: Worker): Promise<AssignOutcome | null> {
    if (worker.repo.status !== "active") return null;
    const task = await this.nextPending(
      t => t.blockersLoaded && t.status === "pending" && t.repoId === worker.repo.id,
    );
    if (!task) return null;
    worker.assign(task);
    try {
      await task.assign(worker);
      return { ok: true, task, queued: this.drainEvents(task), worker };
    } catch (err) {
      worker.release();
      return { ok: false, worker, err };
    }
  }

  // ── Memory-only write operations (ephemeral data) ─────────────────────────

  queueEvent(task: Task, event: WebhookEvent): void {
    this.eventQueue.enqueue(task, event);
  }

  drainEvents(task: Task): WebhookEvent[] {
    return this.eventQueue.drain(task);
  }

  registerBranch(branch: string, task: Task): void {
    this.branchToTaskId.set(branch, task.taskId);
  }

  // ── Issue-lifecycle methods ───────────────────────────────────────────────

  /** Mark issue as open in memory (used for test setup and startup tracking). */
  trackIssue(issueNumber: number): void {
    this._openIssues.add(issueNumber);
  }

  /** Track issue as open and persist it to DB. Called when issues/labeled fires. */
  async enqueueIssue(taskId: string, issueNumber: number, repo: string, title: string, body: string, labels: string[]): Promise<Task> {
    this._openIssues.add(issueNumber);
    return Task.upsert(taskId, issueNumber, repo, title, body, labels);
  }

  /** Stop tracking issue and remove it from DB. Called when brunel:ready label is removed. */
  async dequeueIssue(issueNumber: number): Promise<void> {
    this._openIssues.delete(issueNumber);
    this._blockers.delete(issueNumber);
    this._blockersLoaded.delete(issueNumber);
    const task = await this.repo.getTaskByIssue(issueNumber);
    if (task) await task.deleteIfUnassigned();
  }

  /** Called when issues/closed fires: mark the issue as closed.
   *  Tasks that were ever assigned (assigned_at IS NOT NULL) are kept for historical purposes.
   *  Tasks that were never assigned are deleted — deleteIfUnassigned() is a no-op when assigned_at is set. */
  async closeIssue(issueNumber: number): Promise<void> {
    this._openIssues.delete(issueNumber);
    const task = await this.repo.getTaskByIssue(issueNumber);
    if (!task || task.status === "complete") return;
    await task.close();
    await task.deleteIfUnassigned(); // no-op if ever assigned (assigned_at IS NOT NULL)
  }

  /** Called when issues/reopened fires: mark the issue open again. */
  async reopenIssue(issueNumber: number): Promise<void> {
    this._openIssues.add(issueNumber);
    const task = await this.repo.getTaskByIssue(issueNumber);
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

  /** Active tasks for this repo with open-issue state baked in — for admin broadcasts.
   *  Complete tasks are excluded: the dashboard only shows active tasks. */
  async getTasksForBroadcast(): Promise<Wire.Task[]> {
    const tasks = await Task.list({ repoId: this.repo.id });
    return tasks.filter((t) => !t.completedAt).map((t) => {
      this.hydrateBlockers(t);
      return t.toWire();
    });
  }

  // ── Startup methods ────────────────────────────────────────────────────────

  /** Register ephemeral branch mappings from DB at startup. */
  async loadActiveTasksFromDb(): Promise<void> {
    const tasks = await Task.list();
    for (const task of tasks) {
      if (task.completedAt) continue;
      if (task.branch) this.registerBranch(task.branch, task);
      log(`[startup] restored task #${task.taskId} (${task.status})`);
    }
  }

  /** Fetch all blockers for an issue from body text and GitHub native relationships. */
  async fetchBlockers(issueNumber: number, body: string): Promise<number[]> {
    const [bodyBlockers, nativeBlockers] = await Promise.all([
      Task.parseBodyBlockers(body),
      fetchNativeBlockers(issueNumber, this.repo.fullName),
    ]);
    return Array.from(new Set([...bodyBlockers, ...nativeBlockers]));
  }

  /** Fetch and store blocker state for an issue. Called when a task is first
   *  enqueued or when its body is edited. Fire-and-forget from the caller. */
  async fetchAndLoadDeps(
    issueNumber: number,
    body: string,
  ): Promise<void> {
    const blockers = await this.fetchBlockers(issueNumber, body);
    this.setBlockers(issueNumber, blockers);
    if (blockers.length > 0) {
      const states = await fetchIssueStates(blockers, this.repo.fullName);
      for (const [num, state] of states) {
        this.setIssueOpenState(num, state === "open");
      }
    }
    this.markBlockersLoaded(issueNumber);
  }

  /** Fire-and-forget wrapper: calls fetchAndLoadDeps then emits "deps_loaded" so the
   *  controller can trigger work assignment without knowing about async deps loading. */
  startDepsLoad(
    issueNumber: number,
    body: string,
  ): void {
    this.fetchAndLoadDeps(issueNumber, body)
      .then(() => this.emit("deps_loaded"))
      .catch((err) => log(`ERROR fetching deps for #${issueNumber}: ${fmtError(err)}`));
  }

  // ── Issue event handlers ───────────────────────────────────────────────────

  /** Handle issues/labeled or issues/opened: enqueue the issue and start dep loading.
   *  Returns the new Task if enqueued, or null if ignored (e.g. issue is already closed). */
  async handleIssueLabeledEvent(
    issueNumber: number,
    title: string,
    body: string,
    labels: string[],
    state: string,
  ): Promise<Task | null> {
    if (state === "closed") {
      log(`[task #${issueNumber}] labeled: ignoring — issue is closed`);
      return null;
    }
    const task = await this.enqueueIssue(String(issueNumber), issueNumber, this.repo.fullName, title, body, labels);
    this.startDepsLoad(issueNumber, body);
    return task;
  }

  /** Handle issues/edited when the body changes: reset blockers and reload them. */
  handleIssueBodyEditedEvent(
    issueNumber: number,
    newBody: string,
  ): void {
    this.resetBlockers(issueNumber);
    this.startDepsLoad(issueNumber, newBody);
  }

  // ── PR event handlers ──────────────────────────────────────────────────────

  private static extractLinkedIssueNumber(body: string): number | null {
    const match = /(?:closes|fixes|resolves)\s+#(\d+)/i.exec(body);
    return match ? parseInt(match[1], 10) : null;
  }

  /** Handle pull_request/opened: find the linked issue, register the branch and PR.
   *  Returns the linked task, or null if no linked issue is found. */
  async handlePrOpenedEvent(prNumber: number, body: string, branch: string | null): Promise<Task | null> {
    const linkedIssue = TaskManager.extractLinkedIssueNumber(body);
    if (linkedIssue === null) return null;
    const task = await this.repo.getTaskByIssue(linkedIssue);
    if (!task) return null;
    if (branch) this.registerBranch(branch, task);
    await task.registerPr(prNumber, branch).catch((err: unknown) =>
      log(`ERROR Failed to register PR #${prNumber} for task #${task.taskId}: ${fmtError(err)}`)
    );
    log(`[task #${linkedIssue}] PR #${prNumber} registered`);
    return task;
  }

  /** Handle pull_request/edited when the body changes: (re)register the PR-issue link.
   *  Returns the task if a closing keyword is found in the new body, or null otherwise. */
  async handlePrEditedEvent(prNumber: number, body: string, branch: string | null): Promise<Task | null> {
    const linkedIssue = TaskManager.extractLinkedIssueNumber(body);
    if (linkedIssue === null) return null;
    const task = await this.repo.getTaskByIssue(linkedIssue);
    if (!task) return null;
    if (branch) this.registerBranch(branch, task);
    await task.registerPr(prNumber, branch).catch((err: unknown) =>
      log(`ERROR Failed to register PR #${prNumber} for task #${task.taskId}: ${fmtError(err)}`)
    );
    log(`[task #${linkedIssue}] PR #${prNumber} registered (body edited)`);
    return task;
  }

  /** Handle pull_request/closed: unregister or record the merge on the linked task.
   *  Returns the task, or null if no task owns the PR. */
  async handlePrClosedEvent(prNumber: number, merged: boolean): Promise<Task | null> {
    const task = await this.repo.getTaskByPr(prNumber);
    if (!task) return null;
    if (merged) {
      log(`[task #${task.issueNumber}] PR #${prNumber} merged`);
      await task.mergePr().catch((err: unknown) =>
        log(`ERROR Failed to record PR #${prNumber} merge: ${fmtError(err)}`)
      );
    } else {
      log(`[task #${task.issueNumber}] PR #${prNumber} unregistered (closed without merging)`);
      await task.unregisterPr().catch((err: unknown) =>
        log(`ERROR Failed to unregister PR #${prNumber}: ${fmtError(err)}`)
      );
    }
    return task;
  }

  // ── Check event handler ────────────────────────────────────────────────────

  /** Find the task for a check_run or check_suite event.
   *  Tries by PR number first, then falls back to branch name.
   *  Returns the task and a display ref string, or null if not found. */
  async getTaskForCheckEvent(prNumbers: number[], headBranch: string): Promise<{ task: Task; ref: string } | null> {
    if (prNumbers.length > 0) {
      const task = await this.repo.getTaskByPr(prNumbers[0]);
      if (task) return { task, ref: `PR #${prNumbers[0]}` };
    }
    if (headBranch) {
      const task = await this.getTaskForBranch(headBranch);
      if (task) return { task, ref: `branch ${headBranch}` };
    }
    return null;
  }

  /** Fetch brunel:ready issues from GitHub and load deps.
   *  Called at startup after loadActiveTasksFromDb. */
  async loadIssuesFromGithub(): Promise<void> {
    await loadIssuesToQueue(this);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Annotate a task with in-memory blocker state (including open/closed per blocker) before returning it. */
  private hydrateBlockers(task: Task): void {
    const nums = this._blockers.get(task.issueNumber) ?? [];
    task.blockers = nums.map(n => ({ issueNumber: n, isOpen: this._openIssues.has(n) }));
    task.blockersLoaded = this._blockersLoaded.has(task.issueNumber);
  }
}
