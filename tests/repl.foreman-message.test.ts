/**
 * Tests that the worker prints a concise one-liner for every foreman message received.
 * This ensures no message arrives silently, even when the worker is busy running a query.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { stripAnsi } from "./helpers.js";
import { printForWorkerMsg, stopStatus, setVerbose } from "../src/agent/display.js";
import type { ForWorkerMsg } from "../src/types.js";

function captureOutput(fn: () => void): string {
  let output = "";
  const logSpy = vi.spyOn(console, "log").mockImplementation((s: any) => { output += String(s) + "\n"; });
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  fn();
  logSpy.mockRestore();
  writeSpy.mockRestore();
  return output;
}

beforeEach(() => {
  stopStatus();
  setVerbose(false);
});

afterEach(() => {
  stopStatus();
  setVerbose(false);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("printForWorkerMsg", () => {
  it("task_assigned prints issue number and title (verbose only)", () => {
    const msg: ForWorkerMsg = {
      type: "task_assigned",
      taskId: "task-1",
      issue: { number: 42, title: "Fix the bug", body: "", labels: [], repoUrl: "https://github.com/owner/repo" },
    };
    // task_assigned is verbose-only — silent in default mode
    const quietOutput = captureOutput(() => printForWorkerMsg(msg));
    expect(stripAnsi(quietOutput).trim()).toBe("");

    setVerbose(true);
    const verboseOutput = captureOutput(() => printForWorkerMsg(msg));
    const plain = stripAnsi(verboseOutput);
    expect(plain).toContain("#42");
    expect(plain).toContain("Fix the bug");
  });

  it("task_assigned output is a single line (no embedded newlines in content)", () => {
    const msg: ForWorkerMsg = {
      type: "task_assigned",
      taskId: "task-1",
      issue: { number: 7, title: "Multi word title", body: "", labels: [], repoUrl: "https://github.com/owner/repo" },
    };
    const output = captureOutput(() => printForWorkerMsg(msg));
    // Strip trailing newline from console.log and check no embedded newlines
    const trimmed = stripAnsi(output).trim();
    expect(trimmed).not.toContain("\n");
  });

  it("event_notification, VERBOSE=false → silent", () => {
    const msg: ForWorkerMsg = {
      type: "event_notification",
      taskId: "task-1",
      event: { id: "evt-1", name: "issue_comment", payload: {} },
    };
    const output = captureOutput(() => printForWorkerMsg(msg));
    expect(stripAnsi(output).trim()).toBe("");
  });

  it("event_notification, VERBOSE=true → prints event name", () => {
    setVerbose(true);
    const msg: ForWorkerMsg = {
      type: "event_notification",
      taskId: "task-1",
      event: { id: "evt-1", name: "issue_comment", payload: {} },
    };
    const output = captureOutput(() => printForWorkerMsg(msg));
    expect(stripAnsi(output)).toContain("issue_comment");
  });

  it("event_notification, VERBOSE=true → includes a timestamp in [HH:MM:SS] format", () => {
    setVerbose(true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T14:05:03.000Z"));
    const msg: ForWorkerMsg = {
      type: "event_notification",
      taskId: "task-1",
      event: { id: "evt-1", name: "issue_comment", payload: {} },
    };
    const output = captureOutput(() => printForWorkerMsg(msg));
    const plain = stripAnsi(output);
    expect(plain).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
  });

  it("event_notification, VERBOSE=true → includes check_run details", () => {
    setVerbose(true);
    const msg: ForWorkerMsg = {
      type: "event_notification",
      taskId: "task-1",
      event: {
        id: "evt-cr",
        name: "check_run",
        payload: { action: "completed", check_run: { name: "CI / build", conclusion: "failure" } },
      },
    };
    const output = captureOutput(() => printForWorkerMsg(msg));
    const plain = stripAnsi(output);
    expect(plain).toContain("CI / build");
    expect(plain).toContain("failure");
  });

  it("event_notification, VERBOSE=true → includes action in name/action format when payload has action", () => {
    setVerbose(true);
    const msg: ForWorkerMsg = {
      type: "event_notification",
      taskId: "task-1",
      event: { id: "evt-1", name: "check_suite", payload: { action: "completed" } },
    };
    const output = captureOutput(() => printForWorkerMsg(msg));
    const plain = stripAnsi(output);
    expect(plain).toContain("check_suite/completed");
  });

  it("event_notification, VERBOSE=true → output is a single line (no embedded newlines in content)", () => {
    setVerbose(true);
    const msg: ForWorkerMsg = {
      type: "event_notification",
      taskId: "task-1",
      event: { id: "evt-2", name: "pull_request", payload: {} },
    };
    const output = captureOutput(() => printForWorkerMsg(msg));
    const trimmed = stripAnsi(output).trim();
    expect(trimmed).not.toContain("\n");
  });

});

describe("printForWorkerMsg - hello_ack", () => {
  it("hello_ack, VERBOSE=false → silent", () => {
    const msg: ForWorkerMsg = { type: "hello_ack", workerId: "w-1", status: "idle" };
    const output = captureOutput(() => printForWorkerMsg(msg));
    expect(stripAnsi(output).trim()).toBe("");
  });

  it("hello_ack, VERBOSE=true → prints ack status", () => {
    setVerbose(true);
    const msg: ForWorkerMsg = { type: "hello_ack", workerId: "w-1", status: "idle" };
    const output = captureOutput(() => printForWorkerMsg(msg));
    expect(stripAnsi(output)).toContain("idle");
  });

  it("hello_ack, VERBOSE=true → includes status for busy", () => {
    setVerbose(true);
    const msg: ForWorkerMsg = { type: "hello_ack", workerId: "w-1", status: "busy" };
    const output = captureOutput(() => printForWorkerMsg(msg));
    expect(stripAnsi(output)).toContain("busy");
  });

  it("hello_ack, VERBOSE=true → includes status for cancelled", () => {
    setVerbose(true);
    const msg: ForWorkerMsg = { type: "hello_ack", workerId: "w-1", status: "cancelled" };
    const output = captureOutput(() => printForWorkerMsg(msg));
    expect(stripAnsi(output)).toContain("cancelled");
  });
});

describe("printForWorkerMsg - _default", () => {
  it("unknown type prints <type>", () => {
    const output = captureOutput(() => printForWorkerMsg({ type: "unknown_future_type" } as any));
    expect(stripAnsi(output)).toContain("unknown_future_type");
  });
});
