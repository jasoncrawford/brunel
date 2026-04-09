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

  it("does not assign a pending task when its blockersLoaded is false", async () => {
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    registry.register("w1", fakeWs, "idle");

    await Task.upsert("42", 42, "test/repo", "T", "b", []);
    taskManager.trackIssue(42); // blockersLoaded defaults to false — NOT calling markBlockersLoaded
    await reconcile();

    expect(taskManager.isBlockersLoaded(42)).toBe(false);
    expect((await Task.get("42"))?.status).toBe("pending");
    expect(fakeWs.send).not.toHaveBeenCalledWith(expect.stringContaining('"task_assigned"'));
  });

  it("assigns a pending task to an idle worker when blockersLoaded is true", async () => {
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    registry.register("w1", fakeWs, "idle");

    await Task.upsert("42", 42, "test/repo", "T", "b", []);
    taskManager.trackIssue(42);
    taskManager.markBlockersLoaded(42);
    await reconcile();

    await new Promise((r) => setImmediate(r));

    expect(fakeWs.send).toHaveBeenCalledWith(expect.stringContaining('"task_assigned"'));
    expect((await Task.get("42"))?.status).toBe("assigned");
    expect(registry.get("w1")?.status).toBe("busy");
  });

  it("does NOT remove an assigned task (reconcile never deletes)", async () => {
    await Task.upsert("9", 9, "test/repo", "T", "b", []);
    const t = await Task.get("9");
    await t!.assign("worker-1");
    await reconcile();
    expect(await Task.get("9")).toBeDefined();
    expect((await Task.get("9"))?.status).toBe("assigned");
  });

  it("does NOT remove a complete task (reconcile never deletes)", async () => {
    await Task.upsert("9", 9, "test/repo", "T", "b", []);
    const t = await Task.get("9");
    await t!.complete();
    await reconcile();
    expect(await Task.get("9")).toBeDefined();
    expect((await Task.get("9"))?.status).toBe("complete");
  });
});

describe("issues/closed — task lifecycle", () => {
  it("marks an assigned task closed when its issue is closed", async () => {
    taskManager.trackIssue(142);
    taskManager.markBlockersLoaded(142);
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
    taskManager.trackIssue(143);
    taskManager.markBlockersLoaded(143);
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
    taskManager.trackIssue(144);
    taskManager.markBlockersLoaded(144);
    await Task.upsert("144", 144, "test/repo", "T", "b", []);

    await routeEvent("evt-1", "issues", {
      action: "closed",
      issue: { number: 144, title: "T", body: "", labels: [] },
    });

    expect(await Task.get("144")).toBeNull();
  });

  it("marks an assigned task closed when its issue is closed (preserved for worker)", async () => {
    taskManager.trackIssue(145);
    taskManager.markBlockersLoaded(145);
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

    taskManager.trackIssue(42);
    taskManager.markBlockersLoaded(42);

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

  it("task remains pending with blockersLoaded: false when dep fetch fails", async () => {
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

    expect(taskManager.isBlockersLoaded(42)).toBe(false);

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(taskManager.isBlockersLoaded(42)).toBe(false);
    expect((await Task.get("42"))?.status).toBe("pending");
  });
});
