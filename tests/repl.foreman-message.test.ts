/**
 * Tests that the worker prints a concise one-liner for every foreman message received.
 * This ensures no message arrives silently, even when the worker is busy running a query.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stripAnsi } from "./helpers.js";
import { printForemanMessage, stopStatus, setVerbose } from "../src/display.js";
import type { ForemanMessage } from "../src/types.js";

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
});

describe("printForemanMessage", () => {
  it("task_assigned prints issue number and title", () => {
    const msg: ForemanMessage = {
      type: "task_assigned",
      taskId: "task-1",
      issue: { number: 42, title: "Fix the bug", body: "", labels: [], repoUrl: "https://github.com/owner/repo" },
    };
    const output = captureOutput(() => printForemanMessage(msg));
    const plain = stripAnsi(output);
    expect(plain).toContain("#42");
    expect(plain).toContain("Fix the bug");
  });

  it("task_assigned output is a single line (no embedded newlines in content)", () => {
    const msg: ForemanMessage = {
      type: "task_assigned",
      taskId: "task-1",
      issue: { number: 7, title: "Multi word title", body: "", labels: [], repoUrl: "https://github.com/owner/repo" },
    };
    const output = captureOutput(() => printForemanMessage(msg));
    // Strip trailing newline from console.log and check no embedded newlines
    const trimmed = stripAnsi(output).trim();
    expect(trimmed).not.toContain("\n");
  });

  it("event_notification prints event name", () => {
    const msg: ForemanMessage = {
      type: "event_notification",
      taskId: "task-1",
      event: { id: "evt-1", name: "issue_comment", payload: {} },
    };
    const output = captureOutput(() => printForemanMessage(msg));
    const plain = stripAnsi(output);
    expect(plain).toContain("issue_comment");
  });

  it("event_notification output is a single line (no embedded newlines in content)", () => {
    const msg: ForemanMessage = {
      type: "event_notification",
      taskId: "task-1",
      event: { id: "evt-2", name: "pull_request", payload: {} },
    };
    const output = captureOutput(() => printForemanMessage(msg));
    const trimmed = stripAnsi(output).trim();
    expect(trimmed).not.toContain("\n");
  });

  it("standby prints a waiting message", () => {
    const msg: ForemanMessage = { type: "standby" };
    const output = captureOutput(() => printForemanMessage(msg));
    const plain = stripAnsi(output);
    expect(plain.toLowerCase()).toMatch(/standby|waiting/);
  });

  it("standby output is a single line (no embedded newlines in content)", () => {
    const msg: ForemanMessage = { type: "standby" };
    const output = captureOutput(() => printForemanMessage(msg));
    const trimmed = stripAnsi(output).trim();
    expect(trimmed).not.toContain("\n");
  });
});

describe("printForemanMessage - _default", () => {
  it("unknown type prints foreman/<type>", () => {
    const output = captureOutput(() => printForemanMessage({ type: "unknown_future_type" } as any));
    expect(stripAnsi(output)).toContain("foreman/unknown_future_type");
  });
});
