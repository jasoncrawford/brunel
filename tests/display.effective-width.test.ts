import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { stripAnsi } from "./helpers.js";
import { statusBar } from "../src/agent/status-bar.js";
import { getConfig } from "../src/config.js";
import {
  effectiveWidth,
  VERBOSE_PREFIX_LEN,
  clearBreak,
  renderTable,
  fmtHunk,
  W,
} from "../src/agent/display.js";

beforeEach(() => getConfig().verbose = false);
afterEach(() => getConfig().verbose = false);

describe("VERBOSE_PREFIX_LEN", () => {
  it("is 9 (length of 'HH:mm:ss ')", () => {
    expect(VERBOSE_PREFIX_LEN).toBe(9);
  });
});

describe("effectiveWidth()", () => {
  it("verbose=false: returns full terminal width", () => {
    getConfig().verbose = false;
    const expected = process.stdout.columns ?? W;
    expect(effectiveWidth()).toBe(expected);
  });

  it("verbose=true: returns terminal width minus VERBOSE_PREFIX_LEN", () => {
    getConfig().verbose = true;
    const expected = (process.stdout.columns ?? W) - VERBOSE_PREFIX_LEN;
    expect(effectiveWidth()).toBe(expected);
  });

  it("verbose=false with custom fallback: uses fallback when no columns", () => {
    getConfig().verbose = false;
    const cols = process.stdout.columns;
    if (cols == null) {
      expect(effectiveWidth(80)).toBe(80);
    } else {
      expect(effectiveWidth(80)).toBe(cols);
    }
  });

  it("verbose=true with custom fallback: subtracts prefix from fallback when no columns", () => {
    getConfig().verbose = true;
    const cols = process.stdout.columns;
    if (cols == null) {
      expect(effectiveWidth(80)).toBe(80 - VERBOSE_PREFIX_LEN);
    } else {
      expect(effectiveWidth(80)).toBe(cols - VERBOSE_PREFIX_LEN);
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

  it("verbose=true: divider is narrower by VERBOSE_PREFIX_LEN", () => {
    getConfig().verbose = true;
    const expectedWidth = (process.stdout.columns ?? W) - VERBOSE_PREFIX_LEN;
    const lines = stripAnsi(clearBreak()).split("\n");
    expect(lines[1]).toHaveLength(expectedWidth);
  });
});

describe("renderTable() - verbose mode reduces width", () => {
  const tableLines = [
    "| A | B |",
    "| --- | --- |",
    "| short | text |",
  ];

  it("verbose=false: uses full terminal width for layout", () => {
    getConfig().verbose = false;
    const fullWidth = process.stdout.columns ?? W;
    const verboseResult = stripAnsi(renderTable(tableLines));
    const explicitResult = stripAnsi(renderTable(tableLines, fullWidth));
    expect(verboseResult).toBe(explicitResult);
  });

  it("verbose=true: uses reduced width (same as maxWidth minus VERBOSE_PREFIX_LEN)", () => {
    getConfig().verbose = true;
    const reducedWidth = (process.stdout.columns ?? W) - VERBOSE_PREFIX_LEN;
    const verboseResult = stripAnsi(renderTable(tableLines));
    const explicitResult = stripAnsi(renderTable(tableLines, reducedWidth));
    expect(verboseResult).toBe(explicitResult);
  });
});

describe("fmtHunk() - verbose mode reduces padding width", () => {
  const hunk = {
    oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
    lines: ["+added line", "-removed line", " context line"],
  };

  it("verbose=false: diff lines padded to full terminal width", () => {
    getConfig().verbose = false;
    const fullWidth = process.stdout.columns ?? 80;
    const result = fmtHunk(hunk);
    // Strip ANSI and find the added line — it should be padded to fullWidth
    const addedLine = stripAnsi(result).split("\n").find(l => l.startsWith("+"));
    expect(addedLine).toBeDefined();
    expect(addedLine!.length).toBe(fullWidth);
  });

  it("verbose=true: diff lines padded to reduced width", () => {
    getConfig().verbose = true;
    const reducedWidth = (process.stdout.columns ?? 80) - VERBOSE_PREFIX_LEN;
    const result = fmtHunk(hunk);
    const addedLine = stripAnsi(result).split("\n").find(l => l.startsWith("+"));
    expect(addedLine).toBeDefined();
    expect(addedLine!.length).toBe(reducedWidth);
  });
});
