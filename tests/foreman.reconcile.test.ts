import { describe, it, expect, beforeEach } from "vitest";
import http from "http";
import { TaskQueue, WorkerRegistry, createForemanWss } from "../src/foreman.js";
import type { LabeledIssueState } from "../src/types.js";

const TASK_LABEL = "brunel:ready";

function makeIssue(n: number): LabeledIssueState["issue"] {
  return { number: n, title: `Issue ${n}`, body: "body", labels: [TASK_LABEL], repoUrl: "https://github.com/o/r" };
}

describe("reconcile()", () => {
  let queue: TaskQueue;
  let registry: WorkerRegistry;
  let labeledIssues: Map<number, LabeledIssueState>;
  let reconcile: () => void;

  beforeEach(() => {
    queue = new TaskQueue();
    registry = new WorkerRegistry();
    labeledIssues = new Map();
    const server = http.createServer();
    ({ reconcile } = createForemanWss(queue, registry, server, {
      taskLabel: TASK_LABEL,
      labeledIssues,
    }));
  });

  it("is exposed in the return value of createForemanWss", () => {
    expect(typeof reconcile).toBe("function");
  });

  it("creates a task for each entry in labeledIssues that has no task yet", () => {
    labeledIssues.set(42, { issue: makeIssue(42), depsLoaded: true });
    reconcile();
    const t = queue.get("42");
    expect(t?.issueNumber).toBe(42);
    expect(t?.title).toBe("Issue 42");
    expect(t?.depsLoaded).toBe(true);
    expect(t?.status).toBe("pending");
  });

  it("creates task with depsLoaded: false when entry says false", () => {
    labeledIssues.set(7, { issue: makeIssue(7), depsLoaded: false });
    reconcile();
    expect(queue.get("7")?.depsLoaded).toBe(false);
  });

  it("does not create a duplicate task if one already exists for the issue", () => {
    queue.addTask({ taskId: "42", issueNumber: 42, title: "Existing", body: "b", labels: [], repoUrl: "", depsLoaded: true });
    labeledIssues.set(42, { issue: makeIssue(42), depsLoaded: true });
    reconcile();
    // Title must not be overwritten by reconcile
    expect(queue.get("42")?.title).toBe("Existing");
  });

  it("syncs depsLoaded from labeledIssues to an existing task that has depsLoaded: false", () => {
    queue.addTask({ taskId: "5", issueNumber: 5, title: "T", body: "b", labels: [], repoUrl: "", depsLoaded: false });
    labeledIssues.set(5, { issue: makeIssue(5), depsLoaded: true });
    reconcile();
    expect(queue.get("5")?.depsLoaded).toBe(true);
  });

  it("does not change depsLoaded on an existing task when labeledIssues also says false", () => {
    queue.addTask({ taskId: "5", issueNumber: 5, title: "T", body: "b", labels: [], repoUrl: "", depsLoaded: false });
    labeledIssues.set(5, { issue: makeIssue(5), depsLoaded: false });
    reconcile();
    expect(queue.get("5")?.depsLoaded).toBe(false);
  });
});
