import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { stripAnsi } from "./helpers.js";
import {
  resolve,
  setVerbose,
  ASSISTANT_BLOCK_FMT,
  USER_BLOCK_FMT,
  TOOL_CALL_FMT,
  TOOL_RESULT_FMT,
  TOOL_ERROR_FMT,
  SYSTEM_FMT,
  MESSAGE_FMT,
  HOOK_FMT,
  type FmtTable,
} from "../src/display.js";

// Helper to call resolve and strip ANSI
function r(table: FmtTable, key: string, data: any): string | null {
  const result = resolve(table, key, data);
  return result === null ? null : stripAnsi(result);
}

describe("resolve()", () => {
  afterEach(() => setVerbose(false));

  it("key exists as Fmt function → calls it", () => {
    const table: FmtTable = { foo: (d) => `value:${d.x}` };
    expect(r(table, "foo", { x: 42 })).toBe("value:42");
  });

  it("key missing, _default exists → calls _default", () => {
    const table: FmtTable = { _default: (d) => `default:${d.x}` };
    expect(r(table, "missing", { x: 7 })).toBe("default:7");
  });

  it("key missing, no _default → returns null", () => {
    const table: FmtTable = { foo: (d) => "foo" };
    expect(resolve(table, "missing", {})).toBeNull();
  });

  it("key as { quiet, verbose }, VERBOSE=false → calls quiet", () => {
    setVerbose(false);
    const table: FmtTable = {
      foo: { quiet: () => "quiet", verbose: () => "verbose" },
    };
    expect(r(table, "foo", {})).toBe("quiet");
  });

  it("key as { quiet, verbose }, VERBOSE=true → calls verbose", () => {
    setVerbose(true);
    const table: FmtTable = {
      foo: { quiet: () => "quiet", verbose: () => "verbose" },
    };
    expect(r(table, "foo", {})).toBe("verbose");
  });

  it("{ verbose: fn } with VERBOSE=false → returns null", () => {
    setVerbose(false);
    const table: FmtTable = { foo: { verbose: () => "v" } };
    expect(resolve(table, "foo", {})).toBeNull();
  });

  it("{ verbose: fn } with VERBOSE=true → calls fn", () => {
    setVerbose(true);
    const table: FmtTable = { foo: { verbose: () => "v" } };
    expect(r(table, "foo", {})).toBe("v");
  });

  it("formatter returns null → resolve returns null", () => {
    const table: FmtTable = { foo: () => null };
    expect(resolve(table, "foo", {})).toBeNull();
  });
});

describe("ASSISTANT_BLOCK_FMT", () => {
  it("thinking block wraps renderMarkdown in gray", () => {
    const result = resolve(ASSISTANT_BLOCK_FMT, "thinking", { thinking: "hello" })!;
    expect(stripAnsi(result)).toContain("hello");
    // gray color: \x1b[38;5;246m
    expect(result).toContain("\x1b[38;5;246m");
  });

  it("text block wraps renderMarkdown in yellow", () => {
    const result = resolve(ASSISTANT_BLOCK_FMT, "text", { text: "world" })!;
    expect(stripAnsi(result)).toContain("world");
    // yellow color: \x1b[38;5;221m
    expect(result).toContain("\x1b[38;5;221m");
  });

  it("_default block shows [assistant/someType]", () => {
    expect(r(ASSISTANT_BLOCK_FMT, "_default", { type: "someType" })).toBe("[assistant/someType]");
  });

  it("unknown type falls through to _default", () => {
    expect(r(ASSISTANT_BLOCK_FMT, "unknownType", { type: "unknownType" })).toBe("[assistant/unknownType]");
  });
});

describe("USER_BLOCK_FMT", () => {
  it("text block, _isSynthetic=false → raw text", () => {
    const result = r(USER_BLOCK_FMT, "text", { text: "user said this", _isSynthetic: false });
    expect(result).toContain("user said this");
    // Should NOT have darkGray ANSI
    const raw = resolve(USER_BLOCK_FMT, "text", { text: "user said this", _isSynthetic: false })!;
    expect(raw).not.toContain("\x1b[90m");
  });

  it("text block, _isSynthetic=true → truncated darkGray text", () => {
    const raw = resolve(USER_BLOCK_FMT, "text", { text: "synthetic msg", _isSynthetic: true })!;
    expect(raw).toContain("\x1b[90m");
    expect(stripAnsi(raw)).toContain("synthetic msg");
  });

  it("_default: [user/someType]", () => {
    expect(r(USER_BLOCK_FMT, "_default", { type: "someType" })).toBe("[user/someType]");
  });
});

describe("TOOL_CALL_FMT", () => {
  it("Bash: shows $ <command>", () => {
    const result = r(TOOL_CALL_FMT, "Bash", { input: { command: "ls -la" } });
    expect(result).toContain("$ ls -la");
  });

  it("Read: shows • Read(<file_path>)", () => {
    const result = r(TOOL_CALL_FMT, "Read", { input: { file_path: "/foo/bar.ts" } });
    expect(result).toContain("• Read(/foo/bar.ts)");
  });

  it("Write: shows • Write(<file_path>)", () => {
    const result = r(TOOL_CALL_FMT, "Write", { input: { file_path: "/foo/out.ts" } });
    expect(result).toContain("• Write(/foo/out.ts)");
  });

  it("Edit: shows • Edit(<file_path>)", () => {
    const result = r(TOOL_CALL_FMT, "Edit", { input: { file_path: "/foo/edit.ts" } });
    expect(result).toContain("• Edit(/foo/edit.ts)");
  });

  it("Glob: shows • Glob(<pattern>)", () => {
    const result = r(TOOL_CALL_FMT, "Glob", { input: { pattern: "**/*.ts" } });
    expect(result).toContain("• Glob(**/*.ts)");
  });

  it("Grep: shows • grep <pattern> <path>", () => {
    const result = r(TOOL_CALL_FMT, "Grep", { input: { pattern: "foo", path: "/src" } });
    expect(result).toContain("• grep foo /src");
  });

  it("Skill: shows • Skill(<skill>)", () => {
    const result = r(TOOL_CALL_FMT, "Skill", { input: { skill: "test-discipline" } });
    expect(result).toContain("• Skill(test-discipline)");
  });

  it("Agent: shows • <subagent_type>(<prompt>)", () => {
    const result = r(TOOL_CALL_FMT, "Agent", {
      input: { subagent_type: "Explore", prompt: "find files" },
    });
    expect(result).toContain("• Explore(find files)");
  });

  it("_default: shows • <name>(<fmtArgs(input)>)", () => {
    const result = r(TOOL_CALL_FMT, "_default", {
      name: "MyTool",
      input: { key: "val" },
    });
    expect(result).toContain("• MyTool(key=val)");
  });

  it("with input.description: description appended in gray", () => {
    const raw = resolve(TOOL_CALL_FMT, "Bash", {
      input: { command: "ls", description: "list files" },
    })!;
    // gray: \x1b[38;5;246m
    expect(raw).toContain("\x1b[38;5;246m");
    expect(stripAnsi(raw)).toContain("# list files");
  });

  it("without description: no gray suffix", () => {
    const raw = resolve(TOOL_CALL_FMT, "Bash", { input: { command: "ls" } })!;
    expect(raw).not.toContain("\x1b[38;5;246m");
  });
});

describe("TOOL_RESULT_FMT", () => {
  it("_default: → <truncated text> in darkGray", () => {
    const raw = resolve(TOOL_RESULT_FMT, "_default", { content: "result text" })!;
    expect(raw).toContain("\x1b[90m");
    expect(stripAnsi(raw)).toContain("→ result text");
  });

  it("Read: → N line(s) in darkGray", () => {
    const content = "line1\nline2\nline3";
    const raw = resolve(TOOL_RESULT_FMT, "Read", { content })!;
    expect(raw).toContain("\x1b[90m");
    expect(stripAnsi(raw)).toContain("→ 3 lines");
  });

  it("Read: 1 line singular", () => {
    const raw = resolve(TOOL_RESULT_FMT, "Read", { content: "single line" })!;
    expect(stripAnsi(raw)).toContain("→ 1 line");
  });

  it("Edit with structuredPatch: renders diff", () => {
    const hunk = {
      oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      lines: ["-old", "+new"],
    };
    const b = { content: "", _msg: { tool_use_result: { structuredPatch: [hunk] } } };
    const result = stripAnsi(resolve(TOOL_RESULT_FMT, "Edit", b)!);
    expect(result).toContain("@@");
  });

  it("Edit without patch: falls back to → <text>", () => {
    const b = { content: "edited ok" };
    const result = stripAnsi(resolve(TOOL_RESULT_FMT, "Edit", b)!);
    expect(result).toContain("→ edited ok");
  });

  it("Skill: returns null (suppressed)", () => {
    expect(resolve(TOOL_RESULT_FMT, "Skill", { content: "anything" })).toBeNull();
  });
});

describe("TOOL_ERROR_FMT", () => {
  it("_default: ! <error text> in salmon", () => {
    const raw = resolve(TOOL_ERROR_FMT, "_default", { content: "something went wrong" })!;
    // salmon: \x1b[38;5;203m
    expect(raw).toContain("\x1b[38;5;203m");
    expect(stripAnsi(raw)).toContain("! something went wrong");
  });
});

describe("SYSTEM_FMT", () => {
  afterEach(() => setVerbose(false));

  it("init, VERBOSE=false → null", () => {
    setVerbose(false);
    expect(resolve(SYSTEM_FMT, "init", { session_id: "abc" })).toBeNull();
  });

  it("init, VERBOSE=true → session: <session_id>", () => {
    setVerbose(true);
    expect(r(SYSTEM_FMT, "init", { session_id: "abc" })).toBe("session: abc");
  });

  it("task_started → lavender ▶ agent started: <description>", () => {
    const raw = resolve(SYSTEM_FMT, "task_started", { description: "Running tests" })!;
    // lavender: \x1b[38;5;183m
    expect(raw).toContain("\x1b[38;5;183m");
    expect(stripAnsi(raw)).toContain("▶ agent started: Running tests");
  });

  it("task_progress → lavender • <description>", () => {
    const raw = resolve(SYSTEM_FMT, "task_progress", { description: "Step 2" })!;
    expect(raw).toContain("\x1b[38;5;183m");
    expect(stripAnsi(raw)).toContain("• Step 2");
  });

  it("task_notification → lavender ◀︎ <status>: <summary>", () => {
    const raw = resolve(SYSTEM_FMT, "task_notification", { status: "done", summary: "All good" })!;
    expect(raw).toContain("\x1b[38;5;183m");
    expect(stripAnsi(raw)).toContain("done: All good");
  });

  it("_default, VERBOSE=false → null", () => {
    setVerbose(false);
    expect(resolve(SYSTEM_FMT, "unknown_subtype", { subtype: "unknown_subtype" })).toBeNull();
  });

  it("_default, VERBOSE=true → system/<subtype>", () => {
    setVerbose(true);
    expect(r(SYSTEM_FMT, "_default", { subtype: "whatever" })).toBe("system/whatever");
  });
});

describe("MESSAGE_FMT", () => {
  afterEach(() => setVerbose(false));

  it("_empty → [<type> — empty] in darkGray", () => {
    const raw = resolve(MESSAGE_FMT, "_empty", { type: "assistant" })!;
    expect(raw).toContain("\x1b[90m");
    expect(stripAnsi(raw)).toContain("[assistant — empty]");
  });

  it("result → \\n<fmtStats(...)> in darkGray", () => {
    const msg = {
      duration_ms: 5000,
      num_turns: 2,
      usage: { output_tokens: 150, input_tokens: 800 },
    };
    const raw = resolve(MESSAGE_FMT, "result", msg)!;
    expect(raw).toContain("\x1b[90m");
    const text = stripAnsi(raw);
    expect(text).toContain("5s");
    expect(text).toContain("2 turns");
    expect(text).toContain("800 in");
    expect(text).toContain("150 out");
  });

  it("rate_limit_event, VERBOSE=false → null", () => {
    setVerbose(false);
    expect(resolve(MESSAGE_FMT, "rate_limit_event", { rate_limit_info: { status: "allowed" } })).toBeNull();
  });

  it("rate_limit_event, VERBOSE=true → rate limit: status=<status>", () => {
    setVerbose(true);
    expect(r(MESSAGE_FMT, "rate_limit_event", { rate_limit_info: { status: "allowed" } }))
      .toBe("rate limit: status=allowed");
  });

  it("_default → msg: <type>", () => {
    expect(r(MESSAGE_FMT, "_default", { type: "whatever" })).toBe("msg: whatever");
  });
});

describe("HOOK_FMT", () => {
  afterEach(() => setVerbose(false));

  it("PreToolUse, VERBOSE=false → null", () => {
    setVerbose(false);
    expect(resolve(HOOK_FMT, "PreToolUse", { tool_name: "Bash", tool_input: {} })).toBeNull();
  });

  it("PreToolUse, VERBOSE=true → hook: pre-tool <name>(<args>)", () => {
    setVerbose(true);
    const result = r(HOOK_FMT, "PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
    expect(result).toContain("hook: pre-tool");
    expect(result).toContain("Bash");
  });

  it("PostToolUse, VERBOSE=true, no error → (ok)", () => {
    setVerbose(true);
    const result = r(HOOK_FMT, "PostToolUse", { tool_name: "Read", tool_error: null });
    expect(result).toContain("(ok)");
  });

  it("PostToolUse, VERBOSE=true, with error → (error)", () => {
    setVerbose(true);
    const result = r(HOOK_FMT, "PostToolUse", { tool_name: "Read", tool_error: "oops" });
    expect(result).toContain("(error)");
  });

  it("Notification, VERBOSE=true → hook: notif \"<message>\"", () => {
    setVerbose(true);
    const result = r(HOOK_FMT, "Notification", { message: "hello" });
    expect(result).toContain('hook: notif "hello"');
  });

  it("UserPromptSubmit, VERBOSE=true → hook: user prompt \"<prompt>\"", () => {
    setVerbose(true);
    const result = r(HOOK_FMT, "UserPromptSubmit", { prompt: "do something" });
    expect(result).toContain('hook: user prompt "do something"');
  });

  it("PermissionRequest, VERBOSE=true → hook: permission <name> → <status>", () => {
    setVerbose(true);
    const result = r(HOOK_FMT, "PermissionRequest", { tool_name: "Bash", status: "approved" });
    expect(result).toContain("hook: permission Bash");
    expect(result).toContain("→ approved");
  });

  it("Stop, VERBOSE=true → hook: stop reason=<reason>", () => {
    setVerbose(true);
    const result = r(HOOK_FMT, "Stop", { stop_reason: "end_turn" });
    expect(result).toContain("hook: stop reason=end_turn");
  });

  it("SubagentStart, VERBOSE=true → hook: subagent start id=<id>", () => {
    setVerbose(true);
    const result = r(HOOK_FMT, "SubagentStart", { agent_id: "agent-123" });
    expect(result).toContain("hook: subagent start id=agent-123");
  });

  it("SubagentStop, VERBOSE=true → hook: subagent stop id=<id>", () => {
    setVerbose(true);
    const result = r(HOOK_FMT, "SubagentStop", { agent_id: "agent-123" });
    expect(result).toContain("hook: subagent stop  id=agent-123");
  });

  it("TaskCompleted, VERBOSE=true → hook: task completed id=<id>", () => {
    setVerbose(true);
    const result = r(HOOK_FMT, "TaskCompleted", { task_id: "task-456" });
    expect(result).toContain("hook: task completed id=task-456");
  });

  it("_default, VERBOSE=true → hook: <event name>", () => {
    setVerbose(true);
    const result = r(HOOK_FMT, "_default", { _event: "SomeEvent" });
    expect(result).toContain("hook: SomeEvent");
  });
});
