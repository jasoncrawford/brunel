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
// The bug: when the picker runs while ask() owns the screen (e.g. SIGINT fires
// during the "[agent] > " prompt), display.clearBar() exits early because
// inputPrint is set. Picker options are then written at the prompt cursor
// position, overwriting the status bar rows.
//
// The fix: Picker accepts an optional onStart callback that is called before
// clearBar(). The composition root wires this to input.cancel(), which clears
// inputPrint/inputStatus/inputClear so clearBar() can actually erase the status
// bar rows before rendering options.
//
// Behavioral test: with inputPrint set (ask() active) and a persistent status
// bar present, verify that the erase-to-end-of-line sequence (\x1b[K) written
// by clearBar() appears in stdout *before* the first option text. Without
// onStart, clearBar() is a no-op and no erase precedes the options.

describe("Picker: status bar erasure before options when ask() is active (issue #832)", () => {
  afterEach(() => {
    process.stdin.removeAllListeners("data");
    vi.restoreAllMocks();
  });

  /** Sets up a real Display with a persistent bar active and inputPrint set, returns stdout spy. */
  function setup() {
    const agentStatus = new AgentStatus({ agentId: "test-agent" });
    const display = new Display(getConfig(), agentStatus);
    display.persistentActive = true; // makes clearBar() have rows to erase
    display.inputPrint = () => {};   // simulates ask() owning the screen

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    // onStart tears down the ask() state so clearBar() can run (the fix)
    const onStart = () => {
      display.inputPrint = null;
      display.inputStatus = null;
      display.inputClear = null;
    };

    return { display, written, onStart };
  }

  /** Returns true if an erase-to-end-of-line (\x1b[K) appears before `text` in the joined output. */
  function eraseBeforeText(written: string[], text: string): boolean {
    const all = written.join("");
    const optionAt = all.indexOf(text);
    if (optionAt === -1) return false;
    return all.lastIndexOf("\x1b[K", optionAt) !== -1;
  }

  it("pick(): status bar is erased before options even when inputPrint is set", async () => {
    const { display, written, onStart } = setup();
    const picker = new Picker(display, onStart);

    const promise = picker.pick(["Option A", "Option B"]);
    process.stdin.emit("data", "\r");
    await promise;

    expect(eraseBeforeText(written, "Option A")).toBe(true);
  });

  it("pickMultiple(): status bar is erased before options even when inputPrint is set", async () => {
    const { display, written, onStart } = setup();
    const picker = new Picker(display, onStart);

    const promise = picker.pickMultiple(["Choice A", "Choice B"]);
    process.stdin.emit("data", "\r");
    await promise;

    expect(eraseBeforeText(written, "Choice A")).toBe(true);
  });

  it("pickQuestion(): status bar is erased before options even when inputPrint is set", async () => {
    const { display, written, onStart } = setup();
    const picker = new Picker(display, onStart);
    const opts = [{ label: "Yes", description: "Proceed" }];

    const promise = picker.pickQuestion(opts);
    process.stdin.emit("data", "\r");
    await promise;

    expect(eraseBeforeText(written, "Yes")).toBe(true);
  });

  it("without onStart, no erase precedes options when inputPrint is set (documents the bug)", async () => {
    const { display, written } = setup();
    const picker = new Picker(display); // no onStart — clearBar() stays a no-op

    const promise = picker.pick(["Option A", "Option B"]);
    process.stdin.emit("data", "\r");
    await promise;

    expect(eraseBeforeText(written, "Option A")).toBe(false);
  });
});
