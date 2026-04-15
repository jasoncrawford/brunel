import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StatusBar, statusBar } from "../src/agent/status-bar.js";

// Strip ANSI codes for assertion
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Helper: create a StatusBar with given state and return its status text. */
function getStatus(opts: {
  agentId: string;
  connectionStatus: "connected" | "disconnected" | "reconnecting" | "handshaking";
  taskNumber?: number;
  prNumber?: number;
  branch?: string;
  model?: string;
  effort?: "low" | "medium" | "high";
  disconnectCode?: number;
  reconnectAt?: number;
  verbose?: boolean;
}): string {
  const bar = new StatusBar({ agentId: opts.agentId });
  if (opts.verbose !== undefined) bar.setVerbose(opts.verbose);
  bar.update({
    connectionStatus: opts.connectionStatus,
    taskNumber: opts.taskNumber,
    prNumber: opts.prNumber,
    branch: opts.branch,
    model: opts.model,
    effort: opts.effort,
    disconnectCode: opts.disconnectCode,
    reconnectAt: opts.reconnectAt,
  });
  return stripAnsi(bar.getStatusText());
}

describe("StatusBar status text", () => {
  afterEach(() => {
    statusBar.setVerbose(false);
    vi.useRealTimers();
  });

  it("idle with no task shows worker id and no current task", () => {
    const result = getStatus({
      agentId: "7c254628-abcd-1234-efgh-000000000000",
      connectionStatus: "connected",
    });
    expect(result).toContain("worker 7c254628");
    expect(result).toContain("no current task");
    expect(result).toContain("Connected");
  });

  it("with task, PR, and branch", () => {
    const origColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true });
    try {
      const result = getStatus({
        agentId: "7c254628-abcd-1234-efgh-000000000000",
        taskNumber: 374,
        prNumber: 406,
        branch: "db-single-source-of-truth",
        connectionStatus: "connected",
      });
      expect(result).toContain("worker 7c254628");
      expect(result).toContain("task #374");
      expect(result).toContain("PR #406");
      expect(result).toContain("db-single-source-of-truth");
      expect(result).toContain("Connected");
    } finally {
      if (origColumns) Object.defineProperty(process.stdout, "columns", origColumns);
      else delete (process.stdout as { columns?: number }).columns;
    }
  });

  it("disconnected shows Disconnected on right", () => {
    const result = getStatus({
      agentId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "disconnected",
    });
    expect(result).toContain("Disconnected");
    expect(result).not.toContain("Connected");
  });

  it("disconnected with reconnectAt shows Retrying in", () => {
    vi.useFakeTimers();
    const result = getStatus({
      agentId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "disconnected",
      reconnectAt: Date.now() + 3000,
    });
    expect(result).toContain("Retrying in 3s");
  });

  it("reconnecting shows Reconnecting... on right", () => {
    const result = getStatus({
      agentId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "reconnecting",
    });
    expect(result).toContain("Reconnecting...");
  });

  it("handshaking shows Handshaking... on right", () => {
    const result = getStatus({
      agentId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "handshaking",
    });
    expect(result).toContain("Handshaking...");
  });

  it("disconnected with disconnectCode omits code in non-verbose mode", () => {
    const result = getStatus({
      agentId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "disconnected",
      disconnectCode: 1006,
      verbose: false,
    });
    expect(result).toContain("Disconnected");
    expect(result).not.toContain("1006");
  });

  it("disconnected with disconnectCode shows code in verbose mode when reconnectAt given", () => {
    vi.useFakeTimers();
    const result = getStatus({
      agentId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "disconnected",
      disconnectCode: 1006,
      reconnectAt: Date.now() + 2000,
      verbose: true,
    });
    expect(result).toContain("Disconnected (1006). Retrying in 2s");
  });

  it("omits task when taskNumber is undefined", () => {
    const result = getStatus({
      agentId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "connected",
    });
    expect(result).not.toContain("task #");
  });

  it("omits PR when prNumber is undefined", () => {
    const result = getStatus({
      agentId: "abc12345-0000-0000-0000-000000000000",
      taskNumber: 5,
      connectionStatus: "connected",
    });
    expect(result).not.toContain("PR #");
  });

  it("omits branch when branch is empty string", () => {
    const result = getStatus({
      agentId: "abc12345-0000-0000-0000-000000000000",
      taskNumber: 5,
      branch: "",
      connectionStatus: "connected",
    });
    // Should not have a trailing separator after task: worker ∙ model ∙ task
    const parts = result.split("∙");
    expect(parts.length).toBe(3); // "worker abc12345 ", " sonnet ", " task #5      Connected"
  });

  it("result fits within terminal width", () => {
    const origColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
    try {
      const result = getStatus({
        agentId: "7c254628-abcd-1234-efgh-000000000000",
        taskNumber: 374,
        prNumber: 406,
        branch: "my-very-long-branch-name-that-is-quite-verbose",
        connectionStatus: "connected",
      });
      expect(result.length).toBe(79); // width - 1 (last-column wrap avoidance)
    } finally {
      if (origColumns) {
        Object.defineProperty(process.stdout, "columns", origColumns);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (process.stdout as any).columns;
      }
    }
  });

  it("shows 'sonnet' when model is undefined", () => {
    const result = getStatus({
      agentId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "connected",
    });
    expect(result).toContain("sonnet");
  });

  it("shows 'sonnet' when model is 'default'", () => {
    const result = getStatus({
      agentId: "abc12345-0000-0000-0000-000000000000",
      model: "default",
      connectionStatus: "connected",
    });
    expect(result).toContain("sonnet");
    expect(result).not.toContain("default");
  });

  it("shows model name when model is set to non-default", () => {
    const result = getStatus({
      agentId: "abc12345-0000-0000-0000-000000000000",
      model: "opus",
      connectionStatus: "connected",
    });
    expect(result).toContain("opus");
  });

  it("shows model after worker id and before task info", () => {
    const result = getStatus({
      agentId: "abc12345-0000-0000-0000-000000000000",
      model: "haiku",
      taskNumber: 42,
      connectionStatus: "connected",
    });
    const workerIdx = result.indexOf("worker abc12345");
    const modelIdx = result.indexOf("haiku");
    const taskIdx = result.indexOf("task #42");
    expect(workerIdx).toBeLessThan(modelIdx);
    expect(modelIdx).toBeLessThan(taskIdx);
  });

  it("omits effort when effort is undefined", () => {
    const result = getStatus({
      agentId: "abc12345-0000-0000-0000-000000000000",
      model: "opus",
      connectionStatus: "connected",
    });
    expect(result).toContain("opus");
    expect(result).not.toContain("(");
  });

  it("shows effort in parentheses when effort is set", () => {
    const result = getStatus({
      agentId: "abc12345-0000-0000-0000-000000000000",
      model: "opus",
      effort: "medium",
      connectionStatus: "connected",
    });
    expect(result).toContain("opus (medium)");
  });

  it("shows effort with default sonnet model", () => {
    const result = getStatus({
      agentId: "abc12345-0000-0000-0000-000000000000",
      effort: "high",
      connectionStatus: "connected",
    });
    expect(result).toContain("sonnet (high)");
  });

  it("uses first 8 chars of workerId for legacy bare UUID IDs", () => {
    const result = getStatus({
      agentId: "7c254628-1111-2222-3333-444444444444",
      connectionStatus: "connected",
    });
    expect(result).toContain("worker 7c254628");
    expect(result).not.toContain("7c254628-1111");
  });

  it("shows name + first 8 chars of UUID for named worker IDs", () => {
    const result = getStatus({
      agentId: "obadiah-7143f5cc-abf3-4b8a-bdb5-86989c54d3b2",
      connectionStatus: "connected",
    });
    expect(result).toContain("worker obadiah-7143f5cc");
    expect(result).not.toContain("obadiah-7143f5cc-abf3");
  });
});

describe("persistent status bar", () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    // Ensure clean state
    statusBar.stop();
    statusBar.stopPersistent();
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
    statusBar.stop();
    statusBar.stopPersistent();
  });

  it("startPersistent draws a status line", () => {
    statusBar.update({ connectionStatus: "connected" });
    statusBar.startPersistent();
    const writes = stdoutWrite.mock.calls.map(a => String(a[0]));
    const combined = writes.join("");
    expect(combined).toContain("Connected");
  });

  it("stopPersistent clears the status line", () => {
    statusBar.startPersistent();
    stdoutWrite.mockClear();
    statusBar.stopPersistent();
    const writes = stdoutWrite.mock.calls.map(a => String(a[0]));
    // Should have written escape sequences to clear
    expect(writes.some(w => w.includes("\x1b[K"))).toBe(true);
  });

  it("start and startPersistent coexist", () => {
    statusBar.update({ connectionStatus: "connected" });
    statusBar.startPersistent();
    statusBar.start(() => "Working… 5s");
    const writes = stdoutWrite.mock.calls.map(a => String(a[0]));
    const combined = writes.join("");
    expect(combined).toContain("Working… 5s");
    expect(combined).toContain("Connected");
  });

  it("stop leaves persistent status active", () => {
    statusBar.startPersistent();
    statusBar.start(() => "Working…");
    stdoutWrite.mockClear();
    statusBar.stop();
    // persistent status is still active
    expect(statusBar.persistentActive).toBe(true);
    expect(statusBar.active).toBe(false);
  });
});
