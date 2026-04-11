// ── Command Registry ──────────────────────────────────────────────────────────

export type Availability = "repl" | "worker" | "both";

export type HandlerResult = void | "exit" | "task-complete";
export type CommandHandler = (args: string) => Promise<HandlerResult>;

export interface CommandEntry {
  /** Canonical command name, e.g. "workspace:create" */
  name: string;
  description: string;
  availability: Availability;
  handler: CommandHandler;
}

/**
 * A registry scoped to a given prefix.
 * e.g. registry.scoped("workspace").register("create", opts) registers "workspace:create".
 */
export class ScopedCommandRegistry {
  constructor(
    private readonly parent: CommandRegistry,
    private readonly prefix: string,
  ) {}

  /** Register a command under this scope's prefix. */
  register(
    name: string,
    opts: { description: string; availability?: Availability; handler: CommandHandler },
  ): void {
    this.parent.register(`${this.prefix}:${name}`, opts);
  }

  /** Return a sub-scoped registry with an extended prefix. */
  scoped(subPrefix: string): ScopedCommandRegistry {
    return new ScopedCommandRegistry(this.parent, `${this.prefix}:${subPrefix}`);
  }
}

/** Registry of slash commands available in the REPL and/or worker mode. */
export class CommandRegistry {
  private readonly _entries: Map<string, CommandEntry> = new Map();

  /** Register a command in the registry. */
  register(
    name: string,
    opts: { description: string; availability?: Availability; handler: CommandHandler },
  ): void {
    this._entries.set(name, {
      name,
      description: opts.description,
      availability: opts.availability ?? "both",
      handler: opts.handler,
    });
  }

  /** Look up a command entry by canonical name. */
  lookup(name: string): CommandEntry | undefined {
    return this._entries.get(name);
  }

  /**
   * Return all command entries available in the given mode.
   * In non-worker mode, commands with availability "worker" are excluded.
   * In worker mode, commands with availability "repl" are excluded.
   */
  listAll(workerMode = false): CommandEntry[] {
    return Array.from(this._entries.values()).filter(e =>
      workerMode ? e.availability !== "repl" : e.availability !== "worker",
    );
  }

  /**
   * Execute a registered command by name.
   * Returns the handler's result, or undefined if the command is not found.
   */
  async execute(name: string, args: string): Promise<HandlerResult | undefined> {
    const entry = this._entries.get(name);
    if (!entry) return undefined;
    return entry.handler(args);
  }

  /**
   * Returns a ScopedCommandRegistry that prefixes all registered names with the
   * given prefix (e.g. scoped("workspace").register("create", …) → "workspace:create").
   */
  scoped(prefix: string): ScopedCommandRegistry {
    return new ScopedCommandRegistry(this, prefix);
  }

  /** Reset the registry (for test isolation). */
  _reset(): void {
    this._entries.clear();
  }
}
