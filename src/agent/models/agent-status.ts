import { exec } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomInt } from "node:crypto";
import { promisify } from "node:util";
import type { Settings } from "./settings.js";
import type { EffortValue } from "./settings.js";

const execAsync = promisify(exec);

const WORKER_NAMES = [
  "abner", "adelaide", "albert", "alden", "alfred", "amelia", "amity", "amos",
  "andrew", "arthur", "asa", "augustus", "aurelia", "beatrice", "benjamin",
  "boaz", "caleb", "calvin", "cassandra", "cassius", "cecilia", "charity",
  "charlotte", "chauncey", "clara", "clarence", "clement", "constance",
  "cornelius", "cressida", "daniel", "deliverance", "dinah", "ebenezer",
  "edmund", "edwin", "eleanor", "elihu", "endeavour", "ephraim", "ernest",
  "esther", "experience", "ezekiel", "faith", "felicity", "frances",
  "franklin", "frederick", "gideon", "grace", "harold", "harriet", "henry",
  "herbert", "hezekiah", "hiram", "honour", "hope", "horatio", "humility",
  "ichabod", "increase", "jedediah", "jeremiah", "jethro", "josephine",
  "justice", "lavinia", "lawrence", "lemuel", "levi", "lucius", "lydia",
  "mabel", "martha", "matilda", "mercy", "micah", "miles", "naomi", "obadiah",
  "oliver", "parthenia", "patience", "peregrine", "perseverance", "philip",
  "phineas", "priscilla", "prosper", "prudence", "resolve", "rosalind",
  "roscoe", "rufus", "rupert", "ruth", "silas", "simon", "susannah", "tabitha",
  "temperance", "thaddeus", "thankful", "theodore", "theophilus", "titus",
  "tobias", "verity", "victor", "violet", "warren", "zephaniah",
];

// ── Worker status types ────────────────────────────────────────────────────────

export type WorkerConnectionStatus = "connected" | "disconnected" | "reconnecting" | "handshaking";

export type WorkerStatusPatch = {
  connectionStatus?: WorkerConnectionStatus;
  disconnectCode?: number | undefined;
  reconnectAt?: number | undefined;
  taskNumber?: number | undefined;
  prNumber?: number | undefined;
  branch?: string;
  model?: string | undefined;
  effort?: EffortValue | undefined;
  pendingEventsCount?: number;
  eventsPaused?: boolean;
  workerReady?: boolean;
};

// ── AgentStatus class ─────────────────────────────────────────────────────────

/**
 * Pure state model for worker status. Holds all worker status state
 * (connection, task, model, etc.) and emits "change" on updates. No
 * rendering, no screen geometry, no redraw callbacks. Analogous to
 * Settings on the agent side.
 *
 * Construct in the entry point and inject into Display and WorkerSession.
 * Display subscribes to "change" events for reactive status bar redraws.
 */
export class AgentStatus extends EventEmitter {
  private _agentId: string;
  private _connectionStatus: WorkerConnectionStatus = "disconnected";
  private _disconnectCode: number | undefined;
  private _reconnectAt: number | undefined;
  private _taskNumber: number | undefined;
  private _prNumber: number | undefined;
  private _branch = "";
  private _model: string | undefined;
  private _effort: EffortValue | undefined;
  private _countdownTimer: ReturnType<typeof setInterval> | null = null;
  private _taskInputTokens = 0;
  private _taskOutputTokens = 0;
  private _taskCostUsd: number | undefined;
  private _workerModeActive = false;
  private _pendingEventsCount = 0;
  private _eventsPaused = false;
  private _workerReady = false;

  // Fired after a tool result is printed (tool has just finished running).
  // Used by the worker to refresh git branch in the status bar after Bash.
  private _onToolResult: ((toolName: string) => void) | null = null;

  constructor({ agentId, settings, ...initial }: { agentId?: string; settings?: Settings } & Omit<WorkerStatusPatch, "reconnectAt">) {
    super();
    this._agentId = agentId ?? AgentStatus.generateAgentId();
    if ("connectionStatus" in initial) this._connectionStatus = initial.connectionStatus!;
    if ("disconnectCode" in initial) this._disconnectCode = initial.disconnectCode;
    if ("taskNumber" in initial) this._taskNumber = initial.taskNumber;
    if ("prNumber" in initial) this._prNumber = initial.prNumber;
    if ("branch" in initial) this._branch = initial.branch!;
    if ("model" in initial) this._model = initial.model;
    if ("effort" in initial) this._effort = initial.effort;
    if (settings) {
      this._model = settings.model;
      this._effort = settings.effort;
      settings.on("change", () => {
        this._model = settings.model;
        this._effort = settings.effort;
        this.emit("change");
      });
    }
  }

  // ── Worker status getters ──────────────────────────────────────────────────

  get agentId(): string { return this._agentId; }
  get connectionStatus(): WorkerConnectionStatus { return this._connectionStatus; }
  get disconnectCode(): number | undefined { return this._disconnectCode; }
  get reconnectAt(): number | undefined { return this._reconnectAt; }
  get taskNumber(): number | undefined { return this._taskNumber; }
  get prNumber(): number | undefined { return this._prNumber; }
  get branch(): string { return this._branch; }
  get model(): string | undefined { return this._model; }
  get effort(): EffortValue | undefined { return this._effort; }
  get taskInputTokens(): number { return this._taskInputTokens; }
  get taskOutputTokens(): number { return this._taskOutputTokens; }
  get taskCostUsd(): number | undefined { return this._taskCostUsd; }
  get workerModeActive(): boolean { return this._workerModeActive; }
  get pendingEventsCount(): number { return this._pendingEventsCount; }
  get eventsPaused(): boolean { return this._eventsPaused; }
  get workerReady(): boolean { return this._workerReady; }

  /** Apply a partial status update and emit "change". */
  update(patch: WorkerStatusPatch): void {
    if ("connectionStatus" in patch) this._connectionStatus = patch.connectionStatus!;
    if ("disconnectCode" in patch) this._disconnectCode = patch.disconnectCode;
    if ("reconnectAt" in patch) {
      this._reconnectAt = patch.reconnectAt;
      this._syncCountdownTimer();
    }
    if ("taskNumber" in patch) this._taskNumber = patch.taskNumber;
    if ("prNumber" in patch) this._prNumber = patch.prNumber;
    if ("branch" in patch) this._branch = patch.branch!;
    if ("model" in patch) this._model = patch.model;
    if ("effort" in patch) this._effort = patch.effort;
    if ("pendingEventsCount" in patch) this._pendingEventsCount = patch.pendingEventsCount!;
    if ("eventsPaused" in patch) this._eventsPaused = patch.eventsPaused!;
    if ("workerReady" in patch) this._workerReady = patch.workerReady!;
    this.emit("change");
  }

  /** Accumulate per-query token/cost stats into the running task totals and emit "change". */
  addQueryStats(inputTokens: number, outputTokens: number, costUsd: number | undefined): void {
    this._taskInputTokens += inputTokens;
    this._taskOutputTokens += outputTokens;
    if (costUsd != null) {
      this._taskCostUsd = (this._taskCostUsd ?? 0) + costUsd;
    }
    this.emit("change");
  }

  /** Change the agent ID (used by /worker:resume to assume a dead worker's identity) and emit "change". */
  setAgentId(id: string): void {
    this._agentId = id;
    this.emit("change");
  }

  /** Set whether worker mode is active and emit "change". */
  setWorkerModeActive(active: boolean): void {
    this._workerModeActive = active;
    this.emit("change");
  }

  /** Reset per-task token/cost accumulators and emit "change". */
  resetTaskStats(): void {
    this._taskInputTokens = 0;
    this._taskOutputTokens = 0;
    this._taskCostUsd = undefined;
    this.emit("change");
  }

  private _syncCountdownTimer(): void {
    if (this._reconnectAt != null) {
      if (!this._countdownTimer) {
        this._countdownTimer = setInterval(() => {
          this.emit("change");
        }, 1000);
      }
    } else {
      if (this._countdownTimer) {
        clearInterval(this._countdownTimer);
        this._countdownTimer = null;
      }
    }
  }

  // ── Tool result callback ───────────────────────────────────────────────────

  setOnToolResult(fn: ((toolName: string) => void) | null): void {
    this._onToolResult = fn;
  }

  /** Invoke the tool-result callback (if registered) with the tool name. */
  fireOnToolResult(name: string): void {
    this._onToolResult?.(name);
  }

  /** Refresh the branch field from the current git repo. */
  async refreshBranch(): Promise<void> {
    this.update({ branch: await AgentStatus.getCurrentBranch() });
  }

  // ── Static git/id utilities ────────────────────────────────────────────────

  /** Returns the current git branch name, or "" on any error. */
  static async getCurrentBranch(): Promise<string> {
    try {
      const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD");
      return stdout.trim();
    } catch {
      return "";
    }
  }

  /**
   * Returns the repo in "owner/name" format by parsing the git remote origin URL.
   * Handles both HTTPS (https://github.com/owner/repo.git) and SSH
   * (git@github.com:owner/repo.git) URL formats. Returns "" on any error.
   */
  static async getRemoteRepo(): Promise<string> {
    try {
      const { stdout } = await execAsync("git remote get-url origin");
      const url = stdout.trim();
      const match = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
      return match ? match[1] : "";
    } catch {
      return "";
    }
  }

  /** Generate a human-readable agent ID by prepending a random human name to a UUID.
   * E.g. "patience-a9bdda00-1234-5678-abcd-ef0123456789" */
  static generateAgentId(): string {
    const idx = randomInt(WORKER_NAMES.length);
    return `${WORKER_NAMES[idx]}-${crypto.randomUUID()}`;
  }
}
