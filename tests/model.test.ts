import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleModelCommand, setCachedModels, _resetCachedModels, findModel } from "../src/agent/model.js";
import type { PickResult } from "../src/agent/input.js";
import { stripAnsi } from "./helpers.js";

const MODELS = [
  { value: "default", displayName: "Default (recommended)", description: "Best for everyday tasks" },
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
  it("sets model by known alias", async () => {
    setCachedModels(MODELS);
    const result = await handleModelCommand("opus", undefined, noopPick, undefined, print);
    expect(result).toBe("opus");
    expect(printed.join("")).toContain("Opus 4.6");
  });

  it("warns but accepts unknown model", async () => {
    setCachedModels(MODELS);
    const result = await handleModelCommand("claude-sonnet-4-6-20250514", undefined, noopPick, undefined, print);
    expect(result).toBe("claude-sonnet-4-6-20250514");
    const output = printed.join("");
    expect(output).toContain("claude-sonnet-4-6-20250514");
    expect(output).toMatch(/unknown|warning|not recognized/i);
  });

  it("'default' resets to undefined", async () => {
    const result = await handleModelCommand("default", "opus", noopPick, undefined, print);
    expect(result).toBeUndefined();
    expect(printed.join("")).toContain("default");
  });

  it("'sonnet' maps to default", async () => {
    setCachedModels(MODELS);
    const result = await handleModelCommand("sonnet", "opus", noopPick, undefined, print);
    expect(result).toBeUndefined();
    expect(printed.join("")).toContain("default");
  });

  it("accepts value as-is when no cache", async () => {
    const result = await handleModelCommand("opus", undefined, noopPick, undefined, print);
    expect(result).toBe("opus");
  });

  it("fetches models via fetchModelsFn when cache is empty", async () => {
    const fetchFn = vi.fn().mockResolvedValue(MODELS);
    const result = await handleModelCommand("opus", undefined, noopPick, fetchFn, print);
    expect(fetchFn).toHaveBeenCalled();
    expect(result).toBe("opus");
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
    await handleModelCommand("", "opus", pickFn, undefined, print);
    expect(pickFn.mock.calls[0][1]).toBe(1);
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

  it("does not include Other option", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "cancelled" });
    await handleModelCommand("", undefined, pickFn, undefined, print);
    const options = pickFn.mock.calls[0][0] as string[];
    expect(options.length).toBe(MODELS.length);
    expect(options.every(o => !o.includes("Other"))).toBe(true);
  });

  it("cancel preserves current model", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "cancelled" });
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
    expect(options[0]).toMatch(/^Default \(recommended\)/);
    expect(options[1]).toMatch(/^Opus 4\.6/);
    expect(options[2]).toMatch(/^Haiku 4\.5/);
  });
});

// ── findModel matching ──────────────────────────────────────────────────────

describe("findModel", () => {
  const SDK_MODELS = [
    { value: "default", displayName: "Default (recommended)", description: "Sonnet 4.6" },
    { value: "sonnet[1m]", displayName: "Sonnet (1M context)", description: "" },
    { value: "opus", displayName: "Opus", description: "Opus 4.6" },
    { value: "opus[1m]", displayName: "Opus (1M context)", description: "" },
    { value: "haiku", displayName: "Haiku", description: "Haiku 4.5" },
  ];

  it("exact match on short alias", () => {
    expect(findModel(SDK_MODELS, "default")?.displayName).toBe("Default (recommended)");
    expect(findModel(SDK_MODELS, "opus")?.displayName).toBe("Opus");
    expect(findModel(SDK_MODELS, "haiku")?.displayName).toBe("Haiku");
    expect(findModel(SDK_MODELS, "opus[1m]")?.displayName).toBe("Opus (1M context)");
  });

  it("does not match full model IDs via substring", () => {
    expect(findModel(SDK_MODELS, "claude-sonnet-4-6")).toBeUndefined();
    expect(findModel(SDK_MODELS, "claude-opus-4-6")).toBeUndefined();
    expect(findModel(SDK_MODELS, "claude-haiku-4-5")).toBeUndefined();
  });

  it("returns undefined for no match", () => {
    expect(findModel(SDK_MODELS, "gpt-4")).toBeUndefined();
    expect(findModel(SDK_MODELS, "nope")).toBeUndefined();
  });
});
