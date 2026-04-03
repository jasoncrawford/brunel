import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { WorkerSession, classifyEvent, debounceMs } from "../src/worker.js";
import type { ForemanMessage, GitHubEvent, TaskIssue } from "../src/types.js";
import { stripAnsi } from "./helpers.js";

// ── Fake WebSocket ─────────────────────────────────────────────────────────────

class FakeWs extends EventEmitter {
  readyState = 1; // OPEN
  send = vi.fn();
  ping = vi.fn();
  terminate = vi.fn(() => {
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
let runQuery: ReturnType<typeof vi.fn>;
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
  runQuery = vi.fn().mockResolvedValue("session-1");
  display = {
    print: vi.fn(),
    printForemanMessage: vi.fn(),
    startPersistentStatus: vi.fn(),
    stopPersistentStatus: vi.fn(),
    updatePersistentStatus: vi.fn(),
    setOnToolResultCallback: vi.fn(),
  };
  session = new WorkerSession(WORKER_ID, wsFactory, runQuery, display);
  session.start();
});

// ── Idle → task assignment ────────────────────────────────────────────────────

describe("task_assigned", () => {
  it("calls runQuery with the initial prompt when task_assigned is received", async () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());
    const [prompt] = runQuery.mock.calls[0];
    expect(prompt).toContain(issue.title);
  });

  it("updates currentTaskId and currentIssue when task_assigned is received", async () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalled());
    // The state is observable via /task-complete behavior: if task is set,
    // task_complete message is sent to WS
    const action = session.handleUserInput("/task-complete");
    await action;
    const sent = JSON.parse(fakeWs.send.mock.calls[0][0]);
    expect(sent.taskId).toBe("42");
  });

  it("calls display.printForemanMessage for task_assigned", async () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    await vi.waitFor(() => expect(display.printForemanMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "task_assigned" })
    ));
  });

  it("prints the initial prompt in amber when task_assigned is received", async () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());
    const printCalls = display.print.mock.calls.map(args => stripAnsi(String(args[0])));
    expect(printCalls.some(s => s.includes(issue.title))).toBe(true);
  });
});

// ── Event handling during query ───────────────────────────────────────────────

describe("event_notification", () => {
  it("resolves WS input promise when actionable event_notification is received", async () => {
    const promise = session.createWsInputPromise();
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });
    const result = await promise;
    expect(result).toBeTruthy(); // promise resolved (sentinel value is internal impl detail)
  });

  it("queues event when event_notification arrives during runQuery", async () => {
    const issue = makeIssue();
    // First runQuery blocks until we resolve it
    let resolveFirst!: (v: string | undefined) => void;
    runQuery.mockReturnValueOnce(new Promise<string | undefined>((r) => { resolveFirst = r; }));
    runQuery.mockResolvedValue("session-2");

    // Assign task → starts runQuery (blocking)
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());

    // Deliver event while query is running
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });
    // First runQuery not yet finished — only called once so far
    expect(runQuery).toHaveBeenCalledOnce();

    // Finish first runQuery → should trigger event runQuery
    resolveFirst("session-1");
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalledTimes(2));

    const [eventPrompt] = runQuery.mock.calls[1];
    // Second call is with a different prompt (not the initial task prompt)
    const [initialPrompt] = runQuery.mock.calls[0];
    expect(eventPrompt).not.toBe(initialPrompt);
    expect(eventPrompt).toContain("A comment was added"); // issue_comment template content
  });

  it("prints event prompt when event runs a query (no 'Building prompt' diagnostic)", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());

      display.print.mockClear();
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });
      // Advance past the debounce timer
      await vi.runAllTimersAsync();
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledTimes(2));

      const printCalls = display.print.mock.calls.map(args => stripAnsi(String(args[0])));
      expect(printCalls.some(s => s.startsWith("Building prompt from events:"))).toBe(false);
      expect(printCalls.some(s => s.includes("A comment was added"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("batches multiple pending events into a single runQuery call", async () => {
    const issue = makeIssue();
    let resolveFirst!: (v: string | undefined) => void;
    runQuery.mockReturnValueOnce(new Promise<string | undefined>((r) => { resolveFirst = r; }));
    runQuery.mockResolvedValue("session-2");

    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());

    // Two actionable events during query (both get queued in pendingEvents)
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("pull_request_review") });

    resolveFirst("session-1");
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalledTimes(2));

    // Only 2 total runQuery calls: initial + 1 batched event call
    // buildEventPrompt with multiple events returns a "Multiple events" message
    const [batchedPrompt] = runQuery.mock.calls[1];
    expect(batchedPrompt).toContain("Multiple events");
  });
});

// ── User commands ─────────────────────────────────────────────────────────────

describe("handleUserInput", () => {
  it("/task-complete sends task_complete to WS and clears task state", async () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalled());

    await session.handleUserInput("/task-complete");

    const sent = JSON.parse(fakeWs.send.mock.calls[0][0]);
    expect(sent).toEqual({ type: "task_complete", workerId: WORKER_ID, taskId: "42" });
  });

  it("/task-complete returns 'task-complete' so workerMain can hide the prompt", async () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalled());

    const result = await session.handleUserInput("/task-complete");

    expect(result).toBe("task-complete");
  });

  it("/task-complete with no active task returns undefined (no prompt change needed)", async () => {
    const result = await session.handleUserInput("/task-complete");
    expect(result).toBeUndefined();
  });

  it("/task-complete with no active task does not send to WS", async () => {
    await session.handleUserInput("/task-complete");
    expect(fakeWs.send).not.toHaveBeenCalled();
  });

  it("/clear clears sessionId but not task state", async () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalled());

    await session.handleUserInput("/clear");

    // After /clear, task is still set — /task-complete should still send
    await session.handleUserInput("/task-complete");
    expect(fakeWs.send).toHaveBeenCalled();
    const sent = JSON.parse(fakeWs.send.mock.calls[0][0]);
    expect(sent.taskId).toBe("42");
  });

  it("regular query text runs runQuery with prompt and sessionId", async () => {
    await session.handleUserInput("hello claude");
    expect(runQuery).toHaveBeenCalledWith("hello claude", undefined, expect.anything());
  });

  it("WS_TASK_ASSIGNED sentinel triggers initial runQuery", async () => {
    const issue = makeIssue();
    // Simulate what the ws message handler does before resolving the promise
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());
    const [prompt] = runQuery.mock.calls[0];
    expect(prompt).toContain(issue.title);
  });

  it("__eof__ returns 'exit' so workerMain() loop breaks and cleanup runs", async () => {
    const result = await session.handleUserInput("__eof__");
    expect(result).toBe("exit");
  });
});

// ── State isolation ───────────────────────────────────────────────────────────

describe("state after task_complete", () => {
  it("currentTaskId / currentIssue / currentSessionId are cleared after /task-complete", async () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalled());

    await session.handleUserInput("/task-complete");

    // State should be cleared — another /task-complete sends nothing
    fakeWs.send.mockClear();
    await session.handleUserInput("/task-complete");
    expect(fakeWs.send).not.toHaveBeenCalled();
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

  it("shows task number after task_assigned", async () => {
    const issue = makeIssue(42);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t42", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalled());
    const text = stripAnsi(session.getStatusText());
    expect(text).toContain("task #42");
  });

  it("shows PR number after pull_request event", async () => {
    const issue = makeIssue(1);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalled());

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
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalled());

    // Set PR number
    const prEvent: GitHubEvent = {
      id: "pr-evt",
      name: "pull_request",
      payload: { action: "opened", pull_request: { number: 55, title: "PR" } },
    };
    sendMsg(fakeWs, { type: "event_notification", taskId: "t1", event: prEvent });
    expect(stripAnsi(session.getStatusText())).toContain("PR #55");

    // Complete task and assign new task
    await session.handleUserInput("/task-complete");
    const issue2 = makeIssue(2);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t2", issue: issue2 });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalledTimes(2));

    expect(stripAnsi(session.getStatusText())).not.toContain("PR #");
  });

  it("clears PR number from status bar when pull_request/closed without merging is received", async () => {
    const issue = makeIssue(1);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalled());

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

  it("keeps PR number in status bar when pull_request/closed with merge is received", async () => {
    const issue = makeIssue(1);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalled());

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

// ── createWsInputPromise ──────────────────────────────────────────────────────

describe("createWsInputPromise", () => {
  it("resolves when task_assigned arrives", async () => {
    const promise = session.createWsInputPromise();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "1", issue: makeIssue() });
    expect(await promise).toBeTruthy(); // sentinel value is internal impl detail
  });

  it("each new promise abandons the previous one (previous never resolves)", async () => {
    const first = session.createWsInputPromise();
    const second = session.createWsInputPromise();

    sendMsg(fakeWs, { type: "task_assigned", taskId: "1", issue: makeIssue() });

    // second gets resolved since it holds the current resolveWsInput
    expect(await second).toBeTruthy(); // sentinel value is internal impl detail
    // first was abandoned and never resolves
    const firstResult = await Promise.race([first, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 20))]);
    expect(firstResult).toBe("timeout");
  });
});

// ── waitUntilIdle ─────────────────────────────────────────────────────────────

describe("waitUntilIdle", () => {
  it("resolves immediately when no query is running", async () => {
    // No task assigned — not running a query
    const result = await Promise.race([
      session.waitUntilIdle().then(() => "idle"),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(result).toBe("idle");
  });

  it("waits until runQuery completes when a query is running", async () => {
    let resolveQuery!: (v: string | undefined) => void;
    runQuery.mockReturnValueOnce(new Promise<string | undefined>((r) => { resolveQuery = r; }));

    sendMsg(fakeWs, { type: "task_assigned", taskId: "1", issue: makeIssue() });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());

    // waitUntilIdle should not resolve while query is running
    const idlePromise = session.waitUntilIdle();
    const raceResult1 = await Promise.race([
      idlePromise.then(() => "idle"),
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(raceResult1).toBe("pending");

    // Resolve the query
    resolveQuery("session-done");

    // Now waitUntilIdle should resolve
    const raceResult2 = await Promise.race([
      idlePromise.then(() => "idle"),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 100)),
    ]);
    expect(raceResult2).toBe("idle");
  });

  it("multiple waitUntilIdle callers all resolve when query completes", async () => {
    let resolveQuery!: (v: string | undefined) => void;
    runQuery.mockReturnValueOnce(new Promise<string | undefined>((r) => { resolveQuery = r; }));

    sendMsg(fakeWs, { type: "task_assigned", taskId: "1", issue: makeIssue() });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());

    const p1 = session.waitUntilIdle();
    const p2 = session.waitUntilIdle();

    resolveQuery("session-done");

    await expect(p1).resolves.toBeUndefined();
    await expect(p2).resolves.toBeUndefined();
  });

  it("resolves after runQuery is aborted (^C interrupt)", async () => {
    let resolveQuery!: (v: string | undefined) => void;
    let capturedAc!: AbortController;
    runQuery.mockImplementationOnce(
      (_prompt: string, _sessionId: string | undefined, ac: AbortController) => {
        capturedAc = ac;
        return new Promise<string | undefined>((r) => { resolveQuery = r; });
      }
    );

    sendMsg(fakeWs, { type: "task_assigned", taskId: "1", issue: makeIssue() });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());

    const idlePromise = session.waitUntilIdle();

    // Simulate ^C: abort the controller and let the mock resolve
    capturedAc.abort();
    resolveQuery(undefined);

    // waitUntilIdle should resolve even though the query was aborted
    const result = await Promise.race([
      idlePromise.then(() => "idle"),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 100)),
    ]);
    expect(result).toBe("idle");
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

      // Reconnect: new WS is created
      const newWs = reconnectWithNewWs();

      // Open event → hello_sent state
      newWs.emit("open");

      // Try to send task_complete — should be buffered (hello_ack not yet received)
      await session.handleUserInput("/task-complete");
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

      const newWs = reconnectWithNewWs();
      newWs.emit("open");

      // Buffer a task_complete
      await session.handleUserInput("/task-complete");
      expect(newWs.send).not.toHaveBeenCalled();

      // Send hello_ack cancelled → buffer discarded, task state cleared
      sendMsg(newWs, { type: "hello_ack", workerId: WORKER_ID, status: "cancelled" });
      expect(newWs.send).not.toHaveBeenCalled();

      // Verify task state cleared: subsequent /task-complete sends nothing
      await session.handleUserInput("/task-complete");
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
      } as unknown as import("../src/workspace.js").Workspace;

      const wsA = new FakeWs();
      const wsB = new FakeWs();
      let callCount = 0;
      const wsFactoryWs = vi.fn().mockImplementation(() => callCount++ === 0 ? wsA : wsB);

      const sessionWithWs = new WorkerSession(WORKER_ID, wsFactoryWs, runQuery, display, {
        workspaceCtx: { workspace, originalCwd: "/original", workspaceDir: "/tmp/workers", repoUrl: "https://github.com/owner/repo", confirm: vi.fn() },
      });
      sessionWithWs.start(); // uses wsA

      const issue = makeIssue();
      sendMsg(wsA, { type: "task_assigned", taskId: "42", issue });

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

  it("aborts running query when hello_ack cancelled is received", async () => {
    vi.useFakeTimers();
    try {
      let capturedAc: AbortController | undefined;
      let resolveQuery!: (v: string) => void;
      const pendingQuery = new Promise<string>((resolve) => { resolveQuery = resolve; });

      runQuery.mockImplementationOnce(async (
        _prompt: string,
        _sessionId: string | undefined,
        ac: AbortController,
      ) => {
        capturedAc = ac;
        return pendingQuery;
      });

      // Assign task — starts runQuery (which is now pending)
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      await vi.waitFor(() => expect(capturedAc).toBeDefined());

      // Simulate reconnect and receive cancelled ack while query is still running
      const newWs = reconnectWithNewWs();
      newWs.emit("open");
      sendMsg(newWs, { type: "hello_ack", workerId: WORKER_ID, status: "cancelled" });

      // The running query's AbortController must be aborted
      expect(capturedAc?.signal.aborted).toBe(true);

      // Clean up: resolve the pending promise so the async loop can exit
      resolveQuery("session-1");
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

      const newWs = reconnectWithNewWs();
      newWs.emit("open");

      await session.handleUserInput("/task-complete");
      expect(newWs.send).not.toHaveBeenCalled();

      // hello_ack idle — task was reverted on foreman side; but worker flushes anyway
      // (foreman's ownership check will reject the stale task_complete if needed)
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
  it("log_only event is not pushed to pendingEvents and does not trigger query", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());

      runQuery.mockClear();
      // check_run is log_only
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: { id: "e1", name: "check_run", payload: { action: "completed" } } });
      await vi.runAllTimersAsync();

      // No additional runQuery call
      expect(runQuery).not.toHaveBeenCalled();
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
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());

      runQuery.mockClear();
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });

      // runQuery not yet called (debounce timer pending)
      expect(runQuery).not.toHaveBeenCalled();

      // Advance past the debounce delay
      await vi.runAllTimersAsync();

      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());
    } finally {
      vi.useRealTimers();
    }
  });

  it("multiple actionable events arriving within debounce window are batched into one query", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());

      runQuery.mockClear();
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("pull_request_review") });

      // Advance past the debounce delay
      await vi.runAllTimersAsync();

      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());
      const [prompt] = runQuery.mock.calls[0];
      expect(prompt).toContain("Multiple events");
    } finally {
      vi.useRealTimers();
    }
  });

  it("debounce timer is cancelled when runQueryLoop starts (e.g., via user input)", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());

      runQuery.mockClear();
      // Actionable event sets the debounce timer
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });
      expect(runQuery).not.toHaveBeenCalled();

      // User input fires a query before the timer fires.
      // runQueryLoop cancels the debounce, runs the user's query, then drains
      // the pending issue_comment event — total 2 runQuery calls.
      const userQueryPromise = session.handleUserInput("what's the status?");
      await userQueryPromise;

      // Advance past the original debounce delay — the cancelled timer must
      // NOT fire a third runQuery call.
      await vi.runAllTimersAsync();

      expect(runQuery).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Interrupt (AbortController) ───────────────────────────────────────────────

describe("interrupt", () => {
  it("runQueryLoop passes an AbortController to runQuery", async () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());
    const ac = runQuery.mock.calls[0][2];
    expect(ac).toBeInstanceOf(AbortController);
  });

  it("when runQuery's AbortController is aborted, event drain is skipped", async () => {
    const issue = makeIssue();
    // Mock runQuery: abort the controller on first call, then resolve
    runQuery.mockImplementationOnce(async (_prompt: string, _sessionId: string | undefined, ac: AbortController) => {
      ac.abort(); // simulate user pressing ^C
      return "session-1";
    });

    // Deliver event before query finishes (it will be in pendingEvents)
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());

    // Queue an event that would normally trigger a second runQuery
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });

    // Wait for the loop to settle
    await vi.waitFor(() => !session["isRunningQuery"]);

    // The event drain should have been skipped — only one runQuery call
    expect(runQuery).toHaveBeenCalledOnce();
  });

  it("when runQuery's AbortController is aborted, notifyQueryDone is not called (waitUntilIdle still resolves via isRunningQuery flag)", async () => {
    const issue = makeIssue();
    let abortedAc: AbortController | undefined;
    runQuery.mockImplementationOnce(async (_prompt: string, _sessionId: string | undefined, ac: AbortController) => {
      abortedAc = ac;
      ac.abort();
      return "session-1";
    });

    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());

    // waitUntilIdle should still resolve after the runQuery loop exits
    const result = await Promise.race([
      session.waitUntilIdle().then(() => "idle"),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 100)),
    ]);
    expect(result).toBe("idle");
    expect(abortedAc?.signal.aborted).toBe(true);
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
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());
      runQuery.mockClear();

      const csEvt: GitHubEvent = { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success" } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: csEvt });

      // Should NOT fire after 3s (old default)
      await vi.advanceTimersByTimeAsync(3001);
      expect(runQuery).not.toHaveBeenCalled();

      // Should fire after 30s
      await vi.advanceTimersByTimeAsync(27001);
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());
    } finally {
      vi.useRealTimers();
    }
  });

  it("check_suite failure still uses 3s debounce", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());
      runQuery.mockClear();

      const csEvt: GitHubEvent = { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "failure" } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: csEvt });

      await vi.advanceTimersByTimeAsync(3001);
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());
    } finally {
      vi.useRealTimers();
    }
  });

  it("pull_request/closed triggers immediate dispatch (0ms debounce)", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());
      runQuery.mockClear();

      const prEvt: GitHubEvent = { id: "e1", name: "pull_request", payload: { action: "closed", pull_request: { number: 1 } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: prEvt });

      // Advance by just 1ms — fires immediately (0ms debounce)
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());
    } finally {
      vi.useRealTimers();
    }
  });

  it("failure check_suite arriving during 30s success window resets timer to 3s", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());
      runQuery.mockClear();

      // Success sets 30s timer
      const successEvt: GitHubEvent = { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success" } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: successEvt });

      // Advance 3s — still waiting (30s timer)
      await vi.advanceTimersByTimeAsync(3001);
      expect(runQuery).not.toHaveBeenCalled();

      // Failure arrives — resets timer to 3s
      const failEvt: GitHubEvent = { id: "e2", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "failure" } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: failEvt });

      // Advance 3s more — should fire now
      await vi.advanceTimersByTimeAsync(3001);
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());
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
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());

      // Close the PR — should trigger cleanup query
      const closedEvt: GitHubEvent = { id: "e1", name: "pull_request", payload: { action: "closed", pull_request: { number: 1 } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: closedEvt });
      await vi.runAllTimersAsync();
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledTimes(2));
      runQuery.mockClear();

      // check_suite event should be silently dropped
      const csEvt: GitHubEvent = { id: "e2", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success" } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: csEvt });
      await vi.runAllTimersAsync();
      expect(runQuery).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets prIsClosed flag on task_assigned", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());

      // Close the PR
      const closedEvt: GitHubEvent = { id: "e1", name: "pull_request", payload: { action: "closed", pull_request: { number: 1 } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: closedEvt });
      await vi.runAllTimersAsync();
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledTimes(2));

      // New task assigned — resets prIsClosed
      sendMsg(fakeWs, { type: "task_assigned", taskId: "99", issue: makeIssue(2) });
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledTimes(3));
      runQuery.mockClear();

      // check_suite event should now work normally (not dropped)
      const csEvt: GitHubEvent = { id: "e2", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success" } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "99", event: csEvt });
      await vi.runAllTimersAsync();
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());
    } finally {
      vi.useRealTimers();
    }
  });

  it("still processes issue_comment/created after PR is closed", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());

      // Close the PR — should trigger cleanup query
      const closedEvt: GitHubEvent = { id: "e1", name: "pull_request", payload: { action: "closed", pull_request: { number: 1 } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: closedEvt });
      await vi.runAllTimersAsync();
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledTimes(2));
      runQuery.mockClear();

      // issue_comment/created should NOT be dropped — still actionable after PR closed
      const commentEvt: GitHubEvent = { id: "e2", name: "issue_comment", payload: { action: "created" } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: commentEvt });
      await vi.runAllTimersAsync();
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears prIsClosed when pull_request/reopened is received", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());

      // Close the PR
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: { id: "e1", name: "pull_request", payload: { action: "closed", pull_request: { number: 1 } } } });
      await vi.runAllTimersAsync();
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledTimes(2));

      // Reopen the PR
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: { id: "e2", name: "pull_request", payload: { action: "reopened", pull_request: { number: 1 } } } });
      await vi.runAllTimersAsync();
      runQuery.mockClear();

      // check_suite event should now work normally (not dropped)
      const csEvt: GitHubEvent = { id: "e3", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success" } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: csEvt });
      await vi.runAllTimersAsync();
      await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());
    } finally {
      vi.useRealTimers();
    }
  });
});

import { Workspace } from "../src/workspace.js";

// ── workspace slash commands in WorkerSession ─────────────────────────────────

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

  it("/reset-workspace calls workspace.reset() when clean", async () => {
    const workspace = makeWorkspace();
    const confirm = vi.fn().mockResolvedValue(true);
    const sessionWs = new WorkerSession(WORKER_ID, wsFactory, runQuery, display, {
      workspaceCtx: {
        workspace,
        originalCwd: "/original",
        workspaceDir: "/tmp/workers",
        repoUrl: "https://token@github.com/owner/repo.git",
        confirm,
      },
    });
    sessionWs.start();
    await sessionWs.handleUserInput("/reset-workspace");
    expect(workspace.reset).toHaveBeenCalledOnce();
  });

  it("/reset-workspace does not reset if user declines", async () => {
    const workspace = makeWorkspace();
    (workspace.checkSafety as ReturnType<typeof vi.fn>).mockResolvedValue({
      uncommittedFiles: ["M foo.ts"], unpushedCommits: [], noUpstream: false,
    });
    const confirm = vi.fn().mockResolvedValue(false);
    const sessionWs = new WorkerSession(WORKER_ID, wsFactory, runQuery, display, {
      workspaceCtx: {
        workspace,
        originalCwd: "/original",
        workspaceDir: "/tmp/workers",
        repoUrl: "https://token@github.com/owner/repo.git",
        confirm,
      },
    });
    sessionWs.start();
    await sessionWs.handleUserInput("/reset-workspace");
    expect(workspace.reset).not.toHaveBeenCalled();
  });

  it("/remove-workspace calls destroy() when approved", async () => {
    const workspace = makeWorkspace();
    const confirm = vi.fn().mockResolvedValue(true);
    const originalCwd = process.cwd();
    const sessionWs = new WorkerSession(WORKER_ID, wsFactory, runQuery, display, {
      workspaceCtx: {
        workspace,
        originalCwd,
        workspaceDir: "/tmp/workers",
        repoUrl: "https://token@github.com/owner/repo.git",
        confirm,
      },
    });
    sessionWs.start();
    await sessionWs.handleUserInput("/remove-workspace");
    expect(workspace.destroy).toHaveBeenCalledOnce();
  });

  it("/create-workspace prints 'managed automatically' in worker mode", async () => {
    const sessionWs = new WorkerSession(WORKER_ID, wsFactory, runQuery, display, {});
    sessionWs.start();
    await sessionWs.handleUserInput("/create-workspace");
    const printed = display.print.mock.calls.map(([s]: [string]) => s).join("\n");
    expect(printed).toContain("managed automatically");
  });
});

// ── afterTask callback on /task-complete ──────────────────────────────────────

describe("afterTask callback on /task-complete", () => {
  it("calls afterTask before sending task_complete to foreman", async () => {
    const afterTask = vi.fn().mockResolvedValue(undefined);
    const sessionWithAfterTask = new WorkerSession(
      WORKER_ID, wsFactory, runQuery, display, { afterTask }
    );
    sessionWithAfterTask.start();

    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalled());

    await sessionWithAfterTask.handleUserInput("/task-complete");
    expect(afterTask).toHaveBeenCalledOnce();
    const sentMsg = JSON.parse(fakeWs.send.mock.calls.at(-1)![0]);
    expect(sentMsg.type).toBe("task_complete");
  });

  it("does not send task_complete if afterTask throws", async () => {
    const afterTask = vi.fn().mockRejectedValue(new Error("reset failed"));
    const sessionWithAfterTask = new WorkerSession(
      WORKER_ID, wsFactory, runQuery, display, { afterTask }
    );
    sessionWithAfterTask.start();

    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalled());

    const sendCountBefore = fakeWs.send.mock.calls.length;
    await sessionWithAfterTask.handleUserInput("/task-complete");
    const taskCompleteSent = fakeWs.send.mock.calls
      .slice(sendCountBefore)
      .some(([data]: [string]) => JSON.parse(data).type === "task_complete");
    expect(taskCompleteSent).toBe(false);
  });

  it("sends task_complete normally with no afterTask", async () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalled());
    await session.handleUserInput("/task-complete");
    const lastMsg = JSON.parse(fakeWs.send.mock.calls.at(-1)![0]);
    expect(lastMsg.type).toBe("task_complete");
  });
});

// ── API error handling ────────────────────────────────────────────────────────

describe("runQuery error handling", () => {
  it("prints error and remains functional when runQuery throws during task_assigned", async () => {
    const issue = makeIssue();
    runQuery.mockRejectedValueOnce(new Error("You're out of extra usage · resets 9am (Etc/Unknown)"));

    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());

    // waitUntilIdle should resolve (not hang) after the error
    const result = await Promise.race([
      session.waitUntilIdle().then(() => "idle"),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 200)),
    ]);
    expect(result).toBe("idle");

    // Error message should be printed
    const printCalls = display.print.mock.calls.map(args => stripAnsi(String(args[0])));
    expect(printCalls.some(s => s.includes("out of extra usage"))).toBe(true);
  });

  it("prints error and remains functional when runQuery throws during event processing", async () => {
    const issue = makeIssue();
    let resolveFirst!: (v: string | undefined) => void;
    runQuery.mockReturnValueOnce(new Promise<string | undefined>((r) => { resolveFirst = r; }));
    runQuery.mockRejectedValueOnce(new Error("Claude Code returned an error result: out of tokens"));

    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());

    // Queue an event while query is running
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });

    // Finish the first query → event processing starts and throws
    resolveFirst("session-1");
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalledTimes(2));

    // waitUntilIdle should resolve (not hang) after the error
    const result = await Promise.race([
      session.waitUntilIdle().then(() => "idle"),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 200)),
    ]);
    expect(result).toBe("idle");

    // Error message should be printed
    const printCalls = display.print.mock.calls.map(args => stripAnsi(String(args[0])));
    expect(printCalls.some(s => s.includes("out of tokens"))).toBe(true);
  });

  it("does not print error for abort (^C interrupt) — that is a clean interrupt", async () => {
    const issue = makeIssue();
    let rejectQuery!: (e: Error) => void;
    runQuery.mockReturnValueOnce(new Promise<string | undefined>((_r, reject) => { rejectQuery = reject; }));

    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());

    display.print.mockClear();
    // runQuery (in repl.ts) swallows AbortError and resolves undefined — but
    // here we simulate a raw abort thrown by the mock (edge case)
    rejectQuery(new Error("Operation aborted by user"));

    await vi.waitFor(() => session.waitUntilIdle());

    const printCalls = display.print.mock.calls.map(args => stripAnsi(String(args[0])));
    expect(printCalls.some(s => s.toLowerCase().includes("error"))).toBe(false);
  });
});

describe("sendGoodbye", () => {
  it("sends worker_goodbye with workerId and taskId when ws is open and task is active", async () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalled());

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

// ── interrupt() ───────────────────────────────────────────────────────────────

describe("interrupt()", () => {
  it("returns false when no query is running", () => {
    expect(session.interrupt()).toBe(false);
  });

  it("returns true and aborts the AbortController when a query is running", async () => {
    let capturedAc: AbortController | undefined;
    let resolveQuery!: (value: string | undefined) => void;
    runQuery.mockImplementation(
      (_prompt: string, _sid: string | undefined, ac: AbortController) => {
        capturedAc = ac;
        return new Promise<string | undefined>((resolve) => { resolveQuery = resolve; });
      },
    );

    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    await vi.waitFor(() => expect(capturedAc).toBeDefined());

    const result = session.interrupt();
    expect(result).toBe(true);
    expect(capturedAc?.signal.aborted).toBe(true);

    // Clean up: resolve the query so runQueryLoop can exit
    resolveQuery(undefined);
    await session.waitUntilIdle();
  });

  it("returns false after the query finishes", async () => {
    let resolveQuery!: (value: string | undefined) => void;
    runQuery.mockImplementation(
      () => new Promise<string | undefined>((resolve) => { resolveQuery = resolve; }),
    );

    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalled());

    resolveQuery(undefined);
    await session.waitUntilIdle();

    expect(session.interrupt()).toBe(false);
  });
});

// ── Heartbeat ─────────────────────────────────────────────────────────────────

describe("heartbeat", () => {
  const PING_INTERVAL = 100;
  let pingWs: FakeWs;
  let pingWsFactory: ReturnType<typeof vi.fn>;
  let pingSession: WorkerSession;

  beforeEach(() => {
    pingWs = new FakeWs();
    pingWsFactory = vi.fn().mockReturnValue(pingWs);
    pingSession = new WorkerSession(WORKER_ID, pingWsFactory, runQuery, display, { pingIntervalMs: PING_INTERVAL });
    pingSession.start();
  });

  it("sends a ping after the interval when the connection is open", () => {
    vi.useFakeTimers();
    try {
      pingWs.emit("open");
      vi.advanceTimersByTime(PING_INTERVAL);
      expect(pingWs.ping).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates connection when no pong is received before the next ping", () => {
    vi.useFakeTimers();
    try {
      pingWs.emit("open");
      vi.advanceTimersByTime(PING_INTERVAL); // first ping sent, isAlive set to false
      expect(pingWs.ping).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(PING_INTERVAL); // second interval: no pong → terminate
      expect(pingWs.terminate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not terminate when a pong is received between pings", () => {
    vi.useFakeTimers();
    try {
      pingWs.emit("open");
      vi.advanceTimersByTime(PING_INTERVAL); // first ping sent
      pingWs.emit("pong");                   // pong received → isAlive = true
      vi.advanceTimersByTime(PING_INTERVAL); // second ping sent (not terminate)
      expect(pingWs.terminate).not.toHaveBeenCalled();
      expect(pingWs.ping).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects after heartbeat-induced termination", () => {
    vi.useFakeTimers();
    try {
      const newWs = new FakeWs();
      pingWsFactory.mockReturnValueOnce(newWs);

      pingWs.emit("open");
      vi.advanceTimersByTime(PING_INTERVAL * 2); // two intervals → terminate → close → reconnect scheduled
      vi.advanceTimersByTime(5001); // advance past the reconnect delay
      expect(pingWsFactory).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows Disconnected in status bar after heartbeat timeout", () => {
    vi.useFakeTimers();
    try {
      pingWs.emit("open");
      sendMsg(pingWs, { type: "hello_ack", workerId: WORKER_ID, status: "idle" });
      expect(stripAnsi(pingSession.getStatusText())).toContain("Connected");

      vi.advanceTimersByTime(PING_INTERVAL * 2); // two intervals → terminate → close
      expect(stripAnsi(pingSession.getStatusText())).toContain("Disconnected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not ping after the connection is closed", () => {
    vi.useFakeTimers();
    try {
      pingWs.emit("open");
      pingWs.emit("close", 1006, Buffer.from("")); // close before first ping
      pingWs.ping.mockClear();
      vi.advanceTimersByTime(PING_INTERVAL * 3);
      expect(pingWs.ping).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
