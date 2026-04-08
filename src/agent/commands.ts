// ── Command Registry ──────────────────────────────────────────────────────────

export type Availability = "repl" | "worker" | "both";

export interface CommandEntry {
  /** Canonical command name, e.g. "workspace:create" */
  name: string;
  /** Backward-compatible aliases, e.g. ["create-workspace"] */
  aliases: string[];
  description: string;
  availability: Availability;
}

const _entries: CommandEntry[] = [];

/** Register a command in the registry. */
export function register(
  name: string,
  opts: { aliases?: string[]; description: string; availability?: Availability },
): void {
  _entries.push({
    name,
    aliases: opts.aliases ?? [],
    description: opts.description,
    availability: opts.availability ?? "both",
  });
}

/** Look up a command entry by canonical name or alias. */
export function lookup(name: string): CommandEntry | undefined {
  return _entries.find(e => e.name === name || e.aliases.includes(name));
}

/**
 * Return all command entries available in the given mode.
 * In non-worker mode, commands with availability "worker" are excluded.
 * In worker mode, commands with availability "repl" are excluded.
 */
export function listAll(workerMode = false): CommandEntry[] {
  return _entries.filter(e =>
    workerMode ? e.availability !== "repl" : e.availability !== "worker",
  );
}

// ── Built-in command registrations ───────────────────────────────────────────

register("clear",  { description: "Clear the conversation" });
register("exit",   { description: "Exit the REPL" });
register("model",  { description: "Select the Claude model to use" });
register("effort", { description: "Set the effort level for Claude's thinking" });

register("workspace:create", {
  aliases: ["create-workspace"],
  description: "Create an isolated git checkout for this session",
});
register("workspace:reset", {
  aliases: ["reset-workspace"],
  description: "Reset workspace to clean main branch",
});
register("workspace:remove", {
  aliases: ["remove-workspace"],
  description: "Remove the workspace checkout for this session",
});
register("workspace:prune", {
  aliases: ["prune"],
  description: "Remove orphaned worker workspace directories",
});

register("worker:task-complete", {
  aliases: ["task-complete"],
  description: "Mark the current task as done",
  availability: "worker",
});
