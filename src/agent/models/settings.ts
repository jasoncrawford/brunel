import { EventEmitter } from "node:events";

// ── Effort levels ────────────────────────────────────────────────────────────

export const EFFORT_LEVELS = [
  { value: "auto",   displayName: "Auto (default)", description: "Let Claude decide" },
  { value: "low",    displayName: "Low",            description: "Minimal thinking, fastest responses" },
  { value: "medium", displayName: "Medium",         description: "Moderate thinking" },
  { value: "high",   displayName: "High",           description: "Deep reasoning" },
  { value: "max",    displayName: "Max",            description: "Maximum effort" },
] as const;

/** The valid effort values accepted as config/CLI input (excludes "auto"). */
export const VALID_EFFORT_VALUES = ["low", "medium", "high", "max"] as const;
export type EffortValue = typeof VALID_EFFORT_VALUES[number];

// ── Model cache ───────────────────────────────────────────────────────────────

export type ModelInfo = { value: string; displayName: string; description: string };
let _cachedModels: ModelInfo[] | null = null;

/** Returns the cached model list, or null if no query has been run yet. */
export function getCachedModels(): ModelInfo[] | null { return _cachedModels; }

/** Update the cached models list (called from runQuery). */
export function setCachedModels(models: ModelInfo[]): void { _cachedModels = models; }

/** Reset the cached models (for testing). */
export function _resetCachedModels(): void { _cachedModels = null; }

// ── Matching ──────────────────────────────────────────────────────────────────

/**
 * Find a model by exact value match. SDK values are short aliases like
 * "default", "opus", "haiku" (and "sonnet[1m]", "opus[1m]").
 */
export function findModel(models: ModelInfo[], input: string): ModelInfo | undefined {
  return models.find(m => m.value === input);
}

// ── Settings ──────────────────────────────────────────────────────────────────

export type FetchModelsFn = () => Promise<ModelInfo[]>;

/** Owns the runtime-settable preferences (model and effort) and operations on them.
 * Emits "change" whenever model or effort is updated. */
export class Settings extends EventEmitter {
  private _model: string | undefined;
  private _effort: EffortValue | undefined;

  constructor(initial: { model?: string; effort?: EffortValue } = {}) {
    super();
    this._model = initial.model;
    this._effort = initial.effort;
  }

  get model(): string | undefined { return this._model; }
  get effort(): EffortValue | undefined { return this._effort; }

  _setModel(v: string | undefined): void { this._model = v; this.emit("change"); }
  _setEffort(v: EffortValue | undefined): void { this._effort = v; this.emit("change"); }
}
