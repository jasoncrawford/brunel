import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { c } from "../views/style.js";
import { AgentStatus } from "../models/agent-status.js";
import type { Display } from "../views/display.js";
import { buildInitialPrompt, buildEventPrompt } from "../worker-prompts.js";
import * as Wire from "../../../shared/wire.js";
import { fmtError } from "../../utils.js";
import { fmtNum } from "../../../shared/formatters.js";
import { getConfig } from "../../config.js";
import type { CommandRegistry } from "./command-controller.js";
import { Picker } from "../views/picker.js";
import { WorkspaceController } from "./workspace-controller.js";

// ── WorkerDisplay interface ───────────────────────────────────────────────────

/**
 * Minimal display interface required by worker controllers.
 * Satisfied structurally by Display; tests can pass lightweight stubs.
 */
export interface WorkerDisplay {
  print(line: string | null): void;
  printForemanMessage(msg: Wire.ForemanMessage): void;
}

/**
 * Extended display interface required by WorkerController.
 * Adds agentStatus to WorkerDisplay so WorkerController can update status
 * without a separate AgentStatus parameter. Satisfied by Display and test stubs
 * that include an agentStatus field.
 */
export interface WorkerControllerDisplay extends WorkerDisplay {
  readonly agentStatus: AgentStatus;
}

// ── Wire types ────────────────────────────────────────────────────────────────

export type WsFactory = (agentId: string, taskId?: string) => WebSocket;

/** Task state needed to decide whether and how to prompt before quitting. */
export type TaskQuitInfo = {
  taskNumber: number;
  workerId: string;
  issueClosed: boolean;
};

/** A prompt queued by WorkerController for main() to execute. */
export type QueuedPrompt = { prompt: string; fresh: boolean };

/** Options for overriding WorkerController internals in tests. */
export type WorkerControllerOptions = {
  /** Inject a WS factory for testing (default: builds from config in start()). */
  wsFactory?: WsFactory;
  /** Override the afterTask hook (default: derived from workspaceController.onReset). */
  afterTask?: () => Promise<void>;
  /** Override ping interval in ms (default: from config). */
  pingIntervalMs?: number;
  /** Override max reconnect delay in ms (default: from config). */
  maxReconnectDelayMs?: number;
  /** Override pick function for testing repo activation and quit confirmation. */
  pickFn?: (options: string[]) => Promise<number>;
  /** Override branch getter for testing. */
  getBranch?: () => Promise<string>;
};

// Messages that must wait for hello_ack before being sent.
type BufferableMessage = Extract<Wire.WorkerMessage, { type: "task_complete" }>;

// ── Event classification ───────────────────────────────────────────────────────

export function classifyEvent(event: Wire.WebhookEvent): "actionable" | "log_only" {
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
      return (action === "closed" || action === "auto_merge_enabled" || action === "opened") ? "actionable" : "log_only";

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

function debounceMs(events: Wire.WebhookEvent[]): number {
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTaskStats(inputTokens: number, outputTokens: number, costUsd: number | undefined): string {
  const parts = [`tokens: ${fmtNum(inputTokens)} in / ${fmtNum(outputTokens)} out`];
  if (costUsd != null) parts.push(`cost: $${costUsd.toFixed(2)}`);
  return parts.join(", ");
}

// ── WorkerController ──────────────────────────────────────────────────────────

/**
 * Worker mode lifecycle manager, WebSocket client, and task protocol handler.
 * Owns the foreman connection, handshake protocol, task state, event debouncing,
 * and prompt queuing. Does NOT execute queries — instead queues prompts and
 * emits "prompts_ready" for index.ts to run via AgentController.
 *
 * Call start() to activate worker mode and connect to the foreman.
 * Call stop() to gracefully disconnect. The class handles reconnect internally.
 *
 * On a fatal foreman error, emits "fatal". When prompts are ready, emits
 * "prompts_ready" — index.ts cancels any live ask() and drains the queue
 * by calling hasPendingPrompts() / takeNextPrompt().
 */
export class WorkerController extends EventEmitter {
  // Extracted from display for convenient access.
  readonly agentStatus: AgentStatus;

  // ── Active session state (set by start(), cleared by stop()) ───────────────
  private _isActive = false;
  private _activeWsFactory: WsFactory | undefined;
  private _activeAfterTask: (() => Promise<void>) | undefined;
  private _activePingIntervalMs = 25_000;
  private _activeMaxReconnectDelayMs = 300_000;

  // ── Task state (cleared by stop()) ────────────────────────────────────────
  private currentTaskId: string | undefined;
  private currentIssue: Wire.TaskIssue | undefined;
  private pendingEvents: Wire.WebhookEvent[] = [];
  private pendingPrompts: QueuedPrompt[] = [];
  private prIsClosed = false;
  private issueClosed = false;
  private _resetPromise: Promise<void> | null = null;

  // ── Connection state (cleared by stop()) ──────────────────────────────────
  private ws: WebSocket | undefined;
  // Initialized to "registered" so instances that never connect (e.g. tests
  // that exercise only task state) behave as if already registered.
  private connectionState: "hello_sent" | "registered" = "registered";
  private bufferedMessages: BufferableMessage[] = [];
  private reconnectAttempts = 0;
  private _stopped = false;

  // ── Query state ───────────────────────────────────────────────────────────
  private currentAc: AbortController | null = null;
  private _queryRunning = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly display: WorkerControllerDisplay,
    private readonly picker: Picker | undefined,
    private readonly workspaceController: WorkspaceController | undefined,
    private readonly repo: string,
    private readonly options?: WorkerControllerOptions,
  ) {
    super();
    this.agentStatus = display.agentStatus;
  }

  // ── Public getters ────────────────────────────────────────────────────────

  get agentId(): string { return this.agentStatus.agentId; }
  /** True when worker mode is active (connected or connecting). */
  get isActive(): boolean { return this._isActive; }
  /** True when a worker cleanup must run on exit (i.e., worker is active). */
  get isCleanupPending(): boolean { return this._isActive; }

  // ── Protocol methods (previously required reaching through .session) ───────

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
   * the query was aborted), and refreshes the branch display.
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

  // ── Task lifecycle methods ────────────────────────────────────────────────

  /** Returns true if a task is currently assigned to this worker. */
  hasTask(): boolean {
    return this.currentTaskId !== undefined;
  }

  /** Abort the currently running query, if any. Returns true if aborted. */
  interrupt(): boolean {
    if (this.currentAc) {
      this.currentAc.abort();
      return true;
    }
    return false;
  }

  /**
   * Send worker_goodbye to the foreman if the WebSocket is currently open.
   */
  sendGoodbye(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "worker_goodbye",
        workerId: this.agentStatus.agentId,
        taskId: this.currentTaskId,
      }));
    }
  }

  /**
   * Returns task quit info if a task is currently active, undefined otherwise.
   */
  getTaskQuitInfo(): TaskQuitInfo | undefined {
    if (!this.currentTaskId || !this.currentIssue) return undefined;
    return {
      taskNumber: this.currentIssue.number,
      workerId: this.agentId,
      issueClosed: this.issueClosed,
    };
  }

  /**
   * Prompt the user before quitting with an active task.
   *
   * Returns 'quit', 'complete-and-quit', or 'cancel'.
   * An injectable pickFn override is accepted for tests.
   */
  async confirmTaskQuit(
    info: TaskQuitInfo,
    pickFn: (options: string[]) => Promise<number> = this.pickFnOrDefault(),
  ): Promise<"quit" | "complete-and-quit" | "cancel"> {
    if (info.issueClosed) {
      this.display.print(c.amber(`\nTask #${info.taskNumber} is closed but not complete. Complete it before exiting?`));
      const idx = await pickFn(["Yes, complete before exiting", "No, just exit", "Don't exit"]);
      if (idx === 0) return "complete-and-quit";
      if (idx === 1) return "quit";
      return "cancel";
    } else {
      this.display.print(c.amber(`\nTask #${info.taskNumber} is still open. Quitting now will unassign ${info.workerId}. Quit anyway?`));
      const idx = await pickFn(["No, keep working", "Yes, quit anyway"]);
      if (idx === 1) return "quit";
      return "cancel";
    }
  }

  /**
   * Complete the current task: call afterTask hook, send task_complete, reset state.
   * Returns 'task-complete' if a task was active, undefined if no task was assigned.
   */
  async completeCurrentTask(): Promise<"task-complete" | undefined> {
    if (!this.currentTaskId) return undefined;
    if (this._activeAfterTask) {
      try { await this._activeAfterTask(); } catch (err) {
        this.display.print(c.amber(`afterTask failed: ${fmtError(err)}`));
      }
    }
    const { taskInputTokens, taskOutputTokens, taskCostUsd } = this.agentStatus;
    const hasStats = taskInputTokens > 0 || taskOutputTokens > 0 || taskCostUsd != null;
    this.sendTaskMessage({
      type: "task_complete",
      workerId: this.agentStatus.agentId,
      taskId: this.currentTaskId,
      ...(hasStats && { stats: { inputTokens: taskInputTokens, outputTokens: taskOutputTokens, costUsd: taskCostUsd } }),
    });
    const taskNumber = this.currentIssue!.number;
    this.currentTaskId = undefined;
    this.currentIssue = undefined;
    const statsStr = fmtTaskStats(this.agentStatus.taskInputTokens, this.agentStatus.taskOutputTokens, this.agentStatus.taskCostUsd);
    this.display.print(c.sageGreen(`Task #${taskNumber} complete, ${statsStr}`));
    this.agentStatus.resetTaskStats();
    this.agentStatus.update({ taskNumber: undefined, prNumber: undefined });
    await this.refreshBranch();
    this.display.print(c.sageGreen("Waiting for next task..."));
    return "task-complete";
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Connect to the foreman and begin accepting tasks. */
  async start(): Promise<void> {
    if (this._isActive) {
      this.display.print(c.amber("Worker mode is already active."));
      return;
    }
    await this.workspaceController?.onCreate();

    const { options } = this;
    this._activeAfterTask = options?.afterTask ?? (
      this.workspaceController ? () => this.workspaceController!.onReset() : undefined
    );
    this._activeWsFactory = options?.wsFactory ?? this.buildWsFactory();
    this._activePingIntervalMs = options?.pingIntervalMs ?? getConfig().pingIntervalMs ?? 25_000;
    this._activeMaxReconnectDelayMs = options?.maxReconnectDelayMs ?? getConfig().maxReconnectDelayMs ?? 300_000;

    this._stopped = false;
    this._isActive = true;

    this.agentStatus.update({ model: getConfig().model, effort: getConfig().effort });
    this.agentStatus.setWorkerModeActive(true);
    this.agentStatus.setOnToolResult((toolName) => {
      if (toolName === "Bash") void this.refreshBranch();
    });
    void this.refreshBranch();
    this.connect();
  }

  /** Disconnect from the foreman. Prompts if a task is in progress. */
  async stop(): Promise<void> {
    if (!this._isActive) return;
    const taskInfo = this.getTaskQuitInfo();
    if (taskInfo) {
      const choice = await this.confirmTaskQuit(taskInfo);
      if (choice === "cancel") return;
      if (choice === "complete-and-quit") await this.completeCurrentTask();
    }
    this._stopped = true;
    this.sendGoodbye();
    this.ws?.close();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.resetSessionState();
    this._isActive = false;
    this.agentStatus.setWorkerModeActive(false);
    this.display.print(c.sageGreen("Worker mode stopped."));
    await this.refreshBranch();
  }

  /** Run worker teardown: send goodbye, destroy workspace, tear down I/O. */
  async cleanup(): Promise<void> {
    if (this._isActive) {
      this.sendGoodbye();
      await this.workspaceController?.onDestroy();
      process.stdout.write("\x1b[?2004l\r\n");
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  }

  /** Register /worker:complete, /worker:start, /worker:stop into the given (already-scoped) registry. */
  registerCommands(registry: CommandRegistry): void {
    registry.register("complete", {
      description: "Mark the current task as done",
      handler: async () => {
        if (!this._isActive) {
          this.display.print(c.boldRed("Not connected to a foreman."));
          return undefined;
        }
        return this.completeCurrentTask();
      },
    });
    registry.register("start", {
      description: "Connect to the foreman and start accepting tasks",
      handler: async () => { await this.start(); },
    });
    registry.register("stop", {
      description: "Disconnect from the foreman",
      handler: async () => {
        if (!this._isActive) {
          this.display.print(c.amber("Worker mode is not active."));
          return undefined;
        }
        await this.stop();
      },
    });
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private pickFnOrDefault(): (opts: string[]) => Promise<number> {
    if (this.options?.pickFn) return this.options.pickFn;
    return (opts) => this.picker!.pick(opts);
  }

  private async refreshBranch(): Promise<void> {
    const getBranch = this.options?.getBranch ?? AgentStatus.getCurrentBranch;
    this.agentStatus.update({ branch: await getBranch() });
  }

  private buildWsFactory(): WsFactory {
    return (agentId, taskId) => {
      const ws = new WebSocket(`${getConfig().foremanUrl}/worker`);
      ws.on("open", () => {
        ws.send(JSON.stringify({
          type: "worker_hello",
          workerId: agentId,
          repo: this.repo,
          taskId,
          status: taskId ? "busy" : "idle",
        }));
      });
      return ws;
    };
  }

  private resetSessionState(): void {
    this.currentTaskId = undefined;
    this.currentIssue = undefined;
    this.pendingEvents = [];
    this.pendingPrompts = [];
    this.prIsClosed = false;
    this.issueClosed = false;
    this._resetPromise = null;
    this.ws = undefined;
    this.connectionState = "registered";
    this.bufferedMessages = [];
    this.reconnectAttempts = 0;
    this.currentAc = null;
    this._queryRunning = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Push a prompt to the queue and emit "prompts_ready" so index.ts's routing
   * loop can cancel any live ask() and drain the queue.
   * fresh=true means the session should reset its conversationId (new task).
   */
  private enqueuePrompt(prompt: string, fresh: boolean): void {
    this.pendingPrompts.push({ prompt, fresh });
    this.emit("prompts_ready");
  }

  /**
   * Send a task-scoped message to the foreman. Always buffers first, then
   * immediately flushes if the handshake is complete.
   */
  private sendTaskMessage(msg: BufferableMessage): void {
    this.bufferedMessages.push(msg);
    this.flushBuffer();
  }

  private transitionToRegistered(): void {
    this.connectionState = "registered";
    this.agentStatus.update({ connectionStatus: "connected", disconnectCode: undefined });
    this.flushBuffer();
  }

  private flushBuffer(): void {
    if (this.connectionState !== "registered") return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const pending = this.bufferedMessages.splice(0);
    for (const m of pending) {
      this.ws.send(JSON.stringify(m));
    }
  }

  private connect(): void {
    this.agentStatus.update({ connectionStatus: "reconnecting", reconnectAt: undefined });
    const ws = this._activeWsFactory!(this.agentStatus.agentId, this.currentTaskId);
    this.ws = ws;

    const pingIntervalMs = this._activePingIntervalMs;
    let isAlive = false;
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    const clearPingTimer = () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    };

    ws.on("open", () => {
      this.connectionState = "hello_sent";
      this.agentStatus.update({ connectionStatus: "handshaking" });

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
      let msg: Wire.ForemanMessage;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      void this.handleMessage(msg);
    });

    ws.on("close", (code: number, _reason: Buffer) => {
      clearPingTimer();
      if (ws !== this.ws) return;
      if (this._stopped) return;
      const delay = Math.random() * Math.min(this._activeMaxReconnectDelayMs, 1000 * Math.pow(2, this.reconnectAttempts));
      this.reconnectAttempts++;
      this.agentStatus.update({
        connectionStatus: "disconnected",
        disconnectCode: code,
        reconnectAt: Date.now() + delay,
      });
      setTimeout(() => this.connect(), delay);
    });

    ws.on("error", (err: Error) => {
      if (ws !== this.ws) return;
      this.display.print(c.amber(`WebSocket error: ${err.message}`));
      ws.terminate();
    });
  }

  private async handleMessage(msg: Wire.ForemanMessage): Promise<void> {
    this.display.printForemanMessage(msg);

    if (msg.type === "foreman_error") {
      if (msg.fatal) {
        this._stopped = true;
        this.currentAc?.abort();
        this.ws?.close();
        this.emit("fatal");
      }
      return;
    }

    if (msg.type === "repo_activated") {
      this.transitionToRegistered();
      return;
    }

    if (msg.type === "hello_ack") {
      this.reconnectAttempts = 0;
      if (msg.status === "cancelled") {
        this.currentAc?.abort();
        this.connectionState = "registered";
        this.bufferedMessages = [];
        this.pendingPrompts = [];
        this.pendingEvents = [];
        this.currentTaskId = undefined;
        this.currentIssue = undefined;
        this.agentStatus.update({
          connectionStatus: "connected",
          disconnectCode: undefined,
          taskNumber: undefined,
          prNumber: undefined,
          branch: "",
        });
        this.agentStatus.resetTaskStats();
        this.display.print(c.amber("Task cancelled (reassigned to another worker)."));
        const workspace = this.workspaceController?.workspace;
        if (workspace?.isCreated) {
          this._resetPromise = workspace.reset().then(() => {
            this.display.print(c.amber("Workspace reset."));
          }).catch((err: unknown) => {
            this.display.print(c.boldRed(`Workspace reset failed: ${err instanceof Error ? err.message : String(err)}`));
          }).finally(() => {
            this._resetPromise = null;
          });
        }
      } else if (msg.repoStatus === "new") {
        this.agentStatus.update({ connectionStatus: "connected", disconnectCode: undefined });
        this.display.print(c.amber(`Repo ${this.repo} is new — activate it?`));
        const idx = await this.pickFnOrDefault()(["Yes, activate", "No, skip"]);
        if (idx === 0) {
          this.ws?.send(JSON.stringify({ type: "activate_repo", workerId: this.agentId } satisfies Wire.WorkerMessage));
          return;
        }
        this.display.print(c.darkGray("Repo not activated. Staying idle."));
        this.transitionToRegistered();
      } else {
        this.transitionToRegistered();
      }
      return;
    }

    if (msg.type === "task_assigned") {
      this.currentTaskId = msg.taskId;
      this.currentIssue = msg.issue;
      this.prIsClosed = false;
      this.issueClosed = false;
      this.agentStatus.update({ taskNumber: msg.issue.number, prNumber: undefined });
      this.agentStatus.resetTaskStats();
      void this.refreshBranch();
      const initialPrompt = buildInitialPrompt(msg.issue, !!this.workspaceController?.workspace);
      this.display.print(c.sageGreen(initialPrompt));
      const enqueue = () => this.enqueuePrompt(initialPrompt, true);
      if (this._resetPromise) {
        void this._resetPromise.then(enqueue, enqueue);
      } else {
        enqueue();
      }
    } else if (msg.type === "event_notification") {
      if (msg.taskId !== this.currentTaskId) {
        this.display.print(c.darkGray(`[worker] ignoring event_notification for task ${msg.taskId} (current: ${this.currentTaskId ?? "none"})`));
        return;
      }

      const { event } = msg;
      const action = event.payload["action"] as string | undefined;

      if (event.name === "pull_request") {
        const pr = event.payload["pull_request"] as { number?: number; merged?: boolean } | undefined;
        if (action === "closed" && !pr?.merged) {
          this.agentStatus.update({ prNumber: undefined });
        } else if (pr?.number != null) {
          this.agentStatus.update({ prNumber: pr.number });
        }
        if (action === "closed") {
          this.prIsClosed = true;
        } else if (action === "reopened") {
          this.prIsClosed = false;
        }
      } else if (event.name === "issues") {
        if (action === "closed") {
          this.issueClosed = true;
        } else if (action === "reopened") {
          this.issueClosed = false;
        }
      } else if (this.prIsClosed && event.name === "check_suite") {
        return;
      }

      const classification = classifyEvent(event);
      if (classification === "log_only") {
        return;
      }

      this.pendingEvents.push(event);

      if (!this._queryRunning && this.currentTaskId && this.currentIssue) {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          if (!this._queryRunning && this.currentTaskId && this.currentIssue) {
            const events = this.pendingEvents.splice(0);
            if (events.length > 0) {
              this.enqueuePrompt(this.buildAndLogEventPrompt(events), false);
            }
          }
        }, debounceMs(this.pendingEvents));
      }
    }
  }

  private buildAndLogEventPrompt(events: Wire.WebhookEvent[]): string {
    const prompt = buildEventPrompt(events);
    this.display.print(c.sageGreen(prompt));
    return prompt;
  }
}
