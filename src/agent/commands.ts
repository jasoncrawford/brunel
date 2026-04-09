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

const _entries: Map<string, CommandEntry> = new Map();

/** Register a command in the registry. */
export function register(
  name: string,
  opts: { description: string; availability?: Availability; handler: CommandHandler },
): void {
  _entries.set(name, {
    name,
    description: opts.description,
    availability: opts.availability ?? "both",
    handler: opts.handler,
  });
}

/** Look up a command entry by canonical name. */
export function lookup(name: string): CommandEntry | undefined {
  return _entries.get(name);
}

/**
 * Return all command entries available in the given mode.
 * In non-worker mode, commands with availability "worker" are excluded.
 * In worker mode, commands with availability "repl" are excluded.
 */
export function listAll(workerMode = false): CommandEntry[] {
  return Array.from(_entries.values()).filter(e =>
    workerMode ? e.availability !== "repl" : e.availability !== "worker",
  );
}

/**
 * Execute a registered command by name.
 * Returns the handler's result, or undefined if the command is not found.
 */
export async function execute(name: string, args: string): Promise<HandlerResult | undefined> {
  const entry = _entries.get(name);
  if (!entry) return undefined;
  return entry.handler(args);
}

/**
 * Returns a register function scoped to the given namespace prefix.
 * e.g. scoped("workspace")("create", opts) registers "workspace:create".
 */
export function scoped(
  prefix: string,
): (name: string, opts: { description: string; availability?: Availability; handler: CommandHandler }) => void {
  return (name, opts) => register(`${prefix}:${name}`, opts);
}

/** Reset the registry (for test isolation). */
export function _reset(): void {
  _entries.clear();
}
