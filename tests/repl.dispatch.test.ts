import { describe, it, expect } from "vitest";
import { dispatchInput } from "../src/input.js";

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
    expect(result).toEqual({ type: "query", prompt: "Base prompt.\nsome extra args" });
  });
});
