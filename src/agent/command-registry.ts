// ── Command Registry ──────────────────────────────────────────────────────────

export type HandlerResult = void | "exit" | "task-complete";
export type CommandHandler = (args: string) => Promise<HandlerResult>;

export interface CommandEntry {
  /** Canonical command name, e.g. "workspace:create" */
  name: string;
  description: string;
  handler: CommandHandler;
}

/**
 * Registry of slash commands.
 *
 * Supports scoped sub-registries via scoped(prefix): the returned registry
 * shares the same underlying store as its root, so callers receive and work
 * with a plain CommandRegistry regardless of whether it is scoped. For
 * example:
 *
 *   registry.scoped("workspace").register("create", opts)
 *   // → stores "workspace:create" in registry
 */
export class CommandRegistry {
  private readonly _entries: Map<string, CommandEntry> = new Map();

  constructor(
    private readonly _parent?: CommandRegistry,
    private readonly _prefix?: string,
  ) {}

  private get _root(): CommandRegistry {
    return this._parent ?? this;
  }

  private _qualify(name: string): string {
    return this._prefix ? `${this._prefix}:${name}` : name;
  }

  /** Register a command. In a scoped registry the name is automatically prefixed. */
  register(name: string, opts: { description: string; handler: CommandHandler }): void {
    const fullName = this._qualify(name);
    this._root._entries.set(fullName, {
      name: fullName,
      description: opts.description,
      handler: opts.handler,
    });
  }

  /** Look up a command entry by canonical name. */
  lookup(name: string): CommandEntry | undefined {
    return this._root._entries.get(name);
  }

  /** Return all registered command entries. */
  listAll(): CommandEntry[] {
    return Array.from(this._root._entries.values());
  }

  /**
   * Execute a registered command by name.
   * Returns the handler's result, or undefined if the command is not found.
   */
  async execute(name: string, args: string): Promise<HandlerResult | undefined> {
    const entry = this._root._entries.get(name);
    if (!entry) return undefined;
    return entry.handler(args);
  }

  /**
   * Return a scoped registry that prefixes all registered names with prefix.
   * e.g. registry.scoped("workspace").register("create", …) → "workspace:create".
   * Scoped registries can be nested: scoped("a").scoped("b") → prefix "a:b".
   */
  scoped(prefix: string): CommandRegistry {
    return new CommandRegistry(this._root, this._qualify(prefix));
  }

  /** Reset the registry (for test isolation). */
  _reset(): void {
    this._root._entries.clear();
  }
}
