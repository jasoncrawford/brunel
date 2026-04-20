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
import { loadConfig, getConfig, type BrunelConfig } from "../config.js";
import { Workspace } from "./models/workspace.js";
import { fmtError } from "../utils.js";
import { Settings } from "./models/settings.js";
import type { FetchModelsFn } from "./models/settings.js";
import { CommandRegistry, CommandController } from "./controllers/command-controller.js";
import { SettingsController } from "./controllers/settings-controller.js";
import { WorkspaceController } from "./controllers/workspace-controller.js";
import { AgentController, logFull, createFetchModelsFn } from "./controllers/agent-controller.js";
import type { AgentPermConfig } from "./controllers/agent-controller.js";

// ── BrunelAgent ───────────────────────────────────────────────────────────────

/**
 * Composition root for the Brunel agent. The constructor builds the full
 * object graph (everything except the worker-mode session, which requires an
 * async handshake). Call `start(runWorkerMode)` to complete setup and enter
 * the routing loop.
 */
export class BrunelAgent {
  readonly display: Display;
  private readonly settings: Settings;
  private readonly permConfig: AgentPermConfig;
  private readonly statusBar: StatusBar;
  private readonly input: Input;
  private readonly picker: Picker;
  private readonly agentController: AgentController;
  private readonly workspaceController: WorkspaceController;
  private readonly fetchModelsFn: FetchModelsFn;
  private readonly settingsController: SettingsController;
  private readonly controller: CommandController;

  constructor(config: BrunelConfig) {
    this.settings = new Settings({ model: config.model, effort: config.effort });
    this.statusBar = new StatusBar({ agentId: WorkerSession.generateAgentId(), settings: this.settings });
    this.display = new Display(config, this.statusBar);
    this.permConfig = {
      permissionMode: config.permissionMode,
      allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions,
    };
    this.input = new Input(this.display);
    this.picker = new Picker();
    this.agentController = new AgentController(this.display, this.picker, this.permConfig, this.settings);

    const originalCwd = process.cwd();
    const confirm = async (msg: string): Promise<boolean> => {
      this.statusBar.stop();
      this.display.print(c.amber(`\n⚠ Potential data loss:\n${msg}`));
      const idx = await this.picker.pick(["Yes, proceed", "No, cancel"]);
      return idx === 0;
    };

    const workspaceCfg = (config.githubRepo && config.githubToken)
      ? {
          workspaceDir: config.workspaceDir ?? path.join(os.homedir(), ".brunel", "workers"),
          repoUrl: config.repoUrl ?? `https://${config.githubToken}@github.com/${config.githubRepo}.git`,
        }
      : undefined;

    // Construct workspace and controller once for both REPL and worker modes.
    // In worker mode, WorkspaceController.onCreate() (called via startWorkerMode)
    // clones the repo and changes the working directory. In REPL mode it is
    // available for manual /workspace:* commands but not auto-cloned.
    const workspace = workspaceCfg
      ? new Workspace(workspaceCfg.workspaceDir, this.statusBar.agentId, workspaceCfg.repoUrl, originalCwd, confirm)
      : undefined;
    this.workspaceController = new WorkspaceController(workspace, this.display);

    this.fetchModelsFn = createFetchModelsFn(this.permConfig);
    this.settingsController = new SettingsController(this.settings, this.display);
    const registry = new CommandRegistry();
    this.controller = new CommandController(registry);
  }

  /**
   * Complete setup and enter the routing loop.
   *
   * If runWorkerMode is true, subscribes to workspace events, clones the repo,
   * connects to the foreman, and installs signal handlers before starting the
   * loop. In REPL mode the loop starts immediately with no foreman connection.
   */
  async start(runWorkerMode: boolean): Promise<void> {
    // Worker mode setup: subscribe to workspace events, create the clone,
    // configure the WorkerSession, and install signal handlers.
    const workerCtx = runWorkerMode
      ? await startWorkerMode(this.display, this.statusBar, this.picker, this.workspaceController)
      : undefined;
    const session = workerCtx?.session;
    const workerCleanup = workerCtx?.cleanup;

    // doExit handles REPL workspace cleanup and stdin/stdout teardown.
    // Only called in REPL mode (worker mode cleanup goes through workerCleanup()).
    const doExit = async () => {
      await this.workspaceController.onDestroy();
      process.stdout.write("\x1b[?2004l\r\n");
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    };

    // Print the startup banner.
    this.display.print(c.sageGreen(hr("═")));
    this.display.print(c.skyBlue(this.display.s.bold("  Brunel Agent")));
    this.display.print(c.lavender(`  Permissions: ${this.permConfig.permissionMode} | Model: ${this.settings.model ?? "default"} | Effort: ${this.settings.effort ?? "auto"} | Output: ${getConfig().verbose ? "verbose" : "quiet"} | Log: repl.log`));
    this.display.print(c.sageGreen(hr("═")));

    process.stdout.write("\x1b[?2004h"); // enable bracketed paste mode
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    let sessionId: string | undefined;

    // Register all commands. All commands are present in both REPL and worker
    // modes; commands that require a foreman connection degrade gracefully.
    // Registration happens here rather than the constructor because some
    // handlers close over start()-local state (sessionId, doExit, session).
    const registry = this.controller.registry;
    this.workspaceController.registerCommands(registry.scoped("workspace"));
    registerWorkerCommands(session, registry.scoped("worker"), this.display);
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
        this.display.print(this.display.renderer.clearBreak());
      },
    });
    registry.register("model", {
      description: "Select the Claude model to use",
      handler: async (args) => {
        await this.settingsController.pickModel(
          args,
          (opts, idx) => this.picker.pick(opts, { currentIdx: idx, escapable: true }),
          this.fetchModelsFn,
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

    /**
     * Run a single prompt through agentController.runQuery. Notifies the session
     * before/after so it can track the AbortController for interrupt() and drain
     * pending events when the query finishes. Returns true if the query completed
     * normally, false if interrupted or errored (caller should stop draining).
     */
    const runPrompt = async (prompt: string): Promise<boolean> => {
      const ac = new AbortController();
      session?.notifyQueryStart(ac);
      try {
        sessionId = await this.agentController.runQuery(prompt, sessionId, ac, this.settings.model, this.settings.effort) ?? sessionId;
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
     * Drain all pending foreman prompts through agentController.runQuery. Stops
     * draining if a prompt is interrupted or errors.
     */
    const drainPendingPrompts = async (): Promise<void> => {
      while (session?.hasPendingPrompts()) {
        const item = session.takeNextPrompt()!;
        if (item.fresh) sessionId = undefined; // new task → fresh conversation
        const ok = await runPrompt(item.prompt);
        if (!ok) break;
      }
    };

    // ── Routing ─────────────────────────────────────────────────────────────
    //
    // Session events and user input flow through a shared async event channel.
    // No promise-racing or event-to-promise adapters needed: session events push
    // directly to the channel, and ask() pushes when it receives real input.
    // The routing loop sleeps until the next event arrives.

    type RoutingEvent =
      | { type: "line"; value: string }
      | { type: "session"; event: "prompts_ready" | "fatal" };

    // Minimal async FIFO queue.
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

    // Session events push directly to the channel (and cancel any active prompt).
    if (session) {
      session.on("prompts_ready", () => {
        this.input.cancel();
        enqueueRoutingEvent({ type: "session", event: "prompts_ready" });
      });
      session.on("fatal", () => {
        this.input.cancel();
        enqueueRoutingEvent({ type: "session", event: "fatal" });
      });
    }

    // One round of readline: shows the prompt and pushes to the channel when the
    // user submits real input. Fire-and-forget — the loop calls this when ready.
    const listenForInput = (): void => {
      const promptStr = session ? "\n[agent] > " : "\n> ";
      void this.input.ask(promptStr, () => this.controller.listCommands()).then((line) => {
        if (line !== null) enqueueRoutingEvent({ type: "line", value: line });
      });
    };

    // ── Routing loop ─────────────────────────────────────────────────────
    // Sleeps until the next routing event arrives, then dispatches it.

    while (true) {
      // Skip showing the prompt when session prompts are already queued
      // (avoids briefly flashing the prompt before immediately cancelling it).
      if (session?.hasPendingPrompts()) {
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
    if (workerCleanup) {
      await workerCleanup();
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
