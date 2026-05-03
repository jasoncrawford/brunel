import type * as Wire from "../../../shared/wire.js";
import type { BrunelConfig } from "../../config.js";
import { fmtTime, fmtArgs } from "../../../shared/formatters.js";
import { c, s, W } from "./style.js";
import { Renderer } from "./renderer.js";
import type {
  ToolUseBlock,
  ToolResultBlock,
  ContentBlock,
} from "./renderer.js";
import { AgentStatus } from "../models/agent-status.js";

// ── Display class ──────────────────────────────────────────────────────────

/** Visible width of the verbose timestamp prefix "HH:mm:ss " */
const VERBOSE_PREFIX_LEN = 9;

/**
 * View class for terminal I/O. Receives config and agentStatus in its
 * constructor so both are injected rather than globally accessed.
 *
 * Renderer (renderer.ts) produces strings; Display is the single doorway
 * through which everything reaches stdout. It clears the status bar before
 * printing, redraws it after, and handles verbose-mode line prefixing.
 *
 * Display owns all status bar rendering: startBar()/stopBar() for the
 * animated query-progress bar and startPersistentBar()/stopPersistentBar()
 * for the persistent worker status bar. It subscribes to agentStatus
 * "change" events for reactive redraws.
 *
 * Redraw coordination callbacks (inputPrint, inputClear, inputStatus) live
 * here because they coordinate between Input and Display — not the state
 * model.
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
  readonly renderer: Renderer;

  /**
   * Returns the current terminal column count. Defaults to reading
   * `process.stdout.columns`; override in tests to avoid global patching.
   */
  getColumns: () => number | undefined = () => process.stdout.columns;

  // ── Primary (animated query-progress) bar ──────────────────────────────────
  /** Whether the primary animated status bar is currently active. */
  active = false;
  private _text = "";
  private _getText: (() => string) | null = null;
  private _interval: ReturnType<typeof setInterval> | null = null;

  // ── Persistent (worker) bar ────────────────────────────────────────────────
  /** Whether the persistent worker status bar is currently active. */
  persistentActive = false;
  private _persistentText = "";
  private _resizeHandler: (() => void) | null = null;

  // ── Redraw coordination callbacks ──────────────────────────────────────────
  // Registered by ask() while it is active. print() routes through these so
  // output doesn't corrupt the interactive prompt/suggestion area.

  // Fired after a tool result is printed (tool has just finished running).
  // Cursor is at a fresh new line after print().
  inputPrint: (() => void) | null = null;
  // Called while cursor is in the buffer area — navigates back to prompt
  // line then redraws with status bars below.
  inputStatus: (() => void) | null = null;
  // Registered by ask(). Called by print() BEFORE writing output to clear the
  // prompt area including any leading blank line (see issue #418).
  inputClear: (() => void) | null = null;

  constructor(readonly config: BrunelConfig, readonly agentStatus: AgentStatus) {
    this.renderer = new Renderer(this);
    // Subscribe to agentStatus changes for reactive status bar redraws.
    agentStatus.on("change", () => {
      this._updatePersistent();
    });
  }

  /** Public accessor for tests to clear tool-use state between tests. */
  get toolUseNames(): Map<string, string> { return this._toolUseNames; }

  get verbose(): boolean { return this.config.verbose; }

  effectiveWidth(fallback = W): number {
    return (this.getColumns() ?? fallback) - (this.verbose ? VERBOSE_PREFIX_LEN : 0);
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
    const inputPrint = this.inputPrint;
    if (inputPrint) {
      // ask() is active: erase from current cursor position to end of screen
      // (clears the prompt, suggestion row, and status bars), write the new
      // content line, then let drawFresh redraw the prompt + status bars below.
      const inputClear = this.inputClear;
      if (inputClear) {
        inputClear();
      } else {
        process.stdout.write("\r\x1b[J");
      }
      this._printLine(line);
      inputPrint();
      return;
    }
    this.clearBar();
    this._printLine(line);
    this.drawBar();
  }

  /** Print a single content block from an assistant/user message. */
  printBlock(b: ContentBlock, role: "assistant" | "user", msg?: Record<string, unknown>): void {
    if (b.type === "tool_use") {
      const tu = b as ToolUseBlock;
      this._toolUseNames.set(tu.id, tu.name);
      this._toolUseInputs.set(tu.id, tu.input);
      this.print(this.renderer.formatToolCall(tu));
      return;
    }
    if (b.type === "tool_result") {
      const tr = b as ToolResultBlock;
      const name = this._toolUseNames.get(tr.tool_use_id) ?? "";
      const _input = this._toolUseInputs.get(tr.tool_use_id);
      this.print(this.renderer.formatToolResult({ ...tr, _input }, name, msg));
      // Fire after the tool result is printed — tool has just finished running.
      this.agentStatus.fireOnToolResult(name);
      return;
    }
    this.print(this.renderer.formatContentBlock(b, role, !!(msg?.isSynthetic), this.config.thinkOutLoud));
  }

  /** Print a full SDK message (system, assistant, user, result, etc.). */
  printMessage(msg: unknown): void {
    if (msg === null || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;

    if (m.parent_tool_use_id != null) return;

    if (m.type === "system") {
      const subtype = typeof m.subtype === "string" ? m.subtype : "_default";
      if (subtype === "task_started" || subtype === "task_notification" || subtype === "task_progress") {
        if (m.skip_transcript === true) return;
        const toolUseId = typeof m.tool_use_id === "string" ? m.tool_use_id : null;
        if (toolUseId != null) {
          const toolName = this._toolUseNames.get(toolUseId);
          if (toolName !== undefined && toolName !== "Agent") return;
        }
      }
      this.print(this.renderer.formatSystemEvent(subtype, m));
      return;
    }

    if (m.type === "assistant" || m.type === "user") {
      const role = m.type as "assistant" | "user";
      const message = m.message as { content?: ContentBlock[] } | undefined;
      const content = message?.content ?? [];
      if (!content.length) { this.print(this.renderer.formatMessageEvent("_empty", m)); return; }
      for (const b of content) this.printBlock(b, role, m);
      return;
    }

    const type = typeof m.type === "string" ? m.type : "_default";
    this.print(this.renderer.formatMessageEvent(type, m));
  }

  /** Print a foreman→worker wire message. */
  printForemanMessage(msg: Wire.ForemanMessage): void {
    this.print(this.renderer.formatForemanMessage(msg));
  }

  // ── Internal rendering helpers ─────────────────────────────────────────────

  private _lineCount(): number {
    const n = (this.active ? 1 : 0) + (this.persistentActive ? 1 : 0);
    return n === 2 ? 3 : n; // blank separator between the two bars when both active
  }

  /**
   * Clear all active status bar rows. No-ops when ask() owns the screen
   * (it handles its own redraws via the input callbacks).
   */
  clearBar(): void {
    if (this.inputPrint || this.inputStatus) return; // ask() owns the screen
    const n = this._lineCount();
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

  /**
   * Draw all active status bar rows. Routes through input callbacks when
   * ask() is active so the prompt area is updated without misaligning the cursor.
   */
  drawBar(): void {
    if (this.inputStatus) {
      // ask() is active and cursor is in the buffer area — use the status-aware
      // redraw that navigates back to the prompt line before redrawing.
      this.inputStatus();
      return;
    }
    if (this.inputPrint) {
      // ask() is active after display.print() — cursor is at a fresh new line.
      this.inputPrint();
      return;
    }
    const n = this._lineCount();
    if (n === 0) return;
    // Cursor is on the blank separator row. Draw each status line below it,
    // then return cursor to the blank separator row and hide it.
    let seq = "";
    if (this.active) seq += `\n\r${this._text}\x1b[K\x1b[0m`;
    if (this.active && this.persistentActive) seq += `\n\r\x1b[K`; // blank line between bars
    if (this.persistentActive) seq += `\n\r${this._persistentText}\x1b[K\x1b[0m`;
    seq += `\x1b[${n}A\r`;
    seq += "\x1b[?25l";  // hide cursor
    process.stdout.write(seq);
  }

  /**
   * Write the status bar rows starting from the current cursor position (no
   * leading blank separator). Returns the total number of extra rows written
   * (0 if no bars are active, or 1+n for blank-separator + n bar rows).
   * Called by ask() to integrate status bars into the prompt+suggestion area.
   */
  drawRaw(): number {
    const n = this._lineCount();
    if (n === 0) return 0;
    let seq = "\r\n\x1b[K"; // blank separator row
    if (this.active) seq += `\r\n${this._text}\x1b[K\x1b[0m`;
    if (this.active && this.persistentActive) seq += `\r\n\x1b[K`;
    if (this.persistentActive) seq += `\r\n${this._persistentText}\x1b[K\x1b[0m`;
    process.stdout.write(seq);
    return 1 + n; // blank separator + n bar rows
  }

  // ── Primary (animated) status bar ─────────────────────────────────────────

  /** Start the animated query-progress bar, polling getText() every 500ms. */
  startBar(getText: () => string): void {
    // Clear any existing interval before creating a new one. Without this, a
    // second startBar() call (e.g. after a tool-permission prompt restarts the
    // bar) leaves the old interval running with its stale getText closure. Two
    // intervals firing at the same 500ms cadence then alternate between
    // different getText outputs, producing the rapid back-and-forth blink
    // reported in issue #986.
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
    this.clearBar();
    this.active = true;
    this._getText = getText;
    this._text = getText();
    this.drawBar();
    this._interval = setInterval(() => {
      this.clearBar();
      this._text = this._getText!();
      this.drawBar();
    }, 500);
  }

  /** Stop the animated bar and redraw any persistent bar. */
  stopBar(): void {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
    this.clearBar();
    this.active = false;
    this._getText = null;
    this._text = "";
    this.drawBar();
  }

  // ── Persistent (worker) status bar ────────────────────────────────────────

  /**
   * Show the worker status bar. Renders immediately using the current state
   * and redraws automatically whenever agentStatus emits "change" or the
   * terminal is resized.
   */
  startPersistentBar(): void {
    this.clearBar();
    this.persistentActive = true;
    this._persistentText = this.renderer.fmtStatusBar(this.agentStatus, (this.getColumns() ?? W) - 1);
    this.drawBar();
    if (!this._resizeHandler) {
      this._resizeHandler = () => this._handleResize();
      process.stdout.on("resize", this._resizeHandler);
    }
  }

  /** Stop the persistent bar and redraw the primary bar if still active. */
  stopPersistentBar(): void {
    if (this._resizeHandler) {
      process.stdout.off("resize", this._resizeHandler);
      this._resizeHandler = null;
    }
    this.clearBar();
    this.persistentActive = false;
    this._persistentText = "";
    this.drawBar();
  }

  /** Handle terminal resize: recompute and redraw all active bars. */
  private _handleResize(): void {
    if (!this.persistentActive && !this.active) return;
    this.clearBar();
    // Erase from cursor (blank separator row) to end of screen. When the terminal
    // becomes narrower, the old wider status bar wraps into extra visual rows that
    // clearBar() (which only clears n logical rows) leaves behind as garbage.
    if (!this.inputPrint && !this.inputStatus) {
      process.stdout.write("\x1b[J");
    }
    if (this._getText) this._text = this._getText();
    this._persistentText = this.renderer.fmtStatusBar(this.agentStatus, (this.getColumns() ?? W) - 1);
    this.drawBar();
  }

  /** Refresh the persistent status line text and redraw. Called on agentStatus "change". */
  private _updatePersistent(): void {
    if (!this.persistentActive) return;
    this._persistentText = this.renderer.fmtStatusBar(this.agentStatus, (this.getColumns() ?? W) - 1);
    // When the animation interval is running and no interactive prompt is
    // active, skip the full clearBar+drawBar — the interval will pick up the
    // updated text on its next tick. This prevents extra clear/redraw cycles
    // between interval ticks that cause the status line to flicker (issue #986).
    // When inputStatus is set, ask() owns the screen and needs drawBar() to
    // fire its inputStatus callback for proper multiline-prompt redraw.
    if (this.active && !this.inputStatus) return;
    this.clearBar();
    this.drawBar();
  }
}
