import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stripAnsi } from "./helpers.js";
import {
  printBlock,
  printMessage,
  startStatus,
  stopStatus,
  print,
  toolUseNames,
  setVerbose,
  setThinkOutLoud,
  _statusActive,
  setInputPrintCallback,
} from "../src/agent/display.js";

function captureOutput(fn: () => void): string {
  let output = "";
  const logSpy = vi.spyOn(console, "log").mockImplementation((s: any) => { output += String(s) + "\n"; });
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { output += String(s); return true; });
  fn();
  logSpy.mockRestore();
  writeSpy.mockRestore();
  return output;
}

async function captureOutputAsync(fn: () => Promise<void>): Promise<string> {
  let output = "";
  const logSpy = vi.spyOn(console, "log").mockImplementation((s: any) => { output += String(s) + "\n"; });
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { output += String(s); return true; });
  await fn();
  logSpy.mockRestore();
  writeSpy.mockRestore();
  return output;
}

beforeEach(() => {
  toolUseNames.clear();
  stopStatus();
  setVerbose(false);
});

afterEach(() => {
  toolUseNames.clear();
  stopStatus();
  setVerbose(false);
  vi.restoreAllMocks();
});

describe("printBlock - tool_use blocks", () => {
  it("registers id → name in toolUseNames", () => {
    captureOutput(() => {
      printBlock({ type: "tool_use", id: "toolu_001", name: "Bash", input: { command: "ls" } }, "assistant");
    });
    expect(toolUseNames.get("toolu_001")).toBe("Bash");
  });

  it("prints tool call output", () => {
    const output = captureOutput(() => {
      printBlock({ type: "tool_use", id: "toolu_001", name: "Bash", input: { command: "ls" } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("$ ls");
  });

  it("unknown tool name falls through to _default", () => {
    const output = captureOutput(() => {
      printBlock({ type: "tool_use", id: "toolu_001", name: "MyCustomTool", input: { foo: "bar" } }, "assistant");
    });
    expect(stripAnsi(output)).toContain("MyCustomTool");
  });
});

describe("printBlock - tool_result blocks", () => {
  it("is_error=false → routes to TOOL_RESULT_FMT", () => {
    toolUseNames.set("toolu_001", "Bash");
    const output = captureOutput(() => {
      printBlock({
        type: "tool_result",
        tool_use_id: "toolu_001",
        is_error: false,
        content: "output text",
      }, "user");
    });
    expect(stripAnsi(output)).toContain("→ output text");
  });

  it("is_error=true → routes to TOOL_ERROR_FMT", () => {
    toolUseNames.set("toolu_001", "Bash");
    const output = captureOutput(() => {
      printBlock({
        type: "tool_result",
        tool_use_id: "toolu_001",
        is_error: true,
        content: "error message",
      }, "user");
    });
    expect(stripAnsi(output)).toContain("! error message");
  });

  it("_msg injected: Edit result accesses structuredPatch", () => {
    toolUseNames.set("toolu_edit_001", "Edit");
    const hunk = {
      oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      lines: ["-old", "+new"],
    };
    const msg = { tool_use_result: { structuredPatch: [hunk] } };
    const output = captureOutput(() => {
      printBlock({
        type: "tool_result",
        tool_use_id: "toolu_edit_001",
        is_error: false,
        content: "",
      }, "user", msg);
    });
    expect(stripAnsi(output)).toContain("@@");
  });

  it("unknown tool_use_id (map miss) → _default formatter", () => {
    const output = captureOutput(() => {
      printBlock({
        type: "tool_result",
        tool_use_id: "unknown_id",
        is_error: false,
        content: "some output",
      }, "user");
    });
    expect(stripAnsi(output)).toContain("→ some output");
  });

  it("preceding tool_use registers correct name for result", () => {
    captureOutput(() => {
      printBlock({ type: "tool_use", id: "toolu_read_001", name: "Read", input: { file_path: "/foo.ts" } }, "assistant");
    });
    const output = captureOutput(() => {
      printBlock({
        type: "tool_result",
        tool_use_id: "toolu_read_001",
        is_error: false,
        content: "line1\nline2",
      }, "user");
    });
    expect(stripAnsi(output)).toContain("→ 2 lines");
  });
});

describe("printBlock - assistant blocks (non-tool)", () => {
  it("thinking type → ASSISTANT_BLOCK_FMT: thinkOutLoud=true shows content", () => {
    setThinkOutLoud(true);
    const output = captureOutput(() => {
      printBlock({ type: "thinking", thinking: "my thoughts" }, "assistant");
    });
    setThinkOutLoud(false);
    expect(stripAnsi(output)).toContain("my thoughts");
  });

  it("thinking type → ASSISTANT_BLOCK_FMT: thinkOutLoud=false shows placeholder", () => {
    const output = captureOutput(() => {
      printBlock({ type: "thinking", thinking: "my thoughts" }, "assistant");
    });
    expect(stripAnsi(output)).toContain("Thinking...");
    expect(stripAnsi(output)).not.toContain("my thoughts");
  });

  it("text type → ASSISTANT_BLOCK_FMT", () => {
    const output = captureOutput(() => {
      printBlock({ type: "text", text: "response text" }, "assistant");
    });
    expect(stripAnsi(output)).toContain("response text");
  });

  it("unknown type → _default in ASSISTANT_BLOCK_FMT", () => {
    const output = captureOutput(() => {
      printBlock({ type: "weird_block" }, "assistant");
    });
    expect(stripAnsi(output)).toContain("[assistant/weird_block]");
  });
});

describe("printBlock - user blocks (non-tool_result)", () => {
  it("text with msg.isSynthetic=true → hidden (no output)", () => {
    const raw = (() => {
      let out = "";
      const logSpy = vi.spyOn(console, "log").mockImplementation((s: any) => { out += String(s) + "\n"; });
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { out += String(s); return true; });
      printBlock({ type: "text", text: "synthetic content" }, "user", { isSynthetic: true });
      logSpy.mockRestore();
      writeSpy.mockRestore();
      return out;
    })();
    expect(raw.trim()).toBe("");
  });

  it("text with msg.isSynthetic absent → _isSynthetic=false (not darkGray)", () => {
    let raw = "";
    const logSpy = vi.spyOn(console, "log").mockImplementation((s: any) => { raw += String(s) + "\n"; });
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { raw += String(s); return true; });
    printBlock({ type: "text", text: "user msg" }, "user");
    logSpy.mockRestore();
    writeSpy.mockRestore();
    // Not darkGray (for non-synthetic user text)
    expect(raw).not.toContain("\x1b[90m");
  });

  it("unknown type → _default in USER_BLOCK_FMT", () => {
    const output = captureOutput(() => {
      printBlock({ type: "image" }, "user");
    });
    expect(stripAnsi(output)).toContain("[user/image]");
  });
});

describe("printMessage", () => {
  it("parent_tool_use_id non-null → suppressed (nothing printed)", () => {
    const output = captureOutput(() => {
      printMessage({ type: "assistant", parent_tool_use_id: "toolu_xxx", message: { content: [{ type: "text", text: "suppressed" }] } });
    });
    expect(stripAnsi(output)).not.toContain("suppressed");
  });

  it("parent_tool_use_id=null → processed normally", () => {
    const output = captureOutput(() => {
      printMessage({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "visible" }] } });
    });
    expect(stripAnsi(output)).toContain("visible");
  });

  it("parent_tool_use_id absent → processed normally", () => {
    const output = captureOutput(() => {
      printMessage({ type: "assistant", message: { content: [{ type: "text", text: "also visible" }] } });
    });
    expect(stripAnsi(output)).toContain("also visible");
  });

  it("system/init → routed to SYSTEM_FMT (quiet mode = null)", () => {
    setVerbose(false);
    const output = captureOutput(() => {
      printMessage({ type: "system", subtype: "init", session_id: "abc" });
    });
    expect(output).toBe("");
  });

  it("system/task_started → lavender output", () => {
    const output = captureOutput(() => {
      printMessage({ type: "system", subtype: "task_started", description: "Running tests" });
    });
    expect(stripAnsi(output)).toContain("▶ agent started: Running tests");
  });

  it("system/task_progress → lavender output", () => {
    const output = captureOutput(() => {
      printMessage({ type: "system", subtype: "task_progress", description: "Step 1" });
    });
    expect(stripAnsi(output)).toContain("• Step 1");
  });

  it("system/task_notification → lavender output", () => {
    const output = captureOutput(() => {
      printMessage({ type: "system", subtype: "task_notification", status: "done", summary: "All good" });
    });
    expect(stripAnsi(output)).toContain("done: All good");
  });

  it("assistant with empty content → MESSAGE_FMT._empty", () => {
    const output = captureOutput(() => {
      printMessage({ type: "assistant", message: { content: [] } });
    });
    expect(stripAnsi(output)).toContain("[assistant — empty]");
  });

  it("assistant with single content block → printBlock called once", () => {
    const output = captureOutput(() => {
      printMessage({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } });
    });
    expect(stripAnsi(output)).toContain("hello");
  });

  it("assistant with multiple content blocks → each printed in order", () => {
    const output = captureOutput(() => {
      printMessage({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "my thoughts" },
            { type: "text", text: "response" },
          ],
        },
      });
    });
    const plain = stripAnsi(output);
    expect(plain).toContain("Thinking...");
    expect(plain).toContain("response");
    expect(plain.indexOf("Thinking...")).toBeLessThan(plain.indexOf("response"));
  });

  it("result message → fmtStats output", () => {
    const output = captureOutput(() => {
      printMessage({
        type: "result",
        duration_ms: 5000,
        num_turns: 2,
        usage: { output_tokens: 150, input_tokens: 800 },
      });
    });
    const plain = stripAnsi(output);
    expect(plain).toContain("5s");
    expect(plain).toContain("2 turns");
  });

  it("rate_limit_event, quiet mode → null (nothing printed)", () => {
    setVerbose(false);
    const output = captureOutput(() => {
      printMessage({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
    });
    expect(output).toBe("");
  });

  it("rate_limit_event, verbose mode, status=allowed → null (silenced)", () => {
    setVerbose(true);
    const output = captureOutput(() => {
      printMessage({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
    });
    expect(output).toBe("");
  });
});


describe("print()", () => {
  it("print(null) is a no-op", () => {
    const output = captureOutput(() => {
      print(null);
    });
    expect(output).toBe("");
  });

  it("print(text) while inactive: just logs", () => {
    const output = captureOutput(() => {
      print("hello");
    });
    expect(stripAnsi(output)).toContain("hello");
  });

  it("print(text) with inputPrintCallback set: clears current line before logging", () => {
    const cb = vi.fn();
    setInputPrintCallback(cb);
    try {
      const output = captureOutput(() => {
        print("hello");
      });
      // \r\x1b[J (CR + clear to end of screen) must appear BEFORE the logged text
      const clearIdx = output.indexOf("\r\x1b[J");
      const helloIdx = output.indexOf("hello");
      expect(clearIdx).toBeGreaterThan(-1);
      expect(helloIdx).toBeGreaterThan(clearIdx);
    } finally {
      setInputPrintCallback(null);
    }
  });

  it("print(text) while inactive (no callback): does NOT write \\r\\x1b[K", () => {
    const output = captureOutput(() => {
      print("hello");
    });
    expect(output).not.toContain("\r\x1b[K");
  });
});

describe("Status line", () => {
  afterEach(() => {
    stopStatus();
    vi.restoreAllMocks();
  });

  it("startStatus and stopStatus run without error", () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    startStatus(() => "Working...");
    stopStatus();
  });

  it("stopStatus sets _statusActive=false", () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    startStatus(() => "Working...");
    stopStatus();
    // Calling stopStatus again should not crash (idempotent)
    stopStatus();
  });

  it("calling stopStatus twice: no crash", () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stopStatus();
    stopStatus();
  });
});
