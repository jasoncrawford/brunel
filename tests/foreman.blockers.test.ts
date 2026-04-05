import { describe, it, expect, vi } from "vitest";
import { WorkerRegistry } from "../src/foreman/worker-registry.js";
import { createForemanWss } from "../src/foreman/wss.js";
import { TaskModel } from "../src/foreman/task-model.js";
import { loadDefaultConfig } from "../src/config.js";
import { createMemoryTaskStore } from "../src/foreman/db.js";
import type { TaskStore } from "../src/foreman/db.js";
import type { TaskIssue } from "../src/types.js";
import http from "http";

const defaultCfg = await loadDefaultConfig();

const ISSUE_10: TaskIssue = { number: 10, title: "T", body: "b", labels: [], repoUrl: "r" };

/** Creates a real in-memory store with vi.spyOn on all methods for assertion. */
function makeSpiedStore(): TaskStore {
  const store = createMemoryTaskStore();
  vi.spyOn(store, "upsertTask");
  vi.spyOn(store, "updateTaskContent");
  vi.spyOn(store, "markAssigned");
  vi.spyOn(store, "markComplete");
  vi.spyOn(store, "markPending");
  vi.spyOn(store, "markBlocked");
  vi.spyOn(store, "updateTaskPr");
  vi.spyOn(store, "deleteTask");
  vi.spyOn(store, "getTask");
  vi.spyOn(store, "listTasks");
  return store;
}

// ── Issue close → markPending ─────────────────────────────────────────────────

describe("foreman — blocker transitions via routeEvent", () => {
  it("issue close unblocks task in memory when no open blockers remain", async () => {
    const taskModel = new TaskModel();
    const registry = new WorkerRegistry();
    const server = http.createServer();

    await taskModel.register("10", 10, "owner/repo", "T", "b", []);
    await taskModel.block("10");
    const graph = new Map([[10, new Set([5])]]);

    const { wss, routeEvent } = createForemanWss(taskModel, registry, server, { ...defaultCfg, taskLabel: "brunel:ready" }, { graph });
    taskModel.trackIssue(10, ISSUE_10, true);
    taskModel.setIssueOpenState(5, true);
    wss.close();

    await routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 5, title: "Blocker", labels: [] },
    });

    expect((await taskModel.get("10"))?.status).toBe("pending");
  });

  it("issue close calls markPending on taskStore when task is fully unblocked", async () => {
    const taskStore = makeSpiedStore();
    const taskModel = new TaskModel(taskStore);
    const registry = new WorkerRegistry();
    const server = http.createServer();

    await taskModel.register("10", 10, "owner/repo", "T", "b", []);
    await taskModel.block("10");
    const graph = new Map([[10, new Set([5])]]);

    const { wss, routeEvent } = createForemanWss(taskModel, registry, server, { ...defaultCfg, taskLabel: "brunel:ready" }, { graph });
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
    const taskStore = makeSpiedStore();
    const taskModel = new TaskModel(taskStore);
    const registry = new WorkerRegistry();
    const server = http.createServer();

    await taskModel.register("10", 10, "owner/repo", "T", "b", []);
    await taskModel.block("10");
    // Task 10 is blocked by BOTH 5 and 6
    const graph = new Map([[10, new Set([5, 6])]]);

    const { wss, routeEvent } = createForemanWss(taskModel, registry, server, { ...defaultCfg, taskLabel: "brunel:ready" }, { graph });
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
    expect((await taskModel.get("10"))?.status).toBe("blocked");
    expect(taskStore.markPending).not.toHaveBeenCalled();
  });
});
