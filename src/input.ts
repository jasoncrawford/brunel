import fs from "fs";
import * as display from "./display.js";

// ── Stash ─────────────────────────────────────────────────────────────────────

/** Buffer stashed by ^S, restored as the initial value of the next ask() call. */
let stash: string | null = null;

/** Reset the stash (exposed for testing). */
export function _resetStash(): void { stash = null; }

// ── Frontmatter parsing ────────────────────────────────────────────────────────

/**
 * Parse a YAML frontmatter block (---...---) at the top of a string.
 * Returns key/value pairs as strings. Non-matching lines are silently skipped.
 * Returns {} if no frontmatter block is present.
 */
export function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) result[m[1].trim()] = m[2].trim();
  }
  return result;
}

// ── Argument application ──────────────────────────────────────────────────────

/**
 * Apply args to a loaded command/skill content string.
 * If content contains $ARGUMENTS, all occurrences are replaced with args (even if empty).
 * Otherwise, if args is non-empty, appends "\nARGUMENTS: <args>".
 * Otherwise returns content unchanged.
 */
export function applyArguments(content: string, args: string): string {
  if (content.includes("$ARGUMENTS")) {
    return content.replaceAll("$ARGUMENTS", args);
  }
  if (args) {
    return `${content}\nARGUMENTS: ${args}`;
  }
  return content;
}

// ── Slash commands ────────────────────────────────────────────────────────────

export type SlashCommandResult =
  | { type: "exit" }
  | { type: "clear" }
  | { type: "task_complete" }
  | { type: "unknown_command"; command: string };

type BuiltinCommand = {
  name: string;
  description: string;
  result: Exclude<SlashCommandResult, { type: "unknown_command" }>;
  workerOnly?: boolean;
};

const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { name: "clear",         description: "Clear the conversation",      result: { type: "clear" } },
  { name: "exit",          description: "Exit the REPL",               result: { type: "exit" } },
  { name: "task-complete", description: "Mark the current task as done", result: { type: "task_complete" }, workerOnly: true },
];

/**
 * Parse a slash command from raw user input.
 * Returns null if the input is not a slash command.
 */
export function parseSlashCommand(input: string): SlashCommandResult | null {
  if (!input.startsWith("/")) return null;
  const command = input.slice(1).split(/\s+/)[0];
  if (!command) return null;
  const builtin = BUILTIN_COMMANDS.find(c => c.name === command);
  if (builtin) return builtin.result;
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
 * Resolve the raw content for a command name by trying three locations in order:
 * 1. ~/.claude/commands/<command-path>.md  (custom command file)
 * 2. ~/.claude/skills/<command>/SKILL.md   (user skill)
 * 3. <plugin installPath>/skills/<skill>/SKILL.md  (plugin skill, for "plugin:skill" names)
 * Returns raw file content, or null if not found.
 * Does NOT apply arguments — that is left to the caller.
 */
export function resolveContent(
  command: string,
  readFile: (path: string) => string | null = defaultReadFile,
): string | null {
  // 1. Command file
  const cmdPath = resolveCommandFilePath(command);
  const cmdContent = readFile(cmdPath);
  if (cmdContent !== null) return cmdContent;

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";

  // 2. User skill
  const userSkillPath = `${home}/.claude/skills/${command}/SKILL.md`;
  const userContent = readFile(userSkillPath);
  if (userContent !== null) return userContent;

  // 3. Plugin skill (plugin:skill format only)
  const colonIdx = command.indexOf(":");
  if (colonIdx > 0) {
    const pluginName = command.slice(0, colonIdx);
    const skillName = command.slice(colonIdx + 1);
    const pluginsJson = readFile(`${home}/.claude/plugins/installed_plugins.json`);
    if (pluginsJson) {
      try {
        const parsed = JSON.parse(pluginsJson) as {
          plugins: Record<string, Array<{ installPath: string }>>;
        };
        for (const [key, entries] of Object.entries(parsed.plugins ?? {})) {
          if (key.split("@")[0] === pluginName) {
            for (const entry of entries) {
              const skillPath = `${entry.installPath}/skills/${skillName}/SKILL.md`;
              const content = readFile(skillPath);
              if (content !== null) return content;
            }
          }
        }
      } catch {
        // malformed JSON — return null
      }
    }
  }

  return null;
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
    // unknown_command: look up command file or skill
    const { command } = slash;
    const content = resolveContent(command, readFile);
    if (content === null) return { type: "unknown_command", command };
    const args = input.slice(1 + command.length).trim();
    const prompt = applyArguments(content, args);
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

/** A command name paired with a display description for autocomplete. */
export type CommandSuggestion = { name: string; description: string };

/**
 * Extract the best one-line description from file content.
 * Uses `description` frontmatter if present; otherwise the first non-empty
 * line of the body (after the frontmatter block).
 */
function extractDescription(content: string): string {
  const fm = parseFrontmatter(content);
  if (fm.description) return fm.description;
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/**
 * Like listCommandNames but returns CommandSuggestion objects that include a
 * one-line description for each command (sourced from frontmatter or first
 * line of the command file / skill).
 */
export function listCommands(
  listDir: ListDir = defaultListDir,
  readFile: (path: string) => string | null = defaultReadFile,
  workerMode = false,
): CommandSuggestion[] {
  const names = listCommandNames(listDir, readFile, workerMode);
  return names.map(name => {
    const builtin = BUILTIN_COMMANDS.find(c => c.name === name);
    if (builtin) return { name, description: builtin.description };
    const content = resolveContent(name, readFile);
    return { name, description: content ? extractDescription(content) : "" };
  });
}

/**
 * listCommands for worker mode (includes worker-only builtins such as
 * "task-complete").
 */
export function listWorkerCommands(
  listDir: ListDir = defaultListDir,
  readFile: (path: string) => string | null = defaultReadFile,
): CommandSuggestion[] {
  return listCommands(listDir, readFile, true);
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
 * Return all available command names: builtins plus any .md files under
 * ~/.claude/commands/ (recursively) and skill names.
 * Subdirectory names become colon-separated prefixes: foo/bar.md → "foo:bar".
 * Worker-only builtins (e.g. "task-complete") are excluded unless workerMode is true.
 * The listDir and readFile parameters are injectable for testing.
 */
export function listCommandNames(
  listDir: ListDir = defaultListDir,
  readFile: (path: string) => string | null = defaultReadFile,
  workerMode = false,
): string[] {
  const builtins = BUILTIN_COMMANDS.filter(c => workerMode || !c.workerOnly).map(c => c.name);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ""; // "" → walks "/.claude/commands" which will silently return null
  const commandsDir = `${home}/.claude/commands`;
  const fileCommands = walkDir(commandsDir, "", listDir);
  const skillNames = listSkillNames(listDir, readFile);
  return [...new Set([...builtins, ...fileCommands, ...skillNames])].sort();
}

/**
 * Return all available command names for worker mode — same as listCommandNames
 * but includes worker-only builtins (e.g. "task-complete").
 * The listDir and readFile parameters are injectable for testing.
 */
export function listWorkerCommandNames(
  listDir: ListDir = defaultListDir,
  readFile: (path: string) => string | null = defaultReadFile,
): string[] {
  return listCommandNames(listDir, readFile, true);
}

/**
 * Return all available skill names: user skills from ~/.claude/skills/ plus
 * plugin skills from installed_plugins.json.
 * Skills with `user-invocable: false` in their SKILL.md frontmatter are excluded.
 * Plugin skills are named "<plugin>:<skill>".
 * Both listDir and readFile are injectable for testing.
 */
export function listSkillNames(
  listDir: ListDir = defaultListDir,
  readFile: (path: string) => string | null = defaultReadFile,
): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const results: string[] = [];

  // Plugin skills
  const pluginsJson = readFile(`${home}/.claude/plugins/installed_plugins.json`);
  if (pluginsJson) {
    try {
      const parsed = JSON.parse(pluginsJson) as {
        plugins: Record<string, Array<{ installPath: string }>>;
      };
      for (const [key, entries] of Object.entries(parsed.plugins ?? {})) {
        const pluginName = key.split("@")[0];
        for (const entry of entries) {
          const skillsDir = `${entry.installPath}/skills`;
          const skillDirs = listDir(skillsDir);
          if (!skillDirs) continue;
          for (const dir of skillDirs) {
            if (!dir.isDir) continue;
            const skillMd = readFile(`${skillsDir}/${dir.name}/SKILL.md`);
            if (!skillMd) continue;
            const fm = parseFrontmatter(skillMd);
            if (fm["user-invocable"] === "false") continue;
            results.push(`${pluginName}:${dir.name}`);
          }
        }
      }
    } catch {
      // malformed JSON — skip plugin skills
    }
  }

  // User skills
  const userSkillsDir = `${home}/.claude/skills`;
  const userSkillDirs = listDir(userSkillsDir);
  if (userSkillDirs) {
    for (const dir of userSkillDirs) {
      if (!dir.isDir) continue;
      const skillMd = readFile(`${userSkillsDir}/${dir.name}/SKILL.md`);
      if (!skillMd) continue;
      const fm = parseFrontmatter(skillMd);
      if (fm["user-invocable"] === "false") continue;
      results.push(dir.name);
    }
  }

  return [...new Set(results)].sort();
}

// ── Raw input with bracketed paste support ────────────────────────────────────

// Bracketed paste mode: the terminal wraps pasted text in escape markers
// (\x1b[200~ ... \x1b[201~), letting us collect it as a single input
// rather than having each newline submit a separate prompt.

export function ask(
  promptStr: string,
  getCommands: () => CommandSuggestion[] = () => listCommands(),
  abort?: Promise<string>,
): Promise<string> {
  return new Promise((resolve) => {
    let buffer = stash ?? "";
    let pasteBuffer = "";
    let inPaste = false;
    let done = false;
    // Visual length of prompt on the terminal line (excludes any leading \n)
    const promptVisualLen = promptStr.slice(promptStr.lastIndexOf("\n") + 1).length;
    // Visual part of prompt string used when redrawing
    const promptLine = promptStr.slice(promptStr.lastIndexOf("\n") + 1);
    let commands: CommandSuggestion[] = [];
    try { commands = getCommands(); } catch { /* graceful: use empty */ }

    let cursor = buffer.length; // start cursor at end of any pre-populated stash
    // Number of rows used by the last full redraw (suggestion row is always included)
    let totalDrawnRows = 0;
    stash = null; // consume the stash

    process.stdout.write(promptStr);
    // If buffer was pre-populated from stash, render it immediately.
    if (buffer) fullRedraw(0, computeMatches());

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
        else                  { if (col >= cols) { row++; col = 0; } col++; }
      }
      return { row, col };
    }

    // ── Full redraw ───────────────────────────────────────────────────────────
    //
    // Redraws the entire input area (prompt + buffer + suggestion row) from
    // scratch.  prevRow is the screen row where the terminal cursor currently
    // sits (must be computed from the OLD buffer/cursor BEFORE any mutation).
    // After the redraw the terminal cursor is positioned at the current `cursor`.

    // ── Suggestion rendering ─────────────────────────────────────────────────
    //
    // Each suggestion is rendered on its own line. Command names are padded so
    // descriptions start at the same column across all visible suggestions.

    function renderSuggestions(suggestions: CommandSuggestion[]): string[] {
      if (suggestions.length === 0) return [];
      const cols = process.stdout.columns || 80;
      const maxNameLen = Math.max(...suggestions.map(s => s.name.length));
      return suggestions.map(s => {
        const prefix = "  /" + s.name.padEnd(maxNameLen + 2);
        const remaining = cols - prefix.length;
        let desc = s.description;
        if (remaining > 3 && desc) {
          if (desc.length > remaining) desc = desc.slice(0, remaining - 1) + "…";
        } else {
          desc = "";
        }
        return display.c.darkGray(prefix + desc);
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
      // The buffer-line clear and the first newline are combined into one write
      // so that no individual write call starts with \r\n.
      const sugLines = renderSuggestions(suggestions);
      const firstSugLine = sugLines.length > 0 ? sugLines[0] : "";
      process.stdout.write("\x1b[K\r\n\x1b[K" + firstSugLine);
      for (let i = 1; i < sugLines.length; i++) {
        process.stdout.write("\r\n\x1b[K" + sugLines[i]);
      }

      const sugLastRow = endRow + Math.max(1, sugLines.length);

      // 4. Clear any extra rows left over from a previously longer buffer or
      //    more suggestions
      for (let r = sugLastRow; r < totalDrawnRows; r++) {
        process.stdout.write("\r\n\x1b[K");
      }
      if (totalDrawnRows > sugLastRow) {
        process.stdout.write(`\x1b[${totalDrawnRows - sugLastRow}A`);
      }
      totalDrawnRows = sugLastRow;

      // 5. Go from last suggestion row back to prompt row 0
      process.stdout.write(`\x1b[${sugLastRow}A\r`);

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
      // display.print() already moved the cursor to a new line via console.log's
      // trailing \n; \r ensures we're at column 0 without adding an extra blank line.
      process.stdout.write("\r" + promptLine + displayStr);

      const { row: endRow } = screenPosOf(buffer.length);

      const matches = computeMatches();
      const sugLines = renderSuggestions(matches);
      const firstSugLine = sugLines.length > 0 ? sugLines[0] : "";
      process.stdout.write("\x1b[K\r\n\x1b[K" + firstSugLine);
      for (let i = 1; i < sugLines.length; i++) {
        process.stdout.write("\r\n\x1b[K" + sugLines[i]);
      }

      const sugLastRow = endRow + Math.max(1, sugLines.length);
      totalDrawnRows = sugLastRow;

      process.stdout.write(`\x1b[${sugLastRow}A\r`);

      const { row: targetRow, col: targetCol } = screenPosOf(cursor);
      if (targetRow > 0) process.stdout.write(`\x1b[${targetRow}B`);
      if (targetCol > 0) process.stdout.write(`\x1b[${targetCol}C`);
    }

    // Register the fresh-redraw hook so display.print() can notify us.
    // Only register when there is a visible prompt to redraw — an empty prompt
    // string means the caller doesn't want any prompt shown (e.g. worker
    // standby mode), so no redraw is needed and no line-clear should fire.
    if (promptLine) display.setInputPrintCallback(drawFresh);

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
      // Don't call cleanup() here — process.exit() terminates for real;
      // in tests where exit() is mocked, the listener stays alive so tests
      // can push "\r" to resolve the dangling promise.
      process.stdout.write("\x1b[?2004l\r\n");
      process.exit(0);
    }

    // ── Autocomplete ────────────────────────────────────────────────────────

    function computeMatches(): CommandSuggestion[] {
      if (!buffer.startsWith("/")) return [];
      if (buffer.slice(1).includes(" ")) return [];
      const prefix = buffer.slice(1).split(/\s+/)[0];
      // prefix is "" when buffer is exactly "/" — filter("", ...) returns all
      return commands.filter(c => c.name.startsWith(prefix)).slice(0, 5);
    }

    // ── Editing operations (all use fullRedraw) ──────────────────────────────

    function replaceBuffer(newText: string) {
      const prevRow = screenPosOf(cursor).row;
      buffer = newText;
      cursor = newText.length;
      fullRedraw(prevRow, computeMatches());
    }

    function insert(ch: string) {
      const prevRow = screenPosOf(cursor).row;
      buffer = buffer.slice(0, cursor) + ch + buffer.slice(cursor);
      cursor++;
      fullRedraw(prevRow, computeMatches());
    }

    function deleteBack() {
      if (cursor === 0) return;
      const prevRow = screenPosOf(cursor).row;
      buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
      cursor--;
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
      process.stdout.write(display.c.darkGray("✦ Prompt stashed — will be restored on next submit\r\n"));
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
          if (matches.length > 0) { replaceBuffer("/" + matches[0].name); }
          submit(buffer);
          return;
        }
        else if (ch === "\x7f" || ch === "\x08")      { deleteBack(); }
        else if (ch === "\x03") { if (buffer) { replaceBuffer(""); } else { process.stdout.write("^C"); exit(); } }
        else if (ch === "\x04") { if (!buffer) exit(); }
        else if (ch === "\x01")                       { moveTo(0); }             // ^A
        else if (ch === "\x05")                       { moveTo(buffer.length); } // ^E
        else if (ch === "\x0b")                       { killToEnd(); }           // ^K
        else if (ch === "\x15")                       { killToStart(); }         // ^U
        else if (ch === "\x17")                       { deleteWord(); }          // ^W
        else if (ch === "\x10")                       { moveLineUp(); }          // ↑
        else if (ch === "\x11")                       { moveLineDown(); }        // ↓
        else if (ch === "\x13")                       { stashBuffer(); }         // ^S
        else if (ch === "\x1c")                       { moveWordLeft(); }        // option+←
        else if (ch === "\x1d")                       { moveWordRight(); }       // option+→
        else if (ch === "\x1e")                       { moveTo(cursor - 1); }    // ←
        else if (ch === "\x1f")                       { moveTo(cursor + 1); }    // →
        else if (ch === "\x09") {                                                 // Tab
          const matches = computeMatches();
          if (matches.length > 0) { replaceBuffer("/" + matches[0].name + " "); }
        }
        else if (code >= 32)                          { insert(ch); }
      }
    }

    function normalizePaste(s: string) {
      return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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

// ── Interactive pickers (raw-mode arrow-key menus) ─────────────────────────

/** Formats a single picker row: adds ▶/space marker and dims non-selected rows. */
function pickerLine(text: string, isSelected: boolean): string {
  const prefix = isSelected ? "▶ " : "  ";
  const full = prefix + text;
  return isSelected ? full : display.s.dim(full);
}

/**
 * Single-selection arrow-key picker. Returns the index of the chosen option.
 * Up/down arrows move the cursor; Enter confirms. Ctrl-C exits the process.
 * Assumes stdin is already in raw mode.
 */
export async function pick(options: string[], promptStr?: string): Promise<number> {
  return new Promise((resolve) => {
    let idx = 0;
    let done = false;
    const count = options.length;

    if (promptStr) process.stdout.write(promptStr + "\n");
    for (let i = 0; i < count; i++) {
      process.stdout.write(pickerLine(options[i], i === idx) + "\n");
    }

    function redraw() {
      process.stdout.write(`\x1b[${count}A\r`);
      for (let i = 0; i < count; i++) {
        process.stdout.write(pickerLine(options[i], i === idx) + "\x1b[K\r\n");
      }
    }

    function onData(raw: string) {
      if (done) return;
      let data = raw;
      data = data.replace(/\x1b\[A/g, "\x10"); // up arrow
      data = data.replace(/\x1b\[B/g, "\x11"); // down arrow
      data = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
      data = data.replace(/\x1b./gs, "");
      for (const ch of data) {
        if (ch === "\x10") { idx = (idx - 1 + count) % count; redraw(); }
        else if (ch === "\x11") { idx = (idx + 1) % count; redraw(); }
        else if (ch === "\r" || ch === "\n") {
          done = true;
          process.stdin.removeListener("data", onData);
          resolve(idx);
        } else if (ch === "\x03") {
          process.stdout.write("^C\r\n");
          process.exit(0);
        }
      }
    }

    process.stdin.on("data", onData);
  });
}

/**
 * Multi-selection arrow-key picker. Returns an array of selected indices.
 * Up/down arrows move the cursor; Space toggles selection; Enter confirms.
 * Ctrl-C exits the process.
 */
export async function pickMultiple(options: string[], promptStr?: string): Promise<number[]> {
  return new Promise((resolve) => {
    let idx = 0;
    let done = false;
    const count = options.length;
    const selected = new Set<number>();

    if (promptStr) process.stdout.write(promptStr + "\n");
    for (let i = 0; i < count; i++) {
      const check = selected.has(i) ? "◉" : "○";
      process.stdout.write(pickerLine(`${check} ${options[i]}`, i === idx) + "\n");
    }

    function redraw() {
      process.stdout.write(`\x1b[${count}A\r`);
      for (let i = 0; i < count; i++) {
        const check = selected.has(i) ? "◉" : "○";
        process.stdout.write(pickerLine(`${check} ${options[i]}`, i === idx) + "\x1b[K\r\n");
      }
    }

    function onData(raw: string) {
      if (done) return;
      let data = raw;
      data = data.replace(/\x1b\[A/g, "\x10"); // up arrow
      data = data.replace(/\x1b\[B/g, "\x11"); // down arrow
      data = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
      data = data.replace(/\x1b./gs, "");
      for (const ch of data) {
        if (ch === "\x10") { idx = (idx - 1 + count) % count; redraw(); }
        else if (ch === "\x11") { idx = (idx + 1) % count; redraw(); }
        else if (ch === " ") {
          if (selected.has(idx)) selected.delete(idx);
          else selected.add(idx);
          redraw();
        } else if (ch === "\r" || ch === "\n") {
          done = true;
          process.stdin.removeListener("data", onData);
          resolve([...selected].sort((a, b) => a - b));
        } else if (ch === "\x03") {
          process.stdout.write("^C\r\n");
          process.exit(0);
        }
      }
    }

    process.stdin.on("data", onData);
  });
}

// ── Question picker (AskUserQuestion) ─────────────────────────────────────────

/**
 * Minimal single-line text prompt. Reads characters until Enter,
 * supporting backspace. No autocomplete or multiline support.
 */
export async function promptLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdout.write(prompt);

    function onData(raw: string) {
      const data = raw
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
        .replace(/\x1b./gs, "");
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          process.stdout.write("\r\n");
          process.stdin.removeListener("data", onData);
          resolve(buf);
          return;
        } else if (ch === "\x7f" || ch === "\x08") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write("\x08 \x08");
          }
        } else if (ch === "\x03") {
          process.stdout.write("^C\r\n");
          process.exit(0);
        } else if (ch.charCodeAt(0) >= 32) {
          buf += ch;
          process.stdout.write(ch);
        }
      }
    }

    process.stdin.on("data", onData);
  });
}

export type PickQuestionResult =
  | { type: "answer"; value: string }
  | { type: "other"; text: string }
  | { type: "discuss" };

/**
 * Single-selection picker for AskUserQuestion tool calls.
 * Options are rendered as numbered items with bold label and description.
 * Non-selected rows are dim; the selected row is normal weight.
 * "Other:" (free-text entry) and "Let's discuss" (deny) are always appended.
 * Digit keys 1–9 jump the cursor to that 1-based index.
 */
export async function pickQuestion(
  options: Array<{ label: string; description: string }>,
): Promise<PickQuestionResult> {
  return new Promise((resolve) => {
    const extras = [
      { label: "Other:",        description: "" },
      { label: "Let's discuss", description: "" },
    ];
    const all = [...options, ...extras];
    const count = all.length;
    const otherIdx   = count - 2;
    const discussIdx = count - 1;

    let idx = 0;
    let done = false;
    let textMode = false; // true when typing inline answer for Other:
    let textBuf = "";

    function renderLine(i: number): string {
      const num = i + 1;
      const numStr = num <= 9 ? `${num}` : " ";
      const opt = all[i];
      if (i === idx) {
        // Selected: bold label, normal weight description — no dim
        let text: string;
        if (i === otherIdx && textMode) {
          text = `${display.s.bold("Other:")} ${textBuf}`;
        } else if (opt.description) {
          text = `${display.s.bold(opt.label)}. ${opt.description}`;
        } else {
          text = display.s.bold(opt.label);
        }
        return pickerLine(`${numStr}. ${text}`, true);
      } else {
        // Non-selected: entire line dim, no bold (bold resets dim via \x1b[22m)
        const text = opt.description ? `${opt.label}. ${opt.description}` : opt.label;
        return pickerLine(`${numStr}. ${text}`, false);
      }
    }

    // After a full redraw (cursor below last line), position cursor at end of Other: text
    function positionTextCursor() {
      // Move up from below-last-line to Other: row, then right past the visible prefix
      // Visible prefix: "▶ "(2) + numStr(1) + ". "(2) + "Other: "(7) = 12 chars + textBuf
      process.stdout.write(`\x1b[${count - otherIdx}A\r\x1b[${12 + textBuf.length}C`);
    }

    for (let i = 0; i < count; i++) {
      process.stdout.write(renderLine(i) + "\r\n");
    }

    function redraw() {
      process.stdout.write(`\x1b[${count}A\r`);
      for (let i = 0; i < count; i++) {
        process.stdout.write(renderLine(i) + "\x1b[K\r\n");
      }
      // When Other: is selected, position terminal cursor at end of text entry area
      if (idx === otherIdx) positionTextCursor();
    }

    function navigateTo(newIdx: number) {
      if (idx === otherIdx && textMode) {
        // Move cursor from Other: line back to below last line before redrawing
        process.stdout.write(`\x1b[${count - otherIdx}B`);
        textMode = false;
        textBuf = "";
      }
      idx = newIdx;
      if (idx === otherIdx) textMode = true;
      redraw();
    }

    function onData(raw: string) {
      if (done) return;
      let data = raw;
      data = data.replace(/\x1b\[A/g, "\x10"); // up
      data = data.replace(/\x1b\[B/g, "\x11"); // down
      data = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
      data = data.replace(/\x1b./gs, "");
      for (const ch of data) {
        if (textMode) {
          // Inline text entry for Other: — write chars directly (cursor already positioned)
          if (ch === "\r" || ch === "\n") {
            done = true;
            process.stdin.removeListener("data", onData);
            resolve({ type: "other", text: textBuf });
            return;
          } else if (ch === "\x10") { navigateTo((idx - 1 + count) % count); }
          else if (ch === "\x11")   { navigateTo((idx + 1) % count); }
          else if (ch === "\x7f" || ch === "\x08") {
            if (textBuf.length > 0) {
              textBuf = textBuf.slice(0, -1);
              process.stdout.write("\x08 \x08");
            }
          } else if (ch === "\x03") {
            process.stdout.write("^C\r\n");
            process.exit(0);
          } else if (ch.charCodeAt(0) >= 32) {
            textBuf += ch;
            process.stdout.write(ch);
          }
        } else {
          if (ch === "\x10") { navigateTo((idx - 1 + count) % count); }
          else if (ch === "\x11") { navigateTo((idx + 1) % count); }
          else if (ch === "\r" || ch === "\n") {
            if (idx === discussIdx) {
              done = true;
              process.stdin.removeListener("data", onData);
              resolve({ type: "discuss" });
            } else if (idx === otherIdx) {
              // Already in textMode; Enter submits (textBuf is empty if they just navigated here)
              done = true;
              process.stdin.removeListener("data", onData);
              resolve({ type: "other", text: textBuf });
            } else {
              done = true;
              process.stdin.removeListener("data", onData);
              resolve({ type: "answer", value: options[idx].label });
            }
            return;
          } else if (ch === "\x03") {
            process.stdout.write("^C\r\n");
            process.exit(0);
          } else if (ch >= "1" && ch <= "9") {
            const n = parseInt(ch, 10) - 1;
            if (n < count) { navigateTo(n); }
          }
        }
      }
    }

    process.stdin.on("data", onData);
  });
}
