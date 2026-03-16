# Skill Autocomplete & Execution — Design Spec

**Issue:** #67 — Autocomplete user-invokable skills as slash commands
**Date:** 2026-03-16

---

## Problem

The brunel REPL autocompletes `/` commands from two sources: builtin commands (`clear`, `exit`) and custom command files in `~/.claude/commands/`. User-invokable skills (from `~/.claude/skills/` and installed plugins) are invisible to autocomplete and cannot be executed via slash commands.

---

## Scope

- Extend `listCommandNames` to include skill names
- Extend command resolution to load skill content (including plugin skills)
- Add `$ARGUMENTS` substitution when executing any command or skill
- Filter out skills marked `user-invocable: false` in their SKILL.md frontmatter

---

## Skill Sources

### User skills
`~/.claude/skills/<name>/SKILL.md` — each subdirectory is a skill.
Skill name = directory name.

### Plugin skills
Installed plugins are listed in `~/.claude/plugins/installed_plugins.json`:

```json
{
  "plugins": {
    "superpowers@superpowers-marketplace": [
      { "installPath": "/home/node/.claude/plugins/cache/.../superpowers/5.0.2" }
    ]
  }
}
```

Plugin name = the part of the JSON object key before `@` (e.g. `superpowers`).
Skills live at `<installPath>/skills/<name>/SKILL.md`.
Skill name = `<plugin>:<name>` (e.g. `superpowers:brainstorming`).

**Key lookup for dispatch:** To resolve a `plugin:skill` command, iterate all keys of `plugins`, extract the prefix before `@`, and match against the plugin portion of the command. If two plugins share the same prefix (unlikely but possible), use the first match. On any error reading or parsing `installed_plugins.json`, treat plugin skills as unavailable.

### Exclusion rule
A skill is excluded if its SKILL.md frontmatter contains `user-invocable: false`.
Frontmatter is a `---`-delimited YAML block at the top of the file. Only `key: value` lines inside the block are parsed — non-matching lines are silently skipped. Returns `{}` if no frontmatter is present.

---

## New / Modified Functions in `src/input.ts`

All functions follow the existing injectable pattern — real filesystem access is the default, but every I/O operation can be replaced in tests.

### `parseFrontmatter(content: string): Record<string, string>` *(new, exported)*

Parses a YAML frontmatter block at the top of a file (`---…---`). Returns key/value pairs as plain strings. Lines inside the block that do not match `key: value` are silently skipped. Returns `{}` if no frontmatter block is present. Used internally to check `user-invocable`.

### `applyArguments(content: string, args: string): string` *(new, exported)*

Applies arguments to loaded content:
- If content contains `$ARGUMENTS`: replace every occurrence with `args` (even if `args` is empty string)
- Otherwise, if `args` is non-empty: append `\nARGUMENTS: <args>`
- Otherwise: return content unchanged

Used in `dispatchInput` for both commands and skills. **This replaces the existing ad-hoc arg-appending logic in `dispatchInput`** (`prompt = args ? \`${content}\n${args}\` : content`). The existing dispatch test for argument appending must be updated to expect the new `ARGUMENTS: <args>` format.

### `listSkillNames(listDir, readFile): string[]` *(new, exported)*

**Do not use `walkDir` here.** Skill directories contain `SKILL.md` files, not flat `.md` files, and the naming convention differs from commands.

1. Read `~/.claude/plugins/installed_plugins.json` via `readFile`; on any error (missing or malformed JSON), skip plugin skills and continue.
2. For each installed plugin entry: list `<installPath>/skills/` via `listDir`; for each skill dir, read `SKILL.md` via `readFile`; skip if `user-invocable: false` in frontmatter.
3. List `~/.claude/skills/` via `listDir`; for each skill dir, read `SKILL.md` via `readFile`; skip if `user-invocable: false`.
4. Return sorted, deduplicated list of skill names.

### `listCommandNames(listDir, readFile): string[]` *(modified)*

Previously: `listCommandNames(listDir)`.

New second parameter `readFile` (defaults to `defaultReadFile`) is forwarded to `listSkillNames`. **Both `listDir` and `readFile` are forwarded to `listSkillNames`** — not just `readFile`.

Result = existing command names ∪ skill names, deduplicated and sorted.

The default call site in `ask()` passes no arguments, so defaults apply — production behavior is unchanged. Tests that need to inject `readFile` for skill filtering must construct a closure and pass it via `ask()`'s `getCommands` parameter, e.g.:

```typescript
ask("> ", () => listCommandNames(myListDir, myReadFile))
```

### `resolveContent(command, readFile): string | null` *(new, exported — replaces `loadCommandFile`)*

Tries three locations in order, returning the raw file content of the first match:

1. `~/.claude/commands/<command-path>.md` (existing logic via `resolveCommandFilePath`)
2. `~/.claude/skills/<command>/SKILL.md` (user skill)
3. For `plugin:skill` format: read `installed_plugins.json`, iterate keys to find the matching plugin prefix (part before `@`), resolve `<installPath>/skills/<skill>/SKILL.md`. On any error reading or parsing the JSON, skip to returning `null`.

Returns `null` if none found. Does **not** apply arguments — that is left to `dispatchInput`.

Before removing `loadCommandFile`: **search for all usages of `loadCommandFile` across `src/` and `tests/`** to avoid breaking callers. Remove or convert each usage. Known locations:
- `src/repl.ts` line 7: re-exports `loadCommandFile` — remove it from the export list and add `resolveContent` in its place (since `resolveContent` is the intended public replacement).
- `tests/repl.slash.test.ts` line 2: imports and tests `loadCommandFile` directly — remove the import and the three `loadCommandFile` test cases; migrate any coverage not already handled by `resolveContent` tests.

### `dispatchInput(input, readFile): Promise<DispatchResult>` *(modified)*

Replace the `loadCommandFile` call with `resolveContent`.
After obtaining raw content, call `applyArguments(content, args)` to produce the final prompt.

---

## What Does Not Change

- `resolveCommandFilePath` — unchanged
- `matchCommands`, `walkDir`, `ask` — unchanged
- `parseSlashCommand` — unchanged
- Builtins (`clear`, `exit`, `task-complete`) — unchanged; they are still matched before any file lookup

---

## Testing

All new functions are covered by unit tests following the existing style in `tests/repl.autocomplete.test.ts` and `tests/repl.dispatch.test.ts`. Every I/O operation is injectable, so no real filesystem access is needed.

Key test cases:

**`parseFrontmatter`**
- With a valid frontmatter block
- Without frontmatter (returns `{}`)
- With `user-invocable: false` in frontmatter
- With non-matching lines inside the block (skipped silently)

**`applyArguments`**
- `$ARGUMENTS` present, non-empty args → substituted
- `$ARGUMENTS` present, empty args → substituted with empty string (does not fall through to append)
- `$ARGUMENTS` absent, non-empty args → appended as `ARGUMENTS: <args>`
- `$ARGUMENTS` absent, empty args → content returned unchanged
- Multiple `$ARGUMENTS` occurrences → all replaced

**`listSkillNames`**
- User skills listed and returned
- Plugin skills listed with `plugin:skill` names
- Skills with `user-invocable: false` excluded
- Missing `installed_plugins.json` → graceful (user skills still returned)
- Malformed JSON → graceful (user skills still returned)
- Missing skills directory → graceful (empty)

**`listCommandNames`**
- Skill names merged with command names
- Deduplication when skill name matches a command name

**`resolveContent`**
- Command file found → returns content
- User skill found → returns content
- Plugin skill found → returns content
- None found → returns null
- Malformed `installed_plugins.json` in plugin path → returns null gracefully

**`dispatchInput`**
- Skill with `$ARGUMENTS` in content: args substituted
- Skill without `$ARGUMENTS`: args appended as `ARGUMENTS: <args>`
- Existing test for command arg-appending: updated to expect `ARGUMENTS: <args>` format
- Unknown command returns `unknown_command` result

---

## File Changes

- `src/input.ts` — all new/modified functions above
- `src/repl.ts` — update re-export: remove `loadCommandFile`, add `resolveContent`
- `tests/repl.autocomplete.test.ts` — new tests for `listSkillNames`, `listCommandNames` with skills
- `tests/repl.dispatch.test.ts` — new tests for `resolveContent`, updated `dispatchInput` tests
- `tests/repl.slash.test.ts` — remove `loadCommandFile` import and three `loadCommandFile` test cases; migrate any unique coverage to `repl.dispatch.test.ts`
