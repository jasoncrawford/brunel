// ── Display width ─────────────────────────────────────────────────────────────

export const W = 70;
export const hr = (ch = "─") => ch.repeat(W);

// ── Verbose flag ──────────────────────────────────────────────────────────────

export let VERBOSE = process.argv.includes("--verbose");
export function setVerbose(v: boolean) { VERBOSE = v; }

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

// ── Formatting helpers ────────────────────────────────────────────────────────

export function trunc(str: string, n = 80) {
  str = str.replace(/\s+/g, " ").trim();
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

export function fmtCount(count: number, singular_noun: string, plural_noun?: string) {
  const noun = (count === 1) ? singular_noun : (plural_noun ?? `${singular_noun}s`);
  return `${count} ${noun}`;
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

export function fmtToolCall(b: any, fmt: string) {
  fmt = c.skyBlue(`\n${fmt}`);
  if (b.input?.description) fmt += c.gray(` # ${b.input.description}`);
  return fmt;
}

export function fmtHunk(hunk: any): string {
  const header = c.darkGray(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
  const width = process.stdout.columns ?? 80;
  const lines = (hunk.lines as string[]).map(line => {
    if (line.startsWith("+")) return c.bgGreen(line.padEnd(width));
    if (line.startsWith("-")) return c.bgRed(line.padEnd(width));
    return c.darkGray(line);
  });
  return [header, ...lines].join("\n");
}

export function fmtEditResult(b: any) {
  const patch = b._msg?.tool_use_result?.structuredPatch;
  if (patch && patch.length > 0) return patch.map(fmtHunk).join("\n");
  return c.darkGray(`→ ${trunc(toolResultText(b), 100)}`);
}

export function toolResultText(b: any): string {
  const raw = b.content;
  if (typeof raw === "string") return raw;
  return (Array.isArray(raw) ? raw : [raw])
    .map((x: any) => {
      if (x?.type === "text") return x.text;
      if (x?.type === "tool_reference") return `[tool:${x.tool_name}]`;
      return `[${x?.type ?? "?"}]`;
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
  Bash:     (b) => fmtToolCall(b, `$ ${trunc(b.input?.command ?? "", 80)}`),
  Read:     (b) => fmtToolCall(b, `• Read(${b.input?.file_path ?? "?"})`),
  Write:    (b) => fmtToolCall(b, `• Write(${b.input?.file_path ?? "?"})`),
  Edit:     (b) => fmtToolCall(b, `• Edit(${b.input?.file_path ?? "?"})`),
  Glob:     (b) => fmtToolCall(b, `• Glob(${b.input?.pattern ?? "?"})`),
  Grep:     (b) => fmtToolCall(b, `• grep ${trunc(b.input?.pattern ?? "?", 30)} ${b.input?.path ?? "."}`),
  Skill:    (b) => fmtToolCall(b, `• Skill(${b.input?.skill ?? "?"})`),
  Agent:    (b) => fmtToolCall(b, `• ${b.input?.subagent_type ?? "Agent"}(${trunc(b.input?.prompt ?? "", 80)})`),
  _default: (b) => fmtToolCall(b, `• ${b.name}(${fmtArgs(b.input)})`),
};

export const TOOL_RESULT_FMT: FmtTable = {
  _default: (b) => c.darkGray(`→ ${trunc(toolResultText(b), 100)}`),
  Read:     (b) => c.darkGray(`→ ${fmtCount(toolResultText(b).split("\n").length, "line")}`),
  Edit:     (b) => fmtEditResult(b),
  Skill:    (b) => null,
};

export const TOOL_ERROR_FMT: FmtTable = {
  _default: (b) => c.salmon(`! ${trunc(toolResultText(b), 100)}`),
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

export const HOOK_FMT: FmtTable = {
  PreToolUse:         { verbose: (h) => c.sageGreen(`hook: pre-tool  ${h.tool_name}(${fmtArgs(h.tool_input ?? {}, 30)})`) },
  PostToolUse:        { verbose: (h) => c.sageGreen(`hook: post-tool ${h.tool_name}  (${h.tool_error == null ? "ok" : "error"})`) },
  PostToolUseFailure: { verbose: (h) => c.sageGreen(`hook: tool fail ${h.tool_name}  ${trunc(String(h.tool_error ?? ""), 50)}`) },
  Notification:       { verbose: (h) => c.sageGreen(`hook: notif "${trunc(String(h.message ?? ""), 60)}"`) },
  UserPromptSubmit:   { verbose: (h) => c.sageGreen(`hook: user prompt "${trunc(String(h.prompt ?? ""), 60)}"`) },
  PermissionRequest:  { verbose: (h) => c.sageGreen(`hook: permission ${h.tool_name ?? h.tool ?? "?"}  → ${h.status ?? h.decision ?? "?"}`) },
  Stop:               { verbose: (h) => c.sageGreen(`hook: stop reason=${h.stop_reason ?? "?"}`) },
  SubagentStart:      { verbose: (h) => c.sageGreen(`hook: subagent start id=${h.agent_id ?? "?"}`) },
  SubagentStop:       { verbose: (h) => c.sageGreen(`hook: subagent stop  id=${h.agent_id ?? "?"}`) },
  TaskCompleted:      { verbose: (h) => c.sageGreen(`hook: task completed id=${h.task_id ?? "?"}`) },
  _default:           { verbose: (h) => c.sageGreen(`hook: ${h._event}`) },
};

// ── Printing engine ───────────────────────────────────────────────────────────

let _statusText = "";
export let _statusActive = false;
let _statusInterval: ReturnType<typeof setInterval> | null = null;

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
  console.log(line);
  _drawStatus();
}

export function resolve(table: FmtTable, key: string, data: any): string | null {
  const entry = table[key] ?? table._default;
  if (!entry) return null;
  if (typeof entry === "function") return entry(data);
  const fmt = VERBOSE ? entry.verbose : entry.quiet;
  return fmt ? fmt(data) : null;
}

export const toolUseNames = new Map<string, string>();

export function printBlock(b: any, role: "assistant" | "user", msg?: any) {
  if (b.type === "tool_use") {
    toolUseNames.set(b.id, b.name);
    print(resolve(TOOL_CALL_FMT, b.name, b));
    return;
  }
  if (b.type === "tool_result") {
    const name = toolUseNames.get(b.tool_use_id) ?? "";
    print(resolve(b.is_error ? TOOL_ERROR_FMT : TOOL_RESULT_FMT, name, { ...b, _msg: msg }));
    return;
  }
  const blockFmt = role === "assistant" ? ASSISTANT_BLOCK_FMT : USER_BLOCK_FMT;
  print(resolve(blockFmt, b.type, { ...b, _isSynthetic: msg?.isSynthetic ?? false }));
}

export function printMessage(msg: unknown) {
  const m = msg as any;
  if (m.parent_tool_use_id != null) return;

  if (m.type === "system") {
    print(resolve(SYSTEM_FMT, m.subtype, m));
    return;
  }

  if (m.type === "assistant" || m.type === "user") {
    const content: any[] = m.message?.content ?? [];
    if (!content.length) { print(resolve(MESSAGE_FMT, "_empty", m)); return; }
    for (const b of content) printBlock(b, m.type, m);
    return;
  }

  print(resolve(MESSAGE_FMT, m.type, m));
}

export function printHook(event: string, input: unknown) {
  print(resolve(HOOK_FMT, event, { ...(input as any), _event: event }));
}

// ── GitHub event formatting ────────────────────────────────────────────────────

function truncTitle(title: unknown, max = 50): string {
  const t = String(title ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export function summaryEvent(id: string, name: string, payload: unknown): string {
  const p = payload as Record<string, unknown>;
  const action = typeof p.action === "string" ? `/${p.action}` : "";
  const repo = (p.repository as Record<string, unknown> | undefined)?.full_name;
  const sender = (p.sender as Record<string, unknown> | undefined)?.login;

  let detail = "";
  const issue = p.issue as Record<string, unknown> | undefined;
  const pr = p.pull_request as Record<string, unknown> | undefined;

  if (issue) {
    detail = ` #${issue.number} "${truncTitle(issue.title)}"`;
  } else if (pr) {
    detail = ` #${pr.number} "${truncTitle(pr.title)}"`;
  } else if (name === "push") {
    const ref = String(p.ref ?? "");
    const count = (p.commits as unknown[] | undefined)?.length ?? 0;
    detail = ` ${ref} (${count} commit${count === 1 ? "" : "s"})`;
  }

  const parts: string[] = [`${name}${action}${detail}`];
  if (sender) parts.push(`by ${sender}`);
  if (repo) parts.push(`(${repo})`);

  return `[event] ${parts.join(" ")}`;
}

// ── Foreman → Worker message formatting ───────────────────────────────────────

import type { ForemanMessage } from "./types.js";

/**
 * Returns a display string for a ForemanMessage received by a worker, or null
 * if the message type handles its own printing elsewhere in the worker loop.
 */
export function formatForemanMessage(msg: ForemanMessage): string | null {
  if (msg.type === "event_notification") {
    return summaryEvent(msg.event.id, msg.event.name, msg.event.payload);
  }
  return null;
}
