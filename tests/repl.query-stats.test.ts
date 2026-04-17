import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryStats } from "../src/agent/models/query-stats.js";
import * as queryStatsModule from "../src/agent/models/query-stats.js";
import { stripAnsi } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("QueryStats - initial state", () => {
  it("starts with zero turns", () => {
    const stats = new QueryStats();
    expect(stats.turns).toBe(0);
  });

  it("starts with zero inputTokens", () => {
    const stats = new QueryStats();
    expect(stats.inputTokens).toBe(0);
  });

  it("starts with zero outputTokens", () => {
    const stats = new QueryStats();
    expect(stats.outputTokens).toBe(0);
  });

  it("elapsedSecs is 0 at creation (using fixed startTime)", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const stats = new QueryStats(now);
    expect(stats.elapsedSecs).toBe(0);
  });
});

describe("QueryStats - message_start", () => {
  it("increments turns on message_start", () => {
    const stats = new QueryStats();
    stats.update({ type: "message_start", message: { usage: { input_tokens: 50 } } });
    expect(stats.turns).toBe(1);
  });

  it("accumulates inputTokens across multiple message_start events", () => {
    const stats = new QueryStats();
    stats.update({ type: "message_start", message: { usage: { input_tokens: 100 } } });
    stats.update({ type: "message_start", message: { usage: { input_tokens: 200 } } });
    expect(stats.inputTokens).toBe(300);
  });

  it("treats missing input_tokens as 0", () => {
    const stats = new QueryStats();
    stats.update({ type: "message_start" });
    expect(stats.inputTokens).toBe(0);
    expect(stats.turns).toBe(1);
  });

  it("emits change on message_start", () => {
    const stats = new QueryStats();
    const onChange = vi.fn();
    stats.on("change", onChange);
    stats.update({ type: "message_start", message: { usage: { input_tokens: 10 } } });
    expect(onChange).toHaveBeenCalledOnce();
  });
});

describe("QueryStats - message_delta", () => {
  it("tracks current output tokens on message_delta", () => {
    const stats = new QueryStats();
    stats.update({ type: "message_delta", usage: { output_tokens: 30 } });
    expect(stats.outputTokens).toBe(30);
  });

  it("replaces (not adds) current output tokens on successive deltas", () => {
    const stats = new QueryStats();
    stats.update({ type: "message_delta", usage: { output_tokens: 20 } });
    stats.update({ type: "message_delta", usage: { output_tokens: 45 } });
    expect(stats.outputTokens).toBe(45);
  });

  it("retains previous value when output_tokens is missing", () => {
    const stats = new QueryStats();
    stats.update({ type: "message_delta", usage: { output_tokens: 30 } });
    stats.update({ type: "message_delta" });
    expect(stats.outputTokens).toBe(30);
  });

  it("emits change on message_delta", () => {
    const stats = new QueryStats();
    const onChange = vi.fn();
    stats.on("change", onChange);
    stats.update({ type: "message_delta", usage: { output_tokens: 10 } });
    expect(onChange).toHaveBeenCalledOnce();
  });
});

describe("QueryStats - message_stop", () => {
  it("commits current output tokens to completed on message_stop", () => {
    const stats = new QueryStats();
    stats.update({ type: "message_delta", usage: { output_tokens: 50 } });
    stats.update({ type: "message_stop" });
    expect(stats.outputTokens).toBe(50);
  });

  it("resets current output tokens to 0 after message_stop", () => {
    const stats = new QueryStats();
    stats.update({ type: "message_delta", usage: { output_tokens: 50 } });
    stats.update({ type: "message_stop" });
    // Start a new delta — it should add on top of committed 50
    stats.update({ type: "message_delta", usage: { output_tokens: 20 } });
    expect(stats.outputTokens).toBe(70);
  });

  it("accumulates completed output tokens across multiple messages", () => {
    const stats = new QueryStats();
    // First message
    stats.update({ type: "message_delta", usage: { output_tokens: 50 } });
    stats.update({ type: "message_stop" });
    // Second message
    stats.update({ type: "message_delta", usage: { output_tokens: 30 } });
    stats.update({ type: "message_stop" });
    expect(stats.outputTokens).toBe(80);
  });

  it("emits change on message_stop", () => {
    const stats = new QueryStats();
    const onChange = vi.fn();
    stats.on("change", onChange);
    stats.update({ type: "message_stop" });
    expect(onChange).toHaveBeenCalledOnce();
  });
});

describe("QueryStats - unrecognized events", () => {
  it("does not emit change for unknown event types", () => {
    const stats = new QueryStats();
    const onChange = vi.fn();
    stats.on("change", onChange);
    stats.update({ type: "content_block_delta" });
    stats.update({ type: "content_block_start" });
    stats.update({ type: "ping" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not change any stats for unknown event types", () => {
    const stats = new QueryStats();
    stats.update({ type: "unknown_event" });
    expect(stats.turns).toBe(0);
    expect(stats.inputTokens).toBe(0);
    expect(stats.outputTokens).toBe(0);
  });
});

describe("QueryStats - multi-turn accumulation", () => {
  it("correctly accumulates stats across two full message cycles", () => {
    const stats = new QueryStats();
    // Turn 1
    stats.update({ type: "message_start", message: { usage: { input_tokens: 100 } } });
    stats.update({ type: "message_delta", usage: { output_tokens: 50 } });
    stats.update({ type: "message_stop" });
    // Turn 2
    stats.update({ type: "message_start", message: { usage: { input_tokens: 200 } } });
    stats.update({ type: "message_delta", usage: { output_tokens: 30 } });
    stats.update({ type: "message_stop" });

    expect(stats.turns).toBe(2);
    expect(stats.inputTokens).toBe(300);
    expect(stats.outputTokens).toBe(80);
  });
});

describe("QueryStats - elapsedSecs", () => {
  it("reports elapsed seconds relative to startTime", () => {
    vi.useFakeTimers();
    const start = Date.now();
    const stats = new QueryStats(start);
    vi.advanceTimersByTime(3000);
    expect(stats.elapsedSecs).toBe(3);
  });

  it("floors elapsed time (does not round up)", () => {
    vi.useFakeTimers();
    const start = Date.now();
    const stats = new QueryStats(start);
    vi.advanceTimersByTime(2900);
    expect(stats.elapsedSecs).toBe(2);
  });
});

describe("QueryStats - getStatusText", () => {
  it("uses a verb from pickWorkingVerb", () => {
    const verb = "Welding";
    const stats = new QueryStats(undefined, () => verb);
    expect(stripAnsi(stats.getStatusText())).toContain(verb);
  });

  it("includes elapsed time", () => {
    vi.useFakeTimers();
    const start = Date.now();
    const stats = new QueryStats(start);
    vi.advanceTimersByTime(5000);
    expect(stripAnsi(stats.getStatusText())).toContain("5s");
  });

  it("includes turn count after message_start", () => {
    const stats = new QueryStats();
    stats.update({ type: "message_start", message: { usage: { input_tokens: 10 } } });
    expect(stripAnsi(stats.getStatusText())).toContain("1 turn");
  });

  it("includes output token count after message_delta", () => {
    const stats = new QueryStats();
    stats.update({ type: "message_delta", usage: { output_tokens: 500 } });
    expect(stripAnsi(stats.getStatusText())).toContain("500");
  });

  it("omits turn count before first message_start (turns=0)", () => {
    const stats = new QueryStats();
    expect(stripAnsi(stats.getStatusText())).not.toContain("turn");
  });
});
