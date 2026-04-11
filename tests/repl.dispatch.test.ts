import { describe, it, expect, beforeEach } from "vitest";
import { dispatchInput, applyArguments } from "../src/agent/input.js";
import { resolveContent } from "../src/agent/command-registry.js";
import { registerTestCommands } from "./helpers.js";
import type { CommandRegistry } from "../src/agent/command-registry.js";

let registry: CommandRegistry;

beforeEach(async () => { registry = await registerTestCommands(); });

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
    const result = await dispatchInput("", registry, () => null);
    expect(result).toEqual({ type: "skip" });
  });

  it("/exit returns { type: 'command', name: 'exit', args: '' }", async () => {
    const result = await dispatchInput("/exit", registry, () => null);
    expect(result).toEqual({ type: "command", name: "exit", args: "" });
  });

  it("/clear returns { type: 'command', name: 'clear', args: '' }", async () => {
    const result = await dispatchInput("/clear", registry, () => null);
    expect(result).toEqual({ type: "command", name: "clear", args: "" });
  });

  it("/unknown with no file returns { type: 'unknown_command', command }", async () => {
    const result = await dispatchInput("/unknown", registry, () => null);
    expect(result).toEqual({ type: "unknown_command", command: "unknown" });
  });

  it("/known with file returns { type: 'query', prompt: fileContent }", async () => {
    const result = await dispatchInput("/mycommand", registry, (_path) => "Do something creative.");
    expect(result).toEqual({ type: "query", prompt: "Do something creative." });
  });

  it("plain text returns { type: 'query', prompt: input }", async () => {
    const result = await dispatchInput("hello world", registry, () => null);
    expect(result).toEqual({ type: "query", prompt: "hello world" });
  });

  it("/command with extra args appends args to prompt", async () => {
    const result = await dispatchInput("/mycommand some extra args", registry, (_path) => "Base prompt.");
    expect(result).toEqual({ type: "query", prompt: "Base prompt.\nARGUMENTS: some extra args" });
  });

  it("executes a skill with $ARGUMENTS substitution", async () => {
    const home = process.env.HOME ?? "";
    const readFile = (path: string) => {
      if (path === `${home}/.claude/skills/my-skill/SKILL.md`) return "Do $ARGUMENTS please.";
      return null;
    };
    const result = await dispatchInput("/my-skill the thing", registry, readFile);
    expect(result).toEqual({ type: "query", prompt: "Do the thing please." });
  });

  it("executes a skill without $ARGUMENTS, appending ARGUMENTS:", async () => {
    const home = process.env.HOME ?? "";
    const readFile = (path: string) => {
      if (path === `${home}/.claude/skills/my-skill/SKILL.md`) return "Do a thing.";
      return null;
    };
    const result = await dispatchInput("/my-skill extra args", registry, readFile);
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
    const result = await dispatchInput("/myplugin:foo bar baz", registry, readFile);
    expect(result).toEqual({ type: "query", prompt: "Plugin skill bar baz." });
  });

  it("/workspace:create returns canonical command", async () => {
    const result = await dispatchInput("/workspace:create", registry, () => null);
    expect(result).toEqual({ type: "command", name: "workspace:create", args: "" });
  });

  it("/workspace:reset returns canonical command", async () => {
    const result = await dispatchInput("/workspace:reset", registry, () => null);
    expect(result).toEqual({ type: "command", name: "workspace:reset", args: "" });
  });

  it("/workspace:remove returns canonical command", async () => {
    const result = await dispatchInput("/workspace:remove", registry, () => null);
    expect(result).toEqual({ type: "command", name: "workspace:remove", args: "" });
  });

  it("/workspace:prune returns canonical command", async () => {
    const result = await dispatchInput("/workspace:prune", registry, () => null);
    expect(result).toEqual({ type: "command", name: "workspace:prune", args: "" });
  });

  it("/model returns command with args", async () => {
    const result = await dispatchInput("/model", registry, () => null);
    expect(result).toEqual({ type: "command", name: "model", args: "" });
  });

  it("/model opus passes args to command", async () => {
    const result = await dispatchInput("/model opus", registry, () => null);
    expect(result).toEqual({ type: "command", name: "model", args: "opus" });
  });

  it("/worker:complete returns canonical command", async () => {
    const result = await dispatchInput("/worker:complete", registry, () => null);
    expect(result).toEqual({ type: "command", name: "worker:complete", args: "" });
  });
});
