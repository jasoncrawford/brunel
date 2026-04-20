/**
 * Tests for toRelativePath() — strips cwd prefix from file paths before display.
 */
import path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stripAnsi } from "./helpers.js";
import { getConfig } from "../src/config.js";
import { toRelativePath } from "../shared/formatters.js";
import { Display } from "../src/agent/views/display.js";
import { AgentStatus } from "../src/agent/models/agent-status.js";

let testDisplay: Display;

function captureOutput(fn: () => void): string {
  let output = "";
  vi.spyOn(console, "log").mockImplementation((s: any) => { output += String(s) + "\n"; });
  fn();
  vi.restoreAllMocks();
  return output;
}

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

describe("toRelativePath()", () => {
  it("strips cwd prefix from path under cwd", () => {
    const abs = path.join(process.cwd(), "src/foreman.ts");
    expect(toRelativePath(abs)).toBe("src/foreman.ts");
  });

  it("strips cwd prefix from deeply nested path under cwd", () => {
    const abs = path.join(process.cwd(), "tests/fixtures/messages.ts");
    expect(toRelativePath(abs)).toBe("tests/fixtures/messages.ts");
  });

  it("returns original path when not under cwd", () => {
    expect(toRelativePath("/tmp/some/other/file.ts")).toBe("/tmp/some/other/file.ts");
  });

  it("returns '.' when path equals cwd exactly", () => {
    expect(toRelativePath(process.cwd())).toBe(".");
  });

  it("does not confuse cwd prefix with a differently-named parent directory", () => {
    // e.g. cwd=/home/foo, path=/home/foobar/file.ts should NOT become "bar/file.ts"
    const cwd = process.cwd();
    const sibling = cwd + "extra/file.ts"; // no separator, so not a child
    expect(toRelativePath(sibling)).toBe(sibling);
  });

  it("returns path unchanged when already relative", () => {
    expect(toRelativePath("src/foreman.ts")).toBe("src/foreman.ts");
  });
});

describe("TOOL_CALL_FMT — relative paths for Read/Write/Edit", () => {
  it("Read: relativizes absolute path under cwd", () => {
    const abs = path.join(process.cwd(), "src/foreman.ts");
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "Read", input: { file_path: abs } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• Read(src/foreman.ts)");
    expect(stripAnsi(output)).not.toContain(process.cwd());
  });

  it("Read: keeps path outside cwd as-is", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "Read", input: { file_path: "/foo/bar.ts" } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• Read(/foo/bar.ts)");
  });

  it("Write: relativizes absolute path under cwd", () => {
    const abs = path.join(process.cwd(), "src/output.ts");
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "Write", input: { file_path: abs } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• Write(src/output.ts)");
    expect(stripAnsi(output)).not.toContain(process.cwd());
  });

  it("Write: keeps path outside cwd as-is", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "Write", input: { file_path: "/foo/out.ts" } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• Write(/foo/out.ts)");
  });

  it("Edit: relativizes absolute path under cwd", () => {
    const abs = path.join(process.cwd(), "src/edit.ts");
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "Edit", input: { file_path: abs } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• Edit(src/edit.ts)");
    expect(stripAnsi(output)).not.toContain(process.cwd());
  });

  it("Edit: keeps path outside cwd as-is", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "Edit", input: { file_path: "/foo/edit.ts" } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• Edit(/foo/edit.ts)");
  });
});

describe("TOOL_CALL_FMT — relative paths for Grep", () => {
  it("Grep: relativizes absolute path under cwd", () => {
    const abs = path.join(process.cwd(), "src");
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "Grep", input: { pattern: "foo", path: abs } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• grep foo src");
    expect(stripAnsi(output)).not.toContain(process.cwd());
  });

  it("Grep: keeps path outside cwd as-is", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "Grep", input: { pattern: "foo", path: "/src" } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• grep foo /src");
  });
});
