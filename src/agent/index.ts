import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "url";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = _require("../../package.json") as { version: string };
import { Display } from "./views/display.js";
import { c, hr } from "./views/style.js";
import { AgentStatus } from "./models/agent-status.js";
import { Input } from "./views/input.js";
import { Picker } from "./views/picker.js";
import { WorkerController } from "./controllers/worker-controller.js";
import { loadConfig, parseCommandFromArgs, type BrunelConfig } from "../config.js";
import { Workspace } from "./models/workspace.js";
import { GithubToken } from "./models/github-token.js";
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
    this.agentStatus = new AgentStatus({ settings: this.settings });
    this.display = new Display(config, this.agentStatus, this.settings);
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
   * If cliCommand is provided, the named command is executed on startup (equivalent
   * to the user typing that slash command). Commands with exitAfterRunFromArgs will
   * exit after running instead of entering the REPL loop. Commands must have
   * canRunFromArgs: true to be invocable this way.
   */

  async start(cliCommand: { command: string; args: string } | null): Promise<void> {
    // Always detect the repo so /worker:start can use it at runtime.
    const repo = await AgentStatus.getRemoteRepo();
    // Show current branch in the minimal status bar before worker mode activates.
    await this.agentStatus.refreshBranch();

    // Resolve GitHub token: config/env → gh CLI fallback.
    const { config } = this;
    const githubToken = await new GithubToken(config).resolve();
    if (!githubToken) {
      this.display.print(c.amber(
        "No GitHub token found. Run `gh auth login` or set GITHUB_TOKEN to enable workspace cloning.",
      ));
    }

    // Build workspace config. Clean URL keeps the token out of process listings;
    // auth is applied via http.extraHeader after clone (see Workspace._configureAuth).
    const repoUrl = config.repoUrl ?? (repo && githubToken
      ? `https://github.com/${repo}.git`
      : undefined);
    const workspaceCfg = repoUrl
      ? {
          workspaceDir: config.workspaceDir ?? path.join(os.homedir(), ".brunel", "workers"),
          repoUrl,
        }
      : undefined;
    const workspace = workspaceCfg
      ? new Workspace(workspaceCfg.workspaceDir, this.agentStatus.agentId, workspaceCfg.repoUrl, this.originalCwd, this.confirm, githubToken ?? undefined)
      : undefined;
    const workspaceController = new WorkspaceController(workspace, this.display, config);

    // doExit handles workspace cleanup and stdin/stdout teardown.
    // Returns true if exit should proceed, false if the user cancelled.
    // Called on exit from pure REPL mode (no active worker session).
    const doExit = async (): Promise<boolean> => {
      const ok = await workspaceController.onDestroy();
      if (!ok) return false;
      process.stdout.write("\x1b[?2004l\r\n");
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      return true;
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

    const workerController = new WorkerController(this.agentStatus, this.display, this.picker, workspaceController, repo, {
      ...(githubToken !== null && { githubToken }),
    });
    workerController.on("prompts_ready", () => {
      this.input.cancel();
      enqueueRoutingEvent({ type: "session", event: "prompts_ready" });
    });
    workerController.on("fatal", () => {
      this.input.cancel();
      enqueueRoutingEvent({ type: "session", event: "fatal" });
    });
    this.input.on("firstKeystroke", () => {
      if (workerController.isActive) {
        workerController.pauseEvents();
      }
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
      await workspaceController.onForceDestroy();
      process.stdout.write("\x1b[?2004l\r\n");
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.exit(0);
    });

    // Status bar is always shown.
    this.display.startPersistentBar();

    // Print the startup banner.
    this.display.print(c.sageGreen(hr("═")));
    this.display.print(c.skyBlue(this.display.s.bold(`  brunel-agent v${PACKAGE_VERSION}`)));
    this.display.print(c.lavender(`  Permissions: ${this.settings.permissionMode ?? "default"} | Model: ${this.settings.model ?? "default"} | Effort: ${this.settings.effort ?? "auto"} | Output: ${this.settings.verbose ? "verbose" : "quiet"} | Log: repl.log`));
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
      aliases: ["quit"],
      handler: async () => {
        if (workerController.isActive) {
          await workerController.stop();
          if (workerController.isActive) return undefined; // user cancelled
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
    const pickFn = (opts: string[], idx: number) =>
      this.picker.pick(opts, { currentIdx: idx, escapable: true });
    const settingsPickFn = (
      entries: import("./views/picker.js").SettingsMenuEntry[],
      onCycle: (i: number, v: string) => void,
    ) => this.picker.pickSettingsMenu(entries, onCycle);
    this.settingsController.registerAll(
      registry.scoped("settings"),
      registry,
      pickFn,
      settingsPickFn,
      () => this.agentController.fetchModels(),
    );

    // ── CLI command dispatch ──────────────────────────────────────────────────
    //
    // If a command was specified in CLI args (e.g. `brunel worker:start`), execute
    // it now using the same resolution logic as the REPL (suffix matching, aliases).
    // Commands must have canRunFromArgs: true; exitAfterRunFromArgs: true commands
    // exit after running instead of entering the routing loop.

    if (cliCommand) {
      const slashResult = this.controller.parseSlashCommand(`/${cliCommand.command}`);
      if (!slashResult || slashResult.type === "unknown_command") {
        process.stderr.write(`Error: Unknown command: ${cliCommand.command}\n`);
        await doExit();
        process.exit(1);
        return;
      }
      if (slashResult.type === "ambiguous_command") {
        const options = slashResult.matches.map(m => `/${m}`).join(", ");
        process.stderr.write(`Error: Ambiguous command: ${cliCommand.command} — did you mean one of: ${options}\n`);
        await doExit();
        process.exit(1);
        return;
      }
      const entry = registry.lookup(slashResult.name);
      if (!entry?.canRunFromArgs) {
        process.stderr.write(`Error: Command cannot be invoked from command line args: /${slashResult.name}\n`);
        await doExit();
        process.exit(1);
        return;
      }
      const result = await registry.execute(slashResult.name, cliCommand.args);
      if (result === "exit" || entry.exitAfterRunFromArgs) {
        await doExit();
        return;
      }
    }

    /**
     * Run a single prompt through agentController.runQuery. Notifies the session
     * before/after so it can track the AbortController for interrupt() and drain
     * pending events when the query finishes. Returns true if the query completed
     * normally, false if interrupted or errored (caller should stop draining).
     *
     * If runQuery detects a first-message stall (stallRetry: true), retries the
     * same prompt up to MAX_STALL_RETRIES times before giving up.
     */
    const MAX_STALL_RETRIES = 2;
    const runPrompt = async (prompt: string): Promise<boolean> => {
      for (let attempt = 0; attempt <= MAX_STALL_RETRIES; attempt++) {
        const ac = new AbortController();
        workerController.notifyQueryStart(ac);
        try {
          const { sessionId: newId, stats, stallRetry } = await this.agentController.runQuery(prompt, sessionId, ac);
          if (stallRetry && attempt < MAX_STALL_RETRIES) {
            // Stall before first response: retry with the same prompt. Don't
            // update sessionId — the stalled session may be in a broken state.
            continue;
          }
          sessionId = newId ?? sessionId;
          if (workerController.isActive) {
            this.agentStatus.addQueryStats(stats.inputTokens, stats.outputTokens, stats.costUsd);
          }
          if (stallRetry) {
            this.display.print(c.amber(`\n⚠ Connection stalled — giving up after ${MAX_STALL_RETRIES} retries. Please try again.`));
            return false;
          }
          return !ac.signal.aborted;
        } catch (err) {
          this.display.print(c.boldRed(`\nERROR: ${fmtError(err)}`));
          logFull("ERROR", err instanceof Error ? { message: err.message, stack: err.stack } : err);
          return false;
        } finally {
          workerController.notifyQueryEnd(ac.signal.aborted);
        }
      }
      return false;
    };

    /**
     * Drain all pending foreman prompts through agentController.runQuery. Stops
     * draining if a prompt is interrupted or errors.
     */
    const drainPendingPrompts = async (): Promise<void> => {
      while (workerController.hasPendingPrompts()) {
        const item = workerController.takeNextPrompt()!;
        if (item.resumeSessionId) {
          sessionId = item.resumeSessionId; // resume the dead worker's Claude session
        } else if (item.fresh) {
          sessionId = undefined; // new task → fresh conversation
        }
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
      const details = workerController.pendingEventDetails;
      if (details.length > 0) {
        const n = details.length;
        this.display.print(c.amber(`⚠ ${n} event${n === 1 ? "" : "s"} received (${details.join(", ")}) — /worker:resume-events to process them`));
      }
      const promptStr = workerController.isActive
        ? (workerController.hasTask() || workerController.isReserved ? "\n[agent] > " : "")
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

      // ^D on empty buffer at a visible prompt — stop worker mode then exit.
      if (userInput === "__eof__") {
        if (workerController.isActive) {
          await workerController.stop();
          if (workerController.isActive) continue; // user cancelled — stay in loop
        }
        if (!await doExit()) continue; // user cancelled data-loss confirmation — stay in loop
        break;
      }

      // ^C on empty buffer — behaviour depends on worker state:
      // - waiting (active, no task, not reserved): reserve instead of stopping
      // - reserved or active with task: stop (with confirmation if task active)
      // State 3 with a running query never reaches here — SIGINT handler handles that path.
      if (userInput === "__ctrl_c__") {
        if (workerController.isActive) {
          if (!workerController.hasTask() && !workerController.isReserved) {
            workerController.reserve();
          } else {
            await workerController.stop();
          }
        }
        continue;
      }

      const action = await this.controller.dispatch(userInput);

      if (action.type === "skip") continue;

      if (action.type === "unknown_command") {
        this.display.print(c.boldRed(`Unknown command: /${action.command}`));
        continue;
      }

      if (action.type === "ambiguous_command") {
        const options = action.matches.map(m => `/${m}`).join(", ");
        this.display.print(c.boldRed(`Ambiguous command: /${action.command} — which did you mean? ${options}`));
        continue;
      }

      if (action.type === "command") {
        const result = await registry.execute(action.name, action.args);
        // doExit() is always called here, never inside individual command handlers,
        // so every "exit" return value gets the same terminal cleanup regardless of source.
        if (result === "exit") {
          if (!await doExit()) continue; // user cancelled data-loss confirmation — stay in loop
          break;
        }
        continue;
      }

      // User typed a plain prompt → route to AgentController.runQuery.
      if (action.type !== "query") continue;

      await runPrompt(action.prompt);

      // Drain any foreman prompts that arrived during the user's query.
      await drainPendingPrompts();
    }
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = await loadConfig(process.argv);
  const cliCommand = parseCommandFromArgs(process.argv);
  await new BrunelAgent(config).start(cliCommand);
  // Force exit: after the routing loop ends, residual handles (WebSocket ping
  // timer, open sockets) can keep the event loop alive indefinitely. SIGTERM
  // already calls process.exit(0); this ensures the same for normal exits.
  process.exit(0);
}
