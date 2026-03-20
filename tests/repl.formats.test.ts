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
  fmtTodoWriteInput,
  fmtAskUserQuestionInput,
  fmtToolSearchOutput,
  fmtTodoWriteOutput,
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

  it("AskUserQuestion: shows question text(s)", () => {
    const result = r(TOOL_CALL_FMT, "AskUserQuestion", {
      input: { questions: [{ question: "Which approach?", header: "Approach", options: [], multiSelect: false }] },
    });
    expect(result).toContain('• AskUserQuestion("Which approach?")');
  });

  it("AskUserQuestion: shows multiple question texts", () => {
    const result = r(TOOL_CALL_FMT, "AskUserQuestion", {
      input: {
        questions: [
          { question: "Which approach?", header: "A", options: [], multiSelect: false },
          { question: "Which format?", header: "B", options: [], multiSelect: false },
        ],
      },
    });
    expect(result).toContain('• AskUserQuestion("Which approach?", "Which format?")');
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

  it("Skill: shows → Success", () => {
    const raw = resolve(TOOL_RESULT_FMT, "Skill", { content: "Base directory for this skill: /some/path\n..." })!;
    expect(stripAnsi(raw)).toBe("→ Loaded skill");
  });

  it("Bash: empty result → → Success", () => {
    const raw = resolve(TOOL_RESULT_FMT, "Bash", { content: "" })!;
    expect(stripAnsi(raw)).toBe("→ Success");
  });

  it("Bash: no-output message → → Success", () => {
    const raw = resolve(TOOL_RESULT_FMT, "Bash", { content: "(Bash completed with no output)" })!;
    expect(stripAnsi(raw)).toBe("→ Success");
  });

  it("Bash: with output → shows truncated output", () => {
    const raw = resolve(TOOL_RESULT_FMT, "Bash", { content: "hello world" })!;
    expect(stripAnsi(raw)).toBe("→ hello world");
  });

  it("Bash: result in darkGray", () => {
    const raw = resolve(TOOL_RESULT_FMT, "Bash", { content: "" })!;
    expect(raw).toContain("\x1b[90m");
  });

  it("Write new file with _input.content: shows → Created N lines", () => {
    const b = { content: "File created successfully at: /path/file.md", _input: { content: "line1\nline2\nline3" } };
    const raw = resolve(TOOL_RESULT_FMT, "Write", b)!;
    expect(stripAnsi(raw)).toBe("→ Created 3 lines");
  });

  it("Write new file 1 line: singular form", () => {
    const b = { content: "File created successfully at: /path/file.md", _input: { content: "only one line" } };
    const raw = resolve(TOOL_RESULT_FMT, "Write", b)!;
    expect(stripAnsi(raw)).toBe("→ Created 1 line");
  });

  it("Write updated file with _input.content: shows → Updated N lines", () => {
    const b = { content: "The file /path/file.md has been updated successfully.", _input: { content: "line1\nline2" } };
    const raw = resolve(TOOL_RESULT_FMT, "Write", b)!;
    expect(stripAnsi(raw)).toBe("→ Updated 2 lines");
  });

  it("Write without _input: falls back to → <text>", () => {
    const b = { content: "File created successfully at: /path/file.md" };
    const raw = resolve(TOOL_RESULT_FMT, "Write", b)!;
    expect(stripAnsi(raw)).toContain("→ File created");
  });
});

describe("fmtAskUserQuestionInput()", () => {
  it("returns quoted question text for a single question", () => {
    expect(fmtAskUserQuestionInput([{ question: "Which approach?" }])).toBe('"Which approach?"');
  });

  it("joins multiple questions with comma", () => {
    expect(fmtAskUserQuestionInput([{ question: "A?" }, { question: "B?" }])).toBe('"A?", "B?"');
  });

  it("returns empty string for empty array", () => {
    expect(fmtAskUserQuestionInput([])).toBe("");
  });

  it("returns empty string for non-array input", () => {
    expect(fmtAskUserQuestionInput(null)).toBe("");
    expect(fmtAskUserQuestionInput(undefined)).toBe("");
  });
});

describe("fmtTodoWriteInput()", () => {
  it("returns count string for an array of todos", () => {
    const todos = [{ content: "a", status: "pending" }, { content: "b", status: "pending" }];
    expect(fmtTodoWriteInput(todos)).toBe("2 todos");
  });

  it("uses singular for 1 todo", () => {
    expect(fmtTodoWriteInput([{ content: "only" }])).toBe("1 todo");
  });

  it("returns 0 todos for an empty array", () => {
    expect(fmtTodoWriteInput([])).toBe("0 todos");
  });

  it("returns 0 todos for non-array input", () => {
    expect(fmtTodoWriteInput(null)).toBe("0 todos");
    expect(fmtTodoWriteInput(undefined)).toBe("0 todos");
  });
});

describe("fmtToolSearchOutput()", () => {
  it("returns loaded: <name> for a single tool_reference", () => {
    const content = [{ type: "tool_reference", tool_name: "TodoWrite" }];
    expect(fmtToolSearchOutput(content)).toBe("loaded: TodoWrite");
  });

  it("joins multiple tool references with comma", () => {
    const content = [
      { type: "tool_reference", tool_name: "TodoWrite" },
      { type: "tool_reference", tool_name: "TodoRead" },
    ];
    expect(fmtToolSearchOutput(content)).toContain("TodoWrite");
    expect(fmtToolSearchOutput(content)).toContain("TodoRead");
  });

  it("returns loaded: ? when no tool references found", () => {
    expect(fmtToolSearchOutput([])).toBe("loaded: ?");
    expect(fmtToolSearchOutput([{ type: "text", text: "something" }])).toBe("loaded: ?");
  });
});

describe("fmtTodoWriteOutput()", () => {
  it("shows [✓] box for completed todos", () => {
    const b = {
      content: "Todos modified.",
      _msg: { tool_use_result: { newTodos: [{ content: "done task", status: "completed" }] } },
    };
    expect(fmtTodoWriteOutput(b as any)).toContain("[✓] done task");
  });

  it("shows [►] box for in_progress todos", () => {
    const b = {
      content: "Todos modified.",
      _msg: { tool_use_result: { newTodos: [{ content: "active task", status: "in_progress" }] } },
    };
    expect(fmtTodoWriteOutput(b as any)).toContain("[►] active task");
  });

  it("shows [ ] box for pending todos", () => {
    const b = {
      content: "Todos modified.",
      _msg: { tool_use_result: { newTodos: [{ content: "future task", status: "pending" }] } },
    };
    expect(fmtTodoWriteOutput(b as any)).toContain("[ ] future task");
  });

  it("renders multiple todos as a checklist with each item on its own line", () => {
    const b = {
      content: "Todos modified.",
      _msg: {
        tool_use_result: {
          newTodos: [
            { content: "task a", status: "completed" },
            { content: "task b", status: "in_progress" },
            { content: "task c", status: "pending" },
          ],
        },
      },
    };
    const result = fmtTodoWriteOutput(b as any);
    const lines = result.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("[✓] task a");
    expect(lines[1]).toContain("[►] task b");
    expect(lines[2]).toContain("[ ] task c");
  });

  it("returns 'todos cleared' when newTodos is empty", () => {
    const b = { content: "Todos modified.", _msg: { tool_use_result: { newTodos: [] } } };
    expect(fmtTodoWriteOutput(b as any)).toBe("todos cleared");
  });

  it("falls back to text when no tool_use_result", () => {
    const b = { content: "Todos have been modified successfully." };
    const result = fmtTodoWriteOutput(b as any);
    expect(result).toContain("Todos have been modified");
  });
});

describe("TOOL_CALL_FMT — ToolSearch and TodoWrite", () => {
  it("ToolSearch: shows • ToolSearch(<query>) without key= prefix", () => {
    const result = r(TOOL_CALL_FMT, "ToolSearch", { input: { query: "TodoWrite" } });
    expect(result).toContain("• ToolSearch(TodoWrite)");
    expect(result).not.toContain("query=");
  });

  it("TodoWrite: shows • TodoWrite(<N> todo(s)) with count, not [object Object]", () => {
    const todos = [
      { content: "task a", status: "in_progress" },
      { content: "task b", status: "pending" },
      { content: "task c", status: "pending" },
    ];
    const result = r(TOOL_CALL_FMT, "TodoWrite", { input: { todos } });
    expect(result).toContain("• TodoWrite(3 todos)");
    expect(result).not.toContain("[object Object]");
  });

  it("TodoWrite: singular for 1 todo", () => {
    const result = r(TOOL_CALL_FMT, "TodoWrite", { input: { todos: [{ content: "x" }] } });
    expect(result).toContain("• TodoWrite(1 todo)");
  });
});

describe("TOOL_RESULT_FMT — ToolSearch and TodoWrite", () => {
  it("ToolSearch: shows → loaded: <tool name> from tool_reference", () => {
    const b = { content: [{ type: "tool_reference", tool_name: "TodoWrite" }] };
    const result = r(TOOL_RESULT_FMT, "ToolSearch", b)!;
    expect(result).toContain("→ loaded: TodoWrite");
    expect(result).not.toContain("[tool:");
  });

  it("ToolSearch: result in darkGray", () => {
    const b = { content: [{ type: "tool_reference", tool_name: "TodoWrite" }] };
    const raw = resolve(TOOL_RESULT_FMT, "ToolSearch", b)!;
    expect(raw).toContain("\x1b[90m");
  });

  it("TodoWrite: shows → checklist with symbols and content", () => {
    const b = {
      content: "Todos modified.",
      _msg: {
        tool_use_result: {
          newTodos: [
            { content: "a", status: "in_progress" },
            { content: "b", status: "pending" },
          ],
        },
      },
    };
    const result = r(TOOL_RESULT_FMT, "TodoWrite", b)!;
    expect(result).toContain("[►] a");
    expect(result).toContain("[ ] b");
    expect(result).not.toContain("modified successfully");
  });

  it("TodoWrite: result in darkGray", () => {
    const b = {
      content: "Todos modified.",
      _msg: { tool_use_result: { newTodos: [{ content: "a", status: "done" }] } },
    };
    const raw = resolve(TOOL_RESULT_FMT, "TodoWrite", b)!;
    expect(raw).toContain("\x1b[90m");
  });
});

describe("TOOL_ERROR_FMT", () => {
  it("_default: ! <error text> in salmon", () => {
    const raw = resolve(TOOL_ERROR_FMT, "_default", { content: "something went wrong" })!;
    // salmon: \x1b[38;5;203m
    expect(raw).toContain("\x1b[38;5;203m");
    expect(stripAnsi(raw)).toContain("! something went wrong");
  });

  it("AskUserQuestion: denial rendered in dark gray, not salmon", () => {
    const raw = resolve(TOOL_ERROR_FMT, "AskUserQuestion", { content: "The user would like to discuss" })!;
    // darkGray: \x1b[90m, not salmon \x1b[38;5;203m
    expect(raw).toContain("\x1b[90m");
    expect(raw).not.toContain("\x1b[38;5;203m");
    expect(stripAnsi(raw)).toContain("The user would like to discuss");
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

