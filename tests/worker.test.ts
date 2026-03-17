import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { WorkerSession } from "../src/worker.js";
import type { ForemanMessage, GitHubEvent, TaskIssue } from "../src/types.js";

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
});

// ── Event handling during query ───────────────────────────────────────────────

describe("event_notification", () => {
  it("resolves WS input promise when event_notification is received", async () => {
    const promise = session.createWsInputPromise();
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent() });
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

  it("batches multiple pending events into a single runQuery call", async () => {
    const issue = makeIssue();
    let resolveFirst!: (v: string | undefined) => void;
    runQuery.mockReturnValueOnce(new Promise<string | undefined>((r) => { resolveFirst = r; }));
    runQuery.mockResolvedValue("session-2");

    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalledOnce());

    // Two events during query
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("push") });
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });

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
