import { describe, it, expect, vi } from "vitest";
import { TaskQueue, WorkerRegistry, createForemanWss } from "../src/foreman.js";
import type { TaskBlockerStore, TaskStore } from "../src/db.js";
import type { LabeledIssueState } from "../src/types.js";
import http from "http";

/** Build a labeledIssues map for a single issue so reconcile doesn't evict it. */
function makeLabeledIssues(issueNumber: number): Map<number, LabeledIssueState> {
  return new Map([[issueNumber, {
    issue: { title: "T", body: "b", labels: [], repoUrl: "r" },
    depsLoaded: true,
  }]]);
}

function makeBlockerStore(overrides: Partial<TaskBlockerStore> = {}): TaskBlockerStore {
  return {
    upsertBlockers: vi.fn().mockResolvedValue(undefined),
    closeBlocker: vi.fn().mockResolvedValue(undefined),
    listTaskBlockers: vi.fn().mockResolvedValue([]),
    listAllOpenBlockers: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeTaskStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    upsertTask: vi.fn().mockResolvedValue(undefined),
    markAssigned: vi.fn().mockResolvedValue(undefined),
    markComplete: vi.fn().mockResolvedValue(undefined),
    markPending: vi.fn().mockResolvedValue(undefined),
    markBlocked: vi.fn().mockResolvedValue(undefined),
    updateTaskPr: vi.fn().mockResolvedValue(undefined),
    listTasks: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// ── Issue close → closeBlocker + markPending ──────────────────────────────────

describe("foreman — blocker transitions via routeEvent", () => {
  it("issue close calls closeBlocker for tasks blocked by that issue", () => {
    const taskQueue = new TaskQueue();
    const registry = new WorkerRegistry();
    const server = http.createServer();
    const blockerStore = makeBlockerStore();

    // Task 10 is blocked by issue 5
    taskQueue.addTask({
      taskId: "10", issueNumber: 10, title: "T", body: "b",
      labels: [], repoUrl: "r", status: "blocked",
    });
    const graph = new Map([[10, new Set([5])]]);
    const openIssues = new Set([5]);

    const { wss, routeEvent } = createForemanWss(taskQueue, registry, server, {
      taskLabel: "brunel:ready",
      graph,
      openIssues,
      labeledIssues: makeLabeledIssues(10),
      blockerStore,
      reclaimTimeoutMs: 300_000,
    });
    wss.close();

    routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 5, title: "Blocker", labels: [] },
    });

    expect(blockerStore.closeBlocker).toHaveBeenCalledWith("10", 5);
  });

  it("issue close unblocks task in memory when no open blockers remain", () => {
    const taskQueue = new TaskQueue();
    const registry = new WorkerRegistry();
    const server = http.createServer();

    taskQueue.addTask({
      taskId: "10", issueNumber: 10, title: "T", body: "b",
      labels: [], repoUrl: "r", status: "blocked",
    });
    const graph = new Map([[10, new Set([5])]]);
    const openIssues = new Set([5]);

    const { wss, routeEvent } = createForemanWss(taskQueue, registry, server, {
      taskLabel: "brunel:ready",
      graph,
      openIssues,
      labeledIssues: makeLabeledIssues(10),
      reclaimTimeoutMs: 300_000,
    });
    wss.close();

    routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 5, title: "Blocker", labels: [] },
    });

    expect(taskQueue.get("10")?.status).toBe("pending");
  });

  it("issue close calls markPending on taskStore when task is fully unblocked", () => {
    const taskQueue = new TaskQueue();
    const registry = new WorkerRegistry();
    const server = http.createServer();
    const taskStore = makeTaskStore();

    taskQueue.addTask({
      taskId: "10", issueNumber: 10, title: "T", body: "b",
      labels: [], repoUrl: "r", status: "blocked",
    });
    const graph = new Map([[10, new Set([5])]]);
    const openIssues = new Set([5]);

    const { wss, routeEvent } = createForemanWss(taskQueue, registry, server, {
      taskLabel: "brunel:ready",
      graph,
      openIssues,
      labeledIssues: makeLabeledIssues(10),
      taskStore,
      reclaimTimeoutMs: 300_000,
    });
    wss.close();

    routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 5, title: "Blocker", labels: [] },
    });

    expect(taskStore.markPending).toHaveBeenCalledWith("10");
  });

  it("issue close does NOT unblock task when other blockers are still open", () => {
    const taskQueue = new TaskQueue();
    const registry = new WorkerRegistry();
    const server = http.createServer();
    const taskStore = makeTaskStore();

    taskQueue.addTask({
      taskId: "10", issueNumber: 10, title: "T", body: "b",
      labels: [], repoUrl: "r", status: "blocked",
    });
    // Task 10 is blocked by BOTH 5 and 6
    const graph = new Map([[10, new Set([5, 6])]]);
    const openIssues = new Set([5, 6]);

    const { wss, routeEvent } = createForemanWss(taskQueue, registry, server, {
      taskLabel: "brunel:ready",
      graph,
      openIssues,
      labeledIssues: makeLabeledIssues(10),
      taskStore,
      reclaimTimeoutMs: 300_000,
    });
    wss.close();

    // Close issue 5 — but 6 is still open
    routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 5, title: "Blocker 5", labels: [] },
    });

    // Task remains blocked (6 is still open)
    expect(taskQueue.get("10")?.status).toBe("blocked");
    expect(taskStore.markPending).not.toHaveBeenCalled();
  });
});
