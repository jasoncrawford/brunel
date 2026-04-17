import "dotenv/config";
import os from "node:os";
import path from "node:path";
import fs from "fs";
import { fileURLToPath } from "url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, PermissionMode, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import * as display from "./views/display.js";
import { Display, initDisplay } from "./views/display.js";
import { StatusBar, statusBar, initStatusBar } from "./views/status-bar.js";
import { ask, pick, pickMultiple, pickQuestion } from "./views/input.js";
import type { PickQuestionResult } from "./views/input.js";
import { WorkerSession, registerWorkerCommands, startWorkerMode, generateAgentId, confirmTaskQuit } from "./controllers/worker.js";
import type { RunQuery } from "./controllers/worker.js";
import { loadConfig, getConfig } from "../config.js";
import { Workspace, confirmIfUnsafe } from "./models/workspace.js";
import { registerWorkspaceCommands } from "./controllers/workspace-commands.js";
import { fmtError } from "../utils.js";
import { Settings, setCachedModels } from "./models/settings.js";
import type { ModelInfo, FetchModelsFn, EffortValue } from "./models/settings.js";
import { CommandRegistry } from "./controllers/command-registry.js";
import { QueryStats } from "./models/query-stats.js";
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
  statusBar.stop();
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
        statusBar.start(getStatusText);
        return { behavior: "deny", message: "The user would like to discuss more before answering. Prompt them to begin the discussion." };
      }
      answers[q.question] = result.type === "answer" ? result.value : result.text;
    }
  }

  statusBar.start(getStatusText);
  return { behavior: "allow", updatedInput: { ...input, answers } };
}

export async function handleToolPermission(
  toolName: string,
  input: Record<string, unknown>,
  getStatusText: () => string,
): Promise<PermissionResult> {
  statusBar.stop();
  display.print(display.c.amber(`\n⚠ ${toolName}(${display.fmtArgs(input)})`));
  const idx = await pick(["Allow", "Deny"]);
  statusBar.start(getStatusText);
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
  // Save and clear the input print callback while the query runs. In worker
  // mode, ask() registers drawFresh() as the callback so the prompt redraws
  // after background WebSocket messages — but during a query run the callback
  // fires on every display.print() call, adding an extra \r\n after each piece
  // of output and causing double-spacing. After the query finishes we restore
  // and invoke the callback so the prompt redraws once (fixes issue #108).
  const savedInputCallback = statusBar.inputPrint;
  const savedStatusCallback = statusBar.inputStatus;
  const savedClearCallback = statusBar.inputClear;
  statusBar.inputPrint = null;
  statusBar.inputStatus = null;
  statusBar.inputClear = null;
  if (savedInputCallback) {
    // ask() was active when this query started (e.g., debounce-triggered while the
    // worker prompt was showing). Clear from cursor to end of screen so the prompt
    // area is wiped and _clearStatus/_drawStatus can track the cursor correctly.
    process.stdout.write("\r\n\x1b[J");
  }

  const stats = new QueryStats();
  const getStatusText = () => display.c.darkGray(stats.getStatusText());
  statusBar.start(getStatusText);

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
          stats.update(message.event as Parameters<typeof stats.update>[0]);
        }
        continue; // stream events are display-only; don't pass to printMessage
      }

      // Stop the status line before printing the result so it transitions
      // cleanly into the permanent summary line.
      if (message.type === "result") {
        resultReceived = true;
        statusBar.stop();
      }

      display.printMessage(message);
    }
  } catch (err) {
    // SDK throws when aborted — treat as clean interrupt, not an error
    if (!(err instanceof Error && /aborted by user/i.test(err.message))) throw err;
  } finally {
    process.stdin.removeListener("data", onInterrupt);
  }

  statusBar.stop(); // no-op if result message already stopped it

  if (!resultReceived) {
    display.print(display.c.darkGray("\nInterrupted. What should the agent do instead?"));
  }

  // Restore the callbacks and redraw the prompt. In worker mode this redraws
  // the waiting "[worker] > " prompt after query output has scrolled past it.
  statusBar.inputPrint = savedInputCallback;
  statusBar.inputStatus = savedStatusCallback;
  statusBar.inputClear = savedClearCallback;
  savedInputCallback?.();

  return capturedSessionId;
}

function createFetchModelsFn(permConfig: { permissionMode: PermissionMode }): FetchModelsFn {
  return async () => {
    const q = query({ prompt: "", options: { cwd: process.cwd(), systemPrompt: { type: "preset", preset: "claude_code" }, permissionMode: permConfig.permissionMode } });
    type QueryWithModels = { supportedModels?: () => Promise<ModelInfo[]> };
    const qm = q as unknown as QueryWithModels;
    if (typeof qm.supportedModels === "function") return qm.supportedModels();
    return [];
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function main(
  runQueryFn: RunQuery,
  permConfig: { permissionMode: PermissionMode; allowDangerouslySkipPermissions: boolean },
  runWorkerMode?: boolean,
  workspaceCfg?: { workspaceDir: string; repoUrl: string },
  initialModel?: string,
  initialEffort?: EffortValue,
): Promise<void> {
  const settings = new Settings({ model: initialModel, effort: initialEffort });
  initStatusBar(new StatusBar({ agentId: generateAgentId(), settings }));

  // Worker mode setup: create workspace, session, signal handlers.
  const workerCtx = runWorkerMode ? await startWorkerMode() : undefined;
  const session = workerCtx?.session;

  const fetchModelsFn = createFetchModelsFn(permConfig);

  // Print the startup banner.
  display.print(display.c.sageGreen(display.hr("═")));
  display.print(display.c.skyBlue(display.s.bold("  Brunel Agent")));
  display.print(display.c.lavender(`  Permissions: ${permConfig.permissionMode} | Model: ${settings.model ?? "default"} | Effort: ${settings.effort ?? "auto"} | Output: ${getConfig().verbose ? "verbose" : "quiet"} | Log: ${LOG_FILE}`));
  display.print(display.c.sageGreen(display.hr("═")));

  process.stdout.write("\x1b[?2004h"); // enable bracketed paste mode
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let sessionId: string | undefined;
  const originalCwd = process.cwd();

  const confirm = async (msg: string): Promise<boolean> => {
    statusBar.stop();
    display.print(display.c.amber(`\n⚠ Potential data loss:\n${msg}`));
    const idx = await pick(["Yes, proceed", "No, cancel"]);
    return idx === 0;
  };

  // In REPL mode, create a Workspace (without cloning) if GitHub is configured.
  // In worker mode, the workspace is owned by the session (already created).
  const workspace: Workspace | undefined = session
    ? session.workspace
    : workspaceCfg
      ? new Workspace(workspaceCfg.workspaceDir, statusBar.agentId, workspaceCfg.repoUrl, originalCwd, confirm)
      : undefined;

  // doExit handles REPL workspace cleanup and stdin/stdout teardown.
  // Only called in REPL mode (worker mode cleanup goes through workerCtx.cleanup()).
  const doExit = async () => {
    if (workspace?.isCreated) {
      const ok = await confirmIfUnsafe(workspace, workspace.confirm);
      if (ok) await workspace.destroy();
    }
    process.stdout.write("\x1b[?2004l\r\n");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  };

  // Register all commands. All commands are present in both REPL and worker
  // modes; commands that require a foreman connection degrade gracefully.
  const registry = new CommandRegistry();
  registerWorkspaceCommands(workspace, registry.scoped("workspace"));
  registerWorkerCommands(session, registry.scoped("worker"));
  registry.register("exit", {
    description: "Exit",
    handler: async () => {
      if (!session) { await doExit(); return "exit"; }
      const taskInfo = session.getTaskQuitInfo();
      if (taskInfo) {
        const choice = await confirmTaskQuit(taskInfo);
        if (choice === "cancel") return undefined;
        if (choice === "complete-and-quit") await session.completeCurrentTask();
      }
      return "exit";
    },
  });
  registry.register("clear", {
    description: "Clear the conversation",
    handler: async () => {
      sessionId = undefined;
      display.print(display.clearBreak());
    },
  });
  registry.register("model", {
    description: "Select the Claude model to use",
    handler: async (args) => {
      await settings.pickModel(
        args,
        (opts, idx) => pick(opts, { currentIdx: idx, escapable: true }),
        fetchModelsFn,
        display.print,
      );
    },
  });
  registry.register("effort", {
    description: "Set the effort level for Claude's thinking",
    handler: async (args) => {
      await settings.pickEffort(
        args,
        (opts, idx) => pick(opts, { currentIdx: idx, escapable: true }),
        display.print,
      );
    },
  });

  /**
   * Run a single prompt through runQueryFn. Notifies the session before/after
   * so it can track the AbortController for interrupt() and drain pending events
   * when the query finishes. Returns true if the query completed normally,
   * false if interrupted or errored (caller should stop draining pending prompts).
   */
  const runPrompt = async (prompt: string): Promise<boolean> => {
    const ac = new AbortController();
    session?.notifyQueryStart(ac);
    try {
      sessionId = await runQueryFn(prompt, sessionId, ac, settings.model, settings.effort) ?? sessionId;
      return !ac.signal.aborted;
    } catch (err) {
      console.error(display.c.boldRed(`\nERROR: ${fmtError(err)}`));
      logFull("ERROR", err instanceof Error ? { message: err.message, stack: err.stack } : err);
      return false;
    } finally {
      session?.notifyQueryEnd(ac.signal.aborted);
    }
  };

  // In worker mode, the prompt starts hidden — the agent waits for the foreman
  // to assign a task and is not ready for interactive input until then.
  let showPrompt = !session;

  while (true) {
    const wsAbort = session?.createWsInputPromise();
    // Use an empty prompt string when not ready for interactive input. An
    // empty promptLine suppresses the drawFresh callback so incoming messages
    // are printed cleanly without a prompt preceding or following them.
    const promptStr = session ? (showPrompt ? "\n[agent] > " : "") : "\n> ";
    const input = await ask(promptStr, () => registry.listCommands(), wsAbort);

    // ^D / ^C on empty buffer — treat as exit.
    if (input === "__eof__") {
      if (!session) { await doExit(); break; }
      const taskInfo = session.getTaskQuitInfo();
      if (taskInfo) {
        const choice = await confirmTaskQuit(taskInfo);
        if (choice === "cancel") continue;
        if (choice === "complete-and-quit") await session.completeCurrentTask();
      }
      break;
    }

    // Ignore the internal abort sentinel (fired when wsAbort resolves at the
    // same tick as the ask() call; never a user action).
    if (input === "__abort__") continue;

    // WS_FATAL: a fatal foreman_error was received — drop back to interactive REPL.
    // The session has already stopped reconnecting; just show the prompt and continue.
    if (WorkerSession.isFatalSignal(input)) {
      showPrompt = true;
      continue;
    }

    // WS_PROMPT: a task prompt or debounced event prompt is ready. Hide the
    // prompt, drain all queued prompts through runQueryFn, then show the prompt
    // again. Stops draining if a prompt is interrupted or errors.
    if (WorkerSession.isWsSignal(input)) {
      showPrompt = false;
      while (session?.hasPendingPrompts()) {
        const item = session.takeNextPrompt()!;
        if (item.fresh) sessionId = undefined; // new task → fresh conversation
        const ok = await runPrompt(item.prompt);
        if (!ok) break;
      }
      showPrompt = true;
      continue;
    }

    const action = await registry.dispatch(input);

    if (action.type === "skip") continue;

    if (action.type === "unknown_command") {
      display.print(display.c.boldRed(`Unknown command: /${action.command}`));
      continue;
    }

    if (action.type === "command") {
      const result = await registry.execute(action.name, action.args);
      if (result === "exit") break;
      if (result === "task-complete") showPrompt = false;
      continue;
    }

    if (action.type !== "query") continue;

    await runPrompt(action.prompt);

    // Drain any foreman prompts that arrived during the user's query.
    if (session) {
      while (session.hasPendingPrompts()) {
        const item = session.takeNextPrompt()!;
        if (item.fresh) sessionId = undefined;
        const ok = await runPrompt(item.prompt);
        if (!ok) break;
      }
    }
  }

  // Worker mode post-loop: send goodbye, destroy workspace, tear down I/O, exit.
  if (workerCtx) {
    await workerCtx.cleanup();
    process.exit(0);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = await loadConfig(process.argv);
  initDisplay(new Display(config));
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

  const runWorkerMode = process.argv.includes("--worker-mode");

  await main(boundRunQuery, permConfig, runWorkerMode, workspaceCfg, config.model, config.effort);
}
