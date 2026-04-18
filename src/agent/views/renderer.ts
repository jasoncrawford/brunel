/**
 * Rich content rendering for the terminal TUI. Converts structured data
 * (SDK tool blocks, markdown text, diffs) into styled terminal strings.
 * No I/O — callers pass results to display.print().
 */
import { c, s, W, effectiveWidth } from "./style.js";
import { trunc, fmtCount } from "../../../shared/formatters.js";
import { getConfig } from "../../config.js";

// ── Types ──────────────────────────────────────────────────────────────────

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

// ── Diff rendering ─────────────────────────────────────────────────────────

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

// ── Tool result formatters ─────────────────────────────────────────────────

export function fmtEditResult(b: {
  content: unknown;
  _msg?: { tool_use_result?: { structuredPatch?: Hunk[] } };
}): string {
  const patch = b._msg?.tool_use_result?.structuredPatch;
  if (patch && patch.length > 0) return patch.map(fmtHunk).join("\n");
  return c.darkGray(`→ ${trunc(toolResultText(b), 100)}`);
}

export function fmtBashOutput(text: string): string {
  const t = text.trim();
  if (!t || t === "(Bash completed with no output)") return "Success";
  return getConfig().verbose ? t : trunc(t, 100);
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

function renderTable(tableLines: string[], maxWidth?: number): string {
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

