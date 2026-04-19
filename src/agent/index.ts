import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "url";
import { Display } from "./views/display.js";
import { c, hr } from "./views/style.js";
import { StatusBar } from "./views/status-bar.js";
import { Input } from "./views/input.js";
import { Picker } from "./views/picker.js";
import { registerWorkerCommands, startWorkerMode, WorkerSession } from "./controllers/worker-controller.js";
import type { RunQuery } from "./controllers/worker-controller.js";
import { loadConfig, getConfig } from "../config.js";
import { Workspace } from "./models/workspace.js";
import { fmtError } from "../utils.js";
import { Settings } from "./models/settings.js";
import { CommandRegistry, CommandController } from "./controllers/command-controller.js";
import { SettingsController } from "./controllers/settings-controller.js";
import { WorkspaceController } from "./controllers/workspace-controller.js";
import { AgentController, logFull, createFetchModelsFn } from "./controllers/agent-controller.js";
import type { AgentPermConfig } from "./controllers/agent-controller.js";

// ── Main ──────────────────────────────────────────────────────────────────────

export async function main(
  runQueryFn: RunQuery,
  permConfig: AgentPermConfig,
  display: Display,
  settings: Settings,
  input: Input,
  picker: Picker,
  runWorkerMode?: boolean,
  workspaceCfg?: { workspaceDir: string; repoUrl: string },
): Promise<void> {
  const statusBar = display.statusBar;
  const originalCwd = process.cwd();

  const confirm = async (msg: string): Promise<boolean> => {
    statusBar.stop();
    display.print(c.amber(`\n⚠ Potential data loss:\n${msg}`));
    const idx = await picker.pick(["Yes, proceed", "No, cancel"]);
    return idx === 0;
  };

  // Construct workspace and controller once for both REPL and worker modes.
  // In worker mode, WorkspaceController.onCreate() (called via startWorkerMode)
  // clones the repo and changes the working directory. In REPL mode it is
  // available for manual /workspace:* commands but not auto-cloned.
  const workspace = workspaceCfg
    ? new Workspace(workspaceCfg.workspaceDir, statusBar.agentId, workspaceCfg.repoUrl, originalCwd, confirm)
    : undefined;
  const workspaceController = new WorkspaceController(workspace, display);

  // Worker mode setup: subscribe to workspace events, create the clone,
  // configure the WorkerSession, and install signal handlers.
  const workerCtx = runWorkerMode
    ? await startWorkerMode(display, statusBar, picker, workspaceController)
    : undefined;
  const session = workerCtx?.session;

  const fetchModelsFn = createFetchModelsFn(permConfig);
  const settingsController = new SettingsController(settings, display);

  // Print the startup banner.
  display.print(c.sageGreen(hr("═")));
  display.print(c.skyBlue(display.s.bold("  Brunel Agent")));
  display.print(c.lavender(`  Permissions: ${permConfig.permissionMode} | Model: ${settings.model ?? "default"} | Effort: ${settings.effort ?? "auto"} | Output: ${getConfig().verbose ? "verbose" : "quiet"} | Log: repl.log`));
  display.print(c.sageGreen(hr("═")));

  process.stdout.write("\x1b[?2004h"); // enable bracketed paste mode
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let sessionId: string | undefined;

  // doExit handles REPL workspace cleanup and stdin/stdout teardown.
  // Only called in REPL mode (worker mode cleanup goes through workerCtx.cleanup()).
  const doExit = async () => {
    await workspaceController.onDestroy();
    process.stdout.write("\x1b[?2004l\r\n");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  };

  // Register all commands. All commands are present in both REPL and worker
  // modes; commands that require a foreman connection degrade gracefully.
  const registry = new CommandRegistry();
  const controller = new CommandController(registry);
  workspaceController.registerCommands(registry.scoped("workspace"));
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
      display.print(display.renderer.clearBreak());
    },
  });
  registry.register("model", {
    description: "Select the Claude model to use",
    handler: async (args) => {
      await settingsController.pickModel(
        args,
        (opts, idx) => picker.pick(opts, { currentIdx: idx, escapable: true }),
        fetchModelsFn,
      );
    },
  });
  registry.register("effort", {
    description: "Set the effort level for Claude's thinking",
    handler: async (args) => {
      await settingsController.pickEffort(
        args,
        (opts, idx) => picker.pick(opts, { currentIdx: idx, escapable: true }),
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
      console.error(c.boldRed(`\nERROR: ${fmtError(err)}`));
      logFull("ERROR", err instanceof Error ? { message: err.message, stack: err.stack } : err);
      return false;
    } finally {
      session?.notifyQueryEnd(ac.signal.aborted);
    }
  };

  /**
   * Drain all pending foreman prompts through runQueryFn. Stops draining if a
   * prompt is interrupted or errors.
   */
  const drainPendingPrompts = async (): Promise<void> => {
    while (session?.hasPendingPrompts()) {
      const item = session.takeNextPrompt()!;
      if (item.fresh) sessionId = undefined; // new task → fresh conversation
      const ok = await runPrompt(item.prompt);
      if (!ok) break;
    }
  };

  // ── Session event subscriptions ───────────────────────────────────────────
  // Subscribe to session events once at startup. Both events cancel any live
  // ask() so the routing loop wakes up and can drain queued prompts or drop
  // back to interactive mode.

  if (session) {
    session.on("prompts_ready", () => { input.cancel(); });
    session.on("fatal", () => { input.cancel(); });
  }

  // ── Routing loop ─────────────────────────────────────────────────────────
  // Takes input from the user or foreman and routes each event to the right handler:
  //   command       → execute the registered command handler
  //   user prompt   → run a query via runQueryFn (AgentController.runQuery)
  //   foreman event → WorkerSession emits "prompts_ready", ask() is cancelled,
  //                   loop drains queued prompts then resumes waiting for input

  while (true) {
    // Drain any foreman prompts that arrived between iterations (handles the
    // case where "prompts_ready" fired before ask() was active).
    if (session?.hasPendingPrompts()) {
      await drainPendingPrompts();
      continue;
    }

    const promptStr = session ? "\n[agent] > " : "\n> ";
    const userInput = await input.ask(promptStr, () => controller.listCommands());

    // ask() was cancelled by a session event ("prompts_ready" or "fatal").
    // Drain any queued prompts (no-op for "fatal") and loop back.
    if (userInput === null) {
      await drainPendingPrompts();
      continue;
    }

    // ^D / ^C on empty buffer — treat as exit.
    if (userInput === "__eof__") {
      if (!session) { await doExit(); break; }
      const taskInfo = session.getTaskQuitInfo();
      if (taskInfo) {
        const choice = await session.confirmTaskQuit(taskInfo);
        if (choice === "cancel") continue;
        if (choice === "complete-and-quit") await session.completeCurrentTask();
      }
      break;
    }

    const action = await controller.dispatch(userInput);

    if (action.type === "skip") continue;

    if (action.type === "unknown_command") {
      display.print(c.boldRed(`Unknown command: /${action.command}`));
      continue;
    }

    if (action.type === "command") {
      const result = await registry.execute(action.name, action.args);
      if (result === "exit") break;
      continue;
    }

    // User typed a plain prompt → route to AgentController.runQuery via runQueryFn.
    if (action.type !== "query") continue;

    await runPrompt(action.prompt);

    // Drain any foreman prompts that arrived during the user's query.
    await drainPendingPrompts();
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
  const settings = new Settings({ model: config.model, effort: config.effort });
  const statusBar = new StatusBar({ agentId: WorkerSession.generateAgentId(), settings });
  const display = new Display(config, statusBar);
  const permConfig = {
    permissionMode: config.permissionMode,
    allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions,
  };

  const input = new Input(display);
  const picker = new Picker();
  const agentController = new AgentController(display, picker, permConfig, settings);
  const runQuery: RunQuery = (prompt, sessionId, ac, model, effort) =>
    agentController.runQuery(prompt, sessionId, ac, model, effort);

  const workspaceCfg = (config.githubRepo && config.githubToken)
    ? {
        workspaceDir: config.workspaceDir ?? path.join(os.homedir(), ".brunel", "workers"),
        repoUrl: config.repoUrl ?? `https://${config.githubToken}@github.com/${config.githubRepo}.git`,
      }
    : undefined;

  const runWorkerMode = process.argv.includes("--worker-mode");

  await main(runQuery, permConfig, display, settings, input, picker, runWorkerMode, workspaceCfg);
}
