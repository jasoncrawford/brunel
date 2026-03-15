import fs from "fs";
import { fileURLToPath } from "url";
import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import * as display from "./display.js";
export * from "./display.js";
import { WebSocket } from "ws";
import { getWorkerId } from "./worker-id.js";
import { buildInitialPrompt, buildEventPrompt } from "./templates.js";
import type { ForemanMessage, GitHubEvent, TaskIssue } from "./types.js";
import { ask, listCommandNames, dispatchInput } from "./input.js";
export { parseSlashCommand, resolveCommandFilePath, loadCommandFile, dispatchInput, matchCommands, listCommandNames, ask } from "./input.js";
export type { SlashCommandResult, DispatchResult, ListDir } from "./input.js";

// ── Log file ──────────────────────────────────────────────────────────────────

const LOG_FILE = "repl.log";

export function logFull(label: string, data: unknown) {
  const entry =
    `\n${"=".repeat(70)}\n` +
    `${new Date().toISOString()}  ${label}\n` +
    `${"-".repeat(70)}\n` +
    JSON.stringify(data, null, 2) +
    "\n";
  fs.appendFileSync(LOG_FILE, entry);
}

// ── Hook factory ──────────────────────────────────────────────────────────────

function makeHook(event: string): HookCallback {
  return async (input) => {
    logFull(`HOOK ${event}`, input);
    display.printHook(event, input);
    return {};
  };
}

const ALL_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PermissionRequest",
  "Setup",
  "TeammateIdle",
  "TaskCompleted",
  "ConfigChange",
] as const;

type HookEvent = (typeof ALL_HOOK_EVENTS)[number];

const hooks = Object.fromEntries(
  ALL_HOOK_EVENTS.map((event) => [
    event,
    [{ matcher: ".*", hooks: [makeHook(event)] }],
  ])
) as Record<HookEvent, [{ matcher: string; hooks: [HookCallback] }]>;

// ── Config ────────────────────────────────────────────────────────────────────

const BYPASS = process.argv.includes("--dangerously-skip-permissions");
const PERMISSION_MODE = BYPASS ? "bypassPermissions" : "acceptEdits";

// ── REPL ──────────────────────────────────────────────────────────────────────

export async function runQuery(prompt: string, sessionId: string | undefined) {
  logFull("QUERY", { prompt, sessionId });

  const startTime = Date.now();
  // Accumulate stats from stream_event messages to show in the status line.
  // message_delta.usage.output_tokens is cumulative per message, so we sum
  // completed messages and track the current one separately.
  const stats = { turns: 0, inputTokens: 0, completedOutputTokens: 0, currentOutputTokens: 0 };
  display.startStatus(() => {
    const secs = Math.floor((Date.now() - startTime) / 1000);
    const outTokens = stats.completedOutputTokens + stats.currentOutputTokens;
    return display.c.darkGray(`Working… ${display.fmtStats(secs, stats.turns || undefined, outTokens || undefined, stats.inputTokens || undefined)}`);
  });

  let capturedSessionId = sessionId;

  for await (const message of query({
    prompt,
    options: {
      cwd: process.cwd(),
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project"],
      permissionMode: PERMISSION_MODE,
      includePartialMessages: true,
      ...(BYPASS ? { allowDangerouslySkipPermissions: true } : {}),
      ...(sessionId ? { resume: sessionId } : {}),
      hooks,
    },
  })) {
    const m = message as any;

    if (!(m.type === "stream_event" && m.event?.type === "content_block_delta")) {
      logFull("MESSAGE", message);
    }

    if (m.type === "system" && m.subtype === "init" && !capturedSessionId) {
      capturedSessionId = m.session_id;
    }

    // Extract turn count and token totals from streaming events.
    if (m.type === "stream_event") {
      if (m.parent_tool_use_id == null) {
        const ev = m.event;
        if (ev.type === "message_start")       { stats.turns++; stats.inputTokens += ev.message?.usage?.input_tokens ?? 0; }
        if (ev.type === "message_delta")       stats.currentOutputTokens = ev.usage?.output_tokens ?? stats.currentOutputTokens;
        if (ev.type === "message_stop")        { stats.completedOutputTokens += stats.currentOutputTokens; stats.currentOutputTokens = 0; }
      }
      continue; // stream events are display-only; don't pass to printMessage
    }

    // Stop the status line before printing the result so it transitions
    // cleanly into the permanent summary line.
    if (m.type === "result") display.stopStatus();

    display.printMessage(message);
  }

  display.stopStatus(); // no-op if result message already stopped it
  return capturedSessionId;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write("\x1b[?2004h"); // enable bracketed paste mode
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let sessionId: string | undefined;

  display.print(display.c.sageGreen(display.hr("═")));
  display.print(display.c.skyBlue(display.s.bold("  Claude Agent SDK REPL")));
  display.print(display.c.lavender(`  Permissions: ${PERMISSION_MODE} | Output: ${display.VERBOSE ? "verbose" : "quiet"} | Log: ${LOG_FILE}`));
  display.print(display.c.lavender(`  Type /exit to quit, /clear to start a new session.`));
  display.print(display.c.sageGreen(display.hr("═")));

  while (true) {
    const input = await ask("\n> ");

    const action = await dispatchInput(input);

    if (action.type === "skip") continue;

    if (action.type === "exit") {
      process.stdout.write("\x1b[?2004l\r\n");
      process.stdin.setRawMode(false);
      process.stdin.pause();
      break;
    }

    if (action.type === "clear") {
      sessionId = undefined;
      display.print("Session cleared.");
      continue;
    }

    if (action.type === "unknown_command") {
      display.print(display.c.boldRed(`Unknown command: /${action.command}`));
      continue;
    }

    if (action.type === "task_complete") {
      display.print(display.c.boldRed("Not in worker mode."));
      continue;
    }

    try {
      sessionId = await runQuery(action.prompt, sessionId);
    } catch (err) {
      console.error(display.c.boldRed(`\nERROR: ${err}`));
      logFull("ERROR", err instanceof Error ? { message: err.message, stack: err.stack } : err);
    }
  }
}

// ── Worker mode ───────────────────────────────────────────────────────────────

/**
 * Create a WebSocket connection to the foreman at the /worker path and send
 * the initial worker_hello handshake. Returns the WebSocket for the caller to
 * attach message/close/error handlers.
 */
export function handleForemanMessage(
  msg: ForemanMessage,
  callbacks: {
    onTaskAssigned: (taskId: string, issue: TaskIssue) => void;
    onEventNotification: (event: GitHubEvent) => void;
  }
): void {
  display.printForemanMessage(msg);
  if (msg.type === "task_assigned") {
    callbacks.onTaskAssigned(msg.taskId, msg.issue);
  } else if (msg.type === "event_notification") {
    callbacks.onEventNotification(msg.event);
  }
}

export function connectToForeman(foremanUrl: string, workerId: string, taskId?: string): WebSocket {
  const ws = new WebSocket(`${foremanUrl}/worker`);
  ws.on("open", () => {
    ws.send(JSON.stringify({
      type: "worker_hello",
      workerId,
      taskId,
      status: taskId ? "busy" : "idle",
    }));
  });
  return ws;
}

export async function workerMain() {
  const FOREMAN_URL = process.env.FOREMAN_URL ?? "ws://localhost:3000";
  const workerId = getWorkerId();

  // Local event queue — populated by the ws message handler even during runQuery()
  const pendingEvents: GitHubEvent[] = [];
  let currentTaskId: string | undefined;
  let currentSessionId: string | undefined;
  let currentIssue: TaskIssue | undefined;

  // Sentinel values used to signal WebSocket events through ask()'s abort param
  const WS_TASK_ASSIGNED = "__task_assigned__";
  const WS_EVENT = "__event__";

  // Signalling: when the worker is waiting at the prompt, a WebSocket event
  // can resolve this to interrupt ask() and process the event.
  let resolveWsInput: ((v: string) => void) | null = null;

  process.stdout.write("\x1b[?2004h");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  display.print(display.c.sageGreen(display.hr("═")));
  display.print(display.c.skyBlue(display.s.bold("  Brunel Worker")));
  display.print(display.c.lavender(`  Worker ID: ${workerId} | Foreman: ${FOREMAN_URL}`));
  display.print(display.c.sageGreen(display.hr("═")));

  let ws!: WebSocket;

  function connectWs(): void {
    ws = connectToForeman(FOREMAN_URL, workerId, currentTaskId);

    ws.on("open", () => {
      display.print(display.c.sageGreen("  Connected to foreman."));
    });

    ws.on("message", (data) => {
      let msg: ForemanMessage;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      handleForemanMessage(msg, {
        onTaskAssigned: (taskId, issue) => {
          currentTaskId = taskId;
          currentIssue = issue;
          currentSessionId = undefined;
          resolveWsInput?.(WS_TASK_ASSIGNED);
          resolveWsInput = null;
        },
        onEventNotification: (event) => {
          pendingEvents.push(event);
          resolveWsInput?.(WS_EVENT);
          resolveWsInput = null;
        },
      });
    });

    ws.on("close", () => {
      display.print(display.c.amber("  Disconnected from foreman. Reconnecting..."));
      setTimeout(() => connectWs(), 3000);
    });

    ws.on("error", () => { /* close will fire, handled above */ });
  }

  connectWs();

  // Main worker loop
  while (true) {
    // If we have pending events after a query, process them immediately
    if (pendingEvents.length > 0 && currentTaskId && currentIssue) {
      const events = pendingEvents.splice(0);
      const prompt = buildEventPrompt(events);
      currentSessionId = await runQuery(prompt, currentSessionId);
      continue;
    }

    // Wait for next input: user stdin or WebSocket signal
    const wsAbort = new Promise<string>((resolve) => { resolveWsInput = resolve; });
    const input = await ask("\n[worker] > ", listCommandNames, wsAbort);

    // Node.js is single-threaded: the ws message handler sets currentIssue
    // synchronously before calling resolveWsInput, so currentIssue is always
    // populated by the time ask() resolves with WS_TASK_ASSIGNED.
    if (input === WS_TASK_ASSIGNED && currentIssue) {
      const prompt = buildInitialPrompt(currentIssue);
      currentSessionId = await runQuery(prompt, currentSessionId);
      continue;
    }

    if (input === WS_EVENT) {
      // pendingEvents already populated; loop will process them
      continue;
    }

    if (!input || input === "__abort__") continue;

    const action = await dispatchInput(input);
    if (action.type === "skip") continue;

    if (action.type === "exit") {
      process.stdout.write("\x1b[?2004l\r\n");
      process.stdin.setRawMode(false);
      process.stdin.pause();
      ws.close();
      break;
    }

    if (action.type === "task_complete") {
      if (currentTaskId) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "task_complete", workerId, taskId: currentTaskId }));
        }
        currentTaskId = undefined;
        currentIssue = undefined;
        currentSessionId = undefined;
        display.print(display.c.sageGreen("  Task complete. Waiting for next task..."));
      }
      continue;
    }

    if (action.type === "clear") {
      currentSessionId = undefined;
      display.print("Session cleared.");
      continue;
    }

    if (action.type === "unknown_command") {
      display.print(display.c.boldRed(`Unknown command: /${action.command}`));
      continue;
    }

    if (action.type === "query") {
      try {
        currentSessionId = await runQuery(action.prompt, currentSessionId);
      } catch (err) {
        display.print(display.c.boldRed(`\nERROR: ${err}`));
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--worker-mode")) {
    workerMain();
  } else {
    main();
  }
}
