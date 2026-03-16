import fs from "fs";
import * as display from "./display.js";

// ── Slash commands ────────────────────────────────────────────────────────────

export type SlashCommandResult =
  | { type: "exit" }
  | { type: "clear" }
  | { type: "task_complete" }
  | { type: "unknown_command"; command: string };

/**
 * Parse a slash command from raw user input.
 * Returns null if the input is not a slash command.
 */
export function parseSlashCommand(input: string): SlashCommandResult | null {
  if (!input.startsWith("/")) return null;
  const command = input.slice(1).split(/\s+/)[0];
  if (!command) return null;
  if (command === "exit") return { type: "exit" };
  if (command === "clear") return { type: "clear" };
  if (command === "task-complete") return { type: "task_complete" };
  return { type: "unknown_command", command };
}

/**
 * Convert a slash command name to its file path under ~/.claude/commands/.
 * Colons become path separators: "foo:bar" → ~/.claude/commands/foo/bar.md
 */
export function resolveCommandFilePath(command: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const rel = command.replace(/:/g, "/");
  return `${home}/.claude/commands/${rel}.md`;
}

/**
 * Load a custom slash command from disk, returning the file content as the
 * query prompt, or null if the file does not exist.
 * The readFile parameter is injectable for testing.
 */
export function loadCommandFile(
  command: string,
  readFile: (path: string) => string | null = defaultReadFile,
): string | null {
  const filePath = resolveCommandFilePath(command);
  return readFile(filePath);
}

function defaultReadFile(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export type DispatchResult =
  | { type: "skip" }
  | { type: "exit" }
  | { type: "clear" }
  | { type: "task_complete" }
  | { type: "query"; prompt: string }
  | { type: "unknown_command"; command: string };

/**
 * Dispatch user input to the appropriate REPL action.
 * readFile is injectable for testing.
 */
export async function dispatchInput(
  input: string,
  readFile: (path: string) => string | null = defaultReadFile,
): Promise<DispatchResult> {
  if (!input) return { type: "skip" };

  const slash = parseSlashCommand(input);
  if (slash) {
    if (slash.type === "exit" || slash.type === "clear") return slash;
    if (slash.type === "task_complete") return slash;
    // unknown_command: look up file
    const { command } = slash;
    const content = loadCommandFile(command, readFile);
    if (content === null) return { type: "unknown_command", command };
    const args = input.slice(1 + command.length).trim();
    const prompt = args ? `${content}\n${args}` : content;
    return { type: "query", prompt };
  }

  return { type: "query", prompt: input };
}

// ── Autocomplete ─────────────────────────────────────────────────────────────

/**
 * Filter commands by prefix. Returns commands that start with prefix.
 * Empty prefix returns all commands. Preserves input order.
 */
export function matchCommands(prefix: string, commands: string[]): string[] {
  return commands.filter(cmd => cmd.startsWith(prefix));
}

export type ListDir = (dir: string) => Array<{ name: string; isDir: boolean }> | null;

function walkDir(dir: string, prefix: string, listDir: ListDir): string[] {
  const entries = listDir(dir);
  if (!entries) return [];
  const result: string[] = [];
  for (const entry of entries) {
    const name = prefix ? `${prefix}:${entry.name}` : entry.name;
    if (entry.isDir) {
      result.push(...walkDir(`${dir}/${entry.name}`, name, listDir));
    } else if (entry.name.endsWith(".md")) {
      result.push(name.slice(0, -3)); // strip .md extension
    }
  }
  return result;
}

function defaultListDir(dir: string): Array<{ name: string; isDir: boolean }> | null {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map(e => ({
      name: e.name,
      isDir: e.isDirectory(),
    }));
  } catch {
    return null;
  }
}

/**
 * Return all available command names: builtins ("clear", "exit") plus
 * any .md files found under ~/.claude/commands/ (recursively).
 * Subdirectory names become colon-separated prefixes: foo/bar.md → "foo:bar".
 * The listDir parameter is injectable for testing.
 */
export function listCommandNames(listDir: ListDir = defaultListDir): string[] {
  const builtins = ["clear", "exit"];
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ""; // "" → walks "/.claude/commands" which will silently return null
  const commandsDir = `${home}/.claude/commands`;
  const fileCommands = walkDir(commandsDir, "", listDir);
  return [...new Set([...builtins, ...fileCommands])].sort();
}

// ── Raw input with bracketed paste support ────────────────────────────────────

// Bracketed paste mode: the terminal wraps pasted text in escape markers
// (\x1b[200~ ... \x1b[201~), letting us collect it as a single input
// rather than having each newline submit a separate prompt.

export function ask(
  promptStr: string,
  getCommands: () => string[] = () => listCommandNames(),
  abort?: Promise<string>,
): Promise<string> {
  return new Promise((resolve) => {
    let buffer = "";
    let pasteBuffer = "";
    let inPaste = false;
    let done = false;
    // Visual length of prompt on the terminal line (excludes any leading \n)
    const promptVisualLen = promptStr.slice(promptStr.lastIndexOf("\n") + 1).length;
    // Visual part of prompt string used when redrawing
    const promptLine = promptStr.slice(promptStr.lastIndexOf("\n") + 1);
    let commands: string[] = [];
    try { commands = getCommands(); } catch { /* graceful: use empty */ }

    let cursor = 0; // current cursor position within buffer
    // Number of rows used by the last full redraw (suggestion row is always included)
    let totalDrawnRows = 0;

    process.stdout.write(promptStr);

    // ── Multiline-aware screen position ──────────────────────────────────────
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
        else                  { col++; if (col >= cols) { row++; col = 0; } }
      }
      return { row, col };
    }

    // ── Full redraw ───────────────────────────────────────────────────────────
    //
    // Redraws the entire input area (prompt + buffer + suggestion row) from
    // scratch.  prevCursor is the buffer position where the terminal cursor
    // currently sits (before this redraw).  After the redraw the terminal
    // cursor is positioned at the current `cursor` value.

    function fullRedraw(prevCursor: number, suggestions: string[]) {
      const { row: prevRow } = screenPosOf(prevCursor);

      // 1. Move to start of prompt (row 0, col 0)
      if (prevRow > 0) process.stdout.write(`\x1b[${prevRow}A`);
      process.stdout.write("\r");

      // 2. Write prompt + buffer (pasted \n → visual continuation "... ")
      const displayStr = buffer.replace(/\n/g, "\r\n    ");
      process.stdout.write(promptLine + displayStr);

      const { row: endRow } = screenPosOf(buffer.length);

      // 3. Clear to end of last buffer line, then write suggestion row
      process.stdout.write("\x1b[K\r\n\x1b[K");
      if (suggestions.length > 0) {
        process.stdout.write(display.c.darkGray("  " + suggestions.map(m => "/" + m).join("  ")));
      }

      const sugRow = endRow + 1;

      // 4. Clear any extra rows left over from a previously longer buffer
      for (let r = sugRow; r < totalDrawnRows; r++) {
        process.stdout.write("\r\n\x1b[K");
      }
      if (totalDrawnRows > sugRow) {
        process.stdout.write(`\x1b[${totalDrawnRows - sugRow}A`);
      }
      totalDrawnRows = sugRow;

      // 5. Go from suggestion row back to prompt row 0
      process.stdout.write(`\x1b[${sugRow}A\r`);

      // 6. Navigate to current cursor position
      const { row: targetRow, col: targetCol } = screenPosOf(cursor);
      if (targetRow > 0) process.stdout.write(`\x1b[${targetRow}B`);
      if (targetCol > 0) process.stdout.write(`\x1b[${targetCol}C`);
    }

    // ── Fresh redraw after external output ───────────────────────────────────
    //
    // Called when display.print() writes output while ask() is running (e.g.
    // a WebSocket message arriving in worker mode).  The terminal cursor is
    // now at an unknown position below the old prompt, so we start a fresh
    // prompt on a new line rather than trying to navigate back.

    function drawFresh() {
      if (done) return;
      totalDrawnRows = 0; // reset: we're drawing from a new position
      const displayStr = buffer.replace(/\n/g, "\r\n    ");
      // Start on a fresh line
      process.stdout.write("\r\n" + promptLine + displayStr);

      const { row: endRow } = screenPosOf(buffer.length);

      process.stdout.write("\x1b[K\r\n\x1b[K");
      const matches = computeMatches();
      if (matches.length > 0) {
        process.stdout.write(display.c.darkGray("  " + matches.map(m => "/" + m).join("  ")));
      }

      const sugRow = endRow + 1;
      totalDrawnRows = sugRow;

      process.stdout.write(`\x1b[${sugRow}A\r`);

      const { row: targetRow, col: targetCol } = screenPosOf(cursor);
      if (targetRow > 0) process.stdout.write(`\x1b[${targetRow}B`);
      if (targetCol > 0) process.stdout.write(`\x1b[${targetCol}C`);
    }

    // Register the fresh-redraw hook so display.print() can notify us
    display.setInputPrintCallback(drawFresh);

    if (abort) {
      void abort.then((value) => {
        if (!done) {
          // Clear current line and submit the abort value
          process.stdout.write("\r\x1b[K");
          submit(value);
        }
      });
    }

    function cleanup() {
      display.setInputPrintCallback(null);
      process.stdin.removeListener("data", onData);
    }

    function submit(value: string) {
      if (done) return;
      done = true;
      // Navigate to end of buffer, clear suggestion row, then final newline
      const { row: curRow } = screenPosOf(cursor);
      const { row: endRow } = screenPosOf(buffer.length);
      const rowDiff = endRow - curRow;
      if (rowDiff > 0) process.stdout.write(`\x1b[${rowDiff}B`);
      else if (rowDiff < 0) process.stdout.write(`\x1b[${-rowDiff}A`);
      process.stdout.write("\r\n\x1b[K\r\n");
      cleanup();
      resolve(value.trim());
    }

    function exit() {
      // Don't call cleanup() here — process.exit() terminates for real;
      // in tests where exit() is mocked, the listener stays alive so tests
      // can push "\r" to resolve the dangling promise.
      process.stdout.write("\x1b[?2004l\r\n");
      process.exit(0);
    }

    // ── Autocomplete ────────────────────────────────────────────────────────

    function computeMatches(): string[] {
      if (!buffer.startsWith("/")) return [];
      if (buffer.slice(1).includes(" ")) return [];
      const prefix = buffer.slice(1).split(/\s+/)[0];
      // prefix is "" when buffer is exactly "/" — matchCommands("", ...) returns all
      return matchCommands(prefix, commands).slice(0, 3);
    }

    // ── Editing operations (all use fullRedraw) ──────────────────────────────

    function replaceBuffer(newText: string) {
      const prev = cursor;
      buffer = newText;
      cursor = newText.length;
      fullRedraw(prev, computeMatches());
    }

    function insert(ch: string) {
      const prev = cursor;
      buffer = buffer.slice(0, cursor) + ch + buffer.slice(cursor);
      cursor++;
      fullRedraw(prev, computeMatches());
    }

    function deleteBack() {
      if (cursor === 0) return;
      const prev = cursor;
      buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
      cursor--;
      fullRedraw(prev, computeMatches());
    }

    function moveTo(pos: number) {
      pos = Math.max(0, Math.min(buffer.length, pos));
      if (pos === cursor) return;
      const prev = cursor;
      cursor = pos;
      fullRedraw(prev, computeMatches());
    }

    function killToEnd() {
      const prev = cursor;
      buffer = buffer.slice(0, cursor);
      fullRedraw(prev, computeMatches());
    }

    function killToStart() {
      const prev = cursor;
      buffer = buffer.slice(cursor);
      cursor = 0;
      fullRedraw(prev, computeMatches());
    }

    function deleteWord() {
      if (cursor === 0) return;
      const prev = cursor;
      let pos = cursor;
      while (pos > 0 && buffer[pos - 1] === " ") pos--;
      while (pos > 0 && buffer[pos - 1] !== " ") pos--;
      buffer = buffer.slice(0, pos) + buffer.slice(cursor);
      cursor = pos;
      fullRedraw(prev, computeMatches());
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

    function processTyped(data: string) {
      // Substitute known sequences with placeholder chars before stripping
      data = data.replace(/\x1b\[1;3D/g, "\x1c"); // iTerm2 option+left  → 0x1C
      data = data.replace(/\x1b\[1;3C/g, "\x1d"); // iTerm2 option+right → 0x1D
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
          if (matches.length > 0) { replaceBuffer("/" + matches[0]); }
          submit(buffer);
          return;
        }
        else if (ch === "\x7f" || ch === "\x08")      { deleteBack(); }
        else if (ch === "\x03") { process.stdout.write("^C"); exit(); }
        else if (ch === "\x04") { if (!buffer) exit(); }
        else if (ch === "\x01")                       { moveTo(0); }             // ^A
        else if (ch === "\x05")                       { moveTo(buffer.length); } // ^E
        else if (ch === "\x0b")                       { killToEnd(); }           // ^K
        else if (ch === "\x15")                       { killToStart(); }         // ^U
        else if (ch === "\x17")                       { deleteWord(); }          // ^W
        else if (ch === "\x1c")                       { moveWordLeft(); }        // option+←
        else if (ch === "\x1d")                       { moveWordRight(); }       // option+→
        else if (ch === "\x1e")                       { moveTo(cursor - 1); }    // ←
        else if (ch === "\x1f")                       { moveTo(cursor + 1); }    // →
        else if (ch === "\x09") {                                                 // Tab
          const matches = computeMatches();
          if (matches.length > 0) { replaceBuffer("/" + matches[0]); }
        }
        else if (code >= 32)                          { insert(ch); }
      }
    }

    function normalizePaste(s: string) {
      return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    }

    function insertPaste(str: string) {
      const prev = cursor;
      buffer = buffer.slice(0, cursor) + str + buffer.slice(cursor);
      cursor += str.length;
      fullRedraw(prev, computeMatches());
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
