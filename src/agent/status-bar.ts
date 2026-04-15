import { shortWorkerId } from "../../shared/utils.js";

// ── Verbose flag ───────────────────────────────────────────────────────────────
// Owned here so both the status bar formatter and display.ts can share a single
// source of truth for verbose mode without a circular import.

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
  // Dim sage-green background + bright-white text. No trailing reset: drawStatusBars
  // appends \x1b[K (fills remaining width with the same background) then \x1b[0m.
  return `\x1b[48;5;22m\x1b[97m${leftText + " ".repeat(gap) + rightText}`;
}

// ── Status bar state ───────────────────────────────────────────────────────────

let _statusText = "";
export let _statusActive = false;
let _statusInterval: ReturnType<typeof setInterval> | null = null;

// Persistent (worker) status bar — drawn below the primary status line.
// Unlike the primary status this stays active between queries.
let _persistentStatusText = "";
export let _persistentStatusActive = false;
let _persistentGetText: (() => string) | null = null;

// ── Callbacks ─────────────────────────────────────────────────────────────────

// Callback invoked when a tool_result block is printed, i.e. immediately after
// a tool has finished running. Used by the worker to refresh the git branch in
// the status bar after each Bash invocation.
let _onToolResultCallback: ((toolName: string) => void) | null = null;

export function setOnToolResultCallback(fn: ((toolName: string) => void) | null): void {
  _onToolResultCallback = fn;
}

/** Fire the tool-result callback (if registered) with the given tool name. */
export function fireOnToolResult(name: string): void {
  _onToolResultCallback?.(name);
}

// Callback invoked after print() writes output, so the input layer can redraw
// the prompt (needed in worker mode when WebSocket messages arrive during ask()).
let _inputPrintCallback: (() => void) | null = null;
export function setInputPrintCallback(fn: (() => void) | null) {
  _inputPrintCallback = fn;
}
export function getInputPrintCallback(): (() => void) | null {
  return _inputPrintCallback;
}

// Callback invoked when the status bar changes while ask() is active.
// Unlike _inputPrintCallback (which assumes the cursor is at a fresh new line
// after display.print()), this callback is called while the cursor is at the
// current buffer position. ask() registers a handler that navigates back to
// the prompt line (using the known cursor row) and calls fullRedraw(), so the
// status bars are redrawn without misplacing them inside the buffer area.
let _inputStatusCallback: (() => void) | null = null;
export function setInputStatusCallback(fn: (() => void) | null) {
  _inputStatusCallback = fn;
}
export function getInputStatusCallback(): (() => void) | null {
  return _inputStatusCallback;
}

// Callback invoked by print() BEFORE console.log to clear the prompt area.
// When the prompt string has a leading \n (blank-line prefix), the clear must
// also erase that blank line; otherwise it is orphaned above the printed
// message as a "random" blank line (issue #418).
let _inputClearCallback: (() => void) | null = null;
export function setInputClearCallback(fn: (() => void) | null) {
  _inputClearCallback = fn;
}
export function getInputClearCallback(): (() => void) | null {
  return _inputClearCallback;
}

// ── Internal rendering helpers ─────────────────────────────────────────────────

/** Number of active status lines (primary + persistent). */
function _lineCount(): number {
  const n = (_statusActive ? 1 : 0) + (_persistentStatusActive ? 1 : 0);
  return n === 2 ? 3 : n; // blank separator between the two bars when both are active
}

/**
 * Clear all active status bar rows from the terminal. No-ops when ask() owns
 * the screen (it handles its own redraws via the input callbacks).
 */
export function clearStatusBars(): void {
  if (_inputPrintCallback || _inputStatusCallback) return; // ask() owns the screen; drawFresh handles redraws
  const n = _lineCount();
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
 * Draw all active status bar rows below the current cursor position. Routes
 * through input callbacks when ask() is active so the prompt area is updated
 * without misaligning the cursor.
 */
export function drawStatusBars(): void {
  if (_inputStatusCallback) {
    // ask() is active and cursor is in the buffer area — use the status-aware
    // redraw that navigates back to the prompt line before redrawing.
    _inputStatusCallback();
    return;
  }
  if (_inputPrintCallback) {
    // ask() is active after display.print() — cursor is at a fresh new line.
    _inputPrintCallback();
    return;
  }
  const n = _lineCount();
  if (n === 0) return;
  // Cursor is on the blank separator row. Draw each status line below it,
  // then return cursor to the blank separator row and hide it.
  let seq = "";
  if (_statusActive) seq += `\n\r${_statusText}\x1b[K\x1b[0m`;
  if (_statusActive && _persistentStatusActive) seq += `\n\r\x1b[K`; // blank line between bars
  if (_persistentStatusActive) seq += `\n\r${_persistentStatusText}\x1b[K\x1b[0m`;
  seq += `\x1b[${n}A\r`;
  seq += "\x1b[?25l";  // hide cursor (only reached when _inputPrintCallback is null)
  process.stdout.write(seq);
}

/**
 * Write the status bar rows starting from the current cursor position (no
 * leading blank separator — the cursor should already be at the row just above
 * the desired blank-separator position). Writes a blank separator row then
 * the active bar rows. Returns the total number of extra rows written
 * (0 if no bars are active), so the caller can account for them in cursor math.
 * Called by ask() to integrate the status bars into the prompt+suggestion area.
 */
export function drawStatusBarsRaw(): number {
  const n = _lineCount();
  if (n === 0) return 0;
  let seq = "\r\n\x1b[K"; // blank separator row
  if (_statusActive) seq += `\r\n${_statusText}\x1b[K\x1b[0m`;
  if (_statusActive && _persistentStatusActive) seq += `\r\n\x1b[K`;
  if (_persistentStatusActive) seq += `\r\n${_persistentStatusText}\x1b[K\x1b[0m`;
  process.stdout.write(seq);
  return 1 + n; // blank separator + n bar rows (n already includes blank-between when both active)
}

// ── Public status bar API ──────────────────────────────────────────────────────

/** Start the animated query-progress status bar, polling getText() every 500ms. */
export function startStatus(getText: () => string) {
  clearStatusBars();
  _statusActive = true;
  _statusText = getText();
  drawStatusBars();
  _statusInterval = setInterval(() => {
    clearStatusBars();
    _statusText = getText();
    drawStatusBars();
  }, 500);
}

/** Stop the animated status bar and redraw any persistent bar. */
export function stopStatus() {
  if (_statusInterval) { clearInterval(_statusInterval); _statusInterval = null; }
  clearStatusBars();
  _statusActive = false;
  _statusText = "";
  // Redraw the persistent line (if any) now that the primary line is gone.
  drawStatusBars();
}

/**
 * Show a status bar that only redraws when updatePersistentStatus() is called.
 * Used for state that changes on discrete events (e.g. task assigned, PR
 * opened, connection status changed) rather than continuously over time.
 * Contrast with startStatus(), which polls getText() every 500ms — appropriate
 * for the query status line where elapsed time advances even without events.
 */
export function startPersistentStatus(getText: () => string): void {
  clearStatusBars();
  _persistentStatusActive = true;
  _persistentGetText = getText;
  _persistentStatusText = getText();
  drawStatusBars();
}

/** Stop the persistent status bar and redraw the primary bar if still active. */
export function stopPersistentStatus(): void {
  clearStatusBars();
  _persistentStatusActive = false;
  _persistentGetText = null;
  _persistentStatusText = "";
  // Redraw primary status if still active.
  drawStatusBars();
}

/** Refresh the persistent status line text and redraw. */
export function updatePersistentStatus(): void {
  if (!_persistentStatusActive || !_persistentGetText) return;
  clearStatusBars();
  _persistentStatusText = _persistentGetText();
  drawStatusBars();
}
