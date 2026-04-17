import fs from "fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, PermissionMode, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { c, hr } from "../views/display.js";
import type { Display } from "../views/display.js";
import { ask, pick, pickMultiple, pickQuestion } from "../views/input.js";
import type { PickQuestionResult } from "../views/input.js";
import { WorkerSession, registerWorkerCommands, startWorkerMode } from "./worker-controller.js";
import { getConfig } from "../../config.js";
import { Workspace, confirmIfUnsafe } from "../models/workspace.js";
import { fmtError } from "../../utils.js";
import { Settings } from "../models/settings.js";
import type { ModelInfo, FetchModelsFn, EffortValue } from "../models/settings.js";
import { CommandRegistry, CommandController } from "./command-controller.js";
import { SettingsController } from "./settings-controller.js";
import { QueryStats } from "../models/query-stats.js";
import { registerWorkspaceCommands } from "./workspace-controller.js";

// ── Log file ──────────────────────────────────────────────────────────────────

const LOG_FILE = "repl.log";

function logFull(label: string, data: unknown) {
  const entry =
    `\n${"=".repeat(70)}\n` +
    `${new Date().toISOString()}  ${label}\n` +
    `${"-".repeat(70)}\n` +
    JSON.stringify(data, null, 2) +
    "\n";
  fs.appendFileSync(LOG_FILE, entry);
}

// ── Types ─────────────────────────────────────────────────────────────────────

type QuestionOption = { label: string; description: string };
type Question = { question: string; header: string; options: QuestionOption[]; multiSelect: boolean };

export type AgentPermConfig = {
  permissionMode: PermissionMode;
  allowDangerouslySkipPermissions: boolean;
};

// ── AgentController ───────────────────────────────────────────────────────────

/**
 * Controls the agent query loop and REPL. Owns the Claude SDK interaction,
 * session ID management, tool permission handling, startup banner, and the
 * main prompt loop. Constructed in index.ts and started via start().
 */
export class AgentController {
  constructor(
    private display: Display,
    private permConfig: AgentPermConfig,
    private settings: Settings,
  ) {}

  /**
   * Run a single prompt through the Claude SDK. Manages the status bar,
   * streams output, handles tool permissions, and returns the session ID
   * so the next turn can resume the same conversation.
   */
  async runQuery(
    prompt: string,
    sessionId: string | undefined,
    abortController?: AbortController,
    model?: string,
    effort?: EffortValue,
  ): Promise<string | undefined> {
    logFull("QUERY", { prompt, sessionId });
    const { display, permConfig } = this;
    const statusBar = display.statusBar;
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
    const getStatusText = () => c.darkGray(stats.getStatusText());
    statusBar.start(getStatusText);

    const canUseTool: CanUseTool = async (toolName, input) => {
      if (toolName === "AskUserQuestion") {
        return this.handleAskUserQuestion(input, getStatusText);
      }
      if (permConfig.allowDangerouslySkipPermissions) return { behavior: "allow", updatedInput: input };
      return this.handleToolPermission(toolName, input, getStatusText);
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
    type QueryWithModels = { supportedModels?: () => Promise<ModelInfo[]> };
    const qm = iterable as unknown as QueryWithModels;
    if (typeof qm.supportedModels === "function") {
      qm.supportedModels().then(models => { Settings.setCachedModels(models); }).catch(() => {});
    }

    // Register a temporary raw-stdin listener to catch ^C and abort the query.
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

        if (message.type === "stream_event") {
          if (message.parent_tool_use_id == null) {
            stats.update(message.event as Parameters<typeof stats.update>[0]);
          }
          continue;
        }

        if (message.type === "result") {
          resultReceived = true;
          statusBar.stop();
        }

        display.printMessage(message);
      }
    } catch (err) {
      if (!(err instanceof Error && /aborted by user/i.test(err.message))) throw err;
    } finally {
      process.stdin.removeListener("data", onInterrupt);
    }

    statusBar.stop();

    if (!resultReceived) {
      display.print(c.darkGray("\nInterrupted. What should the agent do instead?"));
    }

    statusBar.inputPrint = savedInputCallback;
    statusBar.inputStatus = savedStatusCallback;
    statusBar.inputClear = savedClearCallback;
    savedInputCallback?.();

    return capturedSessionId;
  }

  /**
   * Run the REPL loop. Sets up worker mode if requested, prints the startup
   * banner, registers all commands, and loops reading prompts until exit.
   */
  async start(
    runWorkerMode?: boolean,
    workspaceCfg?: { workspaceDir: string; repoUrl: string },
  ): Promise<void> {
    const { display, permConfig, settings } = this;
    const statusBar = display.statusBar;

    // Worker mode setup: create workspace, session, signal handlers.
    const workerCtx = runWorkerMode ? await startWorkerMode(display, statusBar) : undefined;
    const session = workerCtx?.session;

    const fetchModelsFn = this.createFetchModelsFn();
    const settingsController = new SettingsController(settings, display);

    // Print the startup banner.
    display.print(c.sageGreen(hr("═")));
    display.print(c.skyBlue(display.s.bold("  Brunel Agent")));
    display.print(c.lavender(`  Permissions: ${permConfig.permissionMode} | Model: ${settings.model ?? "default"} | Effort: ${settings.effort ?? "auto"} | Output: ${getConfig().verbose ? "verbose" : "quiet"} | Log: ${LOG_FILE}`));
    display.print(c.sageGreen(hr("═")));

    process.stdout.write("\x1b[?2004h"); // enable bracketed paste mode
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    let sessionId: string | undefined;
    const originalCwd = process.cwd();

    const confirm = async (msg: string): Promise<boolean> => {
      statusBar.stop();
      display.print(c.amber(`\n⚠ Potential data loss:\n${msg}`));
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
    const doExit = async () => {
      if (workspace?.isCreated) {
        const ok = await confirmIfUnsafe(workspace, workspace.confirm);
        if (ok) await workspace.destroy();
      }
      process.stdout.write("\x1b[?2004l\r\n");
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    };

    // Register all commands.
    const registry = new CommandRegistry();
    const controller = new CommandController(registry);
    registerWorkspaceCommands(workspace, registry.scoped("workspace"), display);
    registerWorkerCommands(session, registry.scoped("worker"), display);
    registry.register("exit", {
      description: "Exit",
      handler: async () => {
        if (!session) { await doExit(); return "exit"; }
        const taskInfo = session.getTaskQuitInfo();
        if (taskInfo) {
          const choice = await session.confirmTaskQuit(taskInfo);
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
        await settingsController.pickModel(
          args,
          (opts, idx) => pick(opts, { currentIdx: idx, escapable: true }),
          fetchModelsFn,
        );
      },
    });
    registry.register("effort", {
      description: "Set the effort level for Claude's thinking",
      handler: async (args) => {
        await settingsController.pickEffort(
          args,
          (opts, idx) => pick(opts, { currentIdx: idx, escapable: true }),
        );
      },
    });

    /**
     * Run a single prompt through runQuery. Notifies the session before/after
     * so it can track the AbortController for interrupt() and drain pending events.
     */
    const runPrompt = async (prompt: string): Promise<boolean> => {
      const ac = new AbortController();
      session?.notifyQueryStart(ac);
      try {
        sessionId = await this.runQuery(prompt, sessionId, ac, settings.model, settings.effort) ?? sessionId;
        return !ac.signal.aborted;
      } catch (err) {
        console.error(c.boldRed(`\nERROR: ${fmtError(err)}`));
        logFull("ERROR", err instanceof Error ? { message: err.message, stack: err.stack } : err);
        return false;
      } finally {
        session?.notifyQueryEnd(ac.signal.aborted);
      }
    };

    let showPrompt = !session;

    while (true) {
      const wsAbort = session?.createWsInputPromise();
      const promptStr = session ? (showPrompt ? "\n[agent] > " : "") : "\n> ";
      const input = await ask(statusBar, promptStr, () => controller.listCommands(), wsAbort);

      if (input === "__eof__") {
        if (!session) { await doExit(); break; }
        const taskInfo = session.getTaskQuitInfo();
        if (taskInfo) {
          const choice = await session.confirmTaskQuit(taskInfo);
          if (choice === "cancel") continue;
          if (choice === "complete-and-quit") await session.completeCurrentTask();
        }
        break;
      }

      if (input === "__abort__") continue;

      if (WorkerSession.isFatalSignal(input)) {
        showPrompt = true;
        continue;
      }

      if (WorkerSession.isWsSignal(input)) {
        showPrompt = false;
        while (session?.hasPendingPrompts()) {
          const item = session.takeNextPrompt()!;
          if (item.fresh) sessionId = undefined;
          const ok = await runPrompt(item.prompt);
          if (!ok) break;
        }
        showPrompt = true;
        continue;
      }

      const action = await controller.dispatch(input);

      if (action.type === "skip") continue;

      if (action.type === "unknown_command") {
        display.print(c.boldRed(`Unknown command: /${action.command}`));
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

  // ── Private helpers ────────────────────────────────────────────────────────

  private async handleAskUserQuestion(
    input: Record<string, unknown>,
    getStatusText: () => string,
  ): Promise<PermissionResult> {
    const { display } = this;
    display.statusBar.stop();
    const questions = (input.questions as Question[]) ?? [];
    const answers: Record<string, string> = {};

    for (const q of questions) {
      display.print(c.yellow(`\n? ${q.question}`));
      if (q.multiSelect) {
        const lines = q.options.map((o: QuestionOption) => o.description ? `${o.label} — ${o.description}` : o.label);
        const idxs = await pickMultiple(lines);
        answers[q.question] = idxs.map((i: number) => q.options[i].label).join(", ");
      } else {
        const result: PickQuestionResult = await pickQuestion(q.options);
        if (result.type === "discuss") {
          display.statusBar.start(getStatusText);
          return { behavior: "deny", message: "The user would like to discuss more before answering. Prompt them to begin the discussion." };
        }
        answers[q.question] = result.type === "answer" ? result.value : result.text;
      }
    }

    display.statusBar.start(getStatusText);
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }

  private async handleToolPermission(
    toolName: string,
    input: Record<string, unknown>,
    getStatusText: () => string,
  ): Promise<PermissionResult> {
    const { display } = this;
    display.statusBar.stop();
    display.print(c.amber(`\n⚠ ${toolName}(${display.fmtArgs(input)})`));
    const idx = await pick(["Allow", "Deny"]);
    display.statusBar.start(getStatusText);
    if (idx === 0) return { behavior: "allow", updatedInput: input };
    return { behavior: "deny", message: "User denied tool request" };
  }

  private createFetchModelsFn(): FetchModelsFn {
    const { permConfig } = this;
    return async () => {
      const q = query({ prompt: "", options: { cwd: process.cwd(), systemPrompt: { type: "preset", preset: "claude_code" }, permissionMode: permConfig.permissionMode } });
      type QueryWithModels = { supportedModels?: () => Promise<ModelInfo[]> };
      const qm = q as unknown as QueryWithModels;
      if (typeof qm.supportedModels === "function") return qm.supportedModels();
      return [];
    };
  }
}
