import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { stripAnsi } from "./helpers.js";
import { Display } from "../src/agent/views/display.js";
import { AgentStatus } from "../src/agent/models/agent-status.js";
import { getConfig } from "../src/config.js";
import { W } from "../src/agent/views/style.js";

let display: Display;

beforeEach(() => {
  display = new Display(getConfig(), new AgentStatus({ agentId: "test" }));
  getConfig().verbose = false;
});

afterEach(() => {
  getConfig().verbose = false;
});

describe("effectiveWidth() - verbose mode reduces width", () => {
  it("verbose=false: effectiveWidth returns full terminal width", () => {
    getConfig().verbose = false;
    const expectedWidth = process.stdout.columns ?? W;
    expect(display.effectiveWidth()).toBe(expectedWidth);
  });

  it("verbose=true: effectiveWidth is narrower by 9 (verbose timestamp prefix)", () => {
    getConfig().verbose = true;
    const expectedWidth = (process.stdout.columns ?? W) - 9;
    expect(display.effectiveWidth()).toBe(expectedWidth);
  });
});

describe("clearBreak() - verbose mode reduces width", () => {
  it("verbose=false: divider fills full terminal width", () => {
    getConfig().verbose = false;
    const expectedWidth = process.stdout.columns ?? W;
    const lines = stripAnsi(display.renderer.clearBreak()).split("\n");
    expect(lines[1]).toHaveLength(expectedWidth);
  });

  it("verbose=true: divider is narrower by 9 (verbose timestamp prefix)", () => {
    getConfig().verbose = true;
    const expectedWidth = (process.stdout.columns ?? W) - 9;
    const lines = stripAnsi(display.renderer.clearBreak()).split("\n");
    expect(lines[1]).toHaveLength(expectedWidth);
  });
});
