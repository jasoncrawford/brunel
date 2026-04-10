import { vi } from "vitest";
import { Task } from "../../src/foreman/models/task.js";

/**
 * Sets up vi.spyOn on all Task static methods backed by an in-memory Map.
 * Returns helpers for seeding and inspecting the mock store.
 *
 * Call this in beforeEach. vi.restoreAllMocks() in afterEach will undo spies.
 */
export function setupInMemoryTasks(emitter?: { emit: (event: string) => void }) {
  const tasks = new Map<string, Task>();

  function notifyChange() {
    Task.events.emit("changed");
  }

  function spyInstanceMethods(task: Task) {
    vi.spyOn(task, "assign").mockImplementation(async (workerId: string) => {
      task.workerId = workerId;
      task.assignedAt = new Date().toISOString();
      notifyChange();
    });
    vi.spyOn(task, "complete").mockImplementation(async () => {
      task.completedAt = new Date().toISOString();
      notifyChange();
    });
    vi.spyOn(task, "revert").mockImplementation(async () => {
      task.workerId = null;
      notifyChange();
    });
    vi.spyOn(task, "close").mockImplementation(async () => {
      task.issueClosedAt = new Date().toISOString();
      notifyChange();
    });
    vi.spyOn(task, "reopen").mockImplementation(async () => {
      task.issueClosedAt = null;
      notifyChange();
    });
    vi.spyOn(task, "registerPr").mockImplementation(async (prNumber: number, branch: string | null) => {
      task.prNumber = prNumber;
      task.branch = branch;
      notifyChange();
    });
    vi.spyOn(task, "unregisterPr").mockImplementation(async () => {
      task.prNumber = null;
      task.branch = null;
      notifyChange();
    });
    vi.spyOn(task, "mergePr").mockImplementation(async () => {
      task.prMergedAt = new Date().toISOString();
      notifyChange();
    });
    vi.spyOn(task, "updateContent").mockImplementation(async (title: string, body: string, labels: string[]) => {
      task.title = title;
      task.body = body;
      task.labels = labels;
      notifyChange();
    });
    vi.spyOn(task, "delete").mockImplementation(async () => {
      if (task.assignedAt === null) {
        tasks.delete(task.taskId);
      }
      notifyChange();
    });
  }

  vi.spyOn(Task, "get").mockImplementation(async (id) => tasks.get(id) ?? null);
  vi.spyOn(Task, "getByIssue").mockImplementation(async (n) =>
    [...tasks.values()].find(t => t.issueNumber === n) ?? null
  );
  vi.spyOn(Task, "getByPr").mockImplementation(async (n) =>
    [...tasks.values()].find(t => t.prNumber === n) ?? null
  );
  vi.spyOn(Task, "getByWorker").mockImplementation(async (w) =>
    [...tasks.values()].find(t => t.workerId === w && !t.completedAt) ?? null
  );
  vi.spyOn(Task, "list").mockImplementation(async (opts) => {
    let result = [...tasks.values()];
    if (opts?.cancelable) {
      result = result.filter(t =>
        t.workerId === null && !t.completedAt && !t.issueClosedAt && !t.prMergedAt
      );
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, opts?.limit ?? 200);
  });
  vi.spyOn(Task, "upsert").mockImplementation(async (taskId, issueNumber, repo, title, body, labels) => {
    const existing = tasks.get(taskId);
    if (existing) {
      existing.workerId = null;
      existing.assignedAt = null;
      existing.completedAt = null;
      existing.issueClosedAt = null;
      existing.prMergedAt = null;
      existing.title = title;
      existing.body = body;
      existing.labels = labels;
      notifyChange();
      return existing;
    }
    const task = Task.fromTest({ task_id: taskId, issue_number: issueNumber, repo, title, body, labels });
    spyInstanceMethods(task);
    tasks.set(taskId, task);
    notifyChange();
    return task;
  });

  /** Helper: seed a task directly without calling upsert */
  function addTask(fields: Parameters<typeof Task.fromTest>[0]): Task {
    const task = Task.fromTest(fields);
    spyInstanceMethods(task);
    tasks.set(task.taskId, task);
    return task;
  }

  return { tasks, addTask };
}
