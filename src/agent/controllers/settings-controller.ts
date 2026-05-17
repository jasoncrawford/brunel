import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { c } from "../views/style.js";
import type { WorkerDisplay } from "./worker-controller.js";
import type { PickResult, SettingsMenuEntry, SettingsMenuResult } from "../views/picker.js";
import { Settings } from "../models/settings.js";
import type { FetchModelsFn, EffortValue, ThinkOutLoudValue } from "../models/settings.js";
import type { CommandRegistry } from "./command-controller.js";

type PickFn = (options: string[], currentIdx: number) => Promise<PickResult>;
type SettingsPickFn = (entries: SettingsMenuEntry[], onCycle: (i: number, v: string) => void) => Promise<SettingsMenuResult>;

/**
 * Handles interactive selection for all settings commands (/settings:*).
 * Receives a Settings model and a display for output.
 */
export class SettingsController {
  constructor(
    private readonly settings: Settings,
    private readonly display: WorkerDisplay,
  ) {}

  /** Parse a boolean alias. Accepts true/on/yes/y and false/off/no/n (case-insensitive). */
  static parseBool(args: string): boolean | undefined {
    switch (args.toLowerCase()) {
      case "true": case "on": case "yes": case "y": return true;
      case "false": case "off": case "no": case "n": return false;
      default: return undefined;
    }
  }

  /** Handle the /model command: show a picker or set directly from an argument. */
  async pickModel(
    args: string,
    pickFn: PickFn,
    fetchModelsFn: FetchModelsFn | undefined,
  ): Promise<void> {
    // Ensure models are loaded
    let models = this.settings.getCachedModels();
    if (!models && fetchModelsFn) {
      try {
        models = await fetchModelsFn();
        this.settings.setCachedModels(models);
      } catch {
        // fall through with null cache
      }
    }

    // Direct set: /model <alias-or-id>
    if (args) {
      if (args === "default") {
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

    this.display.print(c.yellow("\nSelect model:"));
    const result = await pickFn(options, currentIdx);

    if (result.type !== "selected") return;

    const chosen = models[result.index];
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

  /** Handle the /permissions command: show a picker or set directly from an argument. */
  async pickPermissions(
    args: string,
    pickFn: PickFn,
  ): Promise<void> {
    // Direct set: /permissions <mode>
    if (args) {
      if (args === "default") {
        this.display.print(c.darkGray("Permissions set to default."));
        this.settings._setPermissionMode(undefined);
        return;
      }
      const match = Settings.PERMISSION_MODES.find(m => m.value === args);
      if (match && match.value !== "default") {
        this.display.print(c.darkGray(`Permissions set to ${match.value}.`));
        this.settings._setPermissionMode(match.value);
        return;
      }
      // Unknown mode — reject (permissions is a closed set like effort)
      const names = Settings.PERMISSION_MODES.map(m => m.value).join(", ");
      this.display.print(c.amber(`Unknown permission mode "${args}". Valid modes: ${names}`));
      return;
    }

    // Interactive picker
    const options: string[] = [];
    let currentIdx = 0;
    for (let i = 0; i < Settings.PERMISSION_MODES.length; i++) {
      const m = Settings.PERMISSION_MODES[i];
      const desc = m.description ? ` · ${m.description}` : "";
      options.push(`${m.displayName}${desc}`);
      if (m.value === (this.settings.permissionMode ?? "default")) currentIdx = i;
    }

    this.display.print(c.yellow("\nSelect permission mode:"));
    const result = await pickFn(options, currentIdx);

    if (result.type !== "selected") return;

    const chosen = Settings.PERMISSION_MODES[result.index];
    if (chosen.value === "default") {
      if (this.settings.permissionMode === undefined) return; // already default, no-op
      this.display.print(c.darkGray(`Permissions set to default.`));
      this.settings._setPermissionMode(undefined);
      return;
    }
    this.display.print(c.darkGray(`Permissions set to ${chosen.value}.`));
    this.settings._setPermissionMode(chosen.value);
  }

  /** Handle the /settings:verbose command: show a picker or set directly from an argument. */
  async pickVerbose(args: string, pickFn: PickFn): Promise<void> {
    if (args) {
      const val = SettingsController.parseBool(args);
      if (val === undefined) {
        const names = Settings.VERBOSE_OPTIONS.map(o => o.displayName).join(", ");
        this.display.print(c.amber(`Unknown verbose value "${args}". Valid values: ${names} (or true/false/on/off/yes/no)`));
        return;
      }
      this.settings._setVerbose(val);
      this.display.print(c.darkGray(`Verbose set to ${val}.`));
      return;
    }

    const options: string[] = [];
    let currentIdx = 0;
    const currentStr = this.settings.verbose ? "true" : "false";
    for (let i = 0; i < Settings.VERBOSE_OPTIONS.length; i++) {
      const o = Settings.VERBOSE_OPTIONS[i];
      const desc = o.description ? ` · ${o.description}` : "";
      options.push(`${o.displayName}${desc}`);
      if (o.value === currentStr) currentIdx = i;
    }

    this.display.print(c.yellow("\nSelect verbose:"));
    const result = await pickFn(options, currentIdx);
    if (result.type !== "selected") return;

    const chosen = Settings.VERBOSE_OPTIONS[result.index];
    const val = chosen.value === "true";
    if (val === this.settings.verbose) return;
    this.settings._setVerbose(val);
    this.display.print(c.darkGray(`Verbose set to ${chosen.value}.`));
  }

  /** Handle the /settings:think-out-loud command: show a picker or set directly from an argument. */
  async pickThinkOutLoud(args: string, pickFn: PickFn): Promise<void> {
    if (args) {
      const lower = args.toLowerCase();
      if (lower === "default") {
        this.settings._setThinkOutLoud("default");
        this.display.print(c.darkGray(`Think-out-loud set to default.`));
        return;
      }
      const val = SettingsController.parseBool(args);
      if (val === undefined) {
        const names = Settings.THINK_OUT_LOUD_OPTIONS.map(o => o.displayName).join(", ");
        this.display.print(c.amber(`Unknown think-out-loud value "${args}". Valid values: ${names} (or true/false/on/off/yes/no)`));
        return;
      }
      this.settings._setThinkOutLoud(val);
      this.display.print(c.darkGray(`Think-out-loud set to ${val}.`));
      return;
    }

    const options: string[] = [];
    let currentIdx = 0;
    const currentStr: string = this.settings.thinkOutLoud === true ? "true"
      : this.settings.thinkOutLoud === false ? "false"
      : "default";
    for (let i = 0; i < Settings.THINK_OUT_LOUD_OPTIONS.length; i++) {
      const o = Settings.THINK_OUT_LOUD_OPTIONS[i];
      const desc = o.description ? ` · ${o.description}` : "";
      options.push(`${o.displayName}${desc}`);
      if (o.value === currentStr) currentIdx = i;
    }

    this.display.print(c.yellow("\nSelect think-out-loud:"));
    const result = await pickFn(options, currentIdx);
    if (result.type !== "selected") return;

    const chosen = Settings.THINK_OUT_LOUD_OPTIONS[result.index];
    const val: ThinkOutLoudValue = chosen.value === "true" ? true
      : chosen.value === "false" ? false
      : "default";
    if (val === this.settings.thinkOutLoud) return;
    this.settings._setThinkOutLoud(val);
    this.display.print(c.darkGray(`Think-out-loud set to ${chosen.value}.`));
  }

  /** Show the /settings overview picker: all settings with current values, Tab to cycle. */
  async pickSettings(settingsPickFn: SettingsPickFn, pickFn: PickFn, fetchModelsFn?: FetchModelsFn): Promise<void> {
    // Ensure model list is loaded for display
    let models = this.settings.getCachedModels();
    if (!models && fetchModelsFn) {
      try { models = await fetchModelsFn(); this.settings.setCachedModels(models); } catch { /* ignore */ }
    }

    const modelDisplay = this.settings.model ?? "default";
    const effortDisplay = this.settings.effort ?? "auto";
    const permDisplay = this.settings.permissionMode ?? "default";
    const verboseDisplay = this.settings.verbose ? "on" : "off";
    const tolDisplay = this.settings.thinkOutLoud === true ? "on"
      : this.settings.thinkOutLoud === false ? "off"
      : "default";

    const modelCycle = models ? models.map(m => m.value) : undefined;
    const effortCycle = Settings.EFFORT_LEVELS.map(l => l.value);
    const permCycle = Settings.PERMISSION_MODES.map(m => m.value as string);
    const verboseCycle = ["off", "on"];
    const tolCycle = ["default", "off", "on"];

    const entries: SettingsMenuEntry[] = [
      { label: "Model",          display: modelDisplay,   cycleValues: modelCycle },
      { label: "Effort",         display: effortDisplay,  cycleValues: effortCycle },
      { label: "Permissions",    display: permDisplay,    cycleValues: permCycle },
      { label: "Verbose",        display: verboseDisplay, cycleValues: verboseCycle },
      { label: "Think-out-loud", display: tolDisplay,     cycleValues: tolCycle },
    ];

    const onCycle = (i: number, newValue: string): void => {
      switch (i) {
        case 0: { // Model
          this.settings._setModel(newValue === "default" ? undefined : newValue);
          break;
        }
        case 1: { // Effort
          const match = Settings.EFFORT_LEVELS.find(l => l.value === newValue);
          if (match) this.settings._setEffort(match.value === "auto" ? undefined : match.value as EffortValue);
          break;
        }
        case 2: { // Permissions
          const match = Settings.PERMISSION_MODES.find(m => m.value === newValue);
          if (match) this.settings._setPermissionMode(match.value === "default" ? undefined : match.value);
          break;
        }
        case 3: // Verbose
          this.settings._setVerbose(newValue === "on");
          break;
        case 4: { // Think-out-loud
          const val: ThinkOutLoudValue = newValue === "on" ? true : newValue === "off" ? false : "default";
          this.settings._setThinkOutLoud(val);
          break;
        }
      }
    };

    const result = await settingsPickFn(entries, onCycle);
    if (result.type !== "selected") return;

    // On Enter, invoke the sub-command for the selected setting
    switch (result.index) {
      case 0: await this.pickModel("", pickFn, fetchModelsFn); break;
      case 1: await this.pickEffort("", pickFn); break;
      case 2: await this.pickPermissions("", pickFn); break;
      case 3: await this.pickVerbose("", pickFn); break;
      case 4: await this.pickThinkOutLoud("", pickFn); break;
    }
  }

  /**
   * Register all settings commands in the given registry.
   * Call with `registry.scoped("settings")` from the composition root.
   * Also registers the root `/settings` command in the parent registry.
   */
  registerAll(
    scopedRegistry: CommandRegistry,
    rootRegistry: CommandRegistry,
    pickFn: PickFn,
    settingsPickFn: SettingsPickFn,
    fetchModelsFn?: FetchModelsFn,
  ): void {
    scopedRegistry.register("model", {
      description: "Select the Claude model to use",
      handler: async (args) => { await this.pickModel(args, pickFn, fetchModelsFn); },
    });
    scopedRegistry.register("effort", {
      description: "Set the effort level for Claude's thinking",
      handler: async (args) => { await this.pickEffort(args, pickFn); },
    });
    scopedRegistry.register("permissions", {
      description: "Set the permission mode for tool use",
      handler: async (args) => { await this.pickPermissions(args, pickFn); },
    });
    scopedRegistry.register("verbose", {
      description: "Set verbose output mode",
      handler: async (args) => { await this.pickVerbose(args, pickFn); },
    });
    scopedRegistry.register("think-out-loud", {
      description: "Set think-out-loud mode (show agent thinking text)",
      handler: async (args) => { await this.pickThinkOutLoud(args, pickFn); },
    });
    rootRegistry.register("settings", {
      description: "View and edit all settings",
      handler: async () => { await this.pickSettings(settingsPickFn, pickFn, fetchModelsFn); },
    });
  }
}
