import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { stripAnsi } from "./helpers.js";
import { Display } from "../src/agent/views/display.js";
import { resolve } from "../src/agent/views/renderer.js";
import type { FmtTable } from "../src/agent/views/renderer.js";
import { fmtStats, fmtTimestamp } from "../shared/formatters.js";
import { getConfig } from "../src/config.js";
import { AgentStatus } from "../src/agent/models/agent-status.js";

let testDisplay: Display;

function captureOutput(fn: () => void): string {
  let output = "";
  vi.spyOn(console, "log").mockImplementation((s: any) => { output += String(s) + "\n"; });
  fn();
  vi.restoreAllMocks();
  return output;
}

function captureRaw(fn: () => void): string {
  let raw = "";
  vi.spyOn(console, "log").mockImplementation((s: any) => { raw += String(s) + "\n"; });
  fn();
  vi.restoreAllMocks();
  return raw;
}

beforeEach(() => {
  testDisplay = new Display(getConfig(), new AgentStatus({ agentId: "test-agent" }));
  testDisplay.toolUseNames.clear();
  testDisplay.stopBar();
  getConfig().verbose = false;
});

afterEach(() => {
  testDisplay.toolUseNames.clear();
  testDisplay.stopBar();
  getConfig().verbose = false;
  vi.restoreAllMocks();
});

describe("resolve()", () => {
  it("key exists as Fmt function → calls it", () => {
    const table: FmtTable = { foo: (d) => `value:${d.x}` };
    const result = resolve(table, "foo", { x: 42 }, false);
    expect(stripAnsi(result!)).toBe("value:42");
  });

  it("key missing, _default exists → calls _default", () => {
    const table: FmtTable = { _default: (d) => `default:${d.x}` };
    const result = resolve(table, "missing", { x: 7 }, false);
    expect(stripAnsi(result!)).toBe("default:7");
  });

  it("key missing, no _default → returns null", () => {
    const table: FmtTable = { foo: (d) => "foo" };
    expect(resolve(table, "missing", {}, false)).toBeNull();
  });

  it("key as { quiet, verbose }, verbose=false → calls quiet", () => {
    const table: FmtTable = {
      foo: { quiet: () => "quiet", verbose: () => "verbose" },
    };
    expect(stripAnsi(resolve(table, "foo", {}, false)!)).toBe("quiet");
  });

  it("key as { quiet, verbose }, verbose=true → calls verbose", () => {
    const table: FmtTable = {
      foo: { quiet: () => "quiet", verbose: () => "verbose" },
    };
    expect(stripAnsi(resolve(table, "foo", {}, true)!)).toBe("verbose");
  });

  it("{ verbose: fn } with verbose=false → returns null", () => {
    const table: FmtTable = { foo: { verbose: () => "v" } };
    expect(resolve(table, "foo", {}, false)).toBeNull();
  });

  it("{ verbose: fn } with verbose=true → calls fn", () => {
    const table: FmtTable = { foo: { verbose: () => "v" } };
    expect(stripAnsi(resolve(table, "foo", {}, true)!)).toBe("v");
  });

  it("formatter returns null → resolve returns null", () => {
    const table: FmtTable = { foo: () => null };
    expect(resolve(table, "foo", {}, false)).toBeNull();
  });
});

describe("ASSISTANT_BLOCK_FMT", () => {
  it("thinking block: thinkOutLoud=true shows content wrapped in gray", () => {
    getConfig().thinkOutLoud = true;
    const raw = captureRaw(() => {
      testDisplay.printBlock({ type: "thinking", thinking: "hello" }, "assistant");
    });
    getConfig().thinkOutLoud = false;
    expect(stripAnsi(raw)).toContain("hello");
    expect(raw).toContain("\x1b[38;5;246m"); // gray
  });

  it("thinking block: thinkOutLoud=false shows 'Thinking...' placeholder in gray", () => {
    const raw = captureRaw(() => {
      testDisplay.printBlock({ type: "thinking", thinking: "hello" }, "assistant");
    });
    expect(stripAnsi(raw)).toContain("Thinking...");
    expect(stripAnsi(raw)).not.toContain("hello");
    expect(raw).toContain("\x1b[38;5;246m"); // gray
  });

  it("text block wraps renderMarkdown in yellow", () => {
    const raw = captureRaw(() => {
      testDisplay.printBlock({ type: "text", text: "world" }, "assistant");
    });
    expect(stripAnsi(raw)).toContain("world");
    expect(raw).toContain("\x1b[38;5;221m"); // yellow
  });

  it("_default block shows [assistant/someType]", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "someType" }, "assistant");
    });
    expect(stripAnsi(output)).toContain("[assistant/someType]");
  });

  it("unknown type falls through to _default", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "unknownType" }, "assistant");
    });
    expect(stripAnsi(output)).toContain("[assistant/unknownType]");
  });
});

describe("USER_BLOCK_FMT", () => {
  it("text block, _isSynthetic=false → raw text", () => {
    const raw = captureRaw(() => {
      testDisplay.printBlock({ type: "text", text: "user said this" }, "user");
    });
    expect(stripAnsi(raw)).toContain("user said this");
    expect(raw).not.toContain("\x1b[90m"); // not darkGray
  });

  it("text block, isSynthetic=true → null (hidden)", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "text", text: "synthetic msg" }, "user", { isSynthetic: true });
    });
    expect(output.trim()).toBe("");
  });

  it("_default: [user/someType]", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "someType" }, "user");
    });
    expect(stripAnsi(output)).toContain("[user/someType]");
  });
});

describe("TOOL_CALL_FMT", () => {
  it("Bash: shows $ <command>", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "Bash", input: { command: "ls -la" } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("$ ls -la");
  });

  it("Read: shows • Read(<file_path>)", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "Read", input: { file_path: "/foo/bar.ts" } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• Read(/foo/bar.ts)");
  });

  it("Write: shows • Write(<file_path>)", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "Write", input: { file_path: "/foo/out.ts" } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• Write(/foo/out.ts)");
  });

  it("Edit: shows • Edit(<file_path>)", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "Edit", input: { file_path: "/foo/edit.ts" } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• Edit(/foo/edit.ts)");
  });

  it("Glob: shows • Glob(<pattern>)", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "Glob", input: { pattern: "**/*.ts" } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• Glob(**/*.ts)");
  });

  it("Grep: shows • grep <pattern> <path>", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "Grep", input: { pattern: "foo", path: "/src" } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• grep foo /src");
  });

  it("Skill: shows • Skill(<skill>)", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "Skill", input: { skill: "test-discipline" } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• Skill(test-discipline)");
  });

  it("Agent: shows • <subagent_type>(<prompt>)", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "Agent", input: { subagent_type: "Explore", prompt: "find files" } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• Explore(find files)");
  });

  it("Agent: shows • Subagent(<prompt>) for general-purpose subagent type", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "Agent", input: { subagent_type: "general-purpose", prompt: "research something" } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• Subagent(research something)");
  });

  it("Agent: shows • Subagent(<prompt>) when subagent_type is missing", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "Agent", input: { prompt: "research something" } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• Subagent(research something)");
  });

  it("AskUserQuestion: shows question text(s)", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({
        type: "tool_use", id: "1", name: "AskUserQuestion",
        input: { questions: [{ question: "Which approach?", header: "Approach", options: [], multiSelect: false }] },
      }, "assistant");
    });
    expect(stripAnsi(output)).toContain('• AskUserQuestion("Which approach?")');
  });

  it("AskUserQuestion: shows multiple question texts", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({
        type: "tool_use", id: "1", name: "AskUserQuestion",
        input: {
          questions: [
            { question: "Which approach?", header: "A", options: [], multiSelect: false },
            { question: "Which format?", header: "B", options: [], multiSelect: false },
          ],
        },
      }, "assistant");
    });
    expect(stripAnsi(output)).toContain('• AskUserQuestion("Which approach?", "Which format?")');
  });

  it("_default: shows • <name>(<fmtArgs(input)>)", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "MyTool", input: { key: "val" } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• MyTool(key=val)");
  });

  it("with input.description: description appended in gray", () => {
    const raw = captureRaw(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "Bash", input: { command: "ls", description: "list files" } }, "assistant");
    });
    expect(raw).toContain("\x1b[38;5;246m"); // gray
    expect(stripAnsi(raw)).toContain("# list files");
  });

  it("without description: no gray suffix", () => {
    const raw = captureRaw(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "Bash", input: { command: "ls" } }, "assistant");
    });
    expect(raw).not.toContain("\x1b[38;5;246m"); // no gray
  });
});

describe("TOOL_RESULT_FMT", () => {
  it("_default: → <truncated text> in darkGray", () => {
    testDisplay.toolUseNames.set("id1", "UnknownTool");
    const raw = captureRaw(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: false, content: "result text" }, "user");
    });
    expect(raw).toContain("\x1b[90m"); // darkGray
    expect(stripAnsi(raw)).toContain("→ result text");
  });

  it("Read: → N line(s) in darkGray", () => {
    testDisplay.toolUseNames.set("id1", "Read");
    const raw = captureRaw(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: false, content: "line1\nline2\nline3" }, "user");
    });
    expect(raw).toContain("\x1b[90m"); // darkGray
    expect(stripAnsi(raw)).toContain("→ 3 lines");
  });

  it("Read: 1 line singular", () => {
    testDisplay.toolUseNames.set("id1", "Read");
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: false, content: "single line" }, "user");
    });
    expect(stripAnsi(output)).toContain("→ 1 line");
  });

  it("Edit with structuredPatch: renders diff", () => {
    testDisplay.toolUseNames.set("id1", "Edit");
    const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] };
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: false, content: "" }, "user",
        { tool_use_result: { structuredPatch: [hunk] } });
    });
    expect(stripAnsi(output)).toContain("@@");
  });

  it("Edit without patch: falls back to → <text>", () => {
    testDisplay.toolUseNames.set("id1", "Edit");
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: false, content: "edited ok" }, "user");
    });
    expect(stripAnsi(output)).toContain("→ edited ok");
  });

  it("Skill: shows → Loaded skill", () => {
    testDisplay.toolUseNames.set("id1", "Skill");
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: false, content: "Base directory for this skill: /some/path\n..." }, "user");
    });
    expect(stripAnsi(output)).toBe("→ Loaded skill\n");
  });

  it("Bash: empty result → → Success", () => {
    testDisplay.toolUseNames.set("id1", "Bash");
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: false, content: "" }, "user");
    });
    expect(stripAnsi(output)).toContain("→ Success");
  });

  it("Bash: no-output message → → Success", () => {
    testDisplay.toolUseNames.set("id1", "Bash");
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: false, content: "(Bash completed with no output)" }, "user");
    });
    expect(stripAnsi(output)).toContain("→ Success");
  });

  it("Bash: with output → shows truncated output", () => {
    testDisplay.toolUseNames.set("id1", "Bash");
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: false, content: "hello world" }, "user");
    });
    expect(stripAnsi(output)).toContain("→ hello world");
  });

  it("Bash: result in darkGray", () => {
    testDisplay.toolUseNames.set("id1", "Bash");
    const raw = captureRaw(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: false, content: "" }, "user");
    });
    expect(raw).toContain("\x1b[90m");
  });

  it("Write new file with _input.content: shows → Created N lines", () => {
    testDisplay.toolUseNames.set("id1", "Write");
    // Pre-populate input cache by printing the tool_use first
    captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "id1", name: "Write", input: { content: "line1\nline2\nline3" } }, "assistant");
    });
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: false, content: "File created successfully at: /path/file.md" }, "user");
    });
    expect(stripAnsi(output)).toContain("→ Created 3 lines");
  });

  it("Write new file 1 line: singular form", () => {
    testDisplay.toolUseNames.set("id1", "Write");
    captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "id1", name: "Write", input: { content: "only one line" } }, "assistant");
    });
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: false, content: "File created successfully at: /path/file.md" }, "user");
    });
    expect(stripAnsi(output)).toContain("→ Created 1 line");
  });

  it("Write updated file with _input.content: shows → Updated N lines", () => {
    testDisplay.toolUseNames.set("id1", "Write");
    captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "id1", name: "Write", input: { content: "line1\nline2" } }, "assistant");
    });
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: false, content: "The file /path/file.md has been updated successfully." }, "user");
    });
    expect(stripAnsi(output)).toContain("→ Updated 2 lines");
  });

  it("Write without prior tool_use input: falls back to → <text>", () => {
    testDisplay.toolUseNames.set("id1", "Write");
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: false, content: "File created successfully at: /path/file.md" }, "user");
    });
    expect(stripAnsi(output)).toContain("→ File created");
  });
});

describe("fmtAskUserQuestionInput — via TOOL_CALL_FMT", () => {
  it("shows quoted question text for a single question", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({
        type: "tool_use", id: "1", name: "AskUserQuestion",
        input: { questions: [{ question: "Which approach?" }] },
      }, "assistant");
    });
    expect(stripAnsi(output)).toContain('"Which approach?"');
  });

  it("joins multiple questions with comma", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({
        type: "tool_use", id: "1", name: "AskUserQuestion",
        input: { questions: [{ question: "A?" }, { question: "B?" }] },
      }, "assistant");
    });
    expect(stripAnsi(output)).toContain('"A?"');
    expect(stripAnsi(output)).toContain('"B?"');
  });

  it("empty question list shown as AskUserQuestion()", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({
        type: "tool_use", id: "1", name: "AskUserQuestion",
        input: { questions: [] },
      }, "assistant");
    });
    expect(stripAnsi(output)).toContain("AskUserQuestion()");
  });

  it("null questions input treated as empty", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({
        type: "tool_use", id: "1", name: "AskUserQuestion",
        input: { questions: null },
      }, "assistant");
    });
    expect(stripAnsi(output)).toContain("AskUserQuestion()");
  });
});

describe("fmtTodoWriteInput — via TOOL_CALL_FMT", () => {
  it("shows count string for an array of todos", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({
        type: "tool_use", id: "1", name: "TodoWrite",
        input: { todos: [{ content: "a", status: "pending" }, { content: "b", status: "pending" }] },
      }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• TodoWrite(2 todos)");
  });

  it("uses singular for 1 todo", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({
        type: "tool_use", id: "1", name: "TodoWrite",
        input: { todos: [{ content: "only" }] },
      }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• TodoWrite(1 todo)");
  });

  it("returns 0 todos for an empty array", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({
        type: "tool_use", id: "1", name: "TodoWrite",
        input: { todos: [] },
      }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• TodoWrite(0 todos)");
  });

  it("returns 0 todos for null input", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({
        type: "tool_use", id: "1", name: "TodoWrite",
        input: { todos: null },
      }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• TodoWrite(0 todos)");
  });
});

describe("fmtToolSearchOutput — via TOOL_RESULT_FMT", () => {
  it("shows loaded: <name> for a single tool_reference", () => {
    testDisplay.toolUseNames.set("id1", "ToolSearch");
    const output = captureOutput(() => {
      testDisplay.printBlock({
        type: "tool_result", tool_use_id: "id1", is_error: false,
        content: [{ type: "tool_reference", tool_name: "TodoWrite" }],
      }, "user");
    });
    expect(stripAnsi(output)).toContain("→ loaded: TodoWrite");
  });

  it("joins multiple tool references", () => {
    testDisplay.toolUseNames.set("id1", "ToolSearch");
    const output = captureOutput(() => {
      testDisplay.printBlock({
        type: "tool_result", tool_use_id: "id1", is_error: false,
        content: [
          { type: "tool_reference", tool_name: "TodoWrite" },
          { type: "tool_reference", tool_name: "TodoRead" },
        ],
      }, "user");
    });
    expect(stripAnsi(output)).toContain("TodoWrite");
    expect(stripAnsi(output)).toContain("TodoRead");
  });

  it("shows loaded: ? when no tool references found", () => {
    testDisplay.toolUseNames.set("id1", "ToolSearch");
    const output = captureOutput(() => {
      testDisplay.printBlock({
        type: "tool_result", tool_use_id: "id1", is_error: false,
        content: [{ type: "text", text: "something" }],
      }, "user");
    });
    expect(stripAnsi(output)).toContain("→ loaded: ?");
  });

  it("result in darkGray", () => {
    testDisplay.toolUseNames.set("id1", "ToolSearch");
    const raw = captureRaw(() => {
      testDisplay.printBlock({
        type: "tool_result", tool_use_id: "id1", is_error: false,
        content: [{ type: "tool_reference", tool_name: "TodoWrite" }],
      }, "user");
    });
    expect(raw).toContain("\x1b[90m");
  });
});

describe("fmtTodoWriteOutput — via TOOL_RESULT_FMT", () => {
  it("shows [✓] box for completed todos", () => {
    testDisplay.toolUseNames.set("id1", "TodoWrite");
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: false, content: "Todos modified." }, "user",
        { tool_use_result: { newTodos: [{ content: "done task", status: "completed" }] } });
    });
    expect(stripAnsi(output)).toContain("[✓] done task");
  });

  it("shows [►] box for in_progress todos", () => {
    testDisplay.toolUseNames.set("id1", "TodoWrite");
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: false, content: "Todos modified." }, "user",
        { tool_use_result: { newTodos: [{ content: "active task", status: "in_progress" }] } });
    });
    expect(stripAnsi(output)).toContain("[►] active task");
  });

  it("shows [ ] box for pending todos", () => {
    testDisplay.toolUseNames.set("id1", "TodoWrite");
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: false, content: "Todos modified." }, "user",
        { tool_use_result: { newTodos: [{ content: "future task", status: "pending" }] } });
    });
    expect(stripAnsi(output)).toContain("[ ] future task");
  });

  it("renders multiple todos with each item on its own line", () => {
    testDisplay.toolUseNames.set("id1", "TodoWrite");
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: false, content: "Todos modified." }, "user",
        {
          tool_use_result: {
            newTodos: [
              { content: "task a", status: "completed" },
              { content: "task b", status: "in_progress" },
              { content: "task c", status: "pending" },
            ],
          },
        });
    });
    const lines = stripAnsi(output).split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("[✓] task a");
    expect(lines[1]).toContain("[►] task b");
    expect(lines[2]).toContain("[ ] task c");
  });

  it("returns 'todos cleared' when newTodos is empty", () => {
    testDisplay.toolUseNames.set("id1", "TodoWrite");
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: false, content: "Todos modified." }, "user",
        { tool_use_result: { newTodos: [] } });
    });
    expect(stripAnsi(output)).toContain("todos cleared");
  });

  it("falls back to text when no tool_use_result", () => {
    testDisplay.toolUseNames.set("id1", "TodoWrite");
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: false, content: "Todos have been modified successfully." }, "user");
    });
    expect(stripAnsi(output)).toContain("Todos have been modified");
  });

  it("result in darkGray", () => {
    testDisplay.toolUseNames.set("id1", "TodoWrite");
    const raw = captureRaw(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: false, content: "Todos modified." }, "user",
        { tool_use_result: { newTodos: [{ content: "a", status: "done" }] } });
    });
    expect(raw).toContain("\x1b[90m");
  });
});

describe("TOOL_CALL_FMT — ToolSearch and TodoWrite", () => {
  it("ToolSearch: shows • ToolSearch(<query>) without key= prefix", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "ToolSearch", input: { query: "TodoWrite" } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• ToolSearch(TodoWrite)");
    expect(stripAnsi(output)).not.toContain("query=");
  });

  it("TodoWrite: shows • TodoWrite(<N> todo(s)) with count, not [object Object]", () => {
    const todos = [
      { content: "task a", status: "in_progress" },
      { content: "task b", status: "pending" },
      { content: "task c", status: "pending" },
    ];
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "TodoWrite", input: { todos } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• TodoWrite(3 todos)");
    expect(stripAnsi(output)).not.toContain("[object Object]");
  });

  it("TodoWrite: singular for 1 todo", () => {
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_use", id: "1", name: "TodoWrite", input: { todos: [{ content: "x" }] } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("• TodoWrite(1 todo)");
  });
});

describe("TOOL_RESULT_FMT — ToolSearch and TodoWrite", () => {
  it("ToolSearch: shows → loaded: <tool name> from tool_reference", () => {
    testDisplay.toolUseNames.set("id1", "ToolSearch");
    const output = captureOutput(() => {
      testDisplay.printBlock({
        type: "tool_result", tool_use_id: "id1", is_error: false,
        content: [{ type: "tool_reference", tool_name: "TodoWrite" }],
      }, "user");
    });
    expect(stripAnsi(output)).toContain("→ loaded: TodoWrite");
    expect(stripAnsi(output)).not.toContain("[tool:");
  });

  it("TodoWrite: shows → checklist with symbols and content", () => {
    testDisplay.toolUseNames.set("id1", "TodoWrite");
    const output = captureOutput(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: false, content: "Todos modified." }, "user",
        {
          tool_use_result: {
            newTodos: [
              { content: "a", status: "in_progress" },
              { content: "b", status: "pending" },
            ],
          },
        });
    });
    expect(stripAnsi(output)).toContain("[►] a");
    expect(stripAnsi(output)).toContain("[ ] b");
    expect(stripAnsi(output)).not.toContain("modified successfully");
  });
});

describe("TOOL_ERROR_FMT", () => {
  it("_default: ! <error text> in salmon", () => {
    testDisplay.toolUseNames.set("id1", "UnknownTool");
    const raw = captureRaw(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: true, content: "something went wrong" }, "user");
    });
    expect(raw).toContain("\x1b[38;5;203m"); // salmon
    expect(stripAnsi(raw)).toContain("! something went wrong");
  });

  it("AskUserQuestion: denial rendered in dark gray, not salmon", () => {
    testDisplay.toolUseNames.set("id1", "AskUserQuestion");
    const raw = captureRaw(() => {
      testDisplay.printBlock({ type: "tool_result", tool_use_id: "id1", is_error: true, content: "The user would like to discuss" }, "user");
    });
    expect(raw).toContain("\x1b[90m"); // darkGray
    expect(raw).not.toContain("\x1b[38;5;203m"); // not salmon
    expect(stripAnsi(raw)).toContain("The user would like to discuss");
  });
});

describe("SYSTEM_FMT", () => {
  afterEach(() => getConfig().verbose = false);

  it("init, VERBOSE=false → nothing printed", () => {
    getConfig().verbose = false;
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "system", subtype: "init", session_id: "abc" });
    });
    expect(output).toBe("");
  });

  it("init, VERBOSE=true → session: <session_id>", () => {
    getConfig().verbose = true;
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "system", subtype: "init", session_id: "abc" });
    });
    expect(stripAnsi(output)).toContain("init: session abc");
  });

  it("task_started → lavender ▶ agent started: <description>", () => {
    const raw = captureRaw(() => {
      testDisplay.printMessage({ type: "system", subtype: "task_started", description: "Running tests" });
    });
    expect(raw).toContain("\x1b[38;5;183m"); // lavender
    expect(stripAnsi(raw)).toContain("▶ agent started: Running tests");
  });

  it("task_progress → lavender • <description>", () => {
    const raw = captureRaw(() => {
      testDisplay.printMessage({ type: "system", subtype: "task_progress", description: "Step 2" });
    });
    expect(raw).toContain("\x1b[38;5;183m"); // lavender
    expect(stripAnsi(raw)).toContain("• Step 2");
  });

  it("task_notification → lavender ◀︎ <status>: <summary>", () => {
    const raw = captureRaw(() => {
      testDisplay.printMessage({ type: "system", subtype: "task_notification", status: "done", summary: "All good" });
    });
    expect(raw).toContain("\x1b[38;5;183m"); // lavender
    expect(stripAnsi(raw)).toContain("done: All good");
  });

  it("compact_boundary (auto) → shows compaction notice with token count", () => {
    const output = captureOutput(() => {
      testDisplay.printMessage({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 50000 },
      });
    });
    expect(stripAnsi(output)).toContain("compacted");
    expect(stripAnsi(output)).toContain("auto");
    expect(stripAnsi(output)).toContain("50k");
  });

  it("compact_boundary (manual) → shows manual trigger", () => {
    const output = captureOutput(() => {
      testDisplay.printMessage({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 10000 },
      });
    });
    expect(stripAnsi(output)).toContain("manual");
  });

  it("compact_boundary → always shown (not verbose-only)", () => {
    getConfig().verbose = false;
    const output = captureOutput(() => {
      testDisplay.printMessage({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 1000 },
      });
    });
    expect(output).not.toBe("");
  });

  it("status/compacting → shows compacting notice (verbose and quiet)", () => {
    for (const v of [false, true]) {
      getConfig().verbose = v;
      const output = captureOutput(() => {
        testDisplay.printMessage({ type: "system", subtype: "status", status: "compacting" });
      });
      expect(output).not.toBe("");
      expect(stripAnsi(output).toLowerCase()).toContain("compact");
    }
  });

  it("status/null → nothing printed (compaction done)", () => {
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "system", subtype: "status", status: null });
    });
    expect(output).toBe("");
  });

  it("hook_started, VERBOSE=false → nothing printed", () => {
    getConfig().verbose = false;
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "system", subtype: "hook_started", hook_name: "my-hook", hook_event: "PreToolUse" });
    });
    expect(output).toBe("");
  });

  it("hook_started, VERBOSE=true → hook: <hook_name> (<hook_event>)", () => {
    getConfig().verbose = true;
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "system", subtype: "hook_started", hook_name: "my-hook", hook_event: "PreToolUse" });
    });
    expect(stripAnsi(output)).toContain("hook: my-hook (PreToolUse)");
  });

  it("hook_response, VERBOSE=false → nothing printed", () => {
    getConfig().verbose = false;
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "system", subtype: "hook_response", hook_name: "my-hook", hook_event: "PreToolUse", outcome: "success" });
    });
    expect(output).toBe("");
  });

  it("hook_response, VERBOSE=true, success → hook: <hook_name> — success", () => {
    getConfig().verbose = true;
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "system", subtype: "hook_response", hook_name: "my-hook", hook_event: "PreToolUse", outcome: "success" });
    });
    expect(stripAnsi(output)).toContain("hook: my-hook — success");
  });

  it("hook_response, VERBOSE=true, error with exit code → includes [exit N]", () => {
    getConfig().verbose = true;
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "system", subtype: "hook_response", hook_name: "lint-hook", hook_event: "PostToolUse", outcome: "error", exit_code: 1 });
    });
    expect(stripAnsi(output)).toContain("hook: lint-hook — error [exit 1]");
  });

  it("hook_response, VERBOSE=true, exit_code=0 → no exit suffix", () => {
    getConfig().verbose = true;
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "system", subtype: "hook_response", hook_name: "my-hook", hook_event: "PreToolUse", outcome: "success", exit_code: 0 });
    });
    expect(stripAnsi(output)).toContain("hook: my-hook — success");
    expect(stripAnsi(output)).not.toContain("[exit");
  });

  it("api_retry → shown in non-verbose mode (not verbose-only)", () => {
    getConfig().verbose = false;
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500 });
    });
    expect(output).not.toBe("");
  });

  it("api_retry → amber warning color", () => {
    const raw = captureRaw(() => {
      testDisplay.printMessage({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500 });
    });
    expect(raw).toContain("\x1b[38;5;214m"); // amber
  });

  it("api_retry → 'API failure, retrying in Xs (attempt N/M)'", () => {
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 545.686 });
    });
    expect(stripAnsi(output)).toContain("API failure, retrying in 0.5s (attempt 1/10)");
  });

  it("api_retry → rounds delay to 1 decimal place", () => {
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "system", subtype: "api_retry", attempt: 3, max_retries: 5, retry_delay_ms: 2000 });
    });
    expect(stripAnsi(output)).toContain("API failure, retrying in 2s (attempt 3/5)");
  });

  it("api_retry with error_status → includes status code in message", () => {
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 429, error: "rate_limit" });
    });
    expect(stripAnsi(output)).toContain("API failure (429), retrying in 0.5s (attempt 1/10)");
  });

  it("api_retry with error_status null and named error → includes error name", () => {
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 5, retry_delay_ms: 1000, error_status: null, error: "server_error" });
    });
    expect(stripAnsi(output)).toContain("API failure (server_error), retrying in 1s (attempt 2/5)");
  });

  it("api_retry with error_status null and error 'unknown' → no detail appended", () => {
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 3, retry_delay_ms: 500, error_status: null, error: "unknown" });
    });
    expect(stripAnsi(output)).toContain("API failure, retrying in 0.5s (attempt 1/3)");
  });

  it("api_retry with error_status present and error 'unknown' → shows status code not error string", () => {
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 3, retry_delay_ms: 500, error_status: 503, error: "unknown" });
    });
    expect(stripAnsi(output)).toContain("API failure (503), retrying in 0.5s (attempt 1/3)");
  });

  it("_default, VERBOSE=false → nothing printed", () => {
    getConfig().verbose = false;
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "system", subtype: "unknown_subtype" });
    });
    expect(output).toBe("");
  });

  it("_default, VERBOSE=true → system/<subtype>", () => {
    getConfig().verbose = true;
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "system", subtype: "whatever" });
    });
    expect(stripAnsi(output)).toContain("system/whatever");
  });
});

describe("MESSAGE_FMT", () => {
  afterEach(() => getConfig().verbose = false);

  it("_empty → [<type> — empty] in darkGray", () => {
    const raw = captureRaw(() => {
      testDisplay.printMessage({ type: "assistant", message: { content: [] } });
    });
    expect(raw).toContain("\x1b[90m"); // darkGray
    expect(stripAnsi(raw)).toContain("[assistant — empty]");
  });

  it("result → \\n<fmtStats(...)> in darkGray", () => {
    const raw = captureRaw(() => {
      testDisplay.printMessage({
        type: "result",
        duration_ms: 5000,
        num_turns: 2,
        usage: { output_tokens: 150, input_tokens: 800 },
      });
    });
    expect(raw).toContain("\x1b[90m"); // darkGray
    const text = stripAnsi(raw);
    expect(text).toContain("5s");
    expect(text).toContain("2 turns");
    expect(text).toContain("800 in");
    expect(text).toContain("150 out");
  });

  it("result message includes cost when available", () => {
    const raw = captureRaw(() => {
      testDisplay.printMessage({
        type: "result",
        duration_ms: 5000,
        num_turns: 2,
        usage: { input_tokens: 100, output_tokens: 250 },
        total_cost_usd: 0.15,
      });
    });
    const text = stripAnsi(raw);
    expect(text).toContain("cost: $0.15");
  });

  it("result message omits cost when not available", () => {
    const raw = captureRaw(() => {
      testDisplay.printMessage({
        type: "result",
        duration_ms: 5000,
        num_turns: 2,
        usage: { input_tokens: 100, output_tokens: 250 },
      });
    });
    const text = stripAnsi(raw);
    expect(text).not.toContain("cost");
  });

  it("rate_limit_event, status=allowed, VERBOSE=false → nothing printed", () => {
    getConfig().verbose = false;
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
    });
    expect(output).toBe("");
  });

  it("rate_limit_event, status=allowed, VERBOSE=true → nothing printed (silenced)", () => {
    getConfig().verbose = true;
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
    });
    expect(output).toBe("");
  });

  it("rate_limit_event, status=allowed_warning, VERBOSE=false → shows warning", () => {
    getConfig().verbose = false;
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.85 } });
    });
    expect(output).not.toBe("");
    expect(stripAnsi(output)).toContain("Usage warning: 85% of seven-day usage limit");
  });

  it("rate_limit_event, status=allowed_warning, VERBOSE=true → shows warning", () => {
    getConfig().verbose = true;
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.85 } });
    });
    expect(stripAnsi(output)).toContain("Usage warning: 85% of seven-day usage limit");
  });

  it("rate_limit_event, five_hour type → formats correctly", () => {
    getConfig().verbose = false;
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.72 } });
    });
    expect(stripAnsi(output)).toContain("Usage warning: 72% of five-hour usage limit");
  });

  it("rate_limit_event, seven_day_sonnet type → formats correctly", () => {
    getConfig().verbose = false;
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day_sonnet", utilization: 0.9 } });
    });
    expect(stripAnsi(output)).toContain("Usage warning: 90% of seven-day Sonnet usage limit");
  });

  it("rate_limit_event, status=allowed_warning, no rateLimitType → omits limit type", () => {
    getConfig().verbose = false;
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", utilization: 0.82 } });
    });
    expect(stripAnsi(output)).toContain("Usage warning: 82% used");
  });

  it("rate_limit_event, status=rejected, VERBOSE=false → shows rejection", () => {
    getConfig().verbose = false;
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } });
    });
    expect(output).not.toBe("");
    expect(stripAnsi(output)).toContain("Usage limit reached");
  });

  it("rate_limit_event, status=rejected, with rateLimitType → includes limit type", () => {
    getConfig().verbose = false;
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day_opus" } });
    });
    expect(stripAnsi(output)).toContain("Usage limit reached: seven-day Opus usage limit");
  });

  it("_default → msg: <type>", () => {
    const output = captureOutput(() => {
      testDisplay.printMessage({ type: "whatever" });
    });
    expect(stripAnsi(output)).toContain("msg: whatever");
  });
});

describe("fmtStats - cost formatting", () => {
  it("includes cost when provided", () => {
    const result = fmtStats(60, 2, 100, 50, 0.25);
    expect(result).toContain("cost: $0.25");
  });

  it("omits cost when cost is undefined", () => {
    const result = fmtStats(60, 2, 100, 50);
    expect(result).not.toContain("cost");
  });

  it("formats cost with two decimal places", () => {
    const result = fmtStats(60, 2, 100, 50, 0.1234);
    expect(result).toContain("cost: $0.12");
  });

  it("formats cost correctly at zero", () => {
    const result = fmtStats(60, 2, 100, 50, 0);
    expect(result).toContain("cost: $0.00");
  });

  it("places cost at the end of the string", () => {
    const result = fmtStats(60, 2, 100, 50, 0.50);
    expect(result).toMatch(/cost: \$0\.50$/);
  });
});

describe("fmtTimestamp", () => {
  afterEach(() => vi.useRealTimers());

  it("formats date portion as YYYY-MM-DD followed by a space", () => {
    const d = new Date(2026, 4, 17, 14, 30, 56); // May 17, 2026
    expect(fmtTimestamp(d)).toMatch(/^2026-05-17 /);
  });

  it("includes hours, minutes, and seconds in the time portion", () => {
    const d = new Date(2026, 4, 17, 14, 30, 56);
    expect(fmtTimestamp(d)).toMatch(/\d+:\d{2}:\d{2}/);
  });

  it("includes a timezone abbreviation (uppercase letters)", () => {
    const d = new Date(2026, 4, 17, 14, 30, 56);
    expect(fmtTimestamp(d)).toMatch(/[A-Z]{2,}/);
  });

  it("uses current time when called with no argument", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 17, 9, 0, 0));
    expect(fmtTimestamp()).toMatch(/^2026-05-17 /);
  });
});

describe("MESSAGE_FMT result — timestamp", () => {
  afterEach(() => vi.useRealTimers());

  it("result message includes the current date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 17, 14, 30, 56));
    const raw = captureOutput(() => {
      testDisplay.printMessage({
        type: "result",
        duration_ms: 5000,
        num_turns: 2,
        usage: { output_tokens: 150, input_tokens: 800 },
      });
    });
    expect(stripAnsi(raw)).toContain("2026-05-17");
  });
});
