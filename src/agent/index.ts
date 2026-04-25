import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "url";
import { Display } from "./views/display.js";
import { c, hr } from "./views/style.js";
import { AgentStatus } from "./models/agent-status.js";
import { Input } from "./views/input.js";
import { Picker } from "./views/picker.js";
import { WorkerController } from "./controllers/worker-controller.js";
import { loadConfig, getConfig, type BrunelConfig } from "../config.js";
import { Workspace } from "./models/workspace.js";
import { fmtError } from "../utils.js";
import { Settings } from "./models/settings.js";
import { CommandRegistry, CommandController } from "./controllers/command-controller.js";
import { SettingsController } from "./controllers/settings-controller.js";
import { WorkspaceController } from "./controllers/workspace-controller.js";
import { AgentController, logFull } from "./controllers/agent-controller.js";

// ── BrunelAgent ───────────────────────────────────────────────────────────────

/**
 * Composition root for the Brunel agent. The constructor builds the full
 * object graph (everything except the worker-mode session, which requires an
 * async handshake). Call `start(runWorkerMode)` to complete setup and enter
 * the routing loop.
 */
export class BrunelAgent {
  readonly display: Display;
  private readonly config: BrunelConfig;
  private readonly settings: Settings;
  private readonly agentStatus: AgentStatus;
  private readonly input: Input;
  private readonly picker: Picker;
  private readonly agentController: AgentController;
  private readonly settingsController: SettingsController;
  private readonly controller: CommandController;
  private readonly originalCwd: string;
  private readonly confirm: (msg: string) => Promise<boolean>;

  constructor(config: BrunelConfig) {
    this.config = config;
    this.settings = new Settings(config);
    this.agentStatus = new AgentStatus({ agentId: AgentStatus.generateAgentId(), settings: this.settings });
    this.display = new Display(config, this.agentStatus);
    this.input = new Input(this.display);
    this.picker = new Picker(this.display, () => this.input.cancel());
    this.agentController = new AgentController(this.display, this.picker, this.settings);
    this.originalCwd = process.cwd();
    this.confirm = async (msg: string): Promise<boolean> => {
      this.display.stopBar();
      this.display.print(c.amber(`\n⚠ Potential data loss:\n${msg}`));
      const idx = await this.picker.pick(["Yes, proceed", "No, cancel"]);
      return idx === 0;
    };

    this.settingsController = new SettingsController(this.settings, this.display);
    const registry = new CommandRegistry();
    this.controller = new CommandController(registry);
  }

  /**
   * Complete setup and enter the routing loop.
   *
   * If runWorkerMode is true, connects to the foreman immediately (equivalent
   * to running /worker:start on startup). Worker mode can also be toggled at
   * runtime via /worker:start and /worker:stop. The status bar is always shown.
   */
  async start(runWorkerMode: boolean): Promise<void> {
    // Always detect the repo so /worker:start can use it at runtime.
    const repo = await AgentStatus.getRemoteRepo();
    // Show current branch in the minimal status bar before worker mode activates.
    this.agentStatus.update({ branch: await AgentStatus.getCurrentBranch() });

    // Build workspace config after repo detection. repoUrl can be set explicitly
    // in config; otherwise it's derived from the detected git remote + token.
    const { config } = this;
    const repoUrl = config.repoUrl ?? (repo && config.githubToken
      ? `https://${config.githubToken}@github.com/${repo}.git`
      : undefined);
    const workspaceCfg = repoUrl
      ? {
          workspaceDir: config.workspaceDir ?? path.join(os.homedir(), ".brunel", "workers"),
          repoUrl,
        }
      : undefined;
    const workspace = workspaceCfg
      ? new Workspace(workspaceCfg.workspaceDir, this.agentStatus.agentId, workspaceCfg.repoUrl, this.originalCwd, this.confirm)
      : undefined;
    const workspaceController = new WorkspaceController(workspace, this.display, config);

    // doExit handles workspace cleanup and stdin/stdout teardown.
    // Called on exit from pure REPL mode (no active worker session).
    const doExit = async () => {
      await workspaceController.onDestroy();
      process.stdout.write("\x1b[?2004l\r\n");
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    };

    // ── Routing queue ─────────────────────────────────────────────────────────
    //
    // Defined early so the prompts_ready/fatal listeners (which fire before the
    // routing loop starts) can enqueue session events into it.

    type RoutingEvent =
      | { type: "line"; value: string }
      | { type: "session"; event: "prompts_ready" | "fatal" };

    const routingQueue: RoutingEvent[] = [];
    let routingWaiter: ((e: RoutingEvent) => void) | null = null;

    const enqueueRoutingEvent = (event: RoutingEvent): void => {
      if (routingWaiter) { const w = routingWaiter; routingWaiter = null; w(event); }
      else routingQueue.push(event);
    };

    const nextRoutingEvent = (): Promise<RoutingEvent> => {
      if (routingQueue.length) return Promise.resolve(routingQueue.shift()!);
      return new Promise((resolve) => { routingWaiter = resolve; });
    };

    // ── Worker controller ─────────────────────────────────────────────────────

    const workerController = new WorkerController(this.display, this.picker, workspaceController, repo);
    workerController.on("prompts_ready", () => {
      this.input.cancel();
      enqueueRoutingEvent({ type: "session", event: "prompts_ready" });
    });
    workerController.on("fatal", () => {
      this.input.cancel();
      enqueueRoutingEvent({ type: "session", event: "fatal" });
    });

    // ── Signal handlers ───────────────────────────────────────────────────────
    //
    // Registered once; close over `session` so they always see the current state
    // regardless of when worker mode is started or stopped.

    process.on("SIGINT", () => {
      if (!workerController.interrupt()) {
        // Nothing to interrupt — print a newline to keep the terminal tidy.
        process.stdout.write("\n");
      }
    });
    process.on("SIGTERM", async () => {
      workerController.sendGoodbye();
      await doExit();
      process.exit(0);
    });

    // Start worker mode immediately if requested via --worker-mode flag.
    if (runWorkerMode) {
      await workerController.start();
    }

    // Status bar is always shown regardless of worker mode.
    this.display.startPersistentBar();

    // Print the startup banner.
    this.display.print(c.sageGreen(hr("═")));
    this.display.print(c.skyBlue(this.display.s.bold("  Brunel Agent")));
    this.display.print(c.lavender(`  Permissions: ${this.settings.permissionMode ?? "default"} | Model: ${this.settings.model ?? "default"} | Effort: ${this.settings.effort ?? "auto"} | Output: ${getConfig().verbose ? "verbose" : "quiet"} | Log: repl.log`));
    this.display.print(c.sageGreen(hr("═")));

    process.stdout.write("\x1b[?2004h"); // enable bracketed paste mode
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    let sessionId: string | undefined;

    // Register all commands. All commands are present in both REPL and worker
    // modes; commands that require a foreman connection degrade gracefully.
    const registry = this.controller.registry;
    workspaceController.registerCommands(registry.scoped("workspace"));
    workerController.registerCommands(registry.scoped("worker"));
    registry.register("exit", {
      description: "Exit",
      handler: async () => {
        if (!workerController.isActive) { await doExit(); return "exit"; }
        const taskInfo = workerController.getTaskQuitInfo();
        if (taskInfo) {
          const choice = await workerController.confirmTaskQuit(taskInfo);
          if (choice === "cancel") return undefined;
          if (choice === "complete-and-quit") await workerController.completeCurrentTask();
        }
        return "exit";
      },
    });
    registry.register("clear", {
      description: "Clear the conversation",
      handler: async () => {
        sessionId = undefined;
        this.display.print(this.display.renderer.clearBreak());
      },
    });
    registry.register("model", {
      description: "Select the Claude model to use",
      handler: async (args) => {
        await this.settingsController.pickModel(
          args,
          (opts, idx) => this.picker.pick(opts, { currentIdx: idx, escapable: true }),
          () => this.agentController.fetchModels(),
        );
      },
    });
    registry.register("effort", {
      description: "Set the effort level for Claude's thinking",
      handler: async (args) => {
        await this.settingsController.pickEffort(
          args,
          (opts, idx) => this.picker.pick(opts, { currentIdx: idx, escapable: true }),
        );
      },
    });
    registry.register("permissions", {
      description: "Set the permission mode for tool use",
      handler: async (args) => {
        await this.settingsController.pickPermissions(
          args,
          (opts, idx) => this.picker.pick(opts, { currentIdx: idx, escapable: true }),
        );
      },
    });

    /**
     * Run a single prompt through agentController.runQuery. Notifies the session
     * before/after so it can track the AbortController for interrupt() and drain
     * pending events when the query finishes. Returns true if the query completed
     * normally, false if interrupted or errored (caller should stop draining).
     */
    const runPrompt = async (prompt: string): Promise<boolean> => {
      const ac = new AbortController();
      workerController.notifyQueryStart(ac);
      try {
        const { sessionId: newId, stats } = await this.agentController.runQuery(prompt, sessionId, ac);
        sessionId = newId ?? sessionId;
        if (workerController.isActive) {
          this.agentStatus.addQueryStats(stats.inputTokens, stats.outputTokens, stats.costUsd);
        }
        return !ac.signal.aborted;
      } catch (err) {
        console.error(c.boldRed(`\nERROR: ${fmtError(err)}`));
        logFull("ERROR", err instanceof Error ? { message: err.message, stack: err.stack } : err);
        return false;
      } finally {
        workerController.notifyQueryEnd(ac.signal.aborted);
      }
    };

    /**
     * Drain all pending foreman prompts through agentController.runQuery. Stops
     * draining if a prompt is interrupted or errors.
     */
    const drainPendingPrompts = async (): Promise<void> => {
      while (workerController.hasPendingPrompts()) {
        const item = workerController.takeNextPrompt()!;
        if (item.fresh) sessionId = undefined; // new task → fresh conversation
        const ok = await runPrompt(item.prompt);
        if (!ok) break;
      }
    };

    // ── Routing loop ──────────────────────────────────────────────────────────
    //
    // Session events and user input flow through the shared async event channel
    // defined above. The routing loop sleeps until the next event arrives.

    // One round of readline: shows the prompt and pushes to the channel when the
    // user submits real input. Fire-and-forget — the loop calls this when ready.
    // In worker mode with no active task, use an empty prompt so stdin remains
    // active (^D / ^C still work) but no "[agent] > " is displayed while waiting.
    const listenForInput = (): void => {
      const promptStr = workerController.isActive
        ? (workerController.hasTask() ? "\n[agent] > " : "")
        : "\n> ";
      void this.input.ask(promptStr, () => this.controller.listCommands()).then((line) => {
        if (line !== null) enqueueRoutingEvent({ type: "line", value: line });
      });
    };

    while (true) {
      // Skip showing the prompt when session prompts are already queued
      // (avoids briefly flashing the prompt before immediately cancelling it).
      if (workerController.hasPendingPrompts()) {
        await drainPendingPrompts();
        continue;
      }

      listenForInput();
      const event = await nextRoutingEvent();

      if (event.type === "session") {
        // Always cancel the active ask() here. When "prompts_ready" fires while the
        // routing loop is executing (not sleeping in nextRoutingEvent), cancel() in the
        // session event handler is a no-op because ask() hasn't started yet. The event
        // lands in routingQueue. Later, listenForInput() starts a new ask(), then
        // nextRoutingEvent() returns the stale event immediately — without this call,
        // that ask() would never be cancelled, creating orphaned stdin listeners.
        this.input.cancel();
        await drainPendingPrompts(); // no-op for "fatal"
        continue;
      }

      // event.type === "line" — real user input
      const userInput = event.value;

      // ^D on empty buffer — treat as exit.
      if (userInput === "__eof__") {
        if (!workerController.isActive) { await doExit(); break; }
        const taskInfo = workerController.getTaskQuitInfo();
        if (taskInfo) {
          const choice = await workerController.confirmTaskQuit(taskInfo);
          if (choice === "cancel") continue;
          if (choice === "complete-and-quit") await workerController.completeCurrentTask();
        }
        break;
      }

      // ^C on empty buffer — stop worker mode if idle; otherwise ignore
      // (the running query was already interrupted by the SIGINT handler).
      if (userInput === "__ctrl_c__") {
        if (workerController.isActive && !workerController.hasTask()) {
          await workerController.stop();
        }
        continue;
      }

      const action = await this.controller.dispatch(userInput);

      if (action.type === "skip") continue;

      if (action.type === "unknown_command") {
        this.display.print(c.boldRed(`Unknown command: /${action.command}`));
        continue;
      }

      if (action.type === "command") {
        const result = await registry.execute(action.name, action.args);
        if (result === "exit") break;
        continue;
      }

      // User typed a plain prompt → route to AgentController.runQuery.
      if (action.type !== "query") continue;

      await runPrompt(action.prompt);

      // Drain any foreman prompts that arrived during the user's query.
      await drainPendingPrompts();
    }

    // Worker mode post-loop: send goodbye, destroy workspace, tear down I/O, exit.
    if (workerController.isCleanupPending) {
      await workerController.cleanup();
      process.exit(0);
    }
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = await loadConfig(process.argv);
  const runWorkerMode = process.argv.includes("--worker-mode");
  await new BrunelAgent(config).start(runWorkerMode);
}
