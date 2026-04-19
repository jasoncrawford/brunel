import { describe, it, expect } from "vitest";
import { stripAnsi } from "./helpers.js";
import { clearBreak } from "../src/agent/views/renderer.js";
import { W } from "../src/agent/views/style.js";

describe("clearBreak() - verbose mode reduces width", () => {
  it("verbose=false: divider fills full terminal width", () => {
    const expectedWidth = process.stdout.columns ?? W;
    const lines = stripAnsi(clearBreak(false)).split("\n");
    expect(lines[1]).toHaveLength(expectedWidth);
  });

  it("verbose=true: divider is narrower by 9 (verbose timestamp prefix)", () => {
    const expectedWidth = (process.stdout.columns ?? W) - 9;
    const lines = stripAnsi(clearBreak(true)).split("\n");
    expect(lines[1]).toHaveLength(expectedWidth);
  });
});
