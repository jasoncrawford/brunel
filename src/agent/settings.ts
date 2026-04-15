import * as display from "./display.js";
import type { PickResult } from "./input.js";

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

// ── Effort selection ─────────────────────────────────────────────────────────

/**
 * Handle the /effort command: show a picker or set directly from an argument.
 * Returns the new effort value (undefined = auto/default).
 */
export async function handleEffortCommand(
  args: string,
  currentEffort: EffortValue | undefined,
  pickEffortFn: (options: string[], currentIdx: number) => Promise<PickResult>,
  print: (msg: string) => void,
): Promise<EffortValue | undefined> {
  // Direct set: /effort <level>
  if (args) {
    if (args === "auto") {
      print(display.c.darkGray("Effort set to auto (default)."));
      return undefined;
    }
    const match = EFFORT_LEVELS.find(l => l.value === args);
    if (match && match.value !== "auto") {
      print(display.c.darkGray(`Effort set to ${match.value}.`));
      return match.value as EffortValue;
    }
    // Unknown level — reject (unlike model, effort is a closed set)
    const names = EFFORT_LEVELS.map(l => l.value).join(", ");
    print(display.c.amber(`Unknown effort level "${args}". Valid levels: ${names}`));
    return currentEffort;
  }

  // Interactive picker
  const options: string[] = [];
  let currentIdx = 0;
  for (let i = 0; i < EFFORT_LEVELS.length; i++) {
    const l = EFFORT_LEVELS[i];
    const desc = l.description ? ` · ${l.description}` : "";
    options.push(`${l.displayName}${desc}`);
    if (l.value === (currentEffort ?? "auto")) currentIdx = i;
  }

  print(display.c.yellow("\nSelect effort level:"));
  const result = await pickEffortFn(options, currentIdx);

  if (result.type !== "selected") {
    return currentEffort;
  }

  const chosen = EFFORT_LEVELS[result.index];
  if (chosen.value === "auto") {
    if (currentEffort === undefined) return currentEffort; // already auto, no-op
    print(display.c.darkGray(`Effort set to auto (default).`));
    return undefined;
  }
  print(display.c.darkGray(`Effort set to ${chosen.value}.`));
  return chosen.value as EffortValue;
}

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

// ── Model selection ───────────────────────────────────────────────────────────

export type FetchModelsFn = () => Promise<ModelInfo[]>;

/**
 * Handle the /model command: show a picker or set directly from an argument.
 * Returns the new model value (undefined = default).
 */
export async function handleModelCommand(
  args: string,
  currentModel: string | undefined,
  pickModelFn: (options: string[], currentIdx: number) => Promise<PickResult>,
  fetchModelsFn: FetchModelsFn | undefined,
  print: (msg: string) => void,
): Promise<string | undefined> {
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
      print(display.c.darkGray("Model set to default."));
      return undefined;
    }
    if (models) {
      const match = findModel(models, args);
      if (match) {
        print(display.c.darkGray(`Model set to ${match.displayName}.`));
        return match.value;
      }
      // Unknown model — warn but accept (power-user escape hatch)
      const names = models.map(m => m.value).join(", ");
      print(display.c.amber(`Warning: "${args}" is not a known model. Known models: ${names}`));
      print(display.c.darkGray(`Model set to ${args}.`));
      return args;
    }
    // No cache — accept as-is
    print(display.c.darkGray(`Model set to ${args}.`));
    return args;
  }

  // Interactive picker
  if (!models || models.length === 0) {
    print(display.c.amber("No model list available yet. Run a query first, or use /model <name>."));
    return currentModel;
  }

  // Build options from SDK model list — known models only, no "Other".
  const options: string[] = [];
  let currentIdx = -1;
  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const desc = m.description ? ` \u00b7 ${m.description}` : "";
    options.push(`${m.displayName}${desc}`);
    if (m.value === currentModel) currentIdx = i;
  }
  // If currentModel is undefined (default), mark the first entry as current
  if (currentModel === undefined) currentIdx = 0;

  print(display.c.yellow("\nSelect model:"));
  const result = await pickModelFn(options, currentIdx);

  if (result.type !== "selected") {
    return currentModel;
  }

  // Selected a model from the list
  const chosen = models[result.index];
  if (result.index === 0 && currentModel === undefined) {
    // Already on default, no change
    return currentModel;
  }
  // Selecting the first (default/recommended) entry resets to undefined
  if (result.index === 0) {
    print(display.c.darkGray(`Model set to ${chosen.displayName}.`));
    return undefined;
  }
  print(display.c.darkGray(`Model set to ${chosen.displayName}.`));
  return chosen.value;
}

// ── Settings ──────────────────────────────────────────────────────────────────

type PickFn = (options: string[], currentIdx: number) => Promise<PickResult>;

/** Owns the runtime-settable preferences (model and effort) and operations on them. */
export class Settings {
  private _model: string | undefined;
  private _effort: EffortValue | undefined;

  constructor(initial: { model?: string; effort?: EffortValue } = {}) {
    this._model = initial.model;
    this._effort = initial.effort;
  }

  get model(): string | undefined { return this._model; }
  get effort(): EffortValue | undefined { return this._effort; }

  async pickModel(
    args: string,
    pickFn: PickFn,
    fetchModelsFn: FetchModelsFn | undefined,
    print: (msg: string) => void,
  ): Promise<void> {
    this._model = await handleModelCommand(args, this._model, pickFn, fetchModelsFn, print);
  }

  async pickEffort(
    args: string,
    pickFn: PickFn,
    print: (msg: string) => void,
  ): Promise<void> {
    this._effort = await handleEffortCommand(args, this._effort, pickFn, print);
  }
}
