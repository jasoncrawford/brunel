import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stripAnsi } from "./helpers.js";
import { getConfig } from "../src/config.js";
import { Display } from "../src/agent/views/display.js";
import { AgentStatus } from "../src/agent/models/agent-status.js";

function captureWrites(fn: () => void): string {
  let output = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => { output += String(s); return true; });
  fn();
  spy.mockRestore();
  return output;
}

let display: Display;
let agentStatus: AgentStatus;

beforeEach(() => {
  vi.useFakeTimers();
  agentStatus = new AgentStatus({ agentId: "test-agent" });
  display = new Display(getConfig(), agentStatus);
});

afterEach(() => {
  display.stopBar();
  display.stopPersistentBar();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Bug #986: ghost interval from repeated startBar() calls ──────────────────
//
// startBar() did not clear this._interval before creating a new setInterval.
// A second startBar() call (e.g. after a tool-permission prompt) left the
// first interval running with its own captured getText closure. Two intervals
// then fired alternately — each writing different text — producing the rapid
// back-and-forth blink described in the bug report.

describe("startBar() – no ghost interval on repeated calls", () => {
  it("only shows the second getText after startBar() is called twice without stopBar()", () => {
    display.startBar(() => "text-A");

    // Second call without stopBar() — should replace the first interval, not add a second.
    display.startBar(() => "text-B");

    const output = captureWrites(() => vi.advanceTimersByTime(500));

    const plain = stripAnsi(output);
    expect(plain).not.toContain("text-A");  // ghost interval must not fire
    expect(plain).toContain("text-B");       // live interval must fire
  });

  it("stopBar() followed by startBar() still works correctly", () => {
    display.startBar(() => "text-A");
    display.stopBar();
    display.startBar(() => "text-B");

    const output = captureWrites(() => vi.advanceTimersByTime(500));

    const plain = stripAnsi(output);
    expect(plain).not.toContain("text-A");
    expect(plain).toContain("text-B");
  });

  it("three startBar() calls in a row produce only the last getText text", () => {
    display.startBar(() => "text-A");
    display.startBar(() => "text-B");
    display.startBar(() => "text-C");

    const output = captureWrites(() => vi.advanceTimersByTime(500));

    const plain = stripAnsi(output);
    expect(plain).not.toContain("text-A");
    expect(plain).not.toContain("text-B");
    expect(plain).toContain("text-C");
  });
});

// ── Bug #986: _updatePersistent() causing redundant redraws while interval runs
//
// When the 500ms animation interval is running it already redraws both bars on
// every tick. _updatePersistent() (called on every agentStatus "change" event)
// used to unconditionally call clearBar()+drawBar() as well, causing extra
// clear/redraw cycles between interval ticks — the visual flicker reported as
// "two different models/views with overlapping timers".
//
// Fix: when the primary-bar interval is active, _updatePersistent() should
// only refresh _persistentText and let the next interval tick do the redraw.

describe("_updatePersistent() – no extra redraws while interval is running", () => {
  it("agentStatus change while interval is active does not write to stdout between ticks", () => {
    display.startBar(() => "primary-text");
    display.startPersistentBar();

    // Capture writes that happen purely from the agentStatus change
    // (between interval ticks — no vi.advanceTimersByTime here).
    const writesFromChange = captureWrites(() => {
      agentStatus.update({ connectionStatus: "handshaking" });
    });

    // No stdout output should have occurred between interval ticks.
    expect(writesFromChange).toBe("");
  });

  it("agentStatus change while interval is NOT active still triggers an immediate redraw", () => {
    // Only the persistent bar is running — no animation interval.
    display.startPersistentBar();

    const writesFromChange = captureWrites(() => {
      agentStatus.update({ connectionStatus: "connected" });
    });

    // The persistent bar should redraw immediately when no interval is running.
    expect(writesFromChange).not.toBe("");
  });

  it("persistent text updated by agentStatus change is visible on the next interval tick", () => {
    display.startBar(() => "primary-text");
    display.startPersistentBar();

    // Trigger a status update — should only update internal text, not redraw.
    agentStatus.update({ connectionStatus: "connected" });
    agentStatus.setWorkerModeActive(true);

    // The next interval tick should draw both bars with the updated persistent text.
    const output = captureWrites(() => vi.advanceTimersByTime(500));
    const plain = stripAnsi(output);

    expect(plain).toContain("primary-text");
    expect(plain).toContain("Connected");  // from updated persistent status
  });
});
