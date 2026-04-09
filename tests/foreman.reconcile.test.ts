import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import { WorkerRegistry } from "../src/foreman/models/worker-registry.js";
import { createForemanWss } from "../src/foreman/controllers/wss.js";
import { TaskManager } from "../src/foreman/models/task-model.js";
import { Task } from "../src/foreman/models/task.js";
import { setupInMemoryTasks } from "./helpers/task.js";
import { loadDefaultConfig } from "../src/config.js";
const defaultCfg = await loadDefaultConfig();
import type { TaskIssue } from "../src/types.js";

const TASK_LABEL = "brunel:ready";

function makeIssue(n: number): TaskIssue {
  return { number: n, title: `Issue ${n}`, body: "body", labels: [TASK_LABEL], repoUrl: "https://github.com/o/r" };
}

let registry: WorkerRegistry;
let taskManager: TaskManager;
let reconcile: () => Promise<void>;
let routeEvent: (id: string, name: string, payload: unknown) => Promise<void>;

beforeEach(() => {
  taskManager = new TaskManager();
  setupInMemoryTasks(taskManager);
  registry = new WorkerRegistry();
  const server = http.createServer();
  ({ reconcile, routeEvent } = createForemanWss(taskManager, registry, server, { ...defaultCfg, taskLabel: TASK_LABEL }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reconcile()", () => {
  it("is exposed in the return value of createForemanWss", () => {
    expect(typeof reconcile).toBe("function");
  });

  it("creates a task for each entry in labeledIssues that has no task yet", async () => {
    taskManager.trackIssue(42, makeIssue(42), true);
    await reconcile();
    const t = await Task.get("42");
    expect(t?.issueNumber).toBe(42);
    expect(t?.title).toBe("Issue 42");
    expect(taskManager.isDepsLoaded(42)).toBe(true);
    expect(t?.status).toBe("pending");
  });

  it("creates task with depsLoaded: false when entry says false", async () => {
    taskManager.trackIssue(7, makeIssue(7));
    await reconcile();
    expect(taskManager.isDepsLoaded(7)).toBe(false);
  });

  it("does not create a duplicate task if one already exists for the issue", async () => {
    await Task.upsert("42", 42, "test/repo", "Existing", "b", []);
    taskManager.trackIssue(42, makeIssue(42), true);
    await reconcile();
    // Only one task for issue 42 exists (no duplicate)
    expect(await Task.getByIssue(42)).toBeDefined();
    // Title is synced from GitHub
    expect((await Task.get("42"))?.title).toBe("Issue 42");
  });

  it("syncs title from labeledIssues to an existing task", async () => {
    await Task.upsert("42", 42, "test/repo", "", "b", []);
    taskManager.trackIssue(42, { ...makeIssue(42), title: "Real Title" }, true);
    await reconcile();
    expect((await Task.get("42"))?.title).toBe("Real Title");
  });

  it("calls updateContent for existing tasks (not upsert)", async () => {
    // Pre-seed an existing task
    await Task.upsert("42", 42, "test/repo", "Old Title", "old", []);
    // Clear the mock's call history so we only count calls made during reconcile
    vi.mocked(Task.upsert).mockClear();

    // Track the issue with updated content
    taskManager.trackIssue(42, { ...makeIssue(42), title: "New Title", body: "new body", labels: ["brunel:ready", "bug"] }, true);

    await reconcile();

    // updateContent should be called (via spied instance), upsert should NOT be called again
    expect(vi.mocked(Task.upsert)).not.toHaveBeenCalled();
    const t = await Task.get("42");
    expect(t?.title).toBe("New Title");
    expect(t?.body).toBe("new body");
    expect(t?.labels).toEqual(["brunel:ready", "bug"]);
  });

  it("syncs depsLoaded from labeledIssues to an existing task", async () => {
    await Task.upsert("5", 5, "test/repo", "T", "b", []);
    taskManager.trackIssue(5, makeIssue(5), true);
    await reconcile();
    expect(taskManager.isDepsLoaded(5)).toBe(true);
  });

  it("syncs body and labels from labeledIssues to an existing task", async () => {
    await Task.upsert("42", 42, "test/repo", "T", "", []);
    taskManager.trackIssue(42, { ...makeIssue(42), body: "Real description", labels: ["brunel:ready", "bug"] }, true);
    await reconcile();
    expect((await Task.get("42"))?.body).toBe("Real description");
    expect((await Task.get("42"))?.labels).toEqual(["brunel:ready", "bug"]);
  });

  it("does not change depsLoaded on an existing task when labeledIssues also says false", async () => {
    await Task.upsert("5", 5, "test/repo", "T", "b", []);
    taskManager.trackIssue(5, makeIssue(5));
    await reconcile();
    expect(taskManager.isDepsLoaded(5)).toBe(false);
  });

  it("syncs depsLoaded=false from labeledIssues to an existing task (stale-dep bug)", async () => {
    await Task.upsert("5", 5, "test/repo", "T", "b", []);
    taskManager.trackIssue(5, makeIssue(5), true);
    // Reset depsLoaded to false — simulating an edit that cleared deps
    taskManager.trackIssue(5, makeIssue(5));
    await reconcile();
    expect(taskManager.isDepsLoaded(5)).toBe(false);
  });

  it("does not assign a pending task when its depsLoaded is false after reconcile", async () => {
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    registry.register("w1", fakeWs, "idle");

    await Task.upsert("42", 42, "test/repo", "T", "b", []);
    taskManager.trackIssue(42, makeIssue(42)); // depsLoaded defaults to false
    await reconcile();

    expect(taskManager.isDepsLoaded(42)).toBe(false);
    expect((await Task.get("42"))?.status).toBe("pending");
    expect(fakeWs.send).not.toHaveBeenCalledWith(expect.stringContaining('"task_assigned"'));
  });

  it("removes a pending task whose issue is no longer in labeledIssues", async () => {
    await Task.upsert("9", 9, "test/repo", "T", "b", []);
    // labeledIssues is empty — issue 9 has no label
    await reconcile();
    expect(await Task.get("9")).toBeNull();
  });

  it("calls task.delete when reconcile removes a pending task", async () => {
    const { addTask } = setupInMemoryTasks(taskManager);
    const task = addTask({ task_id: "9", issue_number: 9, repo: "test/repo", title: "T", body: "b", labels: [] });
    const spyDelete = vi.spyOn(task, "delete");

    // No trackIssue — issue 9 is not in labeledIssues, so reconcile should delete it
    await reconcile();

    expect(spyDelete).toHaveBeenCalled();
  });

  it("does NOT remove an assigned task even if its issue is not in labeledIssues", async () => {
    await Task.upsert("9", 9, "test/repo", "T", "b", []);
    const t = await Task.get("9");
    await t!.assign("worker-1");
    await reconcile();
    expect(await Task.get("9")).toBeDefined();
    expect((await Task.get("9"))?.status).toBe("assigned");
  });

  it("does NOT remove a complete task even if its issue is not in labeledIssues", async () => {
    await Task.upsert("9", 9, "test/repo", "T", "b", []);
    const t = await Task.get("9");
    await t!.complete();
    await reconcile();
    expect(await Task.get("9")).toBeDefined();
    expect((await Task.get("9"))?.status).toBe("complete");
  });

  it("calls tryAssignWork for each idle worker, assigning pending ready tasks", async () => {
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    registry.register("w1", fakeWs, "idle");

    taskManager.trackIssue(42, makeIssue(42), true);
    await reconcile();

    await new Promise((r) => setImmediate(r));

    expect(fakeWs.send).toHaveBeenCalledWith(expect.stringContaining('"task_assigned"'));
    expect((await Task.get("42"))?.status).toBe("assigned");
    expect(registry.get("w1")?.status).toBe("busy");
  });
});

describe("issues/closed — task lifecycle", () => {
  it("marks an assigned task closed when its issue is closed", async () => {
    taskManager.trackIssue(142, makeIssue(142), true);
    await Task.upsert("142", 142, "test/repo", "T", "b", []);
    const t = await Task.get("142");
    await t!.assign("worker-1");

    await routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 142, title: "T", body: "", labels: [] },
    });

    expect((await Task.get("142"))?.status).toBe("closed");
  });

  it("leaves a complete task complete when its issue is closed again", async () => {
    taskManager.trackIssue(143, makeIssue(143), true);
    await Task.upsert("143", 143, "test/repo", "T", "b", []);
    const t = await Task.get("143");
    await t!.complete();

    await routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 143, title: "T", body: "", labels: [] },
    });

    expect((await Task.get("143"))?.status).toBe("complete");
  });

  it("deletes a pending task when its issue is closed and no worker is assigned", async () => {
    taskManager.trackIssue(144, makeIssue(144), true);
    await Task.upsert("144", 144, "test/repo", "T", "b", []);

    await routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 144, title: "T", body: "", labels: [] },
    });

    expect(await Task.get("144")).toBeNull();
  });

  it("marks an assigned task closed when its issue is closed (preserved for worker)", async () => {
    taskManager.trackIssue(145, makeIssue(145), true);
    await Task.upsert("145", 145, "test/repo", "T", "b", []);
    const t = await Task.get("145");
    await t!.assign("worker-1");

    await routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 145, title: "T", body: "", labels: [] },
    });

    expect((await Task.get("145"))?.status).toBe("closed");
  });

  it("calls task.close for a pending task when its issue is closed", async () => {
    const { addTask } = setupInMemoryTasks(taskManager);
    const task = addTask({ task_id: "42", issue_number: 42, repo: "test/repo", title: "T", body: "b", labels: [] });
    const spyClose = vi.spyOn(task, "close");

    taskManager.trackIssue(42, makeIssue(42), true);

    await routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 42, title: "T", body: "", labels: [] },
    });

    await new Promise((r) => setImmediate(r));
    expect(spyClose).toHaveBeenCalled();
  });
});

describe("startDepsLoad() error handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("task remains pending with depsLoaded: false when dep fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

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

    expect(taskManager.isDepsLoaded(42)).toBe(false);

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(taskManager.isDepsLoaded(42)).toBe(false);
    expect((await Task.get("42"))?.status).toBe("pending");
  });
});
