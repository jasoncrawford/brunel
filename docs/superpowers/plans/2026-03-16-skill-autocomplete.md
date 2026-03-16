# Skill Autocomplete & Execution Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the brunel REPL to autocomplete and execute user-invokable skills as slash commands, alongside existing builtin and custom commands.

**Architecture:** Add `parseFrontmatter` and `applyArguments` as shared utilities; add `listSkillNames` to discover skills from `~/.claude/skills/` and installed plugins; extend `listCommandNames` to merge skill names; replace `loadCommandFile` with `resolveContent` that searches commands then skills; update `dispatchInput` to use the new unified resolver.

**Tech Stack:** TypeScript/ESM, `tsx`, `vitest`, Node.js `fs` (all I/O injectable for testing)

**Spec:** `docs/superpowers/specs/2026-03-16-skill-autocomplete-design.md`

---

## Chunk 1: Branch setup + utility functions (`parseFrontmatter`, `applyArguments`)

### Task 1: Create feature branch and worktree

**Files:**
- No file changes

- [ ] **Step 1: Pull latest main and create branch**

```bash
git fetch origin && git pull origin main
git checkout -b issue-67-skill-autocomplete
```

Expected: branch created off latest main.

---

### Task 2: `parseFrontmatter`

**Files:**
- Modify: `src/input.ts` (add function after existing imports/types)
- Modify: `tests/repl.autocomplete.test.ts` (add new describe block)

- [ ] **Step 1: Write failing tests**

Add to `tests/repl.autocomplete.test.ts` (before existing `matchCommands` describe block, add import of `parseFrontmatter`):

```typescript
import { ask, matchCommands, listCommandNames, parseFrontmatter, type ListDir } from "../src/input.js";
```

(`listSkillNames` will be added to this import in Task 4.)

Then add a new `describe` block after the existing imports/setup:

```typescript
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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /workspace && npm test -- --reporter=verbose tests/repl.autocomplete.test.ts 2>&1 | tail -20
```

Expected: fail with `parseFrontmatter is not exported` or similar import error.

- [ ] **Step 3: Implement `parseFrontmatter` in `src/input.ts`**

Add after the existing imports, before `// ── Slash commands ──`:

```typescript
// ── Frontmatter parsing ────────────────────────────────────────────────────────

/**
 * Parse a YAML frontmatter block (---...---) at the top of a string.
 * Returns key/value pairs as strings. Non-matching lines are silently skipped.
 * Returns {} if no frontmatter block is present.
 */
export function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) result[m[1].trim()] = m[2].trim();
  }
  return result;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /workspace && npm test -- --reporter=verbose tests/repl.autocomplete.test.ts 2>&1 | tail -20
```

Expected: all `parseFrontmatter` tests pass (other tests in file also pass).

- [ ] **Step 5: Commit**

```bash
git add src/input.ts tests/repl.autocomplete.test.ts
git commit -m "feat: add parseFrontmatter utility"
```

---

### Task 3: `applyArguments`

**Files:**
- Modify: `src/input.ts` (add function in dispatch section)
- Modify: `tests/repl.dispatch.test.ts` (add describe block; update existing arg test)

- [ ] **Step 1: Write failing tests and update existing test**

Update the import in `tests/repl.dispatch.test.ts`:

```typescript
import { dispatchInput, applyArguments, resolveContent } from "../src/input.js";
```

Update the existing arg-appending test (line ~36) to the new format:

```typescript
  it("/command with extra args appends args to prompt", async () => {
    const result = await dispatchInput("/mycommand some extra args", (_path) => "Base prompt.");
    expect(result).toEqual({ type: "query", prompt: "Base prompt.\nARGUMENTS: some extra args" });
  });
```

Add a new describe block before the existing `describe("dispatchInput", ...)`:

```typescript
// ── applyArguments ────────────────────────────────────────────────────────────

describe("applyArguments", () => {
  it("replaces $ARGUMENTS with args when present", () => {
    expect(applyArguments("Do $ARGUMENTS now.", "the thing")).toBe("Do the thing now.");
  });

  it("replaces $ARGUMENTS with empty string when args is empty", () => {
    expect(applyArguments("Do $ARGUMENTS now.", "")).toBe("Do  now.");
  });

  it("replaces multiple $ARGUMENTS occurrences", () => {
    expect(applyArguments("$ARGUMENTS and $ARGUMENTS", "x")).toBe("x and x");
  });

  it("appends ARGUMENTS: <args> when no $ARGUMENTS and args non-empty", () => {
    expect(applyArguments("Base prompt.", "extra stuff")).toBe("Base prompt.\nARGUMENTS: extra stuff");
  });

  it("returns content unchanged when no $ARGUMENTS and args is empty", () => {
    expect(applyArguments("Base prompt.", "")).toBe("Base prompt.");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /workspace && npm test -- --reporter=verbose tests/repl.dispatch.test.ts 2>&1 | tail -20
```

Expected: fail — `applyArguments` not exported, and the updated arg test fails.

- [ ] **Step 3: Implement `applyArguments` in `src/input.ts`**

Add after `parseFrontmatter`, before `// ── Slash commands ──`:

```typescript
// ── Argument application ──────────────────────────────────────────────────────

/**
 * Apply args to a loaded command/skill content string.
 * If content contains $ARGUMENTS, all occurrences are replaced with args (even if empty).
 * Otherwise, if args is non-empty, appends "\nARGUMENTS: <args>".
 * Otherwise returns content unchanged.
 */
export function applyArguments(content: string, args: string): string {
  if (content.includes("$ARGUMENTS")) {
    return content.replaceAll("$ARGUMENTS", args);
  }
  if (args) {
    return `${content}\nARGUMENTS: ${args}`;
  }
  return content;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /workspace && npm test -- --reporter=verbose tests/repl.dispatch.test.ts 2>&1 | tail -20
```

Expected: all `applyArguments` tests pass. The updated arg-appending test now fails because `dispatchInput` still uses the old logic — that is expected and will be fixed in Task 7.

- [ ] **Step 5: Commit**

```bash
git add src/input.ts tests/repl.dispatch.test.ts
git commit -m "feat: add applyArguments utility; update arg-appending test for new format"
```

---

## Chunk 2: Skill discovery (`listSkillNames`, extend `listCommandNames`)

### Task 4: `listSkillNames`

**Files:**
- Modify: `src/input.ts` (add function in autocomplete section)
- Modify: `tests/repl.autocomplete.test.ts` (add describe block)

- [ ] **Step 1: Write failing tests**

First expand the import in `tests/repl.autocomplete.test.ts` to include `listSkillNames`:

```typescript
import { ask, matchCommands, listCommandNames, parseFrontmatter, listSkillNames, type ListDir } from "../src/input.js";
```

Add a new describe block after `parseFrontmatter` tests:

```typescript
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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /workspace && npm test -- --reporter=verbose tests/repl.autocomplete.test.ts 2>&1 | tail -20
```

Expected: fail — `listSkillNames` not exported.

- [ ] **Step 3: Implement `listSkillNames` in `src/input.ts`**

Add after `listCommandNames` (in the `// ── Autocomplete ──` section), before `// ── Raw input ──`:

```typescript
/**
 * Return all available skill names: user skills from ~/.claude/skills/ plus
 * plugin skills from installed_plugins.json.
 * Skills with `user-invocable: false` in their SKILL.md frontmatter are excluded.
 * Plugin skills are named "<plugin>:<skill>".
 * Both listDir and readFile are injectable for testing.
 */
export function listSkillNames(
  listDir: ListDir = defaultListDir,
  readFile: (path: string) => string | null = defaultReadFile,
): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const results: string[] = [];

  // Plugin skills
  const pluginsJson = readFile(`${home}/.claude/plugins/installed_plugins.json`);
  if (pluginsJson) {
    try {
      const parsed = JSON.parse(pluginsJson) as {
        plugins: Record<string, Array<{ installPath: string }>>;
      };
      for (const [key, entries] of Object.entries(parsed.plugins ?? {})) {
        const pluginName = key.split("@")[0];
        for (const entry of entries) {
          const skillsDir = `${entry.installPath}/skills`;
          const skillDirs = listDir(skillsDir);
          if (!skillDirs) continue;
          for (const dir of skillDirs) {
            if (!dir.isDir) continue;
            const skillMd = readFile(`${skillsDir}/${dir.name}/SKILL.md`);
            if (!skillMd) continue;
            const fm = parseFrontmatter(skillMd);
            if (fm["user-invocable"] === "false") continue;
            results.push(`${pluginName}:${dir.name}`);
          }
        }
      }
    } catch {
      // malformed JSON — skip plugin skills
    }
  }

  // User skills
  const userSkillsDir = `${home}/.claude/skills`;
  const userSkillDirs = listDir(userSkillsDir);
  if (userSkillDirs) {
    for (const dir of userSkillDirs) {
      if (!dir.isDir) continue;
      const skillMd = readFile(`${userSkillsDir}/${dir.name}/SKILL.md`);
      if (!skillMd) continue;
      const fm = parseFrontmatter(skillMd);
      if (fm["user-invocable"] === "false") continue;
      results.push(dir.name);
    }
  }

  return [...new Set(results)].sort();
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /workspace && npm test -- --reporter=verbose tests/repl.autocomplete.test.ts 2>&1 | tail -30
```

Expected: all `listSkillNames` tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/input.ts tests/repl.autocomplete.test.ts
git commit -m "feat: add listSkillNames for skill discovery"
```

---

### Task 5: Extend `listCommandNames` with skill names

**Files:**
- Modify: `src/input.ts` (update `listCommandNames` signature and body)
- Modify: `tests/repl.autocomplete.test.ts` (add tests for skill merging)

- [ ] **Step 1: Write failing tests**

Add to the existing `describe("listCommandNames", ...)` block in `tests/repl.autocomplete.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /workspace && npm test -- --reporter=verbose tests/repl.autocomplete.test.ts 2>&1 | tail -20
```

Expected: fail — `listCommandNames` currently only accepts one argument; the new tests pass `readFile` as a second arg and expect skill names to be included.

- [ ] **Step 3: Update `listCommandNames` in `src/input.ts`**

Change the existing `listCommandNames` function signature and body:

Old signature:
```typescript
export function listCommandNames(listDir: ListDir = defaultListDir): string[] {
  const builtins = ["clear", "exit"];
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const commandsDir = `${home}/.claude/commands`;
  const fileCommands = walkDir(commandsDir, "", listDir);
  return [...new Set([...builtins, ...fileCommands])].sort();
}
```

New signature:
```typescript
export function listCommandNames(
  listDir: ListDir = defaultListDir,
  readFile: (path: string) => string | null = defaultReadFile,
): string[] {
  const builtins = ["clear", "exit"];
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const commandsDir = `${home}/.claude/commands`;
  const fileCommands = walkDir(commandsDir, "", listDir);
  const skillNames = listSkillNames(listDir, readFile);
  return [...new Set([...builtins, ...fileCommands, ...skillNames])].sort();
}
```

- [ ] **Step 4: Run all autocomplete tests to confirm they pass**

```bash
cd /workspace && npm test -- --reporter=verbose tests/repl.autocomplete.test.ts 2>&1 | tail -30
```

Expected: all tests pass, including new skill-merging tests.

- [ ] **Step 5: Commit**

```bash
git add src/input.ts tests/repl.autocomplete.test.ts
git commit -m "feat: extend listCommandNames to include skill names"
```

---

## Chunk 3: Skill execution (`resolveContent`, update `dispatchInput`, cleanup)

### Task 6: `resolveContent`

**Files:**
- Modify: `src/input.ts` (add function, replacing role of `loadCommandFile`)
- Modify: `tests/repl.dispatch.test.ts` (add describe block)

- [ ] **Step 1: Write failing tests**

Confirm the import in `tests/repl.dispatch.test.ts` already includes `resolveContent` (added in Task 3). If not, ensure it reads:

```typescript
import { dispatchInput, applyArguments, resolveContent } from "../src/input.js";
```

Add a new describe block before `describe("dispatchInput", ...)`:

```typescript
// ── resolveContent ────────────────────────────────────────────────────────────

describe("resolveContent", () => {
  it("returns command file content when command file exists", () => {
    const readFile = (_path: string) => "Command content.";
    expect(resolveContent("mycommand", readFile)).toBe("Command content.");
  });

  it("returns null when nothing resolves", () => {
    expect(resolveContent("nope", () => null)).toBeNull();
  });

  it("tries user skill path when command file is missing", () => {
    const home = process.env.HOME ?? "";
    const readFile = (path: string) => {
      if (path === `${home}/.claude/skills/my-skill/SKILL.md`) return "Skill content.";
      return null;
    };
    expect(resolveContent("my-skill", readFile)).toBe("Skill content.");
  });

  it("tries plugin skill when command is plugin:skill format", () => {
    const home = process.env.HOME ?? "";
    const pluginsJson = JSON.stringify({
      plugins: {
        "myplugin@marketplace": [{ installPath: "/plugins/myplugin/1.0" }],
      },
    });
    const readFile = (path: string) => {
      if (path === `${home}/.claude/plugins/installed_plugins.json`) return pluginsJson;
      if (path === "/plugins/myplugin/1.0/skills/foo/SKILL.md") return "Plugin skill content.";
      return null;
    };
    expect(resolveContent("myplugin:foo", readFile)).toBe("Plugin skill content.");
  });

  it("returns null for plugin:skill when installed_plugins.json is malformed", () => {
    const home = process.env.HOME ?? "";
    const readFile = (path: string) => {
      if (path === `${home}/.claude/plugins/installed_plugins.json`) return "INVALID_JSON{";
      return null;
    };
    expect(resolveContent("myplugin:foo", readFile)).toBeNull();
  });

  it("command file wins over same-named user skill", () => {
    const home = process.env.HOME ?? "";
    const readFile = (path: string) => {
      if (path.includes("/.claude/commands/")) return "Command wins.";
      if (path === `${home}/.claude/skills/foo/SKILL.md`) return "Skill content.";
      return null;
    };
    expect(resolveContent("foo", readFile)).toBe("Command wins.");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /workspace && npm test -- --reporter=verbose tests/repl.dispatch.test.ts 2>&1 | tail -20
```

Expected: fail — `resolveContent` not exported.

- [ ] **Step 3: Implement `resolveContent` in `src/input.ts`**

Add after `loadCommandFile` (in `// ── Slash commands ──` section):

```typescript
/**
 * Resolve the raw content for a command name by trying three locations in order:
 * 1. ~/.claude/commands/<command-path>.md  (custom command file)
 * 2. ~/.claude/skills/<command>/SKILL.md   (user skill)
 * 3. <plugin installPath>/skills/<skill>/SKILL.md  (plugin skill, for "plugin:skill" names)
 * Returns raw file content, or null if not found.
 * Does NOT apply arguments — that is left to the caller.
 */
export function resolveContent(
  command: string,
  readFile: (path: string) => string | null = defaultReadFile,
): string | null {
  // 1. Command file
  const cmdPath = resolveCommandFilePath(command);
  const cmdContent = readFile(cmdPath);
  if (cmdContent !== null) return cmdContent;

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";

  // 2. User skill
  const userSkillPath = `${home}/.claude/skills/${command}/SKILL.md`;
  const userContent = readFile(userSkillPath);
  if (userContent !== null) return userContent;

  // 3. Plugin skill (plugin:skill format only)
  const colonIdx = command.indexOf(":");
  if (colonIdx > 0) {
    const pluginName = command.slice(0, colonIdx);
    const skillName = command.slice(colonIdx + 1);
    const pluginsJson = readFile(`${home}/.claude/plugins/installed_plugins.json`);
    if (pluginsJson) {
      try {
        const parsed = JSON.parse(pluginsJson) as {
          plugins: Record<string, Array<{ installPath: string }>>;
        };
        for (const [key, entries] of Object.entries(parsed.plugins ?? {})) {
          if (key.split("@")[0] === pluginName) {
            for (const entry of entries) {
              const skillPath = `${entry.installPath}/skills/${skillName}/SKILL.md`;
              const content = readFile(skillPath);
              if (content !== null) return content;
            }
          }
        }
      } catch {
        // malformed JSON — return null
      }
    }
  }

  return null;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /workspace && npm test -- --reporter=verbose tests/repl.dispatch.test.ts 2>&1 | tail -20
```

Expected: all `resolveContent` tests pass. `applyArguments` tests pass. The existing `dispatchInput` arg-appending test still fails (that is expected — fixed in next task).

- [ ] **Step 5: Commit**

```bash
git add src/input.ts tests/repl.dispatch.test.ts
git commit -m "feat: add resolveContent for unified command/skill resolution"
```

---

### Task 7: Update `dispatchInput` to use `resolveContent` + `applyArguments`

**Files:**
- Modify: `src/input.ts` (update `dispatchInput` body)
- Modify: `tests/repl.dispatch.test.ts` (add skill execution tests)

- [ ] **Step 1: Write failing tests for skill dispatch**

Add to the existing `describe("dispatchInput", ...)` block in `tests/repl.dispatch.test.ts`:

```typescript
  it("executes a skill with $ARGUMENTS substitution", async () => {
    const home = process.env.HOME ?? "";
    const readFile = (path: string) => {
      if (path === `${home}/.claude/skills/my-skill/SKILL.md`) return "Do $ARGUMENTS please.";
      return null;
    };
    const result = await dispatchInput("/my-skill the thing", readFile);
    expect(result).toEqual({ type: "query", prompt: "Do the thing please." });
  });

  it("executes a skill without $ARGUMENTS, appending ARGUMENTS:", async () => {
    const home = process.env.HOME ?? "";
    const readFile = (path: string) => {
      if (path === `${home}/.claude/skills/my-skill/SKILL.md`) return "Do a thing.";
      return null;
    };
    const result = await dispatchInput("/my-skill extra args", readFile);
    expect(result).toEqual({ type: "query", prompt: "Do a thing.\nARGUMENTS: extra args" });
  });

  it("executes a plugin skill", async () => {
    const home = process.env.HOME ?? "";
    const pluginsJson = JSON.stringify({
      plugins: { "myplugin@marketplace": [{ installPath: "/plugins/myplugin/1.0" }] },
    });
    const readFile = (path: string) => {
      if (path === `${home}/.claude/plugins/installed_plugins.json`) return pluginsJson;
      if (path === "/plugins/myplugin/1.0/skills/foo/SKILL.md") return "Plugin skill $ARGUMENTS.";
      return null;
    };
    const result = await dispatchInput("/myplugin:foo bar baz", readFile);
    expect(result).toEqual({ type: "query", prompt: "Plugin skill bar baz." });
  });
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /workspace && npm test -- --reporter=verbose tests/repl.dispatch.test.ts 2>&1 | tail -20
```

Expected: new skill dispatch tests fail (skill content found but arg format wrong), and the updated arg-appending test still fails.

- [ ] **Step 3: Update `dispatchInput` in `src/input.ts`**

Replace the `unknown_command` handling block inside `dispatchInput`. Find this block:

```typescript
    // unknown_command: look up file
    const { command } = slash;
    const content = loadCommandFile(command, readFile);
    if (content === null) return { type: "unknown_command", command };
    const args = input.slice(1 + command.length).trim();
    const prompt = args ? `${content}\n${args}` : content;
    return { type: "query", prompt };
```

Replace with:

```typescript
    // unknown_command: look up command file or skill
    const { command } = slash;
    const content = resolveContent(command, readFile);
    if (content === null) return { type: "unknown_command", command };
    const args = input.slice(1 + command.length).trim();
    const prompt = applyArguments(content, args);
    return { type: "query", prompt };
```

- [ ] **Step 4: Run all dispatch tests to confirm they pass**

```bash
cd /workspace && npm test -- --reporter=verbose tests/repl.dispatch.test.ts 2>&1 | tail -20
```

Expected: all tests pass including new skill execution tests and updated arg-appending test.

- [ ] **Step 5: Commit**

```bash
git add src/input.ts tests/repl.dispatch.test.ts
git commit -m "feat: update dispatchInput to use resolveContent and applyArguments"
```

---

### Task 8: Remove `loadCommandFile`, update exports and slash tests

**Files:**
- Modify: `src/input.ts` (remove `loadCommandFile`)
- Modify: `src/repl.ts` (update re-export)
- Modify: `tests/repl.slash.test.ts` (remove `loadCommandFile` import and tests, add `resolveContent` coverage)

- [ ] **Step 1: Update `tests/repl.slash.test.ts`**

Change the import (line 2) from:

```typescript
import { parseSlashCommand, resolveCommandFilePath, loadCommandFile, dispatchInput } from "../src/input.js";
```

To:

```typescript
import { parseSlashCommand, resolveCommandFilePath, resolveContent } from "../src/input.js";
```

Remove the entire `describe("loadCommandFile", ...)` block (lines 68–84). Add in its place a describe block that keeps the path-resolution coverage under `resolveContent`:

```typescript
describe("resolveContent path resolution", () => {
  it("passes the resolved command path to readFile", () => {
    let capturedPath = "";
    resolveContent("foo:bar", (path) => { capturedPath = path; return null; });
    expect(capturedPath).toMatch(/\.claude\/commands\/foo\/bar\.md$/);
  });
});
```

- [ ] **Step 2: Update `src/repl.ts`**

Change line 7 from:

```typescript
export { parseSlashCommand, resolveCommandFilePath, loadCommandFile, dispatchInput, matchCommands, listCommandNames, ask } from "./input.js";
```

To:

```typescript
export { parseSlashCommand, resolveCommandFilePath, resolveContent, dispatchInput, matchCommands, listCommandNames, ask } from "./input.js";
```

- [ ] **Step 3: Remove `loadCommandFile` from `src/input.ts`**

Delete the entire `loadCommandFile` function and its JSDoc comment (lines ~41–47). Also delete the `defaultReadFile` helper only if it is no longer used elsewhere; if `resolveContent` still uses `defaultReadFile` as its default, keep it.

- [ ] **Step 4: Run the full test suite to confirm nothing is broken**

```bash
cd /workspace && npm test 2>&1 | tail -30
```

Expected: all tests pass with no TypeScript errors.

- [ ] **Step 5: Run lint and type check**

```bash
cd /workspace && npm run lint && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Run smoke test**

```bash
cd /workspace && npm run smoke 2>&1 | tail -10
```

Expected: smoke test passes.

- [ ] **Step 7: Commit**

```bash
git add src/input.ts src/repl.ts tests/repl.slash.test.ts
git commit -m "refactor: replace loadCommandFile with resolveContent; update exports and tests"
```

---

### Task 9: Open pull request

**Files:**
- No file changes

- [ ] **Step 1: Push branch**

```bash
git push -u origin issue-67-skill-autocomplete
```

- [ ] **Step 2: Create PR**

```bash
gh pr create \
  --title "feat: autocomplete and execute user-invokable skills as slash commands (#67)" \
  --body "$(cat <<'EOF'
## Summary

- Adds `parseFrontmatter` to read SKILL.md frontmatter (filters `user-invocable: false`)
- Adds `applyArguments` for `$ARGUMENTS` substitution and `ARGUMENTS: <args>` append
- Adds `listSkillNames` to discover user skills (`~/.claude/skills/`) and plugin skills (`installed_plugins.json`)
- Extends `listCommandNames` to merge skill names into autocomplete
- Adds `resolveContent` that resolves command content from commands dir, user skills, or plugin skills
- Updates `dispatchInput` to use `resolveContent` + `applyArguments`
- Removes `loadCommandFile` (replaced by `resolveContent`); updates `src/repl.ts` re-export

Closes #67

## Test plan

- [ ] All unit tests pass (`npm test`)
- [ ] Lint passes (`npm run lint`)
- [ ] Type check passes (`npx tsc --noEmit`)
- [ ] Smoke test passes (`npm run smoke`)
- [ ] Manually: type `/` in REPL and verify skill names appear in autocomplete
- [ ] Manually: execute a skill with arguments and verify `$ARGUMENTS` substitution works

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed. Do not merge — leave for user review.
