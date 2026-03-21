import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// parsePermissionMode is a pure function that reads argv — no SDK needed.
// We mock fs to prevent logFull from writing to disk (repl.ts imports fs at module level).
vi.mock("fs", () => ({
  default: { appendFileSync: vi.fn() },
}));

import { parsePermissionMode, VALID_PERMISSION_MODES } from "../src/repl.js";

// Stub process.exit so error cases don't actually kill the test runner.
let exitSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as () => never);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VALID_PERMISSION_MODES", () => {
  it("contains all five SDK modes", () => {
    expect(VALID_PERMISSION_MODES).toEqual(
      expect.arrayContaining(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"])
    );
    expect(VALID_PERMISSION_MODES).toHaveLength(5);
  });
});

describe("parsePermissionMode — happy paths", () => {
  it("no flags → default mode, no bypass", () => {
    const result = parsePermissionMode(["node", "repl.js"]);
    expect(result).toEqual({ mode: "default", allowDangerouslySkipPermissions: false });
  });

  it("--dangerously-skip-permissions → bypassPermissions + bypass true", () => {
    const result = parsePermissionMode(["node", "repl.js", "--dangerously-skip-permissions"]);
    expect(result).toEqual({ mode: "bypassPermissions", allowDangerouslySkipPermissions: true });
  });

  it("--permission-mode default", () => {
    const result = parsePermissionMode(["node", "repl.js", "--permission-mode", "default"]);
    expect(result).toEqual({ mode: "default", allowDangerouslySkipPermissions: false });
  });

  it("--permission-mode acceptEdits", () => {
    const result = parsePermissionMode(["node", "repl.js", "--permission-mode", "acceptEdits"]);
    expect(result).toEqual({ mode: "acceptEdits", allowDangerouslySkipPermissions: false });
  });

  it("--permission-mode bypassPermissions → bypass true", () => {
    const result = parsePermissionMode(["node", "repl.js", "--permission-mode", "bypassPermissions"]);
    expect(result).toEqual({ mode: "bypassPermissions", allowDangerouslySkipPermissions: true });
  });

  it("--permission-mode plan", () => {
    const result = parsePermissionMode(["node", "repl.js", "--permission-mode", "plan"]);
    expect(result).toEqual({ mode: "plan", allowDangerouslySkipPermissions: false });
  });

  it("--permission-mode dontAsk", () => {
    const result = parsePermissionMode(["node", "repl.js", "--permission-mode", "dontAsk"]);
    expect(result).toEqual({ mode: "dontAsk", allowDangerouslySkipPermissions: false });
  });

  it("--dangerously-skip-permissions + --permission-mode bypassPermissions (compatible)", () => {
    const result = parsePermissionMode([
      "node", "repl.js",
      "--dangerously-skip-permissions",
      "--permission-mode", "bypassPermissions",
    ]);
    expect(result).toEqual({ mode: "bypassPermissions", allowDangerouslySkipPermissions: true });
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("parsePermissionMode — error paths", () => {
  it("--dangerously-skip-permissions + --permission-mode default → conflict error", () => {
    parsePermissionMode([
      "node", "repl.js",
      "--dangerously-skip-permissions",
      "--permission-mode", "default",
    ]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("--permission-mode with unknown value → error", () => {
    parsePermissionMode(["node", "repl.js", "--permission-mode", "unknown"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("--permission-mode with no following value (end of argv) → error", () => {
    parsePermissionMode(["node", "repl.js", "--permission-mode"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("--permission-mode followed by another flag → error (treats flag as missing value)", () => {
    parsePermissionMode(["node", "repl.js", "--permission-mode", "--worker-mode"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
