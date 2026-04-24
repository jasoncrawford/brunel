import { describe, it, expect, vi, afterEach } from "vitest";
import { Picker } from "../src/agent/views/picker.js";

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

// ── onStart callback ──────────────────────────────────────────────────────────
//
// When the picker is invoked while ask() is active (the REPL prompt is visible),
// display.clearBar() silently returns early because ask() owns the screen.
// Without intervention, picker options overwrite the status bar lines.
//
// The fix: Picker accepts an optional onStart callback that is called before
// clearBar(). The composition root wires this to input.cancel() so that any
// active ask() is torn down before the picker renders.

describe("Picker onStart callback", () => {
  afterEach(() => {
    process.stdin.removeAllListeners("data");
    vi.restoreAllMocks();
  });

  function setup(optionText: string) {
    const events: Array<"onStart" | "clearBar" | "option" | "drawBar"> = [];

    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      if (String(chunk).includes(optionText)) events.push("option");
      return true;
    });

    const display = {
      clearBar: vi.fn(() => { events.push("clearBar"); }),
      drawBar:  vi.fn(() => { events.push("drawBar"); }),
    };

    const onStart = vi.fn(() => { events.push("onStart"); });

    return { events, display, onStart };
  }

  it("pick(): onStart is called before clearBar and options", async () => {
    const { events, display, onStart } = setup("Alpha");
    const picker = new Picker(display, onStart);

    const promise = picker.pick(["Alpha", "Beta"]);
    process.stdin.emit("data", "\r");
    await promise;

    expect(events).toEqual(["onStart", "clearBar", "option", "drawBar"]);
  });

  it("pickMultiple(): onStart is called before clearBar and options", async () => {
    const { events, display, onStart } = setup("Alpha");
    const picker = new Picker(display, onStart);

    const promise = picker.pickMultiple(["Alpha", "Beta"]);
    process.stdin.emit("data", "\r");
    await promise;

    expect(events).toEqual(["onStart", "clearBar", "option", "drawBar"]);
  });

  it("pickQuestion(): onStart is called before clearBar and options", async () => {
    const { events, display, onStart } = setup("Alpha");
    const picker = new Picker(display, onStart);
    const opts = [{ label: "Alpha", description: "Go" }];

    const promise = picker.pickQuestion(opts);
    process.stdin.emit("data", "\r");
    await promise;

    expect(events).toEqual(["onStart", "clearBar", "option", "drawBar"]);
  });

  it("works with no onStart (backward compatible)", async () => {
    const events: string[] = [];
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const display = {
      clearBar: vi.fn(() => { events.push("clearBar"); }),
      drawBar:  vi.fn(() => { events.push("drawBar"); }),
    };
    const picker = new Picker(display); // no onStart

    const promise = picker.pick(["A", "B"]);
    process.stdin.emit("data", "\r");
    await promise;

    expect(events[0]).toBe("clearBar"); // clearBar still first
    expect(events).not.toContain("onStart");
  });
});
