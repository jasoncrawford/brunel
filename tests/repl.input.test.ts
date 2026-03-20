import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "stream";
import { ask, pick, pickMultiple, promptLine, pickQuestion } from "../src/input.js";
import type { PickQuestionResult } from "../src/input.js";
import * as display from "../src/display.js";

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

beforeEach(() => {
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
      const p = ask("> ", () => []);
      stdin.push("hello");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hello");
    });
  });

  it("leading/trailing whitespace trimmed", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
      stdin.push("  hi  ");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hi");
    });
  });

  it("empty Enter → resolves to ''", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("");
    });
  });
});

describe("ask() - cursor movement", () => {
  it("^A moves cursor to 0", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
      stdin.push("hello");
      stdin.push("\x01"); // ^A
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hello");
    });
  });

  it("^E moves cursor to end", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
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
      const p = ask("> ", () => []);
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
      const p = ask("> ", () => []);
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
      const p = ask("> ", () => []);
      stdin.push("\x1b[D"); // left at start
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("");
    });
  });

  it("right arrow at end: no crash", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
      stdin.push("hi");
      stdin.push("\x1b[C"); // right at end
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hi");
    });
  });

  it("iTerm2 option+left: word jump left", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
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
      const p = ask("> ", () => []);
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
      const p = ask("> ", () => []);
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
      const p = ask("> ", () => []);
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
      const p = ask("> ", () => []);
      stdin.push("hello");
      stdin.push("\x7f"); // backspace
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hell");
    });
  });

  it("backspace at cursor=0: no crash, no change", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
      stdin.push("\x7f"); // backspace at start
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("");
    });
  });

  it("^K kills from cursor to end", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
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
      const p = ask("> ", () => []);
      stdin.push("hello");
      stdin.push("\x15"); // ^U → kill all
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("");
    });
  });

  it("^W deletes word before cursor", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
      stdin.push("foo bar");
      stdin.push("\x17"); // ^W → deletes "bar"
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("foo"); // ask() trims; "foo " → "foo"
    });
  });
});

describe("ask() - character insertion", () => {
  it("printable chars inserted at cursor position", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
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
      const p = ask("> ", () => []);
      stdin.push("hi");
      stdin.push("\x02"); // ^B — not handled, should be ignored
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hi");
    });
  });
});

describe("ask() - exit conditions", () => {
  it("^D on non-empty buffer → no-op (does not exit)", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
      stdin.push("hello");
      stdin.push("\x04"); // ^D on non-empty → no-op
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hello");
    });
  });

  it("^C → calls process.exit(0)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
      stdin.push("\x03"); // ^C
      // p will never resolve (exit is called), but we can check the spy
      await new Promise(r => setTimeout(r, 10));
      expect(exitSpy).toHaveBeenCalledWith(0);
      // Clean up the dangling promise by triggering submit
      stdin.push("\r");
      await p.catch(() => {});
    });
    exitSpy.mockRestore();
  });

  it("^D on empty buffer → calls process.exit(0)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
      stdin.push("\x04"); // ^D on empty
      await new Promise(r => setTimeout(r, 10));
      expect(exitSpy).toHaveBeenCalledWith(0);
      stdin.push("\r");
      await p.catch(() => {});
    });
    exitSpy.mockRestore();
  });
});

describe("ask() - bracketed paste", () => {
  it("complete paste sequence in one chunk → inserts content", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
      stdin.push("\x1b[200~hello world\x1b[201~");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hello world");
    });
  });

  it("paste start/end split across chunks", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
      stdin.push("\x1b[200~hello ");
      stdin.push("world\x1b[201~");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hello world");
    });
  });

  it("\\r\\n inside paste normalized to \\n", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
      stdin.push("\x1b[200~line1\r\nline2\x1b[201~");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("line1\nline2");
    });
  });

  it("paste inserted at cursor (not at end)", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
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
      const p = ask("> ", () => []);
      // Paste with embedded newline — should not submit mid-paste
      stdin.push("\x1b[200~line1\nline2\x1b[201~");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("line1\nline2");
    });
  });
});

describe("ask() - abort parameter", () => {
  it("resolves with abort value when abort promise fires first", async () => {
    await withFakeStdin(async () => {
      let resolveAbort!: (v: string) => void;
      const abort = new Promise<string>((r) => { resolveAbort = r; });
      const result = ask("> ", undefined, abort);
      // Fire abort before any stdin input
      resolveAbort("__abort__");
      expect(await result).toBe("__abort__");
    });
  });
});

describe("ask() - word movement detail", () => {
  it("moveWordLeft: 'foo bar|' → 'foo |bar'", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
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
      const p = ask("> ", () => []);
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
      const p = ask("> ", () => []);
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
      const p = ask("> ", () => []);
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
      const p = ask("> ", () => []);

      // Simulate display.print() being called (e.g., an event notification arriving)
      display.print("Event received: some_event");

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

describe("promptLine()", () => {
  it("resolves with typed text on Enter", async () => {
    await withFakeStdin(async (stdin) => {
      const p = promptLine("Enter: ");
      stdin.push("hello\r");
      expect(await p).toBe("hello");
    });
  });

  it("supports backspace", async () => {
    await withFakeStdin(async (stdin) => {
      const p = promptLine("Enter: ");
      stdin.push("hellp\x7fo\r"); // type "hellp", backspace → "hell", type "o" → "hello"
      expect(await p).toBe("hello");
    });
  });

  it("returns empty string for bare Enter", async () => {
    await withFakeStdin(async (stdin) => {
      const p = promptLine("Enter: ");
      stdin.push("\r");
      expect(await p).toBe("");
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
      const p = pickQuestion(opts);
      stdin.push("\r");
      const result = await p;
      expect(result).toEqual({ type: "answer", value: "Blue" });
    });
  });

  it("down arrow then Enter returns second option", async () => {
    await withFakeStdin(async (stdin) => {
      const p = pickQuestion(opts);
      stdin.push("\x1b[B\r");
      const result = await p;
      expect(result).toEqual({ type: "answer", value: "Red" });
    });
  });

  it("digit key jumps to that 1-based index", async () => {
    await withFakeStdin(async (stdin) => {
      const p = pickQuestion(opts);
      stdin.push("3\r");
      const result = await p;
      expect(result).toEqual({ type: "answer", value: "Green" });
    });
  });

  it("digit out of range is a no-op, cursor stays at 0", async () => {
    await withFakeStdin(async (stdin) => {
      const p = pickQuestion(opts);
      stdin.push("9\r"); // 5 total options; 9 is out of range
      const result = await p;
      expect(result).toEqual({ type: "answer", value: "Blue" });
    });
  });

  it("navigating to Other: activates text entry; type then Enter returns {type:other}", async () => {
    await withFakeStdin(async (stdin) => {
      const p = pickQuestion(opts);
      // Navigate to Other: (textMode activates), then type, then Enter — only one Enter
      stdin.push("\x1b[B\x1b[B\x1b[B");
      stdin.push("purple\r");
      const result = await p;
      expect(result).toEqual({ type: "other", text: "purple" });
    });
  });

  it("Enter on Other: with no text returns {type:other} with empty string", async () => {
    await withFakeStdin(async (stdin) => {
      const p = pickQuestion(opts);
      stdin.push("\x1b[B\x1b[B\x1b[B\r"); // navigate to Other: then Enter immediately
      const result = await p;
      expect(result).toEqual({ type: "other", text: "" });
    });
  });

  it("navigating to Let's discuss and Enter returns {type:discuss}", async () => {
    await withFakeStdin(async (stdin) => {
      const p = pickQuestion(opts);
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
      const p = pickQuestion(opts);
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
      const p = pick(["Alpha", "Beta", "Gamma"]);
      stdin.push("\r");
      const result = await p;
      expect(result).toBe(0);
    });
  });

  it("down arrow once, then Enter → selects index 1", async () => {
    await withFakeStdin(async (stdin) => {
      const p = pick(["Alpha", "Beta", "Gamma"]);
      stdin.push("\x1b[B"); // down
      stdin.push("\r");
      const result = await p;
      expect(result).toBe(1);
    });
  });

  it("down arrow twice, then Enter → selects index 2", async () => {
    await withFakeStdin(async (stdin) => {
      const p = pick(["Alpha", "Beta", "Gamma"]);
      stdin.push("\x1b[B");
      stdin.push("\x1b[B");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe(2);
    });
  });

  it("down past last option wraps to index 0", async () => {
    await withFakeStdin(async (stdin) => {
      const p = pick(["A", "B"]);
      stdin.push("\x1b[B"); // → 1
      stdin.push("\x1b[B"); // → wraps to 0
      stdin.push("\r");
      const result = await p;
      expect(result).toBe(0);
    });
  });

  it("up arrow from index 0 wraps to last", async () => {
    await withFakeStdin(async (stdin) => {
      const p = pick(["A", "B", "C"]);
      stdin.push("\x1b[A"); // up from 0 → wraps to 2
      stdin.push("\r");
      const result = await p;
      expect(result).toBe(2);
    });
  });

  it("up then down then Enter → back to index 0", async () => {
    await withFakeStdin(async (stdin) => {
      const p = pick(["A", "B"]);
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
      const p = pick(["Foo", "Bar"]);
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
      const p = pickMultiple(["A", "B", "C"]);
      stdin.push("\r");
      const result = await p;
      expect(result).toEqual([]);
    });
  });

  it("space on first option then Enter → returns [0]", async () => {
    await withFakeStdin(async (stdin) => {
      const p = pickMultiple(["A", "B", "C"]);
      stdin.push(" "); // toggle A
      stdin.push("\r");
      const result = await p;
      expect(result).toEqual([0]);
    });
  });

  it("space toggles on and off", async () => {
    await withFakeStdin(async (stdin) => {
      const p = pickMultiple(["A", "B"]);
      stdin.push(" "); // select A
      stdin.push(" "); // deselect A
      stdin.push("\r");
      const result = await p;
      expect(result).toEqual([]);
    });
  });

  it("navigate down and select multiple", async () => {
    await withFakeStdin(async (stdin) => {
      const p = pickMultiple(["A", "B", "C"]);
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
      const p = pickMultiple(["A", "B", "C"]);
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
