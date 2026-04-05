import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stripAnsi } from "./helpers.js";
import {
  print, setVerbose, stopStatus, fmtTime, s,
  setInputPrintCallback, distributeWidths,
} from "../src/agent/display.js";

beforeEach(() => {
  stopStatus();
  setVerbose(false);
});

afterEach(() => {
  stopStatus();
  setVerbose(false);
  vi.restoreAllMocks();
});

// ── Bug #1: fmtTime() variable shadowing ─────────────────────────────────────
// The local `s` variable in fmtTime() shadowed the module-level `s` style
// object. After renaming it to `sec`, s.bold() remains callable from any
// context after fmtTime() has been called.

describe("fmtTime() - no variable shadowing", () => {
  it("fmtTime returns HH:MM:SS formatted string", () => {
    const result = fmtTime();
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("module-level s.bold() is callable after fmtTime() is called", () => {
    // Calling fmtTime() must not corrupt the module-level s style object
    fmtTime();
    const result = s.bold("test");
    expect(result).toContain("\x1b[1m");
    expect(stripAnsi(result)).toBe("test");
  });
});

// ── Bug #2: distributeWidths() rounding loss ──────────────────────────────────
// When distributing available width across columns, the old Math.floor
// discarded the remainder. The fix gives +1 to the first `remainder` columns
// so the total allocated always equals `available`.

describe("distributeWidths - fills available space without rounding loss", () => {
  it("allocates all available space when remainder is 0", () => {
    // 3 columns, available=6: 6/3=2 exactly, no remainder
    const widths = distributeWidths([10, 10, 10], 6);
    expect(widths.reduce((a, b) => a + b, 0)).toBe(6);
    expect(widths).toEqual([2, 2, 2]);
  });

  it("allocates all available space with remainder of 1", () => {
    // 3 equal-wide columns, available=7: 7/3=2 rem 1 → one column gets 3
    const widths = distributeWidths([10, 10, 10], 7);
    expect(widths.reduce((a, b) => a + b, 0)).toBe(7);
    expect(widths.every(w => w === 2 || w === 3)).toBe(true);
    expect(widths.filter(w => w === 3)).toHaveLength(1);
    expect(widths.filter(w => w === 2)).toHaveLength(2);
  });

  it("allocates all available space with remainder of 2", () => {
    // 3 equal-wide columns, available=8: 8/3=2 rem 2 → two columns get 3
    const widths = distributeWidths([10, 10, 10], 8);
    expect(widths.reduce((a, b) => a + b, 0)).toBe(8);
    expect(widths.filter(w => w === 3)).toHaveLength(2);
    expect(widths.filter(w => w === 2)).toHaveLength(1);
  });

  it("uses natural width for narrow columns and distributes remainder to wide ones", () => {
    // Column 0: natural=1 (fits its fair share), columns 1-2: natural=10 (don't fit)
    // available=5: k=0, fairShare=floor(5/3)=1, col0 takes 1, remaining=4
    //             k=1, fairShare=floor(4/2)=2, cols 1&2 each get 2 (no remainder)
    const widths = distributeWidths([1, 10, 10], 5);
    expect(widths.reduce((a, b) => a + b, 0)).toBe(5);
    expect(widths[0]).toBe(1);
    expect(widths[1]).toBe(2);
    expect(widths[2]).toBe(2);
  });

  it("natural widths returned as-is when total fits in available", () => {
    const widths = distributeWidths([3, 5, 2], 20);
    expect(widths).toEqual([3, 5, 2]);
  });

  it("returns empty array for empty input", () => {
    expect(distributeWidths([], 100)).toEqual([]);
  });
});

// ── Simplification #4: printLine helper extraction ─────────────────────────────
// The verbose-timestamp logic was duplicated in two branches of print().
// After extraction into a helper, both the normal path and the
// _inputPrintCallback path must produce identical timestamp behavior.

function captureOutput(fn: () => void): string {
  let output = "";
  vi.spyOn(console, "log").mockImplementation((s: unknown) => { output += String(s) + "\n"; });
  vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => { output += String(s); return true; });
  fn();
  return output;
}

describe("print() via _inputPrintCallback path - verbose timestamp", () => {
  it("verbose=true: callback path still prepends HH:MM:SS timestamp", () => {
    const cb = vi.fn();
    setInputPrintCallback(cb);
    setVerbose(true);
    const output = captureOutput(() => print("hello"));
    setInputPrintCallback(null);

    const plain = stripAnsi(output);
    expect(plain).toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(plain).toContain("hello");
    expect(cb).toHaveBeenCalled();
  });

  it("verbose=false: callback path does not prepend timestamp", () => {
    const cb = vi.fn();
    setInputPrintCallback(cb);
    setVerbose(false);
    const output = captureOutput(() => print("world"));
    setInputPrintCallback(null);

    const plain = stripAnsi(output);
    expect(plain).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(plain).toContain("world");
  });

  it("verbose=true: multi-line output in callback path gets timestamp on each line", () => {
    const cb = vi.fn();
    setInputPrintCallback(cb);
    setVerbose(true);
    const output = captureOutput(() => print("line one\nline two"));
    setInputPrintCallback(null);

    const plain = stripAnsi(output);
    const matches = plain.match(/\d{2}:\d{2}:\d{2}/g);
    expect(matches).toHaveLength(2);
  });
});
