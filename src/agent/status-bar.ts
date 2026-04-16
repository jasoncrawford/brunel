import { EventEmitter } from "node:events";
import { shortWorkerId } from "../../shared/utils.js";
import { verbose } from "./display.js";
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

// ── Worker status bar formatting ──────────────────────────────────────────────

const W = 70;

// ── StatusBar class ───────────────────────────────────────────────────────────

/**
 * Reactive model + terminal renderer for the worker status bar. Holds all
 * worker status state (connection, task, model, etc.) and manages the two
 * terminal status bar rows (animated query-progress and persistent worker
 * status). Call update() to change state — it re-renders automatically.
 *
 * Use the shared `statusBar` singleton for normal production use. Instantiate
 * directly in tests that need an isolated instance.
 */
export class StatusBar extends EventEmitter {
  // ── Worker status state ────────────────────────────────────────────────────
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

  // ── Primary (animated query-progress) bar ──────────────────────────────────
  /** Whether the primary animated status bar is currently active. */
  active = false;
  private _text = "";
  private _interval: ReturnType<typeof setInterval> | null = null;

  // ── Persistent (worker) bar ────────────────────────────────────────────────
  /** Whether the persistent worker status bar is currently active. */
  persistentActive = false;
  private _persistentText = "";

  // ── Callbacks ──────────────────────────────────────────────────────────────

  // Fired after a tool result is printed (tool has just finished running).
  // Used by the worker to refresh git branch in the status bar after Bash.
  private _onToolResult: ((toolName: string) => void) | null = null;

  // Registered by ask() while it is active. print() routes through these so
  // output doesn't corrupt the interactive prompt/suggestion area.
  inputPrint: (() => void) | null = null;
  inputStatus: (() => void) | null = null;
  // Registered by ask(). Called by print() BEFORE writing output to clear the
  // prompt area including any leading blank line (see issue #418).
  inputClear: (() => void) | null = null;

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
        this.updatePersistent();
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

  /** Apply a partial status update, re-render the persistent bar, and emit "change". */
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
    this.updatePersistent();
    this.emit("change");
  }

  private _syncCountdownTimer(): void {
    if (this._reconnectAt != null) {
      if (!this._countdownTimer) {
        this._countdownTimer = setInterval(() => {
          this.updatePersistent();
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

  /** Format the current worker status as a single terminal line. */
  getStatusText(): string {
    return this._fmtWorkerStatus();
  }

  private _fmtWorkerStatus(): string {
    const width = (process.stdout.columns ?? W) - 1; // -1 to avoid last-column wrap

    // Right side: connection status
    const retryInSeconds = this._reconnectAt != null
      ? Math.max(0, Math.ceil((this._reconnectAt - Date.now()) / 1000))
      : undefined;
    const codeStr = verbose && this._disconnectCode != null ? ` (${this._disconnectCode})` : "";
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
    // Dim sage-green background + bright-white text. No trailing reset: draw()
    // appends \x1b[K (fills remaining width with the same background) then \x1b[0m.
    return `\x1b[48;5;22m\x1b[97m${leftText + " ".repeat(gap) + rightText}`;
  }

  // ── Callback setters/getters ───────────────────────────────────────────────

  setOnToolResult(fn: ((toolName: string) => void) | null): void {
    this._onToolResult = fn;
  }

  /** Invoke the tool-result callback (if registered) with the tool name. */
  fireOnToolResult(name: string): void {
    this._onToolResult?.(name);
  }

  // ── Internal rendering helpers ─────────────────────────────────────────────

  private _lineCount(): number {
    const n = (this.active ? 1 : 0) + (this.persistentActive ? 1 : 0);
    return n === 2 ? 3 : n; // blank separator between the two bars when both active
  }

  /**
   * Clear all active status bar rows. No-ops when ask() owns the screen
   * (it handles its own redraws via the input callbacks).
   */
  clear(): void {
    if (this.inputPrint || this.inputStatus) return; // ask() owns the screen
    const n = this._lineCount();
    if (n === 0) return;
    // Cursor rests on the blank separator row above the status lines.
    // Move down through each status line erasing it, then return to the
    // blank separator row and restore the cursor.
    let seq = "";
    for (let i = 0; i < n; i++) seq += "\x1b[B\r\x1b[K";
    seq += `\x1b[${n}A\r`;
    seq += "\x1b[?25h";  // show cursor
    process.stdout.write(seq);
  }

  /**
   * Draw all active status bar rows. Routes through input callbacks when
   * ask() is active so the prompt area is updated without misaligning the cursor.
   */
  draw(): void {
    if (this.inputStatus) {
      // ask() is active and cursor is in the buffer area — use the status-aware
      // redraw that navigates back to the prompt line before redrawing.
      this.inputStatus();
      return;
    }
    if (this.inputPrint) {
      // ask() is active after display.print() — cursor is at a fresh new line.
      this.inputPrint();
      return;
    }
    const n = this._lineCount();
    if (n === 0) return;
    // Cursor is on the blank separator row. Draw each status line below it,
    // then return cursor to the blank separator row and hide it.
    let seq = "";
    if (this.active) seq += `\n\r${this._text}\x1b[K\x1b[0m`;
    if (this.active && this.persistentActive) seq += `\n\r\x1b[K`; // blank line between bars
    if (this.persistentActive) seq += `\n\r${this._persistentText}\x1b[K\x1b[0m`;
    seq += `\x1b[${n}A\r`;
    seq += "\x1b[?25l";  // hide cursor
    process.stdout.write(seq);
  }

  /**
   * Write the status bar rows starting from the current cursor position (no
   * leading blank separator). Returns the total number of extra rows written
   * (0 if no bars are active). Called by ask() to integrate status bars into
   * the prompt+suggestion area.
   */
  drawRaw(): number {
    const n = this._lineCount();
    if (n === 0) return 0;
    let seq = "\r\n\x1b[K"; // blank separator row
    if (this.active) seq += `\r\n${this._text}\x1b[K\x1b[0m`;
    if (this.active && this.persistentActive) seq += `\r\n\x1b[K`;
    if (this.persistentActive) seq += `\r\n${this._persistentText}\x1b[K\x1b[0m`;
    process.stdout.write(seq);
    return 1 + n; // blank separator + n bar rows
  }

  // ── Primary (animated) status bar ─────────────────────────────────────────

  /** Start the animated query-progress bar, polling getText() every 500ms. */
  start(getText: () => string): void {
    this.clear();
    this.active = true;
    this._text = getText();
    this.draw();
    this._interval = setInterval(() => {
      this.clear();
      this._text = getText();
      this.draw();
    }, 500);
  }

  /** Stop the animated bar and redraw any persistent bar. */
  stop(): void {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
    this.clear();
    this.active = false;
    this._text = "";
    this.draw();
  }

  // ── Persistent (worker) status bar ────────────────────────────────────────

  /**
   * Show the worker status bar. Renders immediately using the current state
   * and redraws automatically whenever update() is called.
   */
  startPersistent(): void {
    this.clear();
    this.persistentActive = true;
    this._persistentText = this._fmtWorkerStatus();
    this.draw();
  }

  /** Stop the persistent bar and redraw the primary bar if still active. */
  stopPersistent(): void {
    this.clear();
    this.persistentActive = false;
    this._persistentText = "";
    this.draw();
  }

  /** Refresh the persistent status line text and redraw. */
  updatePersistent(): void {
    if (!this.persistentActive) return;
    this.clear();
    this._persistentText = this._fmtWorkerStatus();
    this.draw();
  }
}

/** Shared singleton. Call initStatusBar() at startup before first use. */
export let statusBar: StatusBar = undefined!;

/** Replace the shared singleton (called once at startup from index.ts). */
export function initStatusBar(sb: StatusBar): void { statusBar = sb; }
