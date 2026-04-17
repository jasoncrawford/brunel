/**
 * Tests for toRelativePath() — strips cwd prefix from file paths before display.
 */
import path from "path";
import { describe, it, expect } from "vitest";
import { stripAnsi } from "./helpers.js";
import { toRelativePath, resolve, TOOL_CALL_FMT, type FmtTable } from "../src/agent/views/display.js";

function r(table: FmtTable, key: string, data: any): string | null {
  const result = resolve(table, key, data);
  return result === null ? null : stripAnsi(result);
}

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
    const result = r(TOOL_CALL_FMT, "Read", { input: { file_path: abs } });
    expect(result).toContain("• Read(src/foreman.ts)");
    expect(result).not.toContain(process.cwd());
  });

  it("Read: keeps path outside cwd as-is", () => {
    const result = r(TOOL_CALL_FMT, "Read", { input: { file_path: "/foo/bar.ts" } });
    expect(result).toContain("• Read(/foo/bar.ts)");
  });

  it("Write: relativizes absolute path under cwd", () => {
    const abs = path.join(process.cwd(), "src/output.ts");
    const result = r(TOOL_CALL_FMT, "Write", { input: { file_path: abs } });
    expect(result).toContain("• Write(src/output.ts)");
    expect(result).not.toContain(process.cwd());
  });

  it("Write: keeps path outside cwd as-is", () => {
    const result = r(TOOL_CALL_FMT, "Write", { input: { file_path: "/foo/out.ts" } });
    expect(result).toContain("• Write(/foo/out.ts)");
  });

  it("Edit: relativizes absolute path under cwd", () => {
    const abs = path.join(process.cwd(), "src/edit.ts");
    const result = r(TOOL_CALL_FMT, "Edit", { input: { file_path: abs } });
    expect(result).toContain("• Edit(src/edit.ts)");
    expect(result).not.toContain(process.cwd());
  });

  it("Edit: keeps path outside cwd as-is", () => {
    const result = r(TOOL_CALL_FMT, "Edit", { input: { file_path: "/foo/edit.ts" } });
    expect(result).toContain("• Edit(/foo/edit.ts)");
  });
});

describe("TOOL_CALL_FMT — relative paths for Grep", () => {
  it("Grep: relativizes absolute path under cwd", () => {
    const abs = path.join(process.cwd(), "src");
    const result = r(TOOL_CALL_FMT, "Grep", { input: { pattern: "foo", path: abs } });
    expect(result).toContain("• grep foo src");
    expect(result).not.toContain(process.cwd());
  });

  it("Grep: keeps path outside cwd as-is", () => {
    const result = r(TOOL_CALL_FMT, "Grep", { input: { pattern: "foo", path: "/src" } });
    expect(result).toContain("• grep foo /src");
  });
});
