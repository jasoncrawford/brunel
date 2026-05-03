import { describe, it, expect, beforeEach } from "vitest";
import { CommandRegistry, CommandController, filterCommands } from "../src/agent/controllers/command-controller.js";
import { registerTestCommands } from "./helpers.js";

let registry: CommandController;

beforeEach(() => {
  registry = new CommandController(new CommandRegistry());
});

// ── lookup ────────────────────────────────────────────────────────────────────

describe("lookup", () => {
  it("finds a command by canonical name", () => {
    registry.registry.register("clear", { description: "Clear", handler: async () => {} });
    const entry = registry.registry.lookup("clear");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("clear");
  });

  it("finds a namespaced command by canonical name", () => {
    registry.registry.register("workspace:create", { description: "Create workspace", handler: async () => {} });
    const entry = registry.registry.lookup("workspace:create");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("workspace:create");
  });

  it("returns undefined for unknown command", () => {
    expect(registry.registry.lookup("does-not-exist")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(registry.registry.lookup("")).toBeUndefined();
  });
});

// ── listAll ───────────────────────────────────────────────────────────────────

describe("listAll", () => {
  beforeEach(async () => { registry = await registerTestCommands(); });

  it("includes all registered commands", () => {
    const names = registry.registry.listAll().map(e => e.name);
    expect(names).toContain("clear");
    expect(names).toContain("exit");
    expect(names).toContain("model");
    expect(names).toContain("effort");
    expect(names).toContain("worker:complete");
  });

  it("includes workspace commands", () => {
    const names = registry.registry.listAll().map(e => e.name);
    expect(names).toContain("workspace:create");
    expect(names).toContain("workspace:reset");
    expect(names).toContain("workspace:remove");
    expect(names).toContain("workspace:prune");
  });
});

// ── execute ───────────────────────────────────────────────────────────────────

describe("execute", () => {
  it("calls the handler and returns its result", async () => {
    registry.registry.register("test:cmd", { description: "test", handler: async () => "exit" });
    const result = await registry.registry.execute("test:cmd", "");
    expect(result).toBe("exit");
  });

  it("passes args to the handler", async () => {
    let received = "";
    registry.registry.register("test:args", { description: "test", handler: async (args) => { received = args; } });
    await registry.registry.execute("test:args", "hello world");
    expect(received).toBe("hello world");
  });

  it("returns undefined for unknown command", async () => {
    const result = await registry.registry.execute("nonexistent", "");
    expect(result).toBeUndefined();
  });

  it("handler returning void yields undefined result", async () => {
    registry.registry.register("test:void", { description: "test", handler: async () => {} });
    const result = await registry.registry.execute("test:void", "");
    expect(result).toBeUndefined();
  });

  it("handler can return 'task-complete'", async () => {
    registry.registry.register("test:tc", { description: "test", handler: async () => "task-complete" });
    const result = await registry.registry.execute("test:tc", "");
    expect(result).toBe("task-complete");
  });
});

// ── register ──────────────────────────────────────────────────────────────────

describe("register", () => {
  it("registers a new command that can be looked up", () => {
    registry.registry.register("test:registered", { description: "A test command", handler: async () => {} });
    const entry = registry.registry.lookup("test:registered");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("test:registered");
    expect(entry!.description).toBe("A test command");
  });

  it("overwrites a previously registered command with the same name", () => {
    registry.registry.register("test:overwrite", { description: "first", handler: async () => {} });
    registry.registry.register("test:overwrite", { description: "second", handler: async () => {} });
    const entry = registry.registry.lookup("test:overwrite")!;
    expect(entry.description).toBe("second");
  });
});

// ── scoped ────────────────────────────────────────────────────────────────────

describe("scoped", () => {
  it("prefixes registered names with the scope", () => {
    registry.registry.scoped("workspace").register("create", { description: "Create", handler: async () => {} });
    expect(registry.registry.lookup("workspace:create")).toBeDefined();
    expect(registry.registry.lookup("workspace:create")!.name).toBe("workspace:create");
  });

  it("scoped registry can be further scoped", () => {
    registry.registry.scoped("a").scoped("b").register("c", { description: "Nested", handler: async () => {} });
    expect(registry.registry.lookup("a:b:c")).toBeDefined();
  });

  it("root and scoped registries share the same store", () => {
    const ws = registry.registry.scoped("workspace");
    ws.register("create", { description: "Create", handler: async () => {} });
    registry.registry.register("exit", { description: "Exit", handler: async () => {} });
    expect(registry.registry.listAll().map(e => e.name)).toContain("workspace:create");
    expect(registry.registry.listAll().map(e => e.name)).toContain("exit");
  });

  it("execute works on full canonical name after scoped registration", async () => {
    const ws = registry.registry.scoped("workspace");
    let called = false;
    ws.register("create", { description: "Create", handler: async () => { called = true; } });
    await registry.registry.execute("workspace:create", "");
    expect(called).toBe(true);
  });
});

// ── Built-in command structure ─────────────────────────────────────────────────

describe("each registered entry shape", () => {
  beforeEach(() => {
    registry.registry.register("clear",  { description: "Clear", handler: async () => {} });
    registry.registry.register("exit",   { description: "Exit", handler: async () => "exit" });
    registry.registry.register("model",  { description: "Model", handler: async () => {} });
    registry.registry.register("effort", { description: "Effort", handler: async () => {} });
    registry.registry.register("worker:complete", { description: "Task done", handler: async () => "task-complete" });
  });

  it("each entry has name, description, and handler", () => {
    for (const entry of registry.registry.listAll()) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.description).toBe("string");
      expect(typeof entry.handler).toBe("function");
    }
  });

  it("all registered commands have non-empty descriptions", () => {
    for (const entry of registry.registry.listAll()) {
      expect(entry.description, `${entry.name} should have description`).toBeTruthy();
    }
  });
});

// ── filterCommands ────────────────────────────────────────────────────────────

describe("filterCommands", () => {
  it("empty query returns all commands", () => {
    const cmds = [{ name: "foo", description: "" }, { name: "bar", description: "" }];
    expect(filterCommands("", cmds)).toEqual(cmds);
  });

  it("prefix of full name matches", () => {
    const result = filterCommands("ex", [{ name: "exit", description: "" }]);
    expect(result.map(c => c.name)).toEqual(["exit"]);
  });

  it("non-prefix substring of name matches", () => {
    const result = filterCommands("xit", [{ name: "exit", description: "" }]);
    expect(result.map(c => c.name)).toEqual(["exit"]);
  });

  it("description-only match returns command", () => {
    const result = filterCommands("suite", [
      { name: "run-tests", description: "Run the test suite" },
    ]);
    expect(result.map(c => c.name)).toEqual(["run-tests"]);
  });

  it("prefix of last segment matches a namespaced command", () => {
    const result = filterCommands("comp", [{ name: "worker:complete", description: "" }]);
    expect(result.map(c => c.name)).toEqual(["worker:complete"]);
  });

  it("case-insensitive segment prefix match", () => {
    const result = filterCommands("COMP", [{ name: "worker:complete", description: "" }]);
    expect(result.map(c => c.name)).toEqual(["worker:complete"]);
  });

  it("depth-0 prefix match comes before depth-1 segment prefix match", () => {
    const result = filterCommands("st", [
      { name: "worker:start", description: "" },
      { name: "status",       description: "" },
    ]);
    expect(result.map(c => c.name)).toEqual(["status", "worker:start"]);
  });

  it("depth-1 segment prefix match comes before non-prefix substring match", () => {
    // "st" is a prefix of the "start" segment in "worker:start" (depth 1)
    // "st" is NOT a prefix of any segment in "some-stuff" (substring only)
    const result = filterCommands("st", [
      { name: "some-stuff",   description: "" },
      { name: "worker:start", description: "" },
    ]);
    expect(result.map(c => c.name)).toEqual(["worker:start", "some-stuff"]);
  });

  it("depth-1 segment prefix match comes before depth-2 segment prefix match", () => {
    // "st" → "start" at depth 1 in "worker:start", "stuff" at depth 2 in "foo:bar:stuff"
    const result = filterCommands("st", [
      { name: "foo:bar:stuff", description: "" },
      { name: "worker:start",  description: "" },
    ]);
    expect(result.map(c => c.name)).toEqual(["worker:start", "foo:bar:stuff"]);
  });

  it("full sort order: depth-0, depth-1, depth-2, substring, description", () => {
    const result = filterCommands("st", [
      { name: "foo:bar:stuff",  description: "" },
      { name: "some-stuff",     description: "" },
      { name: "worker:start",   description: "" },
      { name: "status",         description: "" },
      { name: "brainstorm",     description: "Start something" },
    ]);
    expect(result.map(c => c.name)).toEqual([
      "status",
      "worker:start",
      "foo:bar:stuff",
      "some-stuff",
      "brainstorm",
    ]);
  });

  it("sort order: prefix name match before description-only match", () => {
    const result = filterCommands("run", [
      { name: "brainstorm", description: "Run ideas by the AI" },
      { name: "run-tests",  description: "Execute the suite" },
    ]);
    expect(result.map(c => c.name)).toEqual(["run-tests", "brainstorm"]);
  });

  it("/worker:st matches /worker:status at depth 0 before /foo:worker:status at depth 1", () => {
    const result = filterCommands("worker:st", [
      { name: "foo:worker:status", description: "" },
      { name: "worker:status",     description: "" },
    ]);
    expect(result.map(c => c.name)).toEqual(["worker:status", "foo:worker:status"]);
  });

  it("non-prefix substring of full name stays as substring match (not promoted to prefix)", () => {
    // "event" does not start any segment of "something-events" or "worker:resume-events"
    const result = filterCommands("event", [
      { name: "something-events",    description: "" },
      { name: "worker:resume-events", description: "" },
    ]);
    expect(result).toHaveLength(2);
    // Both are substring matches; order preserved from input
    expect(result.map(c => c.name)).toEqual(["something-events", "worker:resume-events"]);
  });
});
