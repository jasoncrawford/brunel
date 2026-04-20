import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stripAnsi } from "./helpers.js";
import { getConfig } from "../src/config.js";
import { fmtTime } from "../shared/formatters.js";
import { s } from "../src/agent/views/style.js";
import { Display } from "../src/agent/views/display.js";
import { AgentStatus } from "../src/agent/views/agent-status.js";

let testDisplay: Display;

beforeEach(() => {
  testDisplay = new Display(getConfig(), new AgentStatus({ agentId: "test-agent" }));
  testDisplay.stopBar();
  getConfig().verbose = false;
});

afterEach(() => {
  testDisplay.stopBar();
  getConfig().verbose = false;
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
    testDisplay.inputPrint = cb;
    getConfig().verbose = true;
    const output = captureOutput(() => testDisplay.print("hello"));
    testDisplay.inputPrint = null;

    const plain = stripAnsi(output);
    expect(plain).toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(plain).toContain("hello");
    expect(cb).toHaveBeenCalled();
  });

  it("verbose=false: callback path does not prepend timestamp", () => {
    const cb = vi.fn();
    testDisplay.inputPrint = cb;
    getConfig().verbose = false;
    const output = captureOutput(() => testDisplay.print("world"));
    testDisplay.inputPrint = null;

    const plain = stripAnsi(output);
    expect(plain).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(plain).toContain("world");
  });

  it("verbose=true: multi-line output in callback path gets timestamp on each line", () => {
    const cb = vi.fn();
    testDisplay.inputPrint = cb;
    getConfig().verbose = true;
    const output = captureOutput(() => testDisplay.print("line one\nline two"));
    testDisplay.inputPrint = null;

    const plain = stripAnsi(output);
    const matches = plain.match(/\d{2}:\d{2}:\d{2}/g);
    expect(matches).toHaveLength(2);
  });
});
