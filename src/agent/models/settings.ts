import { EventEmitter } from "node:events";
import { c } from "../views/display.js";
import type { PickResult } from "../views/input.js";

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
type PickFn = (options: string[], currentIdx: number) => Promise<PickResult>;

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

  private _setModel(v: string | undefined): void { this._model = v; this.emit("change"); }
  private _setEffort(v: EffortValue | undefined): void { this._effort = v; this.emit("change"); }

  /** Handle the /model command: show a picker or set directly from an argument. */
  async pickModel(
    args: string,
    pickFn: PickFn,
    fetchModelsFn: FetchModelsFn | undefined,
    print: (msg: string) => void,
  ): Promise<void> {
    // Ensure models are loaded
    if (!_cachedModels && fetchModelsFn) {
      try {
        _cachedModels = await fetchModelsFn();
      } catch {
        // fall through with null cache
      }
    }
    const models = _cachedModels;

    // Direct set: /model <alias-or-id>
    if (args) {
      if (args === "default" || args === "sonnet") {
        print(c.darkGray("Model set to default."));
        this._setModel(undefined);
        return;
      }
      if (models) {
        const match = findModel(models, args);
        if (match) {
          print(c.darkGray(`Model set to ${match.displayName}.`));
          this._setModel(match.value);
          return;
        }
        // Unknown model — warn but accept (power-user escape hatch)
        const names = models.map(m => m.value).join(", ");
        print(c.amber(`Warning: "${args}" is not a known model. Known models: ${names}`));
        print(c.darkGray(`Model set to ${args}.`));
        this._setModel(args);
        return;
      }
      // No cache — accept as-is
      print(c.darkGray(`Model set to ${args}.`));
      this._setModel(args);
      return;
    }

    // Interactive picker
    if (!models || models.length === 0) {
      print(c.amber("No model list available yet. Run a query first, or use /model <name>."));
      return;
    }

    // Build options from SDK model list — known models only, no "Other".
    const options: string[] = [];
    let currentIdx = -1;
    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      const desc = m.description ? ` \u00b7 ${m.description}` : "";
      options.push(`${m.displayName}${desc}`);
      if (m.value === this._model) currentIdx = i;
    }
    // If model is undefined (default), mark the first entry as current
    if (this._model === undefined) currentIdx = 0;

    print(c.yellow("\nSelect model:"));
    const result = await pickFn(options, currentIdx);

    if (result.type !== "selected") return;

    // Selected a model from the list
    const chosen = models[result.index];
    if (result.index === 0 && this._model === undefined) return; // already on default, no-op
    // Selecting the first (default/recommended) entry resets to undefined
    if (result.index === 0) {
      print(c.darkGray(`Model set to ${chosen.displayName}.`));
      this._setModel(undefined);
      return;
    }
    print(c.darkGray(`Model set to ${chosen.displayName}.`));
    this._setModel(chosen.value);
  }

  /** Handle the /effort command: show a picker or set directly from an argument. */
  async pickEffort(
    args: string,
    pickFn: PickFn,
    print: (msg: string) => void,
  ): Promise<void> {
    // Direct set: /effort <level>
    if (args) {
      if (args === "auto") {
        print(c.darkGray("Effort set to auto (default)."));
        this._setEffort(undefined);
        return;
      }
      const match = EFFORT_LEVELS.find(l => l.value === args);
      if (match && match.value !== "auto") {
        print(c.darkGray(`Effort set to ${match.value}.`));
        this._setEffort(match.value as EffortValue);
        return;
      }
      // Unknown level — reject (unlike model, effort is a closed set)
      const names = EFFORT_LEVELS.map(l => l.value).join(", ");
      print(c.amber(`Unknown effort level "${args}". Valid levels: ${names}`));
      return;
    }

    // Interactive picker
    const options: string[] = [];
    let currentIdx = 0;
    for (let i = 0; i < EFFORT_LEVELS.length; i++) {
      const l = EFFORT_LEVELS[i];
      const desc = l.description ? ` · ${l.description}` : "";
      options.push(`${l.displayName}${desc}`);
      if (l.value === (this._effort ?? "auto")) currentIdx = i;
    }

    print(c.yellow("\nSelect effort level:"));
    const result = await pickFn(options, currentIdx);

    if (result.type !== "selected") return;

    const chosen = EFFORT_LEVELS[result.index];
    if (chosen.value === "auto") {
      if (this._effort === undefined) return; // already auto, no-op
      print(c.darkGray(`Effort set to auto (default).`));
      this._setEffort(undefined);
      return;
    }
    print(c.darkGray(`Effort set to ${chosen.value}.`));
    this._setEffort(chosen.value as EffortValue);
  }
}
