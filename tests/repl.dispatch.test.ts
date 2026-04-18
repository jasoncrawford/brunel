import { describe, it, expect, beforeEach } from "vitest";
import { registerTestCommands } from "./helpers.js";
import type { CommandController } from "../src/agent/controllers/command-controller.js";

let registry: CommandController;

beforeEach(async () => { registry = await registerTestCommands(); });

describe("dispatchInput", () => {
  it("empty input returns { type: 'skip' }", async () => {
    const result = await registry.dispatch("", () => null);
    expect(result).toEqual({ type: "skip" });
  });

  it("/exit returns { type: 'command', name: 'exit', args: '' }", async () => {
    const result = await registry.dispatch("/exit", () => null);
    expect(result).toEqual({ type: "command", name: "exit", args: "" });
  });

  it("/clear returns { type: 'command', name: 'clear', args: '' }", async () => {
    const result = await registry.dispatch("/clear", () => null);
    expect(result).toEqual({ type: "command", name: "clear", args: "" });
  });

  it("/unknown with no file returns { type: 'unknown_command', command }", async () => {
    const result = await registry.dispatch("/unknown", () => null);
    expect(result).toEqual({ type: "unknown_command", command: "unknown" });
  });

  it("/known with file returns { type: 'query', prompt: fileContent }", async () => {
    const result = await registry.dispatch("/mycommand", (_path) => "Do something creative.");
    expect(result).toEqual({ type: "query", prompt: "Do something creative." });
  });

  it("plain text returns { type: 'query', prompt: input }", async () => {
    const result = await registry.dispatch("hello world", () => null);
    expect(result).toEqual({ type: "query", prompt: "hello world" });
  });

  it("/command with extra args appends args to prompt", async () => {
    const result = await registry.dispatch("/mycommand some extra args", (_path) => "Base prompt.");
    expect(result).toEqual({ type: "query", prompt: "Base prompt.\nARGUMENTS: some extra args" });
  });

  it("executes a skill with $ARGUMENTS substitution", async () => {
    const home = process.env.HOME ?? "";
    const readFile = (path: string) => {
      if (path === `${home}/.claude/skills/my-skill/SKILL.md`) return "Do $ARGUMENTS please.";
      return null;
    };
    const result = await registry.dispatch("/my-skill the thing", readFile);
    expect(result).toEqual({ type: "query", prompt: "Do the thing please." });
  });

  it("executes a skill without $ARGUMENTS, appending ARGUMENTS:", async () => {
    const home = process.env.HOME ?? "";
    const readFile = (path: string) => {
      if (path === `${home}/.claude/skills/my-skill/SKILL.md`) return "Do a thing.";
      return null;
    };
    const result = await registry.dispatch("/my-skill extra args", readFile);
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
    const result = await registry.dispatch("/myplugin:foo bar baz", readFile);
    expect(result).toEqual({ type: "query", prompt: "Plugin skill bar baz." });
  });

  it("/workspace:create returns canonical command", async () => {
    const result = await registry.dispatch("/workspace:create", () => null);
    expect(result).toEqual({ type: "command", name: "workspace:create", args: "" });
  });

  it("/workspace:reset returns canonical command", async () => {
    const result = await registry.dispatch("/workspace:reset", () => null);
    expect(result).toEqual({ type: "command", name: "workspace:reset", args: "" });
  });

  it("/workspace:remove returns canonical command", async () => {
    const result = await registry.dispatch("/workspace:remove", () => null);
    expect(result).toEqual({ type: "command", name: "workspace:remove", args: "" });
  });

  it("/workspace:prune returns canonical command", async () => {
    const result = await registry.dispatch("/workspace:prune", () => null);
    expect(result).toEqual({ type: "command", name: "workspace:prune", args: "" });
  });

  it("/model returns command with args", async () => {
    const result = await registry.dispatch("/model", () => null);
    expect(result).toEqual({ type: "command", name: "model", args: "" });
  });

  it("/model opus passes args to command", async () => {
    const result = await registry.dispatch("/model opus", () => null);
    expect(result).toEqual({ type: "command", name: "model", args: "opus" });
  });

  it("/worker:complete returns canonical command", async () => {
    const result = await registry.dispatch("/worker:complete", () => null);
    expect(result).toEqual({ type: "command", name: "worker:complete", args: "" });
  });
});
