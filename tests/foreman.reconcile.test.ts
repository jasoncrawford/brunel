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
});
