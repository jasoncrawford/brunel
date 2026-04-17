import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "stream";
import { ask } from "../src/agent/views/input.js";
import { Display } from "../src/agent/views/display.js";
import { StatusBar } from "../src/agent/views/status-bar.js";
import { getConfig } from "../src/config.js";

function makeStdin() {
  const stream = new PassThrough();
  stream.setEncoding("utf8");
  (stream as any).setRawMode = vi.fn();
  return stream;
}

let origStdin: NodeJS.ReadStream;
let origColumns: number | undefined;

function withFakeStdin(fn: (stdin: PassThrough) => Promise<void>): Promise<void> {
  const stdin = makeStdin();
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
  return fn(stdin).finally(() => {
    Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
  });
}

function setColumns(n: number) {
  Object.defineProperty(process.stdout, "columns", { value: n, configurable: true, writable: true });
}

function collectOutput(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map(c => String(c[0])).join("");
}

let testDisplay: Display;

beforeEach(() => {
  testDisplay = new Display(getConfig(), new StatusBar({ agentId: "test-agent" }));
  origStdin = process.stdin;
  origColumns = process.stdout.columns;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
  if (origColumns !== undefined) {
    setColumns(origColumns);
  }
  vi.restoreAllMocks();
});

// ── Multiline rendering ────────────────────────────────────────────────────────

describe("ask() - multiline rendering", () => {
  it("typing past terminal line boundary redraws from row 0", async () => {
    // cols=10, prompt="> " (2 chars), so 8 chars fills row 0 exactly (pending-wrap).
    // cursor=8 is in pending-wrap: still on row 0 (no \x1b[1A should fire for that char).
    // Typing the 9th char lands on row 1; redraw must navigate correctly.
    setColumns(10);

    await withFakeStdin(async (stdin) => {
      const p = ask(testDisplay.statusBar, "> ", () => []);
      stdin.push("12345678"); // fills row 0 exactly (pending-wrap)
      stdin.push("9");        // goes to row 1
      stdin.push("\r");
      expect(await p).toBe("123456789");
    });
  });

  it("pending-wrap: typing char that exactly fills terminal row does not emit cursor-up", async () => {
    // Bug 1: screenPosOf overcounts rows at pending-wrap boundary.
    // cols=10, prompt="> " (2 chars), buffer="12345678" (8 chars, fills row 0 exactly).
    // cursor=8 is pending-wrap — still on row 0.  Typing "9" has prevRow=0 (no cursor-up).
    // With the bug, screenPosOf(8) returns row=1 → fullRedraw emits \x1b[1A (going above prompt).
    setColumns(10);
    const writeSpy = vi.mocked(process.stdout.write);

    await withFakeStdin(async (stdin) => {
      const p = ask(testDisplay.statusBar, "> ", () => []);
      stdin.push("12345678"); // fills row 0 (pending-wrap at cursor=8, row 0)
      writeSpy.mockClear();   // clear setup output
      stdin.push("9");        // prevRow should be 0 → no cursor-up
      // Must NOT emit \x1b[1A *before* the prompt text: that would mean screenPosOf(8)
      // incorrectly returned row=1, causing a premature cursor-up above the prompt.
      // (A \x1b[1A *after* the prompt is fine — it's the "go back to row 0" navigation.)
      const output = collectOutput(writeSpy);
      const promptPos = output.indexOf("> ");
      const firstCursorUp = output.indexOf("\x1b[1A");
      expect(promptPos).toBeGreaterThan(-1);
      if (firstCursorUp !== -1) {
        expect(firstCursorUp).toBeGreaterThan(promptPos);
      }
      stdin.push("\r");
      expect(await p).toBe("123456789");
    });
  });

  it("left arrow from row 1 to row 0 emits cursor-up", async () => {
    // cols=10, prompt="> " (2 chars), buffer="123456789" (9 chars).
    // cursor=9 is on row 1.  Left arrow → cursor=8 (pending-wrap end of row 0) → \x1b[1A.
    setColumns(10);
    const writeSpy = vi.mocked(process.stdout.write);

    await withFakeStdin(async (stdin) => {
      const p = ask(testDisplay.statusBar, "> ", () => []);
      stdin.push("123456789"); // cursor=9 on row 1
      writeSpy.mockClear();
      stdin.push("\x1b[D");    // left arrow: prevRow=1 → cursor=8 (row 0) → \x1b[1A
      stdin.push("\r");
      expect(await p).toBe("123456789");
    });

    expect(collectOutput(writeSpy)).toContain("\x1b[1A");
  });

  it("buffer value is correct after inserting across line boundary", async () => {
    // Sanity check: editing across line boundaries yields correct buffer
    setColumns(10);

    await withFakeStdin(async (stdin) => {
      const p = ask(testDisplay.statusBar, "> ", () => []);
      stdin.push("12345678"); // fills row 0
      stdin.push("9");        // row 1, cursor=9
      stdin.push("\x1b[D");   // left → cursor=8 (row 1 → row 0 boundary)
      stdin.push("X");        // insert X at position 8
      stdin.push("\r");
      expect(await p).toBe("12345678X9");
    });
  });

  it("^A (home) from row 1 goes to cursor=0 via cursor-up", async () => {
    // cols=10, buffer of 9 chars → cursor at row 1; ^A should go to row 0, col 2
    setColumns(10);
    const writeSpy = vi.mocked(process.stdout.write);

    await withFakeStdin(async (stdin) => {
      const p = ask(testDisplay.statusBar, "> ", () => []);
      stdin.push("123456789"); // cursor=9, visual=11, row=1
      writeSpy.mockClear();
      stdin.push("\x01");      // ^A → moveTo(0), prevCursor=9 (row 1)
      stdin.push("\r");
      expect(await p).toBe("123456789");
    });

    expect(collectOutput(writeSpy)).toContain("\x1b[1A");
  });

  it("^E (end) from row 0 of multiline buffer goes to row 1 via cursor-down", async () => {
    setColumns(10);
    const writeSpy = vi.mocked(process.stdout.write);

    await withFakeStdin(async (stdin) => {
      const p = ask(testDisplay.statusBar, "> ", () => []);
      stdin.push("123456789"); // fill to row 1
      stdin.push("\x01");      // ^A → cursor=0, row 0
      writeSpy.mockClear();
      stdin.push("\x05");      // ^E → moveTo(9), row 1 → need \x1b[1B
      stdin.push("\r");
      expect(await p).toBe("123456789");
    });

    expect(collectOutput(writeSpy)).toContain("\x1b[1B");
  });

  // ── Bug 3: ^U (kill-to-start) on multiline buffer ──────────────────────────

  it("^U on multiline buffer emits cursor-up as the very first action", async () => {
    // Bug 3: killToStart() mutates buffer before calling fullRedraw, so
    // screenPosOf(prevCursor) on the now-empty buffer returns row=0 instead of
    // the actual row the cursor was on.  With the bug, fullRedraw starts with
    // \r (not \x1b[1A), and the old content on row 0 is never erased.
    // Fix: compute prevRow from the OLD buffer before mutating, pass it directly.
    setColumns(10);
    const writeSpy = vi.mocked(process.stdout.write);

    await withFakeStdin(async (stdin) => {
      const p = ask(testDisplay.statusBar, "> ", () => []);
      stdin.push("123456789"); // cursor=9 on row 1
      writeSpy.mockClear();
      stdin.push("\x15");      // ^U → kill to start
      // First write must be \x1b[1A (cursor up to row 0), not \r
      const firstWrite = String(writeSpy.mock.calls[0]?.[0] ?? "");
      expect(firstWrite).toBe("\x1b[1A");
      stdin.push("\r");
      expect(await p).toBe("");
    });
  });
});

// ── Bug 2: up/down arrow navigation in multiline input ────────────────────────

describe("ask() - up/down arrow navigation", () => {
  it("up arrow from row 1 moves cursor to row 0", async () => {
    // cols=10, prompt="> " (2 chars), buffer="123456789X" (10 chars).
    // screenPosOf(10) = {row:1, col:2}.  Up arrow → row=0, col=2 → cursor=0.
    // Type "Y" → "Y123456789X".
    setColumns(10);

    await withFakeStdin(async (stdin) => {
      const p = ask(testDisplay.statusBar, "> ", () => []);
      stdin.push("123456789X"); // cursor=10, row=1, col=2
      stdin.push("\x1b[A");    // up arrow → row=0, col=2 → cursor=0
      stdin.push("Y");
      stdin.push("\r");
      expect(await p).toBe("Y123456789X");
    });
  });

  it("down arrow from row 0 moves cursor to row 1", async () => {
    // cols=10, prompt="> " (2 chars), buffer="123456789X" (10 chars).
    // ^A → cursor=0 (row=0, col=2).  Down arrow → row=1, col=2 → cursor=0.
    // But col=2 on row 1 = buffer position past the 8 pending-wrap chars (pos 8) + 0 on row 1 = pos 8.
    // Actually row 1 starts at buf pos 9 ("9"). col=2 on row 1 isn't reachable (only col=1,"9" and col=2,"X").
    // Take closest: col=2 → cursor=10 ("X").  Type "Y" → "123456789XY".
    setColumns(10);

    await withFakeStdin(async (stdin) => {
      const p = ask(testDisplay.statusBar, "> ", () => []);
      stdin.push("123456789X"); // cursor=10, row=1
      stdin.push("\x01");       // ^A → cursor=0, row=0, col=2
      stdin.push("\x1b[B");     // down arrow → row=1, col=2 → cursor=10
      stdin.push("Y");
      stdin.push("\r");
      expect(await p).toBe("123456789XY");
    });
  });

  it("up arrow at row 0 is a no-op", async () => {
    // Already on top row — up arrow should not move cursor.
    setColumns(10);

    await withFakeStdin(async (stdin) => {
      const p = ask(testDisplay.statusBar, "> ", () => []);
      stdin.push("hello");
      stdin.push("\x01");    // ^A → cursor=0
      stdin.push("\x1b[A"); // up arrow at row 0 → no-op
      stdin.push("X");
      stdin.push("\r");
      expect(await p).toBe("Xhello");
    });
  });

  it("down arrow at last row is a no-op", async () => {
    // Already on the last row — down arrow should not move cursor.
    setColumns(10);

    await withFakeStdin(async (stdin) => {
      const p = ask(testDisplay.statusBar, "> ", () => []);
      stdin.push("hello");  // single row
      stdin.push("\x01");   // ^A → cursor=0
      stdin.push("\x1b[B"); // down arrow at last row → no-op (stays at cursor=0)
      stdin.push("X");
      stdin.push("\r");
      expect(await p).toBe("Xhello");
    });
  });
});

// ── Status update callback (issue #486: paste + status bar) ──────────────────
//
// When the persistent status bar changes while ask() has a multiline buffer
// displayed (e.g. from a large paste), the old code called drawFresh() via
// _inputPrintCallback.  drawFresh() assumes the cursor is at a fresh new line
// (after testDisplay.print()); when called with the cursor in the buffer area it
// writes the prompt at the wrong row, leaving status-bar text interleaved with
// the buffer content.
//
// The fix: ask() registers _inputStatusCallback = redrawFromCurrent(), which
// calls fullRedraw(cursorRow, ...).  fullRedraw() navigates back to the prompt
// line before redrawing, so the status bars always land below the buffer.

describe("ask() - status update during multiline input (issue #486)", () => {
  it("status update while cursor is on row 1 navigates up to prompt before redrawing", async () => {
    // cols=10, prompt="> " (2 chars), buffer=9 chars → cursor on row 1.
    // When updatePersistentStatus fires, the first write should be \x1b[1A
    // (cursor-up to row 0) so the prompt is redrawn from the top, not from
    // row 1 where the buffer cursor sits.
    setColumns(10);
    const writeSpy = vi.mocked(process.stdout.write);

    testDisplay.statusBar.startPersistent(() => "status");

    await withFakeStdin(async (stdin) => {
      const p = ask(testDisplay.statusBar, "> ", () => []);
      stdin.push("123456789"); // cursor on row 1 (9 chars + 2-char prompt wraps)
      writeSpy.mockClear();

      // Simulate a status update (e.g. branch refresh, WS reconnect) while
      // the cursor is sitting on row 1 of the multiline buffer.
      testDisplay.statusBar.updatePersistent();

      // The redraw must start by going up 1 row (\x1b[1A) to reach the prompt
      // line (row 0), then write the prompt "> ".  Without the fix, drawFresh()
      // would write the prompt at the current cursor row (row 1), so "\x1b[1A"
      // would appear only AFTER the prompt text — indicating wrong behaviour.
      const output = collectOutput(writeSpy);
      const cursorUp   = output.indexOf("\x1b[1A");
      const promptPos  = output.indexOf("> ");
      expect(cursorUp).toBeGreaterThan(-1);   // cursor-up must appear
      expect(promptPos).toBeGreaterThan(-1);  // prompt must appear
      // cursor-up must come BEFORE the prompt (navigate back, then draw)
      expect(cursorUp).toBeLessThan(promptPos);

      stdin.push("\r");
      expect(await p).toBe("123456789");
    });

    testDisplay.statusBar.stopPersistent();
  });

  it("status update while cursor is on row 0 does not emit spurious cursor-up", async () => {
    // cols=10, prompt="> " (2 chars), buffer=5 chars — all fits on row 0.
    // No cursor-up should be needed: the prompt is already at the top.
    setColumns(10);
    const writeSpy = vi.mocked(process.stdout.write);

    testDisplay.statusBar.startPersistent(() => "status");

    await withFakeStdin(async (stdin) => {
      const p = ask(testDisplay.statusBar, "> ", () => []);
      stdin.push("hello"); // 5 chars, stays on row 0
      writeSpy.mockClear();

      testDisplay.statusBar.updatePersistent();

      const output = collectOutput(writeSpy);
      // A \x1b[0A is a no-op (guard in fullRedraw), so we just verify the
      // prompt appears and the output doesn't start with a cursor-up.
      expect(output).toContain("> ");
      // First non-trivial write must be \r (go to col 0), not \x1b[NA.
      const firstWrite = String(writeSpy.mock.calls[0]?.[0] ?? "");
      expect(firstWrite).not.toMatch(/^\x1b\[\d+A/); // no leading cursor-up

      stdin.push("\r");
      expect(await p).toBe("hello");
    });

    testDisplay.statusBar.stopPersistent();
  });
});

// ── Print callback (worker mode cursor fix) ────────────────────────────────────

describe("testDisplay.print() callback for ask() redraw", () => {
  it("setInputPrintCallback registers a callback called on testDisplay.print()", () => {
    const callback = vi.fn();
    testDisplay.statusBar.inputPrint = callback;
    // Spy on console.log to prevent actual output
    vi.spyOn(console, "log").mockImplementation(() => {});
    testDisplay.print("test message");
    expect(callback).toHaveBeenCalled();
    testDisplay.statusBar.inputPrint = null;
  });

  it("callback is not called after it is cleared", () => {
    const callback = vi.fn();
    testDisplay.statusBar.inputPrint = callback;
    testDisplay.statusBar.inputPrint = null;
    vi.spyOn(console, "log").mockImplementation(() => {});
    testDisplay.print("test message");
    expect(callback).not.toHaveBeenCalled();
  });

  it("ask() redraws prompt after testDisplay.print() during input", async () => {
    setColumns(80);
    const writeSpy = vi.mocked(process.stdout.write);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await withFakeStdin(async (stdin) => {
      const p = ask(testDisplay.statusBar, "> ", () => []);
      stdin.push("hello");
      writeSpy.mockClear();

      // Simulate testDisplay.print() being called while ask() is running
      testDisplay.print("  Connected to foreman.");

      // The prompt should be redrawn after print, starting with \r (not \r\n —
      // console.log already moved to a new line, so no extra blank line needed)
      const output = collectOutput(writeSpy);
      // Should write the prompt again (either "> " or the buffer)
      expect(output).toMatch(/\r.*>/);

      stdin.push("\r");
      expect(await p).toBe("hello");
    });
  });
});
