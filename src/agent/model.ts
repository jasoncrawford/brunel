import * as display from "./display.js";
import type { PickResult } from "./input.js";
import type { CommandRegistry } from "./commands.js";

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
 * Find a model by exact value match. SDK values are short aliases like
 * "default", "opus", "haiku" (and "sonnet[1m]", "opus[1m]").
 */
export function findModel(models: ModelInfo[], input: string): ModelInfo | undefined {
  return models.find(m => m.value === input);
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

// ── Registration ─────────────────────────────────────────────────────────────

export type ModelCommandDeps = {
  getCurrentModel: () => string | undefined;
  setCurrentModel: (m: string | undefined) => void;
  fetchModelsFn: FetchModelsFn | undefined;
  pickFn: (opts: string[], idx: number) => Promise<PickResult>;
  print: (msg: string) => void;
};

/**
 * Register the /model command into the given registry.
 * Called from index.ts at startup with closures over mutable model state.
 */
export function registerModelCommand(registry: CommandRegistry, deps: ModelCommandDeps): void {
  registry.register("model", {
    description: "Select the Claude model to use",
    handler: async (args) => {
      const newModel = await handleModelCommand(
        args,
        deps.getCurrentModel(),
        deps.pickFn,
        deps.fetchModelsFn,
        deps.print,
      );
      deps.setCurrentModel(newModel);
    },
  });
}
