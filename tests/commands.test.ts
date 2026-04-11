import { describe, it, expect, beforeEach } from "vitest";
import { CommandRegistry } from "../src/agent/commands.js";
import { registerTestCommands } from "./helpers.js";

let registry: CommandRegistry;

beforeEach(() => {
  registry = new CommandRegistry();
});

// ── lookup ────────────────────────────────────────────────────────────────────

describe("lookup", () => {
  it("finds a command by canonical name", () => {
    registry.register("clear", { description: "Clear", handler: async () => {} });
    const entry = registry.lookup("clear");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("clear");
  });

  it("finds a namespaced command by canonical name", () => {
    registry.register("workspace:create", { description: "Create workspace", handler: async () => {} });
    const entry = registry.lookup("workspace:create");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("workspace:create");
  });

  it("returns undefined for unknown command", () => {
    expect(registry.lookup("does-not-exist")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(registry.lookup("")).toBeUndefined();
  });
});

// ── listAll ───────────────────────────────────────────────────────────────────

describe("listAll", () => {
  beforeEach(async () => { registry = await registerTestCommands(); });

  it("non-worker mode excludes worker-only commands", () => {
    const names = registry.listAll(false).map(e => e.name);
    expect(names).not.toContain("worker:complete");
  });

  it("non-worker mode includes both-mode commands", () => {
    const names = registry.listAll(false).map(e => e.name);
    expect(names).toContain("clear");
    expect(names).toContain("exit");
    expect(names).toContain("model");
    expect(names).toContain("effort");
  });

  it("non-worker mode includes workspace commands", () => {
    const names = registry.listAll(false).map(e => e.name);
    expect(names).toContain("workspace:create");
    expect(names).toContain("workspace:reset");
    expect(names).toContain("workspace:remove");
    expect(names).toContain("workspace:prune");
  });

  it("worker mode includes worker-only commands", () => {
    const names = registry.listAll(true).map(e => e.name);
    expect(names).toContain("worker:complete");
  });

  it("worker mode includes both-mode commands", () => {
    const names = registry.listAll(true).map(e => e.name);
    expect(names).toContain("clear");
    expect(names).toContain("model");
    expect(names).toContain("effort");
  });

  it("defaults to non-worker mode", () => {
    const names = registry.listAll().map(e => e.name);
    expect(names).not.toContain("worker:complete");
  });
});

// ── execute ───────────────────────────────────────────────────────────────────

describe("execute", () => {
  it("calls the handler and returns its result", async () => {
    registry.register("test:cmd", { description: "test", handler: async () => "exit" });
    const result = await registry.execute("test:cmd", "");
    expect(result).toBe("exit");
  });

  it("passes args to the handler", async () => {
    let received = "";
    registry.register("test:args", { description: "test", handler: async (args) => { received = args; } });
    await registry.execute("test:args", "hello world");
    expect(received).toBe("hello world");
  });

  it("returns undefined for unknown command", async () => {
    const result = await registry.execute("nonexistent", "");
    expect(result).toBeUndefined();
  });

  it("handler returning void yields undefined result", async () => {
    registry.register("test:void", { description: "test", handler: async () => {} });
    const result = await registry.execute("test:void", "");
    expect(result).toBeUndefined();
  });

  it("handler can return 'task-complete'", async () => {
    registry.register("test:tc", { description: "test", handler: async () => "task-complete" });
    const result = await registry.execute("test:tc", "");
    expect(result).toBe("task-complete");
  });
});

// ── register ──────────────────────────────────────────────────────────────────

describe("register", () => {
  it("registers a new command that can be looked up", () => {
    registry.register("test:registered", { description: "A test command", handler: async () => {} });
    const entry = registry.lookup("test:registered");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("test:registered");
    expect(entry!.description).toBe("A test command");
  });

  it("defaults availability to 'both'", () => {
    registry.register("test:default-avail", { description: "test", handler: async () => {} });
    const entry = registry.lookup("test:default-avail")!;
    expect(entry.availability).toBe("both");
  });

  it("respects explicit availability", () => {
    registry.register("test:repl-only", { description: "test", availability: "repl", handler: async () => {} });
    const entry = registry.lookup("test:repl-only")!;
    expect(entry.availability).toBe("repl");
  });

  it("overwrites a previously registered command with the same name", () => {
    registry.register("test:overwrite", { description: "first", handler: async () => {} });
    registry.register("test:overwrite", { description: "second", handler: async () => {} });
    const entry = registry.lookup("test:overwrite")!;
    expect(entry.description).toBe("second");
  });
});

// ── Built-in command structure ─────────────────────────────────────────────────

describe("each registered entry shape", () => {
  beforeEach(() => {
    registry.register("clear",  { description: "Clear", handler: async () => {} });
    registry.register("exit",   { description: "Exit", availability: "repl", handler: async () => "exit" });
    registry.register("model",  { description: "Model", handler: async () => {} });
    registry.register("effort", { description: "Effort", handler: async () => {} });
    registry.register("worker:complete", { description: "Task done", availability: "worker", handler: async () => "task-complete" });
  });

  it("each entry has name, description, availability, and handler", () => {
    for (const entry of registry.listAll(true)) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.description).toBe("string");
      expect(["repl", "worker", "both"]).toContain(entry.availability);
      expect(typeof entry.handler).toBe("function");
    }
  });

  it("all registered commands have non-empty descriptions", () => {
    for (const entry of registry.listAll(true)) {
      expect(entry.description, `${entry.name} should have description`).toBeTruthy();
    }
  });
});
