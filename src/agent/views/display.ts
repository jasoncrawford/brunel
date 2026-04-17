import * as Wire from "../../../shared/wire.js";
import { statusBar } from "./status-bar.js";
import { getConfig } from "../../config.js";
import type { BrunelConfig } from "../../config.js";

// ── Display width ─────────────────────────────────────────────────────────────

export const W = 70;
export const hr = (ch = "─") => ch.repeat(W);

/** Visible width of the verbose timestamp prefix "HH:mm:ss " */
export const VERBOSE_PREFIX_LEN = 9;

/**
 * Returns the usable terminal width, accounting for the verbose timestamp
 * prefix when verbose mode is active. Pass a fallback used when
 * process.stdout.columns is unavailable.
 *
 * Standalone version — uses getConfig(). The Display class has an equivalent
 * instance method that uses injected config.
 */
export function effectiveWidth(fallback = W): number {
  return (process.stdout.columns ?? fallback) - (getConfig().verbose ? VERBOSE_PREFIX_LEN : 0);
}

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

export function fmtEventDetails(event: Wire.WebhookEvent): string {
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

export function fmtEvent(event: Wire.WebhookEvent): string {
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
  return getConfig().verbose ? t : trunc(t, 100);
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
  thinking: (b) => c.gray("\n" + (getConfig().thinkOutLoud ? renderMarkdown(b.thinking ?? "") : "Thinking...")),
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
  _default:   (b) => c.darkGray(`→ ${getConfig().verbose ? toolResultText(b) : trunc(toolResultText(b), 100)}`),
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

const RATE_LIMIT_TYPE_LABELS: Record<string, string> = {
  five_hour:       "five-hour",
  seven_day:       "seven-day",
  seven_day_opus:  "seven-day Opus",
  seven_day_sonnet: "seven-day Sonnet",
  overage:         "overage",
};

function fmtRateLimitInfo(info: { status?: string; utilization?: number; rateLimitType?: string }): string {
  const typeLabel = info.rateLimitType ? (RATE_LIMIT_TYPE_LABELS[info.rateLimitType] ?? info.rateLimitType) : null;

  if (info.status === "allowed_warning") {
    if (info.utilization != null && typeLabel) {
      return `Usage warning: ${Math.round(info.utilization * 100)}% of ${typeLabel} usage limit`;
    } else if (info.utilization != null) {
      return `Usage warning: ${Math.round(info.utilization * 100)}% used`;
    } else if (typeLabel) {
      return `Usage warning: ${typeLabel} usage limit`;
    }
    return "Usage warning";
  }

  if (info.status === "rejected") {
    if (typeLabel) return `Usage limit reached: ${typeLabel} usage limit`;
    return "Usage limit reached";
  }

  // Fallback for unknown statuses
  const parts: string[] = [`Usage: ${info.status}`];
  if (typeLabel) parts.push(typeLabel);
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
  rate_limit_event: (m) => {
    const info = m.rate_limit_info;
    if (!info || info.status === "allowed") return null;
    return c.amber(fmtRateLimitInfo(info));
  },
  _default:         (m) => c.darkGray(`msg: ${m.type}`),
};

export const FOREMAN_MESSAGE_FMT: FmtTable = {
  task_assigned:      { verbose: (m) => c.darkGray(`Task assigned: #${m.issue.number}, ${m.issue.title}`) },
  event_notification: { verbose: (m) => c.darkGray(`Event received [${fmtTime()}]: ${fmtEvent(m.event as Wire.WebhookEvent)}`) },
  hello_ack:          { verbose: (m) => c.darkGray(`hello_ack: ${m.status}`) },
  foreman_error:      (m) => c.boldRed(`[foreman error] ${m.message}`),
  _default:           (m) => c.darkGray(`Unknown foreman message: ${m.type}`),
};

// ── Display class ─────────────────────────────────────────────────────────────

/**
 * View class for terminal rendering. Receives config in its constructor so
 * config is injected rather than globally accessed.
 *
 * Use `display.print(line)`, `display.printMessage(msg)`, etc. for output.
 * Use the module-level `c`, `s`, and formatting functions for pure utilities.
 */
export class Display {
  /** The color object, exposed as an instance property for convenience. */
  readonly c = c;
  /** The style object, exposed as an instance property for convenience. */
  readonly s = s;

  private readonly _toolUseNames = new Map<string, string>();
  private readonly _toolUseInputs = new Map<string, Record<string, unknown>>();

  constructor(readonly config: BrunelConfig) {}

  /** Public accessor for tests to clear tool-use state between tests. */
  get toolUseNames(): Map<string, string> { return this._toolUseNames; }

  /** Returns the usable terminal width, adjusted for verbose timestamp prefix. */
  effectiveWidth(fallback = W): number {
    return (process.stdout.columns ?? fallback) - (this.config.verbose ? VERBOSE_PREFIX_LEN : 0);
  }

  /**
   * Resolve a format table entry for the given key.
   * Uses this.config.verbose to select between verbose/quiet variants.
   */
  resolve(table: FmtTable, key: string, data: unknown): string | null {
    const entry = table[key] ?? table._default;
    if (!entry) return null;
    if (typeof entry === "function") return entry(data);
    const fmt = this.config.verbose ? entry.verbose : entry.quiet;
    return fmt ? fmt(data) : null;
  }

  private _printLine(line: string): void {
    if (this.config.verbose) {
      const ts = `\x1b[90m${fmtTime()} \x1b[39m`;
      const parts = line.split("\n");
      const openColor = (line.match(/^(\x1b\[[0-9;]*m)+/) ?? [""])[0];
      console.log(parts.map((p, i) => ts + (i > 0 ? openColor : "") + p).join("\n"));
    } else {
      console.log(line);
    }
  }

  /** Print a line to stdout, routing through the status-bar-aware renderer. */
  print(line: string | null): void {
    if (line === null) return;
    const inputPrint = statusBar.inputPrint;
    if (inputPrint) {
      // ask() is active: erase from current cursor position to end of screen
      // (clears the prompt, suggestion row, and status bars), write the new
      // content line, then let drawFresh redraw the prompt + status bars below.
      const inputClear = statusBar.inputClear;
      if (inputClear) {
        inputClear();
      } else {
        process.stdout.write("\r\x1b[J");
      }
      this._printLine(line);
      inputPrint();
      return;
    }
    statusBar.clear();
    this._printLine(line);
    statusBar.draw();
  }

  /** Print a single content block from an assistant/user message. */
  printBlock(b: ContentBlock, role: "assistant" | "user", msg?: Record<string, unknown>): void {
    if (b.type === "tool_use") {
      // Safe cast: we checked b.type === "tool_use" at runtime
      const tu = b as ToolUseBlock;
      this._toolUseNames.set(tu.id, tu.name);
      this._toolUseInputs.set(tu.id, tu.input);
      this.print(this.resolve(TOOL_CALL_FMT, tu.name, tu));
      return;
    }
    if (b.type === "tool_result") {
      // Safe cast: we checked b.type === "tool_result" at runtime
      const tr = b as ToolResultBlock;
      const name = this._toolUseNames.get(tr.tool_use_id) ?? "";
      const _input = this._toolUseInputs.get(tr.tool_use_id);
      this.print(this.resolve(tr.is_error ? TOOL_ERROR_FMT : TOOL_RESULT_FMT, name, { ...tr, _msg: msg, _input }));
      // Fire after the tool result is printed — tool has just finished running.
      statusBar.fireOnToolResult(name);
      return;
    }
    const blockFmt = role === "assistant" ? ASSISTANT_BLOCK_FMT : USER_BLOCK_FMT;
    this.print(this.resolve(blockFmt, b.type, { ...b, _isSynthetic: msg?.isSynthetic ?? false }));
  }

  /** Print a full SDK message (system, assistant, user, result, etc.). */
  printMessage(msg: unknown): void {
    if (msg === null || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;

    if (m.parent_tool_use_id != null) return;

    if (m.type === "system") {
      const subtype = typeof m.subtype === "string" ? m.subtype : "_default";
      this.print(this.resolve(SYSTEM_FMT, subtype, m));
      return;
    }

    if (m.type === "assistant" || m.type === "user") {
      const role = m.type as "assistant" | "user";
      const message = m.message as { content?: ContentBlock[] } | undefined;
      const content = message?.content ?? [];
      if (!content.length) { this.print(this.resolve(MESSAGE_FMT, "_empty", m)); return; }
      for (const b of content) this.printBlock(b, role, m);
      return;
    }

    const type = typeof m.type === "string" ? m.type : "_default";
    this.print(this.resolve(MESSAGE_FMT, type, m));
  }

  /** Print a foreman→worker wire message. */
  printForemanMessage(msg: Wire.ForemanMessage): void {
    this.print(this.resolve(FOREMAN_MESSAGE_FMT, msg.type, msg));
  }
}

// ── Standalone resolve delegate ───────────────────────────────────────────────
//
// The standalone resolve() function uses getConfig().verbose directly (rather
// than the injected config) and is kept for use by utility functions and tests
// that import it directly. Class methods use this.resolve() instead.

/**
 * Resolve a format table entry. Uses getConfig().verbose for verbose/quiet dispatch.
 * @see Display.resolve for the config-injected version
 */
export function resolve(table: FmtTable, key: string, data: unknown): string | null {
  const entry = table[key] ?? table._default;
  if (!entry) return null;
  if (typeof entry === "function") return entry(data);
  const fmt = getConfig().verbose ? entry.verbose : entry.quiet;
  return fmt ? fmt(data) : null;
}
