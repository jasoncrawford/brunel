import { describe, it, expect, vi } from "vitest";
import { WorkerRegistry, createForemanWss } from "../src/foreman.js";
import { TaskModel } from "../src/task-model.js";
import { loadDefaultConfig } from "../src/config.js";
import type { TaskStore } from "../src/db.js";
import type { TaskIssue } from "../src/types.js";
import http from "http";

const defaultCfg = await loadDefaultConfig();

const ISSUE_10: TaskIssue = { number: 10, title: "T", body: "b", labels: [], repoUrl: "r" };

function makeTaskStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    upsertTask: vi.fn().mockResolvedValue(undefined),
    updateTaskContent: vi.fn().mockResolvedValue(undefined),
    markAssigned: vi.fn().mockResolvedValue(undefined),
    markComplete: vi.fn().mockResolvedValue(undefined),
    markPending: vi.fn().mockResolvedValue(undefined),
    markBlocked: vi.fn().mockResolvedValue(undefined),
    updateTaskPr: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
    listTasks: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// ── Issue close → markPending ─────────────────────────────────────────────────

describe("foreman — blocker transitions via routeEvent", () => {
  it("issue close unblocks task in memory when no open blockers remain", async () => {
    const taskModel = new TaskModel();
    const registry = new WorkerRegistry();
    const server = http.createServer();

    taskModel.loadTask({
      taskId: "10", issueNumber: 10, title: "T", body: "b",
      labels: [], repoUrl: "r", status: "blocked",
    });
    const graph = new Map([[10, new Set([5])]]);

    const { wss, routeEvent } = createForemanWss(taskModel, registry, server, {
      taskLabel: "brunel:ready",
      graph,
      reclaimTimeoutMs: 300_000,
      pingIntervalMs: defaultCfg.pingIntervalMs,
    });
    taskModel.trackIssue(10, ISSUE_10, true);
    taskModel.setIssueOpenState(5, true);
    wss.close();

    await routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 5, title: "Blocker", labels: [] },
    });

    expect(taskModel.get("10")?.status).toBe("pending");
  });

  it("issue close calls markPending on taskStore when task is fully unblocked", async () => {
    const taskStore = makeTaskStore();
    const taskModel = new TaskModel(taskStore);
    const registry = new WorkerRegistry();
    const server = http.createServer();

    taskModel.loadTask({
      taskId: "10", issueNumber: 10, title: "T", body: "b",
      labels: [], repoUrl: "r", status: "blocked",
    });
    const graph = new Map([[10, new Set([5])]]);

    const { wss, routeEvent } = createForemanWss(taskModel, registry, server, {
      taskLabel: "brunel:ready",
      graph,
      reclaimTimeoutMs: 300_000,
      pingIntervalMs: defaultCfg.pingIntervalMs,
    });
    taskModel.trackIssue(10, ISSUE_10, true);
    taskModel.setIssueOpenState(5, true);
    wss.close();

    await routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 5, title: "Blocker", labels: [] },
    });

    expect(taskStore.markPending).toHaveBeenCalledWith("10");
  });

  it("issue close does NOT unblock task when other blockers are still open", async () => {
    const taskStore = makeTaskStore();
    const taskModel = new TaskModel(taskStore);
    const registry = new WorkerRegistry();
    const server = http.createServer();

    taskModel.loadTask({
      taskId: "10", issueNumber: 10, title: "T", body: "b",
      labels: [], repoUrl: "r", status: "blocked",
    });
    // Task 10 is blocked by BOTH 5 and 6
    const graph = new Map([[10, new Set([5, 6])]]);

    const { wss, routeEvent } = createForemanWss(taskModel, registry, server, {
      taskLabel: "brunel:ready",
      graph,
      reclaimTimeoutMs: 300_000,
      pingIntervalMs: defaultCfg.pingIntervalMs,
    });
    taskModel.trackIssue(10, ISSUE_10, true);
    taskModel.setIssueOpenState(5, true);
    taskModel.setIssueOpenState(6, true);
    wss.close();

    // Close issue 5 — but 6 is still open
    await routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 5, title: "Blocker 5", labels: [] },
    });

    // Task remains blocked (6 is still open)
    expect(taskModel.get("10")?.status).toBe("blocked");
    expect(taskStore.markPending).not.toHaveBeenCalled();
  });
});
