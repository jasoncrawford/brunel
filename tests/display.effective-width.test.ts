import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { stripAnsi } from "./helpers.js";
import { getConfig } from "../src/config.js";
import { clearBreak } from "../src/agent/views/display.js";
import { effectiveWidth, W } from "../src/agent/views/style.js";

beforeEach(() => getConfig().verbose = false);
afterEach(() => getConfig().verbose = false);

describe("effectiveWidth()", () => {
  it("verbose=false: returns full terminal width", () => {
    const expected = process.stdout.columns ?? W;
    expect(effectiveWidth(W, false)).toBe(expected);
  });

  it("verbose=true: returns terminal width minus 9 (verbose timestamp prefix)", () => {
    const expected = (process.stdout.columns ?? W) - 9;
    expect(effectiveWidth(W, true)).toBe(expected);
  });

  it("verbose=false with custom fallback: uses fallback when no columns", () => {
    const cols = process.stdout.columns;
    if (cols == null) {
      expect(effectiveWidth(80, false)).toBe(80);
    } else {
      expect(effectiveWidth(80, false)).toBe(cols);
    }
  });

  it("verbose=true with custom fallback: subtracts 9 from fallback when no columns", () => {
    const cols = process.stdout.columns;
    if (cols == null) {
      expect(effectiveWidth(80, true)).toBe(80 - 9);
    } else {
      expect(effectiveWidth(80, true)).toBe(cols - 9);
    }
  });
});

describe("clearBreak() - verbose mode reduces width", () => {
  it("verbose=false: divider fills full terminal width", () => {
    getConfig().verbose = false;
    const expectedWidth = process.stdout.columns ?? W;
    const lines = stripAnsi(clearBreak()).split("\n");
    expect(lines[1]).toHaveLength(expectedWidth);
  });

  it("verbose=true: divider is narrower by 9 (verbose timestamp prefix)", () => {
    getConfig().verbose = true;
    const expectedWidth = (process.stdout.columns ?? W) - 9;
    const lines = stripAnsi(clearBreak()).split("\n");
    expect(lines[1]).toHaveLength(expectedWidth);
  });
});
