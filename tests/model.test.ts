import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleModelCommand, setCachedModels, _resetCachedModels, getCachedModels, findModel, validateModel, validateConfigModel } from "../src/model.js";
import type { PickResult } from "../src/input.js";
import { stripAnsi } from "./helpers.js";

const MODELS = [
  { value: "sonnet", displayName: "Sonnet 4.6", description: "Best for everyday tasks" },
  { value: "opus", displayName: "Opus 4.6", description: "Most capable for complex work" },
  { value: "haiku", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
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
    expect(result).toBe("sonnet");
    expect(printed.join("")).toContain("Sonnet 4.6");
  });

  it("sets model by full ID via substring match", async () => {
    setCachedModels(MODELS);
    const result = await handleModelCommand("claude-opus-4-6", undefined, noopPick, undefined, print);
    expect(result).toBe("opus");
    expect(printed.join("")).toContain("Opus 4.6");
  });

  it("rejects unknown alias when cache is available", async () => {
    setCachedModels(MODELS);
    const result = await handleModelCommand("unknown", "opus", noopPick, undefined, print);
    expect(result).toBe("opus"); // unchanged
    expect(printed.join("")).toContain("Unknown model");
  });

  it("'default' resets to undefined", async () => {
    const result = await handleModelCommand("default", "opus", noopPick, undefined, print);
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
    expect(result).toBe("sonnet");
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
    const result = await handleModelCommand("", "opus", pickFn, undefined, print);
    expect(result).toBeUndefined();
  });

  it("selecting a named model returns its value", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "selected", index: 1 });
    const result = await handleModelCommand("", undefined, pickFn, undefined, print);
    expect(result).toBe("opus");
    expect(printed.join("")).toContain("Opus 4.6");
  });

  it("passes currentIdx matching the active model", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "cancelled" });
    await handleModelCommand("", "sonnet", pickFn, undefined, print);
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
    const result = await handleModelCommand("", "opus", pickFn, undefined, print);
    expect(result).toBe("opus");
  });

  it("Other with valid alias sets it", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "other", text: "haiku" });
    const result = await handleModelCommand("", undefined, pickFn, undefined, print);
    expect(result).toBe("haiku");
    expect(printed.join("")).toContain("Haiku 4.5");
  });

  it("Other with full model ID sets it via substring", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "other", text: "claude-haiku-4-5" });
    const result = await handleModelCommand("", undefined, pickFn, undefined, print);
    expect(result).toBe("haiku");
    expect(printed.join("")).toContain("Haiku 4.5");
  });

  it("Other with unknown string accepts it as-is", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "other", text: "claude-custom-model-2025" });
    const result = await handleModelCommand("", "opus", pickFn, undefined, print);
    expect(result).toBe("claude-custom-model-2025");
    expect(printed.join("")).toContain("claude-custom-model-2025");
  });

  it("Other with empty input preserves current", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "other", text: "" });
    const result = await handleModelCommand("", "opus", pickFn, undefined, print);
    expect(result).toBe("opus");
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
    expect(options[0]).toMatch(/^Sonnet 4\.6/);
    expect(options[1]).toMatch(/^Opus 4\.6/);
    expect(options[2]).toMatch(/^Haiku 4\.5/);
  });
});

// ── validateModel ───────────────────────────────────────────────────────────

describe("validateModel", () => {
  it("accepts known alias", () => {
    expect(validateModel(MODELS, "sonnet")).toBeUndefined();
  });

  it("accepts full model ID via substring match", () => {
    expect(validateModel(MODELS, "claude-opus-4-6")).toBeUndefined();
  });

  it("accepts unknown string containing claude-", () => {
    expect(validateModel(MODELS, "claude-sonnet-4-6-20250514")).toBeUndefined();
  });

  it("rejects unknown string without claude-", () => {
    const error = validateModel(MODELS, "nope");
    expect(error).toContain("Unknown model");
    expect(error).toContain("sonnet");
    expect(error).toContain("opus");
    expect(error).toContain("haiku");
  });
});

// ── validateConfigModel ─────────────────────────────────────────────────────

describe("validateConfigModel", () => {
  it("returns resolved alias for known model", async () => {
    const fetchFn = vi.fn().mockResolvedValue(MODELS);
    const onError = vi.fn();
    const result = await validateConfigModel("claude-opus-4-6", fetchFn, onError);
    expect(result).toBe("opus");
    expect(onError).not.toHaveBeenCalled();
  });

  it("caches models after fetch", async () => {
    const fetchFn = vi.fn().mockResolvedValue(MODELS);
    await validateConfigModel("sonnet", fetchFn, vi.fn());
    expect(getCachedModels()).toEqual(MODELS);
  });

  it("calls onError and returns undefined for invalid model", async () => {
    const fetchFn = vi.fn().mockResolvedValue(MODELS);
    const onError = vi.fn();
    const result = await validateConfigModel("nope", fetchFn, onError);
    expect(result).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("Unknown model"));
  });

  it("accepts full model ID with claude- prefix", async () => {
    const fetchFn = vi.fn().mockResolvedValue(MODELS);
    const onError = vi.fn();
    const result = await validateConfigModel("claude-custom-model-2025", fetchFn, onError);
    expect(result).toBe("claude-custom-model-2025");
    expect(onError).not.toHaveBeenCalled();
  });

  it("returns model as-is when fetch fails", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network"));
    const onError = vi.fn();
    const result = await validateConfigModel("whatever", fetchFn, onError);
    expect(result).toBe("whatever");
    expect(onError).not.toHaveBeenCalled();
  });
});

// ── findModel matching ──────────────────────────────────────────────────────

describe("findModel", () => {
  // Realistic SDK values: short aliases, null for Default
  const SDK_MODELS = [
    { value: null as unknown as string, displayName: "Default (recommended)", description: "Sonnet 4.6" },
    { value: "sonnet", displayName: "Sonnet", description: "Sonnet 4.6" },
    { value: "sonnet[1m]", displayName: "Sonnet (1M context)", description: "" },
    { value: "opus", displayName: "Opus", description: "Opus 4.6" },
    { value: "opus[1m]", displayName: "Opus (1M context)", description: "" },
    { value: "haiku", displayName: "Haiku", description: "Haiku 4.5" },
  ];

  it("exact match on short alias", () => {
    expect(findModel(SDK_MODELS, "sonnet")?.displayName).toBe("Sonnet");
    expect(findModel(SDK_MODELS, "opus")?.displayName).toBe("Opus");
    expect(findModel(SDK_MODELS, "haiku")?.displayName).toBe("Haiku");
    expect(findModel(SDK_MODELS, "opus[1m]")?.displayName).toBe("Opus (1M context)");
  });

  it("full model ID matches via substring (input contains value)", () => {
    expect(findModel(SDK_MODELS, "claude-sonnet-4-6")?.value).toBe("sonnet");
    expect(findModel(SDK_MODELS, "claude-opus-4-6")?.value).toBe("opus");
    expect(findModel(SDK_MODELS, "claude-haiku-4-5")?.value).toBe("haiku");
  });

  it("skips null-value entries without crashing", () => {
    expect(findModel(SDK_MODELS, "claude-sonnet-4-6")).toBeDefined();
    expect(findModel(SDK_MODELS, "nonexistent")).toBeUndefined();
  });

  it("returns undefined for no match", () => {
    expect(findModel(SDK_MODELS, "gpt-4")).toBeUndefined();
  });
});
