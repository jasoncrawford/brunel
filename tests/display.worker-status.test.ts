import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as display from "../src/display.js";

// Strip ANSI codes for assertion
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("fmtWorkerStatus", () => {
  it("idle with no task shows worker id and idle", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "7c254628-abcd-1234-efgh-000000000000",
      status: "idle",
      connectionStatus: "connected",
      width: 80,
    }));
    expect(result).toContain("worker 7c254628");
    expect(result).toContain("idle");
    expect(result).toContain("Connected");
  });

  it("busy with task, PR, and branch", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "7c254628-abcd-1234-efgh-000000000000",
      status: "busy",
      taskNumber: 374,
      prNumber: 406,
      branch: "db-single-source-of-truth",
      connectionStatus: "connected",
      width: 120,
    }));
    expect(result).toContain("worker 7c254628");
    expect(result).toContain("busy");
    expect(result).toContain("task #374");
    expect(result).toContain("PR #406");
    expect(result).toContain("db-single-source-of-truth");
    expect(result).toContain("Connected");
  });

  it("disconnected shows Disconnected on right", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      status: "idle",
      connectionStatus: "disconnected",
      width: 80,
    }));
    expect(result).toContain("Disconnected");
    expect(result).not.toContain("Connected");
  });

  it("reconnecting shows Reconnecting... on right", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      status: "idle",
      connectionStatus: "reconnecting",
      width: 80,
    }));
    expect(result).toContain("Reconnecting...");
  });

  it("omits task when taskNumber is undefined", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      status: "idle",
      connectionStatus: "connected",
      width: 80,
    }));
    expect(result).not.toContain("task #");
  });

  it("omits PR when prNumber is undefined", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      status: "busy",
      taskNumber: 5,
      connectionStatus: "connected",
      width: 80,
    }));
    expect(result).not.toContain("PR #");
  });

  it("omits branch when branch is empty string", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      status: "busy",
      taskNumber: 5,
      branch: "",
      connectionStatus: "connected",
      width: 80,
    }));
    // Should not have a trailing separator after task
    const parts = result.split("•");
    expect(parts.length).toBe(3); // "worker abc12345 ", " busy ", " task #5      Connected"
  });

  it("result fits within specified width", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "7c254628-abcd-1234-efgh-000000000000",
      status: "busy",
      taskNumber: 374,
      prNumber: 406,
      branch: "my-very-long-branch-name-that-is-quite-verbose",
      connectionStatus: "connected",
      width: 80,
    }));
    expect(result.length).toBe(80);
  });

  it("uses first 8 chars of workerId", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "abcdefgh-1111-2222-3333-444444444444",
      status: "idle",
      connectionStatus: "connected",
      width: 80,
    }));
    expect(result).toContain("worker abcdefgh");
    expect(result).not.toContain("abcdefgh-1111");
  });
});

describe("persistent status bar", () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    // Ensure clean state
    display.stopStatus();
    display.stopPersistentStatus();
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
    display.stopStatus();
    display.stopPersistentStatus();
  });

  it("startPersistentStatus draws a status line", () => {
    display.startPersistentStatus(() => "worker abc • idle");
    const writes = stdoutWrite.mock.calls.map(a => String(a[0]));
    const combined = writes.join("");
    expect(combined).toContain("worker abc • idle");
  });

  it("stopPersistentStatus clears the status line", () => {
    display.startPersistentStatus(() => "worker abc • idle");
    stdoutWrite.mockClear();
    display.stopPersistentStatus();
    const writes = stdoutWrite.mock.calls.map(a => String(a[0]));
    // Should have written escape sequences to clear
    expect(writes.some(w => w.includes("\x1b[K"))).toBe(true);
  });

  it("startStatus and startPersistentStatus coexist", () => {
    display.startPersistentStatus(() => "worker abc • busy");
    display.startStatus(() => "Working… 5s");
    const writes = stdoutWrite.mock.calls.map(a => String(a[0]));
    const combined = writes.join("");
    expect(combined).toContain("Working… 5s");
    expect(combined).toContain("worker abc • busy");
  });

  it("stopStatus leaves persistent status active", () => {
    display.startPersistentStatus(() => "worker abc • idle");
    display.startStatus(() => "Working…");
    stdoutWrite.mockClear();
    display.stopStatus();
    // persistent status is still active
    expect(display._persistentStatusActive).toBe(true);
    expect(display._statusActive).toBe(false);
  });
});
