/**
 * Rich content rendering for the terminal TUI. Converts structured data
 * (SDK tool blocks, markdown text, diffs) into styled terminal strings.
 * No I/O — callers pass results to display.print().
 */
import * as Wire from "../../../shared/wire.js";
import type { AgentStatus } from "../models/agent-status.js";
import { c, s, W } from "./style.js";
import {
  trunc,
  fmtCount,
  fmtTime,
  fmtNum,
  fmtStats,
  fmtEvent,
  fmtArgs,
  toRelativePath,
} from "../../../shared/formatters.js";
import { shortWorkerId } from "../../../shared/utils.js";
import type { Display } from "./display.js";

// ── Content block types ────────────────────────────────────────────────────

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
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

// ── Format table types ─────────────────────────────────────────────────────

// FmtTable is a mixed-type dispatch table: each entry receives a different
// runtime-typed value, so `any` is intentional here rather than `unknown`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Fmt = (data: any) => string | null;
export type FmtEntry = Fmt | { quiet?: Fmt; verbose?: Fmt };
export type FmtTable = Record<string, FmtEntry>;

// ── Internal dispatch ──────────────────────────────────────────────────────

function _resolve(table: FmtTable, key: string, data: unknown, verbose: boolean): string | null {
  const entry = table[key] ?? table._default;
  if (!entry) return null;
  if (typeof entry === "function") return entry(data);
  const fmt = verbose ? entry.verbose : entry.quiet;
  return fmt ? fmt(data) : null;
}

/**
 * Resolve a format table entry. Exported for tests that exercise the dispatch
 * mechanism with custom FmtTable objects.
 */
export function resolve(table: FmtTable, key: string, data: unknown, verbose: boolean): string | null {
  return _resolve(table, key, data, verbose);
}

// ── Hunk type ──────────────────────────────────────────────────────────────

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

// ── Tool result text extraction ────────────────────────────────────────────

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

// ── Tool result formatters ─────────────────────────────────────────────────

/**
 * Formats bash output for display. Returns "Success" for empty output,
 * otherwise returns the full trimmed text. Callers decide whether to truncate.
 */
export function fmtBashOutput(text: string): string {
  const t = text.trim();
  if (!t || t === "(Bash completed with no output)") return "Success";
  return t;
}

export function fmtWriteOutput(b: { content: unknown; _input?: Record<string, unknown> }): string {
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
  const items = Array.isArray(questions) ? questions as Array<{ question: string }> : [];
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

export function fmtTodoWriteOutput(b: {
  content: unknown;
  _msg?: Record<string, unknown>;
}): string {
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

// ── Markdown renderer ──────────────────────────────────────────────────────

function mdInline(text: string): string {
  text = text.replace(/\*\*(.+?)\*\*/gs,  (_, t) => s.bold(t));
  text = text.replace(/__(.+?)__/gs,      (_, t) => s.bold(t));
  text = text.replace(/`([^`]+)`/g,       (_, t) => s.bold(s.underline(t)));
  return text;
}

// Strips ANSI escape sequences to measure the visible length of a string.
function visLen(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// Pads a (possibly ANSI-formatted) string to `width` visible characters.
function ansiPadEnd(str: string, width: number): string {
  return str + " ".repeat(Math.max(0, width - visLen(str)));
}

// Wraps text at visible-character boundaries, ignoring ANSI escape sequences,
// so pre-formatted strings don't have line breaks distorted by color codes.
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

// ── Format table helpers ───────────────────────────────────────────────────

function fmtToolCallLine(b: ToolUseBlock, fmt: string): string {
  fmt = c.skyBlue(`\n${fmt}`);
  if (b.input?.description) fmt += c.gray(` # ${b.input.description}`);
  return fmt;
}

function fmtSubagentType(subagentType: string | null | undefined): string {
  if (!subagentType || subagentType === "general-purpose") return "Subagent";
  return subagentType;
}

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
  five_hour:        "five-hour",
  seven_day:        "seven-day",
  seven_day_opus:   "seven-day Opus",
  seven_day_sonnet: "seven-day Sonnet",
  overage:          "overage",
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

// ── Renderer class ─────────────────────────────────────────────────────────

export class Renderer {
  constructor(private readonly display: Display) {}

  // ── Format tables ─────────────────────────────────────────────────────────
  //
  // All tables live here as class fields so any entry can reference `this`
  // when needed (e.g. TOOL_RESULT_FMT.Edit calls this.fmtEditResult,
  // ASSISTANT_BLOCK_FMT.text calls this.renderMarkdown). TypeScript sets
  // constructor parameter properties before running field initializers, so
  // `this.display` and all prototype methods are available here.

  private readonly TOOL_CALL_FMT: FmtTable = {
    Bash:       (b) => fmtToolCallLine(b, `$ ${b.input?.command ?? ""}`),
    Read:       (b) => fmtToolCallLine(b, `• Read(${toRelativePath(b.input?.file_path ?? "?")})`),
    Write:      (b) => fmtToolCallLine(b, `• Write(${toRelativePath(b.input?.file_path ?? "?")})`),
    Edit:       (b) => fmtToolCallLine(b, `• Edit(${toRelativePath(b.input?.file_path ?? "?")})`),
    Glob:       (b) => fmtToolCallLine(b, `• Glob(${b.input?.pattern ?? "?"})`),
    Grep:       (b) => fmtToolCallLine(b, `• grep ${trunc(b.input?.pattern ?? "?", 30)} ${b.input?.path != null ? toRelativePath(b.input.path as string) : "."}`),
    Skill:      (b) => fmtToolCallLine(b, `• Skill(${b.input?.skill ?? "?"})`),
    Agent:      (b) => fmtToolCallLine(b, `• ${fmtSubagentType(b.input?.subagent_type)}(${trunc(b.input?.prompt ?? "", 80)})`),
    ToolSearch: (b) => fmtToolCallLine(b, `• ToolSearch(${b.input?.query ?? "?"})`),
    TodoWrite:  (b) => fmtToolCallLine(b, `• TodoWrite(${fmtTodoWriteInput(b.input?.todos)})`),
    AskUserQuestion: (b) => fmtToolCallLine(b, `• AskUserQuestion(${fmtAskUserQuestionInput(b.input?.questions)})`),
    _default:   (b) => fmtToolCallLine(b, `• ${b.name}(${fmtArgs(b.input)})`),
  };

  private readonly TOOL_ERROR_FMT: FmtTable = {
    AskUserQuestion: (b) => c.darkGray(`→ ${toolResultText(b)}`),
    _default:        (b) => c.salmon(`! ${toolResultText(b)}`),
  };

  private readonly TOOL_RESULT_FMT: FmtTable = {
    _default:   {
      quiet:   (b) => c.darkGray(`→ ${trunc(toolResultText(b), 100)}`),
      verbose: (b) => c.darkGray(`→ ${toolResultText(b)}`),
    },
    Read:       (b) => c.darkGray(`→ ${fmtCount(toolResultText(b).split("\n").length, "line")}`),
    Edit:       (b) => this.fmtEditResult(b),
    Skill:      (b) => c.darkGray(`→ Loaded skill`),
    Bash:       {
      quiet:   (b) => c.darkGray(`→ ${trunc(fmtBashOutput(toolResultText(b)), 100)}`),
      verbose: (b) => c.darkGray(`→ ${fmtBashOutput(toolResultText(b))}`),
    },
    Write:      (b) => c.darkGray(`→ ${fmtWriteOutput(b)}`),
    ToolSearch: (b) => c.darkGray(`→ ${fmtToolSearchOutput(b.content)}`),
    TodoWrite:  (b) => c.darkGray(`→ ${fmtTodoWriteOutput(b)}`),
  };

  private readonly USER_BLOCK_FMT: FmtTable = {
    text:     (b) => b._isSynthetic ? null : `\n${b.text ?? ""}`,
    _default: (b) => c.darkGray(`[user/${b.type}]`),
  };

  private readonly ASSISTANT_BLOCK_FMT: FmtTable = {
    thinking: (b) => c.gray("\n" + (b._thinkOutLoud ? this.renderMarkdown(b.thinking ?? "") : "Thinking...")),
    text:     (b) => c.yellow(`\n${this.renderMarkdown(b.text ?? "")}`),
    _default: (b) => c.darkGray(`[assistant/${b.type}]`),
  };

  private readonly SYSTEM_FMT: FmtTable = {
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

  private readonly MESSAGE_FMT: FmtTable = {
    _empty:           (m) => c.darkGray(`[${m.type} — empty]`),
    result:           (m) => c.darkGray(`\n${fmtStats(Math.round(m.duration_ms / 1000), m.num_turns, m.usage.output_tokens, m.usage.input_tokens, m.total_cost_usd)}`),
    rate_limit_event: (m) => {
      const info = m.rate_limit_info;
      if (!info || info.status === "allowed") return null;
      return c.amber(fmtRateLimitInfo(info));
    },
    _default:         (m) => c.darkGray(`msg: ${m.type}`),
  };

  private readonly FOREMAN_MESSAGE_FMT: FmtTable = {
    task_assigned:      { verbose: (m) => c.darkGray(`Task assigned: #${m.issue.number}, ${m.issue.title}`) },
    event_notification: { verbose: (m) => c.darkGray(`Event received [${fmtTime()}]: ${fmtEvent(m.event as Wire.WebhookEvent)}`) },
    hello_ack:          { verbose: (m) => c.darkGray(`hello_ack: ${m.status}`) },
    repo_activated:     () => c.sageGreen("Repo activated. Waiting for tasks..."),
    foreman_error:      (m) => c.boldRed(`[foreman error] ${m.message}`),
    _default:           (m) => c.darkGray(`Unknown foreman message: ${m.type}`),
  };

  private _resolve(table: FmtTable, key: string, data: unknown): string | null {
    return resolve(table, key, data, this.display.verbose);
  }

  /** Returns a styled "context cleared" divider string. */
  clearBreak(): string {
    const width = this.display.effectiveWidth(W);
    const label = "=== Context cleared ";
    const fill = "=".repeat(Math.max(0, width - label.length));
    return "\n" + c.sageGreen(s.bold(label + fill));
  }

  /** Format a diff hunk for display. */
  fmtHunk(hunk: Hunk): string {
    const header = c.darkGray(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    const width = this.display.effectiveWidth(80);
    const lines = hunk.lines.map(line => {
      if (line.startsWith("+")) return c.bgGreen(line.padEnd(width));
      if (line.startsWith("-")) return c.bgRed(line.padEnd(width));
      return c.darkGray(line);
    });
    return [header, ...lines].join("\n");
  }

  private fmtEditResult(b: {
    content: unknown;
    _msg?: { tool_use_result?: { structuredPatch?: Hunk[] } };
  }): string {
    const patch = b._msg?.tool_use_result?.structuredPatch;
    if (patch && patch.length > 0) return patch.map(h => this.fmtHunk(h)).join("\n");
    return c.darkGray(`→ ${trunc(toolResultText(b), 100)}`);
  }

  private renderTable(tableLines: string[], maxWidth?: number): string {
    const termWidth = maxWidth ?? this.display.effectiveWidth();
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

  renderMarkdown(text: string): string {
    const lines = text.split("\n");
    const out: string[] = [];
    let inCode = false;
    const codeLines: string[] = [];
    let tableLines: string[] = [];

    const flushTable = () => {
      if (tableLines.length) { out.push(this.renderTable(tableLines)); tableLines = []; }
    };

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

  /** Format a tool use block — the "calling a tool" line. */
  formatToolCall(b: ToolUseBlock): string | null {
    return this._resolve(this.TOOL_CALL_FMT, b.name, b);
  }

  /** Format a tool result or tool error block. */
  formatToolResult(
    b: ToolResultBlock & { _input?: Record<string, unknown> },
    toolName: string,
    msg: Record<string, unknown> | undefined,
  ): string | null {
    return this._resolve(
      b.is_error ? this.TOOL_ERROR_FMT : this.TOOL_RESULT_FMT,
      toolName,
      { ...b, _msg: msg },
    );
  }

  /** Format an assistant or user content block. */
  formatContentBlock(
    b: ContentBlock,
    role: "assistant" | "user",
    isSynthetic: boolean,
    thinkOutLoud: boolean,
  ): string | null {
    const fmt = role === "assistant" ? this.ASSISTANT_BLOCK_FMT : this.USER_BLOCK_FMT;
    return this._resolve(fmt, b.type, { ...b, _isSynthetic: isSynthetic, _thinkOutLoud: thinkOutLoud });
  }

  /** Format a system event. */
  formatSystemEvent(subtype: string, m: unknown): string | null {
    return this._resolve(this.SYSTEM_FMT, subtype, m);
  }

  /** Format a result/rate-limit/other SDK message event. */
  formatMessageEvent(type: string, m: unknown): string | null {
    return this._resolve(this.MESSAGE_FMT, type, m);
  }

  /** Format a foreman→worker wire message. */
  formatForemanMessage(msg: Wire.ForemanMessage): string | null {
    return this._resolve(this.FOREMAN_MESSAGE_FMT, msg.type, msg);
  }

  /**
   * Format the worker status bar as a terminal-ready string: ANSI-colored,
   * width-padded, ready to be written to stdout.
   * Called by Display._updatePersistent() and Display._handleResize().
   */
  fmtStatusBar(status: AgentStatus, width: number): string {
    // Dim sage-green bg + bright-white text. No trailing reset: drawRaw() appends
    // \x1b[K (fills remaining width with the same bg) then \x1b[0m.
    const styledBar = (content: string) => `\x1b[48;5;22m\x1b[97m${content}`;

    const modelName = (!status.model || status.model === "default") ? "sonnet" : status.model;
    const effortStr = status.effort ? ` (${status.effort})` : "";
    // Base parts shared by both modes: worker id + model/effort.
    const baseParts = [`worker ${shortWorkerId(status.agentId)}`, `${modelName}${effortStr}`];

    if (!status.workerModeActive) {
      // Minimal bar: agent ID + model/effort + branch (if known).
      const parts = [...baseParts];
      if (status.branch) parts.push(status.branch);
      let leftText = parts.join(" ∙ ");
      if (leftText.length > width) leftText = leftText.slice(0, Math.max(0, width - 1)) + "…";
      return styledBar(leftText.padEnd(width));
    }

    // Right side: connection status
    const retryInSeconds = status.reconnectAt != null
      ? Math.max(0, Math.ceil((status.reconnectAt - Date.now()) / 1000))
      : undefined;
    const codeStr = this.display.verbose && status.disconnectCode != null
      ? ` (${status.disconnectCode})`
      : "";
    const rightText =
      status.connectionStatus === "connected"    ? "Connected" :
      status.connectionStatus === "handshaking"  ? "Handshaking..." :
      status.connectionStatus === "reconnecting" ? "Reconnecting..." :
      retryInSeconds != null                     ? `Disconnected${codeStr}. Retrying in ${retryInSeconds}s` :
                                                   `Disconnected${codeStr}`;

    // Left side: worker {id8} ∙ {model} ∙ {task info}
    const parts = [...baseParts];
    if (status.taskNumber != null) parts.push(`task #${status.taskNumber}`);
    else parts.push("no current task");
    if (status.prNumber != null) parts.push(`PR #${status.prNumber}`);
    if (status.branch) parts.push(status.branch);
    if (status.taskNumber != null && status.taskInputTokens > 0) {
      parts.push(`tokens: ${fmtNum(status.taskInputTokens)} in / ${fmtNum(status.taskOutputTokens)} out`);
      if (status.taskCostUsd != null) {
        parts.push(`cost: $${status.taskCostUsd.toFixed(2)}`);
      }
    }
    let leftText = parts.join(" ∙ ");

    // Truncate left side if needed to leave room for right side with a gap of 1
    const maxLeftLen = Math.max(0, width - rightText.length - 1);
    if (leftText.length > maxLeftLen) {
      leftText = leftText.slice(0, Math.max(0, maxLeftLen - 1)) + "…";
    }

    const gap = Math.max(1, width - leftText.length - rightText.length);
    return styledBar(leftText + " ".repeat(gap) + rightText);
  }
}
