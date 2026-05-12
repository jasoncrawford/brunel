# brunel

A GitHub-driven autonomous agent. Labels a GitHub issue `brunel:ready` → the foreman picks it up, assigns it to a worker → the worker runs a Claude Agent SDK loop and reports completion when finished.

## About this file

CLAUDE.md should contain high-level information about project structure, conventions, and workflows — things that help orient a developer quickly and that aren't obvious from reading the code. It should **not** document individual file APIs, method signatures, or implementation details; those belong in the code itself. Keep it concise so it doesn't consume unnecessary context tokens or drift out of date.

When making a change, check whether it affects anything documented here and update this file in the same PR.

## Architecture

Two independent processes: **foreman** (server) and **worker** (agent). They communicate over WebSocket. The foreman has **zero imports from agent code** — `src/agent/` belongs entirely to the worker side.

### Foreman (`src/foreman/`)

MVC structure. Models own state; controllers handle external inputs.

- **Models** (`models/`) — `ActiveRecord` is the abstract base class. `Task`, `WebhookEvent`, `ForemanMessage`, `Repo`, `Worker`, and `Installation` are the main DB-backed models. `TaskManager` owns ephemeral in-memory state (branch mappings, blocker state) and encapsulates all issue/PR event lifecycle logic — one instance per repo, managed via a static registry. `Installation` represents a GitHub App installation; `repos.installation_id` is a nullable FK (null = App not in use). `Worker` tracks both in-memory (connected) and DB-persisted state; use the registry for live connections, `Worker.get()` for DB lookups. `activity-log.ts` provides a cross-table merge of webhook events and foreman messages for the admin dashboard — cross-table concerns like this don't belong to either model class.
- **Servers** (`servers/`) — `http-server.ts` handles webhooks + REST + SPA (uses `ApiController` for API routes); accepts `webhookSecret?` and owns the `Webhooks` instance it exposes as `readonly webhooks`. `wss.ts` is a thin WebSocket transport layer (ping/pong, upgrade, connect/disconnect) that composes `WorkerController`, `WebhookController`, and `WorkerMessenger`; it exposes both sub-controllers as `readonly` properties and wires the `onAny` listener directly. `admin-ws.ts` broadcasts state snapshots and log events to the admin dashboard.
- **Controllers** (`controllers/`) — `WorkerController` owns all worker message business logic (hello handshakes, task assignment, reconnect, claim); `dispatch()` routes messages by convention: `foo_bar` → `handleFooBar`, `deps_loaded` listener is registered in the constructor. `WebhookController` owns webhook routing by convention: `foo_bar` event → `routeFooBarEvent` (e.g. `routePullRequestEvent`, `routeCheckRunEvent`, `routeIssuesEvent`, `routeIssueCommentEvent`); `handleEvent()` is the public entry point, `forwardEvent()` sends to the worker. `WorkerMessenger` is the outbound send infrastructure (analogous to a renderer): all messages sent to workers go through it so it can log and broadcast to the admin dashboard. `InstallationsController` handles GitHub App installation events (`installation.created/deleted`, `installation_repositories.added/removed`): creates/deletes `Installation` records, links/unlinks and activates/deactivates repos, and seeds tasks from GitHub.
- **Clients** (`clients/`) — `db-client.ts` wires the shared Supabase client. `GithubClient` supports two auth modes: personal-token and App installation token (auto-mints a short-lived token). Callers with an `Installation` record should use the installation auth mode.

### Agent/Worker (`src/agent/`)

A unified REPL + worker loop. `index.ts` is the composition root; `AgentController` handles running queries via the Claude SDK.

**Worker mode is human-supervised, not fully autonomous.** A human is always present at the terminal: they can type prompts, run slash commands, interrupt queries, and respond to confirmation dialogs. The foreman assigns tasks and sends prompts automatically, but the worker does not run unattended. Design accordingly — don't route around the human or assume no one is watching the console.

Follows MVC with three subdirectories:

- **Models** (`models/`) — `Workspace` (git/npm workspace management), `Settings` (runtime-settable preferences: model, effort, permissions), `QueryStats` (token usage/turn counts and API cost from SDK messages), `AgentStatus` (pure state model for worker status — emits `"change"` on updates, subscribed to by `Display` for reactive redraws; also owns static git/id utilities `getCurrentBranch`, `getRemoteRepo`, `generateAgentId`)
- **Views** (`views/`) — `Display` (TUI terminal I/O — the single doorway to stdout), `Renderer` (pure string producers, no I/O), `Input` (readline-based REPL), `Picker` (arrow-key menus), `style.ts` (terminal color/style constants)
- **Controllers** (`controllers/`) — `AgentController` (runs queries), `WorkerController` (consolidated worker mode lifecycle: WebSocket protocol, task state, reconnect/heartbeat, `/worker:*` commands; maintains an explicit three-state model: stopped / waiting / active — `transitionToIdle()` is the canonical entry point for the waiting state), `WorkspaceController` (workspace lifecycle + `/workspace:*` slash commands; event listeners are registered once in the constructor, not in `onCreate()` or other per-operation methods), `CommandRegistry`/`CommandController` (slash command registration and dispatch; commands registered with `canRunFromArgs: true` can be invoked directly from CLI args, e.g. `brunel worker:start`; `exitAfterRunFromArgs: true` causes the process to exit after the command completes rather than entering the REPL), `SettingsController` (model/effort/permissions selection)

### Shared

- `src/` root — `config.ts` (unified config loader with `getConfig()` singleton; also exports `parseCommandFromArgs()` which extracts the first positional CLI arg as a command name for direct CLI invocation), `wire.ts` (re-exports from `shared/wire.ts`)
- `shared/` — utilities needed by both Node backend and Vite frontend: `wire.ts` (wire protocol types and the `PROTOCOL_VERSION` integer constant), `formatters.ts` (pure data-to-string helpers)

## Task lifecycle

Status is **derived from timestamps**, not stored: `completedAt` → complete, `issueClosedAt` → closed, `prMergedAt` → merged, `workerId` → assigned, `prNumber` → pushed, open blockers → blocked, else → pending.

`Task.upsert()` intentionally does not overwrite status fields on conflict, so re-syncing at startup never clobbers existing assignments.

Task assignment is **repo-scoped**: `TaskManager.tryAssignWork()` only assigns a task to a worker if (a) the worker's repo status is `"active"` and (b) the task's `repoId` matches the worker's repo. Workers from inactive or mismatched repos are silently skipped. Cross-repo enforcement also applies on reconnect: if a worker reconnects claiming a task that belongs to a different repo, `handleAssignedHello` sends `cancelled` and the worker resets to idle.

## Worker/Foreman handshake

Every `worker_hello` includes a `repo` field (owner/name parsed from `git remote get-url origin`), a `version` string (package version), and a `protocolVersion` integer. The foreman resolves the repo to a `Repo` via `Repo.findOrCreate()` and stores it on the `Worker` — every registered Worker always has a `Repo`. Missing or unresolvable repo is a fatal error. An incompatible `protocolVersion` is also a fatal error ("your worker is too old, please update"). `version` and `protocolVersion` are recorded in the `workers` table on each connection.

**Worker authentication** uses one of two paths, evaluated after repo resolution:
- **GitHub token auth** (preferred): if `worker_hello` carries a `githubToken` and the App is configured (`appId` + `appPrivateKey`), the foreman checks for a repo installation. If no installation exists, it sends a fatal `foreman_error` with an actionable message directing the user to install the App. If an installation is found, the foreman calls `GET /user` with the worker token to get the login, then `GET /repos/.../collaborators/{login}/permission` with a minted installation token. Workers without `push` or `admin` receive a fatal `foreman_error`.
- **Worker secret fallback**: if `githubToken` is absent or the App is not configured, the foreman falls back to comparing `msg.workerSecret` against `config.workerSecret` (no-op when neither is set).

Every `worker_hello` gets a `hello_ack` with one of four statuses before any task is sent:
- `ready` — worker is free and available for auto-assignment
- `reserved` — worker is registered but NOT available for auto-assignment (will send `claim_task` next)
- `assigned` — reconnection accepted, worker may resume the in-progress task
- `cancelled` — task was taken or completed; worker should reset and become idle

Worker state transitions happen via dedicated messages while the worker stays connected:
- `task_complete { nextState: "reserved" }` — complete a task; always sends `reserved` so the foreman holds the worker out of the auto-assignment pool while the post-task picker is showing. Pass `nextState: "reserved"` explicitly in the claim flow to skip the picker entirely.
- `worker_ready` — transition from `reserved` → `ready`; sent after the user confirms "wait for next task" in the picker, by `/worker:start` (or its alias `/worker:ready`), or immediately in non-interactive mode
- `worker_reserved` — transition from `ready` → `reserved` without disconnecting; sent when the user presses `^C` while waiting (no task)

The `/worker:claim` command connects with `status: "reserved"` (no `claimTaskId` in the hello), receives `hello_ack { status: "reserved" }`, then sends `claim_task { taskId }` separately. The foreman replies with `task_assigned` or a non-fatal `foreman_error`.

`hello_ack` also carries `repoStatus: "new" | "active"`. If `"new"`, the worker prompts the user to activate the repo. On confirmation the worker sends `activate_repo`; the foreman activates the repo, seeds tasks from open labeled issues, and replies with `repo_activated`. The worker then transitions to idle and normal task assignment proceeds. If the user declines activation, the worker exits worker mode and returns to the interactive REPL.

If a catastrophic error occurs, the foreman sends `foreman_error` (`{ type, message, fatal }`). `fatal: true` causes the worker to stop reconnecting and return to interactive REPL mode.

## Dev workflow

Three terminals:

```
# terminal 1 — proxy GitHub webhooks to localhost
npx smee-client --url https://smee.io/YOUR_CHANNEL --target http://localhost:3000/webhook

# terminal 2 — run the foreman
npm start

# terminal 3 — run a worker
npm run worker
```

Config via `.env` or `brunel.config.ts` (CLI flags also accepted). See `src/config.ts` for all options. Positional args that aren't flag values are treated as command invocations (e.g. `brunel worker:start`, `brunel workspace:prune`, `brunel worker:claim 512`).

## Useful scripts

- `npm test` — unit tests (vitest); excludes `frontend/**`
- `npm run coverage` — unit tests + coverage report; this is what CI runs (use `npm test` locally for a faster feedback loop)
- `cd frontend && npm test` — frontend component tests (vitest + jsdom)
- `npm run smoke` — end-to-end smoke test: spawns real foreman + worker and asserts they connect
- `npm run test:browser` — Playwright browser tests for the admin dashboard (requires `npm run build` first)
- `npm run lint` — ESLint
- `npx tsc --noEmit` — type check

All five run in CI on every PR (coverage, frontend tests, browser tests, lint, type check).

## Releases

To publish a new version to npm, bump the version and push the tag — CI handles the rest:

```
npm version patch   # or minor / major
git push --tags
```

`.github/workflows/publish.yml` triggers on `v*` tags, builds the frontend, and runs `npm publish` using the `NPM_TOKEN` repo secret.

## Database

Supabase (hosted Postgres). Migrations live in `supabase/migrations/`. After adding a migration, `src/database.types.ts` is regenerated automatically by CI (`.github/workflows/regen-db-types.yml`) and committed back to the PR branch. To regenerate locally:

```
supabase gen types typescript --local > src/database.types.ts
```

Most tests run without Supabase. DB tests (`db.*.test.ts`, `pipeline.test.ts`) require `supabase start`.

## Type system

See **`docs/type-system.md`** for the full design. In brief: one server model class per concept, one `Wire.*` interface per concept in `shared/wire.ts` (imported as `import * as Wire from "../../shared/wire.js"`). Prefer a single wire type with optional fields over multiple types for the same concept.

## Key conventions

- **Output in agent/worker code**: use `display.print(...)` on an injected `display: WorkerDisplay` instance — it routes through the status-bar-aware renderer so messages don't corrupt the TUI. `WorkerDisplay` interface is defined in `controllers/worker-controller.ts`. When calling `display.startBar()`, always call `display.stopBar()` in a `finally` block so the bar is cleared even if the surrounding code throws — leaving it active causes subsequent console output to visually concatenate with the bar text.
- **Verbose output**: gate detailed output (full paths, URLs, diagnostic info) behind `config.verbose`. Non-verbose messages should be short status strings ("Creating workspace...", "Resetting workspace..."). Pass verbose as a `{ verbose: boolean }` config struct to controllers that need it — do not put it on `WorkerDisplay`. Never print credentials or tokens even in verbose mode; mask them (e.g. `[token]`) in any displayed URL.
- **Worker state model**: `WorkerController` has three explicit states — stopped (REPL prompt `>`), waiting (connected, no task), and active (task assigned). `_deactivate()` is the canonical entry for the stopped state — every deactivation path (`stop()`, fatal `foreman_error`) must call it; it sets `_isActive`, `workerModeActive`, `connectionStatus`, and `reconnectAt` atomically. `_setIdleState()` is the canonical entry point for the waiting state — every code path that enters waiting must call it; `transitionToIdle()` wraps it for reconnect paths that also need connection setup. The waiting state has two sub-states tracked by `_isReserved`: ready (auto-assignable, status bar shows "waiting for task") and reserved (not auto-assignable, status bar shows "no current task"). The `workerReady` field on `AgentStatus` carries this distinction to the renderer. `WorkspaceController` registers all event listeners once in the constructor; do not add `workspace.on(…)` calls anywhere else.
- **Keyboard rules**: `^C`/`^D` at a visible prompt (states 1, 3-at-prompt, or 2-reserved) = quit — calls `stop()` (with task-quit confirmation if active) then exits on `^D`/`/exit`. `^C` with no visible prompt (state 3 running a query) = interrupt. `^C` with no visible prompt (state 2 waiting, `ask("")`) = reserve — calls `workerController.reserve()`, sends `worker_reserved` to foreman, transitions to a visible prompt so the user can `/worker:claim`. `^D` with no visible prompt (state 2, `ask("")`) = no-op.
- **Real-time UIs**: prefer event-based designs — a model holds state and emits on change; the UI subscribes once rather than scattering manual refresh calls.
- **Pass model objects, not IDs**: controllers look up model objects from wire message IDs first, then pass the objects to helpers.
- **Wire types**: all live in `shared/wire.ts`, imported as `import * as Wire from "../../shared/wire.js"`.
- **Tests**: the DB is initialised globally with an in-memory shim (`tests/setup.ts`). Helper utilities live in `tests/helpers/` — look there for seed functions, repo/task factories, and reset helpers. Repos start as `"new"`; call `repo.activate()` before any test that expects task assignment. **Display/TUI tests** should assert on stdout output (behavioral), not on internal state. **Fire-and-forget DB operations** use `vi.waitFor(...)` rather than fixed timeouts — fixed delays are flaky under coverage instrumentation.
- **Browser tests**: the server is shared across all tests — use unique issue numbers rather than resetting server state. Test helper endpoints (`/test/*`) must await async side effects before responding. The in-memory DB shim (`tests/helpers/memory-db.ts`) is generic — it works for any table and needs no changes when the schema evolves. When adding a new table with `NOT NULL DEFAULT` columns that models read, add an entry to `columnDefaultFns` in `memory-db.ts` so the shim mirrors those defaults. **Do not link a GitHub App installation to `owner/repo`** (the shared test repo) — once a repo has `installationId` set, `GithubClient` switches to App token auth for all API calls (including `fetchNativeBlockers`); without `appId`/`appPrivateKey` configured, this silently prevents `deps_loaded` from firing and breaks task-assignment tests. Use a dedicated fresh repo for any test that needs installation data (via the `/test/link-installation` endpoint).
- **DB test isolation**: `db.*.test.ts` and `pipeline.test.ts` run in parallel against the same Supabase instance. `pipeline.test.ts` owns `task_id` values `"42"`, `"55"`, `"70"`, `"91"`, `"92"`, `"100"` and `worker_id` values `"w1"`, `"w2"`, `"w-reclaim"`, `"w-blocked"`, `"w-pr"` — avoid those in `db.*.test.ts` to prevent row-count contamination. Prefer a `"db-"` prefix (e.g. `"db-w1"`, `"db-filter-42"`) for identifiers unique to `db.*.test.ts`. Scope `beforeEach` cleanups to rows this file owns (by `worker_id`, `delivery_id`, etc.) rather than blanket-deleting entire tables.
