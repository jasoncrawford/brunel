import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { c } from "../views/style.js";
import { AgentStatus } from "../models/agent-status.js";
import type { Display } from "../views/display.js";
import { buildInitialPrompt, buildEventPrompt } from "../worker-prompts.js";
import * as Wire from "../../../shared/wire.js";
import { fmtError } from "../../utils.js";
import { fmtNum, fmtTaskStats } from "../../../shared/formatters.js";
import { getConfig } from "../../config.js";
import type { CommandRegistry } from "./command-controller.js";
import { Picker, type PickResult } from "../views/picker.js";
import { WorkspaceController, UserCancelledError } from "./workspace-controller.js";

// ── WorkerDisplay interface ───────────────────────────────────────────────────

/**
 * Minimal display interface required by worker controllers.
 * Satisfied structurally by Display; tests can pass lightweight stubs.
 */
export interface WorkerDisplay {
  print(line: string | null): void;
  printForemanMessage(msg: Wire.ForemanMessage): void;
}

// ── Wire types ────────────────────────────────────────────────────────────────

export type WsFactory = (agentId: string, taskId?: string) => WebSocket;

/** Task state needed to decide whether and how to prompt before quitting or claiming. */
export type TaskConfirmInfo = {
  taskNumber: number;
  workerId: string;
  issueClosed: boolean;
};

/** A prompt queued by WorkerController for main() to execute. */
export type QueuedPrompt = { prompt: string; fresh: boolean };

/** Options for overriding WorkerController internals, primarily for testing. */
export type WorkerControllerOptions = {
  /** Inject a WS factory (default: builds from config in start()). */
  wsFactory?: WsFactory;
  /** Override the afterTask hook (default: derived from workspaceController.onReset). */
  afterTask?: () => Promise<void>;
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

  // ── Pending claim (cleared by stop() and after sending) ───────────────────
  private _pendingClaimTaskId: string | undefined;

  // ── Connection state (cleared by stop()) ──────────────────────────────────
  private ws: WebSocket | undefined;
  // Handshake lifecycle: "registered" = hello_ack received (or initial state);
  // "hello_sent" = worker_hello was sent but hello_ack not yet received.
  // Initialized to "registered" so instances that never connect (e.g. tests
  // that exercise only task state) behave as if already registered.
  private connectionState: "hello_sent" | "registered" = "registered";
  private bufferedMessages: BufferableMessage[] = [];
  private reconnectAttempts = 0;
  private _stopped = false;

  // ── Reserved state ────────────────────────────────────────────────────────
  private _isReserved = false;

  // ── Query state ───────────────────────────────────────────────────────────
  private currentAc: AbortController | null = null;
  private _queryRunning = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _eventsPaused = false;

  constructor(
    readonly agentStatus: AgentStatus,
    private readonly display: WorkerDisplay,
    private readonly picker: Picker | undefined,
    private readonly workspaceController: WorkspaceController | undefined,
    private readonly repo: string,
    private readonly options?: WorkerControllerOptions,
  ) {
    super();
  }

  // ── Public getters ────────────────────────────────────────────────────────

  get agentId(): string { return this.agentStatus.agentId; }
  /** True when worker mode is active (connected or connecting). */
  get isActive(): boolean { return this._isActive; }
  /** True when the worker has been reserved (waiting but not auto-assignable). */
  get isReserved(): boolean { return this._isReserved; }
  /** True when event auto-processing is paused (after ^C or first keystroke). */
  get eventsPaused(): boolean { return this._eventsPaused; }
  /** Number of paused pending events (non-zero only when paused and events are queued). */
  get pendingEventsCount(): number { return this._eventsPaused ? this.pendingEvents.length : 0; }
  /**
   * Human-readable labels for each pending event while paused, e.g. ["issue_comment/created",
   * "pull_request/closed"]. Returns [] when not paused or when queue is empty.
   */
  get pendingEventDetails(): string[] {
    if (!this._eventsPaused) return [];
    return this.pendingEvents.map(e => {
      const action = e.payload["action"] as string | undefined;
      return action ? `${e.name}/${action}` : e.name;
    });
  }

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
   * paused), and refreshes the branch display.
   *
   * If aborted (^C) and there are pending events, enters paused state and
   * prints a one-time notice. If not paused, drains events normally (existing
   * behavior). If already paused, events remain queued.
   */
  notifyQueryEnd(aborted = false): void {
    this.currentAc = null;
    this._queryRunning = false;
    if (aborted) {
      if (this.pendingEvents.length > 0 && !this._eventsPaused) {
        this._eventsPaused = true;
        this._syncPendingEventsStatus();
      }
    } else if (!this._eventsPaused) {
      if (this.pendingEvents.length > 0 && this.currentTaskId && this.currentIssue) {
        const events = this.pendingEvents.splice(0);
        this.enqueuePrompt(this.buildAndLogEventPrompt(events), false);
      }
    }
    void this.agentStatus.refreshBranch();
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
   * Pause event auto-processing. Clears any pending debounce timer so events
   * already queued will not auto-fire. Called when the user starts typing at
   * the input prompt (first keystroke, buffer empty → non-empty).
   */
  pauseEvents(): void {
    if (this._eventsPaused) return;
    this._eventsPaused = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this._syncPendingEventsStatus();
  }

  /**
   * Send worker_goodbye to the foreman if the WebSocket is currently open.
   * Called before clean exits (SIGTERM, /quit) so the foreman can immediately
   * revert the task to pending without waiting for the reclaim timeout.
   */
  sendGoodbye(opts?: { task_complete?: boolean; stats?: { inputTokens: number; outputTokens: number; costUsd?: number } }): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const msg: Record<string, unknown> = {
        type: "worker_goodbye",
        workerId: this.agentStatus.agentId,
        taskId: this.currentTaskId,
      };
      if (opts?.task_complete) msg.task_complete = true;
      if (opts?.stats) msg.stats = opts.stats;
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Send worker_ready to opt back into auto-assignment from a reserved state. */
  sendWorkerReady(): void {
    // Guard with connectionState so this is never sent before hello_ack (e.g. during reconnect).
    if (this.ws?.readyState === WebSocket.OPEN && this.connectionState === "registered") {
      this.ws.send(JSON.stringify({
        type: "worker_ready",
        workerId: this.agentStatus.agentId,
      } satisfies Wire.WorkerMessage));
    }
  }

  /**
   * Reserve the worker: transition from the waiting state (ready, no task) to
   * reserved. The foreman stops auto-assigning tasks, and the user can pick a
   * specific task via /worker:claim. No-op if not active or if a task is assigned.
   */
  reserve(): void {
    if (!this._isActive || this.currentTaskId !== undefined) return;
    this._isReserved = true;
    this.agentStatus.update({ workerReady: false });
    if (this.ws?.readyState === WebSocket.OPEN && this.connectionState === "registered") {
      this.ws.send(JSON.stringify({
        type: "worker_reserved",
        workerId: this.agentStatus.agentId,
      } satisfies Wire.WorkerMessage));
    }
    this.display.print(c.sageGreen("Reserved — use /worker:claim to pick a task."));
  }

  private async buildCompleteGoodbyeOpts(): Promise<{ task_complete: true; stats?: { inputTokens: number; outputTokens: number; costUsd?: number } }> {
    // No afterTask reset here — the workspace will be destroyed when the process exits.
    const { taskInputTokens, taskOutputTokens, taskCostUsd } = this.agentStatus;
    const hasStats = taskInputTokens > 0 || taskOutputTokens > 0 || taskCostUsd != null;
    const statsStr = fmtTaskStats(taskInputTokens, taskOutputTokens, taskCostUsd);
    this.display.print(c.sageGreen(`Task #${this.currentIssue?.number} complete, ${statsStr}`));
    return {
      task_complete: true,
      ...(hasStats && { stats: { inputTokens: taskInputTokens, outputTokens: taskOutputTokens, costUsd: taskCostUsd } }),
    };
  }

  /**
   * Returns task confirm info if a task is currently active, undefined otherwise.
   * Used by the quit/exit and claim handlers to decide whether to prompt the user.
   */
  getTaskConfirmInfo(): TaskConfirmInfo | undefined {
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
   * - Issue closed but not complete: asks whether to complete first (default yes).
   * - Issue still open: warns about unassignment and asks to confirm quit (default no).
   *
   * Returns 'quit' to proceed without completing, 'complete-and-quit' to mark
   * the task complete then quit, or 'cancel' to stay in the worker.
   */
  async confirmTaskQuit(
    info: TaskConfirmInfo,
    pickFn: (options: string[]) => Promise<number> = (opts) => this.picker!.pick(opts),
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
   * Prompt the user before claiming a new task while already working on one.
   *
   * - Issue closed but not complete: asks whether to complete first (default yes).
   * - Issue still open: warns about unassignment and asks to confirm (default no).
   *
   * Returns 'complete-and-claim' to complete the current task then claim,
   * 'claim' to abandon the current task and claim, or 'cancel' to do nothing.
   */
  async confirmTaskClaim(
    info: TaskConfirmInfo,
    pickFn: (options: string[]) => Promise<number> = (opts) => this.picker!.pick(opts),
  ): Promise<"claim" | "complete-and-claim" | "cancel"> {
    if (info.issueClosed) {
      this.display.print(c.amber(`\nTask #${info.taskNumber} is closed but not complete. Complete it before claiming a new task?`));
      const idx = await pickFn(["Yes, complete first", "No, just claim", "Don't claim"]);
      if (idx === 0) return "complete-and-claim";
      if (idx === 1) return "claim";
      return "cancel";
    } else {
      this.display.print(c.amber(`\nTask #${info.taskNumber} is still open. Claiming a new task will unassign ${info.workerId}. Proceed?`));
      const idx = await pickFn(["No, keep working", "Yes, claim anyway"]);
      if (idx === 1) return "claim";
      return "cancel";
    }
  }

  /**
   * Complete the current task: send task_complete, reset state, then prompt the user
   * for what to do next.
   *
   * Always sends nextState: "reserved" to the foreman so it doesn't auto-assign a new
   * task while the picker is showing. promptAfterTaskComplete() calls sendWorkerReady()
   * only after the user confirms they want to keep waiting.
   *
   * For the claim flow (nextState: "reserved"), afterTask runs before task_complete so
   * a UserCancelledError can abort the completion if the workspace has unsafe changes.
   * For the default flow (nextState: "ready"), afterTask is deferred to after the picker
   * so the picker appears immediately; the exit option skips afterTask entirely since
   * the workspace is about to be destroyed.
   *
   * Pass "reserved" explicitly to skip the picker entirely (claim flow — the caller
   * handles the next action, e.g. sendClaimTask).
   *
   * Returns 'task-complete' if the worker should remain (or become) idle,
   * 'exit' if the user chose to quit, or undefined if no task was assigned.
   */
  async completeCurrentTask(nextState: "ready" | "reserved" = "ready"): Promise<"task-complete" | "exit" | undefined> {
    if (!this.currentTaskId) return undefined;
    if (nextState === "reserved" && this._activeAfterTask) {
      // Claim flow: run afterTask before marking complete so UserCancelledError can
      // abort if the workspace has unsafe changes.
      try { await this._activeAfterTask(); } catch (err) {
        if (err instanceof UserCancelledError) throw err;
        this.display.print(c.amber(`afterTask failed: ${fmtError(err)}`));
      }
    }
    const { taskInputTokens, taskOutputTokens, taskCostUsd } = this.agentStatus;
    const hasStats = taskInputTokens > 0 || taskOutputTokens > 0 || taskCostUsd != null;
    this.sendTaskMessage({
      type: "task_complete",
      workerId: this.agentStatus.agentId,
      taskId: this.currentTaskId,
      nextState: "reserved",
      ...(hasStats && { stats: { inputTokens: taskInputTokens, outputTokens: taskOutputTokens, costUsd: taskCostUsd } }),
    });
    const taskNumber = this.currentIssue!.number;
    this.currentTaskId = undefined;
    this.currentIssue = undefined;
    const statsStr = fmtTaskStats(this.agentStatus.taskInputTokens, this.agentStatus.taskOutputTokens, this.agentStatus.taskCostUsd);
    this.display.print(c.sageGreen(`Task #${taskNumber} complete, ${statsStr}`));
    this.agentStatus.resetTaskStats();
    this.agentStatus.update({ taskNumber: undefined, prNumber: undefined });
    await this.agentStatus.refreshBranch();
    // When called with "reserved", skip the picker — caller handles next action.
    if (nextState === "reserved") return "task-complete";
    return this.promptAfterTaskComplete();
  }

  /**
   * After completing a task, prompt the user for what to do next.
   * When no picker is available (non-interactive mode) defaults to waiting.
   *
   * Calls sendWorkerReady() only when the user confirms they want to keep waiting —
   * this is what transitions the foreman from "reserved" to auto-assignable.
   *
   * Option 1 ("Claim a specific task:") uses inline text entry via textEntryIndex: 1.
   *
   * afterTask (workspace reset) runs after the picker for all options except Exit,
   * where it is skipped entirely since the workspace will be destroyed on exit.
   */
  private async promptAfterTaskComplete(): Promise<"task-complete" | "exit"> {
    // task_complete was already sent to the foreman by completeCurrentTask().
    const options = [
      "Wait to be assigned the next task",
      "Claim a specific task:",
      "Stop working for now",
      "Exit",
    ];

    const result = await this.postTaskPick(options);

    if (result.type === "other") {
      const taskId = result.text.trim();
      await this.runAfterTaskReset();
      if (taskId) this.claimAfterTask(taskId);
      return "task-complete";
    }

    const index = result.type === "selected" ? result.index : -1;
    switch (index) {
      case 2:
        await this.runAfterTaskReset();
        await this.stop();
        return "task-complete";
      case 3:
        // exit: skip reset — workspace will be destroyed
        await this.stop();
        return "exit";
      default:
        await this.runAfterTaskReset();
        this.sendWorkerReady();
        this.display.print(c.sageGreen("Waiting for next task..."));
        return "task-complete";
    }
  }

  /** Run afterTask (workspace reset) after the picker, swallowing errors non-fatally. */
  private async runAfterTaskReset(): Promise<void> {
    if (!this._activeAfterTask) return;
    try {
      await this._activeAfterTask();
    } catch (err) {
      if (err instanceof UserCancelledError) {
        this.display.print(c.amber("Workspace reset cancelled."));
        return;
      }
      // Log but don't abort — task_complete was already sent.
      this.display.print(c.amber(`afterTask failed: ${fmtError(err)}`));
    }
  }

  private async postTaskPick(options: string[]): Promise<PickResult> {
    if (this.picker) {
      return this.picker.pick(options, { textEntryIndex: 1, textEntryPrefix: "Claim a specific task: " });
    }
    return { type: "selected", index: 0 }; // non-interactive: default to wait
  }

  private claimAfterTask(taskId: string): void {
    if (this.connectionState === "registered") {
      this.sendClaimTask(taskId);
    } else {
      this._pendingClaimTaskId = taskId;
    }
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
    this._activePingIntervalMs = getConfig().pingIntervalMs ?? 25_000;
    this._activeMaxReconnectDelayMs = getConfig().maxReconnectDelayMs ?? 300_000;

    this._stopped = false;
    this._isActive = true;

    this.agentStatus.update({ model: getConfig().model, effort: getConfig().effort });
    this.agentStatus.setWorkerModeActive(true);
    this.agentStatus.setOnToolResult((toolName) => {
      // Refresh the branch display after each Bash tool completes so the status
      // bar reflects branch changes (e.g. git checkout) without waiting for the
      // full query to finish.
      if (toolName === "Bash") void this.agentStatus.refreshBranch();
    });
    void this.agentStatus.refreshBranch();
    this.connect();
  }

  /** Disconnect from the foreman. Prompts if a task is in progress. */
  async stop(): Promise<void> {
    if (!this._isActive) return;
    const taskInfo = this.getTaskConfirmInfo();
    let goodbyeOpts: { task_complete?: boolean; stats?: { inputTokens: number; outputTokens: number; costUsd?: number } } | undefined;
    if (taskInfo) {
      const choice = await this.confirmTaskQuit(taskInfo);
      if (choice === "cancel") return;
      if (choice === "complete-and-quit") {
        try { goodbyeOpts = await this.buildCompleteGoodbyeOpts(); } catch (err) {
          if (err instanceof UserCancelledError) return;
          throw err;
        }
      }
    }
    this._stopped = true;
    this.sendGoodbye(goodbyeOpts);
    this.ws?.close();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.resetSessionState();
    this._isActive = false;
    this.agentStatus.setWorkerModeActive(false);
    this.display.print(c.sageGreen("Worker mode stopped."));
    await this.agentStatus.refreshBranch();
  }

  /** Register /worker:complete, /worker:start, /worker:stop, /worker:claim into the given (already-scoped) registry. */
  registerCommands(registry: CommandRegistry): void {
    registry.register("complete", {
      description: "Mark the current task as done",
      aliases: ["done"],
      handler: async () => {
        if (!this._isActive) {
          this.display.print(c.boldRed("Not connected to a foreman."));
          return undefined;
        }
        try { return await this.completeCurrentTask(); } catch (err) {
          if (err instanceof UserCancelledError) return undefined;
          throw err;
        }
      },
    });
    registry.register("start", {
      description: "Start accepting tasks from the foreman",
      aliases: ["ready"],
      handler: async () => {
        if (!this._isActive) {
          await this.start();
          return undefined;
        }
        if (this.hasTask()) {
          const taskInfo = this.getTaskConfirmInfo();
          if (taskInfo) {
            if (taskInfo.issueClosed) {
              this.display.print(c.amber(`\nTask #${taskInfo.taskNumber} is closed but not complete. Complete it before waiting for new tasks?`));
              const idx = await this.picker!.pick(["Yes, complete and wait for new tasks", "No, just wait for new tasks", "Cancel"]);
              if (idx === 2) return undefined;
              if (idx === 0) {
                try {
                  await this.completeCurrentTask("reserved");
                } catch (err) {
                  if (err instanceof UserCancelledError) return undefined;
                  throw err;
                }
              } else {
                this.currentTaskId = undefined;
                this.currentIssue = undefined;
              }
            } else {
              this.display.print(c.amber(`\nCurrently assigned task #${taskInfo.taskNumber}. Abandon this task?`));
              const idx = await this.picker!.pick(["Yes, abandon and wait for new tasks", `No, stay with task #${taskInfo.taskNumber}`]);
              if (idx !== 0) return undefined;
              this.currentTaskId = undefined;
              this.currentIssue = undefined;
            }
          }
        }
        this.sendWorkerReady();
        this.transitionToIdle();
        return undefined;
      },
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
    registry.register("resume-events", {
      description: "Resume processing of GitHub events, when paused, and process queued events",
      handler: async () => {
        if (!this._isActive) {
          this.display.print(c.boldRed("Not connected to a foreman."));
          return undefined;
        }
        if (!this._eventsPaused) {
          this.display.print(c.amber("Event processing is not paused."));
          return undefined;
        }
        const events = this.pendingEvents.splice(0);
        this._eventsPaused = false;
        this._syncPendingEventsStatus();
        if (events.length === 0) {
          this.display.print(c.amber("Event processing resumed — no events queued."));
        } else if (this.currentTaskId && this.currentIssue) {
          this.enqueuePrompt(this.buildAndLogEventPrompt(events), false);
        }
        return undefined;
      },
    });
    registry.register("claim", {
      description: "Claim a specific task by ID",
      handler: async (args: string) => {
        const taskId = args.trim();
        if (!taskId) {
          this.display.print(c.boldRed("Usage: /worker:claim <taskId>"));
          return undefined;
        }
        if (this.hasTask()) {
          const taskInfo = this.getTaskConfirmInfo();
          if (taskInfo) {
            const choice = await this.confirmTaskClaim(taskInfo);
            if (choice === "cancel") return undefined;
            if (choice === "complete-and-claim") {
              try {
                // Complete with "reserved" so foreman doesn't auto-assign
                // while we're about to claim a specific task.
                await this.completeCurrentTask("reserved");
              } catch (err) {
                if (err instanceof UserCancelledError) return undefined;
                throw err;
              }
              // currentTaskId is now cleared; fall through to claim below
            } else {
              // "claim" — abandon current task: signal foreman and reconnect with new claim
              this._pendingClaimTaskId = taskId;
              this.sendGoodbye();
              this.currentTaskId = undefined;
              this.currentIssue = undefined;
              this.ws?.close();
              return undefined;
            }
          }
        }
        if (!this._isActive) {
          // Include the claim in the hello so it's atomic with registration.
          this._pendingClaimTaskId = taskId;
          await this.start();
          if (!this._isActive) this._pendingClaimTaskId = undefined;
          return undefined;
        }
        if (this.connectionState === "registered") {
          this.sendClaimTask(taskId);
        } else {
          this._pendingClaimTaskId = taskId;
        }
        return undefined;
      },
    });
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private buildWsFactory(): WsFactory {
    return () => new WebSocket(`${getConfig().foremanUrl}/worker`);
  }

  private resetSessionState(): void {
    this.currentTaskId = undefined;
    this.currentIssue = undefined;
    this.pendingEvents = [];
    this.pendingPrompts = [];
    this.prIsClosed = false;
    this.issueClosed = false;
    this._resetPromise = null;
    this._pendingClaimTaskId = undefined;
    this._isReserved = false;
    this.ws = undefined;
    this.connectionState = "registered";
    this.bufferedMessages = [];
    this.reconnectAttempts = 0;
    this.currentAc = null;
    this._queryRunning = false;
    this._eventsPaused = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this._syncPendingEventsStatus();
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
   * immediately flushes if the handshake is complete. This way the buffer
   * is the single code path regardless of connection state.
   */
  private sendTaskMessage(msg: BufferableMessage): void {
    this.bufferedMessages.push(msg);
    this.flushBuffer();
  }

  private transitionToRegistered(): void {
    this.connectionState = "registered";
    this.agentStatus.update({ connectionStatus: "connected", disconnectCode: undefined });
    this.flushBuffer();
    if (this._pendingClaimTaskId) {
      const taskId = this._pendingClaimTaskId;
      this._pendingClaimTaskId = undefined;
      this.sendClaimTask(taskId);
    }
  }

  private transitionToIdle(): void {
    this.transitionToRegistered();
    this.agentStatus.update({ workerReady: true });
    this.display.print(c.sageGreen("Waiting for tasks..."));
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

  private sendClaimTask(taskId: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "claim_task",
        workerId: this.agentStatus.agentId,
        taskId,
      } satisfies Wire.WorkerMessage));
    }
  }

  private connect(): void {
    // Clearing reconnectAt stops the countdown timer in the model.
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
      // If a claim is pending, connect as "reserved" so the foreman doesn't
      // auto-assign while we're about to claim a specific task. After hello_ack,
      // transitionToRegistered() will send the claim_task message automatically.
      // Do NOT put _pendingClaimTaskId in the hello — it will be sent as claim_task.
      const hasPendingClaim = !!this._pendingClaimTaskId;
      ws.send(JSON.stringify({
        type: "worker_hello",
        workerId: this.agentStatus.agentId,
        repo: this.repo,
        ...(this.currentTaskId !== undefined && { taskId: this.currentTaskId }),
        status: this.currentTaskId ? "assigned" : (hasPendingClaim ? "reserved" : "ready"),
      } satisfies Wire.WorkerMessage));

      this.connectionState = "hello_sent";
      this.agentStatus.update({ connectionStatus: "handshaking" });

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
      let msg: Wire.ForemanMessage;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      void this.handleMessage(msg);
    });

    ws.on("close", (code: number, _reason: Buffer) => {
      clearPingTimer(); // always clean up the ping timer when this socket closes
      if (ws !== this.ws) return; // stale close from a previous connection
      if (this._stopped) return; // fatal error received; don't reconnect
      // Full Jitter (Brooker 2015): spread = entire [0, cap] window at high attempt counts.
      const delay = Math.random() * Math.min(this._activeMaxReconnectDelayMs, 1000 * Math.pow(2, this.reconnectAttempts));
      this.reconnectAttempts++;
      // Setting reconnectAt starts a 1-second countdown timer in the model.
      this.agentStatus.update({
        connectionStatus: "disconnected",
        disconnectCode: code,
        reconnectAt: Date.now() + delay,
      });
      setTimeout(() => this.connect(), delay);
    });

    ws.on("error", (err: Error) => {
      if (ws !== this.ws) return; // stale error from a previous connection
      this.display.print(c.amber(`WebSocket error: ${err.message}`));
      // Ensure close fires even for errors that don't automatically close the socket
      // (e.g. some TLS negotiation failures on older Node.js / ws versions).
      ws.terminate();
    });
  }

  private async handleMessage(msg: Wire.ForemanMessage): Promise<void> {
    this.display.printForemanMessage(msg);

    if (msg.type === "foreman_error") {
      if (msg.fatal) {
        this._stopped = true;
        this.currentAc?.abort(); // abort any running query immediately
        this.ws?.close();
        this.emit("fatal");
      }
      return;
    }

    if (msg.type === "repo_activated") {
      this.transitionToIdle();
      // Re-start the main routing loop's stdin listening. The activation picker
      // cancelled the active ask(); without this, the loop stays blocked at
      // nextRoutingEvent() with no stdin listener until a task arrives.
      this.emit("prompts_ready");
      return;
    }

    if (msg.type === "hello_ack") {
      this.reconnectAttempts = 0; // connection succeeded; reset backoff
      if (msg.status === "cancelled") {
        // Task was reassigned while worker was disconnected — stop and reset.
        this.currentAc?.abort(); // abort any running query immediately
        this.connectionState = "registered";
        this.bufferedMessages = [];
        this.pendingPrompts = [];
        this.pendingEvents = [];
        this._eventsPaused = false;
        this.currentTaskId = undefined;
        this.currentIssue = undefined;
        this.agentStatus.update({
          connectionStatus: "connected",
          disconnectCode: undefined,
          taskNumber: undefined,
          prNumber: undefined,
          branch: "",
          pendingEventsCount: 0,
          eventsPaused: false,
        });
        this.agentStatus.resetTaskStats();
        this.display.print(c.amber("Task cancelled (reassigned to another worker)."));
        const workspace = this.workspaceController?.workspace;
        if (workspace?.isCreated) {
          this.transitionToRegistered();
          this.display.print(c.amber("Resetting workspace..."));
          this._resetPromise = workspace.reset().then(() => {
            this.display.print(c.amber("Workspace reset."));
          }).catch((err: unknown) => {
            this.display.print(c.boldRed(`Workspace reset failed: ${err instanceof Error ? err.message : String(err)}`));
          }).finally(() => {
            this._resetPromise = null;
            this.transitionToIdle();
          });
        } else {
          this.transitionToIdle();
        }
      } else if (msg.repoStatus === "new") {
        // Show "Connected" in the status bar before waiting for user input — the
        // worker IS connected, it just needs activation. connectionState stays
        // "hello_sent" so buffered messages are not flushed prematurely.
        this.agentStatus.update({ connectionStatus: "connected", disconnectCode: undefined });
        // Repo is new — ask the user whether to activate it before proceeding.
        this.display.print(c.amber(`Repo ${this.repo} is new — activate it?`));
        const idx = await this.picker!.pick(["Yes, activate", "No, skip"]);
        if (idx === 0) {
          // Send activate_repo — foreman will reply with a repo_activated message.
          this.ws?.send(JSON.stringify({ type: "activate_repo", workerId: this.agentId } satisfies Wire.WorkerMessage));
          return; // wait for repo_activated
        }
        // User declined — exit worker mode and wake the routing loop so stdin
        // is re-established. Without this, the routing loop stays stuck at
        // nextRoutingEvent() with no stdin listeners after the picker finishes.
        this.display.print(c.darkGray("Repo not activated."));
        await this.stop();
        this.emit("prompts_ready");
      } else {
        // "ready", "reserved", or "assigned" with active repoStatus.
        // "reserved" and "assigned" both call transitionToRegistered(), which
        // flushes the buffer and sends any pending claim_task message.
        if (msg.status === "ready") {
          this.transitionToIdle();
        } else {
          this.transitionToRegistered();
        }
      }
      return;
    }

    if (msg.type === "task_assigned") {
      this._isReserved = false;
      this.currentTaskId = msg.taskId;
      this.currentIssue = msg.issue;
      this.prIsClosed = false;
      this.issueClosed = msg.issue.status === "closed";
      // Reset event state so the new task starts with a clean slate.
      this._eventsPaused = false;
      this.pendingEvents = [];
      if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
      this.agentStatus.update({ taskNumber: msg.issue.number, prNumber: msg.issue.prNumber ?? undefined, workerReady: false });
      this.agentStatus.resetTaskStats();
      this._syncPendingEventsStatus();
      void this.agentStatus.refreshBranch();
      const initialPrompt = buildInitialPrompt(msg.issue, !!this.workspaceController?.workspace);
      this.display.print(c.sageGreen(initialPrompt));
      const enqueue = () => this.enqueuePrompt(initialPrompt, true);
      // If a workspace reset is in progress (from a cancelled hello_ack), defer the
      // prompt until the reset finishes — otherwise the task could run in a dirty workspace.
      if (this._resetPromise) {
        void this._resetPromise.then(enqueue, enqueue);
      } else {
        enqueue(); // fresh=true: new task, reset session
      }
    } else if (msg.type === "event_notification") {
      if (msg.taskId !== this.currentTaskId) {
        // Ignore stale events forwarded for tasks we're no longer working on.
        this.display.print(c.darkGray(`[worker] ignoring event_notification for task ${msg.taskId} (current: ${this.currentTaskId ?? "none"})`));
        return;
      }

      const { event } = msg;
      const action = event.payload["action"] as string | undefined;

      if (event.name === "pull_request") {
        const pr = event.payload["pull_request"] as { number?: number; merged?: boolean } | undefined;
        if (action === "closed" && !pr?.merged) {
          // PR was closed without merging — clear the PR from the status bar.
          this.agentStatus.update({ prNumber: undefined });
        } else if (pr?.number != null) {
          // Track PR number for the status bar.
          this.agentStatus.update({ prNumber: pr.number });
        }
        // Track prIsClosed flag.
        if (action === "closed") {
          this.prIsClosed = true; // process normally (cleanup prompt still fires)
        } else if (action === "reopened") {
          this.prIsClosed = false; // process normally
        }
      } else if (event.name === "issues") {
        if (action === "closed") {
          this.issueClosed = true;
        } else if (action === "reopened") {
          this.issueClosed = false;
        }
      } else if (this.prIsClosed && event.name === "check_suite") {
        // Post-merge check suite: already logged via printForemanMessage; silently drop.
        return;
      }

      const classification = classifyEvent(event);
      if (classification === "log_only") {
        // Already logged via printForemanMessage above; no further action.
        return;
      }

      // Actionable event: queue it for debounced dispatch.
      this.pendingEvents.push(event);
      if (this._eventsPaused) this._syncPendingEventsStatus();

      if (!this._eventsPaused && !this._queryRunning && this.currentTaskId && this.currentIssue) {
        // No query running and not paused: set up/reset debounce timer to batch rapid events.
        // When the timer fires, events are enqueued and main()'s ask() is signalled.
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          if (!this._eventsPaused && !this._queryRunning && this.currentTaskId && this.currentIssue) {
            const events = this.pendingEvents.splice(0);
            if (events.length > 0) {
              this.enqueuePrompt(this.buildAndLogEventPrompt(events), false);
            }
            // If _queryRunning became true while debounce was pending, events stay in
            // pendingEvents to be drained by notifyQueryEnd().
          }
        }, debounceMs(this.pendingEvents));
      }
      // If _queryRunning or _eventsPaused: events stay in pendingEvents.
    }
  }

  private _syncPendingEventsStatus(): void {
    this.agentStatus.update({
      eventsPaused: this._eventsPaused,
      pendingEventsCount: this._eventsPaused ? this.pendingEvents.length : 0,
    });
  }

  private buildAndLogEventPrompt(events: Wire.WebhookEvent[]): string {
    const prompt = buildEventPrompt(events);
    this.display.print(c.sageGreen(prompt));
    return prompt;
  }
}
