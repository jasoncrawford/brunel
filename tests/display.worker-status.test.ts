import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as display from "../src/agent/display.js";

// Strip ANSI codes for assertion
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("fmtWorkerStatus", () => {
  afterEach(() => {
    // Reset verbose flag so tests that call setVerbose(true) don't bleed over.
    display.setVerbose(false);
  });

  it("idle with no task shows worker id and no current task", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "7c254628-abcd-1234-efgh-000000000000",
      connectionStatus: "connected",
      width: 80,
    }));
    expect(result).toContain("worker 7c254628");
    expect(result).toContain("no current task");
    expect(result).toContain("Connected");
  });

  it("with task, PR, and branch", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "7c254628-abcd-1234-efgh-000000000000",
      taskNumber: 374,
      prNumber: 406,
      branch: "db-single-source-of-truth",
      connectionStatus: "connected",
      width: 120,
    }));
    expect(result).toContain("worker 7c254628");
    expect(result).toContain("task #374");
    expect(result).toContain("PR #406");
    expect(result).toContain("db-single-source-of-truth");
    expect(result).toContain("Connected");
  });

  it("disconnected shows Disconnected on right", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "disconnected",
      width: 80,
    }));
    expect(result).toContain("Disconnected");
    expect(result).not.toContain("Connected");
  });

  it("disconnected with retryInSeconds shows Retrying in", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "disconnected",
      retryInSeconds: 3,
      width: 80,
    }));
    expect(result).toContain("Retrying in 3s");
  });

  it("reconnecting shows Reconnecting... on right", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "reconnecting",
      width: 80,
    }));
    expect(result).toContain("Reconnecting...");
  });

  it("handshaking shows Handshaking... on right", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "handshaking",
      width: 80,
    }));
    expect(result).toContain("Handshaking...");
  });

  it("disconnected with disconnectCode omits code in non-verbose mode", () => {
    display.setVerbose(false);
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "disconnected",
      disconnectCode: 1006,
      width: 80,
    }));
    expect(result).toContain("Disconnected");
    expect(result).not.toContain("1006");
  });

  it("disconnected with disconnectCode shows code in verbose mode when retryInSeconds given", () => {
    display.setVerbose(true);
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "disconnected",
      disconnectCode: 1006,
      retryInSeconds: 2,
      width: 80,
    }));
    expect(result).toContain("Disconnected (1006). Retrying in 2s");
  });

  it("omits task when taskNumber is undefined", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "connected",
      width: 80,
    }));
    expect(result).not.toContain("task #");
  });

  it("omits PR when prNumber is undefined", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      taskNumber: 5,
      connectionStatus: "connected",
      width: 80,
    }));
    expect(result).not.toContain("PR #");
  });

  it("omits branch when branch is empty string", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      taskNumber: 5,
      branch: "",
      connectionStatus: "connected",
      width: 80,
    }));
    // Should not have a trailing separator after task: worker ∙ model ∙ task
    const parts = result.split("∙");
    expect(parts.length).toBe(3); // "worker abc12345 ", " sonnet ", " task #5      Connected"
  });

  it("result fits within specified width", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "7c254628-abcd-1234-efgh-000000000000",
      taskNumber: 374,
      prNumber: 406,
      branch: "my-very-long-branch-name-that-is-quite-verbose",
      connectionStatus: "connected",
      width: 80,
    }));
    expect(result.length).toBe(79); // width - 1 (last-column wrap avoidance)
  });

  it("shows 'sonnet' when model is undefined", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "connected",
      width: 80,
    }));
    expect(result).toContain("sonnet");
  });

  it("shows 'sonnet' when model is 'default'", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      model: "default",
      connectionStatus: "connected",
      width: 80,
    }));
    expect(result).toContain("sonnet");
    expect(result).not.toContain("default");
  });

  it("shows model name when model is set to non-default", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      model: "opus",
      connectionStatus: "connected",
      width: 80,
    }));
    expect(result).toContain("opus");
  });

  it("shows model after worker id and before task info", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      model: "haiku",
      taskNumber: 42,
      connectionStatus: "connected",
      width: 120,
    }));
    const workerIdx = result.indexOf("worker abc12345");
    const modelIdx = result.indexOf("haiku");
    const taskIdx = result.indexOf("task #42");
    expect(workerIdx).toBeLessThan(modelIdx);
    expect(modelIdx).toBeLessThan(taskIdx);
  });

  it("omits effort when effort is undefined", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      model: "opus",
      connectionStatus: "connected",
      width: 80,
    }));
    expect(result).toContain("opus");
    expect(result).not.toContain("(");
  });

  it("shows effort in parentheses when effort is set", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      model: "opus",
      effort: "medium",
      connectionStatus: "connected",
      width: 120,
    }));
    expect(result).toContain("opus (medium)");
  });

  it("shows effort with default sonnet model", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      effort: "high",
      connectionStatus: "connected",
      width: 120,
    }));
    expect(result).toContain("sonnet (high)");
  });

  it("uses first 8 chars of workerId for legacy bare UUID IDs", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "7c254628-1111-2222-3333-444444444444",
      connectionStatus: "connected",
      width: 80,
    }));
    expect(result).toContain("worker 7c254628");
    expect(result).not.toContain("7c254628-1111");
  });

  it("shows name + first 8 chars of UUID for named worker IDs", () => {
    const result = stripAnsi(display.fmtWorkerStatus({
      workerId: "obadiah-7143f5cc-abf3-4b8a-bdb5-86989c54d3b2",
      connectionStatus: "connected",
      width: 80,
    }));
    expect(result).toContain("worker obadiah-7143f5cc");
    expect(result).not.toContain("obadiah-7143f5cc-abf3");
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
