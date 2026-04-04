import { describe, it, expect } from "vitest";
import { parseSlashCommand, resolveCommandFilePath, resolveContent } from "../src/input.js";

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

  it("recognizes /exit as builtin exit", () => {
    expect(parseSlashCommand("/exit")).toEqual({ type: "exit" });
  });

  it("recognizes /clear as builtin clear", () => {
    expect(parseSlashCommand("/clear")).toEqual({ type: "clear" });
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

  it("recognizes /task-complete", () => {
    expect(parseSlashCommand("/task-complete")).toEqual({ type: "task-complete" });
  });
  it("recognizes /create-workspace", () => {
    expect(parseSlashCommand("/create-workspace")).toEqual({ type: "create-workspace" });
  });
  it("recognizes /reset-workspace", () => {
    expect(parseSlashCommand("/reset-workspace")).toEqual({ type: "reset-workspace" });
  });
  it("recognizes /remove-workspace", () => {
    expect(parseSlashCommand("/remove-workspace")).toEqual({ type: "remove-workspace" });
  });
  it("recognizes /prune", () => {
    expect(parseSlashCommand("/prune")).toEqual({ type: "prune" });
  });
  it("recognizes /model", () => {
    expect(parseSlashCommand("/model")).toEqual({ type: "model" });
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
