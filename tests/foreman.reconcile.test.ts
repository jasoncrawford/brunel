import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import { WorkerRegistry } from "../src/foreman/models/worker-registry.js";
import { createForemanWss } from "../src/foreman/controllers/wss.js";
import { TaskModel } from "../src/foreman/models/task-model.js";
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
let reconcile: () => Promise<void>;
let routeEvent: (id: string, name: string, payload: unknown) => Promise<void>;

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

  it("creates a task for each entry in labeledIssues that has no task yet", async () => {
    taskModel.trackIssue(42, makeIssue(42), true);
    await reconcile();
    const t = await taskModel.get("42");
    expect(t?.issueNumber).toBe(42);
    expect(t?.title).toBe("Issue 42");
    expect(taskModel.isDepsLoaded(42)).toBe(true);
    expect(t?.status).toBe("pending");
  });

  it("creates task with depsLoaded: false when entry says false", async () => {
    taskModel.trackIssue(7, makeIssue(7));
    await reconcile();
    expect(taskModel.isDepsLoaded(7)).toBe(false);
  });

  it("does not create a duplicate task if one already exists for the issue", async () => {
    await taskModel.register("42", 42, "test/repo", "Existing", "b", []);
    taskModel.trackIssue(42, makeIssue(42), true);
    await reconcile();
    // Only one task for issue 42 exists (no duplicate created)
    expect(await taskModel.getTaskForIssue(42)).toBeDefined();
    // Title is synced from GitHub
    expect((await taskModel.get("42"))?.title).toBe("Issue 42");
  });

  it("syncs title from labeledIssues to an existing in-memory task", async () => {
    // Simulates: task restored from DB with empty/stale title, then GitHub data loaded.
    await taskModel.register("42", 42, "test/repo", "", "b", []);
    taskModel.trackIssue(42, { ...makeIssue(42), title: "Real Title" }, true);
    await reconcile();
    expect((await taskModel.get("42"))?.title).toBe("Real Title");
  });

  it("calls updateTaskContent for existing tasks (not upsertTask)", async () => {
    const mockStore = {
      upsertTask: vi.fn().mockResolvedValue(undefined),
      markAssigned: vi.fn().mockResolvedValue(undefined),
      markComplete: vi.fn().mockResolvedValue(undefined),
      markPending: vi.fn().mockResolvedValue(undefined),
      setIssueClosed: vi.fn().mockResolvedValue(undefined),
      clearIssueClosed: vi.fn().mockResolvedValue(undefined),
      setPrMerged: vi.fn().mockResolvedValue(undefined),
      updateTaskContent: vi.fn().mockResolvedValue(undefined),
      updateTaskPr: vi.fn().mockResolvedValue(undefined),
      deleteTask: vi.fn().mockResolvedValue(undefined),
      getTask: vi.fn().mockResolvedValue(null),
      getTaskByIssue: vi.fn().mockResolvedValue(null),
      getTaskByPr: vi.fn().mockResolvedValue(null),
      getTaskByWorker: vi.fn().mockResolvedValue(null),
      listTasks: vi.fn().mockResolvedValue([]),
    };

    // Make getTaskByIssue return a row after register so reconcile sees the existing task
    const storedRow = {
      taskId: "42", issueNumber: 42, repo: "test/repo", title: "Old Title",
      body: "old", labels: [],
      workerId: null, assignedAt: null, completedAt: null, issueClosedAt: null, prMergedAt: null,
      prNumber: null, branch: null, createdAt: new Date().toISOString(),
    };
    mockStore.getTaskByIssue.mockResolvedValue(storedRow);
    mockStore.getTask.mockResolvedValue(storedRow);

    const taskModel2 = new TaskModel(mockStore as any);
    const server2 = http.createServer();
    const { reconcile: rec2 } = createForemanWss(taskModel2, registry, server2, { ...defaultCfg, taskLabel: TASK_LABEL });

    // Existing task in store — trackIssue with updated content
    taskModel2.trackIssue(42, { ...makeIssue(42), title: "New Title", body: "new body", labels: ["brunel:ready", "bug"] }, true);

    await rec2();

    // updateTaskContent should be called for the existing task
    expect(mockStore.updateTaskContent).toHaveBeenCalledWith("42", "New Title", "new body", ["brunel:ready", "bug"]);
    // upsertTask should NOT be called (it resets status to pending)
    expect(mockStore.upsertTask).not.toHaveBeenCalled();
  });

  it("syncs depsLoaded from labeledIssues to an existing task that has depsLoaded: false", async () => {
    await taskModel.register("5", 5, "test/repo", "T", "b", []);
    taskModel.trackIssue(5, makeIssue(5), true);
    await reconcile();
    expect(taskModel.isDepsLoaded(5)).toBe(true);
  });

  it("syncs body and labels from labeledIssues to an existing task (startup restore fix)", async () => {
    // Simulates: task restored from DB with empty body/labels, then GitHub data loaded.
    await taskModel.register("42", 42, "test/repo", "T", "", []);
    taskModel.trackIssue(42, { ...makeIssue(42), body: "Real description", labels: ["brunel:ready", "bug"] }, true);
    await reconcile();
    expect((await taskModel.get("42"))?.body).toBe("Real description");
    expect((await taskModel.get("42"))?.labels).toEqual(["brunel:ready", "bug"]);
  });

  it("does not change depsLoaded on an existing task when labeledIssues also says false", async () => {
    await taskModel.register("5", 5, "test/repo", "T", "b", []);
    taskModel.trackIssue(5, makeIssue(5));
    await reconcile();
    expect(taskModel.isDepsLoaded(5)).toBe(false);
  });

  it("syncs depsLoaded=false from labeledIssues to an existing task that has depsLoaded: true (stale-dep bug)", async () => {
    // Simulates: issue body was edited → labeledIssues.depsLoaded reset to false,
    // but task.depsLoaded is still true. reconcile() must propagate false → task.
    await taskModel.register("5", 5, "test/repo", "T", "b", []);
    taskModel.trackIssue(5, makeIssue(5), true);
    // Now reset depsLoaded to false — simulating an edit that cleared deps
    taskModel.trackIssue(5, makeIssue(5));
    await reconcile();
    expect(taskModel.isDepsLoaded(5)).toBe(false);
  });

  it("does not assign a pending task via tryAssignWork when its depsLoaded is false after reconcile", async () => {
    // The worker is idle, but the task should NOT be assigned because depsLoaded is false.
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    registry.register("w1", fakeWs, "idle");

    // Task exists with depsLoaded: true but labeledIssues says false (e.g. mid-reload).
    await taskModel.register("42", 42, "test/repo", "T", "b", []);
    taskModel.trackIssue(42, makeIssue(42)); // depsLoaded defaults to false
    await reconcile();

    // reconcile must have propagated depsLoaded=false, so the task must NOT be assigned.
    expect(taskModel.isDepsLoaded(42)).toBe(false);
    expect((await taskModel.get("42"))?.status).toBe("pending");
    expect(fakeWs.send).not.toHaveBeenCalledWith(expect.stringContaining('"task_assigned"'));
  });

  it("removes a pending task whose issue is no longer in labeledIssues", async () => {
    await taskModel.register("9", 9, "test/repo", "T", "b", []);
    // labeledIssues is empty — issue 9 has no label
    await reconcile();
    expect(await taskModel.get("9")).toBeNull();
  });

  it("calls store.deleteTask when reconcile removes a pending task whose label was removed", async () => {
    const deleteTask = vi.fn().mockResolvedValue(undefined);
    const storedRow = {
      taskId: "9", issueNumber: 9, repo: "test/repo", title: "T",
      body: "b", labels: [],
      workerId: null, assignedAt: null, completedAt: null, issueClosedAt: null, prMergedAt: null,
      prNumber: null, branch: null, createdAt: new Date().toISOString(),
    };
    const mockStore: TaskStore = {
      upsertTask: vi.fn().mockResolvedValue(undefined),
      markAssigned: vi.fn().mockResolvedValue(undefined),
      markComplete: vi.fn().mockResolvedValue(undefined),
      markPending: vi.fn().mockResolvedValue(undefined),
      setIssueClosed: vi.fn().mockResolvedValue(undefined),
      clearIssueClosed: vi.fn().mockResolvedValue(undefined),
      setPrMerged: vi.fn().mockResolvedValue(undefined),
      deleteTask,
      getTask: vi.fn().mockResolvedValue(null),
      getTaskByIssue: vi.fn().mockResolvedValue(null),
      getTaskByPr: vi.fn().mockResolvedValue(null),
      getTaskByWorker: vi.fn().mockResolvedValue(null),
      updateTaskContent: vi.fn().mockResolvedValue(undefined),
      updateTaskPr: vi.fn().mockResolvedValue(undefined),
      listTasks: vi.fn().mockResolvedValue([storedRow]),
    };
    const spyTaskModel = new TaskModel(mockStore);
    const spyRegistry = new WorkerRegistry();
    const spyServer = http.createServer();
    const { reconcile: spyReconcile } = createForemanWss(spyTaskModel, spyRegistry, spyServer, { ...defaultCfg, taskLabel: TASK_LABEL });

    // No trackIssue — issue 9 is not in labeledIssues, so reconcile should cancel it
    await spyReconcile();

    expect(deleteTask).toHaveBeenCalledWith("9");
  });

  it("does NOT remove an assigned task even if its issue is not in labeledIssues", async () => {
    await taskModel.register("9", 9, "test/repo", "T", "b", []);
    await taskModel.assign("9", "worker-1");
    await reconcile();
    expect(await taskModel.get("9")).toBeDefined();
    expect((await taskModel.get("9"))?.status).toBe("assigned");
  });

  it("does NOT remove a complete task even if its issue is not in labeledIssues", async () => {
    await taskModel.register("9", 9, "test/repo", "T", "b", []);
    await taskModel.complete("9");
    await reconcile();
    expect(await taskModel.get("9")).toBeDefined();
    expect((await taskModel.get("9"))?.status).toBe("complete");
  });

  it("calls tryAssignWork for each idle worker, assigning pending ready tasks", async () => {
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    registry.register("w1", fakeWs, "idle");

    taskModel.trackIssue(42, makeIssue(42), true);
    await reconcile();

    // tryAssignWork is async (DB write then send), so flush the microtask queue.
    await new Promise((r) => setImmediate(r));

    // task_assigned message should have been sent to the idle worker
    expect(fakeWs.send).toHaveBeenCalledWith(expect.stringContaining('"task_assigned"'));
    expect((await taskModel.get("42"))?.status).toBe("assigned");
    expect(registry.get("w1")?.status).toBe("busy");
  });
});

describe("issues/closed — task lifecycle", () => {
  it("marks an assigned task closed when its issue is closed", async () => {
    taskModel.trackIssue(142, makeIssue(142), true);
    await taskModel.register("142", 142, "test/repo", "T", "b", []);
    await taskModel.assign("142", "worker-1");

    await routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 142, title: "T", body: "", labels: [] },
    });

    expect((await taskModel.get("142"))?.status).toBe("closed");
  });

  it("leaves a complete task complete when its issue is closed again", async () => {
    taskModel.trackIssue(143, makeIssue(143), true);
    await taskModel.register("143", 143, "test/repo", "T", "b", []);
    await taskModel.complete("143");

    await routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 143, title: "T", body: "", labels: [] },
    });

    expect((await taskModel.get("143"))?.status).toBe("complete");
  });

  it("deletes a pending task when its issue is closed and no worker is assigned", async () => {
    // When an issue is closed, pending/blocked tasks are cleaned up by reconcile.
    // Only tasks with an assigned worker are preserved (with status='closed').
    taskModel.trackIssue(144, makeIssue(144), true);
    await taskModel.register("144", 144, "test/repo", "T", "b", []);

    await routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 144, title: "T", body: "", labels: [] },
    });

    // Task is deleted since it was pending (not assigned to a worker)
    expect(await taskModel.get("144")).toBeNull();
  });

  it("marks an assigned task closed when its issue is closed (preserved for worker)", async () => {
    // Tasks with an assigned worker are preserved even if issue closes.
    // They get issueClosedAt set, deriving status as 'closed'.
    taskModel.trackIssue(145, makeIssue(145), true);
    await taskModel.register("145", 145, "test/repo", "T", "b", []);
    await taskModel.assign("145", "worker-1");

    await routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 145, title: "T", body: "", labels: [] },
    });

    // Task is preserved (assigned to worker) with closed status
    expect((await taskModel.get("145"))?.status).toBe("closed");
  });

  it("calls store.setIssueClosed for a pending task when its issue is closed", async () => {
    const storedRow = {
      taskId: "42", issueNumber: 42, repo: "test/repo", title: "T",
      body: "b", labels: [],
      workerId: null, assignedAt: null, completedAt: null, issueClosedAt: null, prMergedAt: null,
      prNumber: null, branch: null, createdAt: new Date().toISOString(),
    };
    const mockStore = {
      upsertTask: vi.fn().mockResolvedValue(undefined),
      markAssigned: vi.fn().mockResolvedValue(undefined),
      markComplete: vi.fn().mockResolvedValue(undefined),
      markPending: vi.fn().mockResolvedValue(undefined),
      setIssueClosed: vi.fn(async () => { storedRow.issueClosedAt = new Date().toISOString(); }),
      clearIssueClosed: vi.fn().mockResolvedValue(undefined),
      setPrMerged: vi.fn().mockResolvedValue(undefined),
      deleteTask: vi.fn().mockResolvedValue(undefined),
      getTask: vi.fn().mockImplementation(async () => storedRow),
      getTaskByIssue: vi.fn().mockImplementation(async () => storedRow),
      getTaskByPr: vi.fn().mockResolvedValue(null),
      getTaskByWorker: vi.fn().mockResolvedValue(null),
      updateTaskContent: vi.fn().mockResolvedValue(undefined),
      updateTaskPr: vi.fn().mockResolvedValue(undefined),
      listTasks: vi.fn().mockResolvedValue([]),
    };
    const tm2 = new TaskModel(mockStore as any);
    const r2 = new WorkerRegistry();
    const s2 = http.createServer();
    const { routeEvent: re2 } = createForemanWss(tm2, r2, s2, { ...defaultCfg, taskLabel: TASK_LABEL });

    tm2.trackIssue(42, makeIssue(42), true);

    await re2("evt-1", "issues", {
      action: "closed",
      issue: { number: 42, title: "T", body: "", labels: [] },
    });

    await new Promise((r) => setImmediate(r));
    expect(mockStore.setIssueClosed).toHaveBeenCalledWith("42");
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
    await routeEvent("evt-1", "issues", {
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

    // Task created by reconcile() with depsLoaded: false
    expect(taskModel.isDepsLoaded(42)).toBe(false);

    // Wait for the async startDepsLoad chain to fail and settle
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    // After failure, depsLoaded must still be false and task still pending
    expect(taskModel.isDepsLoaded(42)).toBe(false);
    expect((await taskModel.get("42"))?.status).toBe("pending");
  });
});
