import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "stream";
import { Input } from "../src/agent/views/input.js";
import { Picker } from "../src/agent/views/picker.js";
import type { PickQuestionResult } from "../src/agent/views/picker.js";
import { Display } from "../src/agent/views/display.js";
import { AgentStatus } from "../src/agent/models/agent-status.js";
import { getConfig } from "../src/config.js";

function makeStdin() {
  const stream = new PassThrough();
  stream.setEncoding("utf8");
  (stream as any).setRawMode = vi.fn();
  return stream;
}

// Replace process.stdin for each test
let origStdin: NodeJS.ReadStream;

function withFakeStdin(fn: (stdin: PassThrough) => Promise<void>): Promise<void> {
  const stdin = makeStdin();
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
  return fn(stdin).finally(() => {
    Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
  });
}

let testDisplay: Display;
let testInput: Input;
let testPicker: Picker;

beforeEach(() => {
  testDisplay = new Display(getConfig(), new AgentStatus({ agentId: "test-agent" }));
  testInput = new Input(testDisplay);
  testPicker = new Picker();
  origStdin = process.stdin;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
  vi.restoreAllMocks();
});

describe("ask() - basic input", () => {
  it("type hello then \\r → resolves to 'hello'", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("hello");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hello");
    });
  });

  it("leading/trailing whitespace trimmed", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("  hi  ");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hi");
    });
  });

  it("empty Enter → resolves to ''", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("");
    });
  });
});

describe("ask() - cursor movement", () => {
  it("^A moves cursor to 0", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("hello");
      stdin.push("\x01"); // ^A
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hello");
    });
  });

  it("^E moves cursor to end", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("hello");
      stdin.push("\x01"); // ^A → go to start
      stdin.push("\x05"); // ^E → go to end
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hello");
    });
  });

  it("left arrow moves cursor left", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("ab");
      stdin.push("\x1b[D"); // left arrow
      stdin.push("X");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("aXb");
    });
  });

  it("right arrow moves cursor right", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("ab");
      stdin.push("\x1b[D"); // left
      stdin.push("\x1b[C"); // right → back to end
      stdin.push("Z");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("abZ");
    });
  });

  it("left arrow at start: no crash, cursor stays at 0", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("\x1b[D"); // left at start
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("");
    });
  });

  it("right arrow at end: no crash", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("hi");
      stdin.push("\x1b[C"); // right at end
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hi");
    });
  });

  it("iTerm2 option+left: word jump left", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("foo bar");
      stdin.push("\x1b[1;3D"); // iTerm2 option+left
      stdin.push("X");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("foo Xbar");
    });
  });

  it("iTerm2 option+right: word jump right", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("foo bar");
      stdin.push("\x1b[1;3D"); // option+left → before "bar"
      stdin.push("\x1b[1;3D"); // option+left → before "foo"
      stdin.push("\x1b[1;3C"); // option+right → after "foo"
      stdin.push("X");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("fooX bar");
    });
  });

  it("Terminal.app option+left: word jump left", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("foo bar");
      stdin.push("\x1bb"); // Terminal.app option+left
      stdin.push("X");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("foo Xbar");
    });
  });

  it("Terminal.app option+right: word jump right", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("foo bar");
      stdin.push("\x1bb"); // option+left → before "bar"
      stdin.push("\x1bb"); // option+left → before "foo"
      stdin.push("\x1bf"); // option+right → after "foo"
      stdin.push("X");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("fooX bar");
    });
  });
});

describe("ask() - kill / delete", () => {
  it("backspace at non-zero cursor deletes char before cursor", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("hello");
      stdin.push("\x7f"); // backspace
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hell");
    });
  });

  it("backspace at cursor=0: no crash, no change", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("\x7f"); // backspace at start
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("");
    });
  });

  it("^K kills from cursor to end", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("hello world");
      stdin.push("\x01"); // ^A → start
      stdin.push("\x1b[C"); // right → after 'h'
      stdin.push("\x0b"); // ^K → kill "ello world"
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("h");
    });
  });

  it("^U kills from start to cursor", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("hello");
      stdin.push("\x15"); // ^U → kill all
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("");
    });
  });

  it("^W deletes word before cursor", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("foo bar");
      stdin.push("\x17"); // ^W → deletes "bar"
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("foo"); // ask() trims; "foo " → "foo"
    });
  });

  it("^D in middle of buffer deletes character under cursor, cursor stays", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("abcd");
      stdin.push("\x01"); // ^A → go to start
      stdin.push("\x1b[C"); // right → cursor after 'a', before 'b'
      stdin.push("\x04"); // ^D → deletes 'b'
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("acd");
    });
  });

  it("^D at start of buffer deletes first character", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("hello");
      stdin.push("\x01"); // ^A → go to start (cursor=0)
      stdin.push("\x04"); // ^D → deletes 'h'
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("ello");
    });
  });

  it("^D at end of buffer is a no-op", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("hello");
      // cursor is already at end after typing
      stdin.push("\x04"); // ^D at end → no-op
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hello");
    });
  });
});

describe("ask() - character insertion", () => {
  it("printable chars inserted at cursor position", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("ac");
      stdin.push("\x1b[D"); // left → between a and c
      stdin.push("b");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("abc");
    });
  });

  it("non-printable control chars ignored", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("hi");
      stdin.push("\x02"); // ^B — not handled, should be ignored
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hi");
    });
  });
});

describe("ask() - exit conditions", () => {
  it("^D with cursor at end of buffer → no-op (does not exit)", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("hello");
      stdin.push("\x04"); // ^D at end → no-op (nothing to delete forward)
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hello");
    });
  });

  it("^C with empty buffer → resolves with '__ctrl_c__' (does not call process.exit)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("\x03"); // ^C with empty buffer
      const result = await p;
      expect(result).toBe("__ctrl_c__");
      expect(exitSpy).not.toHaveBeenCalled();
    });
    exitSpy.mockRestore();
  });

  it("^C with non-empty buffer → clears buffer, does not exit", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("hello");
      stdin.push("\x03"); // ^C with text in buffer — should clear, not exit
      await new Promise(r => setTimeout(r, 10));
      expect(exitSpy).not.toHaveBeenCalled();
      // Buffer should be cleared; pressing Enter should submit empty string
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("");
    });
    exitSpy.mockRestore();
  });

  it("^D on empty buffer → resolves with '__eof__' (does not call process.exit)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("\x04"); // ^D on empty
      const result = await p;
      expect(result).toBe("__eof__");
      expect(exitSpy).not.toHaveBeenCalled();
    });
    exitSpy.mockRestore();
  });
});

describe("ask() - bracketed paste", () => {
  it("complete paste sequence in one chunk → inserts content", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("\x1b[200~hello world\x1b[201~");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hello world");
    });
  });

  it("paste start/end split across chunks", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("\x1b[200~hello ");
      stdin.push("world\x1b[201~");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hello world");
    });
  });

  it("\\r\\n inside paste normalized to \\n", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("\x1b[200~line1\r\nline2\x1b[201~");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("line1\nline2");
    });
  });

  it("paste inserted at cursor (not at end)", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("ab");
      stdin.push("\x1b[D"); // left → between a and b
      stdin.push("\x1b[200~X\x1b[201~");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("aXb");
    });
  });

  it("paste mode: newlines within paste don't auto-submit", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      // Paste with embedded newline — should not submit mid-paste
      stdin.push("\x1b[200~line1\nline2\x1b[201~");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("line1\nline2");
    });
  });
});

describe("ask() - cancel()", () => {
  it("cancel() while ask() is running resolves with null", async () => {
    await withFakeStdin(async () => {
      const p = testInput.ask("> ", () => []);
      testInput.cancel();
      expect(await p).toBeNull();
    });
  });

  it("cancel() before ask() is called is a no-op", () => {
    // Should not throw
    expect(() => testInput.cancel()).not.toThrow();
  });

  it("cancel() after ask() resolves is a no-op", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("hello\r");
      await p;
      // After resolution, cancel should be a no-op
      expect(() => testInput.cancel()).not.toThrow();
    });
  });
});

describe("ask() - word movement detail", () => {
  it("moveWordLeft: 'foo bar|' → 'foo |bar'", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("foo bar");
      stdin.push("\x1bb"); // option+left → before "bar"
      stdin.push("X");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("foo Xbar");
    });
  });

  it("moveWordLeft with trailing spaces: skips spaces then word", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("foo bar  "); // cursor at end (after spaces)
      stdin.push("\x1bb"); // option+left → before "bar"
      stdin.push("X");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("foo Xbar"); // ask() trims; trailing spaces removed
    });
  });

  it("moveWordRight: '|foo bar' → 'foo| bar'", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("foo bar");
      stdin.push("\x01"); // ^A → start
      stdin.push("\x1bf"); // option+right → after "foo"
      stdin.push("X");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("fooX bar");
    });
  });
});

describe("ask() - submit output", () => {
  it("submit clears suggestion row without an extra trailing blank line", async () => {
    // submit() should write \r\n\x1b[K (move to suggestion row, clear it) and stop.
    // A trailing \r\n after \x1b[K adds an extra blank line before query output,
    // causing double-spacing when combined with the \n prefix in text formatters.
    const writeSpy = vi.mocked(process.stdout.write);

    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("hello");
      writeSpy.mockClear(); // ignore prompt/redraw writes from typing
      stdin.push("\r");
      await p;
    });

    const writes = writeSpy.mock.calls.map((c) => String(c[0]));
    // The suggestion-row clear must NOT include a trailing \r\n
    expect(writes).not.toContain("\r\n\x1b[K\r\n");
  });
});

describe("ask() - drawFresh after print()", () => {
  it("print() while ask() is running does not add a blank line before the redrawn prompt", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);

      // Simulate testDisplay.print() being called (e.g., an event notification arriving)
      testDisplay.print("Event received: some_event");

      // The drawFresh callback redraws the prompt. Collect all write calls made
      // during/after the print.
      const writes = writeSpy.mock.calls.map((c) => String(c[0]));

      // drawFresh should NOT write \r\n before the prompt — that creates a blank
      // line between the event text and the redrawn prompt (issue #132).
      const hasLeadingBlankLine = writes.some((w) => w.startsWith("\r\n"));
      expect(hasLeadingBlankLine).toBe(false);

      stdin.push("\r");
      await p;
    });
  });
});

describe("ask() - blank line suppression with \\n prefix prompt", () => {
  it("cancel() with \\n prefix does NOT write \\r\\n\\x1b[J (no separator line)", async () => {
    // When ask() is cancelled by a session event, the cleanup must NOT write
    // \r\n\x1b[J. That separator line is never consumed (no status bar runs
    // after a cancel) and accumulates as blank lines on each cancel/re-prompt
    // cycle (issue #418).
    const writeSpy = vi.mocked(process.stdout.write);

    await withFakeStdin(async (_stdin) => {
      const p = testInput.ask("\n> ", () => []);
      writeSpy.mockClear();
      testInput.cancel();
      await p;
    });

    const writes = writeSpy.mock.calls.map((c) => String(c[0]));
    expect(writes).not.toContain("\r\n\x1b[J");
  });

  it("cancel() with \\n prefix writes cursor-up to clear the blank line", async () => {
    // The cancel cleanup should go up 1 row to erase the blank line that the
    // \n prefix wrote when ask() was first called, so the next prompt starts
    // at the same vertical position and blank lines do not accumulate.
    const writeSpy = vi.mocked(process.stdout.write);

    await withFakeStdin(async (_stdin) => {
      const p = testInput.ask("\n> ", () => []);
      writeSpy.mockClear();
      testInput.cancel();
      await p;
    });

    const writes = writeSpy.mock.calls.map((c) => String(c[0]));
    const hasUp = writes.some((w) => w.includes("\x1b[1A"));
    expect(hasUp).toBe(true);
  });

  it("print() while ask() with \\n prefix is running goes up before clearing (cursor-up + erase-to-end)", async () => {
    // When testDisplay.print() fires while the prompt is visible, the clearForPrint
    // callback must go up prefixRows rows before erasing to end of screen so
    // the blank prefix line is cleared along with the prompt.  Without this,
    // the blank line is orphaned above the printed message (issue #418).
    // The distinguishing marker is a cursor-up escape (\x1b[1A) combined with
    // erase-to-end (\x1b[J) in the same write call — the no-prefix path uses
    // \r\x1b[J (no cursor-up) and drawFresh's cursor-up is a separate write.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const writeSpy = vi.mocked(process.stdout.write);

    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("\n> ", () => []);
      writeSpy.mockClear();

      testDisplay.print("notification");

      const writes = writeSpy.mock.calls.map((c) => String(c[0]));
      // clearForPrint() writes \x1b[1A\r\x1b[J as a single call — check for both
      const hasPrefixClear = writes.some((w) => /\x1b\[\d+A/.test(w) && w.includes("\x1b[J"));
      expect(hasPrefixClear).toBe(true);

      stdin.push("\r");
      await p;
    });
  });

  it("print() while ask() WITHOUT \\n prefix does NOT go up before clearing (no cursor-up+erase combo)", async () => {
    // No-prefix prompts use \r\x1b[J (no cursor-up) — the cursor-up+erase
    // combination should only appear when there are prefix blank lines to clear.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const writeSpy = vi.mocked(process.stdout.write);

    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      writeSpy.mockClear();

      testDisplay.print("notification");

      const writes = writeSpy.mock.calls.map((c) => String(c[0]));
      // Should NOT have cursor-up combined with \x1b[J in any single write
      const hasPrefixClear = writes.some((w) => /\x1b\[\d+A/.test(w) && w.includes("\x1b[J"));
      expect(hasPrefixClear).toBe(false);

      stdin.push("\r");
      await p;
    });
  });

  it("cancel() after print() with \\n prefix does NOT go up into printed content (issue #1146)", async () => {
    // Regression test for issue #1146: when display.print() fires while ask() with
    // a \n prefix is active, _drawFresh() redraws the prompt below the new content
    // without the blank prefix row above it. cancel() must NOT move up by _prefixRows
    // (those rows are now content), or it erases the last line of the printed text.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const writeSpy = vi.mocked(process.stdout.write);

    await withFakeStdin(async () => {
      const p = testInput.ask("\n[agent] > ", () => []);

      // Simulate an external print arriving while the prompt is visible
      testDisplay.print("line one\nline two\nlast line");

      // Clear spy to isolate only cancel()'s writes
      writeSpy.mockClear();

      testInput.cancel();
      await p;
    });

    // cancel() must NOT write any cursor-up escape — the prefix blank row was
    // consumed by printed content, so going up would erase content, not blank space.
    const writes = writeSpy.mock.calls.map((c) => String(c[0]));
    const hasCursorUp = writes.some((w) => /\x1b\[\d+A/.test(w));
    expect(hasCursorUp).toBe(false);
  });
});

describe("ask() - status bar repositioning on start (issue #757)", () => {
  it("ask() with active persistent status bar calls drawRaw() immediately to position bar below prompt", async () => {
    // Regression test for issue #757: when ask() starts after a query, the cursor
    // sits on the blank separator row above the persistent status bar. The leading
    // \n in "\n[agent] > " moves the cursor INTO the bar line and the prompt text
    // overwrites its beginning.  ask() must call _fullRedraw() unconditionally (not
    // only when the buffer is pre-populated from stash) so that drawRaw() is called
    // and the bar is repositioned below the fresh prompt.
    const agentStatus = new AgentStatus({ agentId: "test-agent" });
    const display = new Display(getConfig(), agentStatus);
    display.persistentActive = true; // simulate post-query state with bar active
    const input = new Input(display);
    const drawRawSpy = vi.spyOn(display, "drawRaw");
    const writeSpy = vi.mocked(process.stdout.write);
    writeSpy.mockClear();

    await withFakeStdin(async (stdin) => {
      const p = input.ask("\n[agent] > ");

      // drawRaw() must have been called during ask() initialisation —
      // before any user input arrives.
      expect(drawRawSpy).toHaveBeenCalled();

      stdin.push("\r");
      await p;
    });
  });

  it("ask() with no active status bar still works correctly (drawRaw no-ops)", async () => {
    // With no active bars drawRaw() returns 0 without writing; calling it is
    // harmless, but the prompt should still render correctly.
    const agentStatus = new AgentStatus({ agentId: "test-agent" }); // persistentActive defaults false
    const display = new Display(getConfig(), agentStatus);
    const input = new Input(display);
    const drawRawSpy = vi.spyOn(display, "drawRaw");

    await withFakeStdin(async (stdin) => {
      const p = input.ask("\n[agent] > ");
      // drawRaw() is called but returns 0 (no rows written); prompt still resolves
      expect(drawRawSpy).toHaveBeenCalled();
      stdin.push("hello\r");
      expect(await p).toBe("hello");
    });
  });
});

describe("pickQuestion()", () => {
  const opts = [
    { label: "Blue",  description: "A cool color" },
    { label: "Red",   description: "A bold color" },
    { label: "Green", description: "An earthy color" },
  ];

  it("Enter on first option returns answer with first label", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testPicker.pickQuestion(opts);
      stdin.push("\r");
      const result = await p;
      expect(result).toEqual({ type: "answer", value: "Blue" });
    });
  });

  it("down arrow then Enter returns second option", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testPicker.pickQuestion(opts);
      stdin.push("\x1b[B\r");
      const result = await p;
      expect(result).toEqual({ type: "answer", value: "Red" });
    });
  });

  it("digit key jumps to that 1-based index", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testPicker.pickQuestion(opts);
      stdin.push("3\r");
      const result = await p;
      expect(result).toEqual({ type: "answer", value: "Green" });
    });
  });

  it("digit out of range is a no-op, cursor stays at 0", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testPicker.pickQuestion(opts);
      stdin.push("9\r"); // 5 total options; 9 is out of range
      const result = await p;
      expect(result).toEqual({ type: "answer", value: "Blue" });
    });
  });

  it("navigating to Other: activates text entry; type then Enter returns {type:other}", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testPicker.pickQuestion(opts);
      // Navigate to Other: (textMode activates), then type, then Enter — only one Enter
      stdin.push("\x1b[B\x1b[B\x1b[B");
      stdin.push("purple\r");
      const result = await p;
      expect(result).toEqual({ type: "other", text: "purple" });
    });
  });

  it("Enter on Other: with no text returns {type:other} with empty string", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testPicker.pickQuestion(opts);
      stdin.push("\x1b[B\x1b[B\x1b[B\r"); // navigate to Other: then Enter immediately
      const result = await p;
      expect(result).toEqual({ type: "other", text: "" });
    });
  });

  it("navigating to Let's discuss and Enter returns {type:discuss}", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testPicker.pickQuestion(opts);
      // 3 model opts → Discuss is index 4 → down 4 times, Enter
      stdin.push("\x1b[B\x1b[B\x1b[B\x1b[B\r");
      const result = await p;
      expect(result).toEqual({ type: "discuss" });
    });
  });

  it("renders option labels to stdout", async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s: any) => {
      written.push(String(s)); return true;
    });
    await withFakeStdin(async (stdin) => {
      const p = testPicker.pickQuestion(opts);
      stdin.push("\r");
      await p;
    });
    const out = written.join("");
    expect(out).toContain("Blue");
    expect(out).toContain("Red");
    expect(out).toContain("Green");
    expect(out).toContain("Other:");
    expect(out).toContain("discuss");
  });
});

describe("pick() - single-selection picker", () => {
  it("Enter with no navigation → selects first option (index 0)", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testPicker.pick(["Alpha", "Beta", "Gamma"]);
      stdin.push("\r");
      const result = await p;
      expect(result).toBe(0);
    });
  });

  it("down arrow once, then Enter → selects index 1", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testPicker.pick(["Alpha", "Beta", "Gamma"]);
      stdin.push("\x1b[B"); // down
      stdin.push("\r");
      const result = await p;
      expect(result).toBe(1);
    });
  });

  it("down arrow twice, then Enter → selects index 2", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testPicker.pick(["Alpha", "Beta", "Gamma"]);
      stdin.push("\x1b[B");
      stdin.push("\x1b[B");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe(2);
    });
  });

  it("down past last option wraps to index 0", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testPicker.pick(["A", "B"]);
      stdin.push("\x1b[B"); // → 1
      stdin.push("\x1b[B"); // → wraps to 0
      stdin.push("\r");
      const result = await p;
      expect(result).toBe(0);
    });
  });

  it("up arrow from index 0 wraps to last", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testPicker.pick(["A", "B", "C"]);
      stdin.push("\x1b[A"); // up from 0 → wraps to 2
      stdin.push("\r");
      const result = await p;
      expect(result).toBe(2);
    });
  });

  it("up then down then Enter → back to index 0", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testPicker.pick(["A", "B"]);
      stdin.push("\x1b[B"); // → 1
      stdin.push("\x1b[A"); // → 0
      stdin.push("\r");
      const result = await p;
      expect(result).toBe(0);
    });
  });

  it("prints all options to stdout on initial render", async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s: any) => {
      written.push(String(s));
      return true;
    });
    await withFakeStdin(async (stdin) => {
      const p = testPicker.pick(["Foo", "Bar"]);
      stdin.push("\r");
      await p;
    });
    const out = written.join("");
    expect(out).toContain("Foo");
    expect(out).toContain("Bar");
  });
});

describe("pickMultiple() - multi-selection picker", () => {
  it("Enter with no toggles → returns empty array", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testPicker.pickMultiple(["A", "B", "C"]);
      stdin.push("\r");
      const result = await p;
      expect(result).toEqual([]);
    });
  });

  it("space on first option then Enter → returns [0]", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testPicker.pickMultiple(["A", "B", "C"]);
      stdin.push(" "); // toggle A
      stdin.push("\r");
      const result = await p;
      expect(result).toEqual([0]);
    });
  });

  it("space toggles on and off", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testPicker.pickMultiple(["A", "B"]);
      stdin.push(" "); // select A
      stdin.push(" "); // deselect A
      stdin.push("\r");
      const result = await p;
      expect(result).toEqual([]);
    });
  });

  it("navigate down and select multiple", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testPicker.pickMultiple(["A", "B", "C"]);
      stdin.push(" ");        // select A (index 0)
      stdin.push("\x1b[B");  // down to B
      stdin.push("\x1b[B");  // down to C
      stdin.push(" ");        // select C (index 2)
      stdin.push("\r");
      const result = await p;
      expect(result).toEqual([0, 2]);
    });
  });

  it("returns indices in ascending order regardless of selection order", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testPicker.pickMultiple(["A", "B", "C"]);
      stdin.push("\x1b[B"); // down to B
      stdin.push(" ");       // select B (index 1)
      stdin.push("\x1b[A"); // up to A
      stdin.push(" ");       // select A (index 0)
      stdin.push("\r");
      const result = await p;
      expect(result).toEqual([0, 1]);
    });
  });
});

describe("ask() - cancel() auto-stash", () => {
  it("cancel() with non-empty buffer stashes the buffer for next ask()", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("hello world");
      // Give the data event a chance to process
      await new Promise(r => setTimeout(r, 0));
      testInput.cancel();
      await p;

      // Next ask() should be pre-populated with the stashed text
      const p2 = testInput.ask("> ", () => []);
      stdin.push("\r");
      const result = await p2;
      expect(result).toBe("hello world");
    });
  });

  it("cancel() with empty buffer does NOT stash anything", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      testInput.cancel();
      await p;

      // Next ask() should start empty (no stash)
      const p2 = testInput.ask("> ", () => []);
      stdin.push("\r");
      const result = await p2;
      expect(result).toBe("");
    });
  });

  it("cancel() with non-empty buffer writes a stash notification", async () => {
    const writeSpy = vi.mocked(process.stdout.write);

    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("test");
      await new Promise(r => setTimeout(r, 0));
      writeSpy.mockClear();
      testInput.cancel();
      await p;
    });

    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("stashed");
  });

  it("cancel() with empty buffer does NOT write a stash notification", async () => {
    const writeSpy = vi.mocked(process.stdout.write);

    await withFakeStdin(async (_stdin) => {
      const p = testInput.ask("> ", () => []);
      writeSpy.mockClear();
      testInput.cancel();
      await p;
    });

    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).not.toContain("stashed");
  });

  it("cancel() auto-stash overwrites existing stash with full buffer", async () => {
    await withFakeStdin(async (stdin) => {
      // First ask: manually stash "old"
      const p1 = testInput.ask("> ", () => []);
      stdin.push("old");
      await new Promise(r => setTimeout(r, 0));
      stdin.push("\x13"); // ^S stash "old"
      stdin.push("\r");
      await p1;

      // Second ask: stash "old" is restored into the buffer; user appends "new"
      // making the buffer "oldnew"; then cancel auto-stashes the full buffer
      const p2 = testInput.ask("> ", () => []);
      stdin.push("new"); // buffer becomes "oldnew" (appended to restored stash)
      await new Promise(r => setTimeout(r, 0));
      testInput.cancel();
      await p2;

      // Third ask: should restore "oldnew" (the full buffer at cancel time)
      const p3 = testInput.ask("> ", () => []);
      stdin.push("\r");
      const result = await p3;
      expect(result).toBe("oldnew");
    });
  });
});

describe("ask() - stash (^S)", () => {
  it("^S with non-empty buffer clears buffer so ask resolves to ''", async () => {
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("hello world");
      stdin.push("\x13"); // ^S — stash
      stdin.push("\r");   // submit now-empty buffer
      const result = await p;
      expect(result).toBe("");
    });
  });

  it("next ask() after stash is pre-populated with stashed text", async () => {
    await withFakeStdin(async (stdin) => {
      // First ask: stash then submit empty
      const p1 = testInput.ask("> ", () => []);
      stdin.push("hello world");
      stdin.push("\x13");
      stdin.push("\r");
      await p1;

      // Second ask: pre-populated with stash; Enter immediately resolves to stash
      const p2 = testInput.ask("> ", () => []);
      stdin.push("\r");
      const result = await p2;
      expect(result).toBe("hello world");
    });
  });

  it("stash is consumed after one ask() call — third ask starts empty", async () => {
    await withFakeStdin(async (stdin) => {
      const p1 = testInput.ask("> ", () => []);
      stdin.push("saved");
      stdin.push("\x13");
      stdin.push("\r");
      await p1;

      const p2 = testInput.ask("> ", () => []);
      stdin.push("\r");
      const r2 = await p2;
      expect(r2).toBe("saved");

      const p3 = testInput.ask("> ", () => []);
      stdin.push("\r");
      const r3 = await p3;
      expect(r3).toBe(""); // stash was consumed
    });
  });

  it("^S with empty buffer is a no-op — nothing stashed", async () => {
    await withFakeStdin(async (stdin) => {
      const p1 = testInput.ask("> ", () => []);
      stdin.push("\x13"); // ^S with empty buffer
      stdin.push("hi");
      stdin.push("\r");
      const r1 = await p1;
      expect(r1).toBe("hi");

      // No stash was set
      const p2 = testInput.ask("> ", () => []);
      stdin.push("\r");
      const r2 = await p2;
      expect(r2).toBe(""); // starts empty
    });
  });

  it("^S writes a 'stashed' notification to stdout", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s: any) => {
      writes.push(String(s));
      return true;
    });

    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("test");
      stdin.push("\x13");
      stdin.push("\r");
      await p;
    });

    const out = writes.join("");
    expect(out).toContain("stashed");
  });

  it("pressing ^S twice: second stash overwrites first", async () => {
    await withFakeStdin(async (stdin) => {
      const p1 = testInput.ask("> ", () => []);
      stdin.push("first");
      stdin.push("\x13"); // stash "first"
      stdin.push("second");
      stdin.push("\x13"); // stash "second" (overwrites "first")
      stdin.push("\r");
      await p1;

      const p2 = testInput.ask("> ", () => []);
      stdin.push("\r");
      const r2 = await p2;
      expect(r2).toBe("second");
    });
  });
});

describe("firstKeystroke event", () => {
  it("emits 'firstKeystroke' on first character typed when buffer is empty", async () => {
    await withFakeStdin(async (stdin) => {
      const onFirstKeystroke = vi.fn();
      testInput.on("firstKeystroke", onFirstKeystroke);
      const p = testInput.ask("> ", () => []);
      stdin.push("a");
      stdin.push("\r");
      await p;
      expect(onFirstKeystroke).toHaveBeenCalledOnce();
    });
  });

  it("does not emit 'firstKeystroke' when buffer starts non-empty (stash pre-populated)", async () => {
    // Prime the stash so the buffer starts non-empty
    await withFakeStdin(async (stdin) => {
      const p = testInput.ask("> ", () => []);
      stdin.push("stashed");
      stdin.push("\x13"); // ^S stashes
      stdin.push("\r"); // submit empty
      await p;
    });

    await withFakeStdin(async (stdin) => {
      const onFirstKeystroke = vi.fn();
      testInput.on("firstKeystroke", onFirstKeystroke);
      const p = testInput.ask("> ", () => []);
      // Buffer is already "stashed" from stash — typing 'x' doesn't transition from empty
      stdin.push("x");
      stdin.push("\r");
      await p;
      expect(onFirstKeystroke).not.toHaveBeenCalled();
    });
  });

  it("emits 'firstKeystroke' only once per ask() call (second char is not a first keystroke)", async () => {
    await withFakeStdin(async (stdin) => {
      const onFirstKeystroke = vi.fn();
      testInput.on("firstKeystroke", onFirstKeystroke);
      const p = testInput.ask("> ", () => []);
      stdin.push("a");
      stdin.push("b");
      stdin.push("\r");
      await p;
      expect(onFirstKeystroke).toHaveBeenCalledOnce();
    });
  });

  it("emits again on a new ask() call if buffer starts empty again", async () => {
    await withFakeStdin(async (stdin) => {
      const onFirstKeystroke = vi.fn();
      testInput.on("firstKeystroke", onFirstKeystroke);

      const p1 = testInput.ask("> ", () => []);
      stdin.push("a");
      stdin.push("\r");
      await p1;

      const p2 = testInput.ask("> ", () => []);
      stdin.push("b");
      stdin.push("\r");
      await p2;

      expect(onFirstKeystroke).toHaveBeenCalledTimes(2);
    });
  });
});
