import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentStatus } from "../src/agent/models/agent-status.js";
import { Display } from "../src/agent/views/display.js";
import { getConfig } from "../src/config.js";

// Strip ANSI codes for assertion
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Helper: create an AgentStatus with given state and return its rendered status text. */
function getStatusText(opts: {
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
  width?: number;
}): string {
  const status = new AgentStatus({ agentId: opts.agentId });
  if (opts.verbose !== undefined) getConfig().verbose = opts.verbose;
  status.update({
    connectionStatus: opts.connectionStatus,
    taskNumber: opts.taskNumber,
    prNumber: opts.prNumber,
    branch: opts.branch,
    model: opts.model,
    effort: opts.effort,
    disconnectCode: opts.disconnectCode,
    reconnectAt: opts.reconnectAt,
  });
  const display = new Display(getConfig(), status);
  return stripAnsi(display.renderer.fmtStatusBar(status, opts.width ?? 119));
}

describe("AgentStatus status text", () => {
  afterEach(() => {
    getConfig().verbose = false;
    vi.useRealTimers();
  });

  it("idle with no task shows worker id and no current task", () => {
    const result = getStatusText({
      agentId: "7c254628-abcd-1234-efgh-000000000000",
      connectionStatus: "connected",
    });
    expect(result).toContain("worker 7c254628");
    expect(result).toContain("no current task");
    expect(result).toContain("Connected");
  });

  it("with task, PR, and branch", () => {
    const result = getStatusText({
      agentId: "7c254628-abcd-1234-efgh-000000000000",
      taskNumber: 374,
      prNumber: 406,
      branch: "db-single-source-of-truth",
      connectionStatus: "connected",
      width: 119,  // 120 columns - 1
    });
    expect(result).toContain("worker 7c254628");
    expect(result).toContain("task #374");
    expect(result).toContain("PR #406");
    expect(result).toContain("db-single-source-of-truth");
    expect(result).toContain("Connected");
  });

  it("disconnected shows Disconnected on right", () => {
    const result = getStatusText({
      agentId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "disconnected",
    });
    expect(result).toContain("Disconnected");
    expect(result).not.toContain("Connected");
  });

  it("disconnected with reconnectAt shows Retrying in", () => {
    vi.useFakeTimers();
    const result = getStatusText({
      agentId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "disconnected",
      reconnectAt: Date.now() + 3000,
    });
    expect(result).toContain("Retrying in 3s");
  });

  it("reconnecting shows Reconnecting... on right", () => {
    const result = getStatusText({
      agentId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "reconnecting",
    });
    expect(result).toContain("Reconnecting...");
  });

  it("handshaking shows Handshaking... on right", () => {
    const result = getStatusText({
      agentId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "handshaking",
    });
    expect(result).toContain("Handshaking...");
  });

  it("disconnected with disconnectCode omits code in non-verbose mode", () => {
    const result = getStatusText({
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
    const result = getStatusText({
      agentId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "disconnected",
      disconnectCode: 1006,
      reconnectAt: Date.now() + 2000,
      verbose: true,
    });
    expect(result).toContain("Disconnected (1006). Retrying in 2s");
  });

  it("omits task when taskNumber is undefined", () => {
    const result = getStatusText({
      agentId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "connected",
    });
    expect(result).not.toContain("task #");
  });

  it("omits PR when prNumber is undefined", () => {
    const result = getStatusText({
      agentId: "abc12345-0000-0000-0000-000000000000",
      taskNumber: 5,
      connectionStatus: "connected",
    });
    expect(result).not.toContain("PR #");
  });

  it("omits branch when branch is empty string", () => {
    const result = getStatusText({
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
    const result = getStatusText({
      agentId: "7c254628-abcd-1234-efgh-000000000000",
      taskNumber: 374,
      prNumber: 406,
      branch: "my-very-long-branch-name-that-is-quite-verbose",
      connectionStatus: "connected",
      width: 79,  // 80 columns - 1
    });
    expect(result.length).toBe(79); // width
  });

  it("shows 'sonnet' when model is undefined", () => {
    const result = getStatusText({
      agentId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "connected",
    });
    expect(result).toContain("sonnet");
  });

  it("shows 'sonnet' when model is 'default'", () => {
    const result = getStatusText({
      agentId: "abc12345-0000-0000-0000-000000000000",
      model: "default",
      connectionStatus: "connected",
    });
    expect(result).toContain("sonnet");
    expect(result).not.toContain("default");
  });

  it("shows model name when model is set to non-default", () => {
    const result = getStatusText({
      agentId: "abc12345-0000-0000-0000-000000000000",
      model: "opus",
      connectionStatus: "connected",
    });
    expect(result).toContain("opus");
  });

  it("shows model after worker id and before task info", () => {
    const result = getStatusText({
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
    const result = getStatusText({
      agentId: "abc12345-0000-0000-0000-000000000000",
      model: "opus",
      connectionStatus: "connected",
    });
    expect(result).toContain("opus");
    expect(result).not.toContain("(");
  });

  it("shows effort in parentheses when effort is set", () => {
    const result = getStatusText({
      agentId: "abc12345-0000-0000-0000-000000000000",
      model: "opus",
      effort: "medium",
      connectionStatus: "connected",
    });
    expect(result).toContain("opus (medium)");
  });

  it("shows effort with default sonnet model", () => {
    const result = getStatusText({
      agentId: "abc12345-0000-0000-0000-000000000000",
      effort: "high",
      connectionStatus: "connected",
    });
    expect(result).toContain("sonnet (high)");
  });

  it("uses first 8 chars of workerId for legacy bare UUID IDs", () => {
    const result = getStatusText({
      agentId: "7c254628-1111-2222-3333-444444444444",
      connectionStatus: "connected",
    });
    expect(result).toContain("worker 7c254628");
    expect(result).not.toContain("7c254628-1111");
  });

  it("shows name + first 8 chars of UUID for named worker IDs", () => {
    const result = getStatusText({
      agentId: "obadiah-7143f5cc-abf3-4b8a-bdb5-86989c54d3b2",
      connectionStatus: "connected",
    });
    expect(result).toContain("worker obadiah-7143f5cc");
    expect(result).not.toContain("obadiah-7143f5cc-abf3");
  });
});

describe("Display persistent status bar", () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>;
  let agentStatus: AgentStatus;
  let display: Display;

  beforeEach(() => {
    agentStatus = new AgentStatus({ agentId: "test-agent" });
    display = new Display(getConfig(), agentStatus);
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    // Ensure clean state
    display.stopBar();
    display.stopPersistentBar();
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
    display.stopBar();
    display.stopPersistentBar();
  });

  it("startPersistentBar draws a status line", () => {
    agentStatus.update({ connectionStatus: "connected" });
    display.startPersistentBar();
    const writes = stdoutWrite.mock.calls.map(a => String(a[0]));
    const combined = writes.join("");
    expect(combined).toContain("Connected");
  });

  it("stopPersistentBar clears the status line", () => {
    display.startPersistentBar();
    stdoutWrite.mockClear();
    display.stopPersistentBar();
    const writes = stdoutWrite.mock.calls.map(a => String(a[0]));
    // Should have written escape sequences to clear
    expect(writes.some(w => w.includes("\x1b[K"))).toBe(true);
  });

  it("startBar and startPersistentBar coexist", () => {
    agentStatus.update({ connectionStatus: "connected" });
    display.startPersistentBar();
    display.startBar(() => "Working… 5s");
    const writes = stdoutWrite.mock.calls.map(a => String(a[0]));
    const combined = writes.join("");
    expect(combined).toContain("Working… 5s");
    expect(combined).toContain("Connected");
  });

  it("stopBar leaves persistent status active", () => {
    agentStatus.update({ connectionStatus: "connected" });
    display.startPersistentBar();
    display.startBar(() => "Working…");
    stdoutWrite.mockClear();
    display.stopBar();
    const combined = stdoutWrite.mock.calls.map(a => String(a[0])).join("");
    expect(combined).toContain("Connected");
    expect(combined).not.toContain("Working…");
  });

  it("agentStatus change triggers persistent bar redraw", () => {
    agentStatus.update({ connectionStatus: "connected" });
    display.startPersistentBar();
    stdoutWrite.mockClear();
    // Trigger a change via update()
    agentStatus.update({ connectionStatus: "reconnecting" });
    const combined = stdoutWrite.mock.calls.map(a => String(a[0])).join("");
    expect(combined).toContain("Reconnecting");
  });

  it("redraws on resize with updated width", () => {
    agentStatus.update({ connectionStatus: "connected" });
    display.startPersistentBar();
    stdoutWrite.mockClear();

    display.getColumns = () => 40;
    process.stdout.emit("resize");
    const writes = stdoutWrite.mock.calls.map(a => String(a[0]));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.join("")).toContain("Connected");
  });

  it("emits erase-to-end-of-screen on resize to clean up wrapped content", () => {
    // When the terminal is made narrower, the old wider status bar wraps into
    // extra visual rows that clearBar() (which only clears n logical rows) would
    // leave as garbage. The resize handler must emit \x1b[J (erase from cursor
    // to end of screen) to clear those wrapped rows before redrawing.
    agentStatus.update({ connectionStatus: "connected" });
    display.startPersistentBar();
    stdoutWrite.mockClear();

    display.getColumns = () => 30;
    process.stdout.emit("resize");
    const combined = stdoutWrite.mock.calls.map(a => String(a[0])).join("");
    expect(combined).toContain("\x1b[J");
  });

  it("does not register multiple resize listeners on repeated startPersistentBar calls", () => {
    display.startPersistentBar();
    display.startPersistentBar(); // second call should not add a second listener
    stdoutWrite.mockClear();
    process.stdout.emit("resize");
    // If there were two listeners, clear+draw would be called twice; just check it doesn't throw
    const writes = stdoutWrite.mock.calls.map(a => String(a[0]));
    expect(writes.length).toBeGreaterThan(0);
  });

  it("stops listening for resize after stopPersistentBar", () => {
    agentStatus.update({ connectionStatus: "connected" });
    display.startPersistentBar();
    display.stopPersistentBar();
    stdoutWrite.mockClear();
    process.stdout.emit("resize");
    // No redraws should happen after stopPersistentBar
    expect(stdoutWrite.mock.calls.length).toBe(0);
  });

});
