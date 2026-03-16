import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "stream";
import { ask, matchCommands, listCommandNames, parseFrontmatter, type ListDir } from "../src/input.js";

// ── Test harness for ask() integration tests ──────────────────────────────────

function makeStdin() {
  const stream = new PassThrough();
  stream.setEncoding("utf8");
  (stream as any).setRawMode = vi.fn();
  return stream;
}

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

const cmds = () => ["brainstorm", "clear", "exit"];

// ── parseFrontmatter ──────────────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  it("returns empty object when no frontmatter", () => {
    expect(parseFrontmatter("# Just a heading\nNo frontmatter here.")).toEqual({});
  });

  it("parses key: value pairs from frontmatter block", () => {
    const content = `---\nname: my-skill\ndescription: Does a thing\n---\n\n# Body`;
    expect(parseFrontmatter(content)).toEqual({ name: "my-skill", description: "Does a thing" });
  });

  it("returns false-y user-invocable when set to false", () => {
    const content = `---\nname: foo\nuser-invocable: false\n---\n`;
    const fm = parseFrontmatter(content);
    expect(fm["user-invocable"]).toBe("false");
  });

  it("silently skips non key:value lines inside frontmatter", () => {
    const content = `---\nname: my-skill\nnot a kv line\ndescription: ok\n---\n`;
    expect(parseFrontmatter(content)).toEqual({ name: "my-skill", description: "ok" });
  });

  it("returns empty object for empty string", () => {
    expect(parseFrontmatter("")).toEqual({});
  });
});

// ── matchCommands ─────────────────────────────────────────────────────────────

describe("matchCommands", () => {
  it("filters commands by prefix", () => {
    expect(matchCommands("ex", ["brainstorm", "clear", "exit"])).toEqual(["exit"]);
  });

  it("empty prefix returns all commands", () => {
    expect(matchCommands("", ["brainstorm", "clear", "exit"])).toEqual(["brainstorm", "clear", "exit"]);
  });

  it("no matches returns empty array", () => {
    expect(matchCommands("zzz", ["brainstorm", "clear", "exit"])).toEqual([]);
  });

  it("is case-sensitive", () => {
    expect(matchCommands("Ex", ["brainstorm", "clear", "exit"])).toEqual([]);
  });

  it("prefix matching includes exact matches", () => {
    expect(matchCommands("exit", ["brainstorm", "clear", "exit"])).toEqual(["exit"]);
  });

  it("handles empty command list", () => {
    expect(matchCommands("ex", [])).toEqual([]);
  });
});

// ── listCommandNames ──────────────────────────────────────────────────────────

describe("listCommandNames", () => {
  it("always includes builtins clear and exit", () => {
    const result = listCommandNames(() => null);
    expect(result).toContain("clear");
    expect(result).toContain("exit");
  });

  it("returns only builtins when directory is missing", () => {
    const result = listCommandNames(() => null);
    expect(result).toEqual(["clear", "exit"]);
  });

  it("includes a file at root level", () => {
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("commands")) return [{ name: "brainstorm.md", isDir: false }];
      return null;
    };
    const result = listCommandNames(listDir);
    expect(result).toContain("brainstorm");
  });

  it("converts subdirectory file to colon-separated name", () => {
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("commands")) return [{ name: "foo", isDir: true }];
      if (dir.endsWith("/foo")) return [{ name: "bar.md", isDir: false }];
      return null;
    };
    const result = listCommandNames(listDir);
    expect(result).toContain("foo:bar");
  });

  it("handles three levels of nesting", () => {
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("commands")) return [{ name: "a", isDir: true }];
      if (dir.endsWith("/a")) return [{ name: "b", isDir: true }];
      if (dir.endsWith("/b")) return [{ name: "c.md", isDir: false }];
      return null;
    };
    const result = listCommandNames(listDir);
    expect(result).toContain("a:b:c");
  });

  it("deduplicates when a file name matches a builtin", () => {
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("commands")) return [{ name: "clear.md", isDir: false }];
      return null;
    };
    const result = listCommandNames(listDir);
    const clears = result.filter(c => c === "clear");
    expect(clears).toHaveLength(1);
  });

  it("ignores non-.md files", () => {
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("commands")) return [
        { name: "notes.txt", isDir: false },
        { name: "script.sh", isDir: false },
        { name: "valid.md", isDir: false },
      ];
      return null;
    };
    const result = listCommandNames(listDir);
    expect(result).not.toContain("notes");
    expect(result).not.toContain("script");
    expect(result).toContain("valid");
  });

  it("result is sorted alphabetically", () => {
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("commands")) return [
        { name: "zebra.md", isDir: false },
        { name: "alpha.md", isDir: false },
      ];
      return null;
    };
    const result = listCommandNames(listDir);
    expect(result).toEqual([...result].sort());
  });
});

// ── Tab completion ────────────────────────────────────────────────────────────

describe("ask() - Tab completion", () => {
  it("Tab with no match is a no-op", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/zzz");
      stdin.push("\x09"); // Tab
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/zzz");
    });
  });

  it("Tab with one match completes buffer", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/ex");
      stdin.push("\x09"); // Tab
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/exit");
    });
  });

  it("Tab with multiple matches completes to first (alphabetical)", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/");
      stdin.push("\x09"); // Tab — "brainstorm" is first alphabetically
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/brainstorm");
    });
  });

  it("Tab on non-slash input is a no-op", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("hello");
      stdin.push("\x09"); // Tab
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hello");
    });
  });

  it("Tab with cursor not at end completes and moves cursor to end", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/ex");
      stdin.push("\x1b[D"); // left arrow (cursor now at position 2)
      stdin.push("\x09");   // Tab
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/exit");
    });
  });
});

// ── Enter completion ──────────────────────────────────────────────────────────

describe("ask() - Enter completion", () => {
  it("Enter with one match completes and submits", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/ex");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/exit");
    });
  });

  it("Enter with no match (slash prefix) submits as-is", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/zzz");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/zzz");
    });
  });

  it("Enter on non-slash input submits as-is (no completion)", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("hello world");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hello world");
    });
  });

  it("Enter with space after command does not complete (no suggestions)", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/exit foo");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/exit foo");
    });
  });

  it("\\n also triggers Enter completion", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/ex");
      stdin.push("\n");
      const result = await p;
      expect(result).toBe("/exit");
    });
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("ask() - autocomplete edge cases", () => {
  it("bare / shows all commands and Enter picks first", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => ["alpha", "beta", "gamma"]);
      stdin.push("/");
      stdin.push("\r"); // Enter completes with first match
      const result = await p;
      expect(result).toBe("/alpha");
    });
  });

  it("^K leaving / in buffer; Tab completes from all commands", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/exit");
      stdin.push("\x01");    // ^A → start of buffer
      stdin.push("\x1b[C"); // right arrow → position 1 (after /)
      stdin.push("\x0b");   // ^K → kill "exit"; buffer is now "/"
      stdin.push("\x09");   // Tab → should complete to first command "brainstorm"
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/brainstorm");
    });
  });

  it("submit without ever showing suggestions (clearSuggestions guard)", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
      stdin.push("hello");
      stdin.push("\r");
      const result = await p;
      // Just verifies no crash; clearSuggestions guard prevents spurious escapes
      expect(result).toBe("hello");
    });
  });

  it("pasted slash prefix triggers Tab completion", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("\x1b[200~/ex\x1b[201~"); // paste "/ex"
      stdin.push("\x09"); // Tab → should complete to "/exit"
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/exit");
    });
  });

  it("paste of non-slash text into non-slash buffer: no suggestions", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("ab");
      stdin.push("\x1b[D"); // left
      stdin.push("\x1b[200~hello\x1b[201~"); // paste "hello" mid-buffer
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("ahellob");
    });
  });

  it("typing / writes suggestion content to stdout", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/");
      stdin.push("\r"); // submit to resolve the promise
      await p;
      // All stdout writes captured by mock; verify suggestion text was written at some point
      const allOutput = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0])).join("");
      expect(allOutput).toContain("brainstorm");
      expect(allOutput).toContain("clear");
      expect(allOutput).toContain("exit");
    });
  });

  it("typing /ex narrows suggestion to only /exit", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/ex");
      stdin.push("\r"); // submit (also completes to /exit)
      await p;
      const allOutput = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0])).join("");
      // "exit" should appear in output; the suggestion line should have shown /exit
      expect(allOutput).toContain("/exit");
    });
  });

  it("space after /ex hides suggestion content; second space draws no suggestion text", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/ex");
      vi.mocked(process.stdout.write).mockClear();
      stdin.push(" ");
      // After the space, refreshSuggestions runs with no matches — suggestion text gone
      const afterSpace = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0]));
      vi.mocked(process.stdout.write).mockClear();
      stdin.push(" "); // second space — still no suggestions
      const afterSecondSpace = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0]));
      stdin.push("\r");
      await p;
      // No suggestion content (brainstorm/clear/exit) after first space
      const hasSuggestionAfterSpace = afterSpace.some(s =>
        s.includes("brainstorm") || s.includes("clear") || s.includes("exit")
      );
      expect(hasSuggestionAfterSpace).toBe(false);
      // No suggestion content after second space either
      const hasSuggestionAfterSecondSpace = afterSecondSpace.some(s =>
        s.includes("brainstorm") || s.includes("clear") || s.includes("exit")
      );
      expect(hasSuggestionAfterSecondSpace).toBe(false);
    });
  });

  it("^U kill then non-slash char: suggestions do not appear", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/exit");
      stdin.push("\x15"); // ^U — kill to start; buffer is now ""
      vi.mocked(process.stdout.write).mockClear();
      stdin.push("h");   // non-slash char; computeMatches should return []
      const afterH = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0]));
      stdin.push("\r");
      await p;
      // No suggestion content should have been drawn after typing "h"
      const hasSuggestionContent = afterH.some(s =>
        s.includes("brainstorm") || s.includes("clear") || s.includes("exit")
      );
      expect(hasSuggestionContent).toBe(false);
    });
  });

  it("Enter on empty input submits empty string (clearSuggestions guard fires silently)", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("");
    });
  });
});

