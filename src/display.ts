import type { ForemanMessage, GitHubEvent } from "./types.js";

// ── Display width ─────────────────────────────────────────────────────────────

export const W = 70;
export const hr = (ch = "─") => ch.repeat(W);

// ── Verbose flag ──────────────────────────────────────────────────────────────

export let verbose = false;
export function setVerbose(v: boolean) { verbose = v; }

// ── Colors ────────────────────────────────────────────────────────────────────

export const c = {
  skyBlue:   (s: string) => `\x1b[38;5;117m${s}\x1b[0m`,
  gray:      (s: string) => `\x1b[38;5;246m${s}\x1b[0m`,
  amber:     (s: string) => `\x1b[38;5;214m${s}\x1b[0m`,
  sageGreen: (s: string) => `\x1b[38;5;150m${s}\x1b[0m`,
  salmon:    (s: string) => `\x1b[38;5;203m${s}\x1b[0m`,
  boldRed:   (s: string) => `\x1b[1;31m${s}\x1b[0m`,
  darkGray:  (s: string) => `\x1b[90m${s}\x1b[0m`,
  yellow:    (s: string) => `\x1b[38;5;221m${s}\x1b[0m`,
  lavender:  (s: string) => `\x1b[38;5;183m${s}\x1b[0m`,
  bgGreen:   (s: string) => `\x1b[48;5;22m${s}\x1b[49m`,
  bgRed:     (s: string) => `\x1b[48;5;52m${s}\x1b[49m`,
};

export const s = {
  bold:          (s: string) => `\x1b[1m${s}\x1b[22m`,
  dim:           (s: string) => `\x1b[2m${s}\x1b[22m`,
  italic:        (s: string) => `\x1b[3m${s}\x1b[23m`,
  underline:     (s: string) => `\x1b[4m${s}\x1b[24m`,
  strikethrough: (s: string) => `\x1b[9m${s}\x1b[29m`,
};

// ── Content block types ───────────────────────────────────────────────────────

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  is_error?: boolean;
  content: string | Array<{ type: string; text?: string; tool_name?: string }>;
  _msg?: { tool_use_result?: { structuredPatch?: Hunk[] } };
}

export type ContentBlock =
  | ToolUseBlock
  | ToolResultBlock
  | { type: "text"; text?: string; _isSynthetic?: boolean }
  | { type: "thinking"; thinking?: string }
  | { type: string };

// ── Formatting helpers ────────────────────────────────────────────────────────

export function trunc(str: string, n = 80) {
  str = str.replace(/\s+/g, " ").trim();
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

export function fmtCount(count: number, singular_noun: string, plural_noun?: string) {
  const noun = (count === 1) ? singular_noun : (plural_noun ?? `${singular_noun}s`);
  return `${count} ${noun}`;
}

export function fmtTimestamp(): string {
  return new Date().toISOString();
}

export function fmtTime(): string {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

interface CheckRun { name: string; conclusion: string | null; status: string }
interface CheckSuite { conclusion: string | null; status: string }
interface Comment { body: string }
interface Review { state: string; body: string }
interface PullRequest { number: number; title: string }
interface WorkflowRun { name: string; conclusion: string | null; status: string }

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string { return typeof v === "string" ? v : ""; }
function num(v: unknown): number { return typeof v === "number" ? v : 0; }

export function fmtEventDetails(event: GitHubEvent): string {
  const p = event.payload;
  switch (event.name) {
    case "check_run": {
      const run = asObj(p.check_run) as CheckRun | null;
      if (!run) return "";
      const status = str(run.conclusion || run.status);
      return `"${str(run.name)}" ${status}`.trim();
    }
    case "check_suite": {
      const suite = asObj(p.check_suite) as CheckSuite | null;
      if (!suite) return "";
      return str(suite.conclusion || suite.status).trim();
    }
    case "issue_comment":
    case "pull_request_review_comment": {
      const comment = asObj(p.comment) as Comment | null;
      return comment?.body ? `"${trunc(str(comment.body), 60)}"` : "";
    }
    case "pull_request_review": {
      const review = asObj(p.review) as Review | null;
      if (!review) return "";
      const parts: string[] = [str(review.state)];
      if (review.body) parts.push(`"${trunc(str(review.body), 40)}"`);
      return parts.filter(Boolean).join(" ");
    }
    case "pull_request": {
      const pr = asObj(p.pull_request) as PullRequest | null;
      if (!pr) return "";
      return `#${num(pr.number)} "${trunc(str(pr.title), 50)}"`;
    }
    case "push": {
      const commits = Array.isArray(p.commits) ? p.commits : [];
      return `${commits.length} commit${commits.length === 1 ? "" : "s"} to ${str(p.ref) || "?"}`;
    }
    case "workflow_run": {
      const run = asObj(p.workflow_run) as WorkflowRun | null;
      if (!run) return "";
      const status = str(run.conclusion || run.status);
      return `"${str(run.name)}" ${status}`.trim();
    }
    default:
      return "";
  }
}

export function fmtEvent(event: GitHubEvent): string {
  const nameAction = `${event.name}${event.payload["action"] ? `/${event.payload["action"]}` : ""}`;
  const details = fmtEventDetails(event);
  return `${nameAction}${details ? ` — ${details}` : ""}`;
}

export function fmtDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m${s}s`;
}

export function fmtNum(n: number): string {
  if (n >= 1000) return `${parseFloat((n / 1000).toPrecision(3))}k`;
  return `${n}`;
}

export function fmtStats(secs: number, turns?: number, outputTokens?: number, inputTokens?: number): string {
  const parts: string[] = [fmtDuration(secs)];
  if (turns) parts.push(fmtCount(turns, "turn"));
  if (outputTokens) {
    const tok = inputTokens != null ? `tokens: ${fmtNum(inputTokens)} in / ${fmtNum(outputTokens)} out` : `tokens: ${fmtNum(outputTokens)} out`;
    parts.push(tok);
  }
  return parts.join(", ");
}

export function fmtArgs(input: Record<string, unknown>, maxVal = 50): string {
  return Object.entries(input ?? {})
    .map(([k, v]) => `${k}=${trunc(String(v), maxVal)}`)
    .join(", ");
}

export function fmtToolCall(b: ToolUseBlock, fmt: string) {
  fmt = c.skyBlue(`\n${fmt}`);
  if (b.input?.description) fmt += c.gray(` # ${b.input.description}`);
  return fmt;
}

export function fmtHunk(hunk: Hunk): string {
  const header = c.darkGray(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
  const width = process.stdout.columns ?? 80;
  const lines = hunk.lines.map(line => {
    if (line.startsWith("+")) return c.bgGreen(line.padEnd(width));
    if (line.startsWith("-")) return c.bgRed(line.padEnd(width));
    return c.darkGray(line);
  });
  return [header, ...lines].join("\n");
}

export function fmtEditResult(b: ToolResultBlock) {
  const patch = b._msg?.tool_use_result?.structuredPatch;
  if (patch && patch.length > 0) return patch.map(fmtHunk).join("\n");
  return c.darkGray(`→ ${trunc(toolResultText(b), 100)}`);
}

export function fmtBashOutput(text: string): string {
  const t = text.trim();
  if (!t || t === "(Bash completed with no output)") return "Success";
  return trunc(t, 100);
}

export function fmtWriteOutput(b: ToolResultBlock & { _input?: Record<string, unknown> }): string {
  const content = b._input?.content as string | undefined;
  if (content == null) return trunc(toolResultText(b), 100);
  const lines = content.split("\n").length;
  const verb = /created/i.test(toolResultText(b)) ? "Created" : "Updated";
  return `${verb} ${fmtCount(lines, "line")}`;
}

export function fmtTodoWriteInput(todos: unknown): string {
  const items = Array.isArray(todos) ? todos : [];
  return fmtCount(items.length, "todo");
}

export function fmtAskUserQuestionInput(questions: unknown): string {
  const items = Array.isArray(questions) ? questions as Array<{question: string}> : [];
  return items.map((q) => `"${q.question}"`).join(", ");
}

export function fmtToolSearchOutput(content: unknown): string {
  const items = Array.isArray(content) ? content : [];
  const names = items
    .filter((x): x is { type: string; tool_name?: string } =>
      x != null && typeof x === "object" && (x as { type: string }).type === "tool_reference")
    .map((x) => x.tool_name)
    .filter(Boolean)
    .join(", ");
  return `loaded: ${names || "?"}`;
}

export function fmtTodoWriteOutput(b: ToolResultBlock): string {
  const newTodos = (b._msg?.tool_use_result as Record<string, unknown> | undefined)?.newTodos;
  const todos = Array.isArray(newTodos) ? newTodos : null;
  if (!todos) return trunc(toolResultText(b), 100);
  if (!todos.length) return "todos cleared";
  return todos.map((t, i) => {
    const todo = t as { status?: string; content?: string };
    const status = todo.status ?? "pending";
    const content = trunc(String(todo.content ?? ""), 60);
    const marker = status === "completed" ? "[✓]" : status === "in_progress" ? "[►]" : "[ ]";
    return `${i > 0 ? "  " : ""}${marker} ${content}`;
  }).join("\n");
}

export function toolResultText(b: { content: unknown }): string {
  const raw = b.content;
  if (typeof raw === "string") return raw;
  const items = Array.isArray(raw) ? raw : [raw];
  return items
    .map((x) => {
      if (x != null && typeof x === "object" && "type" in x) {
        const item = x as { type: string; text?: string; tool_name?: string };
        if (item.type === "text") return item.text ?? "";
        if (item.type === "tool_reference") return `[tool:${item.tool_name}]`;
        return `[${item.type}]`;
      }
      return "[?]";
    })
    .join(" ");
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

export function mdInline(text: string): string {
  text = text.replace(/\*\*(.+?)\*\*/gs,  (_, t) => s.bold(t));
  text = text.replace(/__(.+?)__/gs,      (_, t) => s.bold(t));
  text = text.replace(/`([^`]+)`/g,       (_, t) => s.bold(s.underline(t)));
  return text;
}

export function renderTable(tableLines: string[]): string {
  const rows = tableLines.map(line =>
    line.split("|").slice(1, -1).map(cell => cell.trim())
  );
  const isSep = (row: string[]) => row.every(cell => /^[-: ]+$/.test(cell));
  const dataRows = rows.filter(r => !isSep(r));
  const colCount = Math.max(...dataRows.map(r => r.length));
  const widths = Array.from({ length: colCount }, (_, i) =>
    Math.max(...dataRows.map(r => (r[i] ?? "").length))
  );
  const renderRow = (row: string[]) =>
    "│ " + widths.map((w, i) => mdInline((row[i] ?? "").padEnd(w))).join(" │ ") + " │";
  const divider = "├─" + widths.map(w => "─".repeat(w)).join("─┼─") + "─┤";
  const out: string[] = [];
  for (const row of rows) {
    if (isSep(row)) { out.push(divider); continue; }
    out.push(renderRow(row));
  }
  return out.join("\n");
}

export function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inCode = false;
  const codeLines: string[] = [];
  let tableLines: string[] = [];

  function flushTable() {
    if (tableLines.length) { out.push(renderTable(tableLines)); tableLines = []; }
  }

  for (const line of lines) {
    if (line.startsWith("```")) {
      flushTable();
      if (!inCode) { inCode = true; codeLines.length = 0; }
      else         { inCode = false; out.push(codeLines.map(l => "  " + l).join("\n")); }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }

    if (line.trimStart().startsWith("|")) { tableLines.push(line); continue; }
    flushTable();

    if (/^[-*_]{3,}\s*$/.test(line)) { out.push("─".repeat(W)); continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)/);
    if (heading) {
      const text = mdInline(heading[2]);
      out.push(s.bold(heading[1] === "#" ? text.toUpperCase() : text));
      continue;
    }

    if (line.startsWith("> ")) { out.push("▏ " + mdInline(line.slice(2))); continue; }

    const li = line.match(/^(\s*)[-*+]\s+(.*)/);
    if (li) { out.push(li[1] + "• " + mdInline(li[2])); continue; }

    const oli = line.match(/^(\s*)(\d+)\.\s+(.*)/);
    if (oli) { out.push(oli[1] + oli[2] + ". " + mdInline(oli[3])); continue; }

    out.push(mdInline(line));
  }

  if (inCode && codeLines.length) out.push(codeLines.map(l => "  " + l).join("\n"));
  flushTable();
  return out.join("\n");
}

// ── FORMATS ───────────────────────────────────────────────────────────────────

// FmtTable is a mixed-type dispatch table: each entry receives a different
// runtime-typed value, so `any` is intentional here rather than `unknown`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Fmt = (data: any) => string | null;
export type FmtEntry = Fmt | { quiet?: Fmt; verbose?: Fmt };
export type FmtTable = Record<string, FmtEntry>;

export const ASSISTANT_BLOCK_FMT: FmtTable = {
  thinking: (b) => c.gray(`\n${renderMarkdown(b.thinking ?? "")}`),
  text:     (b) => c.yellow(`\n${renderMarkdown(b.text ?? "")}`),
  _default: (b) => c.darkGray(`[assistant/${b.type}]`),
};

export const USER_BLOCK_FMT: FmtTable = {
  text:     (b) => b._isSynthetic
    ? c.darkGray(`\n${trunc(b.text ?? "", 100)}`)
    : `\n${b.text ?? ""}`,
  _default: (b) => c.darkGray(`[user/${b.type}]`),
};

export const TOOL_CALL_FMT: FmtTable = {
  Bash:       (b) => fmtToolCall(b, `$ ${trunc(b.input?.command ?? "", 80)}`),
  Read:       (b) => fmtToolCall(b, `• Read(${b.input?.file_path ?? "?"})`),
  Write:      (b) => fmtToolCall(b, `• Write(${b.input?.file_path ?? "?"})`),
  Edit:       (b) => fmtToolCall(b, `• Edit(${b.input?.file_path ?? "?"})`),
  Glob:       (b) => fmtToolCall(b, `• Glob(${b.input?.pattern ?? "?"})`),
  Grep:       (b) => fmtToolCall(b, `• grep ${trunc(b.input?.pattern ?? "?", 30)} ${b.input?.path ?? "."}`),
  Skill:      (b) => fmtToolCall(b, `• Skill(${b.input?.skill ?? "?"})`),
  Agent:      (b) => fmtToolCall(b, `• ${b.input?.subagent_type ?? "Agent"}(${trunc(b.input?.prompt ?? "", 80)})`),
  ToolSearch: (b) => fmtToolCall(b, `• ToolSearch(${b.input?.query ?? "?"})`),
  TodoWrite:  (b) => fmtToolCall(b, `• TodoWrite(${fmtTodoWriteInput(b.input?.todos)})`),
  AskUserQuestion: (b) => fmtToolCall(b, `• AskUserQuestion(${fmtAskUserQuestionInput(b.input?.questions)})`),
  _default:   (b) => fmtToolCall(b, `• ${b.name}(${fmtArgs(b.input)})`),
};

export const TOOL_RESULT_FMT: FmtTable = {
  _default:   (b) => c.darkGray(`→ ${trunc(toolResultText(b), 100)}`),
  Read:       (b) => c.darkGray(`→ ${fmtCount(toolResultText(b).split("\n").length, "line")}`),
  Edit:       (b) => fmtEditResult(b),
  Skill:      (b) => c.darkGray(`→ Loaded skill`),
  Bash:       (b) => c.darkGray(`→ ${fmtBashOutput(toolResultText(b))}`),
  Write:      (b) => c.darkGray(`→ ${fmtWriteOutput(b)}`),
  ToolSearch: (b) => c.darkGray(`→ ${fmtToolSearchOutput(b.content)}`),
  TodoWrite:  (b) => c.darkGray(`→ ${fmtTodoWriteOutput(b)}`),
};

export const TOOL_ERROR_FMT: FmtTable = {
  AskUserQuestion: (b) => c.darkGray(`→ ${trunc(toolResultText(b), 100)}`),
  _default:        (b) => c.salmon(`! ${trunc(toolResultText(b), 100)}`),
};

export const SYSTEM_FMT: FmtTable = {
  init:              { verbose: (m) => c.darkGray(`session: ${m.session_id}`) },
  task_started:      (m) => c.lavender(`  ▶ agent started: ${m.description}`),
  task_progress:     (m) => c.lavender(`  • ${m.description}`),
  task_notification: (m) => c.lavender(`  ◀︎ ${m.status}: ${m.summary}`),
  _default:          { verbose: (m) => c.darkGray(`system/${m.subtype}`) },
};

export const MESSAGE_FMT: FmtTable = {
  _empty:           (m) => c.darkGray(`[${m.type} — empty]`),
  result:           (m) => c.darkGray(`\n${fmtStats(Math.round(m.duration_ms / 1000), m.num_turns, m.usage.output_tokens, m.usage.input_tokens)}`),
  rate_limit_event: { verbose: (m) => c.darkGray(`rate limit: status=${m.rate_limit_info?.status ?? "?"}`) },
  _default:         (m) => c.darkGray(`msg: ${m.type}`),
};

export const FOREMAN_MESSAGE_FMT: FmtTable = {
  task_assigned:      (m) => c.lavender(`Task assigned: #${m.issue.number}, ${m.issue.title}`),
  event_notification: (m) => c.darkGray(`Event received [${fmtTime()}]: ${fmtEvent(m.event as GitHubEvent)}`),
  standby:            (m) => c.darkGray("Standby: waiting for tasks..."),
  _default:           (m) => c.darkGray(`Unknown foreman message: ${m.type}`),
};

// ── Printing engine ───────────────────────────────────────────────────────────

let _statusText = "";
export let _statusActive = false;
let _statusInterval: ReturnType<typeof setInterval> | null = null;

// Callback invoked after print() writes output, so the input layer can redraw
// the prompt (needed in worker mode when WebSocket messages arrive during ask()).
let _inputPrintCallback: (() => void) | null = null;
export function setInputPrintCallback(fn: (() => void) | null) {
  _inputPrintCallback = fn;
}

export function getInputPrintCallback(): (() => void) | null {
  return _inputPrintCallback;
}

function _clearStatus() {
  if (!_statusActive) return;
  process.stdout.write("\r\x1b[K\x1b[A\x1b[K");
}

function _drawStatus() {
  if (!_statusActive) return;
  process.stdout.write("\n\r" + _statusText + "\x1b[K");
}

export function startStatus(getText: () => string) {
  _statusActive = true;
  _statusText = getText();
  _drawStatus();
  _statusInterval = setInterval(() => {
    _clearStatus();
    _statusText = getText();
    _drawStatus();
  }, 500);
}

export function stopStatus() {
  if (_statusInterval) { clearInterval(_statusInterval); _statusInterval = null; }
  _clearStatus();
  _statusActive = false;
  _statusText = "";
}

export function print(line: string | null) {
  if (line === null) return;
  _clearStatus();
  // If ask() is waiting with a visible prompt, erase the prompt line before
  // printing so the message appears on a clean line (not appended to the
  // prompt). The prompt is then redrawn below via _inputPrintCallback.
  if (_inputPrintCallback) process.stdout.write("\r\x1b[K");
  console.log(line);
  _drawStatus();
  // Only redraw the input prompt when no query is running. During a query the
  // status bar is active; calling drawFresh() then would interleave the prompt
  // with query output and corrupt the display (causing double-spacing and
  // swallowed output). ask() re-registers the callback on each new call, so
  // prompt-redrawing after background notifications still works between runs.
  if (!_statusActive) _inputPrintCallback?.();
}

export function resolve(table: FmtTable, key: string, data: unknown): string | null {
  const entry = table[key] ?? table._default;
  if (!entry) return null;
  if (typeof entry === "function") return entry(data);
  const fmt = verbose ? entry.verbose : entry.quiet;
  return fmt ? fmt(data) : null;
}

export const toolUseNames = new Map<string, string>();
export const toolUseInputs = new Map<string, Record<string, unknown>>();

export function printBlock(b: ContentBlock, role: "assistant" | "user", msg?: Record<string, unknown>) {
  if (b.type === "tool_use") {
    // Safe cast: we checked b.type === "tool_use" at runtime
    const tu = b as ToolUseBlock;
    toolUseNames.set(tu.id, tu.name);
    toolUseInputs.set(tu.id, tu.input);
    print(resolve(TOOL_CALL_FMT, tu.name, tu));
    return;
  }
  if (b.type === "tool_result") {
    // Safe cast: we checked b.type === "tool_result" at runtime
    const tr = b as ToolResultBlock;
    const name = toolUseNames.get(tr.tool_use_id) ?? "";
    const _input = toolUseInputs.get(tr.tool_use_id);
    print(resolve(tr.is_error ? TOOL_ERROR_FMT : TOOL_RESULT_FMT, name, { ...tr, _msg: msg, _input }));
    return;
  }
  const blockFmt = role === "assistant" ? ASSISTANT_BLOCK_FMT : USER_BLOCK_FMT;
  print(resolve(blockFmt, b.type, { ...b, _isSynthetic: msg?.isSynthetic ?? false }));
}

export function printMessage(msg: unknown) {
  if (msg === null || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;

  if (m.parent_tool_use_id != null) return;

  if (m.type === "system") {
    const subtype = typeof m.subtype === "string" ? m.subtype : "_default";
    print(resolve(SYSTEM_FMT, subtype, m));
    return;
  }

  if (m.type === "assistant" || m.type === "user") {
    const role = m.type as "assistant" | "user";
    const message = m.message as { content?: ContentBlock[] } | undefined;
    const content = message?.content ?? [];
    if (!content.length) { print(resolve(MESSAGE_FMT, "_empty", m)); return; }
    for (const b of content) printBlock(b, role, m);
    return;
  }

  const type = typeof m.type === "string" ? m.type : "_default";
  print(resolve(MESSAGE_FMT, type, m));
}


export function printForemanMessage(msg: ForemanMessage) {
  print(resolve(FOREMAN_MESSAGE_FMT, msg.type, msg));
}
