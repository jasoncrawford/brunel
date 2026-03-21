import fs from "fs";
import { fileURLToPath } from "url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, PermissionMode, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import * as display from "./display.js";
import { ask, listCommandNames, dispatchInput, pick, pickMultiple, pickQuestion } from "./input.js";
import type { PickQuestionResult } from "./input.js";
import { workerMain } from "./worker.js";
export { parseSlashCommand, resolveCommandFilePath, resolveContent, dispatchInput, matchCommands, listCommandNames, listWorkerCommandNames, ask } from "./input.js";
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

// ── Config ────────────────────────────────────────────────────────────────────

export const VALID_PERMISSION_MODES: readonly PermissionMode[] = [
  "default", "acceptEdits", "bypassPermissions", "plan", "dontAsk",
];

export type ParsedPermissionConfig = {
  mode: PermissionMode;
  allowDangerouslySkipPermissions: boolean;
};

export function parsePermissionMode(argv: string[]): ParsedPermissionConfig {
  const hasDangerousFlag = argv.includes("--dangerously-skip-permissions");
  const modeIdx = argv.indexOf("--permission-mode");

  let explicitMode: string | null = null;
  if (modeIdx !== -1) {
    const next = argv[modeIdx + 1];
    // Missing value: no next token, or next token looks like a flag
    if (!next || next.startsWith("--")) {
      process.stderr.write(
        `Error: --permission-mode requires a value. Valid modes: ${VALID_PERMISSION_MODES.join(", ")}\n`
      );
      process.exit(1);
    }
    if (!(VALID_PERMISSION_MODES as readonly string[]).includes(next)) {
      process.stderr.write(
        `Error: Unknown permission mode "${next}". Valid modes: ${VALID_PERMISSION_MODES.join(", ")}\n`
      );
      process.exit(1);
    }
    explicitMode = next;
  }

  // Conflict: --dangerously-skip-permissions implies bypassPermissions;
  // if --permission-mode is also given and says something different, that's an error.
  if (hasDangerousFlag && explicitMode !== null && explicitMode !== "bypassPermissions") {
    process.stderr.write(
      `Error: --dangerously-skip-permissions conflicts with --permission-mode ${explicitMode}. ` +
      `Use --permission-mode bypassPermissions or omit --permission-mode.\n`
    );
    process.exit(1);
  }

  if (hasDangerousFlag || explicitMode === "bypassPermissions") {
    return { mode: "bypassPermissions", allowDangerouslySkipPermissions: true };
  }

  const mode: PermissionMode = (explicitMode as PermissionMode) ?? "default";
  return { mode, allowDangerouslySkipPermissions: false };
}

const { mode: PERMISSION_MODE, allowDangerouslySkipPermissions: ALLOW_BYPASS } =
  parsePermissionMode(process.argv);

// ── REPL ──────────────────────────────────────────────────────────────────────

type QuestionOption = { label: string; description: string };
type Question = { question: string; header: string; options: QuestionOption[]; multiSelect: boolean };

export async function handleAskUserQuestion(
  input: Record<string, unknown>,
  getStatusText: () => string,
): Promise<PermissionResult> {
  display.stopStatus();
  const questions = (input.questions as Question[]) ?? [];
  const answers: Record<string, string> = {};

  for (const q of questions) {
    display.print(display.c.yellow(`\n? ${q.question}`));
    if (q.multiSelect) {
      const lines = q.options.map(o => o.description ? `${o.label} — ${o.description}` : o.label);
      const idxs = await pickMultiple(lines);
      answers[q.question] = idxs.map(i => q.options[i].label).join(", ");
    } else {
      const result: PickQuestionResult = await pickQuestion(q.options);
      if (result.type === "discuss") {
        display.startStatus(getStatusText);
        return { behavior: "deny", message: "The user would like to discuss more before answering. Prompt them to begin the discussion." };
      }
      answers[q.question] = result.type === "answer" ? result.value : result.text;
    }
  }

  display.startStatus(getStatusText);
  return { behavior: "allow", updatedInput: { ...input, answers } };
}

export async function handleToolPermission(
  toolName: string,
  input: Record<string, unknown>,
  getStatusText: () => string,
): Promise<PermissionResult> {
  display.stopStatus();
  display.print(display.c.amber(`\n⚠ ${toolName}(${display.fmtArgs(input)})`));
  const idx = await pick(["Allow", "Deny"]);
  display.startStatus(getStatusText);
  if (idx === 0) return { behavior: "allow", updatedInput: input };
  return { behavior: "deny", message: "User denied tool request" };
}

export async function runQuery(prompt: string, sessionId: string | undefined, abortController?: AbortController) {
  logFull("QUERY", { prompt, sessionId });
  // Save and clear the input print callback while the query runs. In worker
  // mode, ask() registers drawFresh() as the callback so the prompt redraws
  // after background WebSocket messages — but during a query run the callback
  // fires on every display.print() call, adding an extra \r\n after each piece
  // of output and causing double-spacing. After the query finishes we restore
  // and invoke the callback so the prompt redraws once (fixes issue #108).
  const savedInputCallback = display.getInputPrintCallback();
  display.setInputPrintCallback(null);

  const startTime = Date.now();
  // Accumulate stats from stream_event messages to show in the status line.
  // message_delta.usage.output_tokens is cumulative per message, so we sum
  // completed messages and track the current one separately.
  const stats = { turns: 0, inputTokens: 0, completedOutputTokens: 0, currentOutputTokens: 0 };
  const getStatusText = () => {
    const secs = Math.floor((Date.now() - startTime) / 1000);
    const outTokens = stats.completedOutputTokens + stats.currentOutputTokens;
    return display.c.darkGray(`Working… ${display.fmtStats(secs, stats.turns || undefined, outTokens || undefined, stats.inputTokens || undefined)}`);
  };
  display.startStatus(getStatusText);

  const canUseTool: CanUseTool = async (toolName, input) => {
    if (toolName === "AskUserQuestion") {
      return handleAskUserQuestion(input, getStatusText);
    }
    if (ALLOW_BYPASS) return { behavior: "allow", updatedInput: input };
    return handleToolPermission(toolName, input, getStatusText);
  };

  // Use caller-provided AbortController (worker mode) or create our own (REPL mode).
  const ac = abortController ?? new AbortController();

  const iterable = query({
    prompt,
    options: {
      cwd: process.cwd(),
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project"],
      permissionMode: PERMISSION_MODE,
      includePartialMessages: true,
      canUseTool,
      abortController: ac,
      ...(ALLOW_BYPASS ? { allowDangerouslySkipPermissions: true } : {}),
      ...(sessionId ? { resume: sessionId } : {}),
    },
  });

  // Register a temporary raw-stdin listener to catch ^C and abort the query.
  // The listener is removed in a finally block regardless of how the query ends.
  const onInterrupt = (chunk: string) => {
    if (chunk.includes("\x03")) {
      (iterable as unknown as { close?: () => void }).close?.();
      ac.abort();
    }
  };
  process.stdin.on("data", onInterrupt);

  let capturedSessionId = sessionId;
  let resultReceived = false;

  try {
    for await (const message of iterable) {
      if (!(message.type === "stream_event" && (message.event as { type?: string }).type === "content_block_delta")) {
        logFull("MESSAGE", message);
      }

      if (message.type === "system" && message.subtype === "init" && !capturedSessionId) {
        capturedSessionId = message.session_id;
      }

      // Extract turn count and token totals from streaming events.
      if (message.type === "stream_event") {
        if (message.parent_tool_use_id == null) {
          // BetaRawMessageStreamEvent is a discriminated union; use a structural type for field access
          type StreamEvent = { type: string; message?: { usage?: { input_tokens?: number } }; usage?: { output_tokens?: number } };
          const ev = message.event as StreamEvent;
          if (ev.type === "message_start")       { stats.turns++; stats.inputTokens += ev.message?.usage?.input_tokens ?? 0; }
          if (ev.type === "message_delta")       stats.currentOutputTokens = ev.usage?.output_tokens ?? stats.currentOutputTokens;
          if (ev.type === "message_stop")        { stats.completedOutputTokens += stats.currentOutputTokens; stats.currentOutputTokens = 0; }
        }
        continue; // stream events are display-only; don't pass to printMessage
      }

      // Stop the status line before printing the result so it transitions
      // cleanly into the permanent summary line.
      if (message.type === "result") {
        resultReceived = true;
        display.stopStatus();
      }

      display.printMessage(message);
    }
  } catch (err) {
    // SDK throws when aborted — treat as clean interrupt, not an error
    if (!(err instanceof Error && /aborted by user/i.test(err.message))) throw err;
  } finally {
    process.stdin.removeListener("data", onInterrupt);
  }

  display.stopStatus(); // no-op if result message already stopped it

  if (!resultReceived) {
    display.print(display.c.darkGray("\nInterrupted. What should the agent do instead?"));
  }

  // Restore the callback and redraw the prompt. In worker mode this redraws
  // the waiting "[worker] > " prompt after query output has scrolled past it.
  display.setInputPrintCallback(savedInputCallback);
  savedInputCallback?.();

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
