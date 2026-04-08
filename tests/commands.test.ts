import { describe, it, expect, beforeEach } from "vitest";
import { register, lookup, listAll } from "../src/agent/commands.js";
import type { CommandEntry } from "../src/agent/commands.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create an isolated registry snapshot for testing without polluting the
 * module-level registry. We test the exported functions by calling them and
 * inspecting results that include the built-in registrations.
 */

// ── lookup ────────────────────────────────────────────────────────────────────

describe("lookup", () => {
  it("finds a command by canonical name", () => {
    const entry = lookup("clear");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("clear");
  });

  it("finds a namespaced command by canonical name", () => {
    const entry = lookup("workspace:create");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("workspace:create");
  });

  it("finds a command by alias", () => {
    const entry = lookup("create-workspace");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("workspace:create");
  });

  it("finds worker:task-complete by canonical name", () => {
    const entry = lookup("worker:task-complete");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("worker:task-complete");
  });

  it("finds worker:task-complete by alias 'task-complete'", () => {
    const entry = lookup("task-complete");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("worker:task-complete");
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

// ── Built-in registrations ────────────────────────────────────────────────────

describe("built-in command entries", () => {
  it("workspace:create has alias create-workspace", () => {
    const entry = lookup("workspace:create")!;
    expect(entry.aliases).toContain("create-workspace");
  });

  it("workspace:reset has alias reset-workspace", () => {
    const entry = lookup("workspace:reset")!;
    expect(entry.aliases).toContain("reset-workspace");
  });

  it("workspace:remove has alias remove-workspace", () => {
    const entry = lookup("workspace:remove")!;
    expect(entry.aliases).toContain("remove-workspace");
  });

  it("workspace:prune has alias prune", () => {
    const entry = lookup("workspace:prune")!;
    expect(entry.aliases).toContain("prune");
  });

  it("worker:task-complete has alias task-complete", () => {
    const entry = lookup("worker:task-complete")!;
    expect(entry.aliases).toContain("task-complete");
  });

  it("all built-in commands have non-empty descriptions", () => {
    for (const entry of listAll(true)) {
      expect(entry.description, `${entry.name} should have description`).toBeTruthy();
    }
  });

  it("each entry has a name, aliases array, description, and availability", () => {
    for (const entry of listAll(true)) {
      expect(typeof entry.name).toBe("string");
      expect(Array.isArray(entry.aliases)).toBe(true);
      expect(typeof entry.description).toBe("string");
      expect(["repl", "worker", "both"]).toContain(entry.availability);
    }
  });
});

// ── register ──────────────────────────────────────────────────────────────────

describe("register", () => {
  // These tests exercise the register function with new commands and verify
  // they appear via lookup/listAll after registration.

  it("registers a new command that can be looked up", () => {
    register("test:registered", { description: "A test command" });
    const entry = lookup("test:registered");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("test:registered");
    expect(entry!.description).toBe("A test command");
  });

  it("defaults availability to 'both'", () => {
    register("test:default-avail", { description: "test" });
    const entry = lookup("test:default-avail")!;
    expect(entry.availability).toBe("both");
  });

  it("respects explicit availability", () => {
    register("test:repl-only", { description: "test", availability: "repl" });
    const entry = lookup("test:repl-only")!;
    expect(entry.availability).toBe("repl");
  });

  it("registered aliases can be looked up", () => {
    register("test:aliased", { description: "test", aliases: ["old-name"] });
    const entry = lookup("old-name");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("test:aliased");
  });
});
