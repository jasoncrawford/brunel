import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleEffortCommand, EFFORT_LEVELS } from "../src/agent/settings.js";
import type { PickResult } from "../src/agent/input.js";
import { stripAnsi } from "./helpers.js";

let printed: string[];
const print = (s: string) => { printed.push(stripAnsi(s)); };
const noopPick = vi.fn();

beforeEach(() => {
  printed = [];
});

// ── Direct set via argument ─────────────────────────────────────────────────

describe("/effort <arg> (direct set)", () => {
  it("sets effort by known level", async () => {
    const result = await handleEffortCommand("low", undefined, noopPick, print);
    expect(result).toBe("low");
    expect(printed.join("")).toContain("low");
  });

  it("sets each valid level", async () => {
    for (const level of ["low", "medium", "high", "max"] as const) {
      printed = [];
      const result = await handleEffortCommand(level, undefined, noopPick, print);
      expect(result).toBe(level);
    }
  });

  it("'auto' resets to undefined", async () => {
    const result = await handleEffortCommand("auto", "low", noopPick, print);
    expect(result).toBeUndefined();
    expect(printed.join("")).toContain("auto");
  });

  it("rejects unknown levels", async () => {
    const result = await handleEffortCommand("turbo", "high", noopPick, print);
    expect(result).toBe("high"); // unchanged
    const output = printed.join("");
    expect(output).toMatch(/unknown|invalid/i);
    expect(output).toContain("turbo");
  });
});

// ── Interactive picker ──────────────────────────────────────────────────────

describe("/effort (interactive picker)", () => {
  it("shows picker with all levels including auto", async () => {
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "cancelled" });
    await handleEffortCommand("", undefined, pickFn, print);
    const options = pickFn.mock.calls[0][0] as string[];
    expect(options.length).toBe(EFFORT_LEVELS.length);
    // auto should be first
    expect(options[0]).toMatch(/auto/i);
  });

  it("selecting auto resets to undefined", async () => {
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "selected", index: 0 }); // auto is first
    const result = await handleEffortCommand("", "high", pickFn, print);
    expect(result).toBeUndefined();
  });

  it("selecting a named level returns its value", async () => {
    // EFFORT_LEVELS: auto, low, medium, high, max — "low" is index 1
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "selected", index: 1 });
    const result = await handleEffortCommand("", undefined, pickFn, print);
    expect(result).toBe("low");
    expect(printed.join("")).toContain("low");
  });

  it("passes currentIdx matching the active effort", async () => {
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "cancelled" });
    // "high" is index 3 in [auto, low, medium, high, max]
    await handleEffortCommand("", "high", pickFn, print);
    expect(pickFn.mock.calls[0][1]).toBe(3);
  });

  it("passes currentIdx 0 when no effort set (auto)", async () => {
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "cancelled" });
    await handleEffortCommand("", undefined, pickFn, print);
    expect(pickFn.mock.calls[0][1]).toBe(0);
  });

  it("cancel preserves current effort", async () => {
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "cancelled" });
    const result = await handleEffortCommand("", "max", pickFn, print);
    expect(result).toBe("max");
  });

  it("selecting already-active auto is a no-op", async () => {
    const pickFn = vi.fn<(options: string[], currentIdx: number) => Promise<PickResult>>()
      .mockResolvedValue({ type: "selected", index: 0 });
    const result = await handleEffortCommand("", undefined, pickFn, print);
    expect(result).toBeUndefined(); // unchanged
  });
});
