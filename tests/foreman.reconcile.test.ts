import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import { TaskQueue, WorkerRegistry, TaskModel, createForemanWss } from "../src/foreman.js";
import { loadDefaultConfig } from "../src/config.js";
const defaultCfg = await loadDefaultConfig();
import type { TaskIssue } from "../src/types.js";
import type { TaskStore } from "../src/db.js";

const TASK_LABEL = "brunel:ready";

function makeIssue(n: number): TaskIssue {
  return { number: n, title: `Issue ${n}`, body: "body", labels: [TASK_LABEL], repoUrl: "https://github.com/o/r" };
}

let queue: TaskQueue;
let registry: WorkerRegistry;
let taskModel: TaskModel;
let reconcile: () => void;
let routeEvent: (id: string, name: string, payload: unknown) => void;

beforeEach(() => {
  queue = new TaskQueue();
  registry = new WorkerRegistry();
  const server = http.createServer();
  ({ reconcile, routeEvent, taskModel } = createForemanWss(queue, registry, server, {
    taskLabel: TASK_LABEL,
    reclaimTimeoutMs: defaultCfg.workerReclaimTimeoutMs,
  }));
});

describe("reconcile()", () => {
  it("is exposed in the return value of createForemanWss", () => {
    expect(typeof reconcile).toBe("function");
  });

  it("creates a task for each entry in labeledIssues that has no task yet", () => {
    taskModel.trackIssue(42, makeIssue(42), true);
    reconcile();
    const t = queue.get("42");
    expect(t?.issueNumber).toBe(42);
    expect(t?.title).toBe("Issue 42");
    expect(t?.depsLoaded).toBe(true);
    expect(t?.status).toBe("pending");
  });

  it("creates task with depsLoaded: false when entry says false", () => {
    taskModel.trackIssue(7, makeIssue(7));
    reconcile();
    expect(queue.get("7")?.depsLoaded).toBe(false);
  });

  it("does not create a duplicate task if one already exists for the issue", () => {
    queue.addTask({ taskId: "42", issueNumber: 42, title: "Existing", body: "b", labels: [], repoUrl: "", depsLoaded: true });
    taskModel.trackIssue(42, makeIssue(42), true);
    reconcile();
    // Only one task for issue 42 exists (no duplicate created)
    expect(queue.getTaskForIssue(42)).toBeDefined();
    // Title is synced from GitHub
    expect(queue.get("42")?.title).toBe("Issue 42");
  });

  it("syncs title from labeledIssues to an existing in-memory task", () => {
    // Simulates: task restored from DB with empty/stale title, then GitHub data loaded.
    queue.addTask({ taskId: "42", issueNumber: 42, title: "", body: "b", labels: [], repoUrl: "", depsLoaded: true });
    taskModel.trackIssue(42, { ...makeIssue(42), title: "Real Title" }, true);
    reconcile();
    expect(queue.get("42")?.title).toBe("Real Title");
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
      listTasks: vi.fn().mockResolvedValue([]),
    };
    const server2 = http.createServer();
    const { reconcile: rec2, taskModel: taskModel2 } = createForemanWss(queue, registry, server2, {
      taskLabel: TASK_LABEL,
      reclaimTimeoutMs: defaultCfg.workerReclaimTimeoutMs,
      taskStore: mockStore as any,
    });

    // Existing task in queue
    queue.addTask({ taskId: "42", issueNumber: 42, title: "Old Title", body: "old", labels: [], repoUrl: "", depsLoaded: true });
    taskModel2.trackIssue(42, { ...makeIssue(42), title: "New Title", body: "new body", labels: ["brunel:ready", "bug"] }, true);

    rec2();
    await new Promise((r) => setImmediate(r));

    // updateTaskContent should be called for the existing task
    expect(mockStore.updateTaskContent).toHaveBeenCalledWith("42", "New Title", "new body", ["brunel:ready", "bug"]);
    // upsertTask should NOT be called (it resets status to pending)
    expect(mockStore.upsertTask).not.toHaveBeenCalled();
  });

  it("syncs depsLoaded from labeledIssues to an existing task that has depsLoaded: false", () => {
    queue.addTask({ taskId: "5", issueNumber: 5, title: "T", body: "b", labels: [], repoUrl: "", depsLoaded: false });
    taskModel.trackIssue(5, makeIssue(5), true);
    reconcile();
    expect(queue.get("5")?.depsLoaded).toBe(true);
  });

  it("syncs body and labels from labeledIssues to an existing task (startup restore fix)", () => {
    // Simulates: task restored from DB with empty body/labels, then GitHub data loaded.
    queue.addTask({ taskId: "42", issueNumber: 42, title: "T", body: "", labels: [], repoUrl: "", depsLoaded: true });
    taskModel.trackIssue(42, { ...makeIssue(42), body: "Real description", labels: ["brunel:ready", "bug"] }, true);
    reconcile();
    expect(queue.get("42")?.body).toBe("Real description");
    expect(queue.get("42")?.labels).toEqual(["brunel:ready", "bug"]);
  });

  it("does not change depsLoaded on an existing task when labeledIssues also says false", () => {
    queue.addTask({ taskId: "5", issueNumber: 5, title: "T", body: "b", labels: [], repoUrl: "", depsLoaded: false });
    taskModel.trackIssue(5, makeIssue(5));
    reconcile();
    expect(queue.get("5")?.depsLoaded).toBe(false);
  });

  it("syncs depsLoaded=false from labeledIssues to an existing task that has depsLoaded: true (stale-dep bug)", () => {
    // Simulates: issue body was edited → labeledIssues.depsLoaded reset to false,
    // but task.depsLoaded is still true. reconcile() must propagate false → task.
    queue.addTask({ taskId: "5", issueNumber: 5, title: "T", body: "b", labels: [], repoUrl: "", depsLoaded: true });
    taskModel.trackIssue(5, makeIssue(5));
    reconcile();
    expect(queue.get("5")?.depsLoaded).toBe(false);
  });

  it("does not assign a pending task via tryAssignWork when its depsLoaded is false after reconcile", () => {
    // The worker is idle, but the task should NOT be assigned because depsLoaded is false.
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    registry.register("w1", fakeWs, "idle");

    // Task exists with depsLoaded: true but labeledIssues says false (e.g. mid-reload).
    queue.addTask({ taskId: "42", issueNumber: 42, title: "T", body: "b", labels: [], repoUrl: "", depsLoaded: true });
    taskModel.trackIssue(42, makeIssue(42)); // depsLoaded defaults to false
    reconcile();

    // reconcile must have propagated depsLoaded=false, so the task must NOT be assigned.
    expect(queue.get("42")?.depsLoaded).toBe(false);
    expect(queue.get("42")?.status).toBe("pending");
    expect(fakeWs.send).not.toHaveBeenCalledWith(expect.stringContaining('"task_assigned"'));
  });

  it("removes a pending task whose issue is no longer in labeledIssues", () => {
    queue.addTask({ taskId: "9", issueNumber: 9, title: "T", body: "b", labels: [], repoUrl: "" });
    // labeledIssues is empty — issue 9 has no label
    reconcile();
    expect(queue.get("9")).toBeUndefined();
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
      updateTaskPr: vi.fn().mockResolvedValue(undefined),
      listTasks: vi.fn().mockResolvedValue([]),
    };
    const spyQueue = new TaskQueue();
    const spyRegistry = new WorkerRegistry();
    const spyServer = http.createServer();
    const { reconcile: spyReconcile } = createForemanWss(spyQueue, spyRegistry, spyServer, {
      taskLabel: TASK_LABEL,
      reclaimTimeoutMs: defaultCfg.workerReclaimTimeoutMs,
      taskStore: mockStore,
    });

    spyQueue.addTask({ taskId: "9", issueNumber: 9, title: "T", body: "b", labels: [], repoUrl: "" });
    spyReconcile();

    expect(spyQueue.get("9")).toBeUndefined();
    await Promise.resolve();
    expect(deleteTask).toHaveBeenCalledWith("9");
  });

  it("does NOT remove an assigned task even if its issue is not in labeledIssues", () => {
    queue.addTask({ taskId: "9", issueNumber: 9, title: "T", body: "b", labels: [], repoUrl: "" });
    queue.assignTask("9", "worker-1");
    reconcile();
    expect(queue.get("9")).toBeDefined();
    expect(queue.get("9")?.status).toBe("assigned");
  });

  it("does NOT remove a complete task even if its issue is not in labeledIssues", () => {
    queue.addTask({ taskId: "9", issueNumber: 9, title: "T", body: "b", labels: [], repoUrl: "" });
    queue.completeTask("9");
    reconcile();
    expect(queue.get("9")).toBeDefined();
    expect(queue.get("9")?.status).toBe("complete");
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
    expect(queue.get("42")?.status).toBe("assigned");
    expect(registry.get("w1")?.status).toBe("busy");
  });
});

describe("issues/closed — task lifecycle", () => {
  it("marks an assigned task complete when its issue is closed", () => {
    taskModel.trackIssue(42, makeIssue(42), true);
    queue.addTask({ taskId: "42", issueNumber: 42, title: "T", body: "b", labels: [], repoUrl: "" });
    queue.assignTask("42", "worker-1");

    routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 42, title: "T", body: "", labels: [] },
    });

    expect(queue.get("42")?.status).toBe("complete");
  });

  it("leaves a complete task complete when its issue is closed again", () => {
    taskModel.trackIssue(42, makeIssue(42), true);
    queue.addTask({ taskId: "42", issueNumber: 42, title: "T", body: "b", labels: [], repoUrl: "" });
    queue.completeTask("42");

    routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 42, title: "T", body: "", labels: [] },
    });

    expect(queue.get("42")?.status).toBe("complete");
  });

  it("removes a pending task from the task list when its issue is closed", () => {
    // Bug #385: closing a pending issue should remove it from the task list.
    // Previously, issues/closed did not remove the issue from labeledIssues,
    // so reconcile() never removed the pending task.
    taskModel.trackIssue(42, makeIssue(42), true);
    queue.addTask({ taskId: "42", issueNumber: 42, title: "T", body: "b", labels: [], repoUrl: "" });

    routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 42, title: "T", body: "", labels: [] },
    });

    expect(queue.get("42")).toBeUndefined();
  });

  it("does not mark a pending task complete (just removes it) when its issue is closed", () => {
    // Closing should trigger removal via reconcile, not a status change to complete.
    taskModel.trackIssue(42, makeIssue(42), true);
    queue.addTask({ taskId: "42", issueNumber: 42, title: "T", body: "b", labels: [], repoUrl: "" });

    routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 42, title: "T", body: "", labels: [] },
    });

    // Task should be gone entirely, not stuck at "pending" and not bumped to "complete"
    expect(queue.get("42")).toBeUndefined();
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
    expect(queue.get("42")?.depsLoaded).toBe(false);

    // Wait for the async startDepsLoad chain to fail and settle
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    // After failure, depsLoaded must still be false and task still pending
    expect(queue.get("42")?.depsLoaded).toBe(false);
    expect(queue.get("42")?.status).toBe("pending");
  });
});
