// ── Command Registry ──────────────────────────────────────────────────────────

import fs from "fs";

export type HandlerResult = void | "exit" | "task-complete";
export type CommandHandler = (args: string) => Promise<HandlerResult>;

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
export function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) result[m[1].trim()] = m[2].trim();
  }
  return result;
}

export function defaultReadFile(path: string): string | null {
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
export function resolveCommandFilePath(command: string): string {
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
export function resolveContent(
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
export function listSkillNames(
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
    const builtins = this.listAll().map(e => e.name);
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
      const entry = this.lookup(name);
      if (entry) return { name, description: entry.description };
      const content = resolveContent(name, readFile);
      return { name, description: content ? extractDescription(content) : "" };
    });
  }

  /** Reset the registry (for test isolation). */
  _reset(): void {
    this._root._entries.clear();
  }
}
