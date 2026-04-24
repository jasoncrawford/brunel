import { describe, it, expect, vi, afterEach } from "vitest";
import { Picker } from "../src/agent/views/picker.js";
import { AgentStatus } from "../src/agent/models/agent-status.js";
import { Display } from "../src/agent/views/display.js";
import { getConfig } from "../src/config.js";

// ── Bar management ────────────────────────────────────────────────────────────
//
// The bug: Picker.pick() writes its menu starting at the cursor's resting
// position, which is the blank separator row immediately above the status bar.
// Without bar management, picker options overwrite the status bar lines.
//
// The fix: display.clearBar() is called before any options are written to
// stdout, and display.drawBar() is called after the user selects. These tests
// verify that the option text appears in stdout *after* clearBar fires and
// *before* drawBar fires — confirming options land on freshly-cleared lines.

describe("Picker bar management", () => {
  afterEach(() => {
    process.stdin.removeAllListeners("data");
    vi.restoreAllMocks();
  });

  /** Returns a tracking display and a spy on stdout.write. */
  function setup(optionText: string) {
    const events: Array<"clearBar" | "option" | "drawBar"> = [];

    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      if (String(chunk).includes(optionText)) events.push("option");
      return true;
    });

    const display = {
      clearBar: vi.fn(() => { events.push("clearBar"); }),
      drawBar:  vi.fn(() => { events.push("drawBar"); }),
    };

    return { events, display };
  }

  it("pick(): options are written to stdout after clearBar and before drawBar", async () => {
    const { events, display } = setup("Option A");
    const picker = new Picker(display);

    const promise = picker.pick(["Option A", "Option B"]);
    process.stdin.emit("data", "\r");
    await promise;

    expect(events).toEqual(["clearBar", "option", "drawBar"]);
  });

  it("pickMultiple(): options are written to stdout after clearBar and before drawBar", async () => {
    const { events, display } = setup("Choice A");
    const picker = new Picker(display);

    const promise = picker.pickMultiple(["Choice A", "Choice B"]);
    process.stdin.emit("data", "\r");
    await promise;

    expect(events).toEqual(["clearBar", "option", "drawBar"]);
  });

  it("pickQuestion(): options are written to stdout after clearBar and before drawBar", async () => {
    const { events, display } = setup("Yes");
    const picker = new Picker(display);
    const opts = [{ label: "Yes", description: "Proceed" }];

    const promise = picker.pickQuestion(opts);
    process.stdin.emit("data", "\r");
    await promise;

    expect(events).toEqual(["clearBar", "option", "drawBar"]);
  });

  it("works with no display (no bar methods called, pick still resolves)", async () => {
    const picker = new Picker();

    const promise = picker.pick(["A", "B"]);
    process.stdin.emit("data", "\r");
    await expect(promise).resolves.toBe(0);
  });
});

// ── Issue #832: status bar corruption when ask() is active ───────────────────
//
// Bug: when the picker runs while ask() owns the screen (e.g. SIGINT fires
// during the "[agent] > " prompt), display.clearBar() exits early because
// inputPrint is set. Picker options overwrite the status bar rows. After the
// picker, drawBar() routes through the no-op inputPrint callback and never
// redraws the status bar below the options.
//
// Fix: Picker accepts an optional onStart callback called before clearBar().
// The composition root wires this to input.cancel(), which nulls inputPrint so
// clearBar() erases the old bar and drawBar() redraws it below the options.
//
// Behavioral test: start a real persistent status bar, simulate ask() being
// active, run a picker, then verify that the status bar text appears in stdout
// *after* the picker options. Without the fix, drawBar() routes through the
// no-op inputPrint and never writes status bar text after the options — meaning
// the bar was not redrawn below the picker (it was left on top of it, corrupted).

describe("Picker: status bar not corrupted when ask() is active (issue #832)", () => {
  afterEach(() => {
    process.stdin.removeAllListeners("data");
    vi.restoreAllMocks();
  });

  function setup() {
    const agentStatus = new AgentStatus({ agentId: "status-bar-test" });
    const display = new Display(getConfig(), agentStatus);

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    // Start the persistent bar — writes initial bar text (including "status-b",
    // the first 8 chars of the agentId) to stdout before the picker runs.
    display.startPersistentBar();

    // Simulate ask() owning the screen: clearBar() and drawBar() become no-ops
    // or route through these callbacks instead of writing bar text directly.
    display.inputPrint = () => {};

    // onStart tears down ask() state so clearBar()/drawBar() operate normally
    const onStart = () => {
      display.inputPrint = null;
      display.inputStatus = null;
      display.inputClear = null;
    };

    return { display, written, onStart };
  }

  // "status-b" is the first 8 chars of agentId "status-bar-test", which the
  // status bar renders as "worker status-b". It appears in stdout whenever
  // drawBar() runs the normal (non-inputPrint) code path.
  const BAR_MARKER = "status-b";

  it("pick(): status bar text appears after picker options in stdout", async () => {
    const { display, written, onStart } = setup();
    const picker = new Picker(display, onStart);

    const promise = picker.pick(["Option A", "Option B"]);
    process.stdin.emit("data", "\r");
    await promise;

    const all = written.join("");
    const afterOptions = all.indexOf(BAR_MARKER, all.indexOf("Option A"));
    expect(afterOptions).toBeGreaterThan(-1);
  });

  it("pickMultiple(): status bar text appears after picker options in stdout", async () => {
    const { display, written, onStart } = setup();
    const picker = new Picker(display, onStart);

    const promise = picker.pickMultiple(["Choice A", "Choice B"]);
    process.stdin.emit("data", "\r");
    await promise;

    const all = written.join("");
    const afterOptions = all.indexOf(BAR_MARKER, all.indexOf("Choice A"));
    expect(afterOptions).toBeGreaterThan(-1);
  });

  it("pickQuestion(): status bar text appears after picker options in stdout", async () => {
    const { display, written, onStart } = setup();
    const picker = new Picker(display, onStart);
    const opts = [{ label: "Yes", description: "Proceed" }];

    const promise = picker.pickQuestion(opts);
    process.stdin.emit("data", "\r");
    await promise;

    const all = written.join("");
    const afterOptions = all.indexOf(BAR_MARKER, all.indexOf("Yes"));
    expect(afterOptions).toBeGreaterThan(-1);
  });
});
