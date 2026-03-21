# Unified Config System — Design Spec

**Issue:** #161
**Date:** 2026-03-21
**Status:** Approved

---

## Summary

Add a layered configuration system to brunel so every option can be set via a `brunel.config.ts` file, an environment variable, or a CLI flag, with a deterministic naming convention tying them together.

---

## Motivation

Config is currently scattered: env vars in `github.ts`, `foreman.ts`, `worker.ts`; CLI flags parsed ad-hoc in `display.ts` and `repl.ts`; hardcoded defaults inline. There is no config file, so users cannot version-control their brunel settings.

---

## Architecture

### New module: `src/config.ts`

Exports:

```ts
export async function loadConfig(
  argv: string[],
  fileConfigOverride?: Record<string, unknown>, // for testing only
): Promise<BrunelConfig>

export const VALID_PERMISSION_MODES: readonly PermissionMode[];
export interface BrunelConfig { ... }
```

- Async because cosmiconfig's `search()` is async
- `fileConfigOverride` lets unit tests inject a file-config layer without touching the filesystem; when provided, cosmiconfig is not called and `filepath` is `undefined`
- No side effects beyond `console.warn` for secrets

New dependencies: `npm install cosmiconfig zod` (both to `dependencies`).

### TypeScript config file support

```ts
const explorer = cosmiconfig("brunel", {
  loaders: {
    ".ts": async (filepath) => {
      const mod = await import(filepath);
      return mod.default ?? mod;
    },
  },
});
```

Relies on `tsx`'s import hook being active. Only works when run via `tsx`; out of scope for `bin/brunel.cjs`.

Cosmiconfig searches from `process.cwd()` upward — standard behavior, no stop-dir override needed.

---

## Integration Points

### `repl.ts` — restructuring

The following are removed from `repl.ts`:
- Module-level `PERMISSION_MODE` / `ALLOW_BYPASS` constants (lines 78–79)
- `parsePermissionMode` function and its export
- `ParsedPermissionConfig` type (deleted entirely)
- `VALID_PERMISSION_MODES` export (moves to `config.ts`)

Add `import "dotenv/config"` to the top of `repl.ts` (it currently lacks this).

`runQuery` is refactored to take `permConfig` as its first argument so it no longer closes over module-level state:

```ts
async function runQuery(
  permConfig: { permissionMode: PermissionMode; allowDangerouslySkipPermissions: boolean },
  prompt: string,
  sessionId: string | undefined,
  abortController?: AbortController,
): Promise<string | undefined>
```

The `RunQuery` type alias in `worker.ts` keeps its existing 3-arg signature. A bound wrapper is created in the `isMain` block:

```ts
// repl.ts isMain block — uses top-level await (valid in ESM modules)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = await loadConfig(process.argv);
  setVerbose(config.verbose);
  const permConfig = {
    permissionMode: config.permissionMode,
    allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions,
  };
  const boundRunQuery: RunQuery = (prompt, sessionId, ac) =>
    runQuery(permConfig, prompt, sessionId, ac);

  if (process.argv.includes("--worker-mode")) {
    void workerMain(boundRunQuery, { foremanUrl: config.foremanUrl });
  } else {
    void main(permConfig);
  }
}
```

`main()` gains a `permConfig` parameter (remains unexported; no existing tests import it):

```ts
async function main(
  permConfig: { permissionMode: PermissionMode; allowDangerouslySkipPermissions: boolean },
): Promise<void>
```

Inside `main()`, `runQuery(action.prompt, sessionId)` becomes `runQuery(permConfig, action.prompt, sessionId)`. The header display line uses `permConfig.permissionMode`.

### `worker.ts`

```ts
export type RunQuery = (
  prompt: string,
  sessionId: string | undefined,
  abortController?: AbortController,
) => Promise<string | undefined>;

export async function workerMain(
  runQueryFn: RunQuery,
  config: { foremanUrl: string },
): Promise<void>
```

Remove `process.env.FOREMAN_URL` read; use `config.foremanUrl`.

### `display.ts`

Change line 10 from `export let VERBOSE = process.argv.includes("--verbose")` to `export let VERBOSE = false`. Entry points call `setVerbose(config.verbose)` after `loadConfig`.

### `foreman.ts`

- Remove module-level `PORT` and `WEBHOOK_SECRET` reads (lines 19–20)
- `isMain` block uses top-level await: `const config = await loadConfig(process.argv)`
- Remove internal env var fallback in `createForemanWss` (`process.env.TASK_LABEL`)
- `createForemanWss` options gains `repo` and `token` (both optional for backwards compatibility with existing tests that don't exercise the GitHub call paths):
  ```ts
  options?: {
    taskLabel?: string;
    labelDone?: ...;
    graph?: ...;
    openIssues?: ...;
    repo?: string;   // ← new; captured by routeEvent closure for fetchBlockers/fetchIssueStates
    token?: string;  // ← new
  }
  ```
  The `routeEvent` closure inside `createForemanWss` captures `repo` and `token` from the `options` parameter and passes them as `opts` to `fetchBlockers` and `fetchIssueStates` at the two call sites inside `routeEvent`. Tests that call `createForemanWss` without `repo`/`token` continue to work as long as those code paths aren't exercised.
- `loadIssuesToQueue` call site (inside the `server.listen` async callback) passes explicit `{ repo, token, taskLabel }` from config
- `labelIssueDone` is called via the `labelDone` option, which is a closure over config fields

### `github.ts`

Remove `ghEnv()`. New function signatures:

```ts
loadIssuesToQueue(queue, graph, openIssues, opts: { repo: string; token: string; taskLabel: string })
labelIssueDone(issueNumber, opts: { repo: string; token: string; doneLabel: string })
fetchIssueStates(issueNumbers, opts: { repo: string; token: string })
fetchNativeBlockers(issueNumber, opts: { repo: string; token: string })
```

### `dependencies.ts`

```ts
export async function fetchBlockers(
  issueNumber: number,
  body: string,
  opts: { repo: string; token: string },
): Promise<number[]>
```

`fetchBlockers` forwards `opts` to `fetchNativeBlockers(issueNumber, opts)` for the native-blocker lookup path. All callers (in `github.ts` and `foreman.ts`) pass `opts` from config.

---

## Config Shape

```ts
interface BrunelConfig {
  githubRepo:     string;               // required
  githubToken:    string;               // required
  taskLabel:      string;               // default: "brunel:ready"
  doneLabel:      string;               // default: "brunel:done"
  verbose:        boolean;              // default: false
  port:           number;               // default: 3000
  webhookSecret:  string | undefined;   // optional
  foremanUrl:     string;               // default: "ws://localhost:3000"
  permissionMode: PermissionMode;       // default: "default"
  allowDangerouslySkipPermissions: boolean; // derived: permissionMode === "bypassPermissions"
}
```

---

## Naming Convention

| Option | CLI flag | `BRUNEL_*` env var | Fallback env var | Default |
|--------|----------|--------------------|------------------|---------|
| `githubRepo` | `--github-repo` | `BRUNEL_GITHUB_REPO` | `GITHUB_REPO` | (required) |
| `githubToken` | `--github-token` | `BRUNEL_GITHUB_TOKEN` | `GITHUB_TOKEN`, `GH_TOKEN` | (required) |
| `taskLabel` | `--task-label` | `BRUNEL_TASK_LABEL` | `TASK_LABEL` | `brunel:ready` |
| `doneLabel` | `--done-label` | `BRUNEL_DONE_LABEL` | `DONE_LABEL` | `brunel:done` |
| `verbose` | `--verbose` | `BRUNEL_VERBOSE` | — | `false` |
| `port` | `--port` | `BRUNEL_PORT` | `PORT` | `3000` |
| `webhookSecret` | `--webhook-secret` | `BRUNEL_WEBHOOK_SECRET` | `WEBHOOK_SECRET` | (optional) |
| `foremanUrl` | `--foreman-url` | `BRUNEL_FOREMAN_URL` | — | `ws://localhost:3000` |
| `permissionMode` | `--permission-mode` | `BRUNEL_PERMISSION_MODE` | — | `default` |

`--dangerously-skip-permissions`: CLI-only bare flag; sets `permissionMode: "bypassPermissions"`.
`--verbose`: bare presence flag (no value argument); sets `verbose: true` (boolean, not string).
`--github-token`: emits `console.warn` about secret exposure; startup continues.

---

## Resolution Pipeline

```ts
// 1. File config
let fileConfig: Record<string, unknown> = {};
let filepath: string | undefined;
if (fileConfigOverride !== undefined) {
  fileConfig = fileConfigOverride;
} else {
  const result = await explorer.search();
  fileConfig = result?.config ?? {};
  filepath = result?.filepath;
}
warnIfSecretsInFile(fileConfig, filepath); // filepath may be undefined in tests

// 2. CLI flags — parseCliFlags returns Partial<RawConfig>
//    Boolean flags (--verbose, --dangerously-skip-permissions) return actual boolean true
//    Numeric flags (--port) return the raw string value; Zod coerces it
const cliFlags = parseCliFlags(argv);

// 3. BRUNEL_* env vars and fallback env vars (all string values; Zod coerces)
const brunelEnv = readBrunelEnvVars(process.env);
const fallbackEnv = readFallbackEnvVars(process.env);

// 4. Merge and validate
const raw = { ...fallbackEnv, ...fileConfig, ...brunelEnv, ...cliFlags };
const parsed = BrunelConfigSchema.parse(raw);
return { ...parsed, allowDangerouslySkipPermissions: parsed.permissionMode === "bypassPermissions" };
```

`warnIfSecretsInFile(config: Record<string, unknown>, filepath: string | undefined)`:
- Checks whether the keys `githubToken` or `webhookSecret` are present and non-empty in `config`
- For each secret key found, emits: `console.warn(\`[brunel] Warning: "${key}" found in config file${filepath ? ` (${filepath})` : ""}. Use the BRUNEL_... env var instead to avoid committing secrets.\`)`
- Does not inspect nested keys; only top-level fields
- When `filepath` is `undefined` (tests using `fileConfigOverride`), the file path is omitted; tests only assert `console.warn` was called, not the message content.

### `parseCliFlags` error cases

- `--permission-mode` with no following value → stderr + exit 1
- `--permission-mode` followed by another flag (starts with `--`) → stderr + exit 1
- `--permission-mode <unknown>` → stderr + exit 1, listing valid modes
- `--dangerously-skip-permissions` + `--permission-mode <non-bypass>` (both on CLI) → stderr + exit 1

Note: conflict detection is CLI-only. If `BRUNEL_PERMISSION_MODE=acceptEdits` is in the env and `--dangerously-skip-permissions` is on the CLI, the CLI flag wins (as expected by the layer precedence) and no error is raised — `permissionMode` becomes `"bypassPermissions"` from the CLI layer.

---

## Validation (Zod schema)

- `z.string().min(1)` for `githubRepo`, `githubToken`
- `z.string().optional()` for `webhookSecret`
- `z.coerce.number().int().positive()` for `port`
- `z.enum([...VALID_PERMISSION_MODES])` for `permissionMode`
- Boolean fields use `z.preprocess`: `"true"/"1"` → `true`; `"false"/"0"` → `false`; already-boolean passes through; any other string → validation error

On failure: human-readable message to stderr, exit 1.

---

## Testing

`tests/config.test.ts`:
- `process.exit` and `console.warn` spied on (same pattern as old `repl.permission-mode.test.ts`)
- File config injected via `fileConfigOverride`; `process.env` manipulated with save/restore

Cases:
- **Layer precedence**: CLI > `BRUNEL_*` env > file config > fallback env > default (one test per adjacent pair)
- **Legacy fallbacks**: `GITHUB_REPO`, `TASK_LABEL`, `DONE_LABEL`, `PORT`, `WEBHOOK_SECRET`, `GITHUB_TOKEN`, `GH_TOKEN` all resolve when `BRUNEL_*` absent; `GITHUB_TOKEN` wins over `GH_TOKEN`
- **Secrets warning**: `console.warn` when `githubToken`/`webhookSecret` in file config or `--github-token` on CLI; not when from env vars
- **Validation errors**: missing `githubRepo` → exit 1; missing `githubToken` → exit 1; `--port abc` → exit 1; `BRUNEL_PERMISSION_MODE=badvalue` → exit 1
- **Boolean coercion**: `"true"`/`"1"` → `true`; `"false"`/`"0"` → `false`; `"yes"` → exit 1
- **CLI flags**: `--port 4000`, `--verbose`, `--github-repo`, all others in naming table
- **Permission flags**: `--dangerously-skip-permissions` → `bypassPermissions` + `allowDangerouslySkipPermissions: true`; conflict → exit 1; `--permission-mode` missing/unknown/followed-by-flag → exit 1
- **`allowDangerouslySkipPermissions` derivation**: set via `BRUNEL_PERMISSION_MODE=bypassPermissions` (env) → `allowDangerouslySkipPermissions: true`
- **Defaults**: required fields only → correct defaults

`tests/repl.permission-mode.test.ts` is **deleted**; its tests migrate to `config.test.ts`, importing `VALID_PERMISSION_MODES` from `../src/config.js`.

Existing tests that need updating:
- `foreman.github.test.ts`: `loadIssuesToQueue`, `labelIssueDone`, `fetchIssueStates` now take explicit `opts`; update call sites to pass `{ repo: "owner/repo", token: "tok", ... }` directly instead of setting `process.env`
- `worker.test.ts`: `workerMain` now takes a second `config` argument; pass `{ foremanUrl: "ws://localhost:3000" }`
- `foreman.websocket.test.ts`: `createForemanWss` may need `{ repo, token }` in options if tests exercise `fetchBlockers`/`fetchIssueStates` paths (otherwise no change needed)
- `tests/smoke.ts`: calls `workerMain` indirectly; update as needed to match new signature

---

## Out of Scope

- Logging backend selection (file vs. DB)
- Interactive config wizard
- Config file validation beyond what zod provides
- Supporting `.ts` config files when running via plain `node`
