import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Worker } from "../src/foreman/models/worker.js";
import { ForemanWss } from "../src/foreman/wss.js";
import { TaskManager } from "../src/foreman/models/task-manager.js";
import { Task } from "../src/foreman/models/task.js";
import { resetDb, createTestTaskManager } from "./helpers/task.js";
import { loadDefaultConfig } from "../src/config.js";
import http from "http";

const defaultCfg = await loadDefaultConfig();

// ── Derived blocked status from dependency graph ────────────────────────────────

describe("foreman — blocker transitions via routeEvent", () => {
  let taskManager: TaskManager;

  beforeEach(async () => {
    Worker._reset();
    resetDb();
    taskManager = await createTestTaskManager("owner/repo");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("task derives blocked status when blocker is open", async () => {
    const server = http.createServer();

    await Task.upsert("10", 10, "owner/repo", "T", "b", []);
    taskManager.trackIssue(10);
    taskManager.setBlockers(10, [5]);
    taskManager.markBlockersLoaded(10);
    taskManager.setIssueOpenState(5, true); // blocker is open

    const { wss } = new ForemanWss({ server, config: { ...defaultCfg, taskLabel: "brunel:ready", workerReclaimTimeoutMs: 300_000 } });
    wss.close();

    const snapshots = await taskManager.getTasksForBroadcast();
    expect(snapshots[0].status).toBe("blocked");
  });

  it("task derives pending status when blocker is closed", async () => {
    const server = http.createServer();

    await Task.upsert("10", 10, "owner/repo", "T", "b", []);
    taskManager.trackIssue(10);
    taskManager.setBlockers(10, [5]);
    taskManager.markBlockersLoaded(10);
    taskManager.setIssueOpenState(5, true);

    const foremanWss = new ForemanWss({ server, config: { ...defaultCfg, taskLabel: "brunel:ready" } });
    const { wss } = foremanWss;
    wss.close();

    // Initially blocked
    const snapshots1 = await taskManager.getTasksForBroadcast();
    expect(snapshots1[0].status).toBe("blocked");

    // Close the blocker
    await foremanWss.webhookController.handleEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 5, title: "Blocker", labels: [] },
      repository: { full_name: "owner/repo" },
    });

    // Now pending
    const snapshots2 = await taskManager.getTasksForBroadcast();
    expect(snapshots2[0].status).toBe("pending");
  });

  it("task remains blocked when other blockers are still open", async () => {
    const server = http.createServer();

    await Task.upsert("10", 10, "owner/repo", "T", "b", []);
    // Task 10 is blocked by BOTH 5 and 6
    taskManager.trackIssue(10);
    taskManager.setBlockers(10, [5, 6]);
    taskManager.markBlockersLoaded(10);
    taskManager.setIssueOpenState(5, true);
    taskManager.setIssueOpenState(6, true);

    const foremanWss = new ForemanWss({ server, config: { ...defaultCfg, taskLabel: "brunel:ready" } });
    const { wss } = foremanWss;
    wss.close();

    // Initially blocked
    const snapshots1 = await taskManager.getTasksForBroadcast();
    expect(snapshots1[0].status).toBe("blocked");

    // Close issue 5 — but 6 is still open
    await foremanWss.webhookController.handleEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 5, title: "Blocker 5", labels: [] },
      repository: { full_name: "owner/repo" },
    });

    // Task remains blocked (6 is still open)
    const snapshots2 = await taskManager.getTasksForBroadcast();
    expect(snapshots2[0].status).toBe("blocked");
  });
});
