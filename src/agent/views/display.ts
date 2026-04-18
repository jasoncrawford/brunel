import * as Wire from "../../../shared/wire.js";
import type { StatusBar } from "./status-bar.js";
import { getConfig } from "../../config.js";
import type { BrunelConfig } from "../../config.js";
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
import {
  c, s, W, hr, effectiveWidth,
} from "./style.js";
import {
  type Hunk,
  toolResultText,
  fmtHunk,
  fmtEditResult,
  fmtBashOutput,
  fmtWriteOutput,
  fmtTodoWriteInput,
  fmtAskUserQuestionInput,
  fmtToolSearchOutput,
  fmtTodoWriteOutput,
  renderMarkdown,
} from "./renderer.js";

// Re-export terminal layout / style utilities so importers that
// previously sourced them from display.ts continue to work.
export { c, s, W, hr, effectiveWidth };

// ── clearBreak ─────────────────────────────────────────────────────────────

export function clearBreak(): string {
  const width = effectiveWidth();
  const label = "=== Context cleared ";
  const fill = "=".repeat(Math.max(0, width - label.length));
  return "\n" + c.sageGreen(s.bold(label + fill));
}

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

// ── FORMATS ───────────────────────────────────────────────────────────────

// FmtTable is a mixed-type dispatch table: each entry receives a different
// runtime-typed value, so `any` is intentional here rather than `unknown`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Fmt = (data: any) => string | null;
export type FmtEntry = Fmt | { quiet?: Fmt; verbose?: Fmt };
export type FmtTable = Record<string, FmtEntry>;

function fmtToolCall(b: ToolUseBlock, fmt: string) {
  fmt = c.skyBlue(`\n${fmt}`);
  if (b.input?.description) fmt += c.gray(` # ${b.input.description}`);
  return fmt;
}

function fmtSubagentType(subagentType: string | null | undefined): string {
  if (!subagentType || subagentType === "general-purpose") return "Subagent";
  return subagentType;
}

const ASSISTANT_BLOCK_FMT: FmtTable = {
  thinking: (b) => c.gray("\n" + (getConfig().thinkOutLoud ? renderMarkdown(b.thinking ?? "") : "Thinking...")),
  text:     (b) => c.yellow(`\n${renderMarkdown(b.text ?? "")}`),
  _default: (b) => c.darkGray(`[assistant/${b.type}]`),
};

const USER_BLOCK_FMT: FmtTable = {
  text:     (b) => b._isSynthetic ? null : `\n${b.text ?? ""}`,
  _default: (b) => c.darkGray(`[user/${b.type}]`),
};

const TOOL_CALL_FMT: FmtTable = {
  Bash:       (b) => fmtToolCall(b, `$ ${b.input?.command ?? ""}`),
  Read:       (b) => fmtToolCall(b, `• Read(${toRelativePath(b.input?.file_path ?? "?")})`),
  Write:      (b) => fmtToolCall(b, `• Write(${toRelativePath(b.input?.file_path ?? "?")})`),
  Edit:       (b) => fmtToolCall(b, `• Edit(${toRelativePath(b.input?.file_path ?? "?")})`),
  Glob:       (b) => fmtToolCall(b, `• Glob(${b.input?.pattern ?? "?"})`),
  Grep:       (b) => fmtToolCall(b, `• grep ${trunc(b.input?.pattern ?? "?", 30)} ${b.input?.path != null ? toRelativePath(b.input.path as string) : "."}`),
  Skill:      (b) => fmtToolCall(b, `• Skill(${b.input?.skill ?? "?"})`),
  Agent:      (b) => fmtToolCall(b, `• ${fmtSubagentType(b.input?.subagent_type)}(${trunc(b.input?.prompt ?? "", 80)})`),
  ToolSearch: (b) => fmtToolCall(b, `• ToolSearch(${b.input?.query ?? "?"})`),
  TodoWrite:  (b) => fmtToolCall(b, `• TodoWrite(${fmtTodoWriteInput(b.input?.todos)})`),
  AskUserQuestion: (b) => fmtToolCall(b, `• AskUserQuestion(${fmtAskUserQuestionInput(b.input?.questions)})`),
  _default:   (b) => fmtToolCall(b, `• ${b.name}(${fmtArgs(b.input)})`),
};

const TOOL_RESULT_FMT: FmtTable = {
  _default:   (b) => c.darkGray(`→ ${getConfig().verbose ? toolResultText(b) : trunc(toolResultText(b), 100)}`),
  Read:       (b) => c.darkGray(`→ ${fmtCount(toolResultText(b).split("\n").length, "line")}`),
  Edit:       (b) => fmtEditResult(b),
  Skill:      (b) => c.darkGray(`→ Loaded skill`),
  Bash:       (b) => c.darkGray(`→ ${fmtBashOutput(toolResultText(b))}`),
  Write:      (b) => c.darkGray(`→ ${fmtWriteOutput(b)}`),
  ToolSearch: (b) => c.darkGray(`→ ${fmtToolSearchOutput(b.content)}`),
  TodoWrite:  (b) => c.darkGray(`→ ${fmtTodoWriteOutput(b)}`),
};

const TOOL_ERROR_FMT: FmtTable = {
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

const SYSTEM_FMT: FmtTable = {
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

const MESSAGE_FMT: FmtTable = {
  _empty:           (m) => c.darkGray(`[${m.type} — empty]`),
  result:           (m) => c.darkGray(`\n${fmtStats(Math.round(m.duration_ms / 1000), m.num_turns, m.usage.output_tokens, m.usage.input_tokens)}`),
  rate_limit_event: (m) => {
    const info = m.rate_limit_info;
    if (!info || info.status === "allowed") return null;
    return c.amber(fmtRateLimitInfo(info));
  },
  _default:         (m) => c.darkGray(`msg: ${m.type}`),
};

const FOREMAN_MESSAGE_FMT: FmtTable = {
  task_assigned:      { verbose: (m) => c.darkGray(`Task assigned: #${m.issue.number}, ${m.issue.title}`) },
  event_notification: { verbose: (m) => c.darkGray(`Event received [${fmtTime()}]: ${fmtEvent(m.event as Wire.WebhookEvent)}`) },
  hello_ack:          { verbose: (m) => c.darkGray(`hello_ack: ${m.status}`) },
  foreman_error:      (m) => c.boldRed(`[foreman error] ${m.message}`),
  _default:           (m) => c.darkGray(`Unknown foreman message: ${m.type}`),
};

// ── Display class ──────────────────────────────────────────────────────────

/**
 * View class for terminal rendering. Receives config in its constructor so
 * config is injected rather than globally accessed.
 *
 * Use `display.print(line)`, `display.printMessage(msg)`, etc. for output.
 * Use `c`, `s`, `fmtCount`, `fmtStats`, etc. from their respective modules
 * for pure utilities.
 */
export class Display {
  /** The color object, exposed as an instance property for convenience. */
  readonly c = c;
  /** The style object, exposed as an instance property for convenience. */
  readonly s = s;
  /** Returns the ANSI escape to clear the terminal and reset scroll. */
  readonly clearBreak = clearBreak;
  /** Format tool call arguments for display, truncating long values. */
  readonly fmtArgs = fmtArgs;

  private readonly _toolUseNames = new Map<string, string>();
  private readonly _toolUseInputs = new Map<string, Record<string, unknown>>();

  constructor(readonly config: BrunelConfig, readonly statusBar: StatusBar) {}

  /** Public accessor for tests to clear tool-use state between tests. */
  get toolUseNames(): Map<string, string> { return this._toolUseNames; }

  /** Returns the usable terminal width, adjusted for verbose timestamp prefix. */
  effectiveWidth(fallback = W): number {
    return (process.stdout.columns ?? fallback) - (this.config.verbose ? 9 : 0);
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
    const inputPrint = this.statusBar.inputPrint;
    if (inputPrint) {
      // ask() is active: erase from current cursor position to end of screen
      // (clears the prompt, suggestion row, and status bars), write the new
      // content line, then let drawFresh redraw the prompt + status bars below.
      const inputClear = this.statusBar.inputClear;
      if (inputClear) {
        inputClear();
      } else {
        process.stdout.write("\r\x1b[J");
      }
      this._printLine(line);
      inputPrint();
      return;
    }
    this.statusBar.clear();
    this._printLine(line);
    this.statusBar.draw();
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
      this.statusBar.fireOnToolResult(name);
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

// ── Standalone resolve delegate ────────────────────────────────────────────
//
// The standalone resolve() function uses getConfig().verbose directly (rather
// than the injected config) and is exported for use by tests that want to test
// the dispatch mechanism with custom FmtTable objects. Class methods use
// this.resolve() instead.

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
