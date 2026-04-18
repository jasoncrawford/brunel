import { c } from "../views/display.js";
import type { WorkerDisplay } from "./worker-controller.js";
import type { PickResult } from "../views/picker.js";
import { Settings } from "../models/settings.js";
import type { FetchModelsFn, EffortValue } from "../models/settings.js";

type PickFn = (options: string[], currentIdx: number) => Promise<PickResult>;

/**
 * Handles interactive model and effort selection for the /model and /effort
 * commands. Receives a Settings model and a display for output.
 */
export class SettingsController {
  constructor(
    private readonly settings: Settings,
    private readonly display: WorkerDisplay,
  ) {}

  /** Handle the /model command: show a picker or set directly from an argument. */
  async pickModel(
    args: string,
    pickFn: PickFn,
    fetchModelsFn: FetchModelsFn | undefined,
  ): Promise<void> {
    // Ensure models are loaded
    let models = Settings.getCachedModels();
    if (!models && fetchModelsFn) {
      try {
        models = await fetchModelsFn();
        Settings.setCachedModels(models);
      } catch {
        // fall through with null cache
      }
    }

    // Direct set: /model <alias-or-id>
    if (args) {
      if (args === "default" || args === "sonnet") {
        this.display.print(c.darkGray("Model set to default."));
        this.settings._setModel(undefined);
        return;
      }
      if (models) {
        const match = Settings.findModel(models, args);
        if (match) {
          this.display.print(c.darkGray(`Model set to ${match.displayName}.`));
          this.settings._setModel(match.value);
          return;
        }
        // Unknown model — warn but accept (power-user escape hatch)
        const names = models.map(m => m.value).join(", ");
        this.display.print(c.amber(`Warning: "${args}" is not a known model. Known models: ${names}`));
        this.display.print(c.darkGray(`Model set to ${args}.`));
        this.settings._setModel(args);
        return;
      }
      // No cache — accept as-is
      this.display.print(c.darkGray(`Model set to ${args}.`));
      this.settings._setModel(args);
      return;
    }

    // Interactive picker
    if (!models || models.length === 0) {
      this.display.print(c.amber("No model list available yet. Run a query first, or use /model <name>."));
      return;
    }

    // Build options from SDK model list — known models only, no "Other".
    const options: string[] = [];
    let currentIdx = -1;
    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      const desc = m.description ? ` \u00b7 ${m.description}` : "";
      options.push(`${m.displayName}${desc}`);
      if (m.value === this.settings.model) currentIdx = i;
    }
    // If model is undefined (default), mark the first entry as current
    if (this.settings.model === undefined) currentIdx = 0;

    this.display.print(c.yellow("\nSelect model:"));
    const result = await pickFn(options, currentIdx);

    if (result.type !== "selected") return;

    // Selected a model from the list
    const chosen = models[result.index];
    if (result.index === 0 && this.settings.model === undefined) return; // already on default, no-op
    // Selecting the first (default/recommended) entry resets to undefined
    if (result.index === 0) {
      this.display.print(c.darkGray(`Model set to ${chosen.displayName}.`));
      this.settings._setModel(undefined);
      return;
    }
    this.display.print(c.darkGray(`Model set to ${chosen.displayName}.`));
    this.settings._setModel(chosen.value);
  }

  /** Handle the /effort command: show a picker or set directly from an argument. */
  async pickEffort(
    args: string,
    pickFn: PickFn,
  ): Promise<void> {
    // Direct set: /effort <level>
    if (args) {
      if (args === "auto") {
        this.display.print(c.darkGray("Effort set to auto (default)."));
        this.settings._setEffort(undefined);
        return;
      }
      const match = Settings.EFFORT_LEVELS.find(l => l.value === args);
      if (match && match.value !== "auto") {
        this.display.print(c.darkGray(`Effort set to ${match.value}.`));
        this.settings._setEffort(match.value as EffortValue);
        return;
      }
      // Unknown level — reject (unlike model, effort is a closed set)
      const names = Settings.EFFORT_LEVELS.map(l => l.value).join(", ");
      this.display.print(c.amber(`Unknown effort level "${args}". Valid levels: ${names}`));
      return;
    }

    // Interactive picker
    const options: string[] = [];
    let currentIdx = 0;
    for (let i = 0; i < Settings.EFFORT_LEVELS.length; i++) {
      const l = Settings.EFFORT_LEVELS[i];
      const desc = l.description ? ` · ${l.description}` : "";
      options.push(`${l.displayName}${desc}`);
      if (l.value === (this.settings.effort ?? "auto")) currentIdx = i;
    }

    this.display.print(c.yellow("\nSelect effort level:"));
    const result = await pickFn(options, currentIdx);

    if (result.type !== "selected") return;

    const chosen = Settings.EFFORT_LEVELS[result.index];
    if (chosen.value === "auto") {
      if (this.settings.effort === undefined) return; // already auto, no-op
      this.display.print(c.darkGray(`Effort set to auto (default).`));
      this.settings._setEffort(undefined);
      return;
    }
    this.display.print(c.darkGray(`Effort set to ${chosen.value}.`));
    this.settings._setEffort(chosen.value as EffortValue);
  }
}
