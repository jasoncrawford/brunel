import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { WorkerSession, classifyEvent, debounceMs } from "../src/agent/worker.js";
import type { ForemanMessage, GitHubEvent, TaskIssue } from "../src/types.js";
import { stripAnsi } from "./helpers.js";
import * as displayModule from "../src/agent/display.js";

// ── Fake WebSocket ─────────────────────────────────────────────────────────────

class FakeWs extends EventEmitter {
  readyState = 1; // OPEN
  send = vi.fn();
  ping = vi.fn();
  terminate = vi.fn().mockImplementation(() => {
    this.readyState = 3; // CLOSED
    this.emit("close", 1006, Buffer.from(""));
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const WORKER_ID = "test-worker-id";

function makeIssue(n = 1): TaskIssue {
  return { number: n, title: `Issue ${n}`, body: `Body ${n}`, labels: [], repoUrl: "https://github.com/owner/repo" };
}

function makeEvent(name = "push"): GitHubEvent {
  return { id: "evt-1", name, payload: {} };
}

function sendMsg(ws: FakeWs, msg: ForemanMessage) {
  ws.emit("message", Buffer.from(JSON.stringify(msg)));
}

// ── Test harness ──────────────────────────────────────────────────────────────

let fakeWs: FakeWs;
let wsFactory: ReturnType<typeof vi.fn>;
let display: {
  print: ReturnType<typeof vi.fn>;
  printForemanMessage: ReturnType<typeof vi.fn>;
  startPersistentStatus: ReturnType<typeof vi.fn>;
  stopPersistentStatus: ReturnType<typeof vi.fn>;
  updatePersistentStatus: ReturnType<typeof vi.fn>;
  setOnToolResultCallback: ReturnType<typeof vi.fn>;
};
let session: WorkerSession;

beforeEach(() => {
  fakeWs = new FakeWs();
  wsFactory = vi.fn().mockReturnValue(fakeWs);
  display = {
    print: vi.fn(),
    printForemanMessage: vi.fn(),
    startPersistentStatus: vi.fn(),
    stopPersistentStatus: vi.fn(),
    updatePersistentStatus: vi.fn(),
    setOnToolResultCallback: vi.fn(),
  };
  session = new WorkerSession(WORKER_ID, wsFactory, display);
  session.start();
});

// Always restore real timers after each test so fake-timer leaks don't cascade.
afterEach(() => { vi.useRealTimers(); });

// ── Idle → task assignment ────────────────────────────────────────────────────

describe("task_assigned", () => {
  it("enqueues a fresh prompt with the initial task description when task_assigned is received", () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    expect(session.hasPendingPrompts()).toBe(true);
    const item = session.takeNextPrompt()!;
    expect(item.prompt).toContain(issue.title);
    expect(item.fresh).toBe(true);
  });

  it("updates currentTaskId and currentIssue when task_assigned is received", async () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    session.takeNextPrompt(); // consume prompt

    // State is observable via completeCurrentTask: if task is set, task_complete is sent
    await session.completeCurrentTask();
    const sent = JSON.parse(fakeWs.send.mock.calls[0][0]);
    expect(sent.taskId).toBe("42");
  });

  it("calls display.printForemanMessage for task_assigned", () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    expect(display.printForemanMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "task_assigned" })
    );
  });

  it("prints the initial prompt when task_assigned is received", () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    const printCalls = display.print.mock.calls.map(args => stripAnsi(String(args[0])));
    expect(printCalls.some(s => s.includes(issue.title))).toBe(true);
  });
});

// ── Event handling during a running query ─────────────────────────────────────

describe("event_notification", () => {
  it("resolves WS input promise when actionable event_notification fires after debounce", async () => {
    vi.useFakeTimers();
    // Must assign a task first so the debounce fires (requires currentTaskId to be set).
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt(); // consume initial prompt

    const promise = session.createWsInputPromise();
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBeTruthy();
  });

  it("queues event when event_notification arrives during a running query; drains after query ends", () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    session.takeNextPrompt(); // consume initial

    const ac = new AbortController();
    session.notifyQueryStart(ac);

    // Event arrives while query is running → goes to pendingEvents, not prompts
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });
    expect(session.hasPendingPrompts()).toBe(false);

    // Query ends → event drained into prompt queue
    session.notifyQueryEnd(false);
    expect(session.hasPendingPrompts()).toBe(true);
    const item = session.takeNextPrompt()!;
    expect(item.prompt).toContain("A comment was added");
    expect(item.fresh).toBe(false);
  });

  it("prints event prompt when event is drained (no 'Building prompt' diagnostic)", () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    session.takeNextPrompt();

    const ac = new AbortController();
    session.notifyQueryStart(ac);
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });

    display.print.mockClear();
    session.notifyQueryEnd(false);

    const printCalls = display.print.mock.calls.map(args => stripAnsi(String(args[0])));
    expect(printCalls.some(s => s.startsWith("Building prompt from events:"))).toBe(false);
    expect(printCalls.some(s => s.includes("A comment was added"))).toBe(true);
  });

  it("ignores event_notification for a task other than the current task", async () => {
    vi.useFakeTimers();
    try {
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue(1) });
      session.takeNextPrompt(); // consume initial prompt

      // Stale event for a different task (e.g. old completed task)
      sendMsg(fakeWs, { type: "event_notification", taskId: "99", event: makeEvent("issue_comment") });
      await vi.runAllTimersAsync();

      // No prompt should have been queued
      expect(session.hasPendingPrompts()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prints a warning when ignoring an event_notification for a different task", () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue(1) });
    session.takeNextPrompt(); // consume initial prompt

    display.print.mockClear();
    sendMsg(fakeWs, { type: "event_notification", taskId: "99", event: makeEvent("issue_comment") });

    const printCalls = display.print.mock.calls.map(args => stripAnsi(String(args[0])));
    expect(printCalls.some(s => s.includes("ignoring"))).toBe(true);
  });

  it("batches multiple pending events into a single prompt when query ends", () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    session.takeNextPrompt();

    const ac = new AbortController();
    session.notifyQueryStart(ac);

    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("pull_request_review") });

    session.notifyQueryEnd(false);
    expect(session.hasPendingPrompts()).toBe(true);
    expect(session.pendingPrompts.length ?? session.hasPendingPrompts()).toBeTruthy();
    const item = session.takeNextPrompt()!;
    expect(item.prompt).toContain("Multiple events");
    // Only one batched prompt
    expect(session.hasPendingPrompts()).toBe(false);
  });
});

// ── completeCurrentTask ───────────────────────────────────────────────────────

describe("completeCurrentTask", () => {
  it("sends task_complete to WS and clears task state", async () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    session.takeNextPrompt();

    await session.completeCurrentTask();

    const sent = JSON.parse(fakeWs.send.mock.calls[0][0]);
    expect(sent).toEqual({ type: "task_complete", workerId: WORKER_ID, taskId: "42" });
  });

  it("returns 'task-complete' so the main loop can hide the prompt", async () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    session.takeNextPrompt();

    const result = await session.completeCurrentTask();
    expect(result).toBe("task-complete");
  });

  it("with no active task returns undefined (no prompt change needed)", async () => {
    const result = await session.completeCurrentTask();
    expect(result).toBeUndefined();
  });

  it("with no active task does not send to WS", async () => {
    await session.completeCurrentTask();
    expect(fakeWs.send).not.toHaveBeenCalled();
  });
});

// ── State isolation ───────────────────────────────────────────────────────────

describe("state after task_complete", () => {
  it("task state is cleared after completeCurrentTask()", async () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    session.takeNextPrompt();

    await session.completeCurrentTask();

    // State should be cleared — another completeCurrentTask sends nothing
    fakeWs.send.mockClear();
    await session.completeCurrentTask();
    expect(fakeWs.send).not.toHaveBeenCalled();
  });
});

// ── Prompt queuing API ────────────────────────────────────────────────────────

describe("hasPendingPrompts / takeNextPrompt / createWsInputPromise", () => {
  it("hasPendingPrompts is false initially", () => {
    expect(session.hasPendingPrompts()).toBe(false);
  });

  it("takeNextPrompt returns undefined when no prompts queued", () => {
    expect(session.takeNextPrompt()).toBeUndefined();
  });

  it("createWsInputPromise resolves immediately if prompts already queued", async () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "1", issue: makeIssue() });
    // Prompt is now queued; new promise should resolve immediately
    const p = session.createWsInputPromise();
    const result = await Promise.race([p, new Promise<"pending">((r) => setTimeout(() => r("pending"), 10))]);
    expect(result).not.toBe("pending");
  });

  it("createWsInputPromise resolves when task_assigned arrives", async () => {
    const promise = session.createWsInputPromise();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "1", issue: makeIssue() });
    expect(await promise).toBeTruthy();
  });

  it("each new createWsInputPromise abandons the previous one", async () => {
    const first = session.createWsInputPromise();
    const second = session.createWsInputPromise();

    sendMsg(fakeWs, { type: "task_assigned", taskId: "1", issue: makeIssue() });

    // second gets resolved
    expect(await second).toBeTruthy();
    // first was abandoned and never resolves
    const firstResult = await Promise.race([first, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 20))]);
    expect(firstResult).toBe("timeout");
  });

  it("task_assigned prompt has fresh=true (signals main() to reset sessionId)", () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "1", issue: makeIssue() });
    const item = session.takeNextPrompt()!;
    expect(item.fresh).toBe(true);
  });

  it("event prompt has fresh=false (continues same conversation)", async () => {
    vi.useFakeTimers();
    try {
      sendMsg(fakeWs, { type: "task_assigned", taskId: "1", issue: makeIssue() });
      session.takeNextPrompt();

      sendMsg(fakeWs, { type: "event_notification", taskId: "1", event: makeEvent("issue_comment") });
      await vi.runAllTimersAsync();

      const item = session.takeNextPrompt()!;
      expect(item.fresh).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Reconnect ─────────────────────────────────────────────────────────────────

describe("reconnect", () => {
  it("calls wsFactory again when ws emits close", async () => {
    vi.useFakeTimers();
    expect(wsFactory).toHaveBeenCalledOnce();

    fakeWs.emit("close");
    vi.advanceTimersByTime(5001);

    expect(wsFactory).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("passes workerId and currentTaskId to wsFactory on reconnect", async () => {
    vi.useFakeTimers();

    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    await Promise.resolve();

    fakeWs.emit("close");

    vi.advanceTimersByTime(5001);

    const secondCall = wsFactory.mock.calls[1];
    expect(secondCall[0]).toBe(WORKER_ID);
    expect(secondCall[1]).toBe("42");
    vi.useRealTimers();
  });

  it("reconnect delay is at least 2 seconds (jitter lower bound)", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);

    fakeWs.emit("close");
    vi.advanceTimersByTime(1999);
    expect(wsFactory).toHaveBeenCalledTimes(1); // not reconnected yet

    vi.advanceTimersByTime(2);
    expect(wsFactory).toHaveBeenCalledTimes(2); // reconnected at ~2000ms

    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reconnect delay is at most 5 seconds (jitter upper bound)", async () => {
    vi.useFakeTimers();

    fakeWs.emit("close");
    // Even with maximum jitter (random approaching 1.0), delay is always < 5000ms
    vi.advanceTimersByTime(5000);
    expect(wsFactory).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});

// ── Stale WebSocket handlers ──────────────────────────────────────────────────

describe("stale WebSocket handlers", () => {
  it("ignores close event from the old WebSocket after reconnect", () => {
    vi.useFakeTimers();

    const oldWs = fakeWs;
    // Trigger reconnect — new WS is returned by wsFactory on second call
    const newWs = new FakeWs();
    wsFactory.mockReturnValueOnce(newWs);
    oldWs.emit("close", 1001, Buffer.from(""));
    vi.advanceTimersByTime(5001);

    // wsFactory called a second time (reconnect happened)
    expect(wsFactory).toHaveBeenCalledTimes(2);
    display.print.mockClear();

    // Now the old WS fires close again (delayed TCP teardown)
    oldWs.emit("close", 1006, Buffer.from(""));

    // Should be silently ignored — no state change, no third connection
    expect(wsFactory).toHaveBeenCalledTimes(2); // no third connection

    vi.useRealTimers();
  });

  it("ignores error event from the old WebSocket after reconnect", () => {
    vi.useFakeTimers();

    const oldWs = fakeWs;
    const newWs = new FakeWs();
    wsFactory.mockReturnValueOnce(newWs);
    oldWs.emit("close", 1001, Buffer.from(""));
    vi.advanceTimersByTime(5001);

    display.print.mockClear();

    // Old WS fires error after new connection is established
    oldWs.emit("error", new Error("stale error"));

    // Should be silently ignored
    const calls = display.print.mock.calls.map(a => stripAnsi(String(a[0])));
    expect(calls.some(s => s.includes("stale error"))).toBe(false);

    vi.useRealTimers();
  });
});

// ── Connection status in status bar ───────────────────────────────────────────

describe("connection status bar", () => {
  it("shows Disconnected in status text after close", () => {
    vi.useFakeTimers();
    fakeWs.emit("open");
    fakeWs.emit("close", 1006, Buffer.from(""));
    expect(stripAnsi(session.getStatusText())).toContain("Disconnected");
    vi.useRealTimers();
  });

  it("shows Handshaking... in status text after open (pre-hello_ack)", () => {
    fakeWs.emit("open");
    expect(stripAnsi(session.getStatusText())).toContain("Handshaking...");
  });

  it("shows Connected in status text after hello_ack", () => {
    fakeWs.emit("open");
    sendMsg(fakeWs, { type: "hello_ack", status: "idle" });
    expect(stripAnsi(session.getStatusText())).toContain("Connected");
  });

  it("shows Reconnecting in status text on initial connect", () => {
    expect(stripAnsi(session.getStatusText())).toContain("Reconnecting");
  });

  it("calls startPersistentStatus on start()", () => {
    expect(display.startPersistentStatus).toHaveBeenCalledOnce();
  });

  it("registers a tool result callback on start()", () => {
    expect(display.setOnToolResultCallback).toHaveBeenCalledOnce();
    expect(typeof display.setOnToolResultCallback.mock.calls[0][0]).toBe("function");
  });

  it("tool result callback refreshes status on Bash tool", async () => {
    const cb = display.setOnToolResultCallback.mock.calls[0][0] as (toolName: string) => void;
    display.updatePersistentStatus.mockClear();
    cb("Bash");
    await vi.waitFor(() => expect(display.updatePersistentStatus).toHaveBeenCalled());
  });

  it("tool result callback does not refresh status for non-Bash tools", async () => {
    const cb = display.setOnToolResultCallback.mock.calls[0][0] as (toolName: string) => void;
    // Drain startup calls: connect()'s synchronous refreshStatus() + refreshBranch()'s async one
    await vi.waitFor(() => expect(display.updatePersistentStatus).toHaveBeenCalledTimes(2));
    display.updatePersistentStatus.mockClear();
    cb("Read");
    // Give a tick for any potential async work
    await new Promise((r) => setTimeout(r, 10));
    expect(display.updatePersistentStatus).not.toHaveBeenCalled();
  });

  it("calls updatePersistentStatus after open", () => {
    display.updatePersistentStatus.mockClear();
    fakeWs.emit("open");
    expect(display.updatePersistentStatus).toHaveBeenCalled();
  });

  it("shows Reconnecting in status text when connect() is called after disconnect", () => {
    vi.useFakeTimers();
    fakeWs.emit("open");
    fakeWs.emit("close", 1006, Buffer.from(""));
    // After close we are Disconnected; the timer hasn't fired yet.
    expect(stripAnsi(session.getStatusText())).toContain("Disconnected");
    // Advance time past the reconnect delay to trigger connect().
    vi.advanceTimersByTime(6000);
    // connect() should have been called (wsFactory called a second time) and
    // the status should now show Reconnecting before the new socket opens.
    expect(wsFactory).toHaveBeenCalledTimes(2);
    expect(stripAnsi(session.getStatusText())).toContain("Reconnecting");
    vi.useRealTimers();
  });

  it("disconnect code is stored on close and shown in Reconnecting... state (verbose)", () => {
    vi.useFakeTimers();
    fakeWs.emit("open");
    fakeWs.emit("close", 1006, Buffer.from(""));
    // After close we are Disconnected; the timer hasn't fired yet.
    expect(stripAnsi(session.getStatusText())).toContain("Disconnected");
    vi.useRealTimers();
  });

  it("logs error message on ws error event", () => {
    fakeWs.emit("error", new Error("connection reset"));
    const calls = display.print.mock.calls.map(a => stripAnsi(String(a[0])));
    expect(calls.some(s => s.includes("connection reset"))).toBe(true);
  });
});

// ── Status bar content ────────────────────────────────────────────────────────

describe("status bar content", () => {
  it("shows worker ID prefix in status text", () => {
    const text = stripAnsi(session.getStatusText());
    expect(text).toContain(`worker ${WORKER_ID.slice(0, 8)}`);
  });

  it("shows no current task when no task assigned", () => {
    const text = stripAnsi(session.getStatusText());
    expect(text).toContain("no current task");
  });

  it("shows task number after task_assigned", () => {
    const issue = makeIssue(42);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t42", issue });
    const text = stripAnsi(session.getStatusText());
    expect(text).toContain("task #42");
  });

  it("shows PR number after pull_request event", () => {
    const issue = makeIssue(1);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });

    const prEvent: GitHubEvent = {
      id: "pr-evt",
      name: "pull_request",
      payload: { action: "opened", pull_request: { number: 99, title: "My PR" } },
    };
    sendMsg(fakeWs, { type: "event_notification", taskId: "t1", event: prEvent });
    const text = stripAnsi(session.getStatusText());
    expect(text).toContain("PR #99");
  });

  it("resets PR number when new task is assigned", async () => {
    const issue1 = makeIssue(1);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue: issue1 });

    // Set PR number
    const prEvent: GitHubEvent = {
      id: "pr-evt",
      name: "pull_request",
      payload: { action: "opened", pull_request: { number: 55, title: "PR" } },
    };
    sendMsg(fakeWs, { type: "event_notification", taskId: "t1", event: prEvent });
    expect(stripAnsi(session.getStatusText())).toContain("PR #55");

    // Complete task and assign new task
    session.takeNextPrompt();
    await session.completeCurrentTask();
    const issue2 = makeIssue(2);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t2", issue: issue2 });

    expect(stripAnsi(session.getStatusText())).not.toContain("PR #");
  });

  it("clears PR number from status bar when pull_request/closed without merging is received", () => {
    const issue = makeIssue(1);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });

    // First set the PR number via opened event
    const prOpenedEvent: GitHubEvent = {
      id: "pr-opened",
      name: "pull_request",
      payload: { action: "opened", pull_request: { number: 77, merged: false } },
    };
    sendMsg(fakeWs, { type: "event_notification", taskId: "t1", event: prOpenedEvent });
    expect(stripAnsi(session.getStatusText())).toContain("PR #77");

    // Now close the PR without merging
    const prClosedEvent: GitHubEvent = {
      id: "pr-closed",
      name: "pull_request",
      payload: { action: "closed", pull_request: { number: 77, merged: false } },
    };
    sendMsg(fakeWs, { type: "event_notification", taskId: "t1", event: prClosedEvent });
    expect(stripAnsi(session.getStatusText())).not.toContain("PR #");
  });

  it("keeps PR number in status bar when pull_request/closed with merge is received", () => {
    const issue = makeIssue(1);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });

    const prOpenedEvent: GitHubEvent = {
      id: "pr-opened",
      name: "pull_request",
      payload: { action: "opened", pull_request: { number: 88, merged: false } },
    };
    sendMsg(fakeWs, { type: "event_notification", taskId: "t1", event: prOpenedEvent });
    expect(stripAnsi(session.getStatusText())).toContain("PR #88");

    // Close via merge — PR should stay shown until task completes
    const prMergedEvent: GitHubEvent = {
      id: "pr-merged",
      name: "pull_request",
      payload: { action: "closed", pull_request: { number: 88, merged: true } },
    };
    sendMsg(fakeWs, { type: "event_notification", taskId: "t1", event: prMergedEvent });
    expect(stripAnsi(session.getStatusText())).toContain("PR #88");
  });
});

// ── hello_ack handshake — buffering ──────────────────────────────────────────

describe("hello_ack handshake — buffering", () => {
  function reconnectWithNewWs(): FakeWs {
    vi.spyOn(Math, "random").mockReturnValue(0); // deterministic 2000ms delay
    const newWs = new FakeWs();
    wsFactory.mockReturnValueOnce(newWs);
    fakeWs.emit("close", 1006, Buffer.from(""));
    vi.advanceTimersByTime(2001);
    return newWs;
  }

  it("buffers task_complete in hello_sent state (before hello_ack) and flushes on ack", async () => {
    vi.useFakeTimers();
    try {
      // Assign a task so the worker has something to complete
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      session.takeNextPrompt();

      // Reconnect: new WS is created
      const newWs = reconnectWithNewWs();

      // Open event → hello_sent state
      newWs.emit("open");

      // Try to send task_complete — should be buffered (hello_ack not yet received)
      await session.completeCurrentTask();
      expect(newWs.send).not.toHaveBeenCalled();

      // Send hello_ack → buffer should be flushed
      sendMsg(newWs, { type: "hello_ack", workerId: WORKER_ID, status: "busy" });
      expect(newWs.send).toHaveBeenCalledOnce();
      const sent = JSON.parse(newWs.send.mock.calls[0][0]);
      expect(sent).toEqual({ type: "task_complete", workerId: WORKER_ID, taskId: "42" });
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("discards buffered messages and clears task state on hello_ack cancelled", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      session.takeNextPrompt();

      const newWs = reconnectWithNewWs();
      newWs.emit("open");

      // Buffer a task_complete
      await session.completeCurrentTask();
      expect(newWs.send).not.toHaveBeenCalled();

      // Send hello_ack cancelled → buffer discarded, task state cleared
      sendMsg(newWs, { type: "hello_ack", workerId: WORKER_ID, status: "cancelled" });
      expect(newWs.send).not.toHaveBeenCalled();

      // Verify task state cleared: subsequent completeCurrentTask sends nothing
      await session.completeCurrentTask();
      expect(newWs.send).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("prints cancellation message on hello_ack cancelled", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      session.takeNextPrompt();

      const newWs = reconnectWithNewWs();
      newWs.emit("open");

      display.print.mockClear();
      sendMsg(newWs, { type: "hello_ack", workerId: WORKER_ID, status: "cancelled" });

      const printed = display.print.mock.calls.map(args => stripAnsi(String(args[0]))).join("\n");
      expect(printed).toContain("cancelled");
      expect(printed).not.toContain("Workspace reset");
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("calls workspace.reset() on hello_ack cancelled when workspaceCtx is set", async () => {
    vi.useFakeTimers();
    try {
      const workspace = {
        dir: "/tmp/test-workspace",
        reset: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn().mockResolvedValue(undefined),
        checkSafety: vi.fn().mockResolvedValue({ uncommittedFiles: [], unpushedCommits: [], noUpstream: false }),
      } as unknown as import("../src/agent/workspace.js").Workspace;

      const wsA = new FakeWs();
      const wsB = new FakeWs();
      let callCount = 0;
      const wsFactoryWs = vi.fn().mockImplementation(() => callCount++ === 0 ? wsA : wsB);

      const sessionWithWs = new WorkerSession(WORKER_ID, wsFactoryWs, display, {
        workspaceCtx: { workspace, originalCwd: "/original", workspaceDir: "/tmp/workers", repoUrl: "https://github.com/owner/repo", confirm: vi.fn() },
      });
      sessionWithWs.start(); // uses wsA

      const issue = makeIssue();
      sendMsg(wsA, { type: "task_assigned", taskId: "42", issue });
      sessionWithWs.takeNextPrompt();

      // Simulate reconnect: wsA closes, wsB is created
      vi.spyOn(Math, "random").mockReturnValue(0);
      wsA.emit("close", 1006, Buffer.from(""));
      vi.advanceTimersByTime(2001);
      // wsB is now the active connection
      wsB.emit("open");

      sendMsg(wsB, { type: "hello_ack", workerId: WORKER_ID, status: "cancelled" });

      await vi.waitFor(() => expect(workspace.reset).toHaveBeenCalledOnce());
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("aborts running query when hello_ack cancelled is received", () => {
    vi.useFakeTimers();
    try {
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
      session.takeNextPrompt();

      const ac = new AbortController();
      session.notifyQueryStart(ac);

      // Simulate reconnect and receive cancelled ack while query is still running
      const newWs = reconnectWithNewWs();
      newWs.emit("open");
      sendMsg(newWs, { type: "hello_ack", workerId: WORKER_ID, status: "cancelled" });

      // The running query's AbortController must be aborted
      expect(ac.signal.aborted).toBe(true);

      // Clean up
      session.notifyQueryEnd(true);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("flushes buffered task_complete on hello_ack idle (worker had stale task before reconnect)", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      session.takeNextPrompt();

      const newWs = reconnectWithNewWs();
      newWs.emit("open");

      await session.completeCurrentTask();
      expect(newWs.send).not.toHaveBeenCalled();

      // hello_ack idle — task was reverted on foreman side; but worker flushes anyway
      sendMsg(newWs, { type: "hello_ack", workerId: WORKER_ID, status: "idle" });
      expect(newWs.send).toHaveBeenCalledOnce();
      const sent = JSON.parse(newWs.send.mock.calls[0][0]);
      expect(sent.type).toBe("task_complete");
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("hello_ack is passed to display.printForemanMessage", () => {
    sendMsg(fakeWs, { type: "hello_ack", workerId: WORKER_ID, status: "idle" });
    expect(display.printForemanMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "hello_ack", workerId: WORKER_ID, status: "idle" })
    );
  });
});

// ── classifyEvent ─────────────────────────────────────────────────────────────

describe("classifyEvent", () => {
  function evt(name: string, action?: string, extra?: Record<string, unknown>): GitHubEvent {
    return { id: "e1", name, payload: { ...(action ? { action } : {}), ...extra } };
  }

  describe("log_only events", () => {
    it("check_run/created is log_only", () => {
      expect(classifyEvent(evt("check_run", "created"))).toBe("log_only");
    });
    it("check_run/completed is log_only", () => {
      expect(classifyEvent(evt("check_run", "completed"))).toBe("log_only");
    });
    it("check_suite/requested is log_only", () => {
      expect(classifyEvent(evt("check_suite", "requested"))).toBe("log_only");
    });
    it("check_suite/in_progress is log_only", () => {
      expect(classifyEvent(evt("check_suite", "in_progress"))).toBe("log_only");
    });
    it("check_suite/rerequested is log_only", () => {
      expect(classifyEvent(evt("check_suite", "rerequested"))).toBe("log_only");
    });
    it("check_suite/completed with conclusion skipped is log_only", () => {
      expect(classifyEvent(evt("check_suite", "completed", { check_suite: { conclusion: "skipped" } }))).toBe("log_only");
    });
    it("pull_request/labeled is log_only", () => {
      expect(classifyEvent(evt("pull_request", "labeled"))).toBe("log_only");
    });
    it("pull_request/synchronize is log_only", () => {
      expect(classifyEvent(evt("pull_request", "synchronize"))).toBe("log_only");
    });
    it("pull_request/reopened is log_only", () => {
      expect(classifyEvent(evt("pull_request", "reopened"))).toBe("log_only");
    });
    it("unrecognised event is log_only", () => {
      expect(classifyEvent(evt("deployment", "created"))).toBe("log_only");
    });
    it("unrecognised event with no action is log_only", () => {
      expect(classifyEvent(evt("push"))).toBe("log_only");
    });
    it("issue_comment starting with <!-- railway-bot-comment is log_only", () => {
      const body = "<!-- railway-bot-comment-version=2 -->\n\n<!-- railway-project-id=\"abc\" -->\n🚅 Deployed";
      const event = { id: "e1", name: "issue_comment", payload: { action: "created", comment: { body } } };
      expect(classifyEvent(event)).toBe("log_only");
    });
    it("issue_comment edited starting with <!-- railway-bot-comment is log_only", () => {
      const body = "<!-- railway-bot-comment-version=2 -->\nsome content";
      const event = { id: "e1", name: "issue_comment", payload: { action: "edited", comment: { body } } };
      expect(classifyEvent(event)).toBe("log_only");
    });
  });

  describe("actionable events", () => {
    it("check_suite/completed is actionable", () => {
      expect(classifyEvent(evt("check_suite", "completed"))).toBe("actionable");
    });
    it("pull_request_review/submitted is actionable", () => {
      expect(classifyEvent(evt("pull_request_review", "submitted"))).toBe("actionable");
    });
    it("pull_request_review_comment/created is actionable", () => {
      expect(classifyEvent(evt("pull_request_review_comment", "created"))).toBe("actionable");
    });
    it("issue_comment/created is actionable", () => {
      expect(classifyEvent(evt("issue_comment", "created"))).toBe("actionable");
    });
    it("issue_comment/edited is actionable", () => {
      expect(classifyEvent(evt("issue_comment", "edited"))).toBe("actionable");
    });
    it("issue_comment with railway-bot-comment body is actionable when no railway prefix", () => {
      const event = { id: "e1", name: "issue_comment", payload: { action: "created", comment: { body: "Normal comment" } } };
      expect(classifyEvent(event)).toBe("actionable");
    });
    it("pull_request/closed is actionable", () => {
      expect(classifyEvent(evt("pull_request", "closed"))).toBe("actionable");
    });
    it("pull_request/auto_merge_enabled is actionable", () => {
      expect(classifyEvent(evt("pull_request", "auto_merge_enabled"))).toBe("actionable");
    });
  });
});

// ── log_only filtering ────────────────────────────────────────────────────────

describe("log_only event filtering", () => {
  it("log_only event is not pushed to pendingEvents and does not trigger a prompt", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      session.takeNextPrompt();

      // check_run is log_only
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: { id: "e1", name: "check_run", payload: { action: "completed" } } });
      await vi.runAllTimersAsync();

      expect(session.hasPendingPrompts()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("log_only event does not resolve WS input promise", async () => {
    const promise = session.createWsInputPromise();
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: { id: "e1", name: "check_run", payload: { action: "completed" } } });
    const result = await Promise.race([
      promise,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 30)),
    ]);
    expect(result).toBe("timeout");
  });
});

// ── debounce ──────────────────────────────────────────────────────────────────

describe("debounce", () => {
  it("actionable event when no query running sets debounce timer (no immediate dispatch)", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      session.takeNextPrompt();

      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });

      // No prompt yet (debounce timer pending)
      expect(session.hasPendingPrompts()).toBe(false);

      // Advance past the debounce delay
      await vi.runAllTimersAsync();

      expect(session.hasPendingPrompts()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("multiple actionable events arriving within debounce window are batched into one prompt", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      session.takeNextPrompt();

      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("pull_request_review") });

      await vi.runAllTimersAsync();

      expect(session.hasPendingPrompts()).toBe(true);
      const item = session.takeNextPrompt()!;
      expect(item.prompt).toContain("Multiple events");
      expect(session.hasPendingPrompts()).toBe(false); // only one batched prompt
    } finally {
      vi.useRealTimers();
    }
  });

  it("notifyQueryStart cancels the debounce; events drain into prompts via notifyQueryEnd", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      session.takeNextPrompt();

      // Actionable event sets the debounce timer
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });
      expect(session.hasPendingPrompts()).toBe(false);

      // Query starts → cancels debounce
      const ac = new AbortController();
      session.notifyQueryStart(ac);

      // Advance past the original debounce delay — timer was cancelled
      await vi.advanceTimersByTimeAsync(4000);
      expect(session.hasPendingPrompts()).toBe(false);

      // Query ends → events drain
      session.notifyQueryEnd(false);
      expect(session.hasPendingPrompts()).toBe(true);
      const item = session.takeNextPrompt()!;
      expect(item.prompt).toContain("A comment was added");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── notifyQueryStart / notifyQueryEnd ─────────────────────────────────────────

describe("notifyQueryStart / notifyQueryEnd", () => {
  it("notifyQueryStart stores the AbortController for interrupt()", () => {
    const ac = new AbortController();
    session.notifyQueryStart(ac);
    expect(session.interrupt()).toBe(true);
    expect(ac.signal.aborted).toBe(true);
    session.notifyQueryEnd(true);
  });

  it("notifyQueryEnd with aborted=true does not drain pending events into prompts", () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt();

    const ac = new AbortController();
    session.notifyQueryStart(ac);
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });

    session.notifyQueryEnd(true); // aborted
    expect(session.hasPendingPrompts()).toBe(false);
  });

  it("notifyQueryEnd with aborted=false drains pending events into prompts", () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt();

    const ac = new AbortController();
    session.notifyQueryStart(ac);
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });

    session.notifyQueryEnd(false); // not aborted
    expect(session.hasPendingPrompts()).toBe(true);
  });

  it("notifyQueryEnd clears interrupt() (returns false after query ends)", () => {
    const ac = new AbortController();
    session.notifyQueryStart(ac);
    session.notifyQueryEnd(false);
    expect(session.interrupt()).toBe(false);
  });
});

// ── interrupt() ───────────────────────────────────────────────────────────────

describe("interrupt()", () => {
  it("returns false when no query is running", () => {
    expect(session.interrupt()).toBe(false);
  });

  it("returns true and aborts the AbortController when a query is running", () => {
    const ac = new AbortController();
    session.notifyQueryStart(ac);

    const result = session.interrupt();
    expect(result).toBe(true);
    expect(ac.signal.aborted).toBe(true);

    session.notifyQueryEnd(true); // clean up
  });

  it("returns false after the query finishes", () => {
    const ac = new AbortController();
    session.notifyQueryStart(ac);
    session.notifyQueryEnd(false);

    expect(session.interrupt()).toBe(false);
  });
});

// ── debounceMs ────────────────────────────────────────────────────────────────

describe("debounceMs", () => {
  function csEvt(conclusion: string): GitHubEvent {
    return { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion } } };
  }
  function prEvt(action: string): GitHubEvent {
    return { id: "e2", name: "pull_request", payload: { action } };
  }
  function commentEvt(): GitHubEvent {
    return { id: "e3", name: "issue_comment", payload: { action: "created" } };
  }

  it("returns 0 for pull_request/closed", () => {
    expect(debounceMs([prEvt("closed")])).toBe(0);
  });

  it("returns 0 when any event is pull_request/closed", () => {
    expect(debounceMs([csEvt("success"), prEvt("closed")])).toBe(0);
  });

  it("returns 3000 for check_suite failure", () => {
    expect(debounceMs([csEvt("failure")])).toBe(3000);
  });

  it("returns 3000 for check_suite action_required", () => {
    expect(debounceMs([csEvt("action_required")])).toBe(3000);
  });

  it("returns 30000 for check_suite success only", () => {
    expect(debounceMs([csEvt("success")])).toBe(30000);
  });

  it("returns 30000 for check_suite neutral only", () => {
    expect(debounceMs([csEvt("neutral")])).toBe(30000);
  });

  it("returns 30000 for multiple check_suite success events", () => {
    expect(debounceMs([csEvt("success"), csEvt("success")])).toBe(30000);
  });

  it("returns 3000 for mixed check_suite success and failure", () => {
    expect(debounceMs([csEvt("success"), csEvt("failure")])).toBe(3000);
  });

  it("returns 3000 for issue_comment (default)", () => {
    expect(debounceMs([commentEvt()])).toBe(3000);
  });

  it("returns 3000 for mix of check_suite success and issue_comment", () => {
    expect(debounceMs([csEvt("success"), commentEvt()])).toBe(3000);
  });
});

// ── event-type-specific debounce timers ───────────────────────────────────────

describe("event-type-specific debounce timers", () => {
  it("check_suite success uses 30s debounce instead of 3s", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      session.takeNextPrompt();

      const csEvt: GitHubEvent = { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success" } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: csEvt });

      // Should NOT fire after 3s (old default)
      await vi.advanceTimersByTimeAsync(3001);
      expect(session.hasPendingPrompts()).toBe(false);

      // Should fire after 30s
      await vi.advanceTimersByTimeAsync(27001);
      expect(session.hasPendingPrompts()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("check_suite failure still uses 3s debounce", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      session.takeNextPrompt();

      const csEvt: GitHubEvent = { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "failure" } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: csEvt });

      await vi.advanceTimersByTimeAsync(3001);
      expect(session.hasPendingPrompts()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pull_request/closed triggers immediate dispatch (0ms debounce)", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      session.takeNextPrompt();

      const prEvt: GitHubEvent = { id: "e1", name: "pull_request", payload: { action: "closed", pull_request: { number: 1 } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: prEvt });

      // Advance by just 1ms — fires immediately (0ms debounce)
      await vi.advanceTimersByTimeAsync(1);
      expect(session.hasPendingPrompts()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("failure check_suite arriving during 30s success window resets timer to 3s", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      session.takeNextPrompt();

      // Success sets 30s timer
      const successEvt: GitHubEvent = { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success" } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: successEvt });

      // Advance 3s — still waiting (30s timer)
      await vi.advanceTimersByTimeAsync(3001);
      expect(session.hasPendingPrompts()).toBe(false);

      // Failure arrives — resets timer to 3s
      const failEvt: GitHubEvent = { id: "e2", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "failure" } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: failEvt });

      // Advance 3s more — should fire now
      await vi.advanceTimersByTimeAsync(3001);
      expect(session.hasPendingPrompts()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── prIsClosed guard ──────────────────────────────────────────────────────────

describe("prIsClosed guard", () => {
  it("drops check_suite events silently when PR is closed", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      session.takeNextPrompt();

      // Close the PR — should trigger prompt after debounce
      const closedEvt: GitHubEvent = { id: "e1", name: "pull_request", payload: { action: "closed", pull_request: { number: 1 } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: closedEvt });
      await vi.runAllTimersAsync();
      expect(session.hasPendingPrompts()).toBe(true);
      session.takeNextPrompt(); // consume PR closed prompt

      // check_suite event should be silently dropped (prIsClosed = true)
      const csEvt: GitHubEvent = { id: "e2", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success" } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: csEvt });
      await vi.runAllTimersAsync();
      expect(session.hasPendingPrompts()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets prIsClosed flag on task_assigned", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      session.takeNextPrompt();

      // Close the PR
      const closedEvt: GitHubEvent = { id: "e1", name: "pull_request", payload: { action: "closed", pull_request: { number: 1 } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: closedEvt });
      await vi.runAllTimersAsync();
      session.takeNextPrompt(); // consume

      // New task assigned — resets prIsClosed
      sendMsg(fakeWs, { type: "task_assigned", taskId: "99", issue: makeIssue(2) });
      session.takeNextPrompt(); // consume new task prompt

      // check_suite event should now work normally (not dropped)
      const csEvt: GitHubEvent = { id: "e2", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success" } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "99", event: csEvt });
      await vi.runAllTimersAsync();
      expect(session.hasPendingPrompts()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still processes issue_comment/created after PR is closed", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      session.takeNextPrompt();

      // Close the PR
      const closedEvt: GitHubEvent = { id: "e1", name: "pull_request", payload: { action: "closed", pull_request: { number: 1 } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: closedEvt });
      await vi.runAllTimersAsync();
      session.takeNextPrompt(); // consume

      // issue_comment/created should NOT be dropped — still actionable after PR closed
      const commentEvt: GitHubEvent = { id: "e2", name: "issue_comment", payload: { action: "created" } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: commentEvt });
      await vi.runAllTimersAsync();
      expect(session.hasPendingPrompts()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears prIsClosed when pull_request/reopened is received", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      session.takeNextPrompt();

      // Close the PR
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: { id: "e1", name: "pull_request", payload: { action: "closed", pull_request: { number: 1 } } } });
      await vi.runAllTimersAsync();
      session.takeNextPrompt(); // consume

      // Reopen the PR (log_only — no prompt, but clears prIsClosed flag)
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: { id: "e2", name: "pull_request", payload: { action: "reopened", pull_request: { number: 1 } } } });
      await vi.runAllTimersAsync();

      // check_suite event should now work normally (not dropped)
      const csEvt: GitHubEvent = { id: "e3", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success" } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: csEvt });
      await vi.runAllTimersAsync();
      expect(session.hasPendingPrompts()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

import { Workspace, registerWorkspaceCommands } from "../src/agent/workspace.js";
import { CommandRegistry } from "../src/agent/commands.js";

// ── workspace slash commands via workspaceCommandDeps ─────────────────────────

describe("workspace slash commands in WorkerSession", () => {
  function makeWorkspace(): Workspace {
    return {
      dir: "/tmp/test-workspace",
      reset: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      checkSafety: vi.fn().mockResolvedValue({
        uncommittedFiles: [], unpushedCommits: [], noUpstream: false,
      }),
    } as unknown as Workspace;
  }

  it("/workspace:reset calls workspace.reset() when clean", async () => {
    const workspace = makeWorkspace();
    const confirm = vi.fn().mockResolvedValue(true);
    const sessionWs = new WorkerSession(WORKER_ID, wsFactory, display, {
      workspaceCtx: {
        workspace,
        originalCwd: "/original",
        workspaceDir: "/tmp/workers",
        repoUrl: "https://token@github.com/owner/repo.git",
        confirm,
      },
    });
    sessionWs.start();
    const wsReg1 = new CommandRegistry();
    registerWorkspaceCommands(sessionWs.workspaceCommandDeps, wsReg1, true);
    await wsReg1.execute("workspace:reset", "");
    expect(workspace.reset).toHaveBeenCalledOnce();
  });

  it("/workspace:reset does not reset if user declines", async () => {
    const workspace = makeWorkspace();
    (workspace.checkSafety as ReturnType<typeof vi.fn>).mockResolvedValue({
      uncommittedFiles: ["M foo.ts"], unpushedCommits: [], noUpstream: false,
    });
    const confirm = vi.fn().mockResolvedValue(false);
    const sessionWs = new WorkerSession(WORKER_ID, wsFactory, display, {
      workspaceCtx: {
        workspace,
        originalCwd: "/original",
        workspaceDir: "/tmp/workers",
        repoUrl: "https://token@github.com/owner/repo.git",
        confirm,
      },
    });
    sessionWs.start();
    const wsReg2 = new CommandRegistry();
    registerWorkspaceCommands(sessionWs.workspaceCommandDeps, wsReg2, true);
    await wsReg2.execute("workspace:reset", "");
    expect(workspace.reset).not.toHaveBeenCalled();
  });

  it("/workspace:remove calls destroy() when approved", async () => {
    const workspace = makeWorkspace();
    const confirm = vi.fn().mockResolvedValue(true);
    const originalCwd = process.cwd();
    const sessionWs = new WorkerSession(WORKER_ID, wsFactory, display, {
      workspaceCtx: {
        workspace,
        originalCwd,
        workspaceDir: "/tmp/workers",
        repoUrl: "https://token@github.com/owner/repo.git",
        confirm,
      },
    });
    sessionWs.start();
    const wsReg3 = new CommandRegistry();
    registerWorkspaceCommands(sessionWs.workspaceCommandDeps, wsReg3, true);
    await wsReg3.execute("workspace:remove", "");
    expect(workspace.destroy).toHaveBeenCalledOnce();
  });

  it("/workspace:create prints 'managed automatically' in worker mode", async () => {
    const printSpy = vi.spyOn(displayModule, "print").mockImplementation(() => {});
    try {
      const sessionWs = new WorkerSession(WORKER_ID, wsFactory, display, {});
      sessionWs.start();
      const wsReg4 = new CommandRegistry();
      registerWorkspaceCommands(sessionWs.workspaceCommandDeps, wsReg4, true);
      await wsReg4.execute("workspace:create", "");
      const printed = printSpy.mock.calls.map(([s]) => stripAnsi(s as string)).join("\n");
      expect(printed).toContain("managed automatically");
    } finally {
      printSpy.mockRestore();
    }
  });
});

// ── afterTask callback on /worker:complete ──────────────────────────────────────

describe("afterTask callback on /worker:complete", () => {
  it("calls afterTask before sending task_complete to foreman", async () => {
    const afterTask = vi.fn().mockResolvedValue(undefined);
    const sessionWithAfterTask = new WorkerSession(
      WORKER_ID, wsFactory, display, { afterTask }
    );
    sessionWithAfterTask.start();

    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });
    sessionWithAfterTask.takeNextPrompt();

    await sessionWithAfterTask.completeCurrentTask();
    expect(afterTask).toHaveBeenCalledOnce();
    const sentMsg = JSON.parse(fakeWs.send.mock.calls.at(-1)![0]);
    expect(sentMsg.type).toBe("task_complete");
  });

  it("does not send task_complete if afterTask throws", async () => {
    const afterTask = vi.fn().mockRejectedValue(new Error("reset failed"));
    const sessionWithAfterTask = new WorkerSession(
      WORKER_ID, wsFactory, display, { afterTask }
    );
    sessionWithAfterTask.start();

    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });
    sessionWithAfterTask.takeNextPrompt();

    const sendCountBefore = fakeWs.send.mock.calls.length;
    await sessionWithAfterTask.completeCurrentTask();
    const taskCompleteSent = fakeWs.send.mock.calls
      .slice(sendCountBefore)
      .some(([data]: [string]) => JSON.parse(data).type === "task_complete");
    expect(taskCompleteSent).toBe(false);
  });

  it("sends task_complete normally with no afterTask", async () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });
    session.takeNextPrompt();
    await session.completeCurrentTask();
    const lastMsg = JSON.parse(fakeWs.send.mock.calls.at(-1)![0]);
    expect(lastMsg.type).toBe("task_complete");
  });
});

// ── sendGoodbye ───────────────────────────────────────────────────────────────

describe("sendGoodbye", () => {
  it("sends worker_goodbye with workerId and taskId when ws is open and task is active", async () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    session.takeNextPrompt();

    fakeWs.send.mockClear();
    session.sendGoodbye();

    expect(fakeWs.send).toHaveBeenCalledOnce();
    const sent = JSON.parse(fakeWs.send.mock.calls[0][0]);
    expect(sent).toEqual({ type: "worker_goodbye", workerId: WORKER_ID, taskId: "42" });
  });

  it("sends worker_goodbye with undefined taskId when no task is active", () => {
    fakeWs.send.mockClear();
    session.sendGoodbye();

    expect(fakeWs.send).toHaveBeenCalledOnce();
    const sent = JSON.parse(fakeWs.send.mock.calls[0][0]);
    expect(sent.type).toBe("worker_goodbye");
    expect(sent.workerId).toBe(WORKER_ID);
    expect(sent.taskId).toBeUndefined();
  });

  it("does not send when ws is not open", () => {
    fakeWs.readyState = 3; // CLOSED
    fakeWs.send.mockClear();
    session.sendGoodbye();
    expect(fakeWs.send).not.toHaveBeenCalled();
  });
});

// ── Heartbeat / ping-pong ──────────────────────────────────────────────────────

describe("heartbeat", () => {
  afterEach(() => { vi.useRealTimers(); });

  function makeHeartbeatSession(pingIntervalMs = 100) {
    const ws = new FakeWs();
    const factory = vi.fn().mockReturnValue(ws);
    const s = new WorkerSession(WORKER_ID, factory, display, { pingIntervalMs });
    s.start();
    return { ws, factory, s };
  }

  it("sends a ping after the interval when the socket is open", () => {
    vi.useFakeTimers();
    const { ws } = makeHeartbeatSession(100);
    ws.emit("open");
    sendMsg(ws, { type: "hello_ack", status: "idle" });

    expect(ws.ping).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(ws.ping).toHaveBeenCalledOnce();
  });

  it("keeps the connection alive when a pong is received before the next ping tick", () => {
    vi.useFakeTimers();
    const { ws } = makeHeartbeatSession(100);
    ws.emit("open");
    sendMsg(ws, { type: "hello_ack", status: "idle" });

    vi.advanceTimersByTime(100); // first ping sent, isAlive set to false
    ws.emit("pong");             // pong received, isAlive reset to true
    vi.advanceTimersByTime(100); // second tick: isAlive is true → keeps connection

    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it("keeps the connection alive when an incoming ping from the foreman resets liveness", () => {
    vi.useFakeTimers();
    const { ws } = makeHeartbeatSession(100);
    ws.emit("open");
    sendMsg(ws, { type: "hello_ack", status: "idle" });

    vi.advanceTimersByTime(100); // first ping sent, isAlive set to false
    ws.emit("ping");             // foreman's heartbeat ping resets isAlive to true
    vi.advanceTimersByTime(100); // second tick: isAlive is true → keeps connection

    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it("terminates the connection when no pong is received after a ping", () => {
    vi.useFakeTimers();
    const { ws } = makeHeartbeatSession(100);
    ws.emit("open");
    sendMsg(ws, { type: "hello_ack", status: "idle" });

    vi.advanceTimersByTime(100); // first ping sent, isAlive set to false
    // no pong emitted
    vi.advanceTimersByTime(100); // second tick: isAlive is false → terminate

    expect(ws.terminate).toHaveBeenCalledOnce();
  });

  it("shows Disconnected in status text after heartbeat timeout", () => {
    vi.useFakeTimers();
    const { ws, s } = makeHeartbeatSession(100);
    ws.emit("open");
    sendMsg(ws, { type: "hello_ack", status: "idle" });
    expect(stripAnsi(s.getStatusText())).toContain("Connected");

    vi.advanceTimersByTime(100); // ping sent
    vi.advanceTimersByTime(100); // no pong → terminate → close fires

    expect(stripAnsi(s.getStatusText())).toContain("Disconnected");
  });

  it("reconnects after heartbeat timeout", () => {
    vi.useFakeTimers();
    const { ws, factory } = makeHeartbeatSession(100);
    ws.emit("open");
    sendMsg(ws, { type: "hello_ack", status: "idle" });

    vi.advanceTimersByTime(100); // ping sent
    vi.advanceTimersByTime(100); // no pong → terminate
    vi.advanceTimersByTime(5000); // reconnect delay

    expect(factory).toHaveBeenCalledTimes(2); // initial + one reconnect
  });

  it("resets the ping interval when a pong is received mid-cycle", () => {
    vi.useFakeTimers();
    const { ws } = makeHeartbeatSession(100);
    ws.emit("open");
    sendMsg(ws, { type: "hello_ack", status: "idle" });

    vi.advanceTimersByTime(100); // first ping sent
    expect(ws.ping).toHaveBeenCalledOnce();

    ws.emit("pong");             // resets the timer
    ws.ping.mockClear();

    // Only 50ms after reset — no ping should fire yet
    vi.advanceTimersByTime(50);
    expect(ws.ping).not.toHaveBeenCalled();

    // Full interval after reset — now the next ping fires
    vi.advanceTimersByTime(50);
    expect(ws.ping).toHaveBeenCalledOnce();
  });

  it("stops the ping timer when the socket closes", () => {
    vi.useFakeTimers();
    const { ws } = makeHeartbeatSession(100);
    ws.emit("open");
    sendMsg(ws, { type: "hello_ack", status: "idle" });

    vi.advanceTimersByTime(100); // first ping sent

    // Socket closes normally before the second tick
    ws.emit("close", 1000, Buffer.from(""));
    ws.ping.mockClear();

    // Even after another interval, no more pings sent on the closed socket
    vi.advanceTimersByTime(100);
    expect(ws.ping).not.toHaveBeenCalled();
  });
});
