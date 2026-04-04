import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleModelCommand, setCachedModels, _resetCachedModels, getCachedModels, findModel } from "../src/model.js";
import type { PickResult } from "../src/input.js";
import { stripAnsi } from "./helpers.js";

const MODELS = [
  { value: "claude-sonnet-4-6", displayName: "Sonnet 4.6", description: "Best for everyday tasks" },
  { value: "claude-opus-4-6", displayName: "Opus 4.6", description: "Most capable for complex work" },
  { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
];

let printed: string[];
const print = (s: string) => { printed.push(stripAnsi(s)); };
const noopPick = vi.fn();

beforeEach(() => {
  _resetCachedModels();
  printed = [];
});

// ── Direct set via argument ─────────────────────────────────────────────────

describe("/model <arg> (direct set)", () => {
  it("sets model by alias when cache is available", async () => {
    setCachedModels(MODELS);
    const result = await handleModelCommand("sonnet", undefined, noopPick, undefined, print);
    expect(result).toBe("claude-sonnet-4-6");
    expect(printed.join("")).toContain("Sonnet 4.6");
  });

  it("sets model by full ID when cache is available", async () => {
    setCachedModels(MODELS);
    const result = await handleModelCommand("claude-opus-4-6", undefined, noopPick, undefined, print);
    expect(result).toBe("claude-opus-4-6");
    expect(printed.join("")).toContain("Opus 4.6");
  });

  it("rejects unknown alias when cache is available", async () => {
    setCachedModels(MODELS);
    const result = await handleModelCommand("unknown", "claude-opus-4-6", noopPick, undefined, print);
    expect(result).toBe("claude-opus-4-6"); // unchanged
    expect(printed.join("")).toContain("Unknown model");
  });

  it("'default' resets to undefined", async () => {
    const result = await handleModelCommand("default", "claude-opus-4-6", noopPick, undefined, print);
    expect(result).toBeUndefined();
    expect(printed.join("")).toContain("default");
  });

  it("accepts value as-is when no cache", async () => {
    const result = await handleModelCommand("opus", undefined, noopPick, undefined, print);
    expect(result).toBe("opus");
  });

  it("fetches models via fetchModelsFn when cache is empty", async () => {
    const fetchFn = vi.fn().mockResolvedValue(MODELS);
    const result = await handleModelCommand("sonnet", undefined, noopPick, fetchFn, print);
    expect(fetchFn).toHaveBeenCalled();
    expect(result).toBe("claude-sonnet-4-6");
  });
});

// ── Interactive picker ──────────────────────────────────────────────────────

describe("/model (interactive picker)", () => {
  it("shows message when no cache available", async () => {
    const result = await handleModelCommand("", "opus", noopPick, undefined, print);
    expect(result).toBe("opus"); // unchanged
    expect(printed.join("")).toContain("No model list available");
  });

  it("selecting first entry resets to undefined (default)", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "selected", index: 0 });
    const result = await handleModelCommand("", "claude-opus-4-6", pickFn, undefined, print);
    expect(result).toBeUndefined();
  });

  it("selecting a named model returns its value", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "selected", index: 1 });
    const result = await handleModelCommand("", undefined, pickFn, undefined, print);
    expect(result).toBe("claude-opus-4-6");
    expect(printed.join("")).toContain("Opus 4.6");
  });

  it("passes currentIdx matching the active model", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "cancelled" });
    await handleModelCommand("", "claude-sonnet-4-6", pickFn, undefined, print);
    // currentIdx should be 0 (index of claude-sonnet-4-6 in MODELS)
    expect(pickFn.mock.calls[0][1]).toBe(0);
  });

  it("passes currentIdx 0 when no model set (default)", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "cancelled" });
    await handleModelCommand("", undefined, pickFn, undefined, print);
    expect(pickFn.mock.calls[0][1]).toBe(0);
  });

  it("shows model descriptions in options", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "cancelled" });
    await handleModelCommand("", undefined, pickFn, undefined, print);
    const options = pickFn.mock.calls[0][0] as string[];
    expect(options[0]).toContain("Best for everyday tasks");
  });

  it("includes Other: as last option", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "cancelled" });
    await handleModelCommand("", undefined, pickFn, undefined, print);
    const options = pickFn.mock.calls[0][0] as string[];
    expect(options[options.length - 1]).toContain("Other");
  });

  it("cancel preserves current model", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "cancelled" });
    const result = await handleModelCommand("", "claude-opus-4-6", pickFn, undefined, print);
    expect(result).toBe("claude-opus-4-6");
  });

  it("Other with valid model ID sets it", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "other", text: "claude-haiku-4-5-20251001" });
    const result = await handleModelCommand("", undefined, pickFn, undefined, print);
    expect(result).toBe("claude-haiku-4-5-20251001");
    expect(printed.join("")).toContain("Haiku 4.5");
  });

  it("Other with invalid model ID rejects", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "other", text: "not-a-model" });
    const result = await handleModelCommand("", "claude-opus-4-6", pickFn, undefined, print);
    expect(result).toBe("claude-opus-4-6"); // unchanged
    expect(printed.join("")).toContain("Unknown model");
  });

  it("Other with empty input preserves current", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "other", text: "" });
    const result = await handleModelCommand("", "claude-opus-4-6", pickFn, undefined, print);
    expect(result).toBe("claude-opus-4-6");
  });
});

// ── Display names ───────────────────────────────────────────────────────────

describe("display names", () => {
  it("uses displayName from model info, not raw alias", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "cancelled" });
    await handleModelCommand("", undefined, pickFn, undefined, print);
    const options = pickFn.mock.calls[0][0] as string[];
    // Should show "Sonnet 4.6" not "sonnet" or "claude-sonnet-4-6"
    expect(options[0]).toMatch(/^Sonnet 4\.6/);
    expect(options[1]).toMatch(/^Opus 4\.6/);
    expect(options[2]).toMatch(/^Haiku 4\.5/);
  });
});

// ── findModel matching ──────────────────────────────────────────────────────

describe("findModel", () => {
  const DATED_MODELS = [
    { value: "claude-sonnet-4-6-20250514", displayName: "Sonnet 4.6", description: "" },
    { value: "claude-opus-4-6-20250514", displayName: "Opus 4.6", description: "" },
  ];

  it("exact match", () => {
    expect(findModel(MODELS, "claude-opus-4-6")?.value).toBe("claude-opus-4-6");
  });

  it("value starts with input (prefix match)", () => {
    expect(findModel(DATED_MODELS, "claude-opus-4-6")?.displayName).toBe("Opus 4.6");
  });

  it("input starts with value", () => {
    expect(findModel(MODELS, "claude-opus-4-6-20250514")?.value).toBe("claude-opus-4-6");
  });

  it("alias without claude- prefix", () => {
    expect(findModel(MODELS, "sonnet")?.value).toBe("claude-sonnet-4-6");
  });

  it("substring match (value contains input)", () => {
    expect(findModel(DATED_MODELS, "opus-4-6")?.displayName).toBe("Opus 4.6");
  });

  it("returns undefined for no match", () => {
    expect(findModel(MODELS, "gpt-4")).toBeUndefined();
  });
});
