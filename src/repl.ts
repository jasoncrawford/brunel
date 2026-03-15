import fs from "fs";
import { fileURLToPath } from "url";
import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import * as display from "./display.js";
import { ask, listCommandNames, dispatchInput } from "./input.js";
import { workerMain } from "./worker.js";
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--worker-mode")) {
    void workerMain(runQuery);
  } else {
    void main();
  }
}
