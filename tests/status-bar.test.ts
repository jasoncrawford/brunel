import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as statusBar from "../src/agent/status-bar.js";

// Strip ANSI codes for assertion
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("verbose flag", () => {
  afterEach(() => {
    statusBar.setVerbose(false);
  });

  it("defaults to false", () => {
    expect(statusBar.verbose).toBe(false);
  });

  it("setVerbose(true) sets verbose to true", () => {
    statusBar.setVerbose(true);
    expect(statusBar.verbose).toBe(true);
  });

  it("setVerbose(false) resets verbose", () => {
    statusBar.setVerbose(true);
    statusBar.setVerbose(false);
    expect(statusBar.verbose).toBe(false);
  });
});

describe("fmtWorkerStatus", () => {
  afterEach(() => {
    statusBar.setVerbose(false);
  });

  it("shows worker id and no current task when idle", () => {
    const result = stripAnsi(statusBar.fmtWorkerStatus({
      workerId: "7c254628-abcd-1234-efgh-000000000000",
      connectionStatus: "connected",
      width: 80,
    }));
    expect(result).toContain("worker 7c254628");
    expect(result).toContain("no current task");
    expect(result).toContain("Connected");
  });

  it("shows disconnectCode in verbose mode", () => {
    statusBar.setVerbose(true);
    const result = stripAnsi(statusBar.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "disconnected",
      disconnectCode: 1006,
      retryInSeconds: 2,
      width: 80,
    }));
    expect(result).toContain("Disconnected (1006). Retrying in 2s");
  });

  it("omits disconnectCode in non-verbose mode", () => {
    statusBar.setVerbose(false);
    const result = stripAnsi(statusBar.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "disconnected",
      disconnectCode: 1006,
      width: 80,
    }));
    expect(result).toContain("Disconnected");
    expect(result).not.toContain("1006");
  });

  it("shows task, PR, and branch when set", () => {
    const result = stripAnsi(statusBar.fmtWorkerStatus({
      workerId: "7c254628-abcd-1234-efgh-000000000000",
      taskNumber: 374,
      prNumber: 406,
      branch: "db-single-source-of-truth",
      connectionStatus: "connected",
      width: 120,
    }));
    expect(result).toContain("task #374");
    expect(result).toContain("PR #406");
    expect(result).toContain("db-single-source-of-truth");
  });
});

describe("callbacks", () => {
  afterEach(() => {
    statusBar.setOnToolResultCallback(null);
    statusBar.setInputPrintCallback(null);
    statusBar.setInputStatusCallback(null);
    statusBar.setInputClearCallback(null);
  });

  it("getInputPrintCallback returns null by default", () => {
    expect(statusBar.getInputPrintCallback()).toBeNull();
  });

  it("setInputPrintCallback/getInputPrintCallback round-trips", () => {
    const fn = vi.fn();
    statusBar.setInputPrintCallback(fn);
    expect(statusBar.getInputPrintCallback()).toBe(fn);
  });

  it("getInputStatusCallback returns null by default", () => {
    expect(statusBar.getInputStatusCallback()).toBeNull();
  });

  it("setInputStatusCallback/getInputStatusCallback round-trips", () => {
    const fn = vi.fn();
    statusBar.setInputStatusCallback(fn);
    expect(statusBar.getInputStatusCallback()).toBe(fn);
  });

  it("getInputClearCallback returns null by default", () => {
    expect(statusBar.getInputClearCallback()).toBeNull();
  });

  it("setInputClearCallback/getInputClearCallback round-trips", () => {
    const fn = vi.fn();
    statusBar.setInputClearCallback(fn);
    expect(statusBar.getInputClearCallback()).toBe(fn);
  });

  it("fireOnToolResult calls the registered callback", () => {
    const fn = vi.fn();
    statusBar.setOnToolResultCallback(fn);
    statusBar.fireOnToolResult("Bash");
    expect(fn).toHaveBeenCalledWith("Bash");
  });

  it("fireOnToolResult does nothing when no callback registered", () => {
    // should not throw
    expect(() => statusBar.fireOnToolResult("Bash")).not.toThrow();
  });
});

describe("persistent status bar", () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    statusBar.stopStatus();
    statusBar.stopPersistentStatus();
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
    statusBar.stopStatus();
    statusBar.stopPersistentStatus();
  });

  it("startPersistentStatus draws a status line", () => {
    statusBar.startPersistentStatus(() => "worker abc • idle");
    const writes = stdoutWrite.mock.calls.map(a => String(a[0]));
    expect(writes.join("")).toContain("worker abc • idle");
  });

  it("_persistentStatusActive is true after start", () => {
    statusBar.startPersistentStatus(() => "worker abc • idle");
    expect(statusBar._persistentStatusActive).toBe(true);
  });

  it("_persistentStatusActive is false after stop", () => {
    statusBar.startPersistentStatus(() => "worker abc • idle");
    statusBar.stopPersistentStatus();
    expect(statusBar._persistentStatusActive).toBe(false);
  });

  it("stopPersistentStatus clears the status line", () => {
    statusBar.startPersistentStatus(() => "worker abc • idle");
    stdoutWrite.mockClear();
    statusBar.stopPersistentStatus();
    const writes = stdoutWrite.mock.calls.map(a => String(a[0]));
    expect(writes.some(w => w.includes("\x1b[K"))).toBe(true);
  });

  it("updatePersistentStatus refreshes text", () => {
    let text = "initial";
    statusBar.startPersistentStatus(() => text);
    stdoutWrite.mockClear();
    text = "updated";
    statusBar.updatePersistentStatus();
    const writes = stdoutWrite.mock.calls.map(a => String(a[0]));
    expect(writes.join("")).toContain("updated");
  });

  it("_statusActive is false by default", () => {
    expect(statusBar._statusActive).toBe(false);
  });

  it("stopStatus sets _statusActive to false", () => {
    statusBar.stopStatus();
    expect(statusBar._statusActive).toBe(false);
  });
});
