import { describe, it, expect } from "vitest";
import { dispatchInput, applyArguments, resolveContent } from "../src/input.js";

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

describe("dispatchInput", () => {
  it("empty input returns { type: 'skip' }", async () => {
    const result = await dispatchInput("", () => null);
    expect(result).toEqual({ type: "skip" });
  });

  it("/exit returns { type: 'exit' }", async () => {
    const result = await dispatchInput("/exit", () => null);
    expect(result).toEqual({ type: "exit" });
  });

  it("/clear returns { type: 'clear' }", async () => {
    const result = await dispatchInput("/clear", () => null);
    expect(result).toEqual({ type: "clear" });
  });

  it("/unknown with no file returns { type: 'unknown_command', command }", async () => {
    const result = await dispatchInput("/unknown", () => null);
    expect(result).toEqual({ type: "unknown_command", command: "unknown" });
  });

  it("/known with file returns { type: 'query', prompt: fileContent }", async () => {
    const result = await dispatchInput("/mycommand", (_path) => "Do something creative.");
    expect(result).toEqual({ type: "query", prompt: "Do something creative." });
  });

  it("plain text returns { type: 'query', prompt: input }", async () => {
    const result = await dispatchInput("hello world", () => null);
    expect(result).toEqual({ type: "query", prompt: "hello world" });
  });

  it("/command with extra args appends args to prompt", async () => {
    const result = await dispatchInput("/mycommand some extra args", (_path) => "Base prompt.");
    expect(result).toEqual({ type: "query", prompt: "Base prompt.\nARGUMENTS: some extra args" });
  });

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

  it("/create-workspace returns { type: 'create-workspace' }", async () => {
    const result = await dispatchInput("/create-workspace", () => null);
    expect(result).toEqual({ type: "create-workspace" });
  });

  it("/reset-workspace returns { type: 'reset-workspace' }", async () => {
    const result = await dispatchInput("/reset-workspace", () => null);
    expect(result).toEqual({ type: "reset-workspace" });
  });

  it("/remove-workspace returns { type: 'remove-workspace' }", async () => {
    const result = await dispatchInput("/remove-workspace", () => null);
    expect(result).toEqual({ type: "remove-workspace" });
  });

  it("/prune returns { type: 'prune' }", async () => {
    const result = await dispatchInput("/prune", () => null);
    expect(result).toEqual({ type: "prune" });
  });

  it("/model returns { type: 'model' }", async () => {
    const result = await dispatchInput("/model", () => null);
    expect(result).toEqual({ type: "model" });
  });
});
