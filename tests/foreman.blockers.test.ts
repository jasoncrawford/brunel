import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkerRegistry } from "../src/foreman/models/worker-registry.js";
import { createForemanWss } from "../src/foreman/controllers/wss.js";
import { TaskManager } from "../src/foreman/models/task-model.js";
import { Task } from "../src/foreman/models/task.js";
import { setupInMemoryTasks } from "./helpers/task.js";
import { loadDefaultConfig } from "../src/config.js";
import type { TaskIssue } from "../src/types.js";
import http from "http";

const defaultCfg = await loadDefaultConfig();

const ISSUE_10: TaskIssue = { number: 10, title: "T", body: "b", labels: [], repoUrl: "r" };

// ── Derived blocked status from dependency graph ────────────────────────────────

describe("foreman — blocker transitions via routeEvent", () => {
  let taskManager: TaskManager;

  beforeEach(() => {
    taskManager = new TaskManager();
    setupInMemoryTasks(taskManager);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("task derives blocked status when blocker is open", async () => {
    const registry = new WorkerRegistry();
    const server = http.createServer();

    await Task.upsert("10", 10, "owner/repo", "T", "b", []);
    const graph = new Map([[10, new Set([5])]]);

    const { wss } = createForemanWss(taskManager, registry, server, { ...defaultCfg, taskLabel: "brunel:ready", workerReclaimTimeoutMs: 300_000 }, { graph });
    taskManager.trackIssue(10, ISSUE_10, true);
    taskManager.setIssueOpenState(5, true); // blocker is open
    wss.close();

    const snapshots = await taskManager.getTaskSnapshots(graph);
    expect(snapshots[0].status).toBe("blocked");
  });

  it("task derives pending status when blocker is closed", async () => {
    const registry = new WorkerRegistry();
    const server = http.createServer();

    await Task.upsert("10", 10, "owner/repo", "T", "b", []);
    const graph = new Map([[10, new Set([5])]]);

    const { wss, routeEvent } = createForemanWss(taskManager, registry, server, { ...defaultCfg, taskLabel: "brunel:ready" }, { graph });
    taskManager.trackIssue(10, ISSUE_10, true);
    taskManager.setIssueOpenState(5, true);
    wss.close();

    // Initially blocked
    const snapshots1 = await taskManager.getTaskSnapshots(graph);
    expect(snapshots1[0].status).toBe("blocked");

    // Close the blocker
    await routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 5, title: "Blocker", labels: [] },
    });

    // Now pending
    const snapshots2 = await taskManager.getTaskSnapshots(graph);
    expect(snapshots2[0].status).toBe("pending");
  });

  it("task remains blocked when other blockers are still open", async () => {
    const registry = new WorkerRegistry();
    const server = http.createServer();

    await Task.upsert("10", 10, "owner/repo", "T", "b", []);
    // Task 10 is blocked by BOTH 5 and 6
    const graph = new Map([[10, new Set([5, 6])]]);

    const { wss, routeEvent } = createForemanWss(taskManager, registry, server, { ...defaultCfg, taskLabel: "brunel:ready" }, { graph });
    taskManager.trackIssue(10, ISSUE_10, true);
    taskManager.setIssueOpenState(5, true);
    taskManager.setIssueOpenState(6, true);
    wss.close();

    // Initially blocked
    const snapshots1 = await taskManager.getTaskSnapshots(graph);
    expect(snapshots1[0].status).toBe("blocked");

    // Close issue 5 — but 6 is still open
    await routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 5, title: "Blocker 5", labels: [] },
    });

    // Task remains blocked (6 is still open)
    const snapshots2 = await taskManager.getTaskSnapshots(graph);
    expect(snapshots2[0].status).toBe("blocked");
  });
});
