import * as display from "./display.js";
import type { PickResult } from "./input.js";
import type { CommandRegistry } from "./commands.js";

// ── Effort levels ───────────────────────────────────────────────────────────

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

// ── Effort selection ────────────────────────────────────────────────────────

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

// ── Registration ─────────────────────────────────────────────────────────────

export type EffortCommandDeps = {
  getCurrentEffort: () => EffortValue | undefined;
  setCurrentEffort: (e: EffortValue | undefined) => void;
  pickFn: (opts: string[], idx: number) => Promise<PickResult>;
  print: (msg: string) => void;
};

/**
 * Register the /effort command into the given registry.
 * Called from index.ts at startup with closures over mutable effort state.
 */
export function registerEffortCommand(registry: CommandRegistry, deps: EffortCommandDeps): void {
  registry.register("effort", {
    description: "Set the effort level for Claude's thinking",
    handler: async (args) => {
      const newEffort = await handleEffortCommand(
        args,
        deps.getCurrentEffort(),
        deps.pickFn,
        deps.print,
      );
      deps.setCurrentEffort(newEffort);
    },
  });
}
