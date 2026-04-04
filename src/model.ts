import * as display from "./display.js";

// ── Model cache ──────────────────────────────────────────────────────────────

export type ModelInfo = { value: string; displayName: string; description: string };
let _cachedModels: ModelInfo[] | null = null;

/** Returns the cached model list, or null if no query has been run yet. */
export function getCachedModels(): ModelInfo[] | null { return _cachedModels; }

/** Update the cached models list (called from runQuery). */
export function setCachedModels(models: ModelInfo[]): void { _cachedModels = models; }

/** Reset the cached models (for testing). */
export function _resetCachedModels(): void { _cachedModels = null; }

// ── Model selection ──────────────────────────────────────────────────────────

/**
 * Handle the /model command: show a picker or set directly from an argument.
 * Returns the new model value (undefined = default).
 */
export async function handleModelCommand(
  args: string,
  currentModel: string | undefined,
  pickFn: (options: string[]) => Promise<number>,
  askFn: (prompt: string) => Promise<string>,
  print: (msg: string) => void,
): Promise<string | undefined> {
  const models = _cachedModels;

  // Direct set: /model <alias-or-id>
  if (args) {
    if (args === "default") {
      print(display.c.darkGray("Model set to default."));
      return undefined;
    }
    // Validate against cached models if available
    if (models) {
      const match = models.find(
        m => m.value === args || m.value.startsWith(`claude-${args}`)
      );
      if (match) {
        print(display.c.darkGray(`Model set to ${match.displayName}.`));
        return match.value;
      }
      print(display.c.boldRed(`Unknown model "${args}". Use /model to see available options.`));
      return currentModel;
    }
    // No cache yet — accept the value as-is (validated by SDK on next query)
    print(display.c.darkGray(`Model set to ${args}.`));
    return args;
  }

  // Interactive picker
  if (!models || models.length === 0) {
    print(display.c.amber("No model list available yet. Run a query first, or use /model <name>."));
    return currentModel;
  }

  const options: string[] = [];
  const defaultLabel = currentModel ? "Default" : "Default (current)";
  options.push(defaultLabel);
  for (const m of models) {
    const isCurrent = m.value === currentModel;
    const label = `${m.displayName}${isCurrent ? " (current)" : ""}`;
    const desc = m.description ? ` — ${m.description}` : "";
    options.push(`${label}${desc}`);
  }
  options.push("Other\u2026");

  print(display.c.yellow("\nSelect model:"));
  const idx = await pickFn(options);

  // Default
  if (idx === 0) {
    print(display.c.darkGray("Model set to default."));
    return undefined;
  }

  // Other…
  if (idx === options.length - 1) {
    const value = await askFn("Model ID: ");
    if (!value || value === "__eof__") return currentModel;
    const match = models.find(m => m.value === value);
    if (!match) {
      print(display.c.boldRed(`Unknown model "${value}". Must be a full model ID (e.g. claude-sonnet-4-6).`));
      return currentModel;
    }
    print(display.c.darkGray(`Model set to ${match.displayName}.`));
    return match.value;
  }

  // Named model
  const chosen = models[idx - 1];
  print(display.c.darkGray(`Model set to ${chosen.displayName}.`));
  return chosen.value;
}
