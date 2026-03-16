import fs from "fs";
import * as display from "./display.js";

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
  getCommands: () => string[] = () => listCommandNames(),
  abort?: Promise<string>,
): Promise<string> {
  return new Promise((resolve) => {
    let buffer = "";
    let pasteBuffer = "";
    let inPaste = false;
    let done = false;
    let suggestionsShown = false;
    // Visual length of prompt on the terminal line (excludes any leading \n)
    const promptVisualLen = promptStr.slice(promptStr.lastIndexOf("\n") + 1).length;
    let commands: string[] = [];
    try { commands = getCommands(); } catch { /* graceful: use empty */ }

    process.stdout.write(promptStr);

    if (abort) {
      void abort.then((value) => {
        if (!done) {
          // Clear current line and submit the abort value
          process.stdout.write("\r\x1b[K");
          submit(value);
        }
      });
    }

    function submit(value: string) {
      if (done) return;
      done = true;
      process.stdout.write("\r\n");
      process.stdin.removeListener("data", onData);
      resolve(value.trim());
    }

    function exit() {
      process.stdout.write("\x1b[?2004l\r\n");
      process.exit(0);
    }

    let cursor = 0; // current cursor position within buffer

    // ── Autocomplete ────────────────────────────────────────────────────────

    function computeMatches(): string[] {
      if (!buffer.startsWith("/")) return [];
      if (buffer.slice(1).includes(" ")) return [];
      const prefix = buffer.slice(1).split(/\s+/)[0];
      // prefix is "" when buffer is exactly "/" — matchCommands("", ...) returns all
      return matchCommands(prefix, commands).slice(0, 3);
    }

    function refreshSuggestions() {
      const matches = computeMatches();
      const fromEnd = buffer.length - cursor;
      if (fromEnd > 0) process.stdout.write(`\x1b[${fromEnd}C`);
      process.stdout.write("\r\n\x1b[K");
      if (matches.length > 0) {
        process.stdout.write(display.c.darkGray("  " + matches.map(m => "/" + m).join("  ")));
      }
      process.stdout.write("\x1b[A\r");
      const fwd = promptVisualLen + cursor;
      if (fwd > 0) process.stdout.write(`\x1b[${fwd}C`);
      suggestionsShown = matches.length > 0;
    }

    function clearSuggestions() {
      if (!suggestionsShown) return;
      const fromEnd = buffer.length - cursor;
      if (fromEnd > 0) process.stdout.write(`\x1b[${fromEnd}C`);
      process.stdout.write("\r\n\x1b[K\x1b[A\r");
      const fwd = promptVisualLen + cursor;
      if (fwd > 0) process.stdout.write(`\x1b[${fwd}C`);
      suggestionsShown = false;
    }

    function replaceBuffer(newText: string) {
      if (cursor > 0) process.stdout.write(`\x1b[${cursor}D`);
      process.stdout.write(newText + "\x1b[K");
      buffer = newText;
      cursor = newText.length;
    }

    // Write suffix from cursor, clear trailing chars, reposition cursor
    function redrawSuffix() {
      const rest = buffer.slice(cursor);
      process.stdout.write(rest + "\x1b[K");
      if (rest.length) process.stdout.write(`\x1b[${rest.length}D`);
    }

    function insert(ch: string) {
      buffer = buffer.slice(0, cursor) + ch + buffer.slice(cursor);
      cursor++;
      // Write ch + everything after it, then move back to just after ch
      const rest = buffer.slice(cursor);
      process.stdout.write(ch + rest + "\x1b[K");
      if (rest.length) process.stdout.write(`\x1b[${rest.length}D`);
    }

    function deleteBack() {
      if (cursor === 0) return;
      buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
      cursor--;
      process.stdout.write("\b");
      redrawSuffix();
    }

    function moveTo(pos: number) {
      pos = Math.max(0, Math.min(buffer.length, pos));
      if (pos === cursor) return;
      const delta = pos - cursor;
      process.stdout.write(delta < 0 ? `\x1b[${-delta}D` : `\x1b[${delta}C`);
      cursor = pos;
    }

    function killToEnd() {
      buffer = buffer.slice(0, cursor);
      process.stdout.write("\x1b[K");
    }

    function killToStart() {
      const rest = buffer.slice(cursor);
      buffer = rest;
      if (cursor) process.stdout.write(`\x1b[${cursor}D`);
      cursor = 0;
      redrawSuffix();
    }

    function deleteWord() {
      if (cursor === 0) return;
      let pos = cursor;
      while (pos > 0 && buffer[pos - 1] === " ") pos--;
      while (pos > 0 && buffer[pos - 1] !== " ") pos--;
      buffer = buffer.slice(0, pos) + buffer.slice(cursor);
      if (cursor - pos) process.stdout.write(`\x1b[${cursor - pos}D`);
      cursor = pos;
      redrawSuffix();
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
          clearSuggestions();
          submit(buffer);
          return;
        }
        else if (ch === "\x7f" || ch === "\x08")      { deleteBack(); refreshSuggestions(); }
        else if (ch === "\x03") { process.stdout.write("^C"); exit(); }
        else if (ch === "\x04") { if (!buffer) exit(); }
        else if (ch === "\x01")                       { moveTo(0); }             // ^A
        else if (ch === "\x05")                       { moveTo(buffer.length); } // ^E
        else if (ch === "\x0b")                       { killToEnd(); refreshSuggestions(); }           // ^K
        else if (ch === "\x15")                       { killToStart(); refreshSuggestions(); }         // ^U
        else if (ch === "\x17")                       { deleteWord(); refreshSuggestions(); }          // ^W
        else if (ch === "\x1c")                       { moveWordLeft(); }        // option+←
        else if (ch === "\x1d")                       { moveWordRight(); }       // option+→
        else if (ch === "\x1e")                       { moveTo(cursor - 1); }   // ←
        else if (ch === "\x1f")                       { moveTo(cursor + 1); }   // →
        else if (ch === "\x09") {                                                            // Tab
          const matches = computeMatches();
          if (matches.length > 0) { replaceBuffer("/" + matches[0]); refreshSuggestions(); }
        }
        else if (code >= 32)                          { insert(ch); refreshSuggestions(); }
      }
    }

    function normalizePaste(s: string) {
      return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    }

    function insertPaste(str: string) {
      buffer = buffer.slice(0, cursor) + str + buffer.slice(cursor);
      cursor += str.length;
      // Echo with \r\n... for newlines, then redraw any suffix after cursor
      process.stdout.write(str.split("\n").join("\r\n... "));
      redrawSuffix();
      refreshSuggestions();
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
