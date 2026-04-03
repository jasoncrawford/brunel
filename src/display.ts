import type { ForemanMessage, GitHubEvent } from "./types.js";
import { shortWorkerId } from "../shared/utils.js";

// ── Display width ─────────────────────────────────────────────────────────────

export const W = 70;
export const hr = (ch = "─") => ch.repeat(W);

/** Visible width of the verbose timestamp prefix "HH:mm:ss " */
export const VERBOSE_PREFIX_LEN = 9;

/**
 * Returns the usable terminal width, accounting for the verbose timestamp
 * prefix when verbose mode is active. Pass a fallback used when
 * process.stdout.columns is unavailable.
 */
export function effectiveWidth(fallback = W): number {
  return (process.stdout.columns ?? fallback) - (verbose ? VERBOSE_PREFIX_LEN : 0);
}

// ── Verbose flag ──────────────────────────────────────────────────────────────

export let verbose = false;
export function setVerbose(v: boolean) { verbose = v; }

// ── Think-out-loud flag ───────────────────────────────────────────────────────

export let thinkOutLoud = false;
export function setThinkOutLoud(v: boolean) { thinkOutLoud = v; }

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

export function clearBreak(): string {
  const width = effectiveWidth();
  const label = "=== Context cleared ";
  const fill = "=".repeat(Math.max(0, width - label.length));
  return "\n" + c.sageGreen(s.bold(label + fill));
}

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
  const sec = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${sec}`;
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
    case "delete": {
      const refType = str(p.ref_type);
      const ref = str(p.ref);
      return `${refType} ${ref}`.trim();
    }
    case "issues": {
      const label = asObj(p.label) as { name?: string } | null;
      return label?.name ? `label: ${label.name}` : "";
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

export function toRelativePath(filePath: string): string {
  const cwd = process.cwd();
  if (filePath === cwd) return ".";
  const prefix = cwd + "/";
  if (filePath.startsWith(prefix)) return filePath.slice(prefix.length);
  return filePath;
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
  const width = effectiveWidth(80);
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
  return verbose ? t : trunc(t, 100);
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

function wrapText(text: string, width: number): string[] {
  if (width <= 0 || text.length <= width) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") {
      if (word.length > width) {
        let rest = word;
        while (rest.length > width) { lines.push(rest.slice(0, width)); rest = rest.slice(width); }
        current = rest;
      } else {
        current = word;
      }
    } else if (current.length + 1 + word.length <= width) {
      current += " " + word;
    } else {
      lines.push(current);
      if (word.length > width) {
        let rest = word;
        while (rest.length > width) { lines.push(rest.slice(0, width)); rest = rest.slice(width); }
        current = rest;
      } else {
        current = word;
      }
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

// Strips ANSI escape sequences to measure the visible length of a string.
function visLen(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// Pads a (possibly ANSI-formatted) string to `width` visible characters.
function ansiPadEnd(str: string, width: number): string {
  return str + " ".repeat(Math.max(0, width - visLen(str)));
}

// Like wrapText but measures word lengths by visible characters, so ANSI
// escape sequences in pre-formatted strings don't distort line breaks.
function wrapTextAnsi(text: string, width: number): string[] {
  if (width <= 0 || visLen(text) <= width) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  let currentLen = 0;
  for (const word of words) {
    const wl = visLen(word);
    if (currentLen === 0) {
      if (wl > width) {
        // Unlike wrapText, we don't force-split overlong words here because
        // splitting an ANSI-escaped string at a byte offset can cut mid-escape-
        // sequence and corrupt terminal output. The word is pushed unsplit and
        // will visually overflow its column. In practice this is rare: table
        // cells containing very long ANSI-styled words (e.g. a coloured URL
        // with no spaces) will be wider than their allocated column width.
        lines.push(word);
      } else {
        current = word;
        currentLen = wl;
      }
    } else if (currentLen + 1 + wl <= width) {
      current += " " + word;
      currentLen += 1 + wl;
    } else {
      lines.push(current);
      if (wl > width) {
        lines.push(word);
        current = "";
        currentLen = 0;
      } else {
        current = word;
        currentLen = wl;
      }
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

export function distributeWidths(naturalWidths: number[], available: number): number[] {
  const N = naturalWidths.length;
  if (N === 0) return [];
  const total = naturalWidths.reduce((a, b) => a + b, 0);
  if (total <= available) return [...naturalWidths];
  const allocated = new Array<number>(N).fill(0);
  const order = [...naturalWidths.keys()].sort((a, b) => naturalWidths[a] - naturalWidths[b]);
  let remaining = available;
  for (let k = 0; k < N; k++) {
    const i = order[k];
    const fairShare = Math.floor(remaining / (N - k));
    if (naturalWidths[i] <= fairShare) {
      allocated[i] = naturalWidths[i];
      remaining -= naturalWidths[i];
    } else {
      // Distribute remaining space evenly, giving +1 to the first `extra`
      // columns so no space is lost to integer rounding.
      const base = Math.floor(remaining / (N - k));
      const extra = remaining % (N - k);
      for (let j = k; j < N; j++) {
        allocated[order[j]] = base + (j - k < extra ? 1 : 0);
      }
      break;
    }
  }
  return allocated;
}

export function renderTable(tableLines: string[], maxWidth?: number): string {
  const termWidth = maxWidth ?? effectiveWidth();
  const rows = tableLines.map(line =>
    line.split("|").slice(1, -1).map(cell => cell.trim())
  );
  const isSep = (row: string[]) => row.every(cell => /^[-: ]+$/.test(cell));

  // Pre-apply inline formatting so column widths are measured in visible
  // characters, not raw markdown source (e.g. **bold** is 4 visible chars,
  // not 8 raw chars).
  const fmtRows = rows.map(row => isSep(row) ? row : row.map(mdInline));

  const dataRows = fmtRows.filter(r => !isSep(r));
  const colCount = Math.max(...dataRows.map(r => r.length));
  const naturalWidths = Array.from({ length: colCount }, (_, i) =>
    Math.max(...dataRows.map(r => visLen(r[i] ?? "")))
  );
  // overhead: "│ " (2) + " │ " * (N-1) (3*(N-1)) + " │" (2) = 1 + 3*N
  const overhead = 1 + 3 * colCount;
  const available = Math.max(termWidth - overhead, colCount);
  const widths = distributeWidths(naturalWidths, available);
  const renderRow = (row: string[]): string => {
    const wrapped = widths.map((w, i) => wrapTextAnsi(row[i] ?? "", w));
    const numLines = Math.max(...wrapped.map(ls => ls.length));
    const termRows: string[] = [];
    for (let ln = 0; ln < numLines; ln++) {
      termRows.push(
        "│ " + widths.map((w, i) => ansiPadEnd(wrapped[i][ln] ?? "", w)).join(" │ ") + " │"
      );
    }
    return termRows.join("\n");
  };
  const divider = "├─" + widths.map(w => "─".repeat(w)).join("─┼─") + "─┤";
  const out: string[] = [];
  for (const row of fmtRows) {
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
  thinking: (b) => c.gray("\n" + (thinkOutLoud ? renderMarkdown(b.thinking ?? "") : "Thinking...")),
  text:     (b) => c.yellow(`\n${renderMarkdown(b.text ?? "")}`),
  _default: (b) => c.darkGray(`[assistant/${b.type}]`),
};

export const USER_BLOCK_FMT: FmtTable = {
  text:     (b) => b._isSynthetic ? null : `\n${b.text ?? ""}`,
  _default: (b) => c.darkGray(`[user/${b.type}]`),
};

export const TOOL_CALL_FMT: FmtTable = {
  Bash:       (b) => fmtToolCall(b, `$ ${b.input?.command ?? ""}`),
  Read:       (b) => fmtToolCall(b, `• Read(${toRelativePath(b.input?.file_path ?? "?")})`),
  Write:      (b) => fmtToolCall(b, `• Write(${toRelativePath(b.input?.file_path ?? "?")})`),
  Edit:       (b) => fmtToolCall(b, `• Edit(${toRelativePath(b.input?.file_path ?? "?")})`),
  Glob:       (b) => fmtToolCall(b, `• Glob(${b.input?.pattern ?? "?"})`),
  Grep:       (b) => fmtToolCall(b, `• grep ${trunc(b.input?.pattern ?? "?", 30)} ${b.input?.path != null ? toRelativePath(b.input.path as string) : "."}`),
  Skill:      (b) => fmtToolCall(b, `• Skill(${b.input?.skill ?? "?"})`),
  Agent:      (b) => fmtToolCall(b, `• ${b.input?.subagent_type ?? "Agent"}(${trunc(b.input?.prompt ?? "", 80)})`),
  ToolSearch: (b) => fmtToolCall(b, `• ToolSearch(${b.input?.query ?? "?"})`),
  TodoWrite:  (b) => fmtToolCall(b, `• TodoWrite(${fmtTodoWriteInput(b.input?.todos)})`),
  AskUserQuestion: (b) => fmtToolCall(b, `• AskUserQuestion(${fmtAskUserQuestionInput(b.input?.questions)})`),
  _default:   (b) => fmtToolCall(b, `• ${b.name}(${fmtArgs(b.input)})`),
};

export const TOOL_RESULT_FMT: FmtTable = {
  _default:   (b) => c.darkGray(`→ ${verbose ? toolResultText(b) : trunc(toolResultText(b), 100)}`),
  Read:       (b) => c.darkGray(`→ ${fmtCount(toolResultText(b).split("\n").length, "line")}`),
  Edit:       (b) => fmtEditResult(b),
  Skill:      (b) => c.darkGray(`→ Loaded skill`),
  Bash:       (b) => c.darkGray(`→ ${fmtBashOutput(toolResultText(b))}`),
  Write:      (b) => c.darkGray(`→ ${fmtWriteOutput(b)}`),
  ToolSearch: (b) => c.darkGray(`→ ${fmtToolSearchOutput(b.content)}`),
  TodoWrite:  (b) => c.darkGray(`→ ${fmtTodoWriteOutput(b)}`),
};

export const TOOL_ERROR_FMT: FmtTable = {
  AskUserQuestion: (b) => c.darkGray(`→ ${toolResultText(b)}`),
  _default:        (b) => c.salmon(`! ${toolResultText(b)}`),
};

function fmtCompactionDetail(meta: unknown): string {
  const m = meta as { trigger?: string; pre_tokens?: number } | undefined;
  const trigger = m?.trigger ?? "auto";
  const tokens = m?.pre_tokens;
  return tokens != null ? `${trigger}, ${fmtNum(tokens)} tokens` : trigger;
}

function fmtHookExitCode(exitCode: number | undefined): string {
  return exitCode != null && exitCode !== 0 ? ` [exit ${exitCode}]` : "";
}

function fmtRateLimitInfo(info: { status?: string; utilization?: number; rateLimitType?: string }): string {
  const parts: string[] = [`rate limit: ${info.status}`];
  if (info.rateLimitType) parts.push(info.rateLimitType);
  if (info.utilization != null) parts.push(`${Math.round(info.utilization * 100)}% used`);
  return parts.join(", ");
}

function fmtApiRetryDetail(m: { error_status?: number | null; error?: string }): string {
  if (m.error_status != null) return ` (${m.error_status})`;
  if (m.error && m.error !== "unknown") return ` (${m.error})`;
  return "";
}

export const SYSTEM_FMT: FmtTable = {
  init:              { verbose: (m) => c.darkGray(`init: session ${m.session_id}`) },
  task_started:      (m) => c.lavender(`  ▶ agent started: ${m.description}`),
  task_progress:     (m) => c.lavender(`  • ${m.description}`),
  task_notification: (m) => c.lavender(`  ◀︎ ${m.status}: ${m.summary}`),
  compact_boundary:  (m) => c.darkGray(`↩ Context compacted (${fmtCompactionDetail(m.compact_metadata)})`),
  status:            (m) => m.status === "compacting" ? c.darkGray("Compacting context...") : null,
  api_retry:         (m) => c.amber(`API failure${fmtApiRetryDetail(m)}, retrying in ${(m.retry_delay_ms / 1000).toFixed(1).replace(/\.0$/, "")}s (attempt ${m.attempt}/${m.max_retries})`),
  hook_started:      { verbose: (m) => c.darkGray(`hook: ${m.hook_name} (${m.hook_event})`) },
  hook_response:     { verbose: (m) => c.darkGray(`hook: ${m.hook_name} — ${m.outcome}${fmtHookExitCode(m.exit_code)}`) },
  _default:          { verbose: (m) => c.darkGray(`system/${m.subtype}`) },
};

export const MESSAGE_FMT: FmtTable = {
  _empty:           (m) => c.darkGray(`[${m.type} — empty]`),
  result:           (m) => c.darkGray(`\n${fmtStats(Math.round(m.duration_ms / 1000), m.num_turns, m.usage.output_tokens, m.usage.input_tokens)}`),
  rate_limit_event: { verbose: (m) => {
    const info = m.rate_limit_info;
    if (!info || info.status === "allowed") return null;
    return c.amber(fmtRateLimitInfo(info));
  }},
  _default:         (m) => c.darkGray(`msg: ${m.type}`),
};

export const FOREMAN_MESSAGE_FMT: FmtTable = {
  task_assigned:      { verbose: (m) => c.darkGray(`Task assigned: #${m.issue.number}, ${m.issue.title}`) },
  event_notification: { verbose: (m) => c.darkGray(`Event received [${fmtTime()}]: ${fmtEvent(m.event as GitHubEvent)}`) },
  hello_ack:          { verbose: (m) => c.darkGray(`hello_ack: ${m.status}`) },
  _default:           (m) => c.darkGray(`Unknown foreman message: ${m.type}`),
};

// ── Worker status bar formatting ──────────────────────────────────────────────

export interface WorkerStatusOpts {
  workerId: string;
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
  const { workerId, taskNumber, prNumber, branch, connectionStatus, disconnectCode, retryInSeconds } = opts;
  const width = (opts.width ?? (process.stdout.columns ?? W)) - 1; // -1 to avoid last-column wrap

  // Right side: connection status
  const codeStr = verbose && disconnectCode != null ? ` (${disconnectCode})` : "";
  const rightText =
    connectionStatus === "connected"    ? "Connected" :
    connectionStatus === "handshaking"  ? "Handshaking..." :
    connectionStatus === "reconnecting" ? "Reconnecting..." :
    retryInSeconds != null              ? `Disconnected${codeStr}. Retrying in ${retryInSeconds}s` :
                                          `Disconnected${codeStr}`;

  // Left side: worker {id8} ∙ {task info}
  const parts: string[] = [`worker ${shortWorkerId(workerId)}`];
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
  // Dim sage-green background + bright-white text. No trailing reset: _drawStatus
  // appends \x1b[K (fills remaining width with the same background) then \x1b[0m.
  return `\x1b[48;5;22m\x1b[97m${leftText + " ".repeat(gap) + rightText}`;
}

// ── Printing engine ───────────────────────────────────────────────────────────

let _statusText = "";
export let _statusActive = false;
let _statusInterval: ReturnType<typeof setInterval> | null = null;

// Persistent (worker) status bar — drawn below the primary status line.
// Unlike the primary status this stays active between queries.
let _persistentStatusText = "";
export let _persistentStatusActive = false;
let _persistentGetText: (() => string) | null = null;

// Callback invoked when a tool_result block is printed, i.e. immediately after
// a tool has finished running. Used by the worker to refresh the git branch in
// the status bar after each Bash invocation.
let _onToolResultCallback: ((toolName: string) => void) | null = null;

export function setOnToolResultCallback(fn: ((toolName: string) => void) | null): void {
  _onToolResultCallback = fn;
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
// current buffer position.  ask() registers a handler that navigates back to
// the prompt line (using the known cursor row) and calls fullRedraw(), so the
// status bars are redrawn without misplacing them inside the buffer area.
let _inputStatusCallback: (() => void) | null = null;
export function setInputStatusCallback(fn: (() => void) | null) {
  _inputStatusCallback = fn;
}

// Callback invoked by print() BEFORE console.log to clear the prompt area.
// When the prompt string has a leading \n (blank-line prefix), the clear must
// also erase that blank line; otherwise it is orphaned above the printed
// message as a "random" blank line (issue #418).
let _inputClearCallback: (() => void) | null = null;
export function setInputClearCallback(fn: (() => void) | null) {
  _inputClearCallback = fn;
}

/** Number of active status lines (primary + persistent). */
function _lineCount(): number {
  const n = (_statusActive ? 1 : 0) + (_persistentStatusActive ? 1 : 0);
  return n === 2 ? 3 : n; // blank separator between the two bars when both are active
}
function _clearStatus() {
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

function _drawStatus() {
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
 * the desired blank-separator position).  Writes a blank separator row then
 * the active bar rows.  Returns the total number of extra rows written
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

export function startStatus(getText: () => string) {
  _clearStatus();
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
  // Redraw the persistent line (if any) now that the primary line is gone.
  _drawStatus();
}

// Shows a status bar that redraws only when updatePersistentStatus() is called.
// Used for state that changes on discrete events (e.g. task assigned, PR
// opened, connection status changed) rather than continuously over time.
// Contrast with startStatus(), which polls getText() every 500ms — appropriate
// for the query status line where elapsed time advances even without events.
export function startPersistentStatus(getText: () => string): void {
  _clearStatus();
  _persistentStatusActive = true;
  _persistentGetText = getText;
  _persistentStatusText = getText();
  _drawStatus();
}

export function stopPersistentStatus(): void {
  _clearStatus();
  _persistentStatusActive = false;
  _persistentGetText = null;
  _persistentStatusText = "";
  // Redraw primary status if still active.
  _drawStatus();
}

/** Refresh the persistent status line text and redraw. */
export function updatePersistentStatus(): void {
  if (!_persistentStatusActive || !_persistentGetText) return;
  _clearStatus();
  _persistentStatusText = _persistentGetText();
  _drawStatus();
}

function printLine(line: string): void {
  if (verbose) {
    const ts = `\x1b[90m${fmtTime()} \x1b[39m`;
    const parts = line.split("\n");
    const openColor = (line.match(/^(\x1b\[[0-9;]*m)+/) ?? [""])[0];
    console.log(parts.map((p, i) => ts + (i > 0 ? openColor : "") + p).join("\n"));
  } else {
    console.log(line);
  }
}

export function print(line: string | null) {
  if (line === null) return;
  if (_inputPrintCallback) {
    // ask() is active: erase from current cursor position to end of screen
    // (clears the prompt, suggestion row, and status bars), write the new
    // content line, then let drawFresh redraw the prompt + status bars below.
    // If the prompt has a leading \n prefix (blank line above the prompt),
    // _inputClearCallback goes up to also erase that blank line first so it
    // is not orphaned above the printed message (issue #418).
    if (_inputClearCallback) {
      _inputClearCallback();
    } else {
      process.stdout.write("\r\x1b[J");
    }
    printLine(line);
    _inputPrintCallback();
    return;
  }
  _clearStatus();
  printLine(line);
  _drawStatus();
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
    // Fire after the tool result is printed — tool has just finished running.
    _onToolResultCallback?.(name);
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

// ── Working verb ───────────────────────────────────────────────────────────────

export const WORKING_VERBS = [
  "Building",
  "Constructing",
  "Surveying",
  "Drafting",
  "Engineering",
  "Excavating",
  "Framing",
  "Grading",
  "Laying foundations",
  "Paving",
  "Scaffolding",
  "Welding",
  "Wiring",
  "Plumbing",
  "Blueprinting",
  "Pouring concrete",
  "Raising beams",
  "Riveting",
  "Hoisting",
  "Bolting",
];

export function pickWorkingVerb(): string {
  return WORKING_VERBS[Math.floor(Math.random() * WORKING_VERBS.length)];
}
