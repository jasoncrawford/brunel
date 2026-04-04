import * as display from "./display.js";
import type { PickResult } from "./input.js";

// ── Model cache ──────────────────────────────────────────────────────────────

export type ModelInfo = { value: string; displayName: string; description: string };
let _cachedModels: ModelInfo[] | null = null;

/** Returns the cached model list, or null if no query has been run yet. */
export function getCachedModels(): ModelInfo[] | null { return _cachedModels; }

/** Update the cached models list (called from runQuery). */
export function setCachedModels(models: ModelInfo[]): void { _cachedModels = models; }

/** Reset the cached models (for testing). */
export function _resetCachedModels(): void { _cachedModels = null; }

// ── Matching ─────────────────────────────────────────────────────────────────

/**
 * Find a model by value match. SDK values are short aliases like "sonnet",
 * "opus", "haiku" (and "sonnet[1m]", "opus[1m]"). The Default entry has
 * value:null, which is skipped.
 *
 * Tries in order:
 * 1. Exact match (e.g. "sonnet" or "opus[1m]")
 * 2. Input contains value as substring (e.g. "claude-sonnet-4-6" contains "sonnet")
 */
export function findModel(models: ModelInfo[], input: string): ModelInfo | undefined {
  const valid = models.filter(m => typeof m.value === "string");
  return valid.find(m => m.value === input)
    ?? valid.find(m => input.includes(m.value));
}

// ── Model selection ──────────────────────────────────────────────────────────

export type FetchModelsFn = () => Promise<ModelInfo[]>;

/** Resolve a model string: return the matched alias value if known, or the raw string. */
function resolveModel(models: ModelInfo[], input: string): { value: string; displayName: string } {
  const match = findModel(models, input);
  if (match) return { value: match.value, displayName: match.displayName };
  return { value: input, displayName: input };
}

/**
 * Validate a model string against the supported models list. Returns an error
 * message if invalid, or undefined if valid. A model is valid if it matches a
 * known alias or looks like a full model ID (contains "claude-").
 */
export function validateModel(models: ModelInfo[], input: string): string | undefined {
  if (findModel(models, input)) return undefined;
  if (input.includes("claude-")) return undefined;
  const valid = models.filter(m => typeof m.value === "string");
  const names = valid.map(m => m.value).join(", ");
  return `Unknown model "${input}". Valid options: ${names}, or a full model ID (e.g. claude-sonnet-4-6-20250514).`;
}

/**
 * Validate the configured model at startup. Fetches the model list and checks
 * the model string. Returns the (possibly resolved) model value, or calls
 * onError and returns undefined.
 */
export async function validateConfigModel(
  model: string,
  fetchModelsFn: FetchModelsFn,
  onError: (msg: string) => void,
): Promise<string | undefined> {
  let models: ModelInfo[];
  try {
    models = await fetchModelsFn();
    setCachedModels(models);
  } catch {
    // Can't fetch model list — skip validation, accept as-is
    return model;
  }
  const error = validateModel(models, model);
  if (error) {
    onError(error);
    return undefined;
  }
  return resolveModel(models, model).value;
}

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
    if (args === "default") {
      print(display.c.darkGray("Model set to default."));
      return undefined;
    }
    if (models) {
      const error = validateModel(models, args);
      if (error) {
        print(display.c.boldRed(error));
        return currentModel;
      }
      const { value, displayName } = resolveModel(models, args);
      print(display.c.darkGray(`Model set to ${displayName}.`));
      return value;
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

  // Build options from SDK model list (no separate "Default" entry — the SDK
  // includes a default/recommended entry already).
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
  options.push("Other:");

  print(display.c.yellow("\nSelect model:"));
  const result = await pickModelFn(options, currentIdx);

  if (result.type === "cancelled") {
    return currentModel;
  }

  if (result.type === "other") {
    if (!result.text) return currentModel;
    // "Other" accepts any string — for entering full model IDs not in the
    // standard list (e.g. claude-sonnet-4-6-20250514). Resolve to alias if
    // recognized, otherwise pass through as-is.
    const { value, displayName } = resolveModel(models, result.text);
    print(display.c.darkGray(`Model set to ${displayName}.`));
    return value;
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
