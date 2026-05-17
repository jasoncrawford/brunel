import { describe, it, expect, beforeEach } from "vitest";
import { CommandRegistry, CommandController } from "../src/agent/controllers/command-controller.js";
import { registerTestCommands } from "./helpers.js";

let registry: CommandController;

beforeEach(async () => { registry = await registerTestCommands(); });

describe("parseSlashCommand", () => {
  it("returns null for non-slash input", () => {
    expect(registry.parseSlashCommand("hello")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(registry.parseSlashCommand("")).toBeNull();
  });

  it("returns null for bare slash", () => {
    expect(registry.parseSlashCommand("/")).toBeNull();
  });

  it("recognizes /exit as builtin", () => {
    expect(registry.parseSlashCommand("/exit")).toEqual({ type: "command", name: "exit" });
  });

  it("recognizes /clear as builtin", () => {
    expect(registry.parseSlashCommand("/clear")).toEqual({ type: "command", name: "clear" });
  });

  it("returns unknown for unrecognized command with no file", () => {
    const result = registry.parseSlashCommand("/unknown");
    expect(result).toEqual({ type: "unknown_command", command: "unknown" });
  });

  it("parses command name from input with arguments", () => {
    const result = registry.parseSlashCommand("/foo some args");
    expect(result).toEqual({ type: "unknown_command", command: "foo" });
  });

  it("parses command name with colon namespace", () => {
    const result = registry.parseSlashCommand("/foo:bar");
    expect(result).toEqual({ type: "unknown_command", command: "foo:bar" });
  });

  it("recognizes /worker:complete (canonical name)", () => {
    expect(registry.parseSlashCommand("/worker:complete")).toEqual({ type: "command", name: "worker:complete" });
  });

  it("recognizes /workspace:create (canonical name)", () => {
    expect(registry.parseSlashCommand("/workspace:create")).toEqual({ type: "command", name: "workspace:create" });
  });

  it("recognizes /workspace:reset (canonical name)", () => {
    expect(registry.parseSlashCommand("/workspace:reset")).toEqual({ type: "command", name: "workspace:reset" });
  });

  it("recognizes /workspace:remove (canonical name)", () => {
    expect(registry.parseSlashCommand("/workspace:remove")).toEqual({ type: "command", name: "workspace:remove" });
  });

  it("recognizes /workspace:prune (canonical name)", () => {
    expect(registry.parseSlashCommand("/workspace:prune")).toEqual({ type: "command", name: "workspace:prune" });
  });

  it("recognizes /settings:model", () => {
    expect(registry.parseSlashCommand("/settings:model")).toEqual({ type: "command", name: "settings:model" });
  });

  it("resolves /model to settings:model via suffix match", () => {
    expect(registry.parseSlashCommand("/model")).toEqual({ type: "command", name: "settings:model" });
  });

  it("resolves /effort to settings:effort via suffix match", () => {
    expect(registry.parseSlashCommand("/effort")).toEqual({ type: "command", name: "settings:effort" });
  });

  it("recognizes /settings", () => {
    expect(registry.parseSlashCommand("/settings")).toEqual({ type: "command", name: "settings" });
  });
});

// ── Unambiguous namespace-less resolution ─────────────────────────────────────

describe("parseSlashCommand: unambiguous namespace-less resolution", () => {
  it("resolves /claim to worker:claim when only one match exists", async () => {
    const result = registry.parseSlashCommand("/claim");
    expect(result).toEqual({ type: "command", name: "worker:claim" });
  });

  it("resolves /complete to worker:complete (canonical suffix match)", async () => {
    const result = registry.parseSlashCommand("/complete");
    expect(result).toEqual({ type: "command", name: "worker:complete" });
  });

  it("resolves /done to worker:complete (alias suffix match, returns canonical)", async () => {
    // worker:done is an alias for worker:complete; stripping 'worker:' gives 'done'
    const result = registry.parseSlashCommand("/done");
    expect(result).toEqual({ type: "command", name: "worker:complete" });
  });

  it("resolves /claim with args by matching on command token only", async () => {
    const result = registry.parseSlashCommand("/claim 123");
    expect(result).toEqual({ type: "command", name: "worker:claim" });
  });

  it("returns ambiguous_command when multiple commands share the suffix", () => {
    const reg = new CommandRegistry();
    const ctrl = new CommandController(reg);
    reg.scoped("worker").register("start", { description: "s1", handler: async () => {} });
    reg.scoped("workspace").register("start", { description: "s2", handler: async () => {} });
    expect(ctrl.parseSlashCommand("/start")).toEqual({
      type: "ambiguous_command",
      command: "start",
      matches: ["worker:start", "workspace:start"],
    });
  });

  it("returns ambiguous_command with matches sorted alphabetically", () => {
    const reg = new CommandRegistry();
    const ctrl = new CommandController(reg);
    reg.scoped("zzz").register("go", { description: "z", handler: async () => {} });
    reg.scoped("aaa").register("go", { description: "a", handler: async () => {} });
    const result = ctrl.parseSlashCommand("/go");
    expect(result).toEqual({
      type: "ambiguous_command",
      command: "go",
      matches: ["aaa:go", "zzz:go"],
    });
  });

  it("still returns unknown_command when no suffix match exists", () => {
    const result = registry.parseSlashCommand("/completelymadeup");
    expect(result).toEqual({ type: "unknown_command", command: "completelymadeup" });
  });
});

