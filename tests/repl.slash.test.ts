import { describe, it, expect, beforeEach } from "vitest";
import { parseSlashCommand, resolveCommandFilePath, resolveContent } from "../src/agent/input.js";
import { registerTestCommands } from "./helpers.js";

beforeEach(async () => registerTestCommands());

describe("parseSlashCommand", () => {
  it("returns null for non-slash input", () => {
    expect(parseSlashCommand("hello")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseSlashCommand("")).toBeNull();
  });

  it("returns null for bare slash", () => {
    expect(parseSlashCommand("/")).toBeNull();
  });

  it("recognizes /exit as builtin", () => {
    expect(parseSlashCommand("/exit")).toEqual({ type: "command", name: "exit" });
  });

  it("recognizes /clear as builtin", () => {
    expect(parseSlashCommand("/clear")).toEqual({ type: "command", name: "clear" });
  });

  it("returns unknown for unrecognized command with no file", () => {
    const result = parseSlashCommand("/unknown");
    expect(result).toEqual({ type: "unknown_command", command: "unknown" });
  });

  it("parses command name from input with arguments", () => {
    const result = parseSlashCommand("/foo some args");
    expect(result).toEqual({ type: "unknown_command", command: "foo" });
  });

  it("parses command name with colon namespace", () => {
    const result = parseSlashCommand("/foo:bar");
    expect(result).toEqual({ type: "unknown_command", command: "foo:bar" });
  });

  it("recognizes /worker:complete (canonical name)", () => {
    expect(parseSlashCommand("/worker:complete")).toEqual({ type: "command", name: "worker:complete" });
  });

  it("recognizes /workspace:create (canonical name)", () => {
    expect(parseSlashCommand("/workspace:create")).toEqual({ type: "command", name: "workspace:create" });
  });

  it("recognizes /workspace:reset (canonical name)", () => {
    expect(parseSlashCommand("/workspace:reset")).toEqual({ type: "command", name: "workspace:reset" });
  });

  it("recognizes /workspace:remove (canonical name)", () => {
    expect(parseSlashCommand("/workspace:remove")).toEqual({ type: "command", name: "workspace:remove" });
  });

  it("recognizes /workspace:prune (canonical name)", () => {
    expect(parseSlashCommand("/workspace:prune")).toEqual({ type: "command", name: "workspace:prune" });
  });

  it("recognizes /model", () => {
    expect(parseSlashCommand("/model")).toEqual({ type: "command", name: "model" });
  });

  it("recognizes /effort", () => {
    expect(parseSlashCommand("/effort")).toEqual({ type: "command", name: "effort" });
  });
});

describe("resolveCommandFilePath", () => {
  it("simple command maps to ~/.claude/commands/<cmd>.md", () => {
    const path = resolveCommandFilePath("brainstorming");
    expect(path).toMatch(/\.claude\/commands\/brainstorming\.md$/);
  });

  it("colon in command name maps to slash in path", () => {
    const path = resolveCommandFilePath("foo:bar");
    expect(path).toMatch(/\.claude\/commands\/foo\/bar\.md$/);
  });

  it("multiple colons produce nested path", () => {
    const path = resolveCommandFilePath("a:b:c");
    expect(path).toMatch(/\.claude\/commands\/a\/b\/c\.md$/);
  });

  it("path starts from home directory", () => {
    const path = resolveCommandFilePath("cmd");
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    expect(path.startsWith(home)).toBe(true);
  });
});

describe("resolveContent path resolution", () => {
  it("passes the resolved command path to readFile", () => {
    let firstPath = "";
    resolveContent("foo:bar", (path) => { if (!firstPath) firstPath = path; return null; });
    expect(firstPath).toMatch(/\.claude\/commands\/foo\/bar\.md$/);
  });
});
