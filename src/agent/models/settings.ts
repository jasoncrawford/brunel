import { EventEmitter } from "node:events";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ModelInfo = { value: string; displayName: string; description: string };
export type FetchModelsFn = () => Promise<ModelInfo[]>;

// ── Settings ──────────────────────────────────────────────────────────────────

/** Owns the runtime-settable preferences (model, effort, and permissionMode) and operations on them.
 * Emits "change" whenever any setting is updated. */
export class Settings extends EventEmitter {
  // ── Effort levels ──────────────────────────────────────────────────────────

  static readonly EFFORT_LEVELS = [
    { value: "auto",   displayName: "Auto (default)", description: "Let Claude decide" },
    { value: "low",    displayName: "Low",            description: "Minimal thinking, fastest responses" },
    { value: "medium", displayName: "Medium",         description: "Moderate thinking" },
    { value: "high",   displayName: "High",           description: "Deep reasoning" },
    { value: "max",    displayName: "Max",            description: "Maximum effort" },
  ] as const;

  /** The valid effort values accepted as config/CLI input (excludes "auto"). */
  static readonly VALID_EFFORT_VALUES = ["low", "medium", "high", "max"] as const;

  // ── Permission modes ───────────────────────────────────────────────────────

  static readonly PERMISSION_MODES = [
    { value: "default" as PermissionMode,           displayName: "Default",           description: "Ask for permission on each tool use" },
    { value: "acceptEdits" as PermissionMode,       displayName: "Accept Edits",      description: "Auto-approve file edits, ask for other tools" },
    { value: "plan" as PermissionMode,              displayName: "Plan",              description: "Auto-approve planning, ask for file/tool use" },
    { value: "dontAsk" as PermissionMode,           displayName: "Don't Ask",         description: "Skip prompts, let the agent decide" },
    { value: "bypassPermissions" as PermissionMode, displayName: "Bypass",            description: "Auto-approve all tools without asking" },
  ] as const;

  // ── Matching ───────────────────────────────────────────────────────────────

  /**
   * Find a model by exact value match. SDK values are short aliases like
   * "default", "opus", "haiku" (and "sonnet[1m]", "opus[1m]").
   */
  static findModel(models: ModelInfo[], input: string): ModelInfo | undefined {
    return models.find(m => m.value === input);
  }

  // ── Instance ───────────────────────────────────────────────────────────────

  private _model: string | undefined;
  private _effort: EffortValue | undefined;
  private _permissionMode: PermissionMode | undefined;
  private _cachedModels: ModelInfo[] | null = null;

  constructor(initial: { model?: string; effort?: EffortValue; permissionMode?: PermissionMode } = {}) {
    super();
    this._model = initial.model;
    this._effort = initial.effort;
    this._permissionMode = initial.permissionMode;
  }

  get model(): string | undefined { return this._model; }
  get effort(): EffortValue | undefined { return this._effort; }
  get permissionMode(): PermissionMode | undefined { return this._permissionMode; }

  _setModel(v: string | undefined): void { this._model = v; this.emit("change"); }
  _setEffort(v: EffortValue | undefined): void { this._effort = v; this.emit("change"); }
  _setPermissionMode(v: PermissionMode | undefined): void { this._permissionMode = v; this.emit("change"); }

  /** Returns the cached model list, or null if no query has been run yet. */
  getCachedModels(): ModelInfo[] | null { return this._cachedModels; }

  /** Update the cached models list (called from runQuery). */
  setCachedModels(models: ModelInfo[]): void { this._cachedModels = models; }
}

export type EffortValue = typeof Settings.VALID_EFFORT_VALUES[number];
