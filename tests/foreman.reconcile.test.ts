import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import { WorkerRegistry } from "../src/foreman/worker-registry.js";
import { createForemanWss } from "../src/foreman/wss.js";
import { TaskModel } from "../src/foreman/task-model.js";
import { loadDefaultConfig } from "../src/config.js";
const defaultCfg = await loadDefaultConfig();
import type { TaskIssue } from "../src/types.js";
import type { TaskStore } from "../src/foreman/db.js";

const TASK_LABEL = "brunel:ready";

function makeIssue(n: number): TaskIssue {
  return { number: n, title: `Issue ${n}`, body: "body", labels: [TASK_LABEL], repoUrl: "https://github.com/o/r" };
}

let registry: WorkerRegistry;
let taskModel: TaskModel;
let reconcile: () => void;
let routeEvent: (id: string, name: string, payload: unknown) => void;

beforeEach(() => {
  taskModel = new TaskModel();
  registry = new WorkerRegistry();
  const server = http.createServer();
  ({ reconcile, routeEvent } = createForemanWss(taskModel, registry, server, { ...defaultCfg, taskLabel: TASK_LABEL }));
});

describe("reconcile()", () => {
  it("is exposed in the return value of createForemanWss", () => {
    expect(typeof reconcile).toBe("function");
  });

  it("creates a task for each entry in labeledIssues that has no task yet", () => {
    taskModel.trackIssue(42, makeIssue(42), true);
    reconcile();
    const t = taskModel.get("42");
    expect(t?.issueNumber).toBe(42);
    expect(t?.title).toBe("Issue 42");
    expect(t?.depsLoaded).toBe(true);
    expect(t?.status).toBe("pending");
  });

  it("creates task with depsLoaded: false when entry says false", () => {
    taskModel.trackIssue(7, makeIssue(7));
    reconcile();
    expect(taskModel.get("7")?.depsLoaded).toBe(false);
  });

  it("does not create a duplicate task if one already exists for the issue", () => {
    taskModel.loadTask({ taskId: "42", issueNumber: 42, title: "Existing", body: "b", labels: [], repoUrl: "", depsLoaded: true });
    taskModel.trackIssue(42, makeIssue(42), true);
    reconcile();
    // Only one task for issue 42 exists (no duplicate created)
    expect(taskModel.getTaskForIssue(42)).toBeDefined();
    // Title is synced from GitHub
    expect(taskModel.get("42")?.title).toBe("Issue 42");
  });

  it("syncs title from labeledIssues to an existing in-memory task", () => {
    // Simulates: task restored from DB with empty/stale title, then GitHub data loaded.
    taskModel.loadTask({ taskId: "42", issueNumber: 42, title: "", body: "b", labels: [], repoUrl: "", depsLoaded: true });
    taskModel.trackIssue(42, { ...makeIssue(42), title: "Real Title" }, true);
    reconcile();
    expect(taskModel.get("42")?.title).toBe("Real Title");
  });

  it("calls updateTaskContent for existing tasks (not upsertTask)", async () => {
    const mockStore = {
      upsertTask: vi.fn().mockResolvedValue(undefined),
      markAssigned: vi.fn().mockResolvedValue(undefined),
      markComplete: vi.fn().mockResolvedValue(undefined),
      markPending: vi.fn().mockResolvedValue(undefined),
      markBlocked: vi.fn().mockResolvedValue(undefined),
      updateTaskContent: vi.fn().mockResolvedValue(undefined),
      updateTaskPr: vi.fn().mockResolvedValue(undefined),
      deleteTask: vi.fn().mockResolvedValue(undefined),
      getTask: vi.fn().mockResolvedValue(null),
      listTasks: vi.fn().mockResolvedValue([]),
    };
    const taskModel2 = new TaskModel(mockStore as any);
    const server2 = http.createServer();
    const { reconcile: rec2 } = createForemanWss(taskModel2, registry, server2, { ...defaultCfg, taskLabel: TASK_LABEL });

    // Existing task in queue
    taskModel2.loadTask({ taskId: "42", issueNumber: 42, title: "Old Title", body: "old", labels: [], repoUrl: "", depsLoaded: true });
    taskModel2.trackIssue(42, { ...makeIssue(42), title: "New Title", body: "new body", labels: ["brunel:ready", "bug"] }, true);

    rec2();
    await new Promise((r) => setImmediate(r));

    // updateTaskContent should be called for the existing task
    expect(mockStore.updateTaskContent).toHaveBeenCalledWith("42", "New Title", "new body", ["brunel:ready", "bug"]);
    // upsertTask should NOT be called (it resets status to pending)
    expect(mockStore.upsertTask).not.toHaveBeenCalled();
  });

  it("syncs depsLoaded from labeledIssues to an existing task that has depsLoaded: false", () => {
    taskModel.loadTask({ taskId: "5", issueNumber: 5, title: "T", body: "b", labels: [], repoUrl: "", depsLoaded: false });
    taskModel.trackIssue(5, makeIssue(5), true);
    reconcile();
    expect(taskModel.get("5")?.depsLoaded).toBe(true);
  });

  it("syncs body and labels from labeledIssues to an existing task (startup restore fix)", () => {
    // Simulates: task restored from DB with empty body/labels, then GitHub data loaded.
    taskModel.loadTask({ taskId: "42", issueNumber: 42, title: "T", body: "", labels: [], repoUrl: "", depsLoaded: true });
    taskModel.trackIssue(42, { ...makeIssue(42), body: "Real description", labels: ["brunel:ready", "bug"] }, true);
    reconcile();
    expect(taskModel.get("42")?.body).toBe("Real description");
    expect(taskModel.get("42")?.labels).toEqual(["brunel:ready", "bug"]);
  });

  it("does not change depsLoaded on an existing task when labeledIssues also says false", () => {
    taskModel.loadTask({ taskId: "5", issueNumber: 5, title: "T", body: "b", labels: [], repoUrl: "", depsLoaded: false });
    taskModel.trackIssue(5, makeIssue(5));
    reconcile();
    expect(taskModel.get("5")?.depsLoaded).toBe(false);
  });

  it("syncs depsLoaded=false from labeledIssues to an existing task that has depsLoaded: true (stale-dep bug)", () => {
    // Simulates: issue body was edited → labeledIssues.depsLoaded reset to false,
    // but task.depsLoaded is still true. reconcile() must propagate false → task.
    taskModel.loadTask({ taskId: "5", issueNumber: 5, title: "T", body: "b", labels: [], repoUrl: "", depsLoaded: true });
    taskModel.trackIssue(5, makeIssue(5));
    reconcile();
    expect(taskModel.get("5")?.depsLoaded).toBe(false);
  });

  it("does not assign a pending task via tryAssignWork when its depsLoaded is false after reconcile", () => {
    // The worker is idle, but the task should NOT be assigned because depsLoaded is false.
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    registry.register("w1", fakeWs, "idle");

    // Task exists with depsLoaded: true but labeledIssues says false (e.g. mid-reload).
    taskModel.loadTask({ taskId: "42", issueNumber: 42, title: "T", body: "b", labels: [], repoUrl: "", depsLoaded: true });
    taskModel.trackIssue(42, makeIssue(42)); // depsLoaded defaults to false
    reconcile();

    // reconcile must have propagated depsLoaded=false, so the task must NOT be assigned.
    expect(taskModel.get("42")?.depsLoaded).toBe(false);
    expect(taskModel.get("42")?.status).toBe("pending");
    expect(fakeWs.send).not.toHaveBeenCalledWith(expect.stringContaining('"task_assigned"'));
  });

  it("removes a pending task whose issue is no longer in labeledIssues", () => {
    taskModel.loadTask({ taskId: "9", issueNumber: 9, title: "T", body: "b", labels: [], repoUrl: "" });
    // labeledIssues is empty — issue 9 has no label
    reconcile();
    expect(taskModel.get("9")).toBeUndefined();
  });

  it("calls store.deleteTask when reconcile removes a pending task whose label was removed", async () => {
    const deleteTask = vi.fn().mockResolvedValue(undefined);
    const mockStore: TaskStore = {
      upsertTask: vi.fn().mockResolvedValue(undefined),
      markAssigned: vi.fn().mockResolvedValue(undefined),
      markComplete: vi.fn().mockResolvedValue(undefined),
      markPending: vi.fn().mockResolvedValue(undefined),
      markBlocked: vi.fn().mockResolvedValue(undefined),
      deleteTask,
      getTask: vi.fn().mockResolvedValue(null),
      updateTaskContent: vi.fn().mockResolvedValue(undefined),
      updateTaskPr: vi.fn().mockResolvedValue(undefined),
      listTasks: vi.fn().mockResolvedValue([]),
    };
    const spyTaskModel = new TaskModel(mockStore);
    const spyRegistry = new WorkerRegistry();
    const spyServer = http.createServer();
    const { reconcile: spyReconcile } = createForemanWss(spyTaskModel, spyRegistry, spyServer, { ...defaultCfg, taskLabel: TASK_LABEL });

    spyTaskModel.loadTask({ taskId: "9", issueNumber: 9, title: "T", body: "b", labels: [], repoUrl: "" });
    spyReconcile();

    expect(spyTaskModel.get("9")).toBeUndefined();
    await Promise.resolve();
    expect(deleteTask).toHaveBeenCalledWith("9");
  });

  it("does NOT remove an assigned task even if its issue is not in labeledIssues", () => {
    taskModel.loadTask({ taskId: "9", issueNumber: 9, title: "T", body: "b", labels: [], repoUrl: "" });
    taskModel.assignInMemory("9", "worker-1");
    reconcile();
    expect(taskModel.get("9")).toBeDefined();
    expect(taskModel.get("9")?.status).toBe("assigned");
  });

  it("does NOT remove a complete task even if its issue is not in labeledIssues", async () => {
    taskModel.loadTask({ taskId: "9", issueNumber: 9, title: "T", body: "b", labels: [], repoUrl: "" });
    await taskModel.complete("9");
    reconcile();
    expect(taskModel.get("9")).toBeDefined();
    expect(taskModel.get("9")?.status).toBe("complete");
  });

  it("calls tryAssignWork for each idle worker, assigning pending ready tasks", async () => {
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    registry.register("w1", fakeWs, "idle");

    taskModel.trackIssue(42, makeIssue(42), true);
    reconcile();

    // tryAssignWork is async (DB write then send), so flush the microtask queue.
    await new Promise((r) => setImmediate(r));

    // task_assigned message should have been sent to the idle worker
    expect(fakeWs.send).toHaveBeenCalledWith(expect.stringContaining('"task_assigned"'));
    expect(taskModel.get("42")?.status).toBe("assigned");
    expect(registry.get("w1")?.status).toBe("busy");
  });
});

describe("issues/closed — task lifecycle", () => {
  it("marks an assigned task complete when its issue is closed", () => {
    taskModel.trackIssue(42, makeIssue(42), true);
    taskModel.loadTask({ taskId: "42", issueNumber: 42, title: "T", body: "b", labels: [], repoUrl: "" });
    taskModel.assignInMemory("42", "worker-1");

    routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 42, title: "T", body: "", labels: [] },
    });

    expect(taskModel.get("42")?.status).toBe("complete");
  });

  it("leaves a complete task complete when its issue is closed again", async () => {
    taskModel.trackIssue(42, makeIssue(42), true);
    taskModel.loadTask({ taskId: "42", issueNumber: 42, title: "T", body: "b", labels: [], repoUrl: "" });
    await taskModel.complete("42");

    routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 42, title: "T", body: "", labels: [] },
    });

    expect(taskModel.get("42")?.status).toBe("complete");
  });

  it("marks a pending task complete when its issue is closed", () => {
    // Bug #489: closing an issue with a pending task should mark it complete in DB.
    // Previously, only assigned tasks were marked complete; pending tasks were cancelled
    // via reconcile, but deleteTask silently skips rows where assigned_at IS NOT NULL
    // (tasks that previously had a worker), leaving stale pending rows in the DB.
    taskModel.trackIssue(42, makeIssue(42), true);
    taskModel.loadTask({ taskId: "42", issueNumber: 42, title: "T", body: "b", labels: [], repoUrl: "" });

    routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 42, title: "T", body: "", labels: [] },
    });

    expect(taskModel.get("42")?.status).toBe("complete");
  });

  it("marks a blocked task complete when its issue is closed", () => {
    taskModel.trackIssue(42, makeIssue(42), true);
    taskModel.loadTask({ taskId: "42", issueNumber: 42, title: "T", body: "b", labels: [], repoUrl: "", status: "blocked" });

    routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 42, title: "T", body: "", labels: [] },
    });

    expect(taskModel.get("42")?.status).toBe("complete");
  });

  it("calls store.markComplete for a pending task when its issue is closed", async () => {
    const mockStore = {
      upsertTask: vi.fn().mockResolvedValue(undefined),
      markAssigned: vi.fn().mockResolvedValue(undefined),
      markComplete: vi.fn().mockResolvedValue(undefined),
      markPending: vi.fn().mockResolvedValue(undefined),
      markBlocked: vi.fn().mockResolvedValue(undefined),
      deleteTask: vi.fn().mockResolvedValue(undefined),
      getTask: vi.fn().mockResolvedValue(null),
      updateTaskContent: vi.fn().mockResolvedValue(undefined),
      updateTaskPr: vi.fn().mockResolvedValue(undefined),
      listTasks: vi.fn().mockResolvedValue([]),
    };
    const tm2 = new TaskModel(mockStore as any);
    const r2 = new WorkerRegistry();
    const s2 = http.createServer();
    const { routeEvent: re2 } = createForemanWss(tm2, r2, s2, { ...defaultCfg, taskLabel: TASK_LABEL, workerReclaimTimeoutMs: 30000 });

    tm2.trackIssue(42, makeIssue(42), true);
    tm2.loadTask({ taskId: "42", issueNumber: 42, title: "T", body: "b", labels: [], repoUrl: "" });

    re2("evt-1", "issues", {
      action: "closed",
      issue: { number: 42, title: "T", body: "", labels: [] },
    });

    await new Promise((r) => setImmediate(r));
    expect(mockStore.markComplete).toHaveBeenCalledWith("42");
    expect(mockStore.deleteTask).not.toHaveBeenCalled();
  });
});

describe("startDepsLoad() error handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("task remains pending with depsLoaded: false when dep fetch fails", async () => {
    // Mock fetch to reject — this causes fetchNativeBlockers (called by fetchBlockers
    // inside startDepsLoad) to reject, which propagates to the .catch handler.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    // Trigger startDepsLoad by routing a labeled event
    routeEvent("evt-1", "issues", {
      action: "labeled",
      label: { name: TASK_LABEL },
      issue: {
        number: 42,
        title: "Issue 42",
        body: "body",
        labels: [{ name: TASK_LABEL }],
      },
      repository: { html_url: "https://github.com/o/r" },
    });

    // Task created synchronously by reconcile() with depsLoaded: false
    expect(taskModel.get("42")?.depsLoaded).toBe(false);

    // Wait for the async startDepsLoad chain to fail and settle
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    // After failure, depsLoaded must still be false and task still pending
    expect(taskModel.get("42")?.depsLoaded).toBe(false);
    expect(taskModel.get("42")?.status).toBe("pending");
  });
});
