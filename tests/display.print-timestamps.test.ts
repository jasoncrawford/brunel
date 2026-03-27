import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stripAnsi } from "./helpers.js";
import { print, setVerbose, stopStatus } from "../src/display.js";

function captureOutput(fn: () => void): string {
  let output = "";
  const logSpy = vi.spyOn(console, "log").mockImplementation((s: any) => { output += String(s) + "\n"; });
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { output += String(s); return true; });
  fn();
  logSpy.mockRestore();
  writeSpy.mockRestore();
  return output;
}

beforeEach(() => {
  stopStatus();
  setVerbose(false);
});

afterEach(() => {
  stopStatus();
  setVerbose(false);
  vi.restoreAllMocks();
});

describe("print() timestamps", () => {
  it("verbose=false: no timestamp prepended", () => {
    setVerbose(false);
    const output = captureOutput(() => print("hello"));
    const plain = stripAnsi(output);
    expect(plain).toContain("hello");
    // HH:MM:SS pattern should NOT appear
    expect(plain).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it("verbose=true: prepends HH:MM:SS timestamp", () => {
    setVerbose(true);
    const output = captureOutput(() => print("hello"));
    const plain = stripAnsi(output);
    expect(plain).toContain("hello");
    expect(plain).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it("verbose=true: timestamp appears before message content", () => {
    setVerbose(true);
    const output = captureOutput(() => print("world"));
    const plain = stripAnsi(output);
    const tsMatch = plain.match(/\d{2}:\d{2}:\d{2}/);
    expect(tsMatch).not.toBeNull();
    const tsIdx = plain.indexOf(tsMatch![0]);
    const msgIdx = plain.indexOf("world");
    expect(tsIdx).toBeLessThan(msgIdx);
  });

  it("verbose=true: timestamp uses darkGray opener and foreground-only reset", () => {
    setVerbose(true);
    const raw = captureOutput(() => print("styled"));
    // darkGray opener
    expect(raw).toContain("\x1b[90m");
    // ends with \x1b[39m (pop foreground only), not a full \x1b[0m reset
    const tsEnd = raw.indexOf("\x1b[39m");
    expect(tsEnd).toBeGreaterThan(-1);
    // full reset must not appear inside the timestamp itself (before content)
    const fullReset = raw.indexOf("\x1b[0m");
    expect(fullReset === -1 || fullReset > tsEnd).toBe(true);
  });

  it("verbose=true: opening color is re-applied to continuation lines", () => {
    setVerbose(true);
    // Simulate a color-wrapped multi-line block like c.gray() produces
    const coloredBlock = `\x1b[38;5;246m\nline one\nline two\x1b[0m`;
    const raw = captureOutput(() => print(coloredBlock));
    // The opening color code \x1b[38;5;246m should appear on every split line
    const occurrences = (raw.match(/\x1b\[38;5;246m/g) ?? []).length;
    // First part is the opener line itself; continuation lines get it re-applied
    expect(occurrences).toBeGreaterThanOrEqual(3); // opener + 2 continuation lines
  });

  it("verbose=true: each line of multi-line output gets a timestamp", () => {
    setVerbose(true);
    const output = captureOutput(() => print("line one\nline two\nline three"));
    const plain = stripAnsi(output);
    const matches = plain.match(/\d{2}:\d{2}:\d{2}/g);
    expect(matches).toHaveLength(3);
    expect(plain).toContain("line one");
    expect(plain).toContain("line two");
    expect(plain).toContain("line three");
  });

  it("verbose=true: print(null) still no-ops", () => {
    setVerbose(true);
    const output = captureOutput(() => print(null));
    expect(output).toBe("");
  });
});
