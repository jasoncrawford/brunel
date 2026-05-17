import { describe, it, expect, vi, beforeEach } from "vitest";
import { Settings } from "../src/agent/models/settings.js";
import { SettingsController } from "../src/agent/controllers/settings-controller.js";
import type { PickConfig, PickResult } from "../src/agent/views/picker.js";
import { stripAnsi } from "./helpers.js";

const MODELS = [
  { value: "default", displayName: "Default (recommended)", description: "Best for everyday tasks" },
  { value: "opus", displayName: "Opus 4.6", description: "Most capable for complex work" },
  { value: "haiku", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
];

let printed: string[];
const print = (s: string | null) => { if (s != null) printed.push(stripAnsi(s)); };
const display = { print, printForemanMessage: () => {} };

function makePicker(pickResult: PickResult = { type: "cancelled" }) {
  return {
    pick: vi.fn<(options: string[], config: PickConfig) => Promise<PickResult>>()
      .mockResolvedValue(pickResult),
    pickSettingsMenu: vi.fn().mockResolvedValue({ type: "cancelled" }),
  };
}

function makeCtrl(s: Settings, picker = makePicker()): SettingsController {
  return new SettingsController(s, display, picker);
}

beforeEach(() => {
  printed = [];
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
    const s = new Settings();
    s.setCachedModels(MODELS);
    const onChange = vi.fn();
    s.on("change", onChange);
    await makeCtrl(s).pickModel("opus", undefined);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("emits change when effort is updated via pickEffort", async () => {
    const s = new Settings();
    const onChange = vi.fn();
    s.on("change", onChange);
    await makeCtrl(s).pickEffort("high");
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("does not emit change when pickModel is cancelled", async () => {
    const s = new Settings({ model: "opus" });
    s.setCachedModels(MODELS);
    const onChange = vi.fn();
    s.on("change", onChange);
    await makeCtrl(s).pickModel("", undefined);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not emit change when pickEffort is cancelled", async () => {
    const s = new Settings({ effort: "max" });
    const onChange = vi.fn();
    s.on("change", onChange);
    await makeCtrl(s).pickEffort("");
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ── pickEffort: direct set via argument ──────────────────────────────────────

describe("pickEffort <arg> (direct set)", () => {
  it("sets effort by known level", async () => {
    const s = new Settings();
    await makeCtrl(s).pickEffort("low");
    expect(s.effort).toBe("low");
    expect(printed.join("")).toContain("low");
  });

  it("sets each valid level", async () => {
    for (const level of ["low", "medium", "high", "max"] as const) {
      const s = new Settings();
      await makeCtrl(s).pickEffort(level);
      expect(s.effort).toBe(level);
    }
  });

  it("'auto' resets to undefined", async () => {
    const s = new Settings({ effort: "low" });
    await makeCtrl(s).pickEffort("auto");
    expect(s.effort).toBeUndefined();
    expect(printed.join("")).toContain("auto");
  });

  it("rejects unknown levels", async () => {
    const s = new Settings({ effort: "high" });
    await makeCtrl(s).pickEffort("turbo");
    expect(s.effort).toBe("high"); // unchanged
    const output = printed.join("");
    expect(output).toMatch(/unknown|invalid/i);
    expect(output).toContain("turbo");
  });
});

// ── pickEffort: interactive picker ───────────────────────────────────────────

describe("pickEffort (interactive picker)", () => {
  it("shows picker with all levels including auto", async () => {
    const picker = makePicker();
    const s = new Settings();
    await makeCtrl(s, picker).pickEffort("");
    const options = picker.pick.mock.calls[0][0] as string[];
    expect(options.length).toBe(Settings.EFFORT_LEVELS.length);
    expect(options[0]).toMatch(/auto/i);
  });

  it("selecting auto resets to undefined", async () => {
    const picker = makePicker({ type: "selected", index: 0 }); // auto is first
    const s = new Settings({ effort: "high" });
    await makeCtrl(s, picker).pickEffort("");
    expect(s.effort).toBeUndefined();
  });

  it("selecting a named level sets the effort", async () => {
    // Settings.EFFORT_LEVELS: auto, low, medium, high, max — "low" is index 1
    const picker = makePicker({ type: "selected", index: 1 });
    const s = new Settings();
    await makeCtrl(s, picker).pickEffort("");
    expect(s.effort).toBe("low");
    expect(printed.join("")).toContain("low");
  });

  it("passes currentIdx matching the active effort", async () => {
    const picker = makePicker();
    // "high" is index 3 in [auto, low, medium, high, max]
    const s = new Settings({ effort: "high" });
    await makeCtrl(s, picker).pickEffort("");
    expect(picker.pick.mock.calls[0][1].currentIdx).toBe(3);
  });

  it("passes currentIdx 0 when no effort set (auto)", async () => {
    const picker = makePicker();
    const s = new Settings();
    await makeCtrl(s, picker).pickEffort("");
    expect(picker.pick.mock.calls[0][1].currentIdx).toBe(0);
  });

  it("cancel preserves current effort", async () => {
    const s = new Settings({ effort: "max" });
    await makeCtrl(s).pickEffort("");
    expect(s.effort).toBe("max");
  });

  it("selecting already-active auto is a no-op", async () => {
    const picker = makePicker({ type: "selected", index: 0 });
    const s = new Settings();
    await makeCtrl(s, picker).pickEffort("");
    expect(s.effort).toBeUndefined();
  });
});

// ── pickModel: direct set via argument ───────────────────────────────────────

describe("pickModel <arg> (direct set)", () => {
  it("sets model by known alias", async () => {
    const s = new Settings();
    s.setCachedModels(MODELS);
    await makeCtrl(s).pickModel("opus", undefined);
    expect(s.model).toBe("opus");
    expect(printed.join("")).toContain("Opus 4.6");
  });

  it("warns but accepts unknown model", async () => {
    const s = new Settings();
    s.setCachedModels(MODELS);
    await makeCtrl(s).pickModel("claude-sonnet-4-6-20250514", undefined);
    expect(s.model).toBe("claude-sonnet-4-6-20250514");
    const output = printed.join("");
    expect(output).toContain("claude-sonnet-4-6-20250514");
    expect(output).toMatch(/unknown|warning|not recognized/i);
  });

  it("'default' resets to undefined", async () => {
    const s = new Settings({ model: "opus" });
    await makeCtrl(s).pickModel("default", undefined);
    expect(s.model).toBeUndefined();
    expect(printed.join("")).toContain("default");
  });

  it("'sonnet' is stored as-is, not silently mapped to default", async () => {
    const s = new Settings({ model: "opus" });
    s.setCachedModels(MODELS);
    await makeCtrl(s).pickModel("sonnet", undefined);
    expect(s.model).toBe("sonnet");
    const output = printed.join("");
    expect(output).toMatch(/warning|unknown/i);
    expect(output).toContain("sonnet");
  });

  it("accepts value as-is when no cache", async () => {
    const s = new Settings();
    await makeCtrl(s).pickModel("opus", undefined);
    expect(s.model).toBe("opus");
  });

  it("fetches models via fetchModelsFn when cache is empty", async () => {
    const fetchFn = vi.fn().mockResolvedValue(MODELS);
    const s = new Settings();
    await makeCtrl(s).pickModel("opus", fetchFn);
    expect(fetchFn).toHaveBeenCalled();
    expect(s.model).toBe("opus");
  });
});

// ── pickModel: interactive picker ────────────────────────────────────────────

describe("pickModel (interactive picker)", () => {
  it("shows message when no cache available", async () => {
    const s = new Settings({ model: "opus" });
    await makeCtrl(s).pickModel("", undefined);
    expect(s.model).toBe("opus"); // unchanged
    expect(printed.join("")).toContain("No model list available");
  });

  it("selecting first entry stores that entry's literal value", async () => {
    const picker = makePicker({ type: "selected", index: 0 });
    const s = new Settings({ model: "opus" });
    s.setCachedModels(MODELS);
    await makeCtrl(s, picker).pickModel("", undefined);
    expect(s.model).toBe(MODELS[0].value); // "default" stored literally, not undefined
  });

  it("selecting a named model sets the model", async () => {
    const picker = makePicker({ type: "selected", index: 1 });
    const s = new Settings();
    s.setCachedModels(MODELS);
    await makeCtrl(s, picker).pickModel("", undefined);
    expect(s.model).toBe("opus");
    expect(printed.join("")).toContain("Opus 4.6");
  });

  it("passes currentIdx matching the active model", async () => {
    const picker = makePicker();
    const s = new Settings({ model: "opus" });
    s.setCachedModels(MODELS);
    await makeCtrl(s, picker).pickModel("", undefined);
    expect(picker.pick.mock.calls[0][1].currentIdx).toBe(1);
  });

  it("passes currentIdx -1 when no model set (nothing pre-selected)", async () => {
    const picker = makePicker();
    const s = new Settings();
    s.setCachedModels(MODELS);
    await makeCtrl(s, picker).pickModel("", undefined);
    expect(picker.pick.mock.calls[0][1].currentIdx).toBe(-1);
  });

  it("shows model descriptions in options", async () => {
    const picker = makePicker();
    const s = new Settings();
    s.setCachedModels(MODELS);
    await makeCtrl(s, picker).pickModel("", undefined);
    const options = picker.pick.mock.calls[0][0] as string[];
    expect(options[0]).toContain("Best for everyday tasks");
  });

  it("does not include Other option", async () => {
    const picker = makePicker();
    const s = new Settings();
    s.setCachedModels(MODELS);
    await makeCtrl(s, picker).pickModel("", undefined);
    const options = picker.pick.mock.calls[0][0] as string[];
    expect(options.length).toBe(MODELS.length);
    expect(options.every(o => !o.includes("Other"))).toBe(true);
  });

  it("cancel preserves current model", async () => {
    const s = new Settings({ model: "opus" });
    s.setCachedModels(MODELS);
    await makeCtrl(s).pickModel("", undefined);
    expect(s.model).toBe("opus");
  });

  it("uses displayName from model info, not raw alias", async () => {
    const picker = makePicker();
    const s = new Settings();
    s.setCachedModels(MODELS);
    await makeCtrl(s, picker).pickModel("", undefined);
    const options = picker.pick.mock.calls[0][0] as string[];
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
    expect(Settings.findModel(SDK_MODELS, "default")?.displayName).toBe("Default (recommended)");
    expect(Settings.findModel(SDK_MODELS, "opus")?.displayName).toBe("Opus");
    expect(Settings.findModel(SDK_MODELS, "haiku")?.displayName).toBe("Haiku");
    expect(Settings.findModel(SDK_MODELS, "opus[1m]")?.displayName).toBe("Opus (1M context)");
  });

  it("does not match full model IDs via substring", () => {
    expect(Settings.findModel(SDK_MODELS, "claude-sonnet-4-6")).toBeUndefined();
    expect(Settings.findModel(SDK_MODELS, "claude-opus-4-6")).toBeUndefined();
    expect(Settings.findModel(SDK_MODELS, "claude-haiku-4-5")).toBeUndefined();
  });

  it("returns undefined for no match", () => {
    expect(Settings.findModel(SDK_MODELS, "gpt-4")).toBeUndefined();
    expect(Settings.findModel(SDK_MODELS, "nope")).toBeUndefined();
  });
});

// ── Settings: verbose and thinkOutLoud ────────────────────────────────────────

describe("Settings: verbose", () => {
  it("defaults verbose to false", () => {
    const s = new Settings();
    expect(s.verbose).toBe(false);
  });

  it("initialises verbose from constructor", () => {
    const s = new Settings({ verbose: true });
    expect(s.verbose).toBe(true);
  });

  it("emits change when verbose is updated", () => {
    const s = new Settings();
    const onChange = vi.fn();
    s.on("change", onChange);
    s._setVerbose(true);
    expect(onChange).toHaveBeenCalledOnce();
  });
});

describe("Settings: thinkOutLoud", () => {
  it("defaults thinkOutLoud to 'default'", () => {
    const s = new Settings();
    expect(s.thinkOutLoud).toBe("default");
  });

  it("initialises thinkOutLoud to 'default' when not passed", () => {
    const s = new Settings({ verbose: true });
    expect(s.thinkOutLoud).toBe("default");
  });

  it("initialises thinkOutLoud to true when passed true", () => {
    const s = new Settings({ thinkOutLoud: true });
    expect(s.thinkOutLoud).toBe(true);
  });

  it("initialises thinkOutLoud to false when passed false", () => {
    const s = new Settings({ thinkOutLoud: false });
    expect(s.thinkOutLoud).toBe(false);
  });

  it("emits change when thinkOutLoud is updated", () => {
    const s = new Settings();
    const onChange = vi.fn();
    s.on("change", onChange);
    s._setThinkOutLoud(true);
    expect(onChange).toHaveBeenCalledOnce();
  });
});

describe("Settings: effectiveThinkOutLoud", () => {
  it("returns verbose value when thinkOutLoud is 'default'", () => {
    expect(new Settings({ verbose: true }).effectiveThinkOutLoud).toBe(true);
    expect(new Settings({ verbose: false }).effectiveThinkOutLoud).toBe(false);
  });

  it("returns thinkOutLoud value when explicitly set", () => {
    expect(new Settings({ verbose: false, thinkOutLoud: true }).effectiveThinkOutLoud).toBe(true);
    expect(new Settings({ verbose: true, thinkOutLoud: false }).effectiveThinkOutLoud).toBe(false);
  });
});

// ── pickVerbose: direct set via argument ──────────────────────────────────────

describe("pickVerbose <arg> (direct set)", () => {
  it("sets verbose to true with 'true'", async () => {
    const s = new Settings();
    await makeCtrl(s).pickVerbose("true");
    expect(s.verbose).toBe(true);
  });

  it("sets verbose to true with alias 'on'", async () => {
    const s = new Settings();
    await makeCtrl(s).pickVerbose("on");
    expect(s.verbose).toBe(true);
  });

  it("sets verbose to true with alias 'yes'", async () => {
    const s = new Settings();
    await makeCtrl(s).pickVerbose("yes");
    expect(s.verbose).toBe(true);
  });

  it("sets verbose to true with alias 'y'", async () => {
    const s = new Settings();
    await makeCtrl(s).pickVerbose("y");
    expect(s.verbose).toBe(true);
  });

  it("sets verbose to false with 'false'", async () => {
    const s = new Settings({ verbose: true });
    await makeCtrl(s).pickVerbose("false");
    expect(s.verbose).toBe(false);
  });

  it("sets verbose to false with alias 'off'", async () => {
    const s = new Settings({ verbose: true });
    await makeCtrl(s).pickVerbose("off");
    expect(s.verbose).toBe(false);
  });

  it("sets verbose to false with alias 'no'", async () => {
    const s = new Settings({ verbose: true });
    await makeCtrl(s).pickVerbose("no");
    expect(s.verbose).toBe(false);
  });

  it("sets verbose to false with alias 'n'", async () => {
    const s = new Settings({ verbose: true });
    await makeCtrl(s).pickVerbose("n");
    expect(s.verbose).toBe(false);
  });

  it("is case-insensitive", async () => {
    const s = new Settings();
    await makeCtrl(s).pickVerbose("ON");
    expect(s.verbose).toBe(true);
    await makeCtrl(s).pickVerbose("OFF");
    expect(s.verbose).toBe(false);
    await makeCtrl(s).pickVerbose("True");
    expect(s.verbose).toBe(true);
  });

  it("rejects unknown values", async () => {
    const s = new Settings();
    await makeCtrl(s).pickVerbose("maybe");
    expect(s.verbose).toBe(false); // unchanged
    const output = printed.join("");
    expect(output).toMatch(/unknown|invalid/i);
    expect(output).toContain("maybe");
  });
});

// ── pickVerbose: interactive picker ──────────────────────────────────────────

describe("pickVerbose (interactive picker)", () => {
  it("shows picker with all verbose options", async () => {
    const picker = makePicker();
    const s = new Settings();
    await makeCtrl(s, picker).pickVerbose("");
    const options = picker.pick.mock.calls[0][0] as string[];
    expect(options.length).toBe(Settings.VERBOSE_OPTIONS.length);
  });

  it("passes currentIdx matching the active verbose value", async () => {
    const picker = makePicker();
    const s = new Settings({ verbose: true });
    await makeCtrl(s, picker).pickVerbose("");
    const onIdx = Settings.VERBOSE_OPTIONS.findIndex(o => o.value === "true");
    expect(picker.pick.mock.calls[0][1].currentIdx).toBe(onIdx);
  });

  it("cancel preserves current verbose", async () => {
    const s = new Settings({ verbose: true });
    await makeCtrl(s).pickVerbose("");
    expect(s.verbose).toBe(true);
  });

  it("selecting an option changes verbose", async () => {
    const offIdx = Settings.VERBOSE_OPTIONS.findIndex(o => o.value === "false");
    const picker = makePicker({ type: "selected", index: offIdx });
    const s = new Settings({ verbose: true });
    await makeCtrl(s, picker).pickVerbose("");
    expect(s.verbose).toBe(false);
  });
});

// ── pickThinkOutLoud: direct set via argument ─────────────────────────────────

describe("pickThinkOutLoud <arg> (direct set)", () => {
  it("sets thinkOutLoud to 'default' with 'default'", async () => {
    const s = new Settings({ thinkOutLoud: true });
    await makeCtrl(s).pickThinkOutLoud("default");
    expect(s.thinkOutLoud).toBe("default");
  });

  it("sets thinkOutLoud to true with 'true'", async () => {
    const s = new Settings();
    await makeCtrl(s).pickThinkOutLoud("true");
    expect(s.thinkOutLoud).toBe(true);
  });

  it("sets thinkOutLoud to true with alias 'on'", async () => {
    const s = new Settings();
    await makeCtrl(s).pickThinkOutLoud("on");
    expect(s.thinkOutLoud).toBe(true);
  });

  it("sets thinkOutLoud to false with 'false'", async () => {
    const s = new Settings({ thinkOutLoud: true });
    await makeCtrl(s).pickThinkOutLoud("false");
    expect(s.thinkOutLoud).toBe(false);
  });

  it("sets thinkOutLoud to false with alias 'off'", async () => {
    const s = new Settings({ thinkOutLoud: true });
    await makeCtrl(s).pickThinkOutLoud("off");
    expect(s.thinkOutLoud).toBe(false);
  });

  it("is case-insensitive", async () => {
    const s = new Settings();
    await makeCtrl(s).pickThinkOutLoud("ON");
    expect(s.thinkOutLoud).toBe(true);
    await makeCtrl(s).pickThinkOutLoud("Default");
    expect(s.thinkOutLoud).toBe("default");
  });

  it("rejects unknown values", async () => {
    const s = new Settings();
    await makeCtrl(s).pickThinkOutLoud("sometimes");
    expect(s.thinkOutLoud).toBe("default"); // unchanged
    const output = printed.join("");
    expect(output).toMatch(/unknown|invalid/i);
    expect(output).toContain("sometimes");
  });
});

// ── pickThinkOutLoud: interactive picker ───────────────────────────────────────

describe("pickThinkOutLoud (interactive picker)", () => {
  it("shows picker with all think-out-loud options", async () => {
    const picker = makePicker();
    const s = new Settings();
    await makeCtrl(s, picker).pickThinkOutLoud("");
    const options = picker.pick.mock.calls[0][0] as string[];
    expect(options.length).toBe(Settings.THINK_OUT_LOUD_OPTIONS.length);
  });

  it("passes currentIdx for 'default'", async () => {
    const picker = makePicker();
    const s = new Settings();
    await makeCtrl(s, picker).pickThinkOutLoud("");
    const defaultIdx = Settings.THINK_OUT_LOUD_OPTIONS.findIndex(o => o.value === "default");
    expect(picker.pick.mock.calls[0][1].currentIdx).toBe(defaultIdx);
  });

  it("passes currentIdx for true", async () => {
    const picker = makePicker();
    const s = new Settings({ thinkOutLoud: true });
    await makeCtrl(s, picker).pickThinkOutLoud("");
    const trueIdx = Settings.THINK_OUT_LOUD_OPTIONS.findIndex(o => o.value === "true");
    expect(picker.pick.mock.calls[0][1].currentIdx).toBe(trueIdx);
  });

  it("cancel preserves current thinkOutLoud", async () => {
    const s = new Settings({ thinkOutLoud: true });
    await makeCtrl(s).pickThinkOutLoud("");
    expect(s.thinkOutLoud).toBe(true);
  });

  it("selecting 'default' sets thinkOutLoud to 'default'", async () => {
    const defaultIdx = Settings.THINK_OUT_LOUD_OPTIONS.findIndex(o => o.value === "default");
    const picker = makePicker({ type: "selected", index: defaultIdx });
    const s = new Settings({ thinkOutLoud: true });
    await makeCtrl(s, picker).pickThinkOutLoud("");
    expect(s.thinkOutLoud).toBe("default");
  });

  it("selecting 'true' sets thinkOutLoud to true", async () => {
    const trueIdx = Settings.THINK_OUT_LOUD_OPTIONS.findIndex(o => o.value === "true");
    const picker = makePicker({ type: "selected", index: trueIdx });
    const s = new Settings();
    await makeCtrl(s, picker).pickThinkOutLoud("");
    expect(s.thinkOutLoud).toBe(true);
  });

  it("selecting 'false' sets thinkOutLoud to false", async () => {
    const falseIdx = Settings.THINK_OUT_LOUD_OPTIONS.findIndex(o => o.value === "false");
    const picker = makePicker({ type: "selected", index: falseIdx });
    const s = new Settings({ thinkOutLoud: true });
    await makeCtrl(s, picker).pickThinkOutLoud("");
    expect(s.thinkOutLoud).toBe(false);
  });
});
