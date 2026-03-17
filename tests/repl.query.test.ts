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

import { query } from "@anthropic-ai/claude-agent-sdk";
import { runQuery } from "../src/repl.js";
import { toolUseNames, stopStatus, setVerbose, setInputPrintCallback } from "../src/display.js";

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
    // Just verify no errors
    const cap = captureConsole();
    try {
      await runQuery("test", undefined);
    } finally {
      cap.restore();
    }
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

describe("runQuery - input print callback", () => {
  it("clears _inputPrintCallback before printing to prevent double-spacing", async () => {
    mockQueryMessages([
      { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
      { type: "result", duration_ms: 100, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } },
    ]);

    const mockCallback = vi.fn();
    setInputPrintCallback(mockCallback);

    const cap = captureConsole();
    try {
      await runQuery("test", undefined);
    } finally {
      cap.restore();
      setInputPrintCallback(null);
    }

    expect(mockCallback).not.toHaveBeenCalled();
  });

  it("does not call _inputPrintCallback re-registered during runQuery (worker race condition)", async () => {
    // In worker mode, ask() re-registers drawFresh after the WebSocket abort fires and
    // a new ask() starts — this happens concurrently with runQuery. The callback must
    // not fire for assistant/tool messages while _statusActive is true (i.e. while the
    // query is in progress), even if it was re-registered after setInputPrintCallback(null).
    // It IS allowed to fire for the result message (after stopStatus() clears _statusActive),
    // which is the correct behavior — it redraws the prompt after the query finishes.
    const mockCallback = vi.fn();
    let callsWhileQueryRunning = 0;

    (query as any).mockImplementation(async function* () {
      // Simulate ask() re-registering the callback mid-run (worker race condition).
      // At this point runQuery has already called startStatus(), so _statusActive=true.
      setInputPrintCallback(mockCallback);
      yield { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } };
      // Snapshot call count after the assistant message was processed — _statusActive is
      // still true here, so the callback must not have fired for that print.
      callsWhileQueryRunning = mockCallback.mock.calls.length;
      yield { type: "result", duration_ms: 100, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } };
    });

    const cap = captureConsole();
    try {
      await runQuery("test", undefined);
    } finally {
      cap.restore();
      setInputPrintCallback(null);
    }

    expect(callsWhileQueryRunning).toBe(0);
  });
});
