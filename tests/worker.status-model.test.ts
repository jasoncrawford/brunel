import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentStatus } from "../src/agent/models/agent-status.js";
import { Display } from "../src/agent/views/display.js";
import { getConfig } from "../src/config.js";
import { stripAnsi } from "./helpers.js";

function fmtStatus(status: AgentStatus): string {
  status.setWorkerModeActive(true);
  return stripAnsi(new Display(getConfig(), status).renderer.fmtStatusBar(status, 100));
}

describe("AgentStatus", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("has disconnected as default connection status", () => {
    const model = new AgentStatus({ agentId: "test-worker-id" });
    expect(model.connectionStatus).toBe("disconnected");
  });

  it("has undefined task/pr/branch by default", () => {
    const model = new AgentStatus({ agentId: "test-worker-id" });
    expect(model.taskNumber).toBeUndefined();
    expect(model.prNumber).toBeUndefined();
    expect(model.branch).toBe("");
  });

  it("emits change when connectionStatus is updated", () => {
    const model = new AgentStatus({ agentId: "test-worker-id" });
    const onChange = vi.fn();
    model.on("change", onChange);
    model.update({ connectionStatus: "connected" });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("emits change when taskNumber is updated", () => {
    const model = new AgentStatus({ agentId: "test-worker-id" });
    const onChange = vi.fn();
    model.on("change", onChange);
    model.update({ taskNumber: 42 });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("emits change when prNumber is updated", () => {
    const model = new AgentStatus({ agentId: "test-worker-id" });
    const onChange = vi.fn();
    model.on("change", onChange);
    model.update({ prNumber: 99 });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("emits change when branch is updated", () => {
    const model = new AgentStatus({ agentId: "test-worker-id" });
    const onChange = vi.fn();
    model.on("change", onChange);
    model.update({ branch: "feature-branch" });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("updates connectionStatus", () => {
    const model = new AgentStatus({ agentId: "test-worker-id" });
    model.update({ connectionStatus: "connected" });
    expect(model.connectionStatus).toBe("connected");
  });

  it("sets and clears taskNumber", () => {
    const model = new AgentStatus({ agentId: "test-worker-id" });
    model.update({ taskNumber: 42 });
    expect(model.taskNumber).toBe(42);
    model.update({ taskNumber: undefined });
    expect(model.taskNumber).toBeUndefined();
  });

  it("sets and clears prNumber", () => {
    const model = new AgentStatus({ agentId: "test-worker-id" });
    model.update({ prNumber: 77 });
    expect(model.prNumber).toBe(77);
    model.update({ prNumber: undefined });
    expect(model.prNumber).toBeUndefined();
  });

  it("sets and clears disconnectCode", () => {
    const model = new AgentStatus({ agentId: "test-worker-id" });
    model.update({ disconnectCode: 1006 });
    expect(model.disconnectCode).toBe(1006);
    model.update({ disconnectCode: undefined });
    expect(model.disconnectCode).toBeUndefined();
  });

  it("batches multiple field updates into one change event", () => {
    const model = new AgentStatus({ agentId: "test-worker-id" });
    const onChange = vi.fn();
    model.on("change", onChange);
    model.update({ connectionStatus: "connected", taskNumber: 5, prNumber: 10 });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("starts emitting change every second when reconnectAt is set", () => {
    vi.useFakeTimers();
    const model = new AgentStatus({ agentId: "test-worker-id" });
    const onChange = vi.fn();
    model.on("change", onChange);
    onChange.mockClear();

    model.update({ reconnectAt: Date.now() + 5000 });
    expect(onChange).toHaveBeenCalledOnce(); // from the update itself
    onChange.mockClear();

    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledOnce(); // timer tick

    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(2); // second tick
  });

  it("stops countdown timer when reconnectAt is cleared", () => {
    vi.useFakeTimers();
    const model = new AgentStatus({ agentId: "test-worker-id" });
    const onChange = vi.fn();
    model.on("change", onChange);

    model.update({ reconnectAt: Date.now() + 5000 });
    onChange.mockClear();

    model.update({ reconnectAt: undefined });
    onChange.mockClear(); // clear the update event itself

    vi.advanceTimersByTime(3000);
    expect(onChange).not.toHaveBeenCalled(); // timer is stopped
  });

  it("getStatusText includes worker ID prefix", () => {
    const model = new AgentStatus({ agentId: "abcdef12-rest-of-id" });
    const text = fmtStatus(model);
    expect(text).toContain("worker abcdef12");
  });

  it("getStatusText shows connection status", () => {
    const model = new AgentStatus({ agentId: "test-worker-id" });
    model.update({ connectionStatus: "connected" });
    expect(fmtStatus(model)).toContain("Connected");
  });

  it("getStatusText shows task number when set", () => {
    const model = new AgentStatus({ agentId: "test-worker-id" });
    model.update({ taskNumber: 42 });
    expect(fmtStatus(model)).toContain("task #42");
  });

  it("getStatusText shows 'no current task' when task is unset", () => {
    const model = new AgentStatus({ agentId: "test-worker-id" });
    expect(fmtStatus(model)).toContain("no current task");
  });

  it("getStatusText shows PR number when set", () => {
    const model = new AgentStatus({ agentId: "test-worker-id" });
    model.update({ prNumber: 77 });
    expect(fmtStatus(model)).toContain("PR #77");
  });

  it("getStatusText shows retry countdown when disconnected with reconnectAt", () => {
    vi.useFakeTimers();
    const model = new AgentStatus({ agentId: "test-worker-id" });
    model.update({ connectionStatus: "disconnected", reconnectAt: Date.now() + 4000 });
    expect(fmtStatus(model)).toContain("Retrying in 4s");
  });

  it("has undefined model and effort by default", () => {
    const model = new AgentStatus({ agentId: "test-worker-id" });
    expect(model.model).toBeUndefined();
    expect(model.effort).toBeUndefined();
  });

  it("sets and clears model", () => {
    const model = new AgentStatus({ agentId: "test-worker-id" });
    model.update({ model: "opus" });
    expect(model.model).toBe("opus");
    model.update({ model: undefined });
    expect(model.model).toBeUndefined();
  });

  it("sets and clears effort", () => {
    const model = new AgentStatus({ agentId: "test-worker-id" });
    model.update({ effort: "high" });
    expect(model.effort).toBe("high");
    model.update({ effort: undefined });
    expect(model.effort).toBeUndefined();
  });

  it("emits change when model is updated", () => {
    const model = new AgentStatus({ agentId: "test-worker-id" });
    const onChange = vi.fn();
    model.on("change", onChange);
    model.update({ model: "haiku" });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("getStatusText shows sonnet when model is undefined", () => {
    const model = new AgentStatus({ agentId: "test-worker-id" });
    expect(fmtStatus(model)).toContain("sonnet");
  });

  it("getStatusText shows model name when set", () => {
    const model = new AgentStatus({ agentId: "test-worker-id" });
    model.update({ model: "opus" });
    expect(fmtStatus(model)).toContain("opus");
  });

  it("getStatusText shows effort in parens when set", () => {
    const model = new AgentStatus({ agentId: "test-worker-id" });
    model.update({ model: "opus", effort: "medium" });
    expect(fmtStatus(model)).toContain("opus (medium)");
  });

  describe("setAgentId", () => {
    it("updates agentId", () => {
      const model = new AgentStatus({ agentId: "original-id" });
      expect(model.agentId).toBe("original-id");
      model.setAgentId("new-dead-worker-id");
      expect(model.agentId).toBe("new-dead-worker-id");
    });

    it("emits change after setAgentId", () => {
      const model = new AgentStatus({ agentId: "original-id" });
      const onChange = vi.fn();
      model.on("change", onChange);
      model.setAgentId("new-id");
      expect(onChange).toHaveBeenCalledOnce();
    });
  });
});
