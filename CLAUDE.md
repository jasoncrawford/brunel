# brunel

A GitHub-driven autonomous agent. Labels a GitHub issue `brunel:ready` → the foreman picks it up, assigns it to a worker → the worker runs a Claude Agent SDK loop and reports completion when finished.

## About this file

CLAUDE.md should contain high-level information about project structure, conventions, and workflows — things that help orient a developer quickly and that aren't obvious from reading the code. It should **not** document individual file APIs, method signatures, or implementation details; those belong in the code itself. Keep it concise so it doesn't consume unnecessary context tokens or drift out of date.

When making a change, check whether it affects anything documented here and update this file in the same PR.

## Architecture

Two independent processes: **foreman** (server) and **worker** (agent). They communicate over WebSocket. The foreman has **zero imports from agent code** — `src/agent/` belongs entirely to the worker side.

### Foreman (`src/foreman/`)

MVC structure. Models own state; controllers handle external inputs.

- **Models** (`models/`) — `ActiveRecord` is the abstract base class for all DB-backed models. `Task`, `WebhookEvent`, `ForemanMessage`, `Repo`, and `Worker` are the main active-record models. `TaskManager` owns ephemeral in-memory state (event queues, branch mappings, blocker state) and encapsulates all issue/PR event lifecycle logic — one instance per repo, managed via a static registry (`TaskManager.forRepo(repo)`). `Repo` provides a convenience `get taskManager()` getter. `Worker` persists worker records in the `workers` DB table with diagnostic timestamps (first/last connected, num_connections, disconnected_at, goodbye_at); an in-memory registry holds currently-connected `Worker` instances, and a static `sockets` map tracks live WebSocket connections. Use `Worker.fromRegistry(id)` for the sync in-memory lookup; `Worker.get(id)` is the inherited async DB lookup.
- **Controllers** (`controllers/`) — `http-server.ts` handles webhooks + REST + SPA. `wss.ts` (`ForemanWss`) is the WebSocket protocol layer for worker↔foreman communication. `admin-ws.ts` broadcasts to the admin dashboard.
- **Clients** (`clients/`) — `db-client.ts` wires the shared Supabase client. `github.ts` wraps GitHub API calls.

### Agent/Worker (`src/agent/`)

A unified REPL + worker loop. `index.ts` is the composition root; `AgentController` handles running queries via the Claude SDK.

Follows MVC with three subdirectories:

- **Models** (`models/`) — `Workspace` (git/npm workspace management), `Settings` (runtime-settable preferences: model, effort, permissions), `QueryStats` (token usage/turn counts and API cost from SDK messages), `AgentStatus` (pure state model for worker status — emits `"change"` on updates, subscribed to by `Display` for reactive redraws; also owns static git/id utilities `getCurrentBranch`, `getRemoteRepo`, `generateAgentId`)
- **Views** (`views/`) — `Display` (TUI terminal I/O — the single doorway to stdout), `Renderer` (pure string producers, no I/O), `Input` (readline-based REPL), `Picker` (arrow-key menus), `style.ts` (terminal color/style constants)
- **Controllers** (`controllers/`) — `AgentController` (runs queries), `WorkerController` (consolidated worker mode lifecycle: WebSocket protocol, task state, reconnect/heartbeat, `/worker:*` commands — previously split across `WorkerController` + `WorkerSession`), `WorkspaceController` (workspace lifecycle + `/workspace:*` slash commands), `CommandRegistry`/`CommandController` (slash command registration and dispatch), `SettingsController` (model/effort/permissions selection)

### Shared

- `src/` root — `config.ts` (unified config loader with `getConfig()` singleton), `wire.ts` (re-exports from `shared/wire.ts`)
- `shared/` — utilities needed by both Node backend and Vite frontend: `wire.ts` (wire protocol types), `formatters.ts` (pure data-to-string helpers)

## Task lifecycle

Status is **derived from timestamps**, not stored: `completedAt` → complete, `issueClosedAt` → closed, `prMergedAt` → merged, `workerId` → assigned, `prNumber` → pushed, open blockers → blocked, else → pending.

`Task.upsert()` intentionally does not overwrite status fields on conflict, so re-syncing at startup never clobbers existing assignments.

Task assignment is **repo-scoped**: `TaskManager.tryAssignWork()` only assigns a task to a worker if (a) the worker's repo status is `"active"` and (b) the task's `repoId` matches the worker's repo. Workers from inactive or mismatched repos are silently skipped. Cross-repo enforcement also applies on reconnect: if a worker reconnects claiming a task that belongs to a different repo, `handleBusyHello` sends `cancelled` and the worker resets to idle.

## Worker/Foreman handshake

Every `worker_hello` includes a `repo` field (owner/name parsed from `git remote get-url origin`). The foreman resolves this to a `Repo` via `Repo.findOrCreate()` and stores it on the `Worker` — every registered Worker always has a `Repo`. Missing or unresolvable repo is a fatal error.

Every `worker_hello` gets a `hello_ack` with one of three statuses before any task is sent:
- `idle` — worker is free, foreman may now assign
- `busy` — reconnection accepted, worker may resume
- `cancelled` — task was taken or completed; worker should reset and become idle

An idle `worker_hello` may include `claimTaskId` to atomically register and claim a specific task (used by the `/worker:claim` command on first connect). The foreman sends `hello_ack { status: "idle" }` first, then immediately sends `task_assigned` or a non-fatal `foreman_error`.

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

Config via `.env` or `brunel.config.ts` (CLI flags also accepted). See `src/config.ts` for all options.

## Useful scripts

- `npm test` — unit tests (vitest); excludes `frontend/**`
- `cd frontend && npm test` — frontend component tests (vitest + jsdom)
- `npm run smoke` — end-to-end smoke test: spawns real foreman + worker and asserts they connect
- `npm run test:browser` — Playwright browser tests for the admin dashboard (requires `npm run build` first)
- `npm run lint` — ESLint
- `npx tsc --noEmit` — type check

All five run in CI on every PR.

## Database

Supabase (hosted Postgres). Migrations live in `supabase/migrations/`. After adding a migration, regenerate types with:

```
supabase gen types typescript --local > src/database.types.ts
```

Most tests run without Supabase. DB tests (`db.*.test.ts`, `pipeline.test.ts`) require `supabase start`.

## Type system

See **`docs/type-system.md`** for the full design. In brief: one server model class per concept, one `Wire.*` interface per concept in `shared/wire.ts` (imported as `import * as Wire from "../../shared/wire.js"`). Prefer a single wire type with optional fields over multiple types for the same concept.

## Key conventions

- **Output in agent/worker code**: use `display.print(...)` on an injected `display: WorkerDisplay` instance — it routes through the status-bar-aware renderer so messages don't corrupt the TUI. `WorkerDisplay` interface is defined in `controllers/worker-controller.ts`.
- **Real-time UIs**: prefer event-based designs — a model holds state and emits on change; the UI subscribes once rather than scattering manual refresh calls.
- **Pass model objects, not IDs**: controllers look up model objects from wire message IDs first, then pass the objects to helpers.
- **Wire types**: all live in `shared/wire.ts`, imported as `import * as Wire from "../../shared/wire.js"`.
- **Tests**: the DB is initialised globally with an in-memory shim via `tests/setup.ts`. See test helper files in `tests/helpers/` for utilities like `seedTask()`, `resetDb()`, `createTestRepo()`, `createTestTaskManager()`, and `registerTestCommands()`. `resetDb()` also clears the TaskManager registry. Any test that expects task assignment must call `await taskModel.repo.activate()` after `createTestTaskManager()`, since repos start as `"new"`. **Display/TUI tests** should assert on what gets written to stdout (behavioral), not on internal state flags or spy call counts — those don't catch user-visible regressions.
- **Browser tests**: the server is shared across all tests — use unique issue numbers per test rather than resetting server state. Test helper endpoints (`/test/*`) must await any async side effects (e.g. WebSocket close handshakes, DB writes) before sending their HTTP response, so that callers can rely on the side effects being complete when the `await fetch(...)` resolves.
- **DB test isolation**: `db.*.test.ts` and `pipeline.test.ts` run in parallel against the same Supabase instance. `pipeline.test.ts` owns `task_id` values `"42"`, `"55"`, `"70"`, `"91"`, `"92"`, `"100"` and `worker_id` values `"w1"`, `"w2"`, `"w-reclaim"`, `"w-blocked"`, `"w-pr"` — avoid those in `db.*.test.ts` to prevent row-count contamination. Prefer a `"db-"` prefix (e.g. `"db-w1"`, `"db-filter-42"`) for identifiers unique to `db.*.test.ts`. Scope `beforeEach` cleanups to rows this file owns (by `worker_id`, `delivery_id`, etc.) rather than blanket-deleting entire tables.
