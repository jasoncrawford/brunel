import { describe, it, expect, beforeEach } from "vitest";
import { Display } from "../src/agent/views/display.js";
import { StatusBar } from "../src/agent/views/status-bar.js";
import { getConfig } from "../src/config.js";
import { W } from "../src/agent/views/style.js";

// Strip ANSI escape codes to get the visible text
function strip(s: string) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

let display: Display;

beforeEach(() => {
  display = new Display(getConfig(), new StatusBar({ agentId: "test" }));
});

describe("clearBreak", () => {
  it("starts with a blank line", () => {
    expect(display.clearBreak()).toMatch(/^\n/);
  });

  it("contains 'Context cleared'", () => {
    expect(display.clearBreak()).toContain("Context cleared");
  });

  it("visible divider line fills the terminal width", () => {
    const expectedWidth = process.stdout.columns ?? W;
    const lines = strip(display.clearBreak()).split("\n");
    // Second element is the divider line (first is the blank line from leading \n)
    expect(lines[1]).toHaveLength(expectedWidth);
  });

  it("divider is composed of '=' marks with the label", () => {
    const lines = strip(display.clearBreak()).split("\n");
    expect(lines[1]).toMatch(/^=+\s+Context cleared\s+=*$/);
  });

  it("applies bold green styling", () => {
    const result = display.clearBreak();
    // sageGreen = 38;5;150
    expect(result).toContain("\x1b[38;5;150m");
    // bold
    expect(result).toContain("\x1b[1m");
  });
});
