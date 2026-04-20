import { EventEmitter } from "node:events";
import { shortWorkerId } from "../../../shared/utils.js";
import { getConfig } from "../../config.js";
import type { Settings } from "../models/settings.js";
import type { EffortValue } from "../models/settings.js";
import { W } from "./style.js";

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

  /** Format the current worker status as a single terminal line.
   * Pass the available width (terminal columns minus 1) for accurate truncation;
   * defaults to W-1 when width is not supplied (e.g. in tests). */
  getStatusText(width = W - 1): string {
    return this._fmtWorkerStatus(width);
  }

  private _fmtWorkerStatus(width: number): string {
    // Right side: connection status
    const retryInSeconds = this._reconnectAt != null
      ? Math.max(0, Math.ceil((this._reconnectAt - Date.now()) / 1000))
      : undefined;
    const codeStr = getConfig().verbose && this._disconnectCode != null ? ` (${this._disconnectCode})` : "";
    const rightText =
      this._connectionStatus === "connected"    ? "Connected" :
      this._connectionStatus === "handshaking"  ? "Handshaking..." :
      this._connectionStatus === "reconnecting" ? "Reconnecting..." :
      retryInSeconds != null                    ? `Disconnected${codeStr}. Retrying in ${retryInSeconds}s` :
                                                  `Disconnected${codeStr}`;

    // Left side: worker {id8} ∙ {model} ∙ {task info}
    const modelName = (!this._model || this._model === "default") ? "sonnet" : this._model;
    const effortStr = this._effort ? ` (${this._effort})` : "";
    const parts: string[] = [`worker ${shortWorkerId(this.agentId)}`, `${modelName}${effortStr}`];
    if (this._taskNumber != null) parts.push(`task #${this._taskNumber}`);
    else parts.push("no current task");
    if (this._prNumber != null) parts.push(`PR #${this._prNumber}`);
    if (this._branch) parts.push(this._branch);
    let leftText = parts.join(" ∙ ");

    // Truncate left side if needed to leave room for right side with a gap of 1
    const maxLeftLen = Math.max(0, width - rightText.length - 1);
    if (leftText.length > maxLeftLen) {
      leftText = leftText.slice(0, Math.max(0, maxLeftLen - 1)) + "…";
    }

    const gap = Math.max(1, width - leftText.length - rightText.length);
    // Dim sage-green background + bright-white text. No trailing reset: drawRaw()
    // appends \x1b[K (fills remaining width with the same background) then \x1b[0m.
    return `\x1b[48;5;22m\x1b[97m${leftText + " ".repeat(gap) + rightText}`;
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
