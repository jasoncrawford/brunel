import { exec } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import * as display from "./display.js";
import { buildInitialPrompt, buildEventPrompt } from "./templates.js";
import type { EffortValue } from "./effort.js";
import type { ForemanMessage, GitHubEvent, TaskIssue, WorkerMessage } from "../types.js";
import { Workspace } from "./workspace.js";
import type { WorkspaceCommandDeps } from "./workspace.js";
import { fmtError } from "../utils.js";
import { scoped } from "./commands.js";

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

// Sentinel: a prompt is ready for main() to execute
export const WS_PROMPT = "__ws_prompt__";

/** A prompt queued by WorkerSession for main() to execute. */
export type QueuedPrompt = { prompt: string; fresh: boolean };

// Messages that must wait for hello_ack before being sent.
type BufferableMessage = Extract<WorkerMessage, { type: "task_complete" }>;

/**
 * WebSocket client and task lifecycle manager. WorkerSession owns the foreman
 * connection, handshake protocol, task state, event debouncing, and prompt
 * queuing. It does NOT execute queries — instead it queues prompts for main()
 * to run via the RunQuery function injected there.
 *
 * When a task is assigned or a debounced event fires, WorkerSession pushes a
 * QueuedPrompt and signals main()'s ask() loop via the WS_PROMPT sentinel.
 * main() drains the queue by calling takeNextPrompt() and running each prompt.
 */
export class WorkerSession {
  private currentTaskId: string | undefined;
  private currentIssue: TaskIssue | undefined;
  private pendingEvents: GitHubEvent[] = [];
  private pendingPrompts: QueuedPrompt[] = [];
  private ws: WebSocket | undefined;
  private resolveWsInput: ((v: string) => void) | null = null;
  private currentAc: AbortController | null = null;
  private _queryRunning = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private prIsClosed = false;
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

  /**
   * Called by main() just before executing a prompt. Stores the AbortController
   * so interrupt() can abort it, marks the query as running (suppressing the
   * debounce timer from firing a redundant signal), and cancels any pending
   * debounce (those events will drain into the queue via notifyQueryEnd()).
   */
  notifyQueryStart(ac: AbortController): void {
    this.currentAc = ac;
    this._queryRunning = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Called by main() after a prompt finishes (or is interrupted). Clears the
   * AbortController, drains any pending events into the prompt queue (unless
   * the query was aborted, which signals the user interrupted), and refreshes
   * the branch display.
   */
  notifyQueryEnd(aborted = false): void {
    this.currentAc = null;
    this._queryRunning = false;
    if (!aborted && this.pendingEvents.length > 0 && this.currentTaskId && this.currentIssue) {
      const events = this.pendingEvents.splice(0);
      this.enqueuePrompt(this.buildAndLogEventPrompt(events), false);
    }
    void this.refreshBranch();
  }

  /** Returns true if there are queued prompts for main() to execute. */
  hasPendingPrompts(): boolean {
    return this.pendingPrompts.length > 0;
  }

  /** Dequeues and returns the next prompt, or undefined if empty. */
  takeNextPrompt(): QueuedPrompt | undefined {
    return this.pendingPrompts.shift();
  }

  /**
   * Complete the current task: call afterTask hook, send task_complete, reset state.
   * Returns 'task-complete' if a task was active, undefined if no task was assigned.
   */
  async completeCurrentTask(): Promise<"task-complete" | undefined> {
    if (!this.currentTaskId) return undefined;
    if (this.options.afterTask) {
      try { await this.options.afterTask(); } catch { return undefined; }
    }
    this.sendTaskMessage({
      type: "task_complete",
      workerId: this.workerId,
      taskId: this.currentTaskId,
    });
    this.currentTaskId = undefined;
    this.currentIssue = undefined;
    this.statusModel.update({ taskNumber: undefined, prNumber: undefined, branch: "" });
    this.display.print(display.c.sageGreen("Task complete. Waiting for next task..."));
    return "task-complete";
  }

  /**
   * Returns the workspace command deps for use with registerWorkspaceCommands().
   * Exposes a proxy so workspace mutations from commands update the session state.
   */
  get workspaceCommandDeps(): WorkspaceCommandDeps {
    const self = this;
    return {
      workspace: {
        get current() { return self.options.workspaceCtx?.workspace; },
        set current(ws: Workspace | undefined) {
          if (self.options.workspaceCtx) {
            if (ws) { self.options.workspaceCtx.workspace = ws; }
            else { self.options.workspaceCtx = undefined; }
          }
        },
      },
      config: this.options.workspaceCtx ? {
        workspaceDir: this.options.workspaceCtx.workspaceDir,
        repoUrl: this.options.workspaceCtx.repoUrl,
        sessionId: this.workerId,
      } : undefined,
      originalCwd: this.options.workspaceCtx?.originalCwd ?? process.cwd(),
      confirm: this.options.workspaceCtx?.confirm ?? (() => Promise.resolve(false)),
    };
  }

  /**
   * Create a one-shot promise that resolves with WS_PROMPT when a queued prompt
   * is ready for main() to execute. If prompts are already queued, resolves
   * immediately. Each call replaces the previous unresolved promise.
   */
  createWsInputPromise(): Promise<string> {
    if (this.pendingPrompts.length > 0) {
      return Promise.resolve(WS_PROMPT);
    }
    return new Promise<string>((resolve) => {
      this.resolveWsInput = resolve;
    });
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

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Push a prompt to the queue and signal main()'s ask() loop via WS_PROMPT.
   * fresh=true means main() should reset its sessionId (new task conversation).
   */
  private enqueuePrompt(prompt: string, fresh: boolean): void {
    this.pendingPrompts.push({ prompt, fresh });
    this.resolveWsInput?.(WS_PROMPT);
    this.resolveWsInput = null;
  }

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
        this.pendingPrompts = [];
        this.pendingEvents = [];
        this.currentTaskId = undefined;
        this.currentIssue = undefined;
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
      this.prIsClosed = false;
      this.statusModel.update({ taskNumber: msg.issue.number, prNumber: undefined });
      void this.refreshBranch();
      const initialPrompt = buildInitialPrompt(msg.issue, !!this.options.workspaceCtx);
      this.display.print(display.c.sageGreen(initialPrompt));
      this.enqueuePrompt(initialPrompt, true); // fresh=true: new task, reset session
    } else if (msg.type === "event_notification") {
      // Ignore stale events forwarded for tasks we're no longer working on.
      if (msg.taskId !== this.currentTaskId) {
        this.display.print(display.c.darkGray(`[worker] ignoring event_notification for task ${msg.taskId} (current: ${this.currentTaskId ?? "none"})`));
        return;
      }

      const { event } = msg;
      const action = event.payload["action"] as string | undefined;

      // Track PR number from any pull_request event for the status bar.
      if (event.name === "pull_request") {
        const pr = event.payload["pull_request"] as { number?: number; merged?: boolean } | undefined;
        if (action === "closed" && !pr?.merged) {
          this.statusModel.update({ prNumber: undefined });
        } else if (pr?.number != null) {
          this.statusModel.update({ prNumber: pr.number });
        }
      }

      if (event.name === "pull_request" && action === "closed") {
        this.prIsClosed = true;
      } else if (event.name === "pull_request" && action === "reopened") {
        this.prIsClosed = false;
      } else if (this.prIsClosed && event.name === "check_suite") {
        // Post-merge check suite: already logged via printForemanMessage; silently drop.
        return;
      }

      const classification = classifyEvent(event);
      if (classification === "log_only") {
        return;
      }

      // Actionable event: queue it for debounced dispatch.
      this.pendingEvents.push(event);

      if (!this._queryRunning && this.currentTaskId && this.currentIssue) {
        // No query running: set up/reset debounce timer to batch rapid events.
        // When the timer fires, events are enqueued and main()'s ask() is signalled.
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          if (!this._queryRunning && this.currentTaskId && this.currentIssue) {
            const events = this.pendingEvents.splice(0);
            if (events.length > 0) {
              this.enqueuePrompt(this.buildAndLogEventPrompt(events), false);
            }
          }
          // If _queryRunning became true while debounce was pending, events stay in
          // pendingEvents to be drained by notifyQueryEnd().
        }, debounceMs(this.pendingEvents));
      }
      // If _queryRunning: events stay in pendingEvents, drained in notifyQueryEnd().
    }
  }

  private buildAndLogEventPrompt(events: GitHubEvent[]): string {
    const prompt = buildEventPrompt(events);
    this.display.print(display.c.sageGreen(prompt));
    return prompt;
  }

}

// ── Worker command registration ────────────────────────────────────────────────

/**
 * Register the worker-namespace commands. Call this at startup in both REPL
 * and worker modes — commands are always present in the registry and degrade
 * gracefully when not connected to a foreman.
 *
 * Follows the same pattern as registerWorkspaceCommands in workspace.ts.
 */
export function registerWorkerCommands(session: WorkerSession | undefined): void {
  const workerReg = scoped("worker");
  workerReg("complete", {
    description: "Mark the current task as done",
    availability: "worker",
    handler: async () => {
      if (!session) {
        display.print(display.c.boldRed("Not connected to a foreman."));
        return undefined;
      }
      return session.completeCurrentTask();
    },
  });
}
