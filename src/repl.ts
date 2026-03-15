import fs from "fs";
import { fileURLToPath } from "url";
import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import * as display from "./display.js";
export * from "./display.js";
import { WebSocket } from "ws";
import { getWorkerId } from "./worker-id.js";
import { buildInitialPrompt, buildEventPrompt } from "./templates.js";
import type { ForemanMessage, GitHubEvent, TaskIssue } from "./types.js";

// ── Log file ──────────────────────────────────────────────────────────────────

const LOG_FILE = "repl.log";

export function logFull(label: string, data: unknown) {
  const entry =
    `\n${"=".repeat(70)}\n` +
    `${new Date().toISOString()}  ${label}\n` +
    `${"-".repeat(70)}\n` +
    JSON.stringify(data, null, 2) +
    "\n";
  fs.appendFileSync(LOG_FILE, entry);
}

// ── Hook factory ──────────────────────────────────────────────────────────────

function makeHook(event: string): HookCallback {
  return async (input) => {
    logFull(`HOOK ${event}`, input);
    display.printHook(event, input);
    return {};
  };
}

const ALL_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PermissionRequest",
  "Setup",
  "TeammateIdle",
  "TaskCompleted",
  "ConfigChange",
] as const;

type HookEvent = (typeof ALL_HOOK_EVENTS)[number];

const hooks = Object.fromEntries(
  ALL_HOOK_EVENTS.map((event) => [
    event,
    [{ matcher: ".*", hooks: [makeHook(event)] }],
  ])
) as Record<HookEvent, [{ matcher: string; hooks: [HookCallback] }]>;

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

// ── Config ────────────────────────────────────────────────────────────────────

const BYPASS = process.argv.includes("--dangerously-skip-permissions");
const PERMISSION_MODE = BYPASS ? "bypassPermissions" : "acceptEdits";

// ── REPL ──────────────────────────────────────────────────────────────────────

export async function runQuery(prompt: string, sessionId: string | undefined) {
  logFull("QUERY", { prompt, sessionId });

  const startTime = Date.now();
  // Accumulate stats from stream_event messages to show in the status line.
  // message_delta.usage.output_tokens is cumulative per message, so we sum
  // completed messages and track the current one separately.
  const stats = { turns: 0, inputTokens: 0, completedOutputTokens: 0, currentOutputTokens: 0 };
  display.startStatus(() => {
    const secs = Math.floor((Date.now() - startTime) / 1000);
    const outTokens = stats.completedOutputTokens + stats.currentOutputTokens;
    return display.c.darkGray(`Working… ${display.fmtStats(secs, stats.turns || undefined, outTokens || undefined, stats.inputTokens || undefined)}`);
  });

  let capturedSessionId = sessionId;

  for await (const message of query({
    prompt,
    options: {
      cwd: process.cwd(),
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project"],
      permissionMode: PERMISSION_MODE,
      includePartialMessages: true,
      ...(BYPASS ? { allowDangerouslySkipPermissions: true } : {}),
      ...(sessionId ? { resume: sessionId } : {}),
      hooks,
    },
  })) {
    const m = message as any;

    if (!(m.type === "stream_event" && m.event?.type === "content_block_delta")) {
      logFull("MESSAGE", message);
    }

    if (m.type === "system" && m.subtype === "init" && !capturedSessionId) {
      capturedSessionId = m.session_id;
    }

    // Extract turn count and token totals from streaming events.
    if (m.type === "stream_event") {
      if (m.parent_tool_use_id == null) {
        const ev = m.event;
        if (ev.type === "message_start")       { stats.turns++; stats.inputTokens += ev.message?.usage?.input_tokens ?? 0; }
        if (ev.type === "message_delta")       stats.currentOutputTokens = ev.usage?.output_tokens ?? stats.currentOutputTokens;
        if (ev.type === "message_stop")        { stats.completedOutputTokens += stats.currentOutputTokens; stats.currentOutputTokens = 0; }
      }
      continue; // stream events are display-only; don't pass to printMessage
    }

    // Stop the status line before printing the result so it transitions
    // cleanly into the permanent summary line.
    if (m.type === "result") display.stopStatus();

    display.printMessage(message);
  }

  display.stopStatus(); // no-op if result message already stopped it
  return capturedSessionId;
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
      abort.then((value) => {
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write("\x1b[?2004h"); // enable bracketed paste mode
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let sessionId: string | undefined;

  display.print(display.c.sageGreen(display.hr("═")));
  display.print(display.c.skyBlue(display.s.bold("  Claude Agent SDK REPL")));
  display.print(display.c.lavender(`  Permissions: ${PERMISSION_MODE} | Output: ${display.VERBOSE ? "verbose" : "quiet"} | Log: ${LOG_FILE}`));
  display.print(display.c.lavender(`  Type /exit to quit, /clear to start a new session.`));
  display.print(display.c.sageGreen(display.hr("═")));

  while (true) {
    const input = await ask("\n> ");

    const action = await dispatchInput(input);

    if (action.type === "skip") continue;

    if (action.type === "exit") {
      process.stdout.write("\x1b[?2004l\r\n");
      process.stdin.setRawMode(false);
      process.stdin.pause();
      break;
    }

    if (action.type === "clear") {
      sessionId = undefined;
      display.print("Session cleared.");
      continue;
    }

    if (action.type === "unknown_command") {
      display.print(display.c.boldRed(`Unknown command: /${action.command}`));
      continue;
    }

    try {
      sessionId = await runQuery(action.prompt, sessionId);
    } catch (err) {
      console.error(display.c.boldRed(`\nERROR: ${err}`));
      logFull("ERROR", err instanceof Error ? { message: err.message, stack: err.stack } : err);
    }
  }
}

// ── Worker mode ───────────────────────────────────────────────────────────────

/**
 * Create a WebSocket connection to the foreman at the /worker path and send
 * the initial worker_hello handshake. Returns the WebSocket for the caller to
 * attach message/close/error handlers.
 */
export function connectToForeman(foremanUrl: string, workerId: string, taskId?: string): WebSocket {
  const ws = new WebSocket(`${foremanUrl}/worker`);
  ws.on("open", () => {
    ws.send(JSON.stringify({
      type: "worker_hello",
      workerId,
      taskId,
      status: taskId ? "busy" : "idle",
    }));
  });
  return ws;
}

export async function workerMain() {
  const FOREMAN_URL = process.env.FOREMAN_URL ?? "ws://localhost:3000";
  const workerId = getWorkerId();

  // Local event queue — populated by the ws message handler even during runQuery()
  const pendingEvents: GitHubEvent[] = [];
  let currentTaskId: string | undefined;
  let currentSessionId: string | undefined;
  let currentIssue: TaskIssue | undefined;

  // Sentinel values used to signal WebSocket events through ask()'s abort param
  const WS_TASK_ASSIGNED = "__task_assigned__";
  const WS_EVENT = "__event__";

  // Signalling: when the worker is waiting at the prompt, a WebSocket event
  // can resolve this to interrupt ask() and process the event.
  let resolveWsInput: ((v: string) => void) | null = null;

  process.stdout.write("\x1b[?2004h");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  display.print(display.c.sageGreen(display.hr("═")));
  display.print(display.c.skyBlue(display.s.bold("  Brunel Worker")));
  display.print(display.c.lavender(`  Worker ID: ${workerId} | Foreman: ${FOREMAN_URL}`));
  display.print(display.c.sageGreen(display.hr("═")));

  let ws: WebSocket;

  function connectWs(): void {
    ws = connectToForeman(FOREMAN_URL, workerId, currentTaskId);

    ws.on("open", () => {
      display.print(display.c.sageGreen("  Connected to foreman."));
    });

    ws.on("message", (data) => {
      let msg: ForemanMessage;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      printForemanMessage(msg);

      if (msg.type === "task_assigned") {
        currentTaskId = msg.taskId;
        currentIssue = msg.issue;
        currentSessionId = undefined;
        resolveWsInput?.(WS_TASK_ASSIGNED);
        resolveWsInput = null;
      } else if (msg.type === "event_notification") {
        pendingEvents.push(msg.event);
        resolveWsInput?.(WS_EVENT);
        resolveWsInput = null;
      }
    });

    ws.on("close", () => {
      display.print(display.c.amber("  Disconnected from foreman. Reconnecting..."));
      setTimeout(() => connectWs(), 3000);
    });

    ws.on("error", () => { /* close will fire, handled above */ });
  }

  connectWs();

  // Main worker loop
  while (true) {
    // If we have pending events after a query, process them immediately
    if (pendingEvents.length > 0 && currentTaskId && currentIssue) {
      const events = pendingEvents.splice(0);
      const prompt = buildEventPrompt(events);
      currentSessionId = await runQuery(prompt, currentSessionId);
      continue;
    }

    // Wait for next input: user stdin or WebSocket signal
    const wsAbort = new Promise<string>((resolve) => { resolveWsInput = resolve; });
    const input = await ask("\n[worker] > ", listCommandNames, wsAbort);

    // Node.js is single-threaded: the ws message handler sets currentIssue
    // synchronously before calling resolveWsInput, so currentIssue is always
    // populated by the time ask() resolves with WS_TASK_ASSIGNED.
    if (input === WS_TASK_ASSIGNED && currentIssue) {
      const prompt = buildInitialPrompt(currentIssue);
      currentSessionId = await runQuery(prompt, currentSessionId);
      continue;
    }

    if (input === WS_EVENT) {
      // pendingEvents already populated; loop will process them
      continue;
    }

    if (!input || input === "__abort__") continue;

    const action = await dispatchInput(input);
    if (action.type === "skip") continue;

    if (action.type === "exit") {
      process.stdout.write("\x1b[?2004l\r\n");
      process.stdin.setRawMode(false);
      process.stdin.pause();
      ws.close();
      break;
    }

    if (action.type === "task_complete") {
      if (currentTaskId) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "task_complete", workerId, taskId: currentTaskId }));
        }
        currentTaskId = undefined;
        currentIssue = undefined;
        currentSessionId = undefined;
        display.print(display.c.sageGreen("  Task complete. Waiting for next task..."));
      }
      continue;
    }

    if (action.type === "clear") {
      currentSessionId = undefined;
      display.print("Session cleared.");
      continue;
    }

    if (action.type === "unknown_command") {
      display.print(display.c.boldRed(`Unknown command: /${action.command}`));
      continue;
    }

    if (action.type === "query") {
      try {
        currentSessionId = await runQuery(action.prompt, currentSessionId);
      } catch (err) {
        display.print(display.c.boldRed(`\nERROR: ${err}`));
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--worker-mode")) {
    workerMain();
  } else {
    main();
  }
}
