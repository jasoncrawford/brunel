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
 * Find a model by value match. Tries, in order:
 * 1. Exact match on value
 * 2. Value starts with input (e.g. input "claude-opus-4-6" matches "claude-opus-4-6-20250514")
 * 3. Input starts with value (e.g. input "claude-opus-4-6-20250514" matches value "claude-opus-4-6")
 * 4. Value starts with "claude-" + input (alias: "sonnet" → "claude-sonnet-*")
 * 5. Value contains input or input contains value (substring match)
 */
export function findModel(models: ModelInfo[], input: string): ModelInfo | undefined {
  return models.find(m => m.value === input)
    ?? models.find(m => m.value.startsWith(input))
    ?? models.find(m => input.startsWith(m.value))
    ?? models.find(m => m.value.startsWith(`claude-${input}`))
    ?? models.find(m => m.value.includes(input) || input.includes(m.value));
}

// ── Model selection ──────────────────────────────────────────────────────────

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
    if (args === "default") {
      print(display.c.darkGray("Model set to default."));
      return undefined;
    }
    if (models) {
      const match = findModel(models, args);
      if (match) {
        print(display.c.darkGray(`Model set to ${match.displayName}.`));
        return match.value;
      }
      print(display.c.boldRed(`Unknown model "${args}". Use /model to see available options.`));
      return currentModel;
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
    const match = findModel(models, result.text);
    if (!match) {
      print(display.c.boldRed(`Unknown model "${result.text}".`));
      return currentModel;
    }
    print(display.c.darkGray(`Model set to ${match.displayName}.`));
    return match.value;
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
