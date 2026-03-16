import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "stream";
import { ask } from "../src/input.js";
import * as display from "../src/display.js";

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

beforeEach(() => {
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
  it("typing past terminal line boundary emits cursor-up to redraw from row 0", async () => {
    // cols=10, prompt="> " (2 chars), so 8 chars of input fills row 0
    // Visual positions: prompt(2) + 8 chars = col 0-9 (full row 0)
    // Typing the 9th char: prevCursor=8, prevRow=floor(10/10)=1 → need \x1b[1A
    setColumns(10);
    const writeSpy = vi.mocked(process.stdout.write);

    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
      stdin.push("12345678"); // fills row 0 (visual=10, row=1 for cursor at pos 8)
      stdin.push("9");        // goes to row 1; fullRedraw from prevCursor=8 → \x1b[1A
      stdin.push("\r");
      expect(await p).toBe("123456789");
    });

    expect(collectOutput(writeSpy)).toContain("\x1b[1A");
  });

  it("left arrow from start of row 1 to end of row 0 emits cursor-up", async () => {
    // cols=10, prompt="> " (2 chars), buffer="12345678" (visual=10, cursor at row 1)
    // Pressing left arrow: prevCursor=8 (row 1) → cursor=7 (row 0, col 9) → \x1b[1A
    setColumns(10);
    const writeSpy = vi.mocked(process.stdout.write);

    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
      stdin.push("12345678");  // cursor at 8, visual=10, prevRow=1 on next key
      writeSpy.mockClear();    // clear output from the inserts above
      stdin.push("\x1b[D");    // left arrow: prevCursor=8 (row 1) → cursor=7 (row 0)
      stdin.push("\r");
      expect(await p).toBe("12345678");
    });

    // fullRedraw called with prevCursor=8 (row 1) must emit \x1b[1A
    expect(collectOutput(writeSpy)).toContain("\x1b[1A");
  });

  it("buffer value is correct after inserting across line boundary", async () => {
    // Sanity check: editing across line boundaries yields correct buffer
    setColumns(10);

    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
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
      const p = ask("> ", () => []);
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
      const p = ask("> ", () => []);
      stdin.push("123456789"); // fill to row 1
      stdin.push("\x01");      // ^A → cursor=0, row 0
      writeSpy.mockClear();
      stdin.push("\x05");      // ^E → moveTo(9), row 1 → need \x1b[1B
      stdin.push("\r");
      expect(await p).toBe("123456789");
    });

    expect(collectOutput(writeSpy)).toContain("\x1b[1B");
  });
});

// ── Print callback (worker mode cursor fix) ────────────────────────────────────

describe("display.print() callback for ask() redraw", () => {
  it("setInputPrintCallback registers a callback called on display.print()", () => {
    const callback = vi.fn();
    display.setInputPrintCallback(callback);
    // Spy on console.log to prevent actual output
    vi.spyOn(console, "log").mockImplementation(() => {});
    display.print("test message");
    expect(callback).toHaveBeenCalled();
    display.setInputPrintCallback(null);
  });

  it("callback is not called after it is cleared", () => {
    const callback = vi.fn();
    display.setInputPrintCallback(callback);
    display.setInputPrintCallback(null);
    vi.spyOn(console, "log").mockImplementation(() => {});
    display.print("test message");
    expect(callback).not.toHaveBeenCalled();
  });

  it("ask() redraws prompt after display.print() during input", async () => {
    setColumns(80);
    const writeSpy = vi.mocked(process.stdout.write);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
      stdin.push("hello");
      writeSpy.mockClear();

      // Simulate display.print() being called while ask() is running
      display.print("  Connected to foreman.");

      // The prompt should be redrawn after print
      const output = collectOutput(writeSpy);
      // Should write the prompt again (either "> " or the buffer)
      expect(output).toMatch(/\r\n.*>/);

      stdin.push("\r");
      expect(await p).toBe("hello");
    });
  });
});
