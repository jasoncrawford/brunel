import { describe, it, expect, vi, beforeEach } from "vitest";
import { Settings, EFFORT_LEVELS, setCachedModels, _resetCachedModels, findModel } from "../src/agent/models/settings.js";
import type { PickResult } from "../src/agent/views/input.js";
import { stripAnsi } from "./helpers.js";

const MODELS = [
  { value: "default", displayName: "Default (recommended)", description: "Best for everyday tasks" },
  { value: "opus", displayName: "Opus 4.6", description: "Most capable for complex work" },
  { value: "haiku", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
];

let printed: string[];
const print = (s: string) => { printed.push(stripAnsi(s)); };
const noopPick = vi.fn();
const cancelPick = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
  .mockResolvedValue({ type: "cancelled" });

beforeEach(() => {
  _resetCachedModels();
  printed = [];
  cancelPick.mockResolvedValue({ type: "cancelled" });
});

// ── Settings class ───────────────────────────────────────────────────────────

describe("Settings", () => {
  it("initialises model and effort from constructor", () => {
    const s = new Settings({ model: "opus", effort: "high" });
    expect(s.model).toBe("opus");
    expect(s.effort).toBe("high");
  });

  it("defaults model and effort to undefined", () => {
    const s = new Settings();
    expect(s.model).toBeUndefined();
    expect(s.effort).toBeUndefined();
  });

  it("emits change when model is updated via pickModel", async () => {
    setCachedModels(MODELS);
    const s = new Settings();
    const onChange = vi.fn();
    s.on("change", onChange);
    await s.pickModel("opus", noopPick, undefined, print);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("emits change when effort is updated via pickEffort", async () => {
    const s = new Settings();
    const onChange = vi.fn();
    s.on("change", onChange);
    await s.pickEffort("high", noopPick, print);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("does not emit change when pickModel is cancelled", async () => {
    setCachedModels(MODELS);
    const s = new Settings({ model: "opus" });
    const onChange = vi.fn();
    s.on("change", onChange);
    await s.pickModel("", cancelPick, undefined, print);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not emit change when pickEffort is cancelled", async () => {
    const s = new Settings({ effort: "max" });
    const onChange = vi.fn();
    s.on("change", onChange);
    await s.pickEffort("", cancelPick, print);
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ── pickEffort: direct set via argument ──────────────────────────────────────

describe("pickEffort <arg> (direct set)", () => {
  it("sets effort by known level", async () => {
    const s = new Settings();
    await s.pickEffort("low", noopPick, print);
    expect(s.effort).toBe("low");
    expect(printed.join("")).toContain("low");
  });

  it("sets each valid level", async () => {
    for (const level of ["low", "medium", "high", "max"] as const) {
      const s = new Settings();
      await s.pickEffort(level, noopPick, print);
      expect(s.effort).toBe(level);
    }
  });

  it("'auto' resets to undefined", async () => {
    const s = new Settings({ effort: "low" });
    await s.pickEffort("auto", noopPick, print);
    expect(s.effort).toBeUndefined();
    expect(printed.join("")).toContain("auto");
  });

  it("rejects unknown levels", async () => {
    const s = new Settings({ effort: "high" });
    await s.pickEffort("turbo", noopPick, print);
    expect(s.effort).toBe("high"); // unchanged
    const output = printed.join("");
    expect(output).toMatch(/unknown|invalid/i);
    expect(output).toContain("turbo");
  });
});

// ── pickEffort: interactive picker ───────────────────────────────────────────

describe("pickEffort (interactive picker)", () => {
  it("shows picker with all levels including auto", async () => {
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "cancelled" });
    const s = new Settings();
    await s.pickEffort("", pickFn, print);
    const options = pickFn.mock.calls[0][0] as string[];
    expect(options.length).toBe(EFFORT_LEVELS.length);
    expect(options[0]).toMatch(/auto/i);
  });

  it("selecting auto resets to undefined", async () => {
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "selected", index: 0 }); // auto is first
    const s = new Settings({ effort: "high" });
    await s.pickEffort("", pickFn, print);
    expect(s.effort).toBeUndefined();
  });

  it("selecting a named level sets the effort", async () => {
    // EFFORT_LEVELS: auto, low, medium, high, max — "low" is index 1
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "selected", index: 1 });
    const s = new Settings();
    await s.pickEffort("", pickFn, print);
    expect(s.effort).toBe("low");
    expect(printed.join("")).toContain("low");
  });

  it("passes currentIdx matching the active effort", async () => {
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "cancelled" });
    // "high" is index 3 in [auto, low, medium, high, max]
    const s = new Settings({ effort: "high" });
    await s.pickEffort("", pickFn, print);
    expect(pickFn.mock.calls[0][1]).toBe(3);
  });

  it("passes currentIdx 0 when no effort set (auto)", async () => {
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "cancelled" });
    const s = new Settings();
    await s.pickEffort("", pickFn, print);
    expect(pickFn.mock.calls[0][1]).toBe(0);
  });

  it("cancel preserves current effort", async () => {
    const s = new Settings({ effort: "max" });
    await s.pickEffort("", cancelPick, print);
    expect(s.effort).toBe("max");
  });

  it("selecting already-active auto is a no-op", async () => {
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "selected", index: 0 });
    const s = new Settings();
    await s.pickEffort("", pickFn, print);
    expect(s.effort).toBeUndefined();
  });
});

// ── pickModel: direct set via argument ───────────────────────────────────────

describe("pickModel <arg> (direct set)", () => {
  it("sets model by known alias", async () => {
    setCachedModels(MODELS);
    const s = new Settings();
    await s.pickModel("opus", noopPick, undefined, print);
    expect(s.model).toBe("opus");
    expect(printed.join("")).toContain("Opus 4.6");
  });

  it("warns but accepts unknown model", async () => {
    setCachedModels(MODELS);
    const s = new Settings();
    await s.pickModel("claude-sonnet-4-6-20250514", noopPick, undefined, print);
    expect(s.model).toBe("claude-sonnet-4-6-20250514");
    const output = printed.join("");
    expect(output).toContain("claude-sonnet-4-6-20250514");
    expect(output).toMatch(/unknown|warning|not recognized/i);
  });

  it("'default' resets to undefined", async () => {
    const s = new Settings({ model: "opus" });
    await s.pickModel("default", noopPick, undefined, print);
    expect(s.model).toBeUndefined();
    expect(printed.join("")).toContain("default");
  });

  it("'sonnet' maps to default", async () => {
    setCachedModels(MODELS);
    const s = new Settings({ model: "opus" });
    await s.pickModel("sonnet", noopPick, undefined, print);
    expect(s.model).toBeUndefined();
    expect(printed.join("")).toContain("default");
  });

  it("accepts value as-is when no cache", async () => {
    const s = new Settings();
    await s.pickModel("opus", noopPick, undefined, print);
    expect(s.model).toBe("opus");
  });

  it("fetches models via fetchModelsFn when cache is empty", async () => {
    const fetchFn = vi.fn().mockResolvedValue(MODELS);
    const s = new Settings();
    await s.pickModel("opus", noopPick, fetchFn, print);
    expect(fetchFn).toHaveBeenCalled();
    expect(s.model).toBe("opus");
  });
});

// ── pickModel: interactive picker ────────────────────────────────────────────

describe("pickModel (interactive picker)", () => {
  it("shows message when no cache available", async () => {
    const s = new Settings({ model: "opus" });
    await s.pickModel("", noopPick, undefined, print);
    expect(s.model).toBe("opus"); // unchanged
    expect(printed.join("")).toContain("No model list available");
  });

  it("selecting first entry resets to undefined (default)", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "selected", index: 0 });
    const s = new Settings({ model: "opus" });
    await s.pickModel("", pickFn, undefined, print);
    expect(s.model).toBeUndefined();
  });

  it("selecting a named model sets the model", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "selected", index: 1 });
    const s = new Settings();
    await s.pickModel("", pickFn, undefined, print);
    expect(s.model).toBe("opus");
    expect(printed.join("")).toContain("Opus 4.6");
  });

  it("passes currentIdx matching the active model", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "cancelled" });
    const s = new Settings({ model: "opus" });
    await s.pickModel("", pickFn, undefined, print);
    expect(pickFn.mock.calls[0][1]).toBe(1);
  });

  it("passes currentIdx 0 when no model set (default)", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "cancelled" });
    const s = new Settings();
    await s.pickModel("", pickFn, undefined, print);
    expect(pickFn.mock.calls[0][1]).toBe(0);
  });

  it("shows model descriptions in options", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "cancelled" });
    const s = new Settings();
    await s.pickModel("", pickFn, undefined, print);
    const options = pickFn.mock.calls[0][0] as string[];
    expect(options[0]).toContain("Best for everyday tasks");
  });

  it("does not include Other option", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "cancelled" });
    const s = new Settings();
    await s.pickModel("", pickFn, undefined, print);
    const options = pickFn.mock.calls[0][0] as string[];
    expect(options.length).toBe(MODELS.length);
    expect(options.every(o => !o.includes("Other"))).toBe(true);
  });

  it("cancel preserves current model", async () => {
    setCachedModels(MODELS);
    const s = new Settings({ model: "opus" });
    await s.pickModel("", cancelPick, undefined, print);
    expect(s.model).toBe("opus");
  });

  it("uses displayName from model info, not raw alias", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "cancelled" });
    const s = new Settings();
    await s.pickModel("", pickFn, undefined, print);
    const options = pickFn.mock.calls[0][0] as string[];
    expect(options[0]).toMatch(/^Default \(recommended\)/);
    expect(options[1]).toMatch(/^Opus 4\.6/);
    expect(options[2]).toMatch(/^Haiku 4\.5/);
  });
});

// ── findModel matching ────────────────────────────────────────────────────────

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
