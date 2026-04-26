import { describe, it, expect, vi, afterEach } from "vitest";
import { Picker, PickerCancelledError } from "../src/agent/views/picker.js";
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

// ── Issue #887: ^C at picker should not exit the process ──────────────────────
//
// Bug: All picker methods called process.exit(0) when Ctrl+C was pressed, which
// killed the whole agent instead of just cancelling the current operation.
//
// Fix: On ^C, picker methods should clean up and resolve/reject gracefully:
// - pick() without config → resolves with -1 (sentinel for "cancelled")
// - pick() with config → resolves with { type: "cancelled" } (same as Escape)
// - pickMultiple() → rejects with PickerCancelledError
// - pickQuestion() → rejects with PickerCancelledError
// - promptLine() → rejects with PickerCancelledError

describe("Picker: ^C cancels cleanly without calling process.exit (issue #887)", () => {
  afterEach(() => {
    process.stdin.removeAllListeners("data");
    vi.restoreAllMocks();
  });

  it("pick() without config: ^C resolves with -1 instead of exiting", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const picker = new Picker();

    const promise = picker.pick(["Allow", "Deny"]);
    process.stdin.emit("data", "\x03");
    await expect(promise).resolves.toBe(-1);
  });

  it("pick() with config: ^C resolves with { type: 'cancelled' } instead of exiting", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const picker = new Picker();

    const promise = picker.pick(["Allow", "Deny"], { escapable: true });
    process.stdin.emit("data", "\x03");
    await expect(promise).resolves.toEqual({ type: "cancelled" });
  });

  it("pick() with config (non-escapable): ^C resolves with { type: 'cancelled' } instead of exiting", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const picker = new Picker();

    const promise = picker.pick(["Allow", "Deny"], {});
    process.stdin.emit("data", "\x03");
    await expect(promise).resolves.toEqual({ type: "cancelled" });
  });

  it("pick() without config in text mode: ^C resolves with -1 instead of exiting", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const picker = new Picker();

    const promise = picker.pick(["Option A", "Other"], { lastIsTextEntry: true });
    // Navigate to "Other" to enter text mode, then ^C
    process.stdin.emit("data", "\x11"); // down arrow → select "Other" (text mode)
    process.stdin.emit("data", "\x03");
    await expect(promise).resolves.toEqual({ type: "cancelled" });
  });

  it("pickMultiple(): ^C rejects with PickerCancelledError instead of exiting", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const picker = new Picker();

    const promise = picker.pickMultiple(["A", "B"]);
    process.stdin.emit("data", "\x03");
    await expect(promise).rejects.toBeInstanceOf(PickerCancelledError);
  });

  it("pickQuestion(): ^C rejects with PickerCancelledError instead of exiting", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const picker = new Picker();
    const opts = [{ label: "Yes", description: "Proceed" }];

    const promise = picker.pickQuestion(opts);
    process.stdin.emit("data", "\x03");
    await expect(promise).rejects.toBeInstanceOf(PickerCancelledError);
  });

  it("pickQuestion() in text mode: ^C rejects with PickerCancelledError instead of exiting", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const picker = new Picker();
    const opts = [{ label: "Yes", description: "Proceed" }];

    const promise = picker.pickQuestion(opts);
    // Navigate to "Other:" option to enter text mode, then ^C
    // "Other:" is second-to-last, "Let's discuss" is last
    // Down twice from "Yes" → past "Let's discuss" ... actually let's just send ^C directly in normal mode
    process.stdin.emit("data", "\x11"); // down → "Other:" (text mode)
    process.stdin.emit("data", "\x03");
    await expect(promise).rejects.toBeInstanceOf(PickerCancelledError);
  });

  it("promptLine(): ^C rejects with PickerCancelledError instead of exiting", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const picker = new Picker();

    const promise = picker.promptLine("Enter value: ");
    process.stdin.emit("data", "\x03");
    await expect(promise).rejects.toBeInstanceOf(PickerCancelledError);
  });

  it("pick() without config: drawBar() is called after ^C cancellation", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const display = { clearBar: vi.fn(), drawBar: vi.fn() };
    const picker = new Picker(display);

    const promise = picker.pick(["Allow", "Deny"]);
    process.stdin.emit("data", "\x03");
    await promise;

    expect(display.drawBar).toHaveBeenCalled();
  });
});
