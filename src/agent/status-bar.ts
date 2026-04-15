import { shortWorkerId } from "../../shared/utils.js";

// ── Verbose flag ───────────────────────────────────────────────────────────────
// Owned here so both the status bar and display.ts share one source of truth
// without a circular import.

export let verbose = false;
export function setVerbose(v: boolean) { verbose = v; }

// ── Worker status bar formatting ──────────────────────────────────────────────

const W = 70;

export interface WorkerStatusOpts {
  workerId: string;
  /** Model alias (e.g. "opus", "haiku"). Undefined or "default" renders as "sonnet". */
  model?: string;
  /** Effort level. Omitted from display when undefined (auto/default). */
  effort?: string;
  taskNumber?: number;
  prNumber?: number;
  branch?: string;
  connectionStatus: "connected" | "disconnected" | "reconnecting" | "handshaking";
  /** WebSocket close code, shown in verbose mode when disconnected. */
  disconnectCode?: number;
  /** Seconds until reconnect attempt, shown when disconnected. */
  retryInSeconds?: number;
  width?: number;
}

export function fmtWorkerStatus(opts: WorkerStatusOpts): string {
  const { workerId, model, effort, taskNumber, prNumber, branch, connectionStatus, disconnectCode, retryInSeconds } = opts;
  const width = (opts.width ?? (process.stdout.columns ?? W)) - 1; // -1 to avoid last-column wrap

  // Right side: connection status
  const codeStr = verbose && disconnectCode != null ? ` (${disconnectCode})` : "";
  const rightText =
    connectionStatus === "connected"    ? "Connected" :
    connectionStatus === "handshaking"  ? "Handshaking..." :
    connectionStatus === "reconnecting" ? "Reconnecting..." :
    retryInSeconds != null              ? `Disconnected${codeStr}. Retrying in ${retryInSeconds}s` :
                                          `Disconnected${codeStr}`;

  // Left side: worker {id8} ∙ {model} ∙ {task info}
  const modelName = (!model || model === "default") ? "sonnet" : model;
  const effortStr = effort ? ` (${effort})` : "";
  const parts: string[] = [`worker ${shortWorkerId(workerId)}`, `${modelName}${effortStr}`];
  if (taskNumber != null) parts.push(`task #${taskNumber}`);
  else parts.push("no current task");
  if (prNumber != null) parts.push(`PR #${prNumber}`);
  if (branch) parts.push(branch);
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

// ── StatusBar class ───────────────────────────────────────────────────────────

/**
 * Manages the terminal status bar display. Two bars coexist: a primary
 * animated bar (query progress, spins every 500ms) and a persistent bar
 * (worker status, redraws only on discrete events).
 *
 * Use the shared `statusBar` singleton for normal production use. Instantiate
 * directly in tests that need an isolated instance.
 */
export class StatusBar {
  // ── Primary (animated query-progress) bar ──────────────────────────────────
  /** Whether the primary animated status bar is currently active. */
  active = false;
  private _text = "";
  private _interval: ReturnType<typeof setInterval> | null = null;

  // ── Persistent (worker) bar ────────────────────────────────────────────────
  /** Whether the persistent worker status bar is currently active. */
  persistentActive = false;
  private _persistentText = "";
  private _persistentGetText: (() => string) | null = null;

  // ── Callbacks ──────────────────────────────────────────────────────────────

  // Fired after a tool result is printed (tool has just finished running).
  // Used by the worker to refresh git branch in the status bar after Bash.
  private _onToolResult: ((toolName: string) => void) | null = null;

  // Registered by ask() while it is active. print() routes through these so
  // output doesn't corrupt the interactive prompt/suggestion area.
  private _inputPrint: (() => void) | null = null;
  private _inputStatus: (() => void) | null = null;
  // Registered by ask(). Called by print() BEFORE writing output to clear the
  // prompt area including any leading blank line (see issue #418).
  private _inputClear: (() => void) | null = null;

  // ── Callback setters/getters ───────────────────────────────────────────────

  setOnToolResult(fn: ((toolName: string) => void) | null): void {
    this._onToolResult = fn;
  }

  /** Invoke the tool-result callback (if registered) with the tool name. */
  fireOnToolResult(name: string): void {
    this._onToolResult?.(name);
  }

  setInputPrint(fn: (() => void) | null): void { this._inputPrint = fn; }
  getInputPrint(): (() => void) | null { return this._inputPrint; }

  setInputStatus(fn: (() => void) | null): void { this._inputStatus = fn; }
  getInputStatus(): (() => void) | null { return this._inputStatus; }

  setInputClear(fn: (() => void) | null): void { this._inputClear = fn; }
  getInputClear(): (() => void) | null { return this._inputClear; }

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
    if (this._inputPrint || this._inputStatus) return; // ask() owns the screen
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
    if (this._inputStatus) {
      // ask() is active and cursor is in the buffer area — use the status-aware
      // redraw that navigates back to the prompt line before redrawing.
      this._inputStatus();
      return;
    }
    if (this._inputPrint) {
      // ask() is active after display.print() — cursor is at a fresh new line.
      this._inputPrint();
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
   * Show a status bar that redraws only when updatePersistent() is called.
   * Used for state that changes on discrete events (task assigned, PR opened,
   * connection status changed) rather than continuously over time.
   */
  startPersistent(getText: () => string): void {
    this.clear();
    this.persistentActive = true;
    this._persistentGetText = getText;
    this._persistentText = getText();
    this.draw();
  }

  /** Stop the persistent bar and redraw the primary bar if still active. */
  stopPersistent(): void {
    this.clear();
    this.persistentActive = false;
    this._persistentGetText = null;
    this._persistentText = "";
    this.draw();
  }

  /** Refresh the persistent status line text and redraw. */
  updatePersistent(): void {
    if (!this.persistentActive || !this._persistentGetText) return;
    this.clear();
    this._persistentText = this._persistentGetText();
    this.draw();
  }
}

/** Shared singleton — use this in production code. */
export const statusBar = new StatusBar();
