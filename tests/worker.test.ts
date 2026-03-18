import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { WorkerSession, classifyEvent } from "../src/worker.js";
import type { ForemanMessage, GitHubEvent, TaskIssue } from "../src/types.js";
import { stripAnsi } from "./helpers.js";

// ── Fake WebSocket ─────────────────────────────────────────────────────────────

class FakeWs extends EventEmitter {
  readyState = 1; // OPEN
  send = vi.fn();
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
let display: { print: ReturnType<typeof vi.fn>; printForemanMessage: ReturnType<typeof vi.fn> };
let session: WorkerSession;

beforeEach(() => {
  fakeWs = new FakeWs();
  wsFactory = vi.fn().mockReturnValue(fakeWs);
  runQuery = vi.fn().mockResolvedValue("session-1");
  display = {
    print: vi.fn(),
    printForemanMessage: vi.fn(),
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

  it("prints 'Building prompt from events:' diagnostic and prompt in amber when event runs a query", async () => {
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
      expect(printCalls.some(s => s.startsWith("Building prompt from events:"))).toBe(true);
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

  it("regular query text runs runQuery", async () => {
    await session.handleUserInput("hello claude");
    expect(runQuery).toHaveBeenCalledWith("hello claude", undefined);
  });

  it("WS_TASK_ASSIGNED sentinel triggers initial runQuery", async () => {
    const issue = makeIssue();
    // Simulate what the ws message handler does before resolving the promise
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());
    const [prompt] = runQuery.mock.calls[0];
    expect(prompt).toContain(issue.title);
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
    vi.advanceTimersByTime(3001);

    expect(wsFactory).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("passes workerId and currentTaskId to wsFactory on reconnect", async () => {
    vi.useFakeTimers();

    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    await Promise.resolve();

    fakeWs.emit("close");
    vi.advanceTimersByTime(3001);

    const secondCall = wsFactory.mock.calls[1];
    expect(secondCall[0]).toBe(WORKER_ID);
    expect(secondCall[1]).toBe("42");
    vi.useRealTimers();
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

    // standby doesn't resolve either promise (not a task/event signal)
    sendMsg(fakeWs, { type: "standby" });
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
    it("pull_request/closed is actionable", () => {
      expect(classifyEvent(evt("pull_request", "closed"))).toBe("actionable");
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
