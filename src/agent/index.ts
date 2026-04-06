import "dotenv/config";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "fs";
import { fileURLToPath } from "url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, PermissionMode, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import * as display from "./display.js";
import { setVerbose, setThinkOutLoud } from "./display.js";
import { ask, listCommandNames, dispatchInput, pick, pickMultiple, pickQuestion } from "./input.js";
import type { PickQuestionResult } from "./input.js";
import { workerMain } from "./worker.js";
import type { RunQuery } from "./worker.js";
import { loadConfig } from "../config.js";
import { Workspace, confirmIfUnsafe } from "./workspace.js";
import { fmtError } from "../utils.js";
import { handleModelCommand, getCachedModels, _resetCachedModels, setCachedModels } from "./model.js";
import type { ModelInfo, FetchModelsFn } from "./model.js";
import { handleEffortCommand } from "./effort.js";
import type { EffortValue } from "./effort.js";
export { parseSlashCommand, resolveCommandFilePath, resolveContent, dispatchInput, matchCommands, listCommandNames, listWorkerCommandNames, ask } from "./input.js";
export type { SlashCommandResult, DispatchResult, ListDir } from "./input.js";
export { handleModelCommand, getCachedModels, _resetCachedModels } from "./model.js";
export { handleEffortCommand } from "./effort.js";

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

export async function runQuery(
  permConfig: { permissionMode: PermissionMode; allowDangerouslySkipPermissions: boolean },
  prompt: string,
  sessionId: string | undefined,
  abortController?: AbortController,
  model?: string,
  effort?: EffortValue,
): Promise<string | undefined> {
  logFull("QUERY", { prompt, sessionId });
  // Save and clear all ask() input callbacks while the query runs. In worker
  // mode, ask() registers drawFresh() as the print callback so the prompt
  // redraws after background WebSocket messages. But if those callbacks are
  // left active during query execution:
  //   - _inputPrintCallback (drawFresh) fires on every display.print(), adding
  //     an extra prompt redraw after each piece of output (double-spacing).
  //   - _inputStatusCallback (redrawFromCurrent) is checked by _drawStatus(),
  //     which is called after every print() — causing fullRedraw() to write the
  //     prompt and status bar inline with query output (issue #554).
  //   - _inputClearCallback (clearForPrint) would interfere similarly.
  // Clearing all three lets the normal _clearStatus/_drawStatus cursor
  // mechanics run during the query. After the query finishes we restore all
  // three and invoke the print callback once to redraw the prompt (issue #108).
  const savedPrintCallback   = display.getInputPrintCallback();
  const savedStatusCallback  = display.getInputStatusCallback();
  const savedClearCallback   = display.getInputClearCallback();
  display.setInputPrintCallback(null);
  display.setInputStatusCallback(null);
  display.setInputClearCallback(null);
  if (savedPrintCallback) {
    // ask() was active when this query started (e.g., debounce-triggered while the
    // worker prompt was showing). Clear from cursor to end of screen so the prompt
    // area is wiped and _clearStatus/_drawStatus can track the cursor correctly.
    process.stdout.write("\r\n\x1b[J");
  }

  const startTime = Date.now();
  // Accumulate stats from stream_event messages to show in the status line.
  // message_delta.usage.output_tokens is cumulative per message, so we sum
  // completed messages and track the current one separately.
  const stats = { turns: 0, inputTokens: 0, completedOutputTokens: 0, currentOutputTokens: 0 };
  const workingVerb = display.pickWorkingVerb();
  const getStatusText = () => {
    const secs = Math.floor((Date.now() - startTime) / 1000);
    const outTokens = stats.completedOutputTokens + stats.currentOutputTokens;
    return display.c.darkGray(`${workingVerb}… ${display.fmtStats(secs, stats.turns || undefined, outTokens || undefined, stats.inputTokens || undefined)}`);
  };
  display.startStatus(getStatusText);

  const canUseTool: CanUseTool = async (toolName, input) => {
    if (toolName === "AskUserQuestion") {
      return handleAskUserQuestion(input, getStatusText);
    }
    if (permConfig.allowDangerouslySkipPermissions) return { behavior: "allow", updatedInput: input };
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
      permissionMode: permConfig.permissionMode,
      includePartialMessages: true,
      canUseTool,
      abortController: ac,
      ...(permConfig.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
      ...(sessionId ? { resume: sessionId } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    },
  });

  // Cache the available models list from the SDK (fire-and-forget).
  // The Query object exposes supportedModels() which returns model info
  // without consuming the message stream.
  type QueryWithModels = { supportedModels?: () => Promise<ModelInfo[]> };
  const qm = iterable as unknown as QueryWithModels;
  if (typeof qm.supportedModels === "function") {
    qm.supportedModels().then(models => { setCachedModels(models); }).catch(() => {});
  }

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

  // Restore all callbacks and redraw the prompt. In worker mode this redraws
  // the waiting "[worker] > " prompt after query output has scrolled past it.
  display.setInputPrintCallback(savedPrintCallback);
  display.setInputStatusCallback(savedStatusCallback);
  display.setInputClearCallback(savedClearCallback);
  savedPrintCallback?.();

  return capturedSessionId;
}

// ── Workspace action handler ──────────────────────────────────────────────────

export type WorkspaceActionType = "create-workspace" | "reset-workspace" | "remove-workspace" | "prune";

export interface WorkspaceActionParams {
  workspaceCfg: { workspaceDir: string; repoUrl: string } | undefined;
  workspace: Workspace | undefined;
  sessionId_: string;
  originalCwd: string;
  confirm: (msg: string) => Promise<boolean>;
  print: (msg: string) => void;
  chdir: (dir: string) => void;
}

/**
 * Handle one workspace slash command in the REPL.
 * Returns the (possibly updated) workspace reference.
 * Extracted for testability.
 */
export async function handleWorkspaceAction(
  type: WorkspaceActionType,
  params: WorkspaceActionParams,
): Promise<Workspace | undefined> {
  const { workspaceCfg, workspace, sessionId_, originalCwd, confirm, print, chdir } = params;

  if (type === "create-workspace") {
    if (!workspaceCfg) {
      print(display.c.boldRed("Cannot create workspace: no GitHub repo configured."));
      return workspace;
    }
    if (workspace) {
      print(display.c.amber(`Workspace already exists: ${workspace.dir}`));
      return workspace;
    }
    const ws = await Workspace.create(workspaceCfg.workspaceDir, sessionId_, workspaceCfg.repoUrl);
    chdir(ws.dir);
    print(display.c.sageGreen(`Workspace created: ${ws.dir}`));
    return ws;
  }

  if (type === "reset-workspace") {
    if (!workspace) {
      print(display.c.boldRed("No workspace. Use /create-workspace first."));
      return workspace;
    }
    const ok = await confirmIfUnsafe(workspace, confirm);
    if (!ok) return workspace;
    await workspace.reset();
    print(display.c.sageGreen("Workspace reset to main."));
    return workspace;
  }

  if (type === "remove-workspace") {
    if (!workspace) {
      print(display.c.boldRed("No workspace in this session."));
      return workspace;
    }
    const ok = await confirmIfUnsafe(workspace, confirm);
    if (!ok) return workspace;
    await workspace.destroy();
    chdir(originalCwd);
    print(display.c.sageGreen(`Workspace removed. Now in: ${originalCwd}`));
    return undefined;
  }

  // type === "prune"
  if (!workspaceCfg) {
    print(display.c.boldRed("Cannot prune: no workspace directory configured."));
    return workspace;
  }
  const removed = await Workspace.prune(workspaceCfg.workspaceDir);
  if (removed.length === 0) {
    print(display.c.sageGreen("Nothing to prune."));
  } else {
    for (const dir of removed) print(display.c.darkGray(`  Removed: ${dir}`));
    print(display.c.sageGreen(`Pruned ${removed.length} orphaned workspace(s).`));
  }
  return workspace;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function createFetchModelsFn(permConfig: { permissionMode: PermissionMode }): FetchModelsFn {
  return async () => {
    const q = query({ prompt: "", options: { cwd: process.cwd(), systemPrompt: { type: "preset", preset: "claude_code" }, permissionMode: permConfig.permissionMode } });
    type QueryWithModels = { supportedModels?: () => Promise<ModelInfo[]> };
    const qm = q as unknown as QueryWithModels;
    if (typeof qm.supportedModels === "function") return qm.supportedModels();
    return [];
  };
}

async function main(
  permConfig: { permissionMode: PermissionMode; allowDangerouslySkipPermissions: boolean },
  workspaceCfg?: { workspaceDir: string; repoUrl: string },
  initialModel?: string,
  initialEffort?: EffortValue,
): Promise<void> {
  const fetchModelsFn = createFetchModelsFn(permConfig);
  let currentModel: string | undefined = initialModel;
  let currentEffort: EffortValue | undefined = initialEffort;

  process.stdout.write("\x1b[?2004h"); // enable bracketed paste mode
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let sessionId: string | undefined;
  const sessionId_ = crypto.randomUUID();
  const originalCwd = process.cwd();
  let workspace: Workspace | undefined = undefined;

  const confirm = async (msg: string): Promise<boolean> => {
    display.stopStatus();
    display.print(display.c.amber(`\n⚠ Potential data loss:\n${msg}`));
    const idx = await pick(["Yes, proceed", "No, cancel"]);
    return idx === 0;
  };

  display.print(display.c.sageGreen(display.hr("═")));
  display.print(display.c.skyBlue(display.s.bold("  Claude Agent SDK REPL")));
  display.print(display.c.lavender(`  Permissions: ${permConfig.permissionMode} | Model: ${initialModel ?? "default"} | Effort: ${initialEffort ?? "auto"} | Output: ${display.verbose ? "verbose" : "quiet"} | Log: ${LOG_FILE}`));
  display.print(display.c.lavender(`  Type /exit to quit, /clear to start a new session.`));
  display.print(display.c.sageGreen(display.hr("═")));

  while (true) {
    const input = await ask("\n> ");

    // ^D / ^C on empty buffer resolves ask() with "__eof__" — treat as /exit.
    if (input === "__eof__") {
      if (workspace) {
        const ok = await confirmIfUnsafe(workspace, confirm);
        if (ok) await workspace.destroy();
      }
      process.stdout.write("\x1b[?2004l\r\n");
      process.stdin.setRawMode(false);
      process.stdin.pause();
      break;
    }

    const action = await dispatchInput(input);

    if (action.type === "skip") continue;

    if (action.type === "exit") {
      if (workspace) {
        const ok = await confirmIfUnsafe(workspace, confirm);
        if (ok) await workspace.destroy();
      }
      process.stdout.write("\x1b[?2004l\r\n");
      process.stdin.setRawMode(false);
      process.stdin.pause();
      break;
    }

    if (action.type === "clear") {
      sessionId = undefined;
      display.print(display.clearBreak());
      continue;
    }

    if (action.type === "unknown_command") {
      display.print(display.c.boldRed(`Unknown command: /${action.command}`));
      continue;
    }

    if (action.type === "task-complete") {
      display.print(display.c.boldRed("Not in worker mode."));
      continue;
    }

    if (action.type === "model") {
      const modelArgs = input.slice("/model".length).trim();
      const pickModelFn = (opts: string[], idx: number) =>
        pick(opts, { currentIdx: idx, escapable: true });
      currentModel = await handleModelCommand(
        modelArgs, currentModel, pickModelFn,
        fetchModelsFn,
        display.print,
      );
      continue;
    }

    if (action.type === "effort") {
      const effortArgs = input.slice("/effort".length).trim();
      const pickEffortFn = (opts: string[], idx: number) =>
        pick(opts, { currentIdx: idx, escapable: true });
      currentEffort = await handleEffortCommand(
        effortArgs, currentEffort, pickEffortFn,
        display.print,
      );
      continue;
    }

    if (
      action.type === "create-workspace" ||
      action.type === "reset-workspace" ||
      action.type === "remove-workspace" ||
      action.type === "prune"
    ) {
      workspace = await handleWorkspaceAction(action.type, {
        workspaceCfg, workspace, sessionId_, originalCwd, confirm,
        print: display.print,
        chdir: (dir) => process.chdir(dir),
      });
      continue;
    }

    if (action.type !== "query") continue;

    try {
      sessionId = await runQuery(permConfig, action.prompt, sessionId, undefined, currentModel, currentEffort);
    } catch (err) {
      console.error(display.c.boldRed(`\nERROR: ${fmtError(err)}`));
      logFull("ERROR", err instanceof Error ? { message: err.message, stack: err.stack } : err);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = await loadConfig(process.argv);
  setVerbose(config.verbose);
  setThinkOutLoud(config.thinkOutLoud);
  const permConfig = {
    permissionMode: config.permissionMode,
    allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions,
  };

  const boundRunQuery: RunQuery = (prompt, sessionId, ac, model, effort) =>
    runQuery(permConfig, prompt, sessionId, ac, model, effort);

  const workspaceCfg = (config.githubRepo && config.githubToken)
    ? {
        workspaceDir: config.workspaceDir ?? path.join(os.homedir(), ".brunel", "workers"),
        repoUrl: `https://${config.githubToken}@github.com/${config.githubRepo}.git`,
      }
    : undefined;

  if (process.argv.includes("--worker-mode")) {
    void workerMain(boundRunQuery, {
      foremanUrl: config.foremanUrl,
      workspaceDir: config.workspaceDir,
      githubToken: config.githubToken,
      githubRepo: config.githubRepo,
      repoUrl: config.repoUrl,
      permissionMode: config.permissionMode,
      verbose: config.verbose,
      logFile: LOG_FILE,
      model: config.model,
      effort: config.effort,
      pingIntervalMs: config.pingIntervalMs,
    });
  } else {
    void main(permConfig, workspaceCfg, config.model, config.effort);
  }
}
