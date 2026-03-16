import { describe, it, expect } from "vitest";
import { dispatchInput, applyArguments, resolveContent } from "../src/input.js";

// ── applyArguments ────────────────────────────────────────────────────────────

describe("applyArguments", () => {
  it("replaces $ARGUMENTS with args when present", () => {
    expect(applyArguments("Do $ARGUMENTS now.", "the thing")).toBe("Do the thing now.");
  });

  it("replaces $ARGUMENTS with empty string when args is empty", () => {
    expect(applyArguments("Do $ARGUMENTS now.", "")).toBe("Do  now.");
  });

  it("replaces multiple $ARGUMENTS occurrences", () => {
    expect(applyArguments("$ARGUMENTS and $ARGUMENTS", "x")).toBe("x and x");
  });

  it("appends ARGUMENTS: <args> when no $ARGUMENTS and args non-empty", () => {
    expect(applyArguments("Base prompt.", "extra stuff")).toBe("Base prompt.\nARGUMENTS: extra stuff");
  });

  it("returns content unchanged when no $ARGUMENTS and args is empty", () => {
    expect(applyArguments("Base prompt.", "")).toBe("Base prompt.");
  });
});

describe("dispatchInput", () => {
  it("empty input returns { type: 'skip' }", async () => {
    const result = await dispatchInput("", () => null);
    expect(result).toEqual({ type: "skip" });
  });

  it("/exit returns { type: 'exit' }", async () => {
    const result = await dispatchInput("/exit", () => null);
    expect(result).toEqual({ type: "exit" });
  });

  it("/clear returns { type: 'clear' }", async () => {
    const result = await dispatchInput("/clear", () => null);
    expect(result).toEqual({ type: "clear" });
  });

  it("/unknown with no file returns { type: 'unknown_command', command }", async () => {
    const result = await dispatchInput("/unknown", () => null);
    expect(result).toEqual({ type: "unknown_command", command: "unknown" });
  });

  it("/known with file returns { type: 'query', prompt: fileContent }", async () => {
    const result = await dispatchInput("/mycommand", (_path) => "Do something creative.");
    expect(result).toEqual({ type: "query", prompt: "Do something creative." });
  });

  it("plain text returns { type: 'query', prompt: input }", async () => {
    const result = await dispatchInput("hello world", () => null);
    expect(result).toEqual({ type: "query", prompt: "hello world" });
  });

  it("/command with extra args appends args to prompt", async () => {
    const result = await dispatchInput("/mycommand some extra args", (_path) => "Base prompt.");
    expect(result).toEqual({ type: "query", prompt: "Base prompt.\nARGUMENTS: some extra args" });
  });
});
