// ── Command Registry ──────────────────────────────────────────────────────────

import fs from "fs";

export type HandlerResult = void | "exit" | "task-complete";
export type CommandHandler = (args: string) => Promise<HandlerResult>;

// ── Argument application ─────────────────────────────────────────────────────

/**
 * Apply args to a loaded command/skill content string.
 * If content contains $ARGUMENTS, all occurrences are replaced with args (even if empty).
 * Otherwise, if args is non-empty, appends "\nARGUMENTS: <args>".
 * Otherwise returns content unchanged.
 */
function applyArguments(content: string, args: string): string {
  if (content.includes("$ARGUMENTS")) {
    return content.replaceAll("$ARGUMENTS", args);
  }
  if (args) {
    return `${content}\nARGUMENTS: ${args}`;
  }
  return content;
}

// ── Dispatch types ────────────────────────────────────────────────────────────

export type SlashCommandResult =
  | { type: "command"; name: string }
  | { type: "unknown_command"; command: string };

export type DispatchResult =
  | { type: "command"; name: string; args: string }
  | { type: "unknown_command"; command: string }
  | { type: "skip" }
  | { type: "query"; prompt: string };

// ── Command filtering ─────────────────────────────────────────────────────────

/**
 * Filter CommandSuggestion objects by substring of name or description.
 * Case-insensitive. Empty query returns all commands.
 * Sort order: prefix matches of name, then non-prefix name substring matches,
 * then description-only matches.
 */
export function filterCommands(query: string, commands: CommandSuggestion[]): CommandSuggestion[] {
  if (query === "") return commands;
  const q = query.toLowerCase();
  const prefixName = commands.filter(c => c.name.toLowerCase().startsWith(q));
  const substringName = commands.filter(
    c => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q),
  );
  const descOnly = commands.filter(
    c => !c.name.toLowerCase().includes(q) && c.description.toLowerCase().includes(q),
  );
  return [...prefixName, ...substringName, ...descOnly];
}

export interface CommandEntry {
  /** Canonical command name, e.g. "workspace:create" */
  name: string;
  description: string;
  handler: CommandHandler;
}

/** A command name paired with a display description for autocomplete. */
export type CommandSuggestion = { name: string; description: string };

export type ListDir = (dir: string) => Array<{ name: string; isDir: boolean }> | null;

// ── Filesystem helpers ────────────────────────────────────────────────────────

/**
 * Parse a YAML frontmatter block (---...---) at the top of a string.
 * Returns key/value pairs as strings. Non-matching lines are silently skipped.
 * Returns {} if no frontmatter block is present.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) result[m[1].trim()] = m[2].trim();
  }
  return result;
}

function defaultReadFile(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function defaultListDir(dir: string): Array<{ name: string; isDir: boolean }> | null {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map(e => ({
      name: e.name,
      isDir: e.isDirectory(),
    }));
  } catch {
    return null;
  }
}

function walkDir(dir: string, prefix: string, listDir: ListDir): string[] {
  const entries = listDir(dir);
  if (!entries) return [];
  const result: string[] = [];
  for (const entry of entries) {
    const name = prefix ? `${prefix}:${entry.name}` : entry.name;
    if (entry.isDir) {
      result.push(...walkDir(`${dir}/${entry.name}`, name, listDir));
    } else if (entry.name.endsWith(".md")) {
      result.push(name.slice(0, -3)); // strip .md extension
    }
  }
  return result;
}

function extractDescription(content: string): string {
  const fm = parseFrontmatter(content);
  if (fm.description) return fm.description;
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

// ── Command content resolution ────────────────────────────────────────────────

/**
 * Convert a slash command name to its file path under ~/.claude/commands/.
 * Colons become path separators: "foo:bar" → ~/.claude/commands/foo/bar.md
 */
function resolveCommandFilePath(command: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const rel = command.replace(/:/g, "/");
  return `${home}/.claude/commands/${rel}.md`;
}

/**
 * Resolve the raw content for a command name by trying three locations in order:
 * 1. ~/.claude/commands/<command-path>.md  (custom command file)
 * 2. ~/.claude/skills/<command>/SKILL.md   (user skill)
 * 3. <plugin installPath>/skills/<skill>/SKILL.md  (plugin skill, for "plugin:skill" names)
 * Returns raw file content, or null if not found.
 * Does NOT apply arguments — that is left to the caller.
 */
function resolveContent(
  command: string,
  readFile: (path: string) => string | null = defaultReadFile,
): string | null {
  // 1. Command file
  const cmdPath = resolveCommandFilePath(command);
  const cmdContent = readFile(cmdPath);
  if (cmdContent !== null) return cmdContent;

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";

  // 2. User skill
  const userSkillPath = `${home}/.claude/skills/${command}/SKILL.md`;
  const userContent = readFile(userSkillPath);
  if (userContent !== null) return userContent;

  // 3. Plugin skill (plugin:skill format only)
  const colonIdx = command.indexOf(":");
  if (colonIdx > 0) {
    const pluginName = command.slice(0, colonIdx);
    const skillName = command.slice(colonIdx + 1);
    const pluginsJson = readFile(`${home}/.claude/plugins/installed_plugins.json`);
    if (pluginsJson) {
      try {
        const parsed = JSON.parse(pluginsJson) as {
          plugins: Record<string, Array<{ installPath: string }>>;
        };
        for (const [key, entries] of Object.entries(parsed.plugins ?? {})) {
          if (key.split("@")[0] === pluginName) {
            for (const entry of entries) {
              const skillPath = `${entry.installPath}/skills/${skillName}/SKILL.md`;
              const content = readFile(skillPath);
              if (content !== null) return content;
            }
          }
        }
      } catch {
        // malformed JSON — return null
      }
    }
  }

  return null;
}

// ── Skill discovery ───────────────────────────────────────────────────────────

/**
 * Return all available skill names: user skills from ~/.claude/skills/ plus
 * plugin skills from installed_plugins.json.
 * Skills with `user-invocable: false` in their SKILL.md frontmatter are excluded.
 * Plugin skills are named "<plugin>:<skill>".
 * Both listDir and readFile are injectable for testing.
 */
function listSkillNames(
  listDir: ListDir = defaultListDir,
  readFile: (path: string) => string | null = defaultReadFile,
): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const results: string[] = [];

  // Plugin skills
  const pluginsJson = readFile(`${home}/.claude/plugins/installed_plugins.json`);
  if (pluginsJson) {
    try {
      const parsed = JSON.parse(pluginsJson) as {
        plugins: Record<string, Array<{ installPath: string }>>;
      };
      for (const [key, entries] of Object.entries(parsed.plugins ?? {})) {
        const pluginName = key.split("@")[0];
        for (const entry of entries) {
          const skillsDir = `${entry.installPath}/skills`;
          const skillDirs = listDir(skillsDir);
          if (!skillDirs) continue;
          for (const dir of skillDirs) {
            if (!dir.isDir) continue;
            const skillMd = readFile(`${skillsDir}/${dir.name}/SKILL.md`);
            if (!skillMd) continue;
            const fm = parseFrontmatter(skillMd);
            if (fm["user-invocable"] === "false") continue;
            results.push(`${pluginName}:${dir.name}`);
          }
        }
      }
    } catch {
      // malformed JSON — skip plugin skills
    }
  }

  // User skills
  const userSkillsDir = `${home}/.claude/skills`;
  const userSkillDirs = listDir(userSkillsDir);
  if (userSkillDirs) {
    for (const dir of userSkillDirs) {
      if (!dir.isDir) continue;
      const skillMd = readFile(`${userSkillsDir}/${dir.name}/SKILL.md`);
      if (!skillMd) continue;
      const fm = parseFrontmatter(skillMd);
      if (fm["user-invocable"] === "false") continue;
      results.push(dir.name);
    }
  }

  return [...new Set(results)].sort();
}

/**
 * Base registry of slash commands. Supports registration and lookup only.
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

/**
 * Full command controller: wraps a CommandRegistry with dispatch, parse, and
 * list methods. Use this for top-level dispatch; pass CommandRegistry to
 * functions that only need to register commands.
 */
export class CommandController {
  constructor(private readonly _registry: CommandRegistry) {}

  /** Expose the underlying registry for registration in tests/callers. */
  get registry(): CommandRegistry { return this._registry; }

  /**
   * Return all available command names: builtins (from the registry) plus any
   * .md files under ~/.claude/commands/ (recursively) and skill names.
   * Subdirectory names become colon-separated prefixes: foo/bar.md → "foo:bar".
   * The listDir and readFile parameters are injectable for testing.
   */
  listCommandNames(
    listDir: ListDir = defaultListDir,
    readFile: (path: string) => string | null = defaultReadFile,
  ): string[] {
    const builtins = this._registry.listAll().map(e => e.name);
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ""; // "" → walks "/.claude/commands" which will silently return null
    const commandsDir = `${home}/.claude/commands`;
    const fileCommands = walkDir(commandsDir, "", listDir);
    const skillNames = listSkillNames(listDir, readFile);
    return [...new Set([...builtins, ...fileCommands, ...skillNames])].sort();
  }

  /**
   * Like listCommandNames but returns CommandSuggestion objects that include a
   * one-line description for each command (sourced from frontmatter or first
   * line of the command file / skill).
   */
  listCommands(
    listDir: ListDir = defaultListDir,
    readFile: (path: string) => string | null = defaultReadFile,
  ): CommandSuggestion[] {
    const names = this.listCommandNames(listDir, readFile);
    return names.map(name => {
      const entry = this._registry.lookup(name);
      if (entry) return { name, description: entry.description };
      const content = resolveContent(name, readFile);
      return { name, description: content ? extractDescription(content) : "" };
    });
  }

  /**
   * Parse a slash command from raw user input.
   * Returns null if the input is not a slash command.
   * Looks up the command name in the registry.
   * Returns the canonical command name on match, or unknown_command if not found.
   */
  parseSlashCommand(input: string): SlashCommandResult | null {
    if (!input.startsWith("/")) return null;
    const command = input.slice(1).split(/\s+/)[0];
    if (!command) return null;
    const entry = this._registry.lookup(command);
    if (entry) return { type: "command", name: entry.name };
    return { type: "unknown_command", command };
  }

  /**
   * Dispatch user input to the appropriate REPL action.
   * readFile is injectable for testing.
   */
  async dispatch(
    input: string,
    readFile: (path: string) => string | null = defaultReadFile,
  ): Promise<DispatchResult> {
    if (!input) return { type: "skip" };

    const slash = this.parseSlashCommand(input);
    if (slash) {
      if (slash.type === "command") {
        const rawCommand = input.slice(1).split(/\s+/)[0];
        const args = input.slice(1 + rawCommand.length).trim();
        return { type: "command", name: slash.name, args };
      }
      // unknown_command: look up command file or skill
      const { command } = slash;
      const content = resolveContent(command, readFile);
      if (content === null) return { type: "unknown_command", command };
      const args = input.slice(1 + command.length).trim();
      const prompt = applyArguments(content, args);
      return { type: "query", prompt };
    }

    return { type: "query", prompt: input };
  }

  /**
   * Return filtered command suggestions matching the given query string.
   * Calls listCommands() internally and applies filterCommands() logic.
   */
  suggest(
    query: string,
    listDir: ListDir = defaultListDir,
    readFile: (path: string) => string | null = defaultReadFile,
  ): CommandSuggestion[] {
    const all = this.listCommands(listDir, readFile);
    return filterCommands(query, all);
  }
}