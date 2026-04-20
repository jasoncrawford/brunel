import { EventEmitter } from "node:events";
import type { Settings } from "./settings.js";
import type { EffortValue } from "./settings.js";

// ── Worker status types ────────────────────────────────────────────────────────

export type WorkerConnectionStatus = "connected" | "disconnected" | "reconnecting" | "handshaking";

export type WorkerStatusPatch = {
  connectionStatus?: WorkerConnectionStatus;
  disconnectCode?: number | undefined;
  reconnectAt?: number | undefined;
  taskNumber?: number | undefined;
  prNumber?: number | undefined;
  branch?: string;
  model?: string | undefined;
  effort?: EffortValue | undefined;
};

// ── AgentStatus class ─────────────────────────────────────────────────────────

/**
 * Pure state model for worker status. Holds all worker status state
 * (connection, task, model, etc.) and emits "change" on updates. No
 * rendering, no screen geometry, no redraw callbacks. Analogous to
 * Settings on the agent side.
 *
 * Construct in the entry point and inject into Display and WorkerSession.
 * Display subscribes to "change" events for reactive status bar redraws.
 */
export class AgentStatus extends EventEmitter {
  readonly agentId: string;
  private _connectionStatus: WorkerConnectionStatus = "disconnected";
  private _disconnectCode: number | undefined;
  private _reconnectAt: number | undefined;
  private _taskNumber: number | undefined;
  private _prNumber: number | undefined;
  private _branch = "";
  private _model: string | undefined;
  private _effort: EffortValue | undefined;
  private _countdownTimer: ReturnType<typeof setInterval> | null = null;

  // Fired after a tool result is printed (tool has just finished running).
  // Used by the worker to refresh git branch in the status bar after Bash.
  private _onToolResult: ((toolName: string) => void) | null = null;

  constructor({ agentId, settings, ...initial }: { agentId: string; settings?: Settings } & Omit<WorkerStatusPatch, "reconnectAt">) {
    super();
    this.agentId = agentId;
    if ("connectionStatus" in initial) this._connectionStatus = initial.connectionStatus!;
    if ("disconnectCode" in initial) this._disconnectCode = initial.disconnectCode;
    if ("taskNumber" in initial) this._taskNumber = initial.taskNumber;
    if ("prNumber" in initial) this._prNumber = initial.prNumber;
    if ("branch" in initial) this._branch = initial.branch!;
    if ("model" in initial) this._model = initial.model;
    if ("effort" in initial) this._effort = initial.effort;
    if (settings) {
      this._model = settings.model;
      this._effort = settings.effort;
      settings.on("change", () => {
        this._model = settings.model;
        this._effort = settings.effort;
        this.emit("change");
      });
    }
  }

  // ── Worker status getters ──────────────────────────────────────────────────

  get connectionStatus(): WorkerConnectionStatus { return this._connectionStatus; }
  get disconnectCode(): number | undefined { return this._disconnectCode; }
  get reconnectAt(): number | undefined { return this._reconnectAt; }
  get taskNumber(): number | undefined { return this._taskNumber; }
  get prNumber(): number | undefined { return this._prNumber; }
  get branch(): string { return this._branch; }
  get model(): string | undefined { return this._model; }
  get effort(): EffortValue | undefined { return this._effort; }

  /** Apply a partial status update and emit "change". */
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
        this._countdownTimer = setInterval(() => {
          this.emit("change");
        }, 1000);
      }
    } else {
      if (this._countdownTimer) {
        clearInterval(this._countdownTimer);
        this._countdownTimer = null;
      }
    }
  }

  // ── Tool result callback ───────────────────────────────────────────────────

  setOnToolResult(fn: ((toolName: string) => void) | null): void {
    this._onToolResult = fn;
  }

  /** Invoke the tool-result callback (if registered) with the tool name. */
  fireOnToolResult(name: string): void {
    this._onToolResult?.(name);
  }
}
