import { describe, it, expect } from "vitest";
import { clearBreak, W } from "../src/display.js";

describe("clearBreak", () => {
  it("contains 'Context cleared'", () => {
    expect(clearBreak()).toContain("Context cleared");
  });

  it("visible portion is exactly W characters wide", () => {
    // Strip ANSI escape codes to measure visible length
    const stripped = clearBreak().replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripped).toHaveLength(W);
  });

  it("is composed entirely of '=' and spaces and the label text", () => {
    const stripped = clearBreak().replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripped).toMatch(/^=+\s+Context cleared\s+=*$/);
  });

  it("applies bold green styling", () => {
    const result = clearBreak();
    // Green color escape (sageGreen = 38;5;150) should be present
    expect(result).toContain("\x1b[38;5;150m");
    // Bold escape should be present
    expect(result).toContain("\x1b[1m");
  });
});
