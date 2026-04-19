import { c } from "./style.js";
import type { Display } from "./display.js";
import { type CommandSuggestion, filterCommands } from "../controllers/command-controller.js";

// ── Input class ───────────────────────────────────────────────────────────────

/**
 * View class for interactive terminal input. Receives a Display reference so
 * ask() can access the status bar without callers threading it through.
 */
export class Input {
  /** Buffer stashed by ^S, restored as the initial value of the next ask() call. */
  private _stash: string | null = null;

  // ── Per-call state (reset at the start of each ask() call) ─────────────────
  //
  // ask() is non-reentrant by design (cancel() ensures only one call is active
  // at a time), so instance fields for per-call state are safe.
  private _buffer = "";
  private _cursor = 0;
  private _done = false;
  private _selectedSuggestion = -1;
  private _pasteBuffer = "";
  private _inPaste = false;
  private _totalDrawnRows = 0;
  private _promptVisualLen = 0;
  private _promptLine = "";
  private _prefixRows = 0;
  private _commands: CommandSuggestion[] = [];
  /** Resolve function of the current ask() Promise; null when ask() is not active. */
  private _resolve: ((value: string | null) => void) | null = null;
  /** Bound data listener, stored so it can be removed in _cleanup(). */
  private _dataListener: ((chunk: string) => void) | null = null;

  constructor(private readonly display: Display) {}

  /**
   * Cancel the currently-running ask() call. The promise resolves with null
   * and the prompt area is cleared. No-op if ask() is not currently active.
   */
  cancel(): void {
    if (!this._resolve || this._done) return;
    this._done = true;
    // Navigate to the end of the buffer, then erase from the top of the
    // prefix block down to the end of the screen.  Unlike _submit(), we
    // do NOT write \r\n\x1b[J (which creates a separator line for
    // _clearStatus() to consume later).  A cancel is never followed by a
    // status-bar query, so that separator is never consumed and accumulates
    // as blank lines on each cycle (issue #418).
    const { row: curRow } = this._screenPosOf(this._cursor);
    const { row: endRow } = this._screenPosOf(this._buffer.length);
    const rowDiff = endRow - curRow;
    if (rowDiff > 0) process.stdout.write(`\x1b[${rowDiff}B`);
    else if (rowDiff < 0) process.stdout.write(`\x1b[${-rowDiff}A`);
    const totalUp = endRow + this._prefixRows;
    if (totalUp > 0) process.stdout.write(`\x1b[${totalUp}A`);
    process.stdout.write("\r\x1b[J");
    const resolve = this._resolve;
    this._cleanup();
    resolve(null);
  }

  // ── Raw input with bracketed paste support ──────────────────────────────────
  //
  // Bracketed paste mode: the terminal wraps pasted text in escape markers
  // (\x1b[200~ ... \x1b[201~), letting us collect it as a single input
  // rather than having each newline submit a separate prompt.

  ask(
    promptStr: string,
    getCommands: () => CommandSuggestion[] = () => [],
  ): Promise<string | null> {
    return new Promise((resolve) => {
      // Initialize per-call state
      this._buffer = this._stash ?? "";
      this._pasteBuffer = "";
      this._inPaste = false;
      this._done = false;
      // Visual length of prompt on the terminal line (excludes any leading \n)
      this._promptVisualLen = promptStr.slice(promptStr.lastIndexOf("\n") + 1).length;
      // Visual part of prompt string used when redrawing
      this._promptLine = promptStr.slice(promptStr.lastIndexOf("\n") + 1);
      // Number of blank rows written above the prompt (from leading \n chars in promptStr)
      this._prefixRows = promptStr.match(/^\n+/)?.[0]?.length ?? 0;
      this._commands = [];
      try { this._commands = getCommands(); } catch { /* graceful: use empty */ }
      this._cursor = this._buffer.length; // start cursor at end of any pre-populated stash
      this._totalDrawnRows = 0;
      this._selectedSuggestion = -1;
      this._stash = null; // consume the stash
      this._resolve = resolve;

      if (this._promptLine) process.stdout.write("\x1b[?25h"); // show cursor when there's a visible prompt
      process.stdout.write(promptStr);
      // Redraw the full prompt area (including status bars below) whenever there
      // is a visible prompt. This is required even when the buffer is empty: if
      // the status bar is active the cursor was sitting on the blank separator
      // row above it, so the leading \n in promptStr moves into the bar line and
      // `[agent] > ` overwrites its beginning.  _fullRedraw clears the bar line
      // and calls drawRaw() to position the bar below the fresh prompt.
      if (this._promptLine) this._fullRedraw(0, this._computeMatches());

      // Register the fresh-redraw hook so print() can notify us.
      if (this._promptLine) {
        this.display.statusBar.inputClear = () => this._clearForPrint();
        this.display.statusBar.inputPrint = () => this._drawFresh();
        this.display.statusBar.inputStatus = () => this._redrawFromCurrent();
      }

      this._dataListener = (chunk: string) => this._onData(chunk);
      process.stdin.on("data", this._dataListener);
    });
  }

  // ── Multiline-aware screen position ────────────────────────────────────────
  //
  // Compute the terminal (row, col) of buffer position `pos`, accounting
  // for both wrapping at terminal width and embedded \n characters (pasted
  // multiline content is displayed with a "... " continuation prefix).
  // Row 0 is the line that contains the visual start of the prompt.

  private _screenPosOf(pos: number): { row: number; col: number } {
    const cols = process.stdout.columns || 80;
    // Pasted newlines are rendered as \r\n    (CR + LF + 4-space indent)
    const disp = this._buffer.slice(0, pos).replace(/\n/g, "\r\n    ");
    let row = 0;
    let col = this._promptVisualLen;
    for (const ch of disp) {
      if (ch === "\r")      { col = 0; }
      else if (ch === "\n") { row++; col = 0; }
      else                  { if (col >= cols) { row++; col = 0; } col++; }
    }
    return { row, col };
  }

  // ── Suggestion rendering ────────────────────────────────────────────────────
  //
  // Each suggestion is rendered on its own line. Command names are padded so
  // descriptions start at the same column across all visible suggestions.

  private _renderSuggestions(suggestions: CommandSuggestion[], selIdx = -1): string[] {
    if (suggestions.length === 0) return [];
    const cols = process.stdout.columns || 80;
    const maxNameLen = Math.max(...suggestions.map(s => s.name.length));
    return suggestions.map((s, i) => {
      const isSelected = i === selIdx;
      const marker = isSelected ? "▶ /" : "  /";
      const prefix = marker + s.name.padEnd(maxNameLen + 2);
      const remaining = cols - prefix.length;
      let desc = s.description;
      if (remaining > 3 && desc) {
        if (desc.length > remaining) desc = desc.slice(0, remaining - 1) + "…";
      } else {
        desc = "";
      }
      return isSelected ? prefix + desc : c.darkGray(prefix + desc);
    });
  }

  // ── Full redraw ─────────────────────────────────────────────────────────────
  //
  // Redraws the entire input area (prompt + buffer + suggestion row) from
  // scratch.  prevRow is the screen row where the terminal cursor currently
  // sits (must be computed from the OLD buffer/cursor BEFORE any mutation).
  // After the redraw the terminal cursor is positioned at the current cursor.

  private _fullRedraw(prevRow: number, suggestions: CommandSuggestion[]) {
    const statusBar = this.display.statusBar;
    // 1. Move to start of prompt (row 0, col 0)
    if (prevRow > 0) process.stdout.write(`\x1b[${prevRow}A`);
    process.stdout.write("\r");

    // 2. Write prompt + buffer (pasted \n → visual continuation "... ")
    const displayStr = this._buffer.replace(/\n/g, "\r\n    ");
    process.stdout.write(this._promptLine + displayStr);

    const { row: endRow } = this._screenPosOf(this._buffer.length);

    // 3. Clear to end of last buffer line, then write suggestion rows.
    const sugLines = this._renderSuggestions(suggestions, this._selectedSuggestion);
    process.stdout.write("\x1b[K");
    if (sugLines.length > 0) {
      process.stdout.write("\r\n\x1b[K" + sugLines[0]);
      for (let i = 1; i < sugLines.length; i++) {
        process.stdout.write("\r\n\x1b[K" + sugLines[i]);
      }
    }

    const sugLastRow = endRow + sugLines.length;

    // 4. Clear any extra rows left over from a previously longer buffer or
    //    more suggestions
    for (let r = sugLastRow; r < this._totalDrawnRows; r++) {
      process.stdout.write("\r\n\x1b[K");
    }
    if (this._totalDrawnRows > sugLastRow) {
      process.stdout.write(`\x1b[${this._totalDrawnRows - sugLastRow}A`);
    }
    this._totalDrawnRows = sugLastRow;

    // 5. Draw status bars below suggestion rows (if any are active).
    //    Returns 0 when no bars are active, or 1+n for blank-separator + n bar rows.
    this._totalDrawnRows += statusBar.drawRaw();

    // 6. Go from last drawn row back to prompt row 0.
    // Guard: \x1b[0A is treated as \x1b[1A in most terminals, so skip it when already at row 0.
    if (this._totalDrawnRows > 0) process.stdout.write(`\x1b[${this._totalDrawnRows}A`);
    process.stdout.write("\r");

    // 6. Navigate to current cursor position
    const { row: targetRow, col: targetCol } = this._screenPosOf(this._cursor);
    if (targetRow > 0) process.stdout.write(`\x1b[${targetRow}B`);
    if (targetCol > 0) process.stdout.write(`\x1b[${targetCol}C`);
  }

  // ── Fresh redraw after external output ─────────────────────────────────────
  //
  // Called when print() writes output while ask() is running (e.g.
  // a WebSocket message arriving in worker mode).  The terminal cursor is
  // now at an unknown position below the old prompt, so we start a fresh
  // prompt on a new line rather than trying to navigate back.

  private _drawFresh() {
    if (this._done) return;
    const statusBar = this.display.statusBar;
    this._totalDrawnRows = 0; // reset: we're drawing from a new position
    const displayStr = this._buffer.replace(/\n/g, "\r\n    ");
    // print() already moved the cursor to a new line via console.log's
    // trailing \n; \r ensures we're at column 0 without adding an extra blank line.
    process.stdout.write("\r" + this._promptLine + displayStr);

    const { row: endRow } = this._screenPosOf(this._buffer.length);

    const matches = this._computeMatches();
    const sugLines = this._renderSuggestions(matches);
    process.stdout.write("\x1b[K");
    if (sugLines.length > 0) {
      process.stdout.write("\r\n\x1b[K" + sugLines[0]);
      for (let i = 1; i < sugLines.length; i++) {
        process.stdout.write("\r\n\x1b[K" + sugLines[i]);
      }
    }

    const sugLastRow = endRow + sugLines.length;
    this._totalDrawnRows = sugLastRow;

    // Draw status bars below suggestion rows (if any are active).
    this._totalDrawnRows += statusBar.drawRaw();

    // Guard: \x1b[0A is treated as \x1b[1A in most terminals, so skip it when already at row 0.
    if (this._totalDrawnRows > 0) process.stdout.write(`\x1b[${this._totalDrawnRows}A`);
    process.stdout.write("\r");

    const { row: targetRow, col: targetCol } = this._screenPosOf(this._cursor);
    if (targetRow > 0) process.stdout.write(`\x1b[${targetRow}B`);
    if (targetCol > 0) process.stdout.write(`\x1b[${targetCol}C`);
    process.stdout.write("\x1b[?25h"); // ensure cursor is visible at the prompt
  }

  // ── Pre-clear callback ──────────────────────────────────────────────────────
  //
  // Called by print() BEFORE console.log to clear the prompt area.
  // When the prompt has a leading \n (blank line prefix), we must also clear
  // that blank line — otherwise it is orphaned above the printed message.

  private _clearForPrint() {
    if (this._prefixRows > 0) {
      // Go up to the first prefix row and erase from there to end of screen.
      // This clears the blank prefix, the prompt line, suggestion rows, and
      // status bars in one shot.  Cursor ends up at the blank-prefix row so
      // console.log prints the message where the blank was (no orphaned line).
      process.stdout.write(`\x1b[${this._prefixRows}A\r\x1b[J`);
    } else {
      // No prefix — clear from prompt line to end of screen (same as the
      // default \r\x1b[J that print() uses when no clear callback is set).
      process.stdout.write("\r\x1b[J");
    }
  }

  // Called when the status bar changes while ask() is waiting for input.
  // Unlike _drawFresh (which assumes cursor is at a fresh new line after
  // print()), this is called while the cursor is at the current
  // buffer position.  Navigate back to the prompt line using the known
  // cursor row, then call _fullRedraw so status bars land in the right place.
  private _redrawFromCurrent() {
    if (this._done) return;
    const curRow = this._screenPosOf(this._cursor).row;
    this._fullRedraw(curRow, this._computeMatches());
  }

  private _cleanup() {
    const statusBar = this.display.statusBar;
    statusBar.inputPrint = null;
    statusBar.inputClear = null;
    statusBar.inputStatus = null;
    this._resolve = null;
    if (this._dataListener) {
      process.stdin.removeListener("data", this._dataListener);
      this._dataListener = null;
    }
  }

  private _submit(value: string) {
    if (this._done) return;
    this._done = true;
    // Navigate to end of buffer then clear the suggestion area. Stop there —
    // no trailing \r\n. The first cleared row becomes the separator line
    // that _clearStatus() erases before the first print(), so query output
    // starts exactly one blank line below the input (not two).
    // \x1b[J erases from the cursor to the end of the screen, clearing all
    // suggestion rows regardless of how many there are.
    const { row: curRow } = this._screenPosOf(this._cursor);
    const { row: endRow } = this._screenPosOf(this._buffer.length);
    const rowDiff = endRow - curRow;
    if (rowDiff > 0) process.stdout.write(`\x1b[${rowDiff}B`);
    else if (rowDiff < 0) process.stdout.write(`\x1b[${-rowDiff}A`);
    process.stdout.write("\r\n\x1b[J");
    const resolve = this._resolve!;
    this._cleanup();
    resolve(value.trim());
  }

  private _exit() {
    // Resolve with the EOF sentinel so callers can run workspace cleanup
    // before process.exit().  _submit() handles terminal cursor/clear output,
    // removes the stdin listener, and resolves the promise.
    this._submit("__eof__");
  }

  // ── Autocomplete ──────────────────────────────────────────────────────────

  private _computeMatches(): CommandSuggestion[] {
    if (!this._buffer.startsWith("/")) return [];
    if (this._buffer.slice(1).includes(" ")) return [];
    const query = this._buffer.slice(1).split(/\s+/)[0];
    // query is "" when buffer is exactly "/" — filterCommands("", ...) returns all
    return filterCommands(query, this._commands).slice(0, 5);
  }

  // ── Editing operations (all use _fullRedraw) ────────────────────────────────

  private _replaceBuffer(newText: string) {
    const prevRow = this._screenPosOf(this._cursor).row;
    this._buffer = newText;
    this._cursor = newText.length;
    this._selectedSuggestion = -1;
    this._fullRedraw(prevRow, this._computeMatches());
  }

  private _insert(ch: string) {
    const prevRow = this._screenPosOf(this._cursor).row;
    this._buffer = this._buffer.slice(0, this._cursor) + ch + this._buffer.slice(this._cursor);
    this._cursor++;
    this._selectedSuggestion = -1;
    this._fullRedraw(prevRow, this._computeMatches());
  }

  private _deleteBack() {
    if (this._cursor === 0) return;
    const prevRow = this._screenPosOf(this._cursor).row;
    this._buffer = this._buffer.slice(0, this._cursor - 1) + this._buffer.slice(this._cursor);
    this._cursor--;
    this._selectedSuggestion = -1;
    this._fullRedraw(prevRow, this._computeMatches());
  }

  private _deleteForward() {
    if (this._cursor === this._buffer.length) return;
    const prevRow = this._screenPosOf(this._cursor).row;
    this._buffer = this._buffer.slice(0, this._cursor) + this._buffer.slice(this._cursor + 1);
    this._selectedSuggestion = -1;
    this._fullRedraw(prevRow, this._computeMatches());
  }

  private _moveTo(pos: number) {
    pos = Math.max(0, Math.min(this._buffer.length, pos));
    if (pos === this._cursor) return;
    const prevRow = this._screenPosOf(this._cursor).row;
    this._cursor = pos;
    this._fullRedraw(prevRow, this._computeMatches());
  }

  private _killToEnd() {
    const prevRow = this._screenPosOf(this._cursor).row;
    this._buffer = this._buffer.slice(0, this._cursor);
    this._fullRedraw(prevRow, this._computeMatches());
  }

  private _killToStart() {
    const prevRow = this._screenPosOf(this._cursor).row;
    this._buffer = this._buffer.slice(this._cursor);
    this._cursor = 0;
    this._fullRedraw(prevRow, this._computeMatches());
  }

  private _deleteWord() {
    if (this._cursor === 0) return;
    const prevRow = this._screenPosOf(this._cursor).row;
    let pos = this._cursor;
    while (pos > 0 && this._buffer[pos - 1] === " ") pos--;
    while (pos > 0 && this._buffer[pos - 1] !== " ") pos--;
    this._buffer = this._buffer.slice(0, pos) + this._buffer.slice(this._cursor);
    this._cursor = pos;
    this._fullRedraw(prevRow, this._computeMatches());
  }

  private _moveWordLeft() {
    let pos = this._cursor;
    while (pos > 0 && this._buffer[pos - 1] === " ") pos--;
    while (pos > 0 && this._buffer[pos - 1] !== " ") pos--;
    this._moveTo(pos);
  }

  private _moveWordRight() {
    let pos = this._cursor;
    while (pos < this._buffer.length && this._buffer[pos] === " ") pos++;
    while (pos < this._buffer.length && this._buffer[pos] !== " ") pos++;
    this._moveTo(pos);
  }

  // Find the buffer position at (targetRow, targetCol), clamping to the
  // nearest reachable position on that row.  Returns -1 if targetRow doesn't
  // exist in the current buffer.
  private _bufPosAtRow(targetRow: number, targetCol: number): number {
    let bestPos = -1;
    let bestColDiff = Infinity;
    for (let pos = 0; pos <= this._buffer.length; pos++) {
      const { row, col } = this._screenPosOf(pos);
      if (row === targetRow) {
        const diff = Math.abs(col - targetCol);
        if (diff < bestColDiff) { bestColDiff = diff; bestPos = pos; }
      } else if (row > targetRow && bestPos !== -1) {
        break; // past target row
      }
    }
    return bestPos;
  }

  private _moveLineUp() {
    const { row, col } = this._screenPosOf(this._cursor);
    if (row === 0) return; // already on top row
    const pos = this._bufPosAtRow(row - 1, col);
    if (pos !== -1) this._moveTo(pos);
  }

  private _moveLineDown() {
    const { row, col } = this._screenPosOf(this._cursor);
    const pos = this._bufPosAtRow(row + 1, col);
    if (pos !== -1) this._moveTo(pos);
    // if row+1 doesn't exist, no-op
  }

  private _stashBuffer() {
    if (!this._buffer) return;
    this._stash = this._buffer;
    // Navigate from current cursor row to the top of the prompt area (row 0),
    // then erase to end of screen, print the stash notification, and redraw
    // an empty prompt so the user can type their next input.
    const { row: curRow } = this._screenPosOf(this._cursor);
    if (curRow > 0) process.stdout.write(`\x1b[${curRow}A`);
    process.stdout.write("\r\x1b[J");
    process.stdout.write(c.darkGray("✦ Prompt stashed — will be restored on next submit\r\n"));
    this._buffer = "";
    this._cursor = 0;
    this._totalDrawnRows = 0;
    process.stdout.write(this._promptLine);
    process.stdout.write("\x1b[K\r\n\x1b[K");
    this._totalDrawnRows = 1;
    process.stdout.write(`\x1b[1A\r`);
    if (this._promptLine.length > 0) process.stdout.write(`\x1b[${this._promptLine.length}C`);
  }

  private _processTyped(data: string) {
    // Substitute known sequences with placeholder chars before stripping
    data = data.replace(/\x1b\[1;3D/g, "\x1c"); // iTerm2 option+left  → 0x1C
    data = data.replace(/\x1b\[1;3C/g, "\x1d"); // iTerm2 option+right → 0x1D
    data = data.replace(/\x1b\[A/g,    "\x10"); // up arrow             → 0x10
    data = data.replace(/\x1b\[B/g,    "\x11"); // down arrow           → 0x11
    data = data.replace(/\x1b\[D/g,    "\x1e"); // left arrow           → 0x1E
    data = data.replace(/\x1b\[C/g,    "\x1f"); // right arrow          → 0x1F
    data = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""); // strip remaining CSI
    data = data.replace(/\x1bb/g,      "\x1c"); // Terminal.app option+left
    data = data.replace(/\x1bf/g,      "\x1d"); // Terminal.app option+right
    data = data.replace(/\x1b./gs, "");          // strip remaining escapes

    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (ch === "\r" || ch === "\n") {
        const matches = this._computeMatches();
        if (this._selectedSuggestion >= 0 && this._selectedSuggestion < matches.length) {
          this._replaceBuffer("/" + matches[this._selectedSuggestion].name);
        } else if (matches.length > 0) {
          this._replaceBuffer("/" + matches[0].name);
        }
        this._submit(this._buffer);
        return;
      }
      else if (ch === "\x7f" || ch === "\x08")      { this._deleteBack(); }
      else if (ch === "\x03") { if (this._buffer) { this._replaceBuffer(""); } else { process.stdout.write("^C"); this._exit(); } }
      else if (ch === "\x04") { if (!this._buffer) this._exit(); else this._deleteForward(); }
      else if (ch === "\x01")                       { this._moveTo(0); }                      // ^A
      else if (ch === "\x05")                       { this._moveTo(this._buffer.length); }    // ^E
      else if (ch === "\x0b")                       { this._killToEnd(); }                    // ^K
      else if (ch === "\x15")                       { this._killToStart(); }                  // ^U
      else if (ch === "\x17")                       { this._deleteWord(); }                   // ^W
      else if (ch === "\x10") {                                                                // ↑
        const matches = this._computeMatches();
        if (this._selectedSuggestion > 0) {
          this._selectedSuggestion--;
          this._fullRedraw(this._screenPosOf(this._cursor).row, matches);
        } else if (this._selectedSuggestion === 0) {
          this._selectedSuggestion = -1;
          this._fullRedraw(this._screenPosOf(this._cursor).row, matches);
        } else {
          this._moveLineUp();
        }
      }
      else if (ch === "\x11") {                                                                // ↓
        const matches = this._computeMatches();
        if (matches.length > 0 && this._selectedSuggestion < matches.length - 1) {
          this._selectedSuggestion++;
          this._fullRedraw(this._screenPosOf(this._cursor).row, matches);
        } else if (matches.length === 0) {
          this._moveLineDown();
        }
      }
      else if (ch === "\x13")                       { this._stashBuffer(); }                  // ^S
      else if (ch === "\x1c")                       { this._moveWordLeft(); }                 // option+←
      else if (ch === "\x1d")                       { this._moveWordRight(); }                // option+→
      else if (ch === "\x1e")                       { this._moveTo(this._cursor - 1); }       // ←
      else if (ch === "\x1f")                       { this._moveTo(this._cursor + 1); }       // →
      else if (ch === "\x09") {                                                                // Tab
        const matches = this._computeMatches();
        if (this._selectedSuggestion >= 0 && this._selectedSuggestion < matches.length) {
          this._replaceBuffer("/" + matches[this._selectedSuggestion].name + " ");
        } else if (matches.length > 0) {
          this._replaceBuffer("/" + matches[0].name + " ");
        }
      }
      else if (code >= 32)                          { this._insert(ch); }
    }
  }

  private _normalizePaste(str: string) {
    return str.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  private _insertPaste(str: string) {
    const prevRow = this._screenPosOf(this._cursor).row;
    this._buffer = this._buffer.slice(0, this._cursor) + str + this._buffer.slice(this._cursor);
    this._cursor += str.length;
    this._fullRedraw(prevRow, this._computeMatches());
  }

  private _onData(chunk: string) {
    if (this._inPaste) {
      const end = chunk.indexOf("\x1b[201~");
      if (end !== -1) {
        this._pasteBuffer += chunk.slice(0, end);
        this._inPaste = false;
        const normalized = this._normalizePaste(this._pasteBuffer);
        this._pasteBuffer = "";
        this._insertPaste(normalized);
      } else {
        this._pasteBuffer += chunk;
      }
      return;
    }

    const start = chunk.indexOf("\x1b[200~");
    if (start !== -1) {
      this._processTyped(chunk.slice(0, start));
      const rest = chunk.slice(start + 6);
      const end = rest.indexOf("\x1b[201~");
      if (end !== -1) {
        this._insertPaste(this._normalizePaste(rest.slice(0, end)));
      } else {
        this._pasteBuffer = rest;
        this._inPaste = true;
      }
      return;
    }

    this._processTyped(chunk);
  }

}
