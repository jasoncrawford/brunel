import { describe, it, expect, beforeEach } from "vitest";
import type { CommandController } from "../src/agent/controllers/command-controller.js";
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

  it("recognizes /model", () => {
    expect(registry.parseSlashCommand("/model")).toEqual({ type: "command", name: "model" });
  });

  it("recognizes /effort", () => {
    expect(registry.parseSlashCommand("/effort")).toEqual({ type: "command", name: "effort" });
  });
});

