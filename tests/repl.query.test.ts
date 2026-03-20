import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stripAnsi } from "./helpers.js";

// Mock the SDK before importing runQuery
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

// Also mock fs.appendFileSync so logFull doesn't write to disk in tests
vi.mock("fs", () => ({
  default: {
    appendFileSync: vi.fn(),
  },
}));

vi.mock("../src/input.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    pick:         vi.fn().mockResolvedValue(0),
    pickMultiple: vi.fn().mockResolvedValue([]),
    pickQuestion: vi.fn().mockResolvedValue({ type: "answer", value: "Fast" }),
  };
});

import { PassThrough } from "stream";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { runQuery } from "../src/repl.js";
import { ask, pick, pickMultiple, pickQuestion } from "../src/input.js";
import { toolUseNames, stopStatus, setVerbose } from "../src/display.js";

function mockQueryMessages(messages: object[]) {
  (query as any).mockImplementation((_opts: any) => {
    return (async function* () {
      for (const m of messages) yield m;
    })();
  });
}

function captureConsole() {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((s: any) => { lines.push(String(s)); });
  const errSpy = vi.spyOn(console, "error").mockImplementation((s: any) => { lines.push(String(s)); });
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return {
    lines,
    restore() {
      logSpy.mockRestore();
      errSpy.mockRestore();
      writeSpy.mockRestore();
    },
  };
}

beforeEach(() => {
  toolUseNames.clear();
  stopStatus();
  setVerbose(false);
  vi.clearAllMocks();
});

afterEach(() => {
  stopStatus();
  vi.restoreAllMocks();
});

describe("runQuery - session ID", () => {
  it("system/init message with session_id → runQuery returns it", async () => {
    mockQueryMessages([
      { type: "system", subtype: "init", session_id: "abc-123" },
      { type: "result", duration_ms: 100, num_turns: 1, usage: { input_tokens: 10, output_tokens: 20 } },
    ]);
    const cap = captureConsole();
    try {
      const sid = await runQuery("hello", undefined);
      expect(sid).toBe("abc-123");
    } finally {
      cap.restore();
    }
  });

  it("no system/init message → returns undefined", async () => {
    mockQueryMessages([
      { type: "result", duration_ms: 100, num_turns: 1, usage: { input_tokens: 10, output_tokens: 20 } },
    ]);
    const cap = captureConsole();
    try {
      const sid = await runQuery("hello", undefined);
      expect(sid).toBeUndefined();
    } finally {
      cap.restore();
    }
  });

  it("runQuery with existing sessionId → query called with resume", async () => {
    mockQueryMessages([
      { type: "result", duration_ms: 100, num_turns: 1, usage: { input_tokens: 10, output_tokens: 20 } },
    ]);
    const cap = captureConsole();
    try {
      await runQuery("hello", "existing-session-id");
    } finally {
      cap.restore();
    }
    const callArg = (query as any).mock.calls[0][0];
    expect(callArg.options.resume).toBe("existing-session-id");
  });

  it("runQuery with undefined sessionId → query called without resume key", async () => {
    mockQueryMessages([
      { type: "result", duration_ms: 100, num_turns: 1, usage: { input_tokens: 10, output_tokens: 20 } },
    ]);
    const cap = captureConsole();
    try {
      await runQuery("hello", undefined);
    } finally {
      cap.restore();
    }
    const callArg = (query as any).mock.calls[0][0];
    expect(callArg.options.resume).toBeUndefined();
  });
});

describe("runQuery - stream event stat accumulation", () => {
  it("multi-turn stat accumulation", async () => {
    mockQueryMessages([
      { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { usage: { input_tokens: 100 } } } },
      { type: "stream_event", parent_tool_use_id: null, event: { type: "message_delta", usage: { output_tokens: 50 } } },
      { type: "stream_event", parent_tool_use_id: null, event: { type: "message_stop" } },
      { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { usage: { input_tokens: 200 } } } },
      { type: "stream_event", parent_tool_use_id: null, event: { type: "message_delta", usage: { output_tokens: 30 } } },
      { type: "stream_event", parent_tool_use_id: null, event: { type: "message_stop" } },
      { type: "result", duration_ms: 2000, num_turns: 2, usage: { input_tokens: 300, output_tokens: 80 } },
    ]);

    const cap = captureConsole();
    try {
      await runQuery("test", undefined);
    } finally {
      cap.restore();
    }
    // Verify result was printed (which means processing completed correctly)
    const plain = cap.lines.map(stripAnsi).join("\n");
    expect(plain).toContain("2s");
  });

  it("stream events with parent_tool_use_id != null → not counted in stats", async () => {
    mockQueryMessages([
      // subagent stream events should not increment stats
      { type: "stream_event", parent_tool_use_id: "toolu_agent", event: { type: "message_start", message: { usage: { input_tokens: 999 } } } },
      { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { usage: { input_tokens: 50 } } } },
      { type: "stream_event", parent_tool_use_id: null, event: { type: "message_stop" } },
      { type: "result", duration_ms: 1000, num_turns: 1, usage: { input_tokens: 50, output_tokens: 10 } },
    ]);
    const cap = captureConsole();
    try {
      await runQuery("test", undefined);
    } finally {
      cap.restore();
    }
    // Subagent tokens (999) must not appear in the stats output; only the top-level 50 in.
    const plain = cap.lines.map(stripAnsi).join("\n");
    expect(plain).not.toContain("999");
  });
});

describe("runQuery - message processing", () => {
  it("stream_event messages not passed to printMessage (only to stats)", async () => {
    mockQueryMessages([
      { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { usage: { input_tokens: 10 } } } },
      { type: "result", duration_ms: 100, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const cap = captureConsole();
    try {
      await runQuery("test", undefined);
    } finally {
      cap.restore();
    }
    // Only result should be in output; message_start (stream_event) should not produce visible output
    const plain = cap.lines.map(stripAnsi).join("\n");
    // Should NOT contain anything from message_start
    expect(plain).not.toContain("message_start");
  });

  it("non-stream messages are printed", async () => {
    mockQueryMessages([
      { type: "assistant", message: { content: [{ type: "text", text: "I can help." }] } },
      { type: "result", duration_ms: 100, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const cap = captureConsole();
    try {
      await runQuery("test", undefined);
    } finally {
      cap.restore();
    }
    const plain = cap.lines.map(stripAnsi).join("\n");
    expect(plain).toContain("I can help.");
  });
});

describe("runQuery - logFull behavior", () => {
  it("content_block_delta stream events NOT logged", async () => {
    const { default: fs } = await import("fs");
    mockQueryMessages([
      { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } } },
      { type: "result", duration_ms: 100, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const cap = captureConsole();
    try {
      await runQuery("test", undefined);
    } finally {
      cap.restore();
    }
    // Check that appendFileSync was NOT called with content_block_delta
    const calls = (fs.appendFileSync as any).mock.calls;
    const hasContentBlockDelta = calls.some((call: any[]) =>
      String(call[1]).includes("content_block_delta")
    );
    expect(hasContentBlockDelta).toBe(false);
  });

  it("non-stream messages ARE logged", async () => {
    const { default: fs } = await import("fs");
    mockQueryMessages([
      { type: "assistant", message: { content: [{ type: "text", text: "response" }] } },
      { type: "result", duration_ms: 100, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const cap = captureConsole();
    try {
      await runQuery("test", undefined);
    } finally {
      cap.restore();
    }
    const calls = (fs.appendFileSync as any).mock.calls;
    const hasAssistantMessage = calls.some((call: any[]) =>
      String(call[1]).includes("MESSAGE")
    );
    expect(hasAssistantMessage).toBe(true);
  });
});

describe("runQuery - error handling", () => {
  it("query() throws Error → error propagates out of runQuery", async () => {
    (query as any).mockImplementation(() => {
      throw new Error("network failure");
    });
    const cap = captureConsole();
    let thrown: unknown;
    try {
      await runQuery("test", undefined);
    } catch (err) {
      thrown = err;
    } finally {
      cap.restore();
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("network failure");
  });
});

describe("runQuery - interrupt support", () => {
  it("passes provided abortController to SDK query options", async () => {
    mockQueryMessages([
      { type: "result", duration_ms: 100, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const cap = captureConsole();
    const ac = new AbortController();
    try {
      await runQuery("test", undefined, ac);
    } finally {
      cap.restore();
    }
    const callArg = (query as any).mock.calls[0][0];
    expect(callArg.options.abortController).toBe(ac);
  });

  it("aborted mid-query → returns without throwing, prints Interrupted.", async () => {
    // Mock a generator that ends when the AbortController is aborted
    (query as any).mockImplementation((opts: any) => {
      return (async function* () {
        // Simulate the SDK: wait until aborted, then end without result message
        await new Promise<void>((resolve) => {
          opts.options.abortController.signal.addEventListener("abort", resolve, { once: true });
        });
        // No result message emitted — generator just ends
      })();
    });

    const cap = captureConsole();
    const ac = new AbortController();
    let thrown: unknown;
    try {
      // Abort after a short delay
      setTimeout(() => ac.abort(), 5);
      await runQuery("test", "sess-1", ac);
    } catch (err) {
      thrown = err;
    } finally {
      cap.restore();
    }

    expect(thrown).toBeUndefined(); // no throw
    const output = cap.lines.map(stripAnsi).join("\n");
    expect(output).toContain("Interrupted.");
  });

  it("aborted mid-query → returns sessionId", async () => {
    (query as any).mockImplementation((opts: any) => {
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "new-sess" };
        await new Promise<void>((resolve) => {
          opts.options.abortController.signal.addEventListener("abort", resolve, { once: true });
        });
      })();
    });

    const cap = captureConsole();
    const ac = new AbortController();
    let sessionId: string | undefined;
    try {
      setTimeout(() => ac.abort(), 5);
      sessionId = await runQuery("test", undefined, ac);
    } finally {
      cap.restore();
    }
    expect(sessionId).toBe("new-sess");
  });

  it("normal completion does not print Interrupted.", async () => {
    mockQueryMessages([
      { type: "result", duration_ms: 100, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const cap = captureConsole();
    try {
      await runQuery("test", undefined);
    } finally {
      cap.restore();
    }
    const output = cap.lines.map(stripAnsi).join("\n");
    expect(output).not.toContain("Interrupted.");
  });

  it("stdin data listener is removed after normal query completion", async () => {
    mockQueryMessages([
      { type: "result", duration_ms: 100, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const before = process.stdin.listenerCount("data");
    const cap = captureConsole();
    try {
      await runQuery("test", undefined);
    } finally {
      cap.restore();
    }
    expect(process.stdin.listenerCount("data")).toBe(before);
  });
});

describe("runQuery - interrupt via ^C on stdin", () => {
  it("^C on stdin → calls close() on query iterable, does not echo ^C to stdout", async () => {
    let closeCalled = false;
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => { resolveClose = resolve; });

    (query as any).mockImplementation((_opts: any) => {
      const gen = (async function* () {
        await closePromise;
        // generator ends without emitting result
      })();
      (gen as any).close = () => { closeCalled = true; resolveClose(); };
      return gen;
    });

    const origStdin = process.stdin;
    const fakeStdin = new PassThrough();
    fakeStdin.setEncoding("utf8");
    (fakeStdin as any).setRawMode = vi.fn();
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });

    const writtenToStdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { writtenToStdout.push(String(s)); return true; });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const queryPromise = runQuery("test", undefined);
      await new Promise((r) => setTimeout(r, 5));
      fakeStdin.push("\x03");
      await queryPromise;
    } finally {
      Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
      vi.restoreAllMocks();
    }

    expect(closeCalled).toBe(true);
    // stdout must NOT contain the "^C" echo
    const stdoutStr = writtenToStdout.join("");
    expect(stdoutStr).not.toContain("^C");
  });

  it("SDK throwing 'aborted by user' error is caught, not rethrown, prints Interrupted.", async () => {
    (query as any).mockImplementation((_opts: any) => {
      const gen = (async function* () {
        throw new Error("Claude Code process aborted by user");
      })();
      (gen as any).close = () => {};
      return gen;
    });

    const cap = captureConsole();
    let thrown: unknown;
    try {
      await runQuery("test", "sess-1");
    } catch (err) {
      thrown = err;
    } finally {
      cap.restore();
    }

    expect(thrown).toBeUndefined();
    const output = cap.lines.map(stripAnsi).join("\n");
    expect(output).toContain("Interrupted.");
  });

  it("SDK throwing unrelated error still propagates", async () => {
    (query as any).mockImplementation((_opts: any) => {
      const gen = (async function* () {
        throw new Error("network failure");
      })();
      (gen as any).close = () => {};
      return gen;
    });

    const cap = captureConsole();
    let thrown: unknown;
    try {
      await runQuery("test", undefined);
    } catch (err) {
      thrown = err;
    } finally {
      cap.restore();
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("network failure");
  });
});

describe("runQuery - canUseTool callback registration", () => {
  it("query() is called with a canUseTool callback defined", async () => {
    mockQueryMessages([
      { type: "result", duration_ms: 100, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const cap = captureConsole();
    try {
      await runQuery("test", undefined);
    } finally {
      cap.restore();
    }
    const callArg = (query as any).mock.calls[0][0];
    expect(typeof callArg.options.canUseTool).toBe("function");
  });
});

describe("runQuery - AskUserQuestion handling", () => {
  const FAKE_OPTIONS = { signal: new AbortController().signal, toolUseID: "tu_1" };

  const singleQuestion = {
    questions: [{
      question: "Which approach?",
      header: "Approach",
      options: [
        { label: "Fast", description: "Speed first" },
        { label: "Safe", description: "Safety first" },
      ],
      multiSelect: false,
    }],
  };

  it("returns behavior:allow with answer injected for single-select", async () => {
    vi.mocked(pickQuestion).mockResolvedValueOnce({ type: "answer", value: "Safe" });
    mockQueryMessages([
      { type: "result", duration_ms: 100, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const cap = captureConsole();
    let canUseTool: Function;
    try {
      await runQuery("test", undefined);
      canUseTool = (query as any).mock.calls[0][0].options.canUseTool;
    } finally {
      cap.restore();
    }

    const result = await canUseTool("AskUserQuestion", singleQuestion, FAKE_OPTIONS);
    expect(result.behavior).toBe("allow");
    expect(result.updatedInput.answers).toEqual({ "Which approach?": "Safe" });
  });

  it("returns behavior:deny when user picks Let's discuss", async () => {
    vi.mocked(pickQuestion).mockResolvedValueOnce({ type: "discuss" });
    mockQueryMessages([
      { type: "result", duration_ms: 100, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const cap = captureConsole();
    let canUseTool: Function;
    try {
      await runQuery("test", undefined);
      canUseTool = (query as any).mock.calls[0][0].options.canUseTool;
    } finally {
      cap.restore();
    }

    const result = await canUseTool("AskUserQuestion", singleQuestion, FAKE_OPTIONS);
    expect(result.behavior).toBe("deny");
  });

  it("uses free text as answer when user picks Other:", async () => {
    vi.mocked(pickQuestion).mockResolvedValueOnce({ type: "other", text: "Something custom" });
    mockQueryMessages([
      { type: "result", duration_ms: 100, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const cap = captureConsole();
    let canUseTool: Function;
    try {
      await runQuery("test", undefined);
      canUseTool = (query as any).mock.calls[0][0].options.canUseTool;
    } finally {
      cap.restore();
    }

    const result = await canUseTool("AskUserQuestion", singleQuestion, FAKE_OPTIONS);
    expect(result.behavior).toBe("allow");
    expect(result.updatedInput.answers).toEqual({ "Which approach?": "Something custom" });
  });

  it("handles multi-select: joins selected labels with comma", async () => {
    (pickMultiple as any).mockResolvedValue([0, 1]); // user picks both
    mockQueryMessages([
      { type: "result", duration_ms: 100, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const cap = captureConsole();
    let canUseTool: Function;
    try {
      await runQuery("test", undefined);
      canUseTool = (query as any).mock.calls[0][0].options.canUseTool;
    } finally {
      cap.restore();
    }

    const multiInput = {
      questions: [{
        question: "Which features?",
        header: "Features",
        options: [
          { label: "Auth", description: "Authentication" },
          { label: "Logs", description: "Logging" },
        ],
        multiSelect: true,
      }],
    };

    const result = await canUseTool("AskUserQuestion", multiInput, FAKE_OPTIONS);
    expect(result.behavior).toBe("allow");
    expect(result.updatedInput.answers).toEqual({ "Which features?": "Auth, Logs" });
  });

  it("preserves other input fields in updatedInput", async () => {
    vi.mocked(pickQuestion).mockResolvedValueOnce({ type: "answer", value: "Fast" });
    mockQueryMessages([
      { type: "result", duration_ms: 100, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const cap = captureConsole();
    let canUseTool: Function;
    try {
      await runQuery("test", undefined);
      canUseTool = (query as any).mock.calls[0][0].options.canUseTool;
    } finally {
      cap.restore();
    }

    const result = await canUseTool("AskUserQuestion", singleQuestion, FAKE_OPTIONS);
    expect(result.updatedInput.questions).toEqual(singleQuestion.questions);
  });
});

describe("runQuery - tool permission handling (non-bypass mode)", () => {
  // Non-bypass is the default in tests (BYPASS = process.argv.includes("--dangerously-skip-permissions"))
  const FAKE_OPTIONS = { signal: new AbortController().signal, toolUseID: "tu_2" };

  it("unknown tool: pick index 0 (Allow) → returns behavior:allow", async () => {
    (pick as any).mockResolvedValue(0); // Allow
    mockQueryMessages([
      { type: "result", duration_ms: 100, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const cap = captureConsole();
    let canUseTool: Function;
    try {
      await runQuery("test", undefined);
      canUseTool = (query as any).mock.calls[0][0].options.canUseTool;
    } finally {
      cap.restore();
    }

    const result = await canUseTool("Bash", { command: "rm -rf /" }, FAKE_OPTIONS);
    expect(result.behavior).toBe("allow");
  });

  it("unknown tool: pick index 1 (Deny) → returns behavior:deny with message", async () => {
    (pick as any).mockResolvedValue(1); // Deny
    mockQueryMessages([
      { type: "result", duration_ms: 100, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const cap = captureConsole();
    let canUseTool: Function;
    try {
      await runQuery("test", undefined);
      canUseTool = (query as any).mock.calls[0][0].options.canUseTool;
    } finally {
      cap.restore();
    }

    const result = await canUseTool("Bash", { command: "rm -rf /" }, FAKE_OPTIONS);
    expect(result.behavior).toBe("deny");
    expect(typeof (result as any).message).toBe("string");
  });
});

describe("runQuery - prompt redraw after query (worker mode integration)", () => {
  it("redraws input prompt on stdout after query completes, not during query output", async () => {
    // In worker mode: ask() is waiting for input while runQuery runs in the background.
    // The prompt should appear on stdout once initially (from ask()) and again after
    // the query completes (the fix for issue #108). It must NOT appear interleaved
    // with query output (which would cause double-spacing).
    (query as any).mockImplementation(async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: "assistant output" }] } };
      yield { type: "result", duration_ms: 100, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } };
    });

    const written: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: any) => written.push(String(s)));
    vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { written.push(String(s)); return true; });

    const origStdin = process.stdin;
    const fakeStdin = new PassThrough();
    fakeStdin.setEncoding("utf8");
    (fakeStdin as any).setRawMode = vi.fn();
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });

    try {
      // Start ask() — writes the prompt and registers drawFresh as the callback
      const askPromise = ask("[worker] > ", () => []);

      // Run the query to completion — drawFresh should be called once afterward
      await runQuery("test", undefined);

      const promptIdx = written.findIndex(s => s.includes("[worker] > "));
      const assistantIdx = written.findIndex(s => stripAnsi(s).includes("assistant output"));
      const lastPromptIdx = written.map((s, i) => s.includes("[worker] > ") ? i : -1).filter(i => i >= 0).at(-1)!;

      expect(promptIdx).toBeGreaterThan(-1);        // prompt drawn initially by ask()
      expect(assistantIdx).toBeGreaterThan(-1);     // query output appeared
      expect(lastPromptIdx).toBeGreaterThan(assistantIdx); // prompt redrawn AFTER query output

      fakeStdin.push("\r");
      await askPromise;
    } finally {
      Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
      vi.restoreAllMocks();
    }
  });
});
