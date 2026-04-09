import { describe, it, expect, beforeEach } from "vitest";
import { register, lookup, listAll, execute, _reset } from "../src/agent/commands.js";

beforeEach(() => {
  _reset();
});

// ── lookup ────────────────────────────────────────────────────────────────────

describe("lookup", () => {
  it("finds a command by canonical name", () => {
    register("clear", { description: "Clear", handler: async () => {} });
    const entry = lookup("clear");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("clear");
  });

  it("finds a namespaced command by canonical name", () => {
    register("workspace:create", { description: "Create workspace", handler: async () => {} });
    const entry = lookup("workspace:create");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("workspace:create");
  });

  it("returns undefined for unknown command", () => {
    expect(lookup("does-not-exist")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(lookup("")).toBeUndefined();
  });
});

// ── listAll ───────────────────────────────────────────────────────────────────

describe("listAll", () => {
  beforeEach(() => {
    register("clear",  { description: "Clear the conversation", handler: async () => {} });
    register("exit",   { description: "Exit the REPL", handler: async () => "exit" });
    register("model",  { description: "Select model", handler: async () => {} });
    register("effort", { description: "Set effort", handler: async () => {} });
    register("workspace:create", { description: "Create workspace", handler: async () => {} });
    register("workspace:reset",  { description: "Reset workspace", handler: async () => {} });
    register("workspace:remove", { description: "Remove workspace", handler: async () => {} });
    register("workspace:prune",  { description: "Prune workspaces", handler: async () => {} });
    register("worker:task-complete", { description: "Mark task done", availability: "worker", handler: async () => "task-complete" });
  });

  it("non-worker mode excludes worker-only commands", () => {
    const names = listAll(false).map(e => e.name);
    expect(names).not.toContain("worker:task-complete");
  });

  it("non-worker mode includes both-mode commands", () => {
    const names = listAll(false).map(e => e.name);
    expect(names).toContain("clear");
    expect(names).toContain("exit");
    expect(names).toContain("model");
    expect(names).toContain("effort");
  });

  it("non-worker mode includes workspace commands", () => {
    const names = listAll(false).map(e => e.name);
    expect(names).toContain("workspace:create");
    expect(names).toContain("workspace:reset");
    expect(names).toContain("workspace:remove");
    expect(names).toContain("workspace:prune");
  });

  it("worker mode includes worker-only commands", () => {
    const names = listAll(true).map(e => e.name);
    expect(names).toContain("worker:task-complete");
  });

  it("worker mode includes both-mode commands", () => {
    const names = listAll(true).map(e => e.name);
    expect(names).toContain("clear");
    expect(names).toContain("model");
    expect(names).toContain("effort");
  });

  it("defaults to non-worker mode", () => {
    const names = listAll().map(e => e.name);
    expect(names).not.toContain("worker:task-complete");
  });
});

// ── execute ───────────────────────────────────────────────────────────────────

describe("execute", () => {
  it("calls the handler and returns its result", async () => {
    register("test:cmd", { description: "test", handler: async () => "exit" });
    const result = await execute("test:cmd", "");
    expect(result).toBe("exit");
  });

  it("passes args to the handler", async () => {
    let received = "";
    register("test:args", { description: "test", handler: async (args) => { received = args; } });
    await execute("test:args", "hello world");
    expect(received).toBe("hello world");
  });

  it("returns undefined for unknown command", async () => {
    const result = await execute("nonexistent", "");
    expect(result).toBeUndefined();
  });

  it("handler returning void yields undefined result", async () => {
    register("test:void", { description: "test", handler: async () => {} });
    const result = await execute("test:void", "");
    expect(result).toBeUndefined();
  });

  it("handler can return 'task-complete'", async () => {
    register("test:tc", { description: "test", handler: async () => "task-complete" });
    const result = await execute("test:tc", "");
    expect(result).toBe("task-complete");
  });
});

// ── register ──────────────────────────────────────────────────────────────────

describe("register", () => {
  it("registers a new command that can be looked up", () => {
    register("test:registered", { description: "A test command", handler: async () => {} });
    const entry = lookup("test:registered");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("test:registered");
    expect(entry!.description).toBe("A test command");
  });

  it("defaults availability to 'both'", () => {
    register("test:default-avail", { description: "test", handler: async () => {} });
    const entry = lookup("test:default-avail")!;
    expect(entry.availability).toBe("both");
  });

  it("respects explicit availability", () => {
    register("test:repl-only", { description: "test", availability: "repl", handler: async () => {} });
    const entry = lookup("test:repl-only")!;
    expect(entry.availability).toBe("repl");
  });

  it("overwrites a previously registered command with the same name", () => {
    register("test:overwrite", { description: "first", handler: async () => {} });
    register("test:overwrite", { description: "second", handler: async () => {} });
    const entry = lookup("test:overwrite")!;
    expect(entry.description).toBe("second");
  });
});

// ── Built-in command structure ─────────────────────────────────────────────────

describe("each registered entry shape", () => {
  beforeEach(() => {
    register("clear",  { description: "Clear", handler: async () => {} });
    register("exit",   { description: "Exit", availability: "repl", handler: async () => "exit" });
    register("model",  { description: "Model", handler: async () => {} });
    register("effort", { description: "Effort", handler: async () => {} });
    register("worker:task-complete", { description: "Task done", availability: "worker", handler: async () => "task-complete" });
  });

  it("each entry has name, description, availability, and handler", () => {
    for (const entry of listAll(true)) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.description).toBe("string");
      expect(["repl", "worker", "both"]).toContain(entry.availability);
      expect(typeof entry.handler).toBe("function");
    }
  });

  it("all registered commands have non-empty descriptions", () => {
    for (const entry of listAll(true)) {
      expect(entry.description, `${entry.name} should have description`).toBeTruthy();
    }
  });
});
