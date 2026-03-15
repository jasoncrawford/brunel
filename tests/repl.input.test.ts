import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "stream";
import { ask } from "../src/input.js";

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
