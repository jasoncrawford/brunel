import type * as Wire from "../../../shared/wire.js";
import type { StatusBar } from "./status-bar.js";
import { getConfig } from "../../config.js";
import type { BrunelConfig } from "../../config.js";
import { fmtTime, fmtArgs } from "../../../shared/formatters.js";
import { c, s, W, effectiveWidth as _effectiveWidth } from "./style.js";
import {
  type ToolUseBlock,
  type ToolResultBlock,
  type ContentBlock,
  type FmtTable,
  clearBreak as _clearBreak,
  ASSISTANT_BLOCK_FMT,
  USER_BLOCK_FMT,
  TOOL_CALL_FMT,
  TOOL_RESULT_FMT,
  TOOL_ERROR_FMT,
  SYSTEM_FMT,
  MESSAGE_FMT,
  FOREMAN_MESSAGE_FMT,
} from "./renderer.js";

export type {
  ToolUseBlock,
  ToolResultBlock,
  ContentBlock,
  FmtTable,
} from "./renderer.js";
export type { Fmt, FmtEntry } from "./renderer.js";

// ── Display class ──────────────────────────────────────────────────────────

/**
 * View class for terminal I/O. Receives config in its constructor so config
 * is injected rather than globally accessed.
 *
 * Renderer (renderer.ts) produces strings; Display is the single doorway
 * through which everything reaches stdout. It clears the status bar before
 * printing, redraws it after, and handles verbose-mode line prefixing.
 */
export class Display {
  /** The color object, exposed as an instance property for convenience. */
  readonly c = c;
  /** The style object, exposed as an instance property for convenience. */
  readonly s = s;
  /** Format tool call arguments for display, truncating long values. */
  readonly fmtArgs = fmtArgs;

  private readonly _toolUseNames = new Map<string, string>();
  private readonly _toolUseInputs = new Map<string, Record<string, unknown>>();

  constructor(readonly config: BrunelConfig, readonly statusBar: StatusBar) {}

  /** Public accessor for tests to clear tool-use state between tests. */
  get toolUseNames(): Map<string, string> { return this._toolUseNames; }

  /** Returns a styled "context cleared" divider string. */
  clearBreak(): string {
    return _clearBreak(this.config.verbose);
  }

  /** Returns the usable terminal width, adjusted for the verbose timestamp prefix. */
  effectiveWidth(fallback = W): number {
    return _effectiveWidth(fallback, this.config.verbose);
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
    this.print(this.resolve(blockFmt, b.type, { ...b, _isSynthetic: msg?.isSynthetic ?? false, _thinkOutLoud: this.config.thinkOutLoud }));
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

// ── Standalone resolve ─────────────────────────────────────────────────────
//
// Uses getConfig().verbose directly. Exported for tests that exercise the
// dispatch mechanism with custom FmtTable objects. Class methods use
// this.resolve() with injected config instead.

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
