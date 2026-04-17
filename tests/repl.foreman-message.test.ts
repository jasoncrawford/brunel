/**
 * Tests that the worker prints a concise one-liner for every foreman message received.
 * This ensures no message arrives silently, even when the worker is busy running a query.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { getConfig } from "../src/config.js";
import { Display } from "../src/agent/views/display.js";
import { StatusBar } from "../src/agent/views/status-bar.js";
import { stripAnsi } from "./helpers.js";
import * as Wire from "../shared/wire.js";

let testDisplay: Display;

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
  testDisplay = new Display(getConfig(), new StatusBar({ agentId: "test-agent" }));
  testDisplay.statusBar.stop();
  getConfig().verbose = false;
});

afterEach(() => {
  testDisplay.statusBar.stop();
  getConfig().verbose = false;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("printForemanMessage", () => {
  it("task_assigned prints issue number and title (verbose only)", () => {
    const msg: Wire.ForemanMessage = {
      type: "task_assigned",
      taskId: "task-1",
      issue: { number: 42, title: "Fix the bug", body: "", labels: [], repoUrl: "https://github.com/owner/repo" },
    };
    // task_assigned is verbose-only — silent in default mode
    const quietOutput = captureOutput(() => testDisplay.printForemanMessage(msg));
    expect(stripAnsi(quietOutput).trim()).toBe("");

    getConfig().verbose = true;
    const verboseOutput = captureOutput(() => testDisplay.printForemanMessage(msg));
    const plain = stripAnsi(verboseOutput);
    expect(plain).toContain("#42");
    expect(plain).toContain("Fix the bug");
  });

  it("task_assigned output is a single line (no embedded newlines in content)", () => {
    const msg: Wire.ForemanMessage = {
      type: "task_assigned",
      taskId: "task-1",
      issue: { number: 7, title: "Multi word title", body: "", labels: [], repoUrl: "https://github.com/owner/repo" },
    };
    const output = captureOutput(() => testDisplay.printForemanMessage(msg));
    // Strip trailing newline from console.log and check no embedded newlines
    const trimmed = stripAnsi(output).trim();
    expect(trimmed).not.toContain("\n");
  });

  it("event_notification, VERBOSE=false → silent", () => {
    const msg: Wire.ForemanMessage = {
      type: "event_notification",
      taskId: "task-1",
      event: { id: "evt-1", name: "issue_comment", payload: {} },
    };
    const output = captureOutput(() => testDisplay.printForemanMessage(msg));
    expect(stripAnsi(output).trim()).toBe("");
  });

  it("event_notification, VERBOSE=true → prints event name", () => {
    getConfig().verbose = true;
    const msg: Wire.ForemanMessage = {
      type: "event_notification",
      taskId: "task-1",
      event: { id: "evt-1", name: "issue_comment", payload: {} },
    };
    const output = captureOutput(() => testDisplay.printForemanMessage(msg));
    expect(stripAnsi(output)).toContain("issue_comment");
  });

  it("event_notification, VERBOSE=true → includes a timestamp in [HH:MM:SS] format", () => {
    getConfig().verbose = true;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T14:05:03.000Z"));
    const msg: Wire.ForemanMessage = {
      type: "event_notification",
      taskId: "task-1",
      event: { id: "evt-1", name: "issue_comment", payload: {} },
    };
    const output = captureOutput(() => testDisplay.printForemanMessage(msg));
    const plain = stripAnsi(output);
    expect(plain).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
  });

  it("event_notification, VERBOSE=true → includes check_run details", () => {
    getConfig().verbose = true;
    const msg: Wire.ForemanMessage = {
      type: "event_notification",
      taskId: "task-1",
      event: {
        id: "evt-cr",
        name: "check_run",
        payload: { action: "completed", check_run: { name: "CI / build", conclusion: "failure" } },
      },
    };
    const output = captureOutput(() => testDisplay.printForemanMessage(msg));
    const plain = stripAnsi(output);
    expect(plain).toContain("CI / build");
    expect(plain).toContain("failure");
  });

  it("event_notification, VERBOSE=true → includes action in name/action format when payload has action", () => {
    getConfig().verbose = true;
    const msg: Wire.ForemanMessage = {
      type: "event_notification",
      taskId: "task-1",
      event: { id: "evt-1", name: "check_suite", payload: { action: "completed" } },
    };
    const output = captureOutput(() => testDisplay.printForemanMessage(msg));
    const plain = stripAnsi(output);
    expect(plain).toContain("check_suite/completed");
  });

  it("event_notification, VERBOSE=true → output is a single line (no embedded newlines in content)", () => {
    getConfig().verbose = true;
    const msg: Wire.ForemanMessage = {
      type: "event_notification",
      taskId: "task-1",
      event: { id: "evt-2", name: "pull_request", payload: {} },
    };
    const output = captureOutput(() => testDisplay.printForemanMessage(msg));
    const trimmed = stripAnsi(output).trim();
    expect(trimmed).not.toContain("\n");
  });

});

describe("printForemanMessage - hello_ack", () => {
  it("hello_ack, VERBOSE=false → silent", () => {
    const msg: Wire.ForemanMessage = { type: "hello_ack", workerId: "w-1", status: "idle" };
    const output = captureOutput(() => testDisplay.printForemanMessage(msg));
    expect(stripAnsi(output).trim()).toBe("");
  });

  it("hello_ack, VERBOSE=true → prints ack status", () => {
    getConfig().verbose = true;
    const msg: Wire.ForemanMessage = { type: "hello_ack", workerId: "w-1", status: "idle" };
    const output = captureOutput(() => testDisplay.printForemanMessage(msg));
    expect(stripAnsi(output)).toContain("idle");
  });

  it("hello_ack, VERBOSE=true → includes status for busy", () => {
    getConfig().verbose = true;
    const msg: Wire.ForemanMessage = { type: "hello_ack", workerId: "w-1", status: "busy" };
    const output = captureOutput(() => testDisplay.printForemanMessage(msg));
    expect(stripAnsi(output)).toContain("busy");
  });

  it("hello_ack, VERBOSE=true → includes status for cancelled", () => {
    getConfig().verbose = true;
    const msg: Wire.ForemanMessage = { type: "hello_ack", workerId: "w-1", status: "cancelled" };
    const output = captureOutput(() => testDisplay.printForemanMessage(msg));
    expect(stripAnsi(output)).toContain("cancelled");
  });
});

describe("printForemanMessage - foreman_error", () => {
  it("foreman_error always prints the message (not verbose-only)", () => {
    const msg: Wire.ForemanMessage = { type: "foreman_error", message: "DB connection lost", fatal: false };
    const output = captureOutput(() => testDisplay.printForemanMessage(msg));
    expect(stripAnsi(output)).toContain("DB connection lost");
  });

  it("foreman_error fatal=true also prints the message", () => {
    const msg: Wire.ForemanMessage = { type: "foreman_error", message: "Catastrophic failure", fatal: true };
    const output = captureOutput(() => testDisplay.printForemanMessage(msg));
    expect(stripAnsi(output)).toContain("Catastrophic failure");
  });

  it("foreman_error prints even when verbose=false", () => {
    getConfig().verbose = false;
    const msg: Wire.ForemanMessage = { type: "foreman_error", message: "Visible error", fatal: false };
    const output = captureOutput(() => testDisplay.printForemanMessage(msg));
    expect(stripAnsi(output.trim())).not.toBe("");
    expect(stripAnsi(output)).toContain("Visible error");
  });

  it("foreman_error output contains error prefix", () => {
    const msg: Wire.ForemanMessage = { type: "foreman_error", message: "Something broke", fatal: false };
    const output = captureOutput(() => testDisplay.printForemanMessage(msg));
    expect(stripAnsi(output)).toContain("[foreman error]");
  });
});

describe("printForemanMessage - _default", () => {
  it("unknown type prints <type>", () => {
    const output = captureOutput(() => testDisplay.printForemanMessage({ type: "unknown_future_type" } as any));
    expect(stripAnsi(output)).toContain("unknown_future_type");
  });
});
