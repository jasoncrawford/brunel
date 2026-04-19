import type * as Wire from "../../../shared/wire.js";
import type { StatusBar } from "./status-bar.js";
import type { BrunelConfig } from "../../config.js";
import { fmtTime, fmtArgs } from "../../../shared/formatters.js";
import { c, s } from "./style.js";
import {
  type ToolUseBlock,
  type ToolResultBlock,
  type ContentBlock,
  clearBreak as _clearBreak,
  formatToolCall,
  formatToolResult,
  formatContentBlock,
  formatSystemEvent,
  formatMessageEvent,
  formatForemanMessage,
} from "./renderer.js";

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
      const tu = b as ToolUseBlock;
      this._toolUseNames.set(tu.id, tu.name);
      this._toolUseInputs.set(tu.id, tu.input);
      this.print(formatToolCall(tu));
      return;
    }
    if (b.type === "tool_result") {
      const tr = b as ToolResultBlock;
      const name = this._toolUseNames.get(tr.tool_use_id) ?? "";
      const _input = this._toolUseInputs.get(tr.tool_use_id);
      this.print(formatToolResult({ ...tr, _input }, name, msg, this.config.verbose));
      // Fire after the tool result is printed — tool has just finished running.
      this.statusBar.fireOnToolResult(name);
      return;
    }
    this.print(formatContentBlock(b, role, !!(msg?.isSynthetic), this.config.thinkOutLoud));
  }

  /** Print a full SDK message (system, assistant, user, result, etc.). */
  printMessage(msg: unknown): void {
    if (msg === null || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;

    if (m.parent_tool_use_id != null) return;

    if (m.type === "system") {
      const subtype = typeof m.subtype === "string" ? m.subtype : "_default";
      this.print(formatSystemEvent(subtype, m, this.config.verbose));
      return;
    }

    if (m.type === "assistant" || m.type === "user") {
      const role = m.type as "assistant" | "user";
      const message = m.message as { content?: ContentBlock[] } | undefined;
      const content = message?.content ?? [];
      if (!content.length) { this.print(formatMessageEvent("_empty", m)); return; }
      for (const b of content) this.printBlock(b, role, m);
      return;
    }

    const type = typeof m.type === "string" ? m.type : "_default";
    this.print(formatMessageEvent(type, m));
  }

  /** Print a foreman→worker wire message. */
  printForemanMessage(msg: Wire.ForemanMessage): void {
    this.print(formatForemanMessage(msg, this.config.verbose));
  }
}
