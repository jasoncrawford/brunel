import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "stream";
import { ask, matchCommands, filterCommands, listCommandNames, listWorkerCommandNames, listCommands, parseFrontmatter, listSkillNames, type ListDir, type CommandSuggestion } from "../src/agent/input.js";

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

const cmds = (): CommandSuggestion[] => [
  { name: "brainstorm", description: "Brainstorm ideas" },
  { name: "clear",      description: "Clear conversation" },
  { name: "exit",       description: "Exit the REPL" },
];

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

// ── listSkillNames ────────────────────────────────────────────────────────────

describe("listSkillNames", () => {
  it("returns empty array when skills dir is missing and no plugins json", () => {
    expect(listSkillNames(() => null, () => null)).toEqual([]);
  });

  it("returns user skill names from ~/.claude/skills/", () => {
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("/.claude/skills")) {
        return [
          { name: "brainstorm", isDir: true },
          { name: "review", isDir: true },
        ];
      }
      return null;
    };
    const readFile = (path: string) => {
      if (path.endsWith("SKILL.md")) return "---\nname: skill\n---\n# Content";
      return null;
    };
    expect(listSkillNames(listDir, readFile)).toEqual(["brainstorm", "review"]);
  });

  it("excludes user skills with user-invocable: false", () => {
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("/.claude/skills")) {
        return [
          { name: "visible", isDir: true },
          { name: "hidden", isDir: true },
        ];
      }
      return null;
    };
    const readFile = (path: string) => {
      if (path.includes("/hidden/SKILL.md")) return "---\nuser-invocable: false\n---\n";
      if (path.endsWith("SKILL.md")) return "---\nname: skill\n---\n";
      return null;
    };
    expect(listSkillNames(listDir, readFile)).toEqual(["visible"]);
  });

  it("ignores non-directory entries in skills dir", () => {
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("/.claude/skills")) {
        return [
          { name: "myscill", isDir: true },
          { name: "README.md", isDir: false },
        ];
      }
      return null;
    };
    const readFile = () => "---\nname: x\n---\n";
    expect(listSkillNames(listDir, readFile)).toEqual(["myscill"]);
  });

  it("skips user skill dir with no SKILL.md", () => {
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("/.claude/skills")) return [{ name: "orphan", isDir: true }];
      return null;
    };
    expect(listSkillNames(listDir, () => null)).toEqual([]);
  });

  it("returns plugin skills with plugin:skill naming", () => {
    const home = process.env.HOME ?? "";
    const pluginsJson = JSON.stringify({
      plugins: {
        "myplugin@marketplace": [{ installPath: "/plugins/myplugin/1.0" }],
      },
    });
    const listDir: ListDir = (dir) => {
      if (dir === "/plugins/myplugin/1.0/skills") {
        return [{ name: "foo", isDir: true }];
      }
      return null;
    };
    const readFile = (path: string) => {
      if (path === `${home}/.claude/plugins/installed_plugins.json`) return pluginsJson;
      if (path.endsWith("SKILL.md")) return "---\nname: foo\n---\n";
      return null;
    };
    expect(listSkillNames(listDir, readFile)).toEqual(["myplugin:foo"]);
  });

  it("excludes plugin skills with user-invocable: false", () => {
    const home = process.env.HOME ?? "";
    const pluginsJson = JSON.stringify({
      plugins: {
        "myplugin@marketplace": [{ installPath: "/plugins/myplugin/1.0" }],
      },
    });
    const listDir: ListDir = (dir) => {
      if (dir === "/plugins/myplugin/1.0/skills") {
        return [{ name: "blocked", isDir: true }];
      }
      return null;
    };
    const readFile = (path: string) => {
      if (path === `${home}/.claude/plugins/installed_plugins.json`) return pluginsJson;
      if (path.endsWith("SKILL.md")) return "---\nuser-invocable: false\n---\n";
      return null;
    };
    expect(listSkillNames(listDir, readFile)).toEqual([]);
  });

  it("returns only user skills when installed_plugins.json is missing", () => {
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("/.claude/skills")) return [{ name: "local", isDir: true }];
      return null;
    };
    const readFile = (path: string) => {
      if (path.endsWith("SKILL.md")) return "---\nname: local\n---\n";
      return null; // installed_plugins.json missing
    };
    expect(listSkillNames(listDir, readFile)).toEqual(["local"]);
  });

  it("returns only user skills when installed_plugins.json is malformed JSON", () => {
    const home = process.env.HOME ?? "";
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("/.claude/skills")) return [{ name: "local", isDir: true }];
      return null;
    };
    const readFile = (path: string) => {
      if (path === `${home}/.claude/plugins/installed_plugins.json`) return "NOT_JSON{{{";
      if (path.endsWith("SKILL.md")) return "---\nname: local\n---\n";
      return null;
    };
    expect(listSkillNames(listDir, readFile)).toEqual(["local"]);
  });

  it("result is sorted alphabetically", () => {
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("/.claude/skills")) {
        return [{ name: "zebra", isDir: true }, { name: "alpha", isDir: true }];
      }
      return null;
    };
    const readFile = () => "---\nname: x\n---\n";
    const result = listSkillNames(listDir, readFile);
    expect(result).toEqual([...result].sort());
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

  it("is case-insensitive", () => {
    expect(matchCommands("EX", ["brainstorm", "clear", "exit"])).toEqual(["exit"]);
  });

  it("matches non-prefix substrings", () => {
    expect(matchCommands("xit", ["brainstorm", "clear", "exit"])).toEqual(["exit"]);
  });

  it("prefix matching includes exact matches", () => {
    expect(matchCommands("exit", ["brainstorm", "clear", "exit"])).toEqual(["exit"]);
  });

  it("handles empty command list", () => {
    expect(matchCommands("ex", [])).toEqual([]);
  });

  it("prefix matches come before non-prefix substring matches", () => {
    // "storm" is a prefix of "storm-abc" and a non-prefix substring of "brainstorm"
    expect(matchCommands("storm", ["brainstorm", "storm-abc"])).toEqual(["storm-abc", "brainstorm"]);
  });
});

// ── filterCommands ────────────────────────────────────────────────────────────

describe("filterCommands", () => {
  const suggestions: CommandSuggestion[] = [
    { name: "brainstorm",  description: "Brainstorm ideas" },
    { name: "clear",       description: "Clear conversation" },
    { name: "exit",        description: "Exit the REPL" },
    { name: "run-tests",   description: "Run the test suite" },
  ];

  it("empty query returns all commands in original order", () => {
    expect(filterCommands("", suggestions)).toEqual(suggestions);
  });

  it("prefix match of command name", () => {
    const result = filterCommands("ex", suggestions);
    expect(result.map(c => c.name)).toContain("exit");
  });

  it("non-prefix substring match of command name", () => {
    const result = filterCommands("xit", suggestions);
    expect(result.map(c => c.name)).toContain("exit");
  });

  it("matches description when name does not match", () => {
    const result = filterCommands("suite", suggestions);
    expect(result.map(c => c.name)).toContain("run-tests");
  });

  it("is case-insensitive for name matching", () => {
    const result = filterCommands("EX", suggestions);
    expect(result.map(c => c.name)).toContain("exit");
  });

  it("is case-insensitive for description matching", () => {
    const result = filterCommands("SUITE", suggestions);
    expect(result.map(c => c.name)).toContain("run-tests");
  });

  it("no matches returns empty array", () => {
    expect(filterCommands("zzz", suggestions)).toEqual([]);
  });

  it("sort order: prefix name matches before non-prefix name matches before description-only matches", () => {
    const cmds: CommandSuggestion[] = [
      { name: "test-suite",   description: "Run the suite"  },  // description matches "run", name doesn't
      { name: "run-tests",    description: "Execute suite"  },  // name prefix matches "run"
      { name: "dry-run",      description: "Preview only"   },  // name non-prefix substring matches "run"
    ];
    const result = filterCommands("run", cmds);
    const names = result.map(c => c.name);
    expect(names).toEqual(["run-tests", "dry-run", "test-suite"]);
  });

  it("handles empty command list", () => {
    expect(filterCommands("ex", [])).toEqual([]);
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
    expect(result).toEqual(["clear", "create-workspace", "effort", "exit", "model", "prune", "remove-workspace", "reset-workspace"]);
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

  it("includes skill names from listSkillNames", () => {
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("/.claude/skills")) return [{ name: "my-skill", isDir: true }];
      return null;
    };
    const readFile = (path: string) => {
      if (path.endsWith("SKILL.md")) return "---\nname: my-skill\n---\n";
      return null;
    };
    const result = listCommandNames(listDir, readFile);
    expect(result).toContain("my-skill");
  });

  it("does not include task-complete (worker-only command)", () => {
    const result = listCommandNames(() => null);
    expect(result).not.toContain("task-complete");
  });

  it("deduplicates when skill name matches a command name", () => {
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("commands")) return [{ name: "shared.md", isDir: false }];
      if (dir.endsWith("/.claude/skills")) return [{ name: "shared", isDir: true }];
      return null;
    };
    const readFile = (path: string) => {
      if (path.endsWith("SKILL.md")) return "---\nname: shared\n---\n";
      return null;
    };
    const result = listCommandNames(listDir, readFile);
    const shared = result.filter(c => c === "shared");
    expect(shared).toHaveLength(1);
  });
});

// ── listCommands ─────────────────────────────────────────────────────────────

describe("listCommands", () => {
  it("returns CommandSuggestion objects with name and description", () => {
    const result = listCommands(() => null);
    expect(result.length).toBeGreaterThan(0);
    for (const cmd of result) {
      expect(cmd).toHaveProperty("name");
      expect(cmd).toHaveProperty("description");
    }
  });

  it("builtins have non-empty descriptions", () => {
    const result = listCommands(() => null);
    const clear = result.find(c => c.name === "clear");
    expect(clear).toBeDefined();
    expect(clear!.description).toBeTruthy();
    const exit = result.find(c => c.name === "exit");
    expect(exit).toBeDefined();
    expect(exit!.description).toBeTruthy();
  });

  it("skill with description frontmatter uses that as description", () => {
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("/.claude/skills")) return [{ name: "my-skill", isDir: true }];
      return null;
    };
    const readFile = (path: string) => {
      if (path.endsWith("SKILL.md")) return "---\nname: my-skill\ndescription: Does a great thing\n---\n# Body\nSome content";
      return null;
    };
    const result = listCommands(listDir, readFile);
    const skill = result.find(c => c.name === "my-skill");
    expect(skill).toBeDefined();
    expect(skill!.description).toBe("Does a great thing");
  });

  it("skill without description falls back to first non-empty line of body", () => {
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("/.claude/skills")) return [{ name: "my-skill", isDir: true }];
      return null;
    };
    const readFile = (path: string) => {
      if (path.endsWith("SKILL.md")) return "---\nname: my-skill\n---\n# First line heading\nMore content";
      return null;
    };
    const result = listCommands(listDir, readFile);
    const skill = result.find(c => c.name === "my-skill");
    expect(skill).toBeDefined();
    expect(skill!.description).toBe("# First line heading");
  });

  it("command file with description frontmatter uses that", () => {
    const home = process.env.HOME ?? "";
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("commands")) return [{ name: "mycmd.md", isDir: false }];
      return null;
    };
    const readFile = (path: string) => {
      if (path === `${home}/.claude/commands/mycmd.md`) return "---\ndescription: My command description\n---\nDo something";
      return null;
    };
    const result = listCommands(listDir, readFile);
    const cmd = result.find(c => c.name === "mycmd");
    expect(cmd).toBeDefined();
    expect(cmd!.description).toBe("My command description");
  });

  it("command file without description uses first line", () => {
    const home = process.env.HOME ?? "";
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("commands")) return [{ name: "mycmd.md", isDir: false }];
      return null;
    };
    const readFile = (path: string) => {
      if (path === `${home}/.claude/commands/mycmd.md`) return "Do something useful\nMore text";
      return null;
    };
    const result = listCommands(listDir, readFile);
    const cmd = result.find(c => c.name === "mycmd");
    expect(cmd).toBeDefined();
    expect(cmd!.description).toBe("Do something useful");
  });

  it("result is sorted alphabetically by name", () => {
    const result = listCommands(() => null);
    const names = result.map(c => c.name);
    expect(names).toEqual([...names].sort());
  });
});

// ── listWorkerCommandNames ────────────────────────────────────────────────────

describe("listWorkerCommandNames", () => {
  it("includes task-complete", () => {
    const result = listWorkerCommandNames(() => null);
    expect(result).toContain("task-complete");
  });

  it("also includes clear and exit", () => {
    const result = listWorkerCommandNames(() => null);
    expect(result).toContain("clear");
    expect(result).toContain("exit");
  });

  it("result is sorted alphabetically", () => {
    const result = listWorkerCommandNames(() => null);
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

  it("Tab adds trailing space so arguments can be typed immediately", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/ex");
      stdin.push("\x09");   // Tab — completes to "/exit "
      stdin.push("arg1");   // type argument right away, no extra space needed
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/exit arg1");
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
      const p = ask("> ", () => [
        { name: "alpha", description: "" },
        { name: "beta",  description: "" },
        { name: "gamma", description: "" },
      ]);
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

  it("shows up to 5 suggestions (not more)", async () => {
    const sixCmds = (): CommandSuggestion[] => [
      { name: "alpha",   description: "d1" },
      { name: "bravo",   description: "d2" },
      { name: "charlie", description: "d3" },
      { name: "delta",   description: "d4" },
      { name: "echo",    description: "d5" },
      { name: "foxtrot", description: "d6" },
    ];
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", sixCmds);
      stdin.push("/");
      stdin.push("\r");
      await p;
      const allOutput = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0])).join("");
      // First 5 should appear, 6th should not
      expect(allOutput).toContain("alpha");
      expect(allOutput).toContain("echo");
      expect(allOutput).not.toContain("foxtrot");
    });
  });

  it("suggestions appear on separate lines (each on its own line)", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/");
      stdin.push("\r");
      await p;
      // Each suggestion after the first is written as its own stdout.write call
      // starting with \r\n\x1b[K (move to next line + clear it).
      const writeCalls = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0]));
      const clearLine = writeCalls.find(w => w.includes("/clear"));
      const exitLine  = writeCalls.find(w => w.includes("/exit"));
      expect(clearLine).toBeDefined();
      expect(exitLine).toBeDefined();
      expect(clearLine).toMatch(/^\r\n/);
      expect(exitLine).toMatch(/^\r\n/);
    });
  });

  it("descriptions appear in suggestion output", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/");
      stdin.push("\r");
      await p;
      const allOutput = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0])).join("");
      expect(allOutput).toContain("Brainstorm ideas");
      expect(allOutput).toContain("Clear conversation");
      expect(allOutput).toContain("Exit the REPL");
    });
  });

  it("descriptions are left-aligned (same column start)", async () => {
    const fixedCmds = (): CommandSuggestion[] => [
      { name: "short",     description: "Short desc" },
      { name: "muchlonger", description: "Long desc" },
    ];
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", fixedCmds);
      stdin.push("/");
      stdin.push("\r");
      await p;
      const allOutput = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0])).join("");
      // Strip ANSI codes for position analysis
      const stripped = allOutput.replace(/\x1b\[[0-9;]*m/g, "");
      const shortDescPos = stripped.indexOf("Short desc");
      const longDescPos = stripped.indexOf("Long desc");
      // Both descriptions should be at the same column offset from their command's "/":
      // find the column of each description on its line
      const lineContainingShort = stripped.slice(0, shortDescPos).lastIndexOf("\n");
      const lineContainingLong  = stripped.slice(0, longDescPos).lastIndexOf("\n");
      const shortCol = shortDescPos - lineContainingShort;
      const longCol  = longDescPos - lineContainingLong;
      expect(shortCol).toBe(longCol);
    });
  });
});

// ── Substring and description matching ────────────────────────────────────────

describe("ask() - substring and description autocomplete", () => {
  const extCmds = (): CommandSuggestion[] => [
    { name: "brainstorm",  description: "Brainstorm ideas" },
    { name: "clear",       description: "Clear conversation" },
    { name: "exit",        description: "Exit the REPL" },
    { name: "run-tests",   description: "Run the test suite" },
  ];

  it("non-prefix substring of command name triggers Tab completion", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", extCmds);
      stdin.push("/xit");   // non-prefix substring of "exit"
      stdin.push("\x09");   // Tab
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/exit");
    });
  });

  it("description substring shows matching command in suggestions", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", extCmds);
      stdin.push("/suite"); // matches "run-tests" description
      stdin.push("\r");     // Enter
      await p;
      const allOutput = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0])).join("");
      expect(allOutput).toContain("run-tests");
    });
  });

  it("description substring Enter-completes to matching command", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", extCmds);
      stdin.push("/suite"); // only matches "run-tests" via description
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/run-tests");
    });
  });

  it("matching is case-insensitive for command name", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", extCmds);
      stdin.push("/EXIT");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/exit");
    });
  });

  it("matching is case-insensitive for description", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", extCmds);
      stdin.push("/SUITE");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/run-tests");
    });
  });

  it("sort order: prefix name match comes before description-only match", async () => {
    const sortCmds = (): CommandSuggestion[] => [
      { name: "run-tests",  description: "Execute the suite"   },
      { name: "brainstorm", description: "Run ideas by the AI" },  // description matches "run"
    ];
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", sortCmds);
      stdin.push("/run");
      stdin.push("\r"); // Enter picks first match
      const result = await p;
      expect(result).toBe("/run-tests"); // prefix match before description match
    });
  });
});

// ── Arrow navigation in autocomplete ─────────────────────────────────────────

const DOWN = "\x1b[B";
const UP   = "\x1b[A";

describe("ask() - arrow navigation in autocomplete", () => {
  it("down arrow then Enter selects first suggestion", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/");
      stdin.push(DOWN);  // highlight first suggestion (brainstorm)
      stdin.push("\r");   // Enter selects it
      const result = await p;
      expect(result).toBe("/brainstorm");
    });
  });

  it("down arrow twice then Enter selects second suggestion", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/");
      stdin.push(DOWN);  // highlight brainstorm
      stdin.push(DOWN);  // highlight clear
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/clear");
    });
  });

  it("down arrow three times then Enter selects third suggestion", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/");
      stdin.push(DOWN);  // brainstorm
      stdin.push(DOWN);  // clear
      stdin.push(DOWN);  // exit
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/exit");
    });
  });

  it("down arrow past last suggestion wraps or clamps at last", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/");
      stdin.push(DOWN);  // brainstorm
      stdin.push(DOWN);  // clear
      stdin.push(DOWN);  // exit (last)
      stdin.push(DOWN);  // should stay at exit
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/exit");
    });
  });

  it("down then up arrow returns to unselected, Enter completes to first match", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/");
      stdin.push(DOWN);  // highlight brainstorm
      stdin.push(UP);    // back to unselected
      stdin.push("\r");   // Enter with no selection → completes to first match
      const result = await p;
      expect(result).toBe("/brainstorm");
    });
  });

  it("Tab with arrow-selected suggestion completes with trailing space", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/");
      stdin.push(DOWN);  // highlight brainstorm
      stdin.push(DOWN);  // highlight clear
      stdin.push("\x09"); // Tab — completes to "/clear "
      stdin.push("arg");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/clear arg");
    });
  });

  it("typing after arrow selection resets selection and updates buffer", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/");
      stdin.push(DOWN);  // highlight brainstorm
      stdin.push("e");   // type 'e' — resets selection, buffer becomes "/e"
      stdin.push("\r");   // Enter completes to first match of "/e" → exit
      const result = await p;
      expect(result).toBe("/exit");
    });
  });

  it("down arrow with no suggestions is a no-op", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("hello");  // no slash, no suggestions
      stdin.push(DOWN);
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hello");
    });
  });

  it("selected suggestion is rendered differently (not all darkGray)", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/");
      stdin.push(DOWN);  // highlight first suggestion
      stdin.push("\r");
      await p;
      const allOutput = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0])).join("");
      // The selected suggestion should have ▶ marker
      expect(allOutput).toContain("▶");
    });
  });

  it("arrow-selected Enter submits directly (does not just fill buffer)", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/");
      stdin.push(DOWN);  // highlight brainstorm
      stdin.push(DOWN);  // highlight clear
      stdin.push("\r");   // Enter submits /clear
      const result = await p;
      expect(result).toBe("/clear");
    });
  });
});

