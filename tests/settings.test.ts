import { describe, it, expect, vi, beforeEach } from "vitest";
import { Settings, setCachedModels, _resetCachedModels } from "../src/agent/settings.js";
import type { PickResult } from "../src/agent/input.js";
import { stripAnsi } from "./helpers.js";

const MODELS = [
  { value: "default", displayName: "Default (recommended)", description: "Best for everyday tasks" },
  { value: "opus", displayName: "Opus 4.6", description: "Most capable for complex work" },
];

let printed: string[];
const print = (s: string) => { printed.push(stripAnsi(s)); };
const cancelPick = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
  .mockResolvedValue({ type: "cancelled" });

beforeEach(() => {
  _resetCachedModels();
  printed = [];
  cancelPick.mockResolvedValue({ type: "cancelled" });
});

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

  it("pickModel updates model", async () => {
    setCachedModels(MODELS);
    const s = new Settings();
    await s.pickModel("opus", cancelPick, undefined, print);
    expect(s.model).toBe("opus");
  });

  it("pickModel resets to undefined on 'default'", async () => {
    const s = new Settings({ model: "opus" });
    await s.pickModel("default", cancelPick, undefined, print);
    expect(s.model).toBeUndefined();
  });

  it("pickEffort updates effort", async () => {
    const s = new Settings();
    await s.pickEffort("high", cancelPick, print);
    expect(s.effort).toBe("high");
  });

  it("pickEffort resets to undefined on 'auto'", async () => {
    const s = new Settings({ effort: "low" });
    await s.pickEffort("auto", cancelPick, print);
    expect(s.effort).toBeUndefined();
  });

  it("pickModel with picker updates model", async () => {
    setCachedModels(MODELS);
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "selected", index: 1 }); // opus
    const s = new Settings();
    await s.pickModel("", pickFn, undefined, print);
    expect(s.model).toBe("opus");
  });

  it("pickEffort with picker updates effort", async () => {
    // EFFORT_LEVELS: auto(0), low(1), medium(2), high(3), max(4)
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "selected", index: 3 }); // high
    const s = new Settings();
    await s.pickEffort("", pickFn, print);
    expect(s.effort).toBe("high");
  });

  it("pickModel cancel preserves model", async () => {
    setCachedModels(MODELS);
    const s = new Settings({ model: "opus" });
    await s.pickModel("", cancelPick, undefined, print);
    expect(s.model).toBe("opus");
  });

  it("pickEffort cancel preserves effort", async () => {
    const s = new Settings({ effort: "max" });
    await s.pickEffort("", cancelPick, print);
    expect(s.effort).toBe("max");
  });
});
