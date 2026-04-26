import { EventEmitter } from "node:events";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Seconds of SDK silence before the status bar shows a stall warning and the watchdog logs it. */
export const STALL_THRESHOLD_SECS = 120;

// ── Working verbs ─────────────────────────────────────────────────────────────

const WORKING_VERBS = [
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

function pickWorkingVerb(): string {
  return WORKING_VERBS[Math.floor(Math.random() * WORKING_VERBS.length)];
}

// ── Format helpers (private to this module) ───────────────────────────────────

function fmtDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m${s}s`;
}

function fmtNum(n: number): string {
  if (n >= 1000) return `${parseFloat((n / 1000).toPrecision(3))}k`;
  return `${n}`;
}

function fmtCount(count: number, singular_noun: string, plural_noun?: string) {
  const noun = (count === 1) ? singular_noun : (plural_noun ?? `${singular_noun}s`);
  return `${count} ${noun}`;
}

function fmtStats(secs: number, turns?: number, outputTokens?: number, inputTokens?: number, costUsd?: number): string {
  const parts: string[] = [fmtDuration(secs)];
  if (turns) parts.push(fmtCount(turns, "turn"));
  if (outputTokens) {
    const tok = inputTokens != null ? `tokens: ${fmtNum(inputTokens)} in / ${fmtNum(outputTokens)} out` : `tokens: ${fmtNum(outputTokens)} out`;
    parts.push(tok);
  }
  if (costUsd != null) {
    parts.push(`cost: $${costUsd.toFixed(2)}`);
  }
  return parts.join(", ");
}

// Structural type for stream events carrying token usage data.
// BetaRawMessageStreamEvent is a discriminated union; we access fields structurally.
export type QueryStreamEvent = {
  type: string;
  message?: { usage?: { input_tokens?: number } };
  usage?: { output_tokens?: number };
  total_cost_usd?: number;
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
  private _costUsd: number | undefined;
  private readonly _startTime: number;
  private readonly _workingVerb: string;
  private _lastActivityTime: number;

  constructor(startTime = Date.now()) {
    super();
    this._startTime = startTime;
    this._lastActivityTime = startTime;
    this._workingVerb = pickWorkingVerb();
  }

  get turns(): number { return this._turns; }
  get inputTokens(): number { return this._inputTokens; }
  get outputTokens(): number { return this._completedOutputTokens + this._currentOutputTokens; }
  get costUsd(): number | undefined { return this._costUsd; }
  get elapsedSecs(): number { return Math.floor((Date.now() - this._startTime) / 1000); }
  get secsSinceLastActivity(): number { return Math.floor((Date.now() - this._lastActivityTime) / 1000); }

  /** Record that an SDK message was received; resets the stall timer. */
  noteActivity(): void {
    this._lastActivityTime = Date.now();
  }

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
    } else if (event.type === "result") {
      this._costUsd = event.total_cost_usd;
    } else {
      return; // unrecognized event — no state change, no emission
    }
    this.emit("change");
  }

  /** Formatted status bar text for use with display.startStatus(). Styling is the caller's responsibility. */
  getStatusText(): string {
    const secs = this.elapsedSecs;
    const outTokens = this.outputTokens;
    const stalled = this.secsSinceLastActivity;
    const stallSuffix = stalled >= STALL_THRESHOLD_SECS
      ? ` ⚠ no activity ${fmtDuration(stalled)}`
      : "";
    return `${this._workingVerb}… ${fmtStats(secs, this._turns || undefined, outTokens || undefined, this._inputTokens || undefined, this._costUsd)}${stallSuffix}`;
  }
}
