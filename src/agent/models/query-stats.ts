import { EventEmitter } from "node:events";
import { pickWorkingVerb, fmtStats } from "../views/display.js";

// Structural type for stream events carrying token usage data.
// BetaRawMessageStreamEvent is a discriminated union; we access fields structurally.
export type QueryStreamEvent = {
  type: string;
  message?: { usage?: { input_tokens?: number } };
  usage?: { output_tokens?: number };
};

/**
 * Accumulates per-query token/turn statistics from stream events.
 * Picks its own working verb at construction and emits "change" whenever a
 * stat-bearing event is processed, so subscribers can react without polling.
 *
 * Usage:
 *   const stats = new QueryStats();
 *   stats.update(ev); // call for each message_start/message_delta/message_stop
 *   stats.getStatusText(); // formatted status bar text
 */
export class QueryStats extends EventEmitter {
  private _turns = 0;
  private _inputTokens = 0;
  private _completedOutputTokens = 0;
  private _currentOutputTokens = 0;
  private readonly _startTime: number;
  private readonly _workingVerb: string;

  constructor(startTime = Date.now()) {
    super();
    this._startTime = startTime;
    this._workingVerb = pickWorkingVerb();
  }

  get turns(): number { return this._turns; }
  get inputTokens(): number { return this._inputTokens; }
  get outputTokens(): number { return this._completedOutputTokens + this._currentOutputTokens; }
  get elapsedSecs(): number { return Math.floor((Date.now() - this._startTime) / 1000); }

  /**
   * Process a single top-level stream event. Emits "change" for stat-bearing
   * events (message_start, message_delta, message_stop); silently ignores others.
   */
  update(event: QueryStreamEvent): void {
    if (event.type === "message_start") {
      this._turns++;
      this._inputTokens += event.message?.usage?.input_tokens ?? 0;
    } else if (event.type === "message_delta") {
      this._currentOutputTokens = event.usage?.output_tokens ?? this._currentOutputTokens;
    } else if (event.type === "message_stop") {
      this._completedOutputTokens += this._currentOutputTokens;
      this._currentOutputTokens = 0;
    } else {
      return; // unrecognized event — no state change, no emission
    }
    this.emit("change");
  }

  /** Formatted status bar text for use with display.startStatus(). Styling is the caller's responsibility. */
  getStatusText(): string {
    const secs = this.elapsedSecs;
    const outTokens = this.outputTokens;
    return `${this._workingVerb}… ${fmtStats(secs, this._turns || undefined, outTokens || undefined, this._inputTokens || undefined)}`;
  }
}
