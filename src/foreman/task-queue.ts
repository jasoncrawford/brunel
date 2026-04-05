import { EventEmitter } from "events";
import type { GitHubEvent, TaskStatus } from "../types.js";
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


// ── TaskQueue ────────────────────────────────────────────────────────────────

export class TaskQueue extends EventEmitter {
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
