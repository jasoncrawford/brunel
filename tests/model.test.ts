import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleModelCommand, setCachedModels, _resetCachedModels, getCachedModels } from "../src/model.js";
import { stripAnsi } from "./helpers.js";

const MODELS = [
  { value: "claude-sonnet-4-6", displayName: "Sonnet 4.6", description: "Best for everyday tasks" },
  { value: "claude-opus-4-6", displayName: "Opus 4.6", description: "Most capable for complex work" },
  { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
];

let printed: string[];
const print = (s: string) => { printed.push(stripAnsi(s)); };

beforeEach(() => {
  _resetCachedModels();
  printed = [];
});

// ── Direct set via argument ─────────────────────────────────────────────────

describe("/model <arg> (direct set)", () => {
  it("sets model by alias when cache is available", async () => {
    setCachedModels(MODELS);
    const result = await handleModelCommand("sonnet", undefined, vi.fn(), vi.fn(), print);
    expect(result).toBe("claude-sonnet-4-6");
    expect(printed.join("")).toContain("Sonnet 4.6");
  });

  it("sets model by full ID when cache is available", async () => {
    setCachedModels(MODELS);
    const result = await handleModelCommand("claude-opus-4-6", undefined, vi.fn(), vi.fn(), print);
    expect(result).toBe("claude-opus-4-6");
    expect(printed.join("")).toContain("Opus 4.6");
  });

  it("rejects unknown alias when cache is available", async () => {
    setCachedModels(MODELS);
    const result = await handleModelCommand("unknown", "claude-opus-4-6", vi.fn(), vi.fn(), print);
    expect(result).toBe("claude-opus-4-6"); // unchanged
    expect(printed.join("")).toContain("Unknown model");
  });

  it("'default' resets to undefined", async () => {
    const result = await handleModelCommand("default", "claude-opus-4-6", vi.fn(), vi.fn(), print);
    expect(result).toBeUndefined();
    expect(printed.join("")).toContain("default");
  });

  it("accepts value as-is when no cache", async () => {
    const result = await handleModelCommand("opus", undefined, vi.fn(), vi.fn(), print);
    expect(result).toBe("opus");
  });
});

// ── Interactive picker ──────────────────────────────────────────────────────

describe("/model (interactive picker)", () => {
  it("shows message when no cache available", async () => {
    const result = await handleModelCommand("", "opus", vi.fn(), vi.fn(), print);
    expect(result).toBe("opus"); // unchanged
    expect(printed.join("")).toContain("No model list available");
  });

  it("selecting Default resets to undefined", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn().mockResolvedValue(0); // "Default"
    const result = await handleModelCommand("", "claude-opus-4-6", pickFn, vi.fn(), print);
    expect(result).toBeUndefined();
  });

  it("selecting a named model returns its value", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn().mockResolvedValue(2); // second model (Opus)
    const result = await handleModelCommand("", undefined, pickFn, vi.fn(), print);
    expect(result).toBe("claude-opus-4-6");
    expect(printed.join("")).toContain("Opus 4.6");
  });

  it("shows (current) marker on active model", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn().mockResolvedValue(1);
    await handleModelCommand("", "claude-sonnet-4-6", pickFn, vi.fn(), print);
    const options = pickFn.mock.calls[0][0] as string[];
    expect(options[1]).toContain("(current)");
    expect(options[2]).not.toContain("(current)");
  });

  it("shows (current) on Default when no model set", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn().mockResolvedValue(0);
    await handleModelCommand("", undefined, pickFn, vi.fn(), print);
    const options = pickFn.mock.calls[0][0] as string[];
    expect(options[0]).toContain("(current)");
  });

  it("shows model descriptions in options", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn().mockResolvedValue(0);
    await handleModelCommand("", undefined, pickFn, vi.fn(), print);
    const options = pickFn.mock.calls[0][0] as string[];
    expect(options[1]).toContain("Best for everyday tasks");
  });

  it("includes Other… as last option", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn().mockResolvedValue(0);
    await handleModelCommand("", undefined, pickFn, vi.fn(), print);
    const options = pickFn.mock.calls[0][0] as string[];
    expect(options[options.length - 1]).toContain("Other");
  });

  it("Other… with valid model ID sets it", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn().mockResolvedValue(MODELS.length + 1); // last option
    const askFn = vi.fn().mockResolvedValue("claude-haiku-4-5-20251001");
    const result = await handleModelCommand("", undefined, pickFn, askFn, print);
    expect(result).toBe("claude-haiku-4-5-20251001");
    expect(printed.join("")).toContain("Haiku 4.5");
  });

  it("Other… with invalid model ID rejects", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn().mockResolvedValue(MODELS.length + 1);
    const askFn = vi.fn().mockResolvedValue("not-a-model");
    const result = await handleModelCommand("", "claude-opus-4-6", pickFn, askFn, print);
    expect(result).toBe("claude-opus-4-6"); // unchanged
    expect(printed.join("")).toContain("Unknown model");
  });

  it("Other… with empty input preserves current", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn().mockResolvedValue(MODELS.length + 1);
    const askFn = vi.fn().mockResolvedValue("");
    const result = await handleModelCommand("", "claude-opus-4-6", pickFn, askFn, print);
    expect(result).toBe("claude-opus-4-6");
  });
});

// ── Display names ───────────────────────────────────────────────────────────

describe("display names", () => {
  it("uses displayName from model info, not raw alias", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn().mockResolvedValue(0);
    await handleModelCommand("", undefined, pickFn, vi.fn(), print);
    const options = pickFn.mock.calls[0][0] as string[];
    // Should show "Sonnet 4.6" not "sonnet" or "claude-sonnet-4-6"
    expect(options[1]).toMatch(/^Sonnet 4\.6/);
    expect(options[2]).toMatch(/^Opus 4\.6/);
    expect(options[3]).toMatch(/^Haiku 4\.5/);
  });
});
