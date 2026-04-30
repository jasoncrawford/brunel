import { describe, it, expect, afterEach, vi } from "vitest";
import { AgentStatus } from "../src/agent/models/agent-status.js";
import { Display } from "../src/agent/views/display.js";
import { getConfig } from "../src/config.js";

// Strip ANSI codes for assertion
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("AgentStatus verbose flag", () => {
  afterEach(() => {
    getConfig().verbose = false;
  });

  it("defaults to false", () => {
    expect(getConfig().verbose).toBe(false);
  });

  it("getConfig().verbose = true sets verbose to true", () => {
    getConfig().verbose = true;
    expect(getConfig().verbose).toBe(true);
  });

  it("getConfig().verbose = false resets verbose", () => {
    getConfig().verbose = true;
    getConfig().verbose = false;
    expect(getConfig().verbose).toBe(false);
  });
});

describe("AgentStatus getStatusText", () => {
  afterEach(() => {
    getConfig().verbose = false;
    vi.useRealTimers();
  });

  it("shows worker id and no current task when idle", () => {
    const status = new AgentStatus({ agentId: "7c254628-abcd-1234-efgh-000000000000" });
    status.update({ connectionStatus: "connected" });
    status.setWorkerModeActive(true);
    const display = new Display(getConfig(), status);
    const result = stripAnsi(display.renderer.fmtStatusBar(status, 119));
    expect(result).toContain("worker 7c254628");
    expect(result).toContain("no current task");
    expect(result).toContain("Connected");
  });

  it("shows disconnectCode in verbose mode (via Renderer.fmtStatusBar)", () => {
    const status = new AgentStatus({ agentId: "abc12345-0000-0000-0000-000000000000" });
    getConfig().verbose = true;
    status.update({ connectionStatus: "disconnected", disconnectCode: 1006, reconnectAt: Date.now() + 2000 });
    status.setWorkerModeActive(true);
    const display = new Display(getConfig(), status);
    const result = stripAnsi(display.renderer.fmtStatusBar(status, 119));
    expect(result).toContain("Disconnected (1006)");
  });

  it("omits disconnectCode in non-verbose mode (via Renderer.fmtStatusBar)", () => {
    const status = new AgentStatus({ agentId: "abc12345-0000-0000-0000-000000000000" });
    getConfig().verbose = false;
    status.update({ connectionStatus: "disconnected", disconnectCode: 1006 });
    status.setWorkerModeActive(true);
    const display = new Display(getConfig(), status);
    const result = stripAnsi(display.renderer.fmtStatusBar(status, 119));
    expect(result).toContain("Disconnected");
    expect(result).not.toContain("1006");
  });

  it("shows task, PR, and branch when set", () => {
    const status = new AgentStatus({ agentId: "7c254628-abcd-1234-efgh-000000000000" });
    status.update({ taskNumber: 374, prNumber: 406, branch: "db-single-source-of-truth", connectionStatus: "connected" });
    status.setWorkerModeActive(true);
    const display = new Display(getConfig(), status);
    const result = stripAnsi(display.renderer.fmtStatusBar(status, 119));
    expect(result).toContain("task #374");
    expect(result).toContain("PR #406");
    expect(result).toContain("db-single-source-of-truth");
  });
});

describe("events-paused badge", () => {
  it("shows 'Events paused (3 pending)' on right side when paused with events", () => {
    const status = new AgentStatus({ agentId: "7c254628-abcd-1234-efgh-000000000000" });
    status.update({ connectionStatus: "connected", eventsPaused: true, pendingEventsCount: 3 });
    status.setWorkerModeActive(true);
    const display = new Display(getConfig(), status);
    const result = stripAnsi(display.renderer.fmtStatusBar(status, 160));
    expect(result).toContain("Events paused (3 pending)");
  });

  it("shows 'Events paused' (no count) when paused with no events", () => {
    const status = new AgentStatus({ agentId: "7c254628-abcd-1234-efgh-000000000000" });
    status.update({ connectionStatus: "connected", eventsPaused: true, pendingEventsCount: 0 });
    status.setWorkerModeActive(true);
    const display = new Display(getConfig(), status);
    const result = stripAnsi(display.renderer.fmtStatusBar(status, 160));
    expect(result).toContain("Events paused");
    expect(result).not.toContain("pending");
  });

  it("does not show events-paused text when not paused", () => {
    const status = new AgentStatus({ agentId: "7c254628-abcd-1234-efgh-000000000000" });
    status.update({ connectionStatus: "connected", eventsPaused: false });
    status.setWorkerModeActive(true);
    const display = new Display(getConfig(), status);
    const result = stripAnsi(display.renderer.fmtStatusBar(status, 160));
    expect(result).not.toContain("Events paused");
  });
});

describe("AgentStatus callbacks", () => {
  it("fireOnToolResult calls the registered callback", () => {
    const status = new AgentStatus({ agentId: "test-agent-id" });
    const fn = vi.fn();
    status.setOnToolResult(fn);
    status.fireOnToolResult("Bash");
    expect(fn).toHaveBeenCalledWith("Bash");
  });

  it("fireOnToolResult does nothing when no callback registered", () => {
    const status = new AgentStatus({ agentId: "test-agent-id" });
    expect(() => status.fireOnToolResult("Bash")).not.toThrow();
  });
});
