import { describe, it, expect } from "vitest";
import { parseSlashCommand, resolveCommandFilePath, loadCommandFile, dispatchInput } from "../src/input.js";

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

  it("returns task_complete for /task-complete", () => {
    expect(parseSlashCommand("/task-complete")).toEqual({ type: "task_complete" });
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

describe("loadCommandFile", () => {
  it("returns file content when file exists", () => {
    const content = loadCommandFile("brainstorming", (_path) => "# Brainstorm\nThink creatively.");
    expect(content).toBe("# Brainstorm\nThink creatively.");
  });

  it("returns null when file does not exist", () => {
    const content = loadCommandFile("nonexistent", (_path) => null);
    expect(content).toBeNull();
  });

  it("passes the resolved path to readFile", () => {
    let capturedPath = "";
    loadCommandFile("foo:bar", (path) => { capturedPath = path; return null; });
    expect(capturedPath).toMatch(/\.claude\/commands\/foo\/bar\.md$/);
  });
});

describe("dispatchInput", () => {
  it("returns task_complete for /task-complete input", async () => {
    expect(await dispatchInput("/task-complete")).toEqual({ type: "task_complete" });
  });
});
