import "dotenv/config";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import * as display from "./display.js";
import { buildInitialPrompt, buildEventPrompt } from "./templates.js";
import { ask, listWorkerCommands, dispatchInput, pick } from "./input.js";
import { handleModelCommand } from "./model.js";
import { handleEffortCommand } from "./effort.js";
import type { EffortValue } from "./effort.js";
import type { ForemanMessage, GitHubEvent, TaskIssue, WorkerMessage } from "../types.js";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { Workspace, confirmIfUnsafe, registerWorkspaceCommands } from "./workspace.js";
import { fmtError, generateWorkerId } from "../utils.js";
import { _reset, register, execute } from "./commands.js";

const execAsync = promisify(exec);

// ── Event classification ───────────────────────────────────────────────────────

export function classifyEvent(event: GitHubEvent): "actionable" | "log_only" {
  const action = event.payload["action"] as string | undefined;

  switch (event.name) {
    case "check_run":
      return "log_only";

    case "check_suite": {
      if (action !== "completed") return "log_only";
      const conclusion = (event.payload.check_suite as Record<string, unknown> | undefined)?.conclusion;
      return conclusion === "skipped" ? "log_only" : "actionable";
    }

    case "pull_request":
      return (action === "closed" || action === "auto_merge_enabled") ? "actionable" : "log_only";

    case "pull_request_review":
    case "pull_request_review_comment":
      return "actionable";

    case "issue_comment": {
      const body = (event.payload.comment as Record<string, unknown> | undefined)?.body;
      if (typeof body === "string" && body.startsWith("<!-- railway-bot-comment")) return "log_only";
      return "actionable";
    }

    default:
      return "log_only";
  }
}

// ── Debounce duration ──────────────────────────────────────────────────────────

export function debounceMs(events: GitHubEvent[]): number {
  if (events.some(e => e.name === "pull_request" && e.payload["action"] === "closed")) {
    return 0;
  }
  if (events.some(e => {
    if (e.name !== "check_suite") return false;
    const conclusion = (e.payload.check_suite as Record<string, unknown> | undefined)?.conclusion as string | undefined;
    return conclusion === "failure" || conclusion === "action_required";
  })) {
    return 3000;
  }
  if (events.length > 0 && events.every(e => e.name === "check_suite")) {
    return 30000;
  }
  return 3000;
}

// ── WorkerStatusModel ─────────────────────────────────────────────────────────

export type WorkerConnectionStatus = "connected" | "disconnected" | "reconnecting" | "handshaking";

export type WorkerStatusPatch = {
  connectionStatus?: WorkerConnectionStatus;
  disconnectCode?: number | undefined;
  reconnectAt?: number | undefined;
  taskNumber?: number | undefined;
  prNumber?: number | undefined;
  branch?: string;
  model?: string | undefined;
  effort?: string | undefined;
};

/**
 * Reactive model for worker status bar state. Emits "change" whenever state
 * changes so the display can subscribe and refresh without manual refresh calls.
 * When reconnectAt is set the model starts a 1-second interval to emit "change"
 * (driving the countdown display); the interval stops when reconnectAt is cleared.
 */
export class WorkerStatusModel extends EventEmitter {
  private _connectionStatus: WorkerConnectionStatus = "disconnected";
  private _disconnectCode: number | undefined;
  private _reconnectAt: number | undefined;
  private _taskNumber: number | undefined;
  private _prNumber: number | undefined;
  private _branch = "";
  private _model: string | undefined;
  private _effort: string | undefined;
  private _countdownTimer: ReturnType<typeof setInterval> | null = null;

  constructor(public readonly workerId: string) {
    super();
  }

  get connectionStatus(): WorkerConnectionStatus { return this._connectionStatus; }
  get disconnectCode(): number | undefined { return this._disconnectCode; }
  get reconnectAt(): number | undefined { return this._reconnectAt; }
  get taskNumber(): number | undefined { return this._taskNumber; }
  get prNumber(): number | undefined { return this._prNumber; }
  get branch(): string { return this._branch; }
  get model(): string | undefined { return this._model; }
  get effort(): string | undefined { return this._effort; }

  /** Apply a partial update and emit "change". Multiple fields in one call = one event. */
  update(patch: WorkerStatusPatch): void {
    if ("connectionStatus" in patch) this._connectionStatus = patch.connectionStatus!;
    if ("disconnectCode" in patch) this._disconnectCode = patch.disconnectCode;
    if ("reconnectAt" in patch) {
      this._reconnectAt = patch.reconnectAt;
      this._syncCountdownTimer();
    }
    if ("taskNumber" in patch) this._taskNumber = patch.taskNumber;
    if ("prNumber" in patch) this._prNumber = patch.prNumber;
    if ("branch" in patch) this._branch = patch.branch!;
    if ("model" in patch) this._model = patch.model;
    if ("effort" in patch) this._effort = patch.effort;
    this.emit("change");
  }

  private _syncCountdownTimer(): void {
    if (this._reconnectAt != null) {
      if (!this._countdownTimer) {
        this._countdownTimer = setInterval(() => this.emit("change"), 1000);
      }
    } else {
      if (this._countdownTimer) {
        clearInterval(this._countdownTimer);
        this._countdownTimer = null;
      }
    }
  }

  getStatusText(): string {
    const retryInSeconds = this._reconnectAt != null
      ? Math.max(0, Math.ceil((this._reconnectAt - Date.now()) / 1000))
      : undefined;
    return display.fmtWorkerStatus({
      workerId: this.workerId,
      model: this._model,
      effort: this._effort,
      taskNumber: this._taskNumber,
      prNumber: this._prNumber,
      branch: this._branch || undefined,
      connectionStatus: this._connectionStatus,
      disconnectCode: this._disconnectCode,
      retryInSeconds,
    });
  }
}

// ── WorkerSession ─────────────────────────────────────────────────────────────

export type WsFactory = (workerId: string, taskId?: string) => WebSocket;
export type RunQuery = (prompt: string, sessionId: string | undefined, abortController?: AbortController, model?: string, effort?: EffortValue) => Promise<string | undefined>;
export type WorkerDisplay = {
  print: (line: string | null) => void;
  printForemanMessage: (msg: ForemanMessage) => void;
  startPersistentStatus?: (getText: () => string) => void;
  stopPersistentStatus?: () => void;
  updatePersistentStatus?: () => void;
  /** Register a callback fired after each tool result (tool has just finished). */
  setOnToolResultCallback?: (fn: ((toolName: string) => void) | null) => void;
};

export type WorkspaceCtx = {
  workspace: Workspace;
  originalCwd: string;
  workspaceDir: string;
  repoUrl: string;
  confirm: (msg: string) => Promise<boolean>;
};

export type WorkerSessionOptions = {
  afterTask?: () => Promise<void>;
  workspaceCtx?: WorkspaceCtx;
  /** Interval in ms between worker-sent pings. Dead connections are detected after
   * one interval with no pong. Default is set in the config schema (pingIntervalMs). */
  pingIntervalMs?: number;
};

// Sentinels used to signal WebSocket events through ask()'s abort param
const WS_TASK_ASSIGNED = "__task_assigned__";
const WS_EVENT = "__event__";

// Messages that must wait for hello_ack before being sent.
type BufferableMessage = Extract<WorkerMessage, { type: "task_complete" }>;

export class WorkerSession {
  private currentTaskId: string | undefined;
  private currentIssue: TaskIssue | undefined;
  private currentSessionId: string | undefined;
  private pendingEvents: GitHubEvent[] = [];
  private ws: WebSocket | undefined;
  private resolveWsInput: ((v: string) => void) | null = null;
  private isRunningQuery = false;
  private currentAc: AbortController | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private prIsClosed = false;
  private queryDoneResolvers: Array<() => void> = [];
  // Handshake lifecycle: "registered" = hello_ack received (or initial state);
  // "hello_sent" = worker_hello was sent but hello_ack not yet received.
  // Initialized to "registered" so sessions that never emit "open" (e.g. tests)
  // behave as if already registered.
  private connectionState: "hello_sent" | "registered" = "registered";
  private bufferedMessages: BufferableMessage[] = [];
  private _currentModel: string | undefined;
  private _currentEffort: EffortValue | undefined;

  // Reactive status bar model: emits "change" on any state mutation, so the
  // display subscription in start() automatically refreshes without manual calls.
  private statusModel: WorkerStatusModel;

  constructor(
    private workerId: string,
    private wsFactory: WsFactory,
    private runQuery: RunQuery,
    private display: WorkerDisplay,
    private options: WorkerSessionOptions = {},
  ) {
    this.statusModel = new WorkerStatusModel(workerId);
  }

  get currentModel(): string | undefined { return this._currentModel; }
  set currentModel(model: string | undefined) {
    this._currentModel = model;
    this.statusModel.update({ model });
  }

  get currentEffort(): EffortValue | undefined { return this._currentEffort; }
  set currentEffort(effort: EffortValue | undefined) {
    this._currentEffort = effort;
    this.statusModel.update({ effort });
  }

  /** Returns the formatted worker status bar text. Used by startPersistentStatus and tests. */
  getStatusText(): string {
    return this.statusModel.getStatusText();
  }

  private async refreshBranch(): Promise<void> {
    let branch = "";
    try {
      const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD");
      branch = stdout.trim();
    } catch {
      branch = "";
    }
    this.statusModel.update({ branch });
  }

  start(): void {
    this._registerCommands();
    // Subscribe to model changes — the display refreshes automatically whenever
    // any status field changes, without needing explicit refreshStatus() calls.
    this.statusModel.on("change", () => this.display.updatePersistentStatus?.());
    this.display.startPersistentStatus?.(() => this.statusModel.getStatusText());
    this.display.setOnToolResultCallback?.((toolName) => {
      // Refresh the branch display after each Bash tool completes so the status
      // bar reflects branch changes (e.g. git checkout) without waiting for the
      // full query to finish.
      if (toolName === "Bash") void this.refreshBranch();
    });
    void this.refreshBranch();
    this.connect();
  }

  private _registerCommands(): void {
    const ctx = this.options.workspaceCtx;
    _reset();
    register("worker:task-complete", {
      description: "Mark the current task as done",
      availability: "worker",
      handler: async () => {
        if (!this.currentTaskId) return;
        if (this.options.afterTask) {
          try { await this.options.afterTask(); } catch { return; }
        }
        this.sendTaskMessage({
          type: "task_complete",
          workerId: this.workerId,
          taskId: this.currentTaskId,
        });
        this.currentTaskId = undefined;
        this.currentIssue = undefined;
        this.currentSessionId = undefined;
        this.statusModel.update({ taskNumber: undefined, prNumber: undefined, branch: "" });
        this.display.print(display.c.sageGreen("Task complete. Waiting for next task..."));
        return "task-complete";
      },
    });
    register("exit", {
      description: "Exit the worker",
      handler: async () => "exit",
    });
    register("clear", {
      description: "Clear the conversation",
      handler: async () => {
        this.currentSessionId = undefined;
        this.display.print(display.clearBreak());
      },
    });
    register("model", {
      description: "Select the Claude model to use",
      handler: async (args) => {
        const pickModelFn = (opts: string[], idx: number) =>
          pick(opts, { currentIdx: idx, escapable: true });
        this.currentModel = await handleModelCommand(
          args, this._currentModel, pickModelFn,
          undefined, // models cached from first query; no fetchModelsFn in worker
          this.display.print,
        );
      },
    });
    register("effort", {
      description: "Set the effort level for Claude's thinking",
      handler: async (args) => {
        const pickEffortFn = (opts: string[], idx: number) =>
          pick(opts, { currentIdx: idx, escapable: true });
        this.currentEffort = await handleEffortCommand(
          args, this._currentEffort, pickEffortFn,
          this.display.print,
        );
      },
    });
    const self = this;
    registerWorkspaceCommands({
      workspace: {
        get current() { return self.options.workspaceCtx?.workspace; },
        set current(ws: Workspace | undefined) {
          if (self.options.workspaceCtx) {
            if (ws) { self.options.workspaceCtx.workspace = ws; }
            else { self.options.workspaceCtx = undefined; }
          }
        },
      },
      config: ctx ? { workspaceDir: ctx.workspaceDir, repoUrl: ctx.repoUrl, sessionId: self.workerId } : undefined,
      originalCwd: ctx?.originalCwd ?? process.cwd(),
      confirm: ctx?.confirm ?? (() => Promise.resolve(false)),
    }, true); // workerMode=true: workspace:create prints "managed automatically"
  }

  /**
   * Create a new one-shot promise that resolves when the WebSocket delivers
   * a task or event signal. Each call abandons the previous promise.
   */
  createWsInputPromise(): Promise<string> {
    return new Promise<string>((resolve) => {
      this.resolveWsInput = resolve;
    });
  }

  /**
   * Resolves when no query is currently running and no debounce timer is
   * pending. If a query is already running, waits until runQueryLoop
   * completes (including any pending events it drains). If a debounce timer
   * is pending (event arrived but query not yet started), waits for the
   * debounce to fire and the resulting query to complete. Multiple
   * concurrent callers are all notified.
   */
  async waitUntilIdle(): Promise<void> {
    while (this.isRunningQuery || this.debounceTimer != null) {
      await new Promise<void>((resolve) => {
        this.queryDoneResolvers.push(resolve);
      });
    }
  }

  /**
   * Abort the currently running query, if any.
   * Returns true if a query was aborted, false if no query was running.
   * Called by the SIGINT handler so ^C interrupts the current query
   * rather than shutting down the worker.
   */
  interrupt(): boolean {
    if (this.currentAc) {
      this.currentAc.abort();
      return true;
    }
    return false;
  }

  /**
   * Send worker_goodbye to the foreman if the WebSocket is currently open.
   * Called before clean exits (SIGTERM, /quit) so the foreman can immediately
   * revert the task to pending without waiting for the reclaim timeout.
   */
  sendGoodbye(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "worker_goodbye",
        workerId: this.workerId,
        taskId: this.currentTaskId,
      }));
    }
  }

  /**
   * Process a line of stdin input: slash commands and user queries.
   */
  async handleUserInput(input: string): Promise<"exit" | "task-complete" | undefined> {
    if (!input || input === "__abort__") return;
    if (input === WS_TASK_ASSIGNED || input === WS_EVENT) return;
    // ^D / ^C on empty buffer resolves ask() with "__eof__" — treat as /exit
    // so the workerMain() loop breaks and workspace cleanup runs.
    if (input === "__eof__") return "exit";

    const action = await dispatchInput(input);
    if (action.type === "skip") return;
    if (action.type === "unknown_command") {
      this.display.print(display.c.boldRed(`Unknown command: /${action.command}`));
      return;
    }

    if (action.type === "command") {
      const result = await execute(action.name, action.args);
      if (result === "exit" || result === "task-complete") return result;
      return;
    }

    if (action.type === "query") {
      await this.runQueryLoop(action.prompt);
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Send a task-scoped message to the foreman. Always buffers first, then
   * immediately flushes if the handshake is complete. This way the buffer
   * is the single code path regardless of connection state.
   */
  private sendTaskMessage(msg: BufferableMessage): void {
    this.bufferedMessages.push(msg);
    this.flushBuffer();
  }

  /**
   * Send all buffered messages if registered and the socket is open.
   * No-ops if the handshake is still pending or the socket is not ready.
   */
  private flushBuffer(): void {
    if (this.connectionState !== "registered") return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const pending = this.bufferedMessages.splice(0);
    for (const m of pending) {
      this.ws.send(JSON.stringify(m));
    }
  }

  private notifyQueryDone(): void {
    const resolvers = this.queryDoneResolvers.splice(0);
    for (const r of resolvers) r();
  }

  private connect(): void {
    // Clearing reconnectAt stops the countdown timer in the model.
    this.statusModel.update({ connectionStatus: "reconnecting", reconnectAt: undefined });
    const ws = this.wsFactory(this.workerId, this.currentTaskId);
    this.ws = ws;

    const pingIntervalMs = this.options.pingIntervalMs ?? 25_000;
    let isAlive = false;
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    const clearPingTimer = () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    };

    ws.on("open", () => {
      this.connectionState = "hello_sent";
      this.statusModel.update({ connectionStatus: "handshaking" });

      // Heartbeat: detect silent connection drops (network loss, laptop sleep, etc.)
      // Each tick sends a ping. If no pong/ping arrives before the next tick, the
      // connection is terminated so the status bar updates and reconnect runs.
      // Receiving any frame (pong from our ping, or ping from the foreman's heartbeat)
      // resets the timer so the next check is a full interval away.
      isAlive = true;

      const startPingTimer = () => {
        clearPingTimer();
        pingTimer = setInterval(() => {
          if (!isAlive) {
            clearPingTimer();
            ws.terminate();
            return;
          }
          isAlive = false;
          ws.ping();
        }, pingIntervalMs);
      };

      const resetLiveness = () => {
        isAlive = true;
        startPingTimer();
      };

      ws.on("pong", resetLiveness);
      ws.on("ping", resetLiveness);
      startPingTimer();
    });

    ws.on("message", (data: Buffer | string) => {
      let msg: ForemanMessage;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      this.handleMessage(msg);
    });

    ws.on("close", (code: number, _reason: Buffer) => {
      clearPingTimer(); // always clean up the ping timer when this socket closes
      if (ws !== this.ws) return; // stale close from a previous connection
      const delay = 2000 + Math.random() * 3000;
      // Setting reconnectAt starts a 1-second countdown timer in the model.
      this.statusModel.update({
        connectionStatus: "disconnected",
        disconnectCode: code,
        reconnectAt: Date.now() + delay,
      });
      setTimeout(() => this.connect(), delay);
    });

    ws.on("error", (err: Error) => {
      if (ws !== this.ws) return; // stale error from a previous connection
      this.display.print(display.c.amber(`WebSocket error: ${err.message}`));
      // Ensure close fires even for errors that don't automatically close the socket
      // (e.g. some TLS negotiation failures on older Node.js / ws versions).
      ws.terminate();
    });
  }

  private handleMessage(msg: ForemanMessage): void {
    this.display.printForemanMessage(msg);

    if (msg.type === "hello_ack") {
      if (msg.status === "cancelled") {
        // Task was reassigned while worker was disconnected — stop and reset.
        this.currentAc?.abort(); // abort any running query immediately
        this.connectionState = "registered";
        this.bufferedMessages = [];
        this.currentTaskId = undefined;
        this.currentIssue = undefined;
        this.currentSessionId = undefined;
        this.statusModel.update({
          connectionStatus: "connected",
          disconnectCode: undefined,
          taskNumber: undefined,
          prNumber: undefined,
          branch: "",
        });
        this.display.print(display.c.amber("Task cancelled (reassigned to another worker)."));
        const ctx = this.options.workspaceCtx;
        if (ctx) {
          void ctx.workspace.reset().then(() => {
            this.display.print(display.c.amber("Workspace reset."));
          }).catch((err: unknown) => {
            this.display.print(display.c.boldRed(`Workspace reset failed: ${err instanceof Error ? err.message : String(err)}`));
          });
        }
      } else {
        // "idle" or "busy": transition to registered and flush buffered messages.
        this.connectionState = "registered";
        this.statusModel.update({ connectionStatus: "connected", disconnectCode: undefined });
        this.flushBuffer();
      }
      return;
    }

    if (msg.type === "task_assigned") {
      this.currentTaskId = msg.taskId;
      this.currentIssue = msg.issue;
      this.currentSessionId = undefined;
      this.prIsClosed = false;
      this.statusModel.update({ taskNumber: msg.issue.number, prNumber: undefined });
      void this.refreshBranch();
      this.resolveWsInput?.(WS_TASK_ASSIGNED);
      this.resolveWsInput = null;
      const initialPrompt = buildInitialPrompt(msg.issue, !!this.options.workspaceCtx);
      this.display.print(display.c.sageGreen(initialPrompt));
      void this.runQueryLoop(initialPrompt);
    } else if (msg.type === "event_notification") {
      const { event } = msg;
      const action = event.payload["action"] as string | undefined;

      // Track PR number from any pull_request event for the status bar.
      if (event.name === "pull_request") {
        const pr = event.payload["pull_request"] as { number?: number; merged?: boolean } | undefined;
        if (action === "closed" && !pr?.merged) {
          // PR was closed without merging — clear the PR from the status bar.
          this.statusModel.update({ prNumber: undefined });
        } else if (pr?.number != null) {
          this.statusModel.update({ prNumber: pr.number });
        }
      }

      if (event.name === "pull_request" && action === "closed") {
        this.prIsClosed = true;
        // process normally (cleanup prompt still fires)
      } else if (event.name === "pull_request" && action === "reopened") {
        this.prIsClosed = false;
        // process normally
      } else if (this.prIsClosed && event.name === "check_suite") {
        // Post-merge check suite: already logged via printForemanMessage; silently drop.
        return;
      }

      const classification = classifyEvent(event);
      if (classification === "log_only") {
        // Already logged via printForemanMessage above; no further action.
        return;
      }

      // Actionable event: queue it and schedule dispatch.
      this.pendingEvents.push(event);
      this.resolveWsInput?.(WS_EVENT);
      this.resolveWsInput = null;

      if (!this.isRunningQuery && this.currentTaskId && this.currentIssue) {
        // No query running: start/reset debounce timer to batch rapid events.
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          if (!this.isRunningQuery && this.currentTaskId && this.currentIssue) {
            const events = this.pendingEvents.splice(0);
            void this.runQueryLoop(this.buildAndLogEventPrompt(events));
            // runQueryLoop will call notifyQueryDone() when it finishes
          } else {
            // No query started — notify any waitUntilIdle() callers so they
            // can recheck the loop condition and exit if truly idle.
            this.notifyQueryDone();
          }
        }, debounceMs(this.pendingEvents));
      }
      // If a query IS running, events drain at the end of runQueryLoop.
    }
  }

  private async runQueryLoop(initialPrompt: string): Promise<void> {
    // Cancel any pending debounce — events will drain naturally at the end of this loop.
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // Always notify waitUntilIdle() callers when this loop exits, even on ^C interrupt.
    try {
      const ac = new AbortController();
      this.currentAc = ac;
      this.isRunningQuery = true;
      let queryFailed = false;
      try {
        this.currentSessionId = await this.runQuery(initialPrompt, this.currentSessionId, ac, this._currentModel, this._currentEffort) ?? this.currentSessionId;
      } catch (err) {
        if (err instanceof Error && /aborted by user/i.test(err.message)) return;
        this.display.print(display.c.boldRed(`\nERROR: ${fmtError(err)}`));
        queryFailed = true;
      } finally {
        this.currentAc = null;
        this.isRunningQuery = false;
        void this.refreshBranch();
      }

      // If the user interrupted (^C) or the query failed, skip the event drain.
      if (ac.signal.aborted || queryFailed) return;

      while (this.pendingEvents.length > 0 && this.currentTaskId && this.currentIssue) {
        const eventAc = new AbortController();
        this.currentAc = eventAc;
        const events = this.pendingEvents.splice(0);
        const prompt = this.buildAndLogEventPrompt(events);
        this.isRunningQuery = true;
        try {
          this.currentSessionId = await this.runQuery(prompt, this.currentSessionId, eventAc, this._currentModel, this._currentEffort) ?? this.currentSessionId;
        } catch (err) {
          if (err instanceof Error && /aborted by user/i.test(err.message)) return;
          this.display.print(display.c.boldRed(`\nERROR: ${fmtError(err)}`));
          return;
        } finally {
          this.currentAc = null;
          this.isRunningQuery = false;
          void this.refreshBranch();
        }
        if (eventAc.signal.aborted) return;
      }
    } finally {
      this.notifyQueryDone();
    }
  }

  private buildAndLogEventPrompt(events: GitHubEvent[]): string {
    const prompt = buildEventPrompt(events);
    this.display.print(display.c.sageGreen(prompt));
    return prompt;
  }

}

// ── workerMain ────────────────────────────────────────────────────────────────

export async function workerMain(
  runQueryFn: RunQuery,
  config: {
    foremanUrl: string;
    workspaceDir?: string;
    githubToken: string;
    githubRepo: string;
    repoUrl?: string;
    permissionMode: PermissionMode;
    verbose: boolean;
    logFile: string;
    model?: string;
    effort?: EffortValue;
    pingIntervalMs: number;
  },
): Promise<void> {
  const FOREMAN_URL = config.foremanUrl;
  const workerId = generateWorkerId();

  const originalCwd = process.cwd();
  const workspaceDir = config.workspaceDir ?? path.join(os.homedir(), ".brunel", "workers");
  const repoUrl = config.repoUrl ?? `https://${config.githubToken}@github.com/${config.githubRepo}.git`;

  const workspace = await Workspace.create(workspaceDir, workerId, repoUrl);
  process.chdir(workspace.dir);

  const confirm = async (msg: string): Promise<boolean> => {
    display.print(display.c.amber(`\n⚠ Potential data loss:\n${msg}`));
    const idx = await pick(["Yes, proceed", "No, cancel"]);
    return idx === 0;
  };

  const afterTask = async () => {
    const ok = await confirmIfUnsafe(workspace, confirm);
    if (!ok) {
      display.print(display.c.amber("Workspace reset cancelled. Task not marked complete."));
      throw new Error("cancelled");
    }
    try {
      await workspace.reset();
    } catch (err) {
      display.print(display.c.boldRed(`Workspace reset failed: ${fmtError(err)}. Task not marked complete.`));
      throw err;
    }
  };

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const ok = await confirmIfUnsafe(workspace, confirm);
    if (ok) await workspace.destroy();
    process.exit(0);
  };

  const wsFactory: WsFactory = (wid, taskId) => {
    const ws = new WebSocket(`${FOREMAN_URL}/worker`);
    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "worker_hello",
        workerId: wid,
        taskId,
        status: taskId ? "busy" : "idle",
      }));
    });
    return ws;
  };

  const workerDisplay: WorkerDisplay = {
    print: display.print,
    printForemanMessage: display.printForemanMessage,
    startPersistentStatus: display.startPersistentStatus,
    stopPersistentStatus: display.stopPersistentStatus,
    updatePersistentStatus: display.updatePersistentStatus,
    setOnToolResultCallback: display.setOnToolResultCallback,
  };

  const session = new WorkerSession(workerId, wsFactory, runQueryFn, workerDisplay, {
    afterTask,
    workspaceCtx: { workspace, originalCwd, workspaceDir, repoUrl, confirm },
    pingIntervalMs: config.pingIntervalMs,
  });
  session.currentModel = config.model;
  session.currentEffort = config.effort;

  // SIGINT: interrupt the running query if one is active; otherwise prompt and shut down.
  // This lets the user press ^C to interrupt a running tool without killing the worker.
  process.on("SIGINT", () => {
    if (!session.interrupt()) {
      void shutdown();
    }
  });

  // SIGTERM is a system/orchestrator signal: send goodbye then force-destroy without prompting.
  process.on("SIGTERM", () => {
    session.sendGoodbye();
    void workspace.destroy().then(() => process.exit(0));
  });

  process.stdout.write("\x1b[?2004h"); // enable bracketed paste mode
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  display.print(display.c.sageGreen(display.hr("═")));
  display.print(display.c.skyBlue(display.s.bold("  Brunel Worker")));
  display.print(display.c.lavender(`  Worker ID: ${workerId} | Foreman: ${FOREMAN_URL}`));
  display.print(display.c.lavender(`  Permissions: ${config.permissionMode} | Model: ${config.model ?? "default"} | Output: ${config.verbose ? "verbose" : "quiet"} | Log: ${config.logFile}`));
  display.print(display.c.sageGreen(display.hr("═")));

  session.start();

  // Start with no visible prompt: the worker is waiting for the foreman to
  // assign a task and is not in a mode that accepts interactive user input.
  // The prompt becomes visible after the first task query completes.
  let showPrompt = false;

  while (true) {
    const wsAbort = session.createWsInputPromise();
    // Use an empty prompt string when not ready for interactive input.  An
    // empty promptLine suppresses the drawFresh callback so incoming messages
    // are printed cleanly without a prompt preceding or following them.
    const promptStr = showPrompt ? "\n[worker] > " : "";
    const input = await ask(promptStr, listWorkerCommands, wsAbort);

    const isSentinel = input === WS_TASK_ASSIGNED || input === WS_EVENT;
    if (isSentinel) {
      // A WS message arrived. Hide the prompt and wait for the triggered
      // query to finish before showing it again.
      showPrompt = false;
      await session.waitUntilIdle();
      showPrompt = true;
    }

    try {
      const result = await session.handleUserInput(input);
      if (result === "exit") break;
      if (result === "task-complete") showPrompt = false;
    } catch (err) {
      display.print(display.c.boldRed(`\nERROR: ${fmtError(err)}`));
    }
  }

  // Send goodbye so the foreman can immediately reassign any in-progress task.
  session.sendGoodbye();

  // Clean shutdown: destroy workspace if user approves.
  // Set shuttingDown so the SIGINT handler won't double-destroy.
  shuttingDown = true;
  const okShutdown = await confirmIfUnsafe(workspace, confirm);
  if (okShutdown) await workspace.destroy();

  process.stdout.write("\x1b[?2004l\r\n");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.exit(0);
}
