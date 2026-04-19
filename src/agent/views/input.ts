import { c } from "./style.js";
import type { Display } from "./display.js";
import { type CommandSuggestion, filterCommands } from "../controllers/command-controller.js";

// ── Stash ─────────────────────────────────────────────────────────────────────

/** Buffer stashed by ^S, restored as the initial value of the next ask() call. */
let stash: string | null = null;

/** Reset the stash (exposed for testing). */
export function _resetStash(): void { stash = null; }

// ── Input class ───────────────────────────────────────────────────────────────

/**
 * View class for interactive terminal input. Receives a Display reference so
 * ask() can access the status bar without callers threading it through.
 */
export class Input {
  constructor(private readonly display: Display) {}

  // ── Raw input with bracketed paste support ──────────────────────────────────
  //
  // Bracketed paste mode: the terminal wraps pasted text in escape markers
  // (\x1b[200~ ... \x1b[201~), letting us collect it as a single input
  // rather than having each newline submit a separate prompt.

  ask<TAbort = never>(
    promptStr: string,
    getCommands: () => CommandSuggestion[] = () => [],
    abort?: Promise<TAbort>,
  ): Promise<string | TAbort> {
    const statusBar = this.display.statusBar;
    return new Promise((resolve) => {
      let buffer = stash ?? "";
      let pasteBuffer = "";
      let inPaste = false;
      let done = false;
      // Visual length of prompt on the terminal line (excludes any leading \n)
      const promptVisualLen = promptStr.slice(promptStr.lastIndexOf("\n") + 1).length;
      // Visual part of prompt string used when redrawing
      const promptLine = promptStr.slice(promptStr.lastIndexOf("\n") + 1);
      // Number of blank rows written above the prompt (from leading \n chars in promptStr)
      const prefixRows = promptStr.match(/^\n+/)?.[0]?.length ?? 0;
      let commands: CommandSuggestion[] = [];
      try { commands = getCommands(); } catch { /* graceful: use empty */ }

      let cursor = buffer.length; // start cursor at end of any pre-populated stash
      // Number of rows used by the last full redraw (suggestion row is always included)
      let totalDrawnRows = 0;
      // Arrow-key selection index into the autocomplete suggestions (-1 = none selected)
      let selectedSuggestion = -1;
      stash = null; // consume the stash

      if (promptLine) process.stdout.write("\x1b[?25h"); // show cursor when there's a visible prompt
      process.stdout.write(promptStr);
      // If buffer was pre-populated from stash, render it immediately.
      if (buffer) fullRedraw(0, computeMatches());

      // ── Multiline-aware screen position ────────────────────────────────────
      //
      // Compute the terminal (row, col) of buffer position `pos`, accounting
      // for both wrapping at terminal width and embedded \n characters (pasted
      // multiline content is displayed with a "... " continuation prefix).
      // Row 0 is the line that contains the visual start of the prompt.

      function screenPosOf(pos: number): { row: number; col: number } {
        const cols = process.stdout.columns || 80;
        // Pasted newlines are rendered as \r\n    (CR + LF + 4-space indent)
        const disp = buffer.slice(0, pos).replace(/\n/g, "\r\n    ");
        let row = 0;
        let col = promptVisualLen;
        for (const ch of disp) {
          if (ch === "\r")      { col = 0; }
          else if (ch === "\n") { row++; col = 0; }
          else                  { if (col >= cols) { row++; col = 0; } col++; }
        }
        return { row, col };
      }

      // ── Full redraw ─────────────────────────────────────────────────────────
      //
      // Redraws the entire input area (prompt + buffer + suggestion row) from
      // scratch.  prevRow is the screen row where the terminal cursor currently
      // sits (must be computed from the OLD buffer/cursor BEFORE any mutation).
      // After the redraw the terminal cursor is positioned at the current `cursor`.

      // ── Suggestion rendering ────────────────────────────────────────────────
      //
      // Each suggestion is rendered on its own line. Command names are padded so
      // descriptions start at the same column across all visible suggestions.

      function renderSuggestions(suggestions: CommandSuggestion[], selIdx = -1): string[] {
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

      function fullRedraw(prevRow: number, suggestions: CommandSuggestion[]) {
        // 1. Move to start of prompt (row 0, col 0)
        if (prevRow > 0) process.stdout.write(`\x1b[${prevRow}A`);
        process.stdout.write("\r");

        // 2. Write prompt + buffer (pasted \n → visual continuation "... ")
        const displayStr = buffer.replace(/\n/g, "\r\n    ");
        process.stdout.write(promptLine + displayStr);

        const { row: endRow } = screenPosOf(buffer.length);

        // 3. Clear to end of last buffer line, then write suggestion rows.
        const sugLines = renderSuggestions(suggestions, selectedSuggestion);
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
        for (let r = sugLastRow; r < totalDrawnRows; r++) {
          process.stdout.write("\r\n\x1b[K");
        }
        if (totalDrawnRows > sugLastRow) {
          process.stdout.write(`\x1b[${totalDrawnRows - sugLastRow}A`);
        }
        totalDrawnRows = sugLastRow;

        // 5. Draw status bars below suggestion rows (if any are active).
        //    Returns 0 when no bars are active, or 1+n for blank-separator + n bar rows.
        totalDrawnRows += statusBar.drawRaw();

        // 6. Go from last drawn row back to prompt row 0.
        // Guard: \x1b[0A is treated as \x1b[1A in most terminals, so skip it when already at row 0.
        if (totalDrawnRows > 0) process.stdout.write(`\x1b[${totalDrawnRows}A`);
        process.stdout.write("\r");

        // 6. Navigate to current cursor position
        const { row: targetRow, col: targetCol } = screenPosOf(cursor);
        if (targetRow > 0) process.stdout.write(`\x1b[${targetRow}B`);
        if (targetCol > 0) process.stdout.write(`\x1b[${targetCol}C`);
      }

      // ── Fresh redraw after external output ─────────────────────────────────
      //
      // Called when print() writes output while ask() is running (e.g.
      // a WebSocket message arriving in worker mode).  The terminal cursor is
      // now at an unknown position below the old prompt, so we start a fresh
      // prompt on a new line rather than trying to navigate back.

      function drawFresh() {
        if (done) return;
        totalDrawnRows = 0; // reset: we're drawing from a new position
        const displayStr = buffer.replace(/\n/g, "\r\n    ");
        // print() already moved the cursor to a new line via console.log's
        // trailing \n; \r ensures we're at column 0 without adding an extra blank line.
        process.stdout.write("\r" + promptLine + displayStr);

        const { row: endRow } = screenPosOf(buffer.length);

        const matches = computeMatches();
        const sugLines = renderSuggestions(matches);
        process.stdout.write("\x1b[K");
        if (sugLines.length > 0) {
          process.stdout.write("\r\n\x1b[K" + sugLines[0]);
          for (let i = 1; i < sugLines.length; i++) {
            process.stdout.write("\r\n\x1b[K" + sugLines[i]);
          }
        }

        const sugLastRow = endRow + sugLines.length;
        totalDrawnRows = sugLastRow;

        // Draw status bars below suggestion rows (if any are active).
        totalDrawnRows += statusBar.drawRaw();

        // Guard: \x1b[0A is treated as \x1b[1A in most terminals, so skip it when already at row 0.
        if (totalDrawnRows > 0) process.stdout.write(`\x1b[${totalDrawnRows}A`);
        process.stdout.write("\r");

        const { row: targetRow, col: targetCol } = screenPosOf(cursor);
        if (targetRow > 0) process.stdout.write(`\x1b[${targetRow}B`);
        if (targetCol > 0) process.stdout.write(`\x1b[${targetCol}C`);
        process.stdout.write("\x1b[?25h"); // ensure cursor is visible at the prompt
      }

      // ── Pre-clear callback ──────────────────────────────────────────────────
      //
      // Called by print() BEFORE console.log to clear the prompt area.
      // When the prompt has a leading \n (blank line prefix), we must also clear
      // that blank line — otherwise it is orphaned above the printed message.

      function clearForPrint() {
        if (prefixRows > 0) {
          // Go up to the first prefix row and erase from there to end of screen.
          // This clears the blank prefix, the prompt line, suggestion rows, and
          // status bars in one shot.  Cursor ends up at the blank-prefix row so
          // console.log prints the message where the blank was (no orphaned line).
          process.stdout.write(`\x1b[${prefixRows}A\r\x1b[J`);
        } else {
          // No prefix — clear from prompt line to end of screen (same as the
          // default \r\x1b[J that print() uses when no clear callback is set).
          process.stdout.write("\r\x1b[J");
        }
      }

      // Called when the status bar changes while ask() is waiting for input.
      // Unlike drawFresh (which assumes cursor is at a fresh new line after
      // print()), this is called while the cursor is at the current
      // buffer position.  Navigate back to the prompt line using the known
      // cursor row, then call fullRedraw so status bars land in the right place.
      function redrawFromCurrent() {
        if (done) return;
        const curRow = screenPosOf(cursor).row;
        fullRedraw(curRow, computeMatches());
      }

      // Register the fresh-redraw hook so print() can notify us.
      // Only register when there is a visible prompt to redraw — an empty prompt
      // string means the caller doesn't want any prompt shown (e.g. worker
      // standby mode), so no redraw is needed and no line-clear should fire.
      if (promptLine) {
        statusBar.inputClear = clearForPrint;
        statusBar.inputPrint = drawFresh;
        statusBar.inputStatus = redrawFromCurrent;
      }

      if (abort) {
        void abort.then((value) => {
          if (!done) {
            // Navigate to the end of the buffer, then erase from the top of the
            // prefix block down to the end of the screen.  Unlike submit(), we
            // do NOT write \r\n\x1b[J (which creates a separator line for
            // _clearStatus() to consume later).  A WS-triggered abort is never
            // followed by a status-bar query, so that separator is never
            // consumed and accumulates as blank lines on each cycle (issue #418).
            const { row: curRow } = screenPosOf(cursor);
            const { row: endRow } = screenPosOf(buffer.length);
            const rowDiff = endRow - curRow;
            if (rowDiff > 0) process.stdout.write(`\x1b[${rowDiff}B`);
            else if (rowDiff < 0) process.stdout.write(`\x1b[${-rowDiff}A`);
            const totalUp = endRow + prefixRows;
            if (totalUp > 0) process.stdout.write(`\x1b[${totalUp}A`);
            process.stdout.write("\r\x1b[J");
            cleanup();
            done = true;
            resolve(value as string | TAbort);
          }
        });
      }

      function cleanup() {
        statusBar.inputPrint = null;
        statusBar.inputClear = null;
        statusBar.inputStatus = null;
        process.stdin.removeListener("data", onData);
      }

      function submit(value: string) {
        if (done) return;
        done = true;
        // Navigate to end of buffer then clear the suggestion area. Stop there —
        // no trailing \r\n. The first cleared row becomes the separator line
        // that _clearStatus() erases before the first print(), so query output
        // starts exactly one blank line below the input (not two).
        // \x1b[J erases from the cursor to the end of the screen, clearing all
        // suggestion rows regardless of how many there are.
        const { row: curRow } = screenPosOf(cursor);
        const { row: endRow } = screenPosOf(buffer.length);
        const rowDiff = endRow - curRow;
        if (rowDiff > 0) process.stdout.write(`\x1b[${rowDiff}B`);
        else if (rowDiff < 0) process.stdout.write(`\x1b[${-rowDiff}A`);
        process.stdout.write("\r\n\x1b[J");
        cleanup();
        resolve(value.trim());
      }

      function exit() {
        // Resolve with the EOF sentinel so callers can run workspace cleanup
        // before process.exit().  submit() handles terminal cursor/clear output,
        // removes the stdin listener, and resolves the promise.
        submit("__eof__");
      }

      // ── Autocomplete ──────────────────────────────────────────────────────

      function computeMatches(): CommandSuggestion[] {
        if (!buffer.startsWith("/")) return [];
        if (buffer.slice(1).includes(" ")) return [];
        const query = buffer.slice(1).split(/\s+/)[0];
        // query is "" when buffer is exactly "/" — filterCommands("", ...) returns all
        return filterCommands(query, commands).slice(0, 5);
      }

      // ── Editing operations (all use fullRedraw) ────────────────────────────

      function replaceBuffer(newText: string) {
        const prevRow = screenPosOf(cursor).row;
        buffer = newText;
        cursor = newText.length;
        selectedSuggestion = -1;
        fullRedraw(prevRow, computeMatches());
      }

      function insert(ch: string) {
        const prevRow = screenPosOf(cursor).row;
        buffer = buffer.slice(0, cursor) + ch + buffer.slice(cursor);
        cursor++;
        selectedSuggestion = -1;
        fullRedraw(prevRow, computeMatches());
      }

      function deleteBack() {
        if (cursor === 0) return;
        const prevRow = screenPosOf(cursor).row;
        buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
        cursor--;
        selectedSuggestion = -1;
        fullRedraw(prevRow, computeMatches());
      }

      function deleteForward() {
        if (cursor === buffer.length) return;
        const prevRow = screenPosOf(cursor).row;
        buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
        selectedSuggestion = -1;
        fullRedraw(prevRow, computeMatches());
      }

      function moveTo(pos: number) {
        pos = Math.max(0, Math.min(buffer.length, pos));
        if (pos === cursor) return;
        const prevRow = screenPosOf(cursor).row;
        cursor = pos;
        fullRedraw(prevRow, computeMatches());
      }

      function killToEnd() {
        const prevRow = screenPosOf(cursor).row;
        buffer = buffer.slice(0, cursor);
        fullRedraw(prevRow, computeMatches());
      }

      function killToStart() {
        const prevRow = screenPosOf(cursor).row;
        buffer = buffer.slice(cursor);
        cursor = 0;
        fullRedraw(prevRow, computeMatches());
      }

      function deleteWord() {
        if (cursor === 0) return;
        const prevRow = screenPosOf(cursor).row;
        let pos = cursor;
        while (pos > 0 && buffer[pos - 1] === " ") pos--;
        while (pos > 0 && buffer[pos - 1] !== " ") pos--;
        buffer = buffer.slice(0, pos) + buffer.slice(cursor);
        cursor = pos;
        fullRedraw(prevRow, computeMatches());
      }

      function moveWordLeft() {
        let pos = cursor;
        while (pos > 0 && buffer[pos - 1] === " ") pos--;
        while (pos > 0 && buffer[pos - 1] !== " ") pos--;
        moveTo(pos);
      }

      function moveWordRight() {
        let pos = cursor;
        while (pos < buffer.length && buffer[pos] === " ") pos++;
        while (pos < buffer.length && buffer[pos] !== " ") pos++;
        moveTo(pos);
      }

      // Find the buffer position at (targetRow, targetCol), clamping to the
      // nearest reachable position on that row.  Returns -1 if targetRow doesn't
      // exist in the current buffer.
      function bufPosAtRow(targetRow: number, targetCol: number): number {
        let bestPos = -1;
        let bestColDiff = Infinity;
        for (let pos = 0; pos <= buffer.length; pos++) {
          const { row, col } = screenPosOf(pos);
          if (row === targetRow) {
            const diff = Math.abs(col - targetCol);
            if (diff < bestColDiff) { bestColDiff = diff; bestPos = pos; }
          } else if (row > targetRow && bestPos !== -1) {
            break; // past target row
          }
        }
        return bestPos;
      }

      function moveLineUp() {
        const { row, col } = screenPosOf(cursor);
        if (row === 0) return; // already on top row
        const pos = bufPosAtRow(row - 1, col);
        if (pos !== -1) moveTo(pos);
      }

      function moveLineDown() {
        const { row, col } = screenPosOf(cursor);
        const pos = bufPosAtRow(row + 1, col);
        if (pos !== -1) moveTo(pos);
        // if row+1 doesn't exist, no-op
      }

      function stashBuffer() {
        if (!buffer) return;
        stash = buffer;
        // Navigate from current cursor row to the top of the prompt area (row 0),
        // then erase to end of screen, print the stash notification, and redraw
        // an empty prompt so the user can type their next input.
        const { row: curRow } = screenPosOf(cursor);
        if (curRow > 0) process.stdout.write(`\x1b[${curRow}A`);
        process.stdout.write("\r\x1b[J");
        process.stdout.write(c.darkGray("✦ Prompt stashed — will be restored on next submit\r\n"));
        buffer = "";
        cursor = 0;
        totalDrawnRows = 0;
        process.stdout.write(promptLine);
        process.stdout.write("\x1b[K\r\n\x1b[K");
        totalDrawnRows = 1;
        process.stdout.write(`\x1b[1A\r`);
        if (promptLine.length > 0) process.stdout.write(`\x1b[${promptLine.length}C`);
      }

      function processTyped(data: string) {
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
            const matches = computeMatches();
            if (selectedSuggestion >= 0 && selectedSuggestion < matches.length) {
              replaceBuffer("/" + matches[selectedSuggestion].name);
            } else if (matches.length > 0) {
              replaceBuffer("/" + matches[0].name);
            }
            submit(buffer);
            return;
          }
          else if (ch === "\x7f" || ch === "\x08")      { deleteBack(); }
          else if (ch === "\x03") { if (buffer) { replaceBuffer(""); } else { process.stdout.write("^C"); exit(); } }
          else if (ch === "\x04") { if (!buffer) exit(); else deleteForward(); }
          else if (ch === "\x01")                       { moveTo(0); }             // ^A
          else if (ch === "\x05")                       { moveTo(buffer.length); } // ^E
          else if (ch === "\x0b")                       { killToEnd(); }           // ^K
          else if (ch === "\x15")                       { killToStart(); }         // ^U
          else if (ch === "\x17")                       { deleteWord(); }          // ^W
          else if (ch === "\x10") {                                                 // ↑
            const matches = computeMatches();
            if (selectedSuggestion > 0) {
              selectedSuggestion--;
              fullRedraw(screenPosOf(cursor).row, matches);
            } else if (selectedSuggestion === 0) {
              selectedSuggestion = -1;
              fullRedraw(screenPosOf(cursor).row, matches);
            } else {
              moveLineUp();
            }
          }
          else if (ch === "\x11") {                                                 // ↓
            const matches = computeMatches();
            if (matches.length > 0 && selectedSuggestion < matches.length - 1) {
              selectedSuggestion++;
              fullRedraw(screenPosOf(cursor).row, matches);
            } else if (matches.length === 0) {
              moveLineDown();
            }
          }
          else if (ch === "\x13")                       { stashBuffer(); }         // ^S
          else if (ch === "\x1c")                       { moveWordLeft(); }        // option+←
          else if (ch === "\x1d")                       { moveWordRight(); }       // option+→
          else if (ch === "\x1e")                       { moveTo(cursor - 1); }    // ←
          else if (ch === "\x1f")                       { moveTo(cursor + 1); }    // →
          else if (ch === "\x09") {                                                 // Tab
            const matches = computeMatches();
            if (selectedSuggestion >= 0 && selectedSuggestion < matches.length) {
              replaceBuffer("/" + matches[selectedSuggestion].name + " ");
            } else if (matches.length > 0) {
              replaceBuffer("/" + matches[0].name + " ");
            }
          }
          else if (code >= 32)                          { insert(ch); }
        }
      }

      function normalizePaste(str: string) {
        return str.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      }

      function insertPaste(str: string) {
        const prevRow = screenPosOf(cursor).row;
        buffer = buffer.slice(0, cursor) + str + buffer.slice(cursor);
        cursor += str.length;
        fullRedraw(prevRow, computeMatches());
      }

      function onData(chunk: string) {
        if (inPaste) {
          const end = chunk.indexOf("\x1b[201~");
          if (end !== -1) {
            pasteBuffer += chunk.slice(0, end);
            inPaste = false;
            const normalized = normalizePaste(pasteBuffer);
            pasteBuffer = "";
            insertPaste(normalized);
          } else {
            pasteBuffer += chunk;
          }
          return;
        }

        const start = chunk.indexOf("\x1b[200~");
        if (start !== -1) {
          processTyped(chunk.slice(0, start));
          const rest = chunk.slice(start + 6);
          const end = rest.indexOf("\x1b[201~");
          if (end !== -1) {
            insertPaste(normalizePaste(rest.slice(0, end)));
          } else {
            pasteBuffer = rest;
            inPaste = true;
          }
          return;
        }

        processTyped(chunk);
      }

      process.stdin.on("data", onData);
    });
  }

}
