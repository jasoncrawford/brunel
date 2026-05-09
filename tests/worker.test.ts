import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { WorkerController, WorkerControllerOptions } from "../src/agent/controllers/worker-controller.js";
import { UserCancelledError } from "../src/agent/controllers/workspace-controller.js";
import { AgentStatus } from "../src/agent/models/agent-status.js";
import { Display } from "../src/agent/views/display.js";
import { Picker, type PickConfig } from "../src/agent/views/picker.js";
import * as Wire from "../shared/wire.js";
import { stripAnsi } from "./helpers.js";
import { getConfig } from "../src/config.js";

function makeMockPicker(fn: (opts: string[]) => Promise<number | { type: "text"; text: string }>): Picker {
  return {
    pick: vi.fn().mockImplementation(async (opts: string[], config?: PickConfig) => {
      const r = await fn(opts);
      if (config == null) return r as number;
      return typeof r === "number" ? { type: "selected", index: r } : { type: "other", text: (r as { text: string }).text };
    }),
  } as unknown as Picker;
}

// ── Fake WebSocket ─────────────────────────────────────────────────────────────

class FakeWs extends EventEmitter {
  readyState = 1; // OPEN
  send = vi.fn();
  ping = vi.fn();
  close = vi.fn().mockImplementation(() => {
    this.readyState = 3; // CLOSED
    this.emit("close", 1000, Buffer.from(""));
  });
  terminate = vi.fn().mockImplementation(() => {
    this.readyState = 3; // CLOSED
    this.emit("close", 1006, Buffer.from(""));
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const AGENT_ID = "test-worker-id";

function makeIssue(n = 1, status: Wire.TaskStatus = "assigned"): Wire.TaskIssue {
  return { number: n, title: `Issue ${n}`, body: `Body ${n}`, labels: [], repoUrl: "https://github.com/owner/repo", status };
}

function makeEvent(name = "push"): Wire.WebhookEvent {
  return { id: "evt-1", name, payload: {} };
}

function sendMsg(ws: FakeWs, msg: Wire.ForemanMessage) {
  ws.emit("message", Buffer.from(JSON.stringify(msg)));
}

function fmtStatus(status: AgentStatus): string {
  status.setWorkerModeActive(true);
  return stripAnsi(new Display(getConfig(), status).renderer.fmtStatusBar(status, 100));
}

// ── Test harness ──────────────────────────────────────────────────────────────

let fakeWs: FakeWs;
let wsFactory: ReturnType<typeof vi.fn>;
let sb: AgentStatus;
let display: {
  print: ReturnType<typeof vi.fn>;
  printForemanMessage: ReturnType<typeof vi.fn>;
};
let session: WorkerController;

beforeEach(async () => {
  fakeWs = new FakeWs();
  wsFactory = vi.fn().mockReturnValue(fakeWs);
  sb = new AgentStatus({ agentId: AGENT_ID });
  display = {
    print: vi.fn(),
    printForemanMessage: vi.fn(),
  };
  vi.spyOn(sb, "setOnToolResult");
  vi.spyOn(sb, "update");
  session = new WorkerController(sb, display, makeMockPicker(async () => 0), undefined, "owner/repo", { wsFactory });
  await session.start();
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

  it("clears eventsPaused when task_assigned is received while paused", () => {
    session.pauseEvents();
    expect(session.eventsPaused).toBe(true);

    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });

    expect(session.eventsPaused).toBe(false);
  });

  it("discards pending events from prior task when task_assigned is received while paused", () => {
    // Assign and activate a first task so events can be queued.
    sendMsg(fakeWs, { type: "task_assigned", taskId: "41", issue: makeIssue(1) });
    session.takeNextPrompt();
    // Queue an event for the first task then pause.
    sendMsg(fakeWs, { type: "event_notification", taskId: "41", event: makeEvent("issue_comment") });
    session.pauseEvents();
    expect(session.pendingEventsCount).toBe(1);

    // New task arrives.
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue(2) });

    expect(session.eventsPaused).toBe(false);
    expect(session.pendingEventsCount).toBe(0);
  });

  it("agentStatus reflects unpaused state after task_assigned clears eventsPaused", () => {
    session.pauseEvents();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });

    expect(sb.eventsPaused).toBe(false);
    expect(sb.pendingEventsCount).toBe(0);
  });
});

// ── Event handling during a running query ─────────────────────────────────────

describe("event_notification", () => {
  it("emits 'prompts_ready' when actionable event_notification fires after debounce", async () => {
    vi.useFakeTimers();
    // Must assign a task first so the debounce fires (requires currentTaskId to be set).
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt(); // consume initial prompt

    const onPromptsReady = vi.fn();
    session.on("prompts_ready", onPromptsReady);
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });
    await vi.runAllTimersAsync();
    expect(onPromptsReady).toHaveBeenCalled();
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
    expect(sent).toEqual({ type: "task_complete", workerId: AGENT_ID, taskId: "42", nextState: "reserved" });
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

  it("includes accumulated token stats in task_complete message", async () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt();
    sb.addQueryStats(1000, 500, 0.05); // add stats after assignment (task_assigned resets stats)
    await session.completeCurrentTask();
    const sent = JSON.parse(fakeWs.send.mock.calls[0][0]);
    expect(sent.type).toBe("task_complete");
    expect(sent.stats).toEqual({ inputTokens: 1000, outputTokens: 500, costUsd: 0.05 });
  });

  it("omits stats from task_complete when no tokens were used", async () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt();
    await session.completeCurrentTask();
    const sent = JSON.parse(fakeWs.send.mock.calls[0][0]);
    expect(sent.type).toBe("task_complete");
    expect(sent.stats).toBeUndefined();
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

  it("restores current branch in agentStatus after task completion (not empty string)", async () => {
    // We can test that branch is refreshed after task completion via the agentStatus.
    // The actual branch value comes from git, so we just verify it's non-empty or was updated.
    const localSb = new AgentStatus({ agentId: AGENT_ID });
    const localSession = new WorkerController(
      localSb,
      display,
      makeMockPicker(async () => 0),
      undefined,
      "owner/repo",
      { wsFactory },
    );
    await localSession.start();

    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    localSession.takeNextPrompt();

    // Set a known branch value, then complete the task and verify refreshBranch() was called
    // (agentStatus.update with branch is called — we rely on the spy set up in beforeEach).
    const updateSpy = vi.spyOn(localSb, "update");
    await localSession.completeCurrentTask();

    // After completeCurrentTask(), refreshBranch() is called which updates branch.
    expect(updateSpy.mock.calls.some(([p]) => "branch" in p)).toBe(true);
  });
});

// ── Prompt queuing API ────────────────────────────────────────────────────────

describe("hasPendingPrompts / takeNextPrompt / prompts_ready event", () => {
  it("hasPendingPrompts is false initially", () => {
    expect(session.hasPendingPrompts()).toBe(false);
  });

  it("takeNextPrompt returns undefined when no prompts queued", () => {
    expect(session.takeNextPrompt()).toBeUndefined();
  });

  it("emits 'prompts_ready' synchronously when task_assigned arrives", () => {
    const onPromptsReady = vi.fn();
    session.on("prompts_ready", onPromptsReady);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "1", issue: makeIssue() });
    expect(onPromptsReady).toHaveBeenCalledOnce();
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
    expect(secondCall[0]).toBe(AGENT_ID);
    expect(secondCall[1]).toBe("42");
    vi.useRealTimers();
  });

  it("reconnect fires immediately when Math.random() returns 0 (full jitter minimum)", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);

    fakeWs.emit("close");
    vi.advanceTimersByTime(1); // delay = 0 * min(300000, 1000) = 0ms
    expect(wsFactory).toHaveBeenCalledTimes(2);

    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("first reconnect delay is at most 1 second (full jitter: random * base * 2^0 = random * 1s)", async () => {
    vi.useFakeTimers();

    fakeWs.emit("close");
    vi.advanceTimersByTime(1001);
    expect(wsFactory).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("delay cap doubles with each attempt (exponential backoff)", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const ws2 = new FakeWs();
    wsFactory.mockReturnValueOnce(ws2);

    // Attempt 0: delay = 0.5 * min(300000, 1000) = 500ms
    fakeWs.emit("close", 1006, Buffer.from(""));
    vi.advanceTimersByTime(499);
    expect(wsFactory).toHaveBeenCalledTimes(1); // not yet at 499ms

    vi.advanceTimersByTime(2);
    expect(wsFactory).toHaveBeenCalledTimes(2); // fired at 500ms

    // Attempt 1: delay = 0.5 * min(300000, 2000) = 1000ms (double)
    ws2.emit("close", 1006, Buffer.from(""));
    vi.advanceTimersByTime(999);
    expect(wsFactory).toHaveBeenCalledTimes(2); // not yet at 999ms

    vi.advanceTimersByTime(2);
    expect(wsFactory).toHaveBeenCalledTimes(3); // fired at 1000ms

    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reconnect delay is capped at maxReconnectDelayMs", async () => {
    vi.useFakeTimers();
    // With random=0.9 and cap=300000ms, uncapped delay at attempt 9+ would exceed 460800ms;
    // capped delay is 270000ms.
    vi.spyOn(Math, "random").mockReturnValue(0.9);

    // Use a dedicated factory so each connect() gets a fresh WS (avoids stale-handler issues)
    const capFactory = vi.fn().mockImplementation(() => new FakeWs());
    const cappedSb = new AgentStatus({ agentId: AGENT_ID });
    const cappedSession = new WorkerController(
      cappedSb,
      display,
      undefined,
      undefined,
      "owner/repo",
      { wsFactory: capFactory },
    );
    await cappedSession.start();
    expect(capFactory).toHaveBeenCalledTimes(1);

    // Simulate 12 disconnects. With random=0.9 and cap=300000ms, delay at attempt 9+ is
    // 0.9*300000=270000ms. Without cap, attempt 9 would need 0.9*512000=460800ms.
    // Every attempt fires within 270001ms — proving the cap works.
    for (let i = 0; i < 12; i++) {
      const latestWs = capFactory.mock.results.at(-1)!.value as FakeWs;
      latestWs.emit("close", 1006, Buffer.from(""));
      vi.advanceTimersByTime(270001); // > 0.9 * cap (270000ms)
      expect(capFactory).toHaveBeenCalledTimes(i + 2);
    }

    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reconnect attempt counter resets to 0 after successful hello_ack", async () => {
    vi.useFakeTimers();
    // random=0.5 so delay = 0.5 * min(cap, base*2^attempt)
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const ws2 = new FakeWs();
    const ws3 = new FakeWs();
    wsFactory.mockReturnValueOnce(ws2).mockReturnValueOnce(ws3);

    // First disconnect (attempt 0 → delay = 0.5 * 1000 = 500ms)
    fakeWs.emit("close", 1006, Buffer.from(""));
    vi.advanceTimersByTime(501);
    expect(wsFactory).toHaveBeenCalledTimes(2);

    // Simulate successful reconnect — hello_ack resets attempts to 0
    sendMsg(ws2, { type: "hello_ack", status: "ready" });

    // Now disconnect again — should use attempt 0 delay (500ms), not attempt 1 (1000ms)
    ws2.emit("close", 1006, Buffer.from(""));
    vi.advanceTimersByTime(499);
    expect(wsFactory).toHaveBeenCalledTimes(2); // not yet at 499ms (500ms after reset)

    vi.advanceTimersByTime(2);
    expect(wsFactory).toHaveBeenCalledTimes(3); // fired at ~500ms, not 1000ms

    vi.restoreAllMocks();
    vi.useRealTimers();
  });
});

// ── /worker:reconnect command ─────────────────────────────────────────────────

describe("/worker:reconnect command", () => {
  function registerAndGetHandler(): (args: string) => Promise<unknown> {
    const handlers: Record<string, (args: string) => Promise<unknown>> = {};
    const registry = {
      register: (name: string, def: { handler: (args: string) => Promise<unknown> }) => {
        handlers[name] = def.handler;
      },
    } as unknown as import("../src/agent/controllers/command-controller.js").CommandRegistry;
    session.registerCommands(registry);
    return handlers["reconnect"]!;
  }

  it("prints an amber message when worker mode is not active", async () => {
    await session.stop();
    const handler = registerAndGetHandler();
    display.print.mockClear();
    await handler("");
    const printed = display.print.mock.calls.map(args => stripAnsi(String(args[0]))).join("\n");
    expect(printed).toContain("not active");
  });

  it("cancels a pending backoff timer and reconnects immediately without advancing time", async () => {
    vi.useFakeTimers();
    try {
      // Disconnect to start the backoff timer
      fakeWs.emit("close", 1006, Buffer.from(""));
      expect(wsFactory).toHaveBeenCalledTimes(1); // timer pending, not yet fired

      const newWs = new FakeWs();
      wsFactory.mockReturnValueOnce(newWs);

      const handler = registerAndGetHandler();
      await handler(""); // should connect immediately, no timer advance needed

      expect(wsFactory).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates an existing open connection before reconnecting", async () => {
    vi.useFakeTimers();
    try {
      const newWs = new FakeWs();
      wsFactory.mockReturnValueOnce(newWs);

      const handler = registerAndGetHandler();
      await handler("");

      expect(fakeWs.terminate).toHaveBeenCalledOnce();
      expect(wsFactory).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets reconnect attempt counter so the next backoff uses attempt 0 delay", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      // Build up backoff: disconnect twice to reach attempt 1 (1000ms delay)
      const ws2 = new FakeWs();
      wsFactory.mockReturnValueOnce(ws2);
      fakeWs.emit("close", 1006, Buffer.from(""));
      vi.advanceTimersByTime(501); // attempt 0 fires at ~500ms
      expect(wsFactory).toHaveBeenCalledTimes(2);

      // ws2 closes — attempt 1 timer (1000ms) is now pending
      ws2.emit("close", 1006, Buffer.from(""));

      // Force reconnect — should fire immediately and reset the counter
      const ws3 = new FakeWs();
      wsFactory.mockReturnValueOnce(ws3);
      const handler = registerAndGetHandler();
      await handler("");
      expect(wsFactory).toHaveBeenCalledTimes(3); // immediate

      // ws3 closes — should use attempt 0 delay (~500ms), not attempt 2 (2000ms)
      const ws4 = new FakeWs();
      wsFactory.mockReturnValueOnce(ws4);
      ws3.emit("close", 1006, Buffer.from(""));
      vi.advanceTimersByTime(499);
      expect(wsFactory).toHaveBeenCalledTimes(3); // not yet at 499ms
      vi.advanceTimersByTime(2);
      expect(wsFactory).toHaveBeenCalledTimes(4); // fires at ~500ms, not 2000ms
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("stale close from the old ws after forceReconnect does not schedule another reconnect", async () => {
    vi.useFakeTimers();
    try {
      const newWs = new FakeWs();
      wsFactory.mockReturnValueOnce(newWs);

      const handler = registerAndGetHandler();
      await handler("");

      // newWs is the active connection now; advancing time should not trigger another connect
      vi.advanceTimersByTime(10_000);
      expect(wsFactory).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prints a green Reconnecting message", async () => {
    const handler = registerAndGetHandler();
    wsFactory.mockReturnValueOnce(new FakeWs());
    display.print.mockClear();
    await handler("");
    const printed = display.print.mock.calls.map(args => stripAnsi(String(args[0]))).join("\n");
    expect(printed).toMatch(/[Rr]econnect/);
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
    expect(fmtStatus(sb)).toContain("Disconnected");
    vi.useRealTimers();
  });

  it("shows Handshaking... in status text after open (pre-hello_ack)", () => {
    fakeWs.emit("open");
    expect(fmtStatus(sb)).toContain("Handshaking...");
  });

  it("shows Connected in status text after hello_ack", () => {
    fakeWs.emit("open");
    sendMsg(fakeWs, { type: "hello_ack", status: "ready" });
    expect(fmtStatus(sb)).toContain("Connected");
  });

  it("shows Reconnecting in status text on initial connect", () => {
    expect(fmtStatus(sb)).toContain("Reconnecting");
  });

  it("registers a tool result callback on start()", () => {
    expect(sb.setOnToolResult).toHaveBeenCalledOnce();
    expect(typeof (sb.setOnToolResult as ReturnType<typeof vi.spyOn>).mock.calls[0][0]).toBe("function");
  });

  it("tool result callback refreshes branch on Bash tool", async () => {
    const cb = (sb.setOnToolResult as ReturnType<typeof vi.spyOn>).mock.calls[0][0] as (toolName: string) => void;
    (sb.update as ReturnType<typeof vi.spyOn>).mockClear();
    cb("Bash");
    // refreshBranch() is async; wait for it to call agentStatus.update({ branch: ... }).
    // vi.waitFor only retries on throw, so use expect() inside to get retry-on-failure.
    await vi.waitFor(() => {
      expect((sb.update as ReturnType<typeof vi.spyOn>).mock.calls.some(([p]) => "branch" in p)).toBe(true);
    });
  });

  it("tool result callback does not refresh branch for non-Bash tools", async () => {
    const cb = (sb.setOnToolResult as ReturnType<typeof vi.spyOn>).mock.calls[0][0] as (toolName: string) => void;
    // Wait for startup refreshBranch() to settle (async from start()).
    // vi.waitFor only retries on throw, so use expect() inside to get retry-on-failure.
    await vi.waitFor(() => {
      expect((sb.update as ReturnType<typeof vi.spyOn>).mock.calls.some(([p]) => "branch" in p)).toBe(true);
    });
    // Count branch calls before cb("Read") — startup activity has now settled
    const countBranchCalls = () =>
      (sb.update as ReturnType<typeof vi.spyOn>).mock.calls.filter(([p]) => "branch" in p).length;
    const before = countBranchCalls();
    cb("Read");
    // Give a tick for any potential async work
    await new Promise((r) => setTimeout(r, 10));
    // Verify cb("Read") did not trigger any additional branch updates
    expect(countBranchCalls()).toBe(before);
  });

  it("updates connection status to handshaking after open", () => {
    (sb.update as ReturnType<typeof vi.spyOn>).mockClear();
    fakeWs.emit("open");
    expect(sb.update).toHaveBeenCalledWith(expect.objectContaining({ connectionStatus: "handshaking" }));
  });

  it("shows Reconnecting in status text when connect() is called after disconnect", () => {
    vi.useFakeTimers();
    fakeWs.emit("open");
    fakeWs.emit("close", 1006, Buffer.from(""));
    // After close we are Disconnected; the timer hasn't fired yet.
    expect(fmtStatus(sb)).toContain("Disconnected");
    // Advance time past the reconnect delay to trigger connect().
    vi.advanceTimersByTime(6000);
    // connect() should have been called (wsFactory called a second time) and
    // the status should now show Reconnecting before the new socket opens.
    expect(wsFactory).toHaveBeenCalledTimes(2);
    expect(fmtStatus(sb)).toContain("Reconnecting");
    vi.useRealTimers();
  });

  it("disconnect code is stored on close and shown in Reconnecting... state (verbose)", () => {
    vi.useFakeTimers();
    fakeWs.emit("open");
    fakeWs.emit("close", 1006, Buffer.from(""));
    // After close we are Disconnected; the timer hasn't fired yet.
    expect(fmtStatus(sb)).toContain("Disconnected");
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
    const text = fmtStatus(sb);
    expect(text).toContain(`worker ${AGENT_ID.slice(0, 8)}`);
  });

  it("shows no current task when no task assigned", () => {
    const text = fmtStatus(sb);
    expect(text).toContain("no current task");
  });

  it("shows task number after task_assigned", () => {
    const issue = makeIssue(42);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t42", issue });
    const text = fmtStatus(sb);
    expect(text).toContain("task #42");
  });

  it("shows PR number after pull_request event", () => {
    const issue = makeIssue(1);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });

    const prEvent: Wire.WebhookEvent = {
      id: "pr-evt",
      name: "pull_request",
      payload: { action: "opened", pull_request: { number: 99, title: "My PR" } },
    };
    sendMsg(fakeWs, { type: "event_notification", taskId: "t1", event: prEvent });
    const text = fmtStatus(sb);
    expect(text).toContain("PR #99");
  });

  it("resets PR number when new task is assigned", async () => {
    const issue1 = makeIssue(1);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue: issue1 });

    // Set PR number
    const prEvent: Wire.WebhookEvent = {
      id: "pr-evt",
      name: "pull_request",
      payload: { action: "opened", pull_request: { number: 55, title: "PR" } },
    };
    sendMsg(fakeWs, { type: "event_notification", taskId: "t1", event: prEvent });
    expect(fmtStatus(sb)).toContain("PR #55");

    // Complete task and assign new task
    session.takeNextPrompt();
    await session.completeCurrentTask();
    const issue2 = makeIssue(2);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t2", issue: issue2 });

    expect(fmtStatus(sb)).not.toContain("PR #");
  });

  it("shows PR number in status bar when task_assigned carries a prNumber", () => {
    const issue = { ...makeIssue(3), prNumber: 123 };
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t3", issue });
    expect(fmtStatus(sb)).toContain("PR #123");
  });

  it("shows no PR number when task_assigned has no prNumber", () => {
    const issue = makeIssue(4);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t4", issue });
    expect(fmtStatus(sb)).not.toContain("PR #");
  });

  it("clears PR number from status bar when pull_request/closed without merging is received", () => {
    const issue = makeIssue(1);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });

    // First set the PR number via opened event
    const prOpenedEvent: Wire.WebhookEvent = {
      id: "pr-opened",
      name: "pull_request",
      payload: { action: "opened", pull_request: { number: 77, merged: false } },
    };
    sendMsg(fakeWs, { type: "event_notification", taskId: "t1", event: prOpenedEvent });
    expect(fmtStatus(sb)).toContain("PR #77");

    // Now close the PR without merging
    const prClosedEvent: Wire.WebhookEvent = {
      id: "pr-closed",
      name: "pull_request",
      payload: { action: "closed", pull_request: { number: 77, merged: false } },
    };
    sendMsg(fakeWs, { type: "event_notification", taskId: "t1", event: prClosedEvent });
    expect(fmtStatus(sb)).not.toContain("PR #");
  });

  it("keeps PR number in status bar when pull_request/closed with merge is received", () => {
    const issue = makeIssue(1);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });

    const prOpenedEvent: Wire.WebhookEvent = {
      id: "pr-opened",
      name: "pull_request",
      payload: { action: "opened", pull_request: { number: 88, merged: false } },
    };
    sendMsg(fakeWs, { type: "event_notification", taskId: "t1", event: prOpenedEvent });
    expect(fmtStatus(sb)).toContain("PR #88");

    // Close via merge — PR should stay shown until task completes
    const prMergedEvent: Wire.WebhookEvent = {
      id: "pr-merged",
      name: "pull_request",
      payload: { action: "closed", pull_request: { number: 88, merged: true } },
    };
    sendMsg(fakeWs, { type: "event_notification", taskId: "t1", event: prMergedEvent });
    expect(fmtStatus(sb)).toContain("PR #88");
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

      // Open event → hello_sent state (hello is sent here)
      newWs.emit("open");
      newWs.send.mockClear();

      // Try to send task_complete — should be buffered (hello_ack not yet received)
      await session.completeCurrentTask();
      expect(newWs.send).not.toHaveBeenCalled();

      // Send hello_ack → buffer should be flushed
      sendMsg(newWs, { type: "hello_ack", workerId: AGENT_ID, status: "assigned" });
      expect(newWs.send).toHaveBeenCalledOnce();
      const sent = JSON.parse(newWs.send.mock.calls[0][0]);
      expect(sent).toEqual({ type: "task_complete", workerId: AGENT_ID, taskId: "42", nextState: "reserved" });
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
      newWs.send.mockClear();

      // Buffer a task_complete
      await session.completeCurrentTask();
      expect(newWs.send).not.toHaveBeenCalled();

      // Send hello_ack cancelled → buffer discarded, task state cleared
      sendMsg(newWs, { type: "hello_ack", workerId: AGENT_ID, status: "cancelled" });
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
      sendMsg(newWs, { type: "hello_ack", workerId: AGENT_ID, status: "cancelled" });

      const printed = display.print.mock.calls.map(args => stripAnsi(String(args[0]))).join("\n");
      expect(printed).toContain("cancelled");
      expect(printed).not.toContain("Workspace reset");
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("calls workspace.reset() on hello_ack cancelled when workspace is set", async () => {
    vi.useFakeTimers();
    const chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => {});
    try {
      const workspace = {
        dir: "/tmp/test-workspace",
        workspaceDir: "/tmp/workers",
        sessionId: "test-agent",
        originalCwd: "/original",
        isCreated: true,
        on: vi.fn(),
        create: vi.fn().mockResolvedValue(undefined),
        confirm: vi.fn(),
        reset: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn().mockResolvedValue(undefined),
        checkSafety: vi.fn().mockResolvedValue({ uncommittedFiles: [], unpushedCommits: [], noUpstream: false }),
      } as unknown as import("../src/agent/models/workspace.js").Workspace;

      const wsA = new FakeWs();
      const wsB = new FakeWs();
      let callCount = 0;
      const wsFactoryWs = vi.fn().mockImplementation(() => callCount++ === 0 ? wsA : wsB);

      const wc = new WorkspaceController(workspace, display, { verbose: false });
      const sessionWithWs = new WorkerController(sb, display, undefined, wc, "", { wsFactory: wsFactoryWs });
      await sessionWithWs.start(); // uses wsA

      const issue = makeIssue();
      sendMsg(wsA, { type: "task_assigned", taskId: "42", issue });
      sessionWithWs.takeNextPrompt();

      // Simulate reconnect: wsA closes, wsB is created
      vi.spyOn(Math, "random").mockReturnValue(0);
      wsA.emit("close", 1006, Buffer.from(""));
      vi.advanceTimersByTime(2001);
      // wsB is now the active connection
      wsB.emit("open");

      sendMsg(wsB, { type: "hello_ack", workerId: AGENT_ID, status: "cancelled" });

      await vi.waitFor(() => expect(workspace.reset).toHaveBeenCalledOnce());
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("defers task_assigned prompt until workspace reset completes on hello_ack cancelled", async () => {
    vi.useFakeTimers();
    const chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => {});
    try {
      let resolveReset!: () => void;
      const resetPromise = new Promise<void>((resolve) => { resolveReset = resolve; });
      const workspace = {
        dir: "/tmp/test-workspace",
        workspaceDir: "/tmp/workers",
        sessionId: "test-agent",
        originalCwd: "/original",
        isCreated: true,
        on: vi.fn(),
        create: vi.fn().mockResolvedValue(undefined),
        confirm: vi.fn(),
        reset: vi.fn().mockReturnValue(resetPromise),
        destroy: vi.fn().mockResolvedValue(undefined),
        checkSafety: vi.fn().mockResolvedValue({ uncommittedFiles: [], unpushedCommits: [], noUpstream: false }),
      } as unknown as import("../src/agent/models/workspace.js").Workspace;

      const wsA = new FakeWs();
      const wsB = new FakeWs();
      let callCount = 0;
      const wsFactoryWs = vi.fn().mockImplementation(() => callCount++ === 0 ? wsA : wsB);

      const wc = new WorkspaceController(workspace, display, { verbose: false });
      const sessionWithWs = new WorkerController(sb, display, undefined, wc, "", { wsFactory: wsFactoryWs });
      await sessionWithWs.start();

      sendMsg(wsA, { type: "task_assigned", taskId: "42", issue: makeIssue() });
      sessionWithWs.takeNextPrompt();

      vi.spyOn(Math, "random").mockReturnValue(0);
      wsA.emit("close", 1006, Buffer.from(""));
      vi.advanceTimersByTime(2001);
      wsB.emit("open");
      sendMsg(wsB, { type: "hello_ack", workerId: AGENT_ID, status: "cancelled" });

      // Prompt for next task arrives while reset is still running
      sendMsg(wsB, { type: "task_assigned", taskId: "99", issue: makeIssue(2) });
      expect(sessionWithWs.hasPendingPrompts()).toBe(false); // deferred

      // Reset completes → prompt is now enqueued
      resolveReset();
      await vi.waitFor(() => expect(sessionWithWs.hasPendingPrompts()).toBe(true));
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
      sendMsg(newWs, { type: "hello_ack", workerId: AGENT_ID, status: "cancelled" });

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
      newWs.send.mockClear();

      await session.completeCurrentTask();
      expect(newWs.send).not.toHaveBeenCalled();

      // hello_ack idle — task was reverted on foreman side; but worker flushes anyway
      sendMsg(newWs, { type: "hello_ack", workerId: AGENT_ID, status: "ready" });
      expect(newWs.send).toHaveBeenCalledOnce();
      const sent = JSON.parse(newWs.send.mock.calls[0][0]);
      expect(sent.type).toBe("task_complete");
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("hello_ack is passed to display.printForemanMessage", () => {
    sendMsg(fakeWs, { type: "hello_ack", workerId: AGENT_ID, status: "ready" });
    expect(display.printForemanMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "hello_ack", workerId: AGENT_ID, status: "ready" })
    );
  });

  it("does not print 'Waiting for tasks...' when reconnecting in idle state", async () => {
    vi.useFakeTimers();
    try {
      // First: establish idle state via hello_ack ready on the initial connection
      sendMsg(fakeWs, { type: "hello_ack", workerId: AGENT_ID, status: "ready" });

      // Now reconnect while idle
      const newWs = reconnectWithNewWs();
      newWs.emit("open");

      display.print.mockClear();
      sendMsg(newWs, { type: "hello_ack", workerId: AGENT_ID, status: "ready" });

      const printed = display.print.mock.calls.map(args => stripAnsi(String(args[0]))).join("\n");
      expect(printed).not.toContain("Waiting for tasks");
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("does not print 'Waiting for tasks...' when reconnecting after post-task wait selection", async () => {
    vi.useFakeTimers();
    try {
      // Assign and complete a task, then select "wait for next task" (which calls sendWorkerReady)
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      session.takeNextPrompt();
      await session.completeCurrentTask("reserved");
      session.sendWorkerReady();

      // Now reconnect — worker is in idle state waiting for a task
      const newWs = reconnectWithNewWs();
      newWs.emit("open");

      display.print.mockClear();
      sendMsg(newWs, { type: "hello_ack", workerId: AGENT_ID, status: "ready" });

      const printed = display.print.mock.calls.map(args => stripAnsi(String(args[0]))).join("\n");
      expect(printed).not.toContain("Waiting for tasks");
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
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

  it("log_only event does not emit 'prompts_ready'", async () => {
    const onPromptsReady = vi.fn();
    session.on("prompts_ready", onPromptsReady);
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: { id: "e1", name: "check_run", payload: { action: "completed" } } });
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(onPromptsReady).not.toHaveBeenCalled();
  });

  it("issue_comment from railway-bot is silently dropped (log_only)", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      session.takeNextPrompt();

      const body = "<!-- railway-bot-comment-version=2 -->\n🚅 Deployed to production";
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: {
        id: "e1",
        name: "issue_comment",
        payload: { action: "created", comment: { body } },
      }});
      await vi.runAllTimersAsync();

      expect(session.hasPendingPrompts()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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

// ── event-type-specific debounce timers ───────────────────────────────────────

describe("event-type-specific debounce timers", () => {
  it("check_suite success uses 30s debounce instead of 3s", async () => {
    vi.useFakeTimers();
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
      session.takeNextPrompt();

      const csEvt: Wire.WebhookEvent = { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success" } } };
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

      const csEvt: Wire.WebhookEvent = { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "failure" } } };
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

      const prEvt: Wire.WebhookEvent = { id: "e1", name: "pull_request", payload: { action: "closed", pull_request: { number: 1 } } };
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
      const successEvt: Wire.WebhookEvent = { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success" } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: successEvt });

      // Advance 3s — still waiting (30s timer)
      await vi.advanceTimersByTimeAsync(3001);
      expect(session.hasPendingPrompts()).toBe(false);

      // Failure arrives — resets timer to 3s
      const failEvt: Wire.WebhookEvent = { id: "e2", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "failure" } } };
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
      const closedEvt: Wire.WebhookEvent = { id: "e1", name: "pull_request", payload: { action: "closed", pull_request: { number: 1 } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: closedEvt });
      await vi.runAllTimersAsync();
      expect(session.hasPendingPrompts()).toBe(true);
      session.takeNextPrompt(); // consume PR closed prompt

      // check_suite event should be silently dropped (prIsClosed = true)
      const csEvt: Wire.WebhookEvent = { id: "e2", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success" } } };
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
      const closedEvt: Wire.WebhookEvent = { id: "e1", name: "pull_request", payload: { action: "closed", pull_request: { number: 1 } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: closedEvt });
      await vi.runAllTimersAsync();
      session.takeNextPrompt(); // consume

      // New task assigned — resets prIsClosed
      sendMsg(fakeWs, { type: "task_assigned", taskId: "99", issue: makeIssue(2) });
      session.takeNextPrompt(); // consume new task prompt

      // check_suite event should now work normally (not dropped)
      const csEvt: Wire.WebhookEvent = { id: "e2", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success" } } };
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
      const closedEvt: Wire.WebhookEvent = { id: "e1", name: "pull_request", payload: { action: "closed", pull_request: { number: 1 } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: closedEvt });
      await vi.runAllTimersAsync();
      session.takeNextPrompt(); // consume

      // issue_comment/created should NOT be dropped — still actionable after PR closed
      const commentEvt: Wire.WebhookEvent = { id: "e2", name: "issue_comment", payload: { action: "created" } };
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
      const csEvt: Wire.WebhookEvent = { id: "e3", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success" } } };
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: csEvt });
      await vi.runAllTimersAsync();
      expect(session.hasPendingPrompts()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── stop() with active task ───────────────────────────────────────────────────

describe("stop() with active task", () => {
  it("remains active if user cancels the quit confirmation", async () => {
    const ws = new FakeWs();
    const s = new WorkerController(sb, display, makeMockPicker(async () => 0), undefined, "owner/repo", {
      wsFactory: vi.fn().mockReturnValue(ws),
    }); // first option = "No, keep working" = cancel
    await s.start();
    sendMsg(ws, { type: "hello_ack", workerId: AGENT_ID, status: "ready" });
    sendMsg(ws, { type: "task_assigned", taskId: "99", issue: makeIssue() });
    s.takeNextPrompt();

    await s.stop();

    expect(s.isActive).toBe(true);
    expect(s.hasTask()).toBe(true);
  });

  it("stops and marks inactive if user confirms quit", async () => {
    const ws = new FakeWs();
    const s = new WorkerController(sb, display, makeMockPicker(async () => 1), undefined, "owner/repo", {
      wsFactory: vi.fn().mockReturnValue(ws),
    }); // second option = "Yes, quit anyway" = quit
    await s.start();
    sendMsg(ws, { type: "hello_ack", workerId: AGENT_ID, status: "ready" });
    sendMsg(ws, { type: "task_assigned", taskId: "99", issue: makeIssue() });
    s.takeNextPrompt();

    await s.stop();

    expect(s.isActive).toBe(false);
  });
});

import { Workspace } from "../src/agent/models/workspace.js";
import { WorkspaceController } from "../src/agent/controllers/workspace-controller.js";
import { CommandRegistry } from "../src/agent/controllers/command-controller.js";
import type { TaskConfirmInfo } from "../src/agent/controllers/worker-controller.js";
// ── foreman_error ─────────────────────────────────────────────────────────────

describe("foreman_error", () => {
  it("non-fatal: calls printForemanMessage and does not queue a prompt", () => {
    sendMsg(fakeWs, { type: "foreman_error", message: "Something went wrong", fatal: false });
    expect(display.printForemanMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "foreman_error", message: "Something went wrong", fatal: false })
    );
    expect(session.hasPendingPrompts()).toBe(false);
  });

  it("non-fatal: does not stop reconnecting (close still triggers reconnect)", async () => {
    vi.useFakeTimers();
    try {
      sendMsg(fakeWs, { type: "foreman_error", message: "Transient error", fatal: false });
      fakeWs.emit("close", 1006, Buffer.from(""));
      vi.advanceTimersByTime(6000);
      // A new connection should have been made
      expect(wsFactory).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fatal: emits 'fatal' event", () => {
    const onFatal = vi.fn();
    session.on("fatal", onFatal);
    sendMsg(fakeWs, { type: "foreman_error", message: "Catastrophic failure", fatal: true });
    expect(onFatal).toHaveBeenCalledOnce();
  });

  it("fatal: does not reconnect after ws closes", async () => {
    vi.useFakeTimers();
    try {
      sendMsg(fakeWs, { type: "foreman_error", message: "Fatal error", fatal: true });
      // The fatal handler closes the ws, which triggers close event
      // Advance past any reconnect delay
      vi.advanceTimersByTime(10000);
      // Should NOT have created a second connection
      expect(wsFactory).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fatal: aborts any running query", () => {
    const ac = new AbortController();
    session.notifyQueryStart(ac);
    sendMsg(fakeWs, { type: "foreman_error", message: "Fatal error", fatal: true });
    expect(ac.signal.aborted).toBe(true);
    session.notifyQueryEnd(true);
  });

  it("fatal: calls printForemanMessage so the error is displayed", () => {
    sendMsg(fakeWs, { type: "foreman_error", message: "Critical failure", fatal: true });
    expect(display.printForemanMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "foreman_error", fatal: true })
    );
  });

  it("non-fatal: does not emit 'fatal' event", () => {
    const onFatal = vi.fn();
    session.on("fatal", onFatal);
    sendMsg(fakeWs, { type: "foreman_error", message: "Transient", fatal: false });
    expect(onFatal).not.toHaveBeenCalled();
  });

  it("fatal: sets connectionStatus to 'disconnected' after ws closes", () => {
    sendMsg(fakeWs, { type: "foreman_error", message: "Fatal error", fatal: true });
    // FakeWs.close() fires the close event synchronously; connectionStatus must be updated
    expect(sb.connectionStatus).toBe("disconnected");
  });

  it("fatal: sets isActive to false so the routing loop shows the REPL prompt", () => {
    sendMsg(fakeWs, { type: "foreman_error", message: "Fatal error", fatal: true });
    expect(session.isActive).toBe(false);
  });
});

// ── workspace slash commands via WorkerController ─────────────────────────────

describe("workspace slash commands in WorkerController", () => {
  let chdirSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => {}); });
  afterEach(() => { chdirSpy.mockRestore(); });

  function makeWorkspace(): Workspace {
    return {
      dir: "/tmp/test-workspace",
      workspaceDir: "/tmp/workers",
      sessionId: "test-agent-id",
      originalCwd: "/original",
      isCreated: true,
      on: vi.fn(),
      create: vi.fn().mockResolvedValue(undefined),
      confirm: vi.fn().mockResolvedValue(true),
      reset: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      checkSafety: vi.fn().mockResolvedValue({
        uncommittedFiles: [], unpushedCommits: [], noUpstream: false,
      }),
    } as unknown as Workspace;
  }

  it("/workspace:reset calls workspace.reset() when clean", async () => {
    const workspace = makeWorkspace();
    const wc = new WorkspaceController(workspace, display, { verbose: false });
    await new WorkerController(sb, display, undefined, wc, "", { wsFactory }).start();
    const wsReg1 = new CommandRegistry();
    wc.registerCommands(wsReg1.scoped("workspace"));
    await wsReg1.execute("workspace:reset", "");
    expect(workspace.reset).toHaveBeenCalledOnce();
  });

  it("/workspace:reset does not reset if user declines", async () => {
    const workspace = makeWorkspace();
    (workspace.checkSafety as ReturnType<typeof vi.fn>).mockResolvedValue({
      uncommittedFiles: ["M foo.ts"], unpushedCommits: [], noUpstream: false,
    });
    (workspace.confirm as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const wc = new WorkspaceController(workspace, display, { verbose: false });
    await new WorkerController(sb, display, undefined, wc, "", { wsFactory }).start();
    const wsReg2 = new CommandRegistry();
    wc.registerCommands(wsReg2.scoped("workspace"));
    await wsReg2.execute("workspace:reset", "");
    expect(workspace.reset).not.toHaveBeenCalled();
  });

  it("/workspace:remove calls destroy() when approved", async () => {
    try {
      const workspace = makeWorkspace();
      const wc = new WorkspaceController(workspace, display, { verbose: false });
      await new WorkerController(sb, display, undefined, wc, "", { wsFactory }).start();
      const wsReg3 = new CommandRegistry();
      wc.registerCommands(wsReg3.scoped("workspace"));
      await wsReg3.execute("workspace:remove", "");
      expect(workspace.destroy).toHaveBeenCalledOnce();
    } finally {
    }
  });

  it("/workspace:create prints 'already exists' when workspace is pre-created", async () => {
    const localDisplay = { print: vi.fn(), printForemanMessage: vi.fn() };
    const workspace = makeWorkspace();
    const wc = new WorkspaceController(workspace, localDisplay, { verbose: false });
    await new WorkerController(sb, display, undefined, wc, "", { wsFactory }).start();
    const wsReg4 = new CommandRegistry();
    wc.registerCommands(wsReg4.scoped("workspace"));
    await wsReg4.execute("workspace:create", "");
    const printed = localDisplay.print.mock.calls.map(([s]: [unknown]) => stripAnsi(String(s))).join("\n");
    expect(printed).toContain("Workspace already exists");
  });
});

// ── afterTask callback on /worker:complete ──────────────────────────────────────

describe("afterTask callback on /worker:complete", () => {
  it("calls afterTask after task_complete is sent", async () => {
    const afterTask = vi.fn().mockResolvedValue(undefined);
    const sessionWithAfterTask = new WorkerController(sb, display, makeMockPicker(async () => 0), undefined, "", { wsFactory, afterTask });
    await sessionWithAfterTask.start();

    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });
    sessionWithAfterTask.takeNextPrompt();

    await sessionWithAfterTask.completeCurrentTask();
    // task_complete is sent first (before afterTask runs)
    const firstMsg = JSON.parse(fakeWs.send.mock.calls[0][0]);
    expect(firstMsg.type).toBe("task_complete");
    // afterTask is called after the picker
    expect(afterTask).toHaveBeenCalledOnce();
  });

  it("sends task_complete even if afterTask throws (task must not get stuck on foreman)", async () => {
    const afterTask = vi.fn().mockRejectedValue(new Error("reset failed"));
    const sessionWithAfterTask = new WorkerController(sb, display, makeMockPicker(async () => 0), undefined, "", { wsFactory, afterTask });
    await sessionWithAfterTask.start();

    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });
    sessionWithAfterTask.takeNextPrompt();

    const sendCountBefore = fakeWs.send.mock.calls.length;
    await sessionWithAfterTask.completeCurrentTask();
    const taskCompleteSent = fakeWs.send.mock.calls
      .slice(sendCountBefore)
      .some(([data]: [string]) => JSON.parse(data).type === "task_complete");
    expect(taskCompleteSent).toBe(true);
  });

  it("sends task_complete normally with no afterTask", async () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });
    session.takeNextPrompt();
    await session.completeCurrentTask();
    const firstMsg = JSON.parse(fakeWs.send.mock.calls[0][0]);
    expect(firstMsg.type).toBe("task_complete");
  });

  it("claim flow: does NOT send task_complete when afterTask throws UserCancelledError", async () => {
    // In the claim (reserved) path, afterTask runs before task_complete so UCE can abort.
    const afterTask = vi.fn().mockRejectedValue(new UserCancelledError());
    const sessionWithAfterTask = new WorkerController(sb, display, undefined, undefined, "", { wsFactory, afterTask });
    await sessionWithAfterTask.start();

    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });
    sessionWithAfterTask.takeNextPrompt();

    const sendCountBefore = fakeWs.send.mock.calls.length;
    try { await sessionWithAfterTask.completeCurrentTask("reserved"); } catch { /* UserCancelledError expected */ }
    const taskCompleteSent = fakeWs.send.mock.calls
      .slice(sendCountBefore)
      .some(([data]: [string]) => JSON.parse(data).type === "task_complete");
    expect(taskCompleteSent).toBe(false);
  });

  it("ready flow: sends task_complete even when afterTask throws UserCancelledError", async () => {
    // In the default (ready) path, task_complete is sent before afterTask runs,
    // so UCE from afterTask cannot prevent task_complete from being sent.
    const afterTask = vi.fn().mockRejectedValue(new UserCancelledError());
    const sessionWithAfterTask = new WorkerController(sb, display, makeMockPicker(async () => 0), undefined, "", { wsFactory, afterTask });
    await sessionWithAfterTask.start();

    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });
    sessionWithAfterTask.takeNextPrompt();

    const sendCountBefore = fakeWs.send.mock.calls.length;
    await sessionWithAfterTask.completeCurrentTask(); // ready path: UCE handled gracefully
    const taskCompleteSent = fakeWs.send.mock.calls
      .slice(sendCountBefore)
      .some(([data]: [string]) => JSON.parse(data).type === "task_complete");
    expect(taskCompleteSent).toBe(true);
  });

  it("claim flow: preserves task state when afterTask throws UserCancelledError", async () => {
    // In the claim (reserved) path, UCE from afterTask prevents task_complete and keeps the task.
    const afterTask = vi.fn().mockRejectedValue(new UserCancelledError());
    const sessionWithAfterTask = new WorkerController(sb, display, undefined, undefined, "", { wsFactory, afterTask });
    await sessionWithAfterTask.start();

    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });
    sessionWithAfterTask.takeNextPrompt();

    try { await sessionWithAfterTask.completeCurrentTask("reserved"); } catch { /* UserCancelledError expected */ }
    expect(sessionWithAfterTask.hasTask()).toBe(true);
  });
});

// ── completeCurrentTask: post-completion prompt ───────────────────────────────

describe("completeCurrentTask: post-completion prompt", () => {
  async function makeSession(
    pickFn: (opts: string[]) => Promise<number | { type: "text"; text: string }>,
    extraOpts: Partial<WorkerControllerOptions> = {},
  ) {
    const ws = new FakeWs();
    const sess = new WorkerController(sb, display, makeMockPicker(pickFn), undefined, "owner/repo", {
      wsFactory: vi.fn().mockReturnValue(ws),
      ...extraOpts,
    });
    await sess.start();
    sendMsg(ws, { type: "task_assigned", taskId: "t-pick", issue: makeIssue(77) });
    sess.takeNextPrompt();
    return { sess, ws };
  }

  it("option 0 (wait for next task): stays active and returns 'task-complete'", async () => {
    const { sess } = await makeSession(async () => 0);
    const result = await sess.completeCurrentTask();
    expect(result).toBe("task-complete");
    expect(sess.isActive).toBe(true);
  });

  it("option 0 (wait for next task): prints 'Waiting for next task'", async () => {
    const { sess } = await makeSession(async () => 0);
    await sess.completeCurrentTask();
    const printed = display.print.mock.calls.map(([l]: [string]) => stripAnsi(l));
    expect(printed.some(l => l.includes("Waiting for next task"))).toBe(true);
  });

  it("option 2 (stop working): stops worker mode and returns 'task-complete'", async () => {
    const { sess } = await makeSession(async () => 2);
    const result = await sess.completeCurrentTask();
    expect(result).toBe("task-complete");
    expect(sess.isActive).toBe(false);
  });

  it("option 3 (exit): does NOT call afterTask (workspace will be destroyed)", async () => {
    const afterTask = vi.fn().mockResolvedValue(undefined);
    const { sess } = await makeSession(async () => 3, { afterTask });
    await sess.completeCurrentTask();
    expect(afterTask).not.toHaveBeenCalled();
  });

  it("option 3 (exit): stops worker mode and returns 'exit'", async () => {
    const { sess } = await makeSession(async () => 3);
    const result = await sess.completeCurrentTask();
    expect(result).toBe("exit");
    expect(sess.isActive).toBe(false);
  });

  it("picker is called with the four expected option labels", async () => {
    const mockPick = vi.fn().mockResolvedValue(0);
    const { sess } = await makeSession(mockPick);
    await sess.completeCurrentTask();
    expect(mockPick).toHaveBeenCalledWith([
      expect.stringContaining("Wait"),
      expect.stringContaining("Claim"),
      expect.stringContaining("Stop working"),
      expect.stringContaining("Exit"),
    ]);
  });

  it("sends task_complete with nextState: reserved so foreman does not auto-assign during picker", async () => {
    const { sess, ws } = await makeSession(async () => 0);
    ws.send.mockClear();
    await sess.completeCurrentTask();
    const msgs = ws.send.mock.calls.map(([s]: [string]) => JSON.parse(s));
    const complete = msgs.find((m: { type: string }) => m.type === "task_complete");
    expect(complete?.nextState).toBe("reserved");
  });

  it("option 0 (wait for next task): sends worker_ready to opt back into auto-assignment", async () => {
    const { sess, ws } = await makeSession(async () => 0);
    ws.send.mockClear();
    await sess.completeCurrentTask();
    const msgs = ws.send.mock.calls.map(([s]: [string]) => JSON.parse(s));
    expect(msgs.some((m: { type: string }) => m.type === "worker_ready")).toBe(true);
  });

  it("option 2 (stop working): does not send worker_ready", async () => {
    const { sess, ws } = await makeSession(async () => 2);
    ws.send.mockClear();
    await sess.completeCurrentTask();
    const msgs = ws.send.mock.calls.map(([s]: [string]) => JSON.parse(s));
    expect(msgs.some((m: { type: string }) => m.type === "worker_ready")).toBe(false);
  });

  it("claim option (text entry): sends claim_task with the entered task ID", async () => {
    const { sess, ws } = await makeSession(async () => ({ type: "text" as const, text: "task-123" }));
    ws.send.mockClear();
    await sess.completeCurrentTask();
    const msgs = ws.send.mock.calls.map(([s]: [string]) => JSON.parse(s));
    expect(msgs.some((m: { type: string; taskId?: string }) => m.type === "claim_task" && m.taskId === "task-123")).toBe(true);
  });

  it("claim option (text entry): worker remains active", async () => {
    const { sess } = await makeSession(async () => ({ type: "text" as const, text: "task-123" }));
    await sess.completeCurrentTask();
    expect(sess.isActive).toBe(true);
  });

  it("claim option (text entry): returns 'task-complete'", async () => {
    const { sess } = await makeSession(async () => ({ type: "text" as const, text: "task-123" }));
    const result = await sess.completeCurrentTask();
    expect(result).toBe("task-complete");
  });

  it("claim option (text entry): does not send worker_ready", async () => {
    const { sess, ws } = await makeSession(async () => ({ type: "text" as const, text: "task-123" }));
    ws.send.mockClear();
    await sess.completeCurrentTask();
    const msgs = ws.send.mock.calls.map(([s]: [string]) => JSON.parse(s));
    expect(msgs.some((m: { type: string }) => m.type === "worker_ready")).toBe(false);
  });

  it("option 0 (wait for next task): clears eventsPaused so status bar does not show 'Events paused'", async () => {
    const { sess } = await makeSession(async () => 0);
    sess.pauseEvents();
    expect(sess.eventsPaused).toBe(true);
    await sess.completeCurrentTask();
    expect(sess.eventsPaused).toBe(false);
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
    expect(sent).toEqual({ type: "worker_goodbye", workerId: AGENT_ID, taskId: "42" });
  });

  it("sends worker_goodbye with undefined taskId when no task is active", () => {
    fakeWs.send.mockClear();
    session.sendGoodbye();

    expect(fakeWs.send).toHaveBeenCalledOnce();
    const sent = JSON.parse(fakeWs.send.mock.calls[0][0]);
    expect(sent.type).toBe("worker_goodbye");
    expect(sent.workerId).toBe(AGENT_ID);
    expect(sent.taskId).toBeUndefined();
  });

  it("does not send when ws is not open", () => {
    fakeWs.readyState = 3; // CLOSED
    fakeWs.send.mockClear();
    session.sendGoodbye();
    expect(fakeWs.send).not.toHaveBeenCalled();
  });

  it("includes task_complete: true when opts.task_complete is true", async () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt();
    fakeWs.send.mockClear();
    session.sendGoodbye({ task_complete: true });
    const sent = JSON.parse(fakeWs.send.mock.calls[0][0]);
    expect(sent.task_complete).toBe(true);
    expect(sent.taskId).toBe("42");
  });

  it("includes stats in goodbye when provided", async () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt();
    fakeWs.send.mockClear();
    session.sendGoodbye({ task_complete: true, stats: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 } });
    const sent = JSON.parse(fakeWs.send.mock.calls[0][0]);
    expect(sent.stats).toEqual({ inputTokens: 100, outputTokens: 50, costUsd: 0.01 });
  });

  it("omits task_complete and stats when opts not provided", async () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt();
    fakeWs.send.mockClear();
    session.sendGoodbye();
    const sent = JSON.parse(fakeWs.send.mock.calls[0][0]);
    expect(sent.task_complete).toBeUndefined();
    expect(sent.stats).toBeUndefined();
  });
});

// ── stop — complete-and-quit ──────────────────────────────────────────────────

describe("stop — complete-and-quit", () => {
  it("sends worker_goodbye with task_complete: true instead of a separate task_complete message", async () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt();
    vi.spyOn(session, "confirmTaskQuit").mockResolvedValue("complete-and-quit");

    fakeWs.send.mockClear();
    await session.stop();

    const msgs = fakeWs.send.mock.calls.map(([d]: [string]) => JSON.parse(d));
    const goodbye = msgs.find((m: { type: string }) => m.type === "worker_goodbye");
    const taskComplete = msgs.find((m: { type: string }) => m.type === "task_complete");

    expect(goodbye).toBeDefined();
    expect(goodbye.task_complete).toBe(true);
    expect(goodbye.taskId).toBe("42");
    expect(taskComplete).toBeUndefined();
  });

  it("includes token stats in the goodbye when tokens were used", async () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt();
    sb.addQueryStats(1000, 500, 0.05);
    vi.spyOn(session, "confirmTaskQuit").mockResolvedValue("complete-and-quit");

    fakeWs.send.mockClear();
    await session.stop();

    const msgs = fakeWs.send.mock.calls.map(([d]: [string]) => JSON.parse(d));
    const goodbye = msgs.find((m: { type: string }) => m.type === "worker_goodbye");
    expect(goodbye.stats).toEqual({ inputTokens: 1000, outputTokens: 500, costUsd: 0.05 });
  });

  it("omits stats from goodbye when no tokens were used", async () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt();
    vi.spyOn(session, "confirmTaskQuit").mockResolvedValue("complete-and-quit");

    fakeWs.send.mockClear();
    await session.stop();

    const msgs = fakeWs.send.mock.calls.map(([d]: [string]) => JSON.parse(d));
    const goodbye = msgs.find((m: { type: string }) => m.type === "worker_goodbye");
    expect(goodbye.stats).toBeUndefined();
  });

  it("complete-and-quit: skips afterTask (workspace is about to be destroyed anyway)", async () => {
    // afterTask (workspace reset) is not called during complete-and-quit because
    // the workspace will be destroyed when the process exits — resetting first is wasteful.
    const afterTask = vi.fn().mockRejectedValue(new UserCancelledError());
    const s = new WorkerController(sb, display, undefined, undefined, "owner/repo", { wsFactory, afterTask });
    await s.start();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    s.takeNextPrompt();
    vi.spyOn(s, "confirmTaskQuit").mockResolvedValue("complete-and-quit");

    fakeWs.send.mockClear();
    await s.stop();

    const msgs = fakeWs.send.mock.calls.map(([d]: [string]) => JSON.parse(d));
    expect(msgs.find((m: { type: string }) => m.type === "worker_goodbye")).toBeDefined();
    expect(s.isActive).toBe(false);
    expect(afterTask).not.toHaveBeenCalled();
  });
});

// ── Heartbeat / ping-pong ──────────────────────────────────────────────────────

describe("heartbeat", () => {
  afterEach(() => { vi.useRealTimers(); });

  async function makeHeartbeatSession() {
    const ws = new FakeWs();
    const factory = vi.fn().mockReturnValue(ws);
    const hbSb = new AgentStatus({ agentId: AGENT_ID });
    const s = new WorkerController(hbSb, display, undefined, undefined, "", { wsFactory: factory });
    await s.start();
    return { ws, factory, s };
  }

  it("sends a ping after the interval when the socket is open", async () => {
    vi.useFakeTimers();
    const { ws } = await makeHeartbeatSession();
    ws.emit("open");
    sendMsg(ws, { type: "hello_ack", status: "ready" });

    expect(ws.ping).not.toHaveBeenCalled();
    vi.advanceTimersByTime(25000);
    expect(ws.ping).toHaveBeenCalledOnce();
  });

  it("keeps the connection alive when a pong is received before the next ping tick", async () => {
    vi.useFakeTimers();
    const { ws } = await makeHeartbeatSession();
    ws.emit("open");
    sendMsg(ws, { type: "hello_ack", status: "ready" });

    vi.advanceTimersByTime(25000); // first ping sent, isAlive set to false
    ws.emit("pong");               // pong received, isAlive reset to true
    vi.advanceTimersByTime(25000); // second tick: isAlive is true → keeps connection

    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it("keeps the connection alive when an incoming ping from the foreman resets liveness", async () => {
    vi.useFakeTimers();
    const { ws } = await makeHeartbeatSession();
    ws.emit("open");
    sendMsg(ws, { type: "hello_ack", status: "ready" });

    vi.advanceTimersByTime(25000); // first ping sent, isAlive set to false
    ws.emit("ping");               // foreman's heartbeat ping resets isAlive to true
    vi.advanceTimersByTime(25000); // second tick: isAlive is true → keeps connection

    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it("terminates the connection when no pong is received after a ping", async () => {
    vi.useFakeTimers();
    const { ws } = await makeHeartbeatSession();
    ws.emit("open");
    sendMsg(ws, { type: "hello_ack", status: "ready" });

    vi.advanceTimersByTime(25000); // first ping sent, isAlive set to false
    // no pong emitted
    vi.advanceTimersByTime(25000); // second tick: isAlive is false → terminate

    expect(ws.terminate).toHaveBeenCalledOnce();
  });

  it("shows Disconnected in status text after heartbeat timeout", async () => {
    vi.useFakeTimers();
    const { ws, s } = await makeHeartbeatSession();
    ws.emit("open");
    sendMsg(ws, { type: "hello_ack", status: "ready" });
    expect(fmtStatus(s.agentStatus)).toContain("Connected");

    vi.advanceTimersByTime(25000); // ping sent
    vi.advanceTimersByTime(25000); // no pong → terminate → close fires

    expect(fmtStatus(s.agentStatus)).toContain("Disconnected");
  });

  it("reconnects after heartbeat timeout", async () => {
    vi.useFakeTimers();
    const { ws, factory } = await makeHeartbeatSession();
    ws.emit("open");
    sendMsg(ws, { type: "hello_ack", status: "ready" });

    vi.advanceTimersByTime(25000); // ping sent
    vi.advanceTimersByTime(25000); // no pong → terminate
    vi.advanceTimersByTime(5000);  // reconnect delay

    expect(factory).toHaveBeenCalledTimes(2); // initial + one reconnect
  });

  it("resets the ping interval when a pong is received mid-cycle", async () => {
    vi.useFakeTimers();
    const { ws } = await makeHeartbeatSession();
    ws.emit("open");
    sendMsg(ws, { type: "hello_ack", status: "ready" });

    vi.advanceTimersByTime(25000); // first ping sent
    expect(ws.ping).toHaveBeenCalledOnce();

    ws.emit("pong");             // resets the timer
    ws.ping.mockClear();

    // Only 12500ms after reset — no ping should fire yet
    vi.advanceTimersByTime(12500);
    expect(ws.ping).not.toHaveBeenCalled();

    // Full interval after reset — now the next ping fires
    vi.advanceTimersByTime(12500);
    expect(ws.ping).toHaveBeenCalledOnce();
  });

  it("stops the ping timer when the socket closes", async () => {
    vi.useFakeTimers();
    const { ws } = await makeHeartbeatSession();
    ws.emit("open");
    sendMsg(ws, { type: "hello_ack", status: "ready" });

    vi.advanceTimersByTime(25000); // first ping sent

    // Socket closes normally before the second tick
    ws.emit("close", 1000, Buffer.from(""));
    ws.ping.mockClear();

    // Even after another interval, no more pings sent on the closed socket
    vi.advanceTimersByTime(25000);
    expect(ws.ping).not.toHaveBeenCalled();
  });
});

// ── getTaskConfirmInfo ────────────────────────────────────────────────────────

describe("getTaskConfirmInfo", () => {
  it("returns undefined when no task is assigned", () => {
    expect(session.getTaskConfirmInfo()).toBeUndefined();
  });

  it("returns task info with issueClosed=false when task is assigned", () => {
    const issue = makeIssue(7);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t7", issue });
    const info = session.getTaskConfirmInfo();
    expect(info).toEqual({ taskNumber: 7, workerId: AGENT_ID, issueClosed: false });
  });

  it("returns undefined after task is completed", async () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });
    session.takeNextPrompt();
    await session.completeCurrentTask();
    expect(session.getTaskConfirmInfo()).toBeUndefined();
  });

  it("returns issueClosed=true after issues/closed event is received", () => {
    const issue = makeIssue(5);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t5", issue });
    session.takeNextPrompt();

    const closedEvt: Wire.WebhookEvent = { id: "e1", name: "issues", payload: { action: "closed" } };
    sendMsg(fakeWs, { type: "event_notification", taskId: "t5", event: closedEvt });

    expect(session.getTaskConfirmInfo()?.issueClosed).toBe(true);
  });

  it("returns issueClosed=false after issues/reopened follows issues/closed", () => {
    const issue = makeIssue(5);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t5", issue });
    session.takeNextPrompt();

    sendMsg(fakeWs, { type: "event_notification", taskId: "t5", event: { id: "e1", name: "issues", payload: { action: "closed" } } });
    expect(session.getTaskConfirmInfo()?.issueClosed).toBe(true);

    sendMsg(fakeWs, { type: "event_notification", taskId: "t5", event: { id: "e2", name: "issues", payload: { action: "reopened" } } });
    expect(session.getTaskConfirmInfo()?.issueClosed).toBe(false);
  });

  it("resets issueClosed to false on new task_assigned", () => {
    const issue1 = makeIssue(1);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue: issue1 });
    session.takeNextPrompt();

    sendMsg(fakeWs, { type: "event_notification", taskId: "t1", event: { id: "e1", name: "issues", payload: { action: "closed" } } });
    expect(session.getTaskConfirmInfo()?.issueClosed).toBe(true);

    const issue2 = makeIssue(2);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t2", issue: issue2 });
    expect(session.getTaskConfirmInfo()?.issueClosed).toBe(false);
  });

  it("does not set issueClosed when issues/closed is for a different task", () => {
    const issue = makeIssue(5);
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t5", issue });
    session.takeNextPrompt();

    // Event for a different task — should be ignored entirely
    sendMsg(fakeWs, { type: "event_notification", taskId: "t99", event: { id: "e1", name: "issues", payload: { action: "closed" } } });
    expect(session.getTaskConfirmInfo()?.issueClosed).toBe(false);
  });

  it("returns issueClosed=true when task_assigned with status 'closed' (e.g. worker claims an already-closed task)", () => {
    const issue = makeIssue(6, "closed");
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t6", issue });
    expect(session.getTaskConfirmInfo()?.issueClosed).toBe(true);
  });
});

// ── confirmTaskQuit ───────────────────────────────────────────────────────────

describe("confirmTaskQuit", () => {
  const openTask: TaskConfirmInfo = { taskNumber: 42, workerId: "test-worker", issueClosed: false };
  const closedTask: TaskConfirmInfo = { taskNumber: 42, workerId: "test-worker", issueClosed: true };
  const noopAgentStatus = new AgentStatus({ agentId: "test" });
  const noopDisplay = { print: vi.fn(), printForemanMessage: vi.fn() };

  beforeEach(() => { noopDisplay.print.mockReset(); noopDisplay.printForemanMessage.mockReset(); });

  it("open issue: returns 'cancel' when user picks 'No, keep working' (index 0)", async () => {
    const mockPick = vi.fn().mockResolvedValue(0);
    const sess = new WorkerController(noopAgentStatus, noopDisplay, makeMockPicker(mockPick), undefined, "");
    const result = await sess.confirmTaskQuit(openTask);
    expect(result).toBe("cancel");
  });

  it("open issue: returns 'quit' when user picks 'Yes, quit anyway' (index 1)", async () => {
    const mockPick = vi.fn().mockResolvedValue(1);
    const sess = new WorkerController(noopAgentStatus, noopDisplay, makeMockPicker(mockPick), undefined, "");
    const result = await sess.confirmTaskQuit(openTask);
    expect(result).toBe("quit");
  });

  it("open issue: prompt mentions task number and worker id", async () => {
    const printAgentStatus = new AgentStatus({ agentId: "test" });
    const printDisplay = { print: vi.fn(), printForemanMessage: vi.fn() };
    const mockPick = vi.fn().mockResolvedValue(0);
    const sess = new WorkerController(printAgentStatus, printDisplay, makeMockPicker(mockPick), undefined, "");
    await sess.confirmTaskQuit(openTask);
    const printed = printDisplay.print.mock.calls.map(([s]: [unknown]) => stripAnsi(String(s))).join("\n");
    expect(printed).toContain("#42");
    expect(printed).toContain("test-worker");
  });

  it("closed issue: returns 'complete-and-quit' when user picks index 0 (yes, complete)", async () => {
    const mockPick = vi.fn().mockResolvedValue(0);
    const sess = new WorkerController(noopAgentStatus, noopDisplay, makeMockPicker(mockPick), undefined, "");
    const result = await sess.confirmTaskQuit(closedTask);
    expect(result).toBe("complete-and-quit");
  });

  it("closed issue: returns 'quit' when user picks index 1 (no, just exit)", async () => {
    const mockPick = vi.fn().mockResolvedValue(1);
    const sess = new WorkerController(noopAgentStatus, noopDisplay, makeMockPicker(mockPick), undefined, "");
    const result = await sess.confirmTaskQuit(closedTask);
    expect(result).toBe("quit");
  });

  it("closed issue: returns 'cancel' when user picks index 2 (don't exit)", async () => {
    const mockPick = vi.fn().mockResolvedValue(2);
    const sess = new WorkerController(noopAgentStatus, noopDisplay, makeMockPicker(mockPick), undefined, "");
    const result = await sess.confirmTaskQuit(closedTask);
    expect(result).toBe("cancel");
  });

  it("closed issue: prompt mentions task number", async () => {
    const printAgentStatus = new AgentStatus({ agentId: "test" });
    const printDisplay = { print: vi.fn(), printForemanMessage: vi.fn() };
    const mockPick = vi.fn().mockResolvedValue(0);
    const sess = new WorkerController(printAgentStatus, printDisplay, makeMockPicker(mockPick), undefined, "");
    await sess.confirmTaskQuit(closedTask);
    const printed = printDisplay.print.mock.calls.map(([s]: [unknown]) => stripAnsi(String(s))).join("\n");
    expect(printed).toContain("#42");
  });

  it("open issue: pick is called with two options (No first, Yes second)", async () => {
    const mockPick = vi.fn().mockResolvedValue(0);
    const sess = new WorkerController(noopAgentStatus, noopDisplay, makeMockPicker(mockPick), undefined, "");
    await sess.confirmTaskQuit(openTask);
    expect(mockPick).toHaveBeenCalledOnce();
    const options = mockPick.mock.calls[0][0] as string[];
    expect(options).toHaveLength(2);
    expect(options[0].toLowerCase()).toContain("no");
    expect(options[1].toLowerCase()).toContain("yes");
  });

  it("closed issue: pick is called with three options", async () => {
    const mockPick = vi.fn().mockResolvedValue(0);
    const sess = new WorkerController(noopAgentStatus, noopDisplay, makeMockPicker(mockPick), undefined, "");
    await sess.confirmTaskQuit(closedTask);
    expect(mockPick).toHaveBeenCalledOnce();
    const options = mockPick.mock.calls[0][0] as string[];
    expect(options).toHaveLength(3);
  });
});

// ── hasTask ───────────────────────────────────────────────────────────────────

describe("hasTask", () => {
  it("returns false when no task is assigned", () => {
    expect(session.hasTask()).toBe(false);
  });

  it("returns true after task_assigned", () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    expect(session.hasTask()).toBe(true);
  });

  it("returns false after completeCurrentTask", async () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    expect(session.hasTask()).toBe(true);
    await session.completeCurrentTask();
    expect(session.hasTask()).toBe(false);
  });
});

// ── Repo activation flow ───────────────────────────────────────────────────────

describe("repo activation flow", () => {
  async function makeSessionWithPick(pickFn: (opts: string[]) => Promise<number>, repo = "owner/myrepo") {
    const ws = new FakeWs();
    const factory = vi.fn().mockReturnValue(ws);
    const sessAg = new AgentStatus({ agentId: AGENT_ID });
    const disp = { print: vi.fn(), printForemanMessage: vi.fn() };
    const sess = new WorkerController(sessAg, disp, makeMockPicker(pickFn), undefined, repo, { wsFactory: factory });
    await sess.start();
    return { sess, ws, disp };
  }

  it("when repoStatus is 'new', shows activation prompt before transitioning", async () => {
    const pickFn = vi.fn().mockResolvedValue(0); // "Yes, activate"
    const { sess, ws } = await makeSessionWithPick(pickFn);
    sendMsg(ws, { type: "hello_ack", workerId: AGENT_ID, status: "ready", repoStatus: "new" });
    await new Promise((r) => setTimeout(r, 10));
    expect(pickFn).toHaveBeenCalledWith(expect.arrayContaining(["Yes, activate", "No, skip"]));
  });

  it("when user confirms activation, sends activate_repo to the foreman", async () => {
    const pickFn = vi.fn().mockResolvedValue(0); // "Yes, activate"
    const { sess, ws } = await makeSessionWithPick(pickFn);
    sendMsg(ws, { type: "hello_ack", workerId: AGENT_ID, status: "ready", repoStatus: "new" });
    await new Promise((r) => setTimeout(r, 10));
    const sent = ws.send.mock.calls.map(([d]: [string]) => JSON.parse(d));
    const activateMsg = sent.find((m) => m.type === "activate_repo");
    expect(activateMsg).toBeDefined();
    expect(activateMsg.workerId).toBe(AGENT_ID);
  });

  it("when user confirms, does NOT yet transition to registered (waits for repo_activated)", async () => {
    const pickFn = vi.fn().mockResolvedValue(0); // "Yes, activate"
    const { sess, ws } = await makeSessionWithPick(pickFn);
    sendMsg(ws, { type: "hello_ack", workerId: AGENT_ID, status: "ready", repoStatus: "new" });
    // No task has been assigned — still no pending prompts
    expect(sess.hasPendingPrompts()).toBe(false); // no task prompt yet
  });

  it("when repo_activated is received, transitions to registered and can accept tasks", async () => {
    const pickFn = vi.fn().mockResolvedValue(0); // "Yes, activate"
    const { sess, ws } = await makeSessionWithPick(pickFn);
    sendMsg(ws, { type: "hello_ack", workerId: AGENT_ID, status: "ready", repoStatus: "new" });
    await new Promise((r) => setTimeout(r, 10));
    // Foreman responds with repo_activated
    sendMsg(ws, { type: "repo_activated", workerId: AGENT_ID });
    await new Promise((r) => setTimeout(r, 10));
    // Session is now registered — task_assigned should be enqueued
    sendMsg(ws, { type: "task_assigned", taskId: "77", issue: makeIssue(77) });
    expect(sess.hasPendingPrompts()).toBe(true);
  });

  it("when user declines activation, does not send activate_repo to the foreman", async () => {
    const pickFn = vi.fn().mockResolvedValue(1); // "No, skip"
    const { sess, ws } = await makeSessionWithPick(pickFn);
    sendMsg(ws, { type: "hello_ack", workerId: AGENT_ID, status: "ready", repoStatus: "new" });
    await new Promise((r) => setTimeout(r, 10));
    const sent = ws.send.mock.calls.map(([d]: [string]) => JSON.parse(d));
    const activateMsg = sent.find((m) => m.type === "activate_repo");
    expect(activateMsg).toBeUndefined();
  });

  it("when user declines activation, worker mode ends (isActive = false)", async () => {
    const pickFn = vi.fn().mockResolvedValue(1); // "No, skip"
    const { sess, ws } = await makeSessionWithPick(pickFn);
    sendMsg(ws, { type: "hello_ack", workerId: AGENT_ID, status: "ready", repoStatus: "new" });
    await new Promise((r) => setTimeout(r, 10));
    expect(sess.isActive).toBe(false);
  });

  it("when user declines activation, emits prompts_ready to wake the routing loop", async () => {
    const pickFn = vi.fn().mockResolvedValue(1); // "No, skip"
    const { sess, ws } = await makeSessionWithPick(pickFn);
    const onPromptsReady = vi.fn();
    sess.on("prompts_ready", onPromptsReady);
    sendMsg(ws, { type: "hello_ack", workerId: AGENT_ID, status: "ready", repoStatus: "new" });
    // stop() awaits refreshBranch() (a git command) before we emit, so wait longer
    await vi.waitFor(() => expect(onPromptsReady).toHaveBeenCalled(), { timeout: 2000 });
  });

  it("when repoStatus is 'active', transitions normally without showing activation prompt", async () => {
    const pickFn = vi.fn().mockResolvedValue(0);
    const { sess, ws } = await makeSessionWithPick(pickFn);
    sendMsg(ws, { type: "hello_ack", workerId: AGENT_ID, status: "ready", repoStatus: "active" });
    await new Promise((r) => setTimeout(r, 10));
    expect(pickFn).not.toHaveBeenCalled();
  });

  it("activation prompt includes the repo name from options", async () => {
    const pickFn = vi.fn().mockResolvedValue(0);
    const { disp, ws } = await makeSessionWithPick(pickFn, "acme/my-project");
    sendMsg(ws, { type: "hello_ack", workerId: AGENT_ID, status: "ready", repoStatus: "new" });
    await new Promise((r) => setTimeout(r, 10));
    const printedLines = disp.print.mock.calls.map(([l]: [string]) => l);
    expect(printedLines.some((l) => l.includes("acme/my-project"))).toBe(true);
  });

  it("emits prompts_ready after repo_activated so the main loop can re-start stdin listening", async () => {
    const pickFn = vi.fn().mockResolvedValue(0); // "Yes, activate"
    const { sess, ws } = await makeSessionWithPick(pickFn);
    sendMsg(ws, { type: "hello_ack", workerId: AGENT_ID, status: "ready", repoStatus: "new" });
    await new Promise((r) => setTimeout(r, 10));

    let emitted = false;
    sess.once("prompts_ready", () => { emitted = true; });

    sendMsg(ws, { type: "repo_activated", workerId: AGENT_ID });
    await new Promise((r) => setTimeout(r, 10));

    expect(emitted).toBe(true);
  });

});

// ── transitionToIdle — single entry for state 2 ───────────────────────────────

function makeSessionWithPickResult(pickResult: number): { s: WorkerController; ws: FakeWs } {
  const ws = new FakeWs();
  const localWsFactory = vi.fn().mockReturnValue(ws);
  const s = new WorkerController(sb, display, makeMockPicker(async () => pickResult), undefined, "owner/repo", {
    wsFactory: localWsFactory,
  });
  return { s, ws };
}

describe("transitionToIdle — Waiting for tasks message", () => {
  it("does NOT print 'Waiting for tasks...' on hello_ack ready (reconnect handshake is silent)", () => {
    display.print.mockClear();
    sendMsg(fakeWs, { type: "hello_ack", workerId: AGENT_ID, status: "ready" });
    const printed = display.print.mock.calls.map(([l]: [string]) => stripAnsi(l)).join("\n");
    expect(printed).not.toContain("Waiting for tasks");
  });

  it("does NOT print 'Waiting for tasks...' on hello_ack busy", () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    session.takeNextPrompt();
    display.print.mockClear();
    sendMsg(fakeWs, { type: "hello_ack", workerId: AGENT_ID, status: "assigned" });
    const printed = display.print.mock.calls.map(([l]: [string]) => stripAnsi(l)).join("\n");
    expect(printed).not.toContain("Waiting for tasks");
  });

  it("prints 'Waiting for tasks...' on hello_ack cancelled with no workspace", () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    session.takeNextPrompt();
    display.print.mockClear();
    sendMsg(fakeWs, { type: "hello_ack", workerId: AGENT_ID, status: "cancelled" });
    const printed = display.print.mock.calls.map(([l]: [string]) => stripAnsi(l)).join("\n");
    expect(printed).toContain("Waiting for tasks");
  });

  it("prints 'Waiting for tasks...' on repo_activated", async () => {
    const { s, ws } = makeSessionWithPickResult(0); // 0 = "Yes, activate"
    await s.start();
    ws.emit("open");
    sendMsg(ws, { type: "hello_ack", workerId: AGENT_ID, status: "ready", repoStatus: "new" });
    await new Promise(r => setTimeout(r, 0)); // let async pick resolve
    display.print.mockClear();
    sendMsg(ws, { type: "repo_activated", workerId: AGENT_ID });
    await new Promise(r => setTimeout(r, 0));
    const printed = display.print.mock.calls.map(([l]: [string]) => stripAnsi(l)).join("\n");
    expect(printed).toContain("Waiting for tasks");
  });

  it("does NOT print 'Waiting for tasks...' synchronously on hello_ack cancelled with workspace", async () => {
    let resolveReset!: () => void;
    const resetPromise = new Promise<void>((resolve) => { resolveReset = resolve; });
    const workspace = {
      isCreated: true,
      on: vi.fn(),
      create: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn().mockReturnValue(resetPromise),
    } as unknown as Workspace;
    const ws = new FakeWs();
    const wc = new WorkspaceController(workspace, display, { verbose: false });
    const s = new WorkerController(sb, display, undefined, wc, "owner/repo", {
      wsFactory: vi.fn().mockReturnValue(ws),
    });
    const chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => {});
    try {
      await s.start();
      sendMsg(ws, { type: "task_assigned", taskId: "42", issue: makeIssue() });
      s.takeNextPrompt();
      display.print.mockClear();
      sendMsg(ws, { type: "hello_ack", workerId: AGENT_ID, status: "cancelled" });
      const printed = display.print.mock.calls.map(([l]: [string]) => stripAnsi(l)).join("\n");
      expect(printed).not.toContain("Waiting for tasks");
    } finally {
      resolveReset();
      chdirSpy.mockRestore();
    }
  });

  it("prints 'Waiting for tasks...' after reset completes on hello_ack cancelled with workspace", async () => {
    let resolveReset!: () => void;
    const resetPromise = new Promise<void>((resolve) => { resolveReset = resolve; });
    const workspace = {
      isCreated: true,
      on: vi.fn(),
      create: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn().mockReturnValue(resetPromise),
    } as unknown as Workspace;
    const ws = new FakeWs();
    const wc = new WorkspaceController(workspace, display, { verbose: false });
    const s = new WorkerController(sb, display, undefined, wc, "owner/repo", {
      wsFactory: vi.fn().mockReturnValue(ws),
    });
    const chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => {});
    try {
      await s.start();
      sendMsg(ws, { type: "task_assigned", taskId: "42", issue: makeIssue() });
      s.takeNextPrompt();
      display.print.mockClear();
      sendMsg(ws, { type: "hello_ack", workerId: AGENT_ID, status: "cancelled" });
      resolveReset();
      await resetPromise;
      await new Promise(r => setTimeout(r, 0)); // flush .finally() microtask
      const printed = display.print.mock.calls.map(([l]: [string]) => stripAnsi(l)).join("\n");
      expect(printed).toContain("Waiting for tasks");
    } finally {
      chdirSpy.mockRestore();
    }
  });
});

// ── Event pause: notifyQueryEnd(aborted=true) ─────────────────────────────────

describe("event pause on ^C (notifyQueryEnd aborted=true)", () => {
  it("sets eventsPaused when aborted with pending events", () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt();
    const ac = new AbortController();
    session.notifyQueryStart(ac);
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });
    session.notifyQueryEnd(true);
    expect(session.eventsPaused).toBe(true);
  });

  it("does not set eventsPaused when aborted with no pending events", () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt();
    const ac = new AbortController();
    session.notifyQueryStart(ac);
    session.notifyQueryEnd(true);
    expect(session.eventsPaused).toBe(false);
  });

  it("does not drain events into prompt queue when aborted with pending events", () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt();
    const ac = new AbortController();
    session.notifyQueryStart(ac);
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });
    session.notifyQueryEnd(true);
    expect(session.hasPendingPrompts()).toBe(false);
  });

  it("drains events normally on notifyQueryEnd(false) when not paused", () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt();
    const ac = new AbortController();
    session.notifyQueryStart(ac);
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });
    session.notifyQueryEnd(false);
    expect(session.hasPendingPrompts()).toBe(true);
  });

  it("keeps events queued (not drained) on notifyQueryEnd(false) when already paused", () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt();
    // First: abort to enter paused state
    let ac = new AbortController();
    session.notifyQueryStart(ac);
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });
    session.notifyQueryEnd(true);

    // Second query runs normally but events are paused
    ac = new AbortController();
    session.notifyQueryStart(ac);
    session.notifyQueryEnd(false);
    expect(session.hasPendingPrompts()).toBe(false);
  });
});

// ── Event pause: debounce suppression when paused ─────────────────────────────

describe("debounce suppression when paused", () => {
  it("does not fire debounce timer for new events while paused", async () => {
    vi.useFakeTimers();
    try {
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
      session.takeNextPrompt();

      // Enter paused state via ^C
      const ac = new AbortController();
      session.notifyQueryStart(ac);
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });
      session.notifyQueryEnd(true);

      // A new event arrives while paused and no query is running
      const onPromptsReady = vi.fn();
      session.on("prompts_ready", onPromptsReady);
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("pull_request_review") });
      await vi.runAllTimersAsync();
      expect(onPromptsReady).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses event from pauseEvents() clears in-flight debounce timer", async () => {
    vi.useFakeTimers();
    try {
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
      session.takeNextPrompt();

      const onPromptsReady = vi.fn();
      session.on("prompts_ready", onPromptsReady);

      // An event arrives and starts a debounce timer
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });

      // User starts typing → pause
      session.pauseEvents();

      // Timer would have fired but should be cleared
      await vi.runAllTimersAsync();
      expect(onPromptsReady).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── /worker:resume-events command ────────────────────────────────────────────

describe("/worker:resume-events command", () => {
  function registerAndGetHandler(): (args: string) => Promise<unknown> {
    const handlers: Record<string, (args: string) => Promise<unknown>> = {};
    const registry = {
      register: (name: string, def: { handler: (args: string) => Promise<unknown> }) => {
        handlers[name] = def.handler;
      },
    } as unknown as import("../src/agent/controllers/command-controller.js").CommandRegistry;
    session.registerCommands(registry);
    return handlers["resume-events"]!;
  }

  it("drains pending events and enqueues a prompt when events are queued", async () => {
    const handler = registerAndGetHandler();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt();

    const ac = new AbortController();
    session.notifyQueryStart(ac);
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });
    session.notifyQueryEnd(true); // enter paused state

    expect(session.eventsPaused).toBe(true);
    await handler("");
    expect(session.hasPendingPrompts()).toBe(true);
    expect(session.eventsPaused).toBe(false);
  });

  it("clears eventsPaused flag even when paused with no events queued", async () => {
    const handler = registerAndGetHandler();
    session.pauseEvents();
    expect(session.eventsPaused).toBe(true);
    display.print.mockClear();
    await handler("");
    expect(session.eventsPaused).toBe(false);
    const printed = display.print.mock.calls.map(args => stripAnsi(String(args[0]))).join("\n");
    expect(printed).toContain("resumed");
  });

  it("prints amber message when event processing is not paused", async () => {
    const handler = registerAndGetHandler();
    display.print.mockClear();
    await handler("");
    const printed = display.print.mock.calls.map(args => stripAnsi(String(args[0]))).join("\n");
    expect(printed).toContain("not paused");
  });

  it("clears the pending events badge in the status bar after draining", async () => {
    const handler = registerAndGetHandler();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt();

    const ac = new AbortController();
    session.notifyQueryStart(ac);
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });
    session.notifyQueryEnd(true);

    await handler("");
    expect(sb.pendingEventsCount).toBe(0);
    expect(sb.eventsPaused).toBe(false);
  });
});

// ── pauseEvents() ─────────────────────────────────────────────────────────────

describe("pauseEvents()", () => {
  it("sets eventsPaused to true", () => {
    session.pauseEvents();
    expect(session.eventsPaused).toBe(true);
  });

  it("is idempotent — calling twice stays paused", () => {
    session.pauseEvents();
    session.pauseEvents();
    expect(session.eventsPaused).toBe(true);
  });

  it("does not print a message (typing-triggered pause is silent)", () => {
    display.print.mockClear();
    session.pauseEvents();
    // pauseEvents from typing should not print the "Events received while running" message
    const printed = display.print.mock.calls.map(args => stripAnsi(String(args[0]))).join("\n");
    expect(printed).not.toContain("Events received while running");
  });
});

// ── events-paused badge in status bar ────────────────────────────────────────

describe("events-paused badge in status bar", () => {
  it("shows 'Events paused (1 pending)' on right side when paused with queued events", () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt();
    const ac = new AbortController();
    session.notifyQueryStart(ac);
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });
    session.notifyQueryEnd(true);

    const text = fmtStatus(sb);
    expect(text).toContain("Events paused (1 pending)");
  });

  it("shows 'Events paused' (no count) when paused with no queued events", () => {
    session.pauseEvents();
    const text = fmtStatus(sb);
    expect(text).toContain("Events paused");
    expect(text).not.toContain("pending");
  });

  it("does not show 'Events paused' when not paused", () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt();
    const text = fmtStatus(sb);
    expect(text).not.toContain("Events paused");
  });

  it("pendingEventsCount on AgentStatus reflects queued events when paused", () => {
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt();
    const ac = new AbortController();
    session.notifyQueryStart(ac);
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("pull_request_review") });
    session.notifyQueryEnd(true);
    expect(sb.pendingEventsCount).toBe(2);
    expect(sb.eventsPaused).toBe(true);
  });

  it("badge clears after /worker:resume-events drains the queue", async () => {
    const handlers: Record<string, (args: string) => Promise<unknown>> = {};
    const registry = {
      register: (name: string, def: { handler: (args: string) => Promise<unknown> }) => {
        handlers[name] = def.handler;
      },
    } as unknown as import("../src/agent/controllers/command-controller.js").CommandRegistry;
    session.registerCommands(registry);

    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue: makeIssue() });
    session.takeNextPrompt();
    const ac = new AbortController();
    session.notifyQueryStart(ac);
    sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });
    session.notifyQueryEnd(true);
    expect(sb.pendingEventsCount).toBe(1);

    await handlers["resume-events"]!("");
    expect(sb.pendingEventsCount).toBe(0);
    expect(sb.eventsPaused).toBe(false);
  });
});

// ── reserve() ─────────────────────────────────────────────────────────────────

describe("reserve()", () => {
  function completeHandshake() {
    fakeWs.emit("open");
    sendMsg(fakeWs, { type: "hello_ack", workerId: AGENT_ID, status: "ready", repoStatus: "active" });
  }

  it("sends worker_reserved message when in waiting state", () => {
    completeHandshake();
    fakeWs.send.mockClear();

    session.reserve();

    const sent = fakeWs.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    expect(sent.some((m: { type: string }) => m.type === "worker_reserved")).toBe(true);
  });

  it("sets isReserved to true", () => {
    completeHandshake();
    expect(session.isReserved).toBe(false);
    session.reserve();
    expect(session.isReserved).toBe(true);
  });

  it("prints a reserved message directing the user to /worker:claim", () => {
    completeHandshake();
    display.print.mockClear();
    session.reserve();
    const printed = display.print.mock.calls.map((c: unknown[]) => stripAnsi(String(c[0]))).join("\n");
    expect(printed).toContain("Reserved");
    expect(printed).toContain("/worker:claim");
  });

  it("does nothing when worker is not active", () => {
    const inactiveSession = new WorkerController(sb, display, undefined, undefined, "owner/repo", { wsFactory });
    expect(inactiveSession.isActive).toBe(false);
    inactiveSession.reserve();
    expect(inactiveSession.isReserved).toBe(false);
    expect(fakeWs.send).not.toHaveBeenCalled();
  });

  it("does nothing when worker has a task", async () => {
    completeHandshake();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "99", issue: makeIssue(99) });
    await vi.waitFor(() => expect(session.hasTask()).toBe(true));

    fakeWs.send.mockClear();
    session.reserve();

    expect(session.isReserved).toBe(false);
    const sent = fakeWs.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    expect(sent.some((m: { type: string }) => m.type === "worker_reserved")).toBe(false);
  });

  it("isReserved resets to false when a task is assigned", async () => {
    completeHandshake();
    session.reserve();
    expect(session.isReserved).toBe(true);

    sendMsg(fakeWs, { type: "task_assigned", taskId: "99", issue: makeIssue(99) });
    await vi.waitFor(() => expect(session.hasTask()).toBe(true));

    expect(session.isReserved).toBe(false);
  });
});

// ── onForceDestroy — skips confirmation ───────────────────────────────────────

describe("WorkspaceController.onForceDestroy", () => {
  it("destroys the workspace without calling checkSafety", async () => {
    const mockWs = {
      dir: "/tmp/test",
      workspaceDir: "/tmp",
      sessionId: "s",
      originalCwd: "/",
      isCreated: true,
      on: vi.fn(),
      create: vi.fn(),
      confirm: vi.fn(),
      reset: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
      checkSafety: vi.fn(),
    } as unknown as Workspace;

    const wc = new WorkspaceController(mockWs, display, { verbose: false });
    await wc.onForceDestroy();

    expect(mockWs.destroy).toHaveBeenCalledOnce();
    expect(mockWs.checkSafety).not.toHaveBeenCalled();
  });
});

// ── lastSeenEventSeqId tracking ───────────────────────────────────────────────

describe("lastSeenEventSeqId", () => {
  function reconnectWithNewWs(): FakeWs {
    const newWs = new FakeWs();
    wsFactory.mockReturnValueOnce(newWs as any);
    fakeWs.emit("close", 1000, Buffer.from(""));
    vi.advanceTimersByTime(1); // delay=0 with Math.random mocked to 0
    return newWs;
  }

  it("includes lastSeenEventSeqId in worker_hello when reconnecting with a task", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });

      // Receive an event_notification with seqId
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment"), seqId: 7 });

      const newWs = reconnectWithNewWs();
      newWs.emit("open");

      const helloCalls = newWs.send.mock.calls.filter((args) => {
        const parsed = JSON.parse(args[0] as string);
        return parsed.type === "worker_hello";
      });
      expect(helloCalls).toHaveLength(1);
      const hello = JSON.parse(helloCalls[0][0] as string);
      expect(hello.status).toBe("assigned");
      expect(hello.lastSeenEventSeqId).toBe(7);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("omits lastSeenEventSeqId when no event_notification with seqId was received", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });

      // Receive an event_notification WITHOUT seqId
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent("issue_comment") });

      const newWs = reconnectWithNewWs();
      newWs.emit("open");

      const helloCalls = newWs.send.mock.calls.filter((args) => {
        const parsed = JSON.parse(args[0] as string);
        return parsed.type === "worker_hello";
      });
      expect(helloCalls).toHaveLength(1);
      const hello = JSON.parse(helloCalls[0][0] as string);
      expect(hello.lastSeenEventSeqId).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("tracks the highest seqId when multiple events arrive", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });

      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent(), seqId: 5 });
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent(), seqId: 3 }); // lower than previous
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent(), seqId: 9 });

      const newWs = reconnectWithNewWs();
      newWs.emit("open");

      const helloCalls = newWs.send.mock.calls.filter((args) => {
        const parsed = JSON.parse(args[0] as string);
        return parsed.type === "worker_hello";
      });
      const hello = JSON.parse(helloCalls[0][0] as string);
      expect(hello.lastSeenEventSeqId).toBe(9);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("resets lastSeenEventSeqId to new task's baseSeqId when a new task is assigned", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue, baseSeqId: 10 });
      sendMsg(fakeWs, { type: "event_notification", taskId: "42", event: makeEvent(), seqId: 7 });

      // Complete task, then receive a new task assignment with its own baseSeqId
      sendMsg(fakeWs, { type: "hello_ack", workerId: AGENT_ID, status: "ready", repoStatus: "active" });
      sendMsg(fakeWs, { type: "task_assigned", taskId: "99", issue: makeIssue(2), baseSeqId: 50 });

      const newWs = reconnectWithNewWs();
      newWs.emit("open");

      const helloCalls = newWs.send.mock.calls.filter((args) => {
        const parsed = JSON.parse(args[0] as string);
        return parsed.type === "worker_hello";
      });
      const hello = JSON.parse(helloCalls[0][0] as string);
      expect(hello.lastSeenEventSeqId).toBe(50);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("uses task_assigned.baseSeqId as initial lastSeenEventSeqId before any events arrive", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const issue = makeIssue();
      sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue, baseSeqId: 33 });
      // No event_notification received — worker disconnects immediately

      const newWs = reconnectWithNewWs();
      newWs.emit("open");

      const helloCalls = newWs.send.mock.calls.filter((args) => {
        const parsed = JSON.parse(args[0] as string);
        return parsed.type === "worker_hello";
      });
      const hello = JSON.parse(helloCalls[0][0] as string);
      expect(hello.lastSeenEventSeqId).toBe(33);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});

// ── worker_hello githubToken ──────────────────────────────────────────────────

describe("worker_hello githubToken", () => {
  function getHelloMessages(ws: FakeWs): Record<string, unknown>[] {
    return ws.send.mock.calls
      .map((args) => { try { return JSON.parse(args[0] as string); } catch { return null; } })
      .filter((m): m is Record<string, unknown> => m?.type === "worker_hello");
  }

  it("includes githubToken in worker_hello when provided in options", async () => {
    const tokenWs = new FakeWs();
    const tokenFactory = vi.fn().mockReturnValue(tokenWs);
    const s = new WorkerController(
      new AgentStatus({ agentId: AGENT_ID }),
      display,
      undefined,
      undefined,
      "owner/repo",
      { wsFactory: tokenFactory, githubToken: "ghp_testtoken" },
    );
    await s.start();
    tokenWs.emit("open");
    await new Promise<void>((r) => setImmediate(r));

    const hellos = getHelloMessages(tokenWs);
    expect(hellos.length).toBeGreaterThan(0);
    expect(hellos[0].githubToken).toBe("ghp_testtoken");
  });

  it("omits githubToken from worker_hello when not provided in options", async () => {
    // The default session from beforeEach has no githubToken in options
    fakeWs.emit("open");
    await new Promise<void>((r) => setImmediate(r));

    const hellos = getHelloMessages(fakeWs);
    expect(hellos.length).toBeGreaterThan(0);
    expect(hellos[0].githubToken).toBeUndefined();
  });
});

// ── _deactivate() — unified teardown invariant ────────────────────────────────

describe("_deactivate() — unified teardown invariant", () => {
  it("stop() sets connectionStatus to 'disconnected' even when no socket exists (backoff case)", async () => {
    vi.useFakeTimers();
    try {
      // Let the socket connect, then close it to enter reconnect backoff.
      fakeWs.emit("close", 1006, Buffer.from(""));
      // At this point we are in reconnect backoff — ws is pending a timer, no open socket.
      // Call stop() before the backoff timer fires.
      await session.stop();
      // _deactivate() must have set connectionStatus directly without relying on a close event.
      expect(sb.connectionStatus).toBe("disconnected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() during reconnect backoff clears reconnectAt (countdown timer stopped)", async () => {
    vi.useFakeTimers();
    try {
      fakeWs.emit("close", 1006, Buffer.from("")); // triggers backoff, sets reconnectAt
      expect(sb.reconnectAt).toBeDefined(); // confirm it's set by the close handler

      await session.stop();
      // _deactivate() must clear reconnectAt — current code's _stopped path does not do this.
      expect(sb.reconnectAt).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() sets workerModeActive to false synchronously before close event fires", async () => {
    // Intercept the close handler to inspect state at the moment it fires.
    let workerModeActiveAtClose: boolean | undefined;
    const origClose = fakeWs.close.getMockImplementation();
    fakeWs.close.mockImplementation(function(this: FakeWs) {
      workerModeActiveAtClose = sb.workerModeActive;
      origClose?.call(this);
    });

    await session.stop();

    // workerModeActive must be false by the time close fires (set by _deactivate() before ws.close()).
    expect(workerModeActiveAtClose).toBe(false);
    expect(sb.workerModeActive).toBe(false);
  });

  it("stop() does not schedule a reconnect when the socket close event fires", async () => {
    vi.useFakeTimers();
    try {
      await session.stop();
      vi.advanceTimersByTime(10_000);
      // wsFactory was called once on start(); stop() must not trigger a second call.
      expect(wsFactory).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fatal foreman_error sets connectionStatus to 'disconnected' synchronously", () => {
    // _deactivate() must update status before ws.close() fires.
    let statusAtClose: string | undefined;
    const origClose = fakeWs.close.getMockImplementation();
    fakeWs.close.mockImplementation(function(this: FakeWs) {
      statusAtClose = sb.connectionStatus;
      origClose?.call(this);
    });

    sendMsg(fakeWs, { type: "foreman_error", message: "Fatal error", fatal: true });
    // Status should be "disconnected" both at close-event time and after.
    expect(statusAtClose).toBe("disconnected");
    expect(sb.connectionStatus).toBe("disconnected");
  });

  it("fatal foreman_error sets workerModeActive to false before close event fires", () => {
    let workerModeActiveAtClose: boolean | undefined;
    const origClose = fakeWs.close.getMockImplementation();
    fakeWs.close.mockImplementation(function(this: FakeWs) {
      workerModeActiveAtClose = sb.workerModeActive;
      origClose?.call(this);
    });

    sendMsg(fakeWs, { type: "foreman_error", message: "Fatal error", fatal: true });
    expect(workerModeActiveAtClose).toBe(false);
  });
});
