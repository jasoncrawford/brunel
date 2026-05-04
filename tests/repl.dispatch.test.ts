import { describe, it, expect, beforeEach } from "vitest";
import { CommandRegistry, CommandController } from "../src/agent/controllers/command-controller.js";
import { registerTestCommands } from "./helpers.js";

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

// ── Unambiguous namespace-less dispatch ───────────────────────────────────────

describe("dispatchInput: unambiguous namespace-less resolution", () => {
  it("/claim resolves to worker:claim with no args", async () => {
    const result = await registry.dispatch("/claim", () => null);
    expect(result).toEqual({ type: "command", name: "worker:claim", args: "" });
  });

  it("/claim 123 resolves to worker:claim passing args", async () => {
    const result = await registry.dispatch("/claim 123", () => null);
    expect(result).toEqual({ type: "command", name: "worker:claim", args: "123" });
  });

  it("/complete resolves to worker:complete", async () => {
    const result = await registry.dispatch("/complete", () => null);
    expect(result).toEqual({ type: "command", name: "worker:complete", args: "" });
  });

  it("returns ambiguous_command for ambiguous namespace-less command", async () => {
    const reg = new CommandRegistry();
    const ctrl = new CommandController(reg);
    reg.scoped("worker").register("start", { description: "s1", handler: async () => {} });
    reg.scoped("workspace").register("start", { description: "s2", handler: async () => {} });
    const result = await ctrl.dispatch("/start", () => null);
    expect(result).toEqual({
      type: "ambiguous_command",
      command: "start",
      matches: ["worker:start", "workspace:start"],
    });
  });

  it("ambiguous command does not fall through to file lookup", async () => {
    const reg = new CommandRegistry();
    const ctrl = new CommandController(reg);
    reg.scoped("worker").register("run", { description: "r1", handler: async () => {} });
    reg.scoped("workspace").register("run", { description: "r2", handler: async () => {} });
    // Pass empty file system so only registry matches count.
    const result = await ctrl.dispatch("/run", () => null, () => null);
    expect(result).toEqual({
      type: "ambiguous_command",
      command: "run",
      matches: ["worker:run", "workspace:run"],
    });
  });
});

// ── File-based namespace-less dispatch ────────────────────────────────────────

describe("dispatchInput: file-based namespace-less resolution", () => {
  it("resolves unambiguous file-based command with namespace stripped", async () => {
    const reg = new CommandRegistry();
    const ctrl = new CommandController(reg);
    const home = process.env.HOME ?? "";
    const readFile = (path: string) => {
      if (path === `${home}/.claude/commands/worker/run.md`) return "Run the worker.";
      return null;
    };
    const listDir = (dir: string) => {
      if (dir === `${home}/.claude/commands`) return [{ name: "worker", isDir: true }];
      if (dir === `${home}/.claude/commands/worker`) return [{ name: "run.md", isDir: false }];
      return null;
    };
    const result = await ctrl.dispatch("/run", readFile, listDir);
    expect(result).toEqual({ type: "query", prompt: "Run the worker." });
  });

  it("passes args through to file-based command resolved via namespace strip", async () => {
    const reg = new CommandRegistry();
    const ctrl = new CommandController(reg);
    const home = process.env.HOME ?? "";
    const readFile = (path: string) => {
      if (path === `${home}/.claude/commands/worker/run.md`) return "Run with: $ARGUMENTS";
      return null;
    };
    const listDir = (dir: string) => {
      if (dir === `${home}/.claude/commands`) return [{ name: "worker", isDir: true }];
      if (dir === `${home}/.claude/commands/worker`) return [{ name: "run.md", isDir: false }];
      return null;
    };
    const result = await ctrl.dispatch("/run foo bar", readFile, listDir);
    expect(result).toEqual({ type: "query", prompt: "Run with: foo bar" });
  });

  it("returns ambiguous_command when multiple file-based commands share the suffix", async () => {
    const reg = new CommandRegistry();
    const ctrl = new CommandController(reg);
    const home = process.env.HOME ?? "";
    const readFile = (path: string) => {
      if (path === `${home}/.claude/commands/worker/run.md`) return "Worker run.";
      if (path === `${home}/.claude/commands/workspace/run.md`) return "Workspace run.";
      return null;
    };
    const listDir = (dir: string) => {
      if (dir === `${home}/.claude/commands`) return [
        { name: "worker", isDir: true },
        { name: "workspace", isDir: true },
      ];
      if (dir === `${home}/.claude/commands/worker`) return [{ name: "run.md", isDir: false }];
      if (dir === `${home}/.claude/commands/workspace`) return [{ name: "run.md", isDir: false }];
      return null;
    };
    const result = await ctrl.dispatch("/run", readFile, listDir);
    expect(result).toEqual({
      type: "ambiguous_command",
      command: "run",
      matches: ["worker:run", "workspace:run"],
    });
  });

  it("includes file-based matches alongside registry matches in ambiguous_command", async () => {
    const reg = new CommandRegistry();
    const ctrl = new CommandController(reg);
    reg.scoped("worker").register("run", { description: "r1", handler: async () => {} });
    const home = process.env.HOME ?? "";
    const readFile = (path: string) => {
      if (path === `${home}/.claude/commands/workspace/run.md`) return "Workspace run.";
      return null;
    };
    const listDir = (dir: string) => {
      if (dir === `${home}/.claude/commands`) return [{ name: "workspace", isDir: true }];
      if (dir === `${home}/.claude/commands/workspace`) return [{ name: "run.md", isDir: false }];
      return null;
    };
    // Registry suffix match finds worker:run; file suffix match finds workspace:run → ambiguous
    const result = await ctrl.dispatch("/run", readFile, listDir);
    expect(result).toEqual({
      type: "ambiguous_command",
      command: "run",
      matches: ["worker:run", "workspace:run"],
    });
  });
});
