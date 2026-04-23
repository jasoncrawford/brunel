# brunel

A GitHub-driven autonomous agent. Labels a GitHub issue `brunel:ready` → the foreman picks it up, assigns it to a worker → the worker runs a Claude Agent SDK loop and reports completion when finished.

## About this file

CLAUDE.md should contain high-level information about project structure, conventions, and workflows — things that help orient a developer quickly and that aren't obvious from reading the code. It should **not** document individual file APIs, method signatures, or implementation details; those belong in the code itself. Keep it concise so it doesn't consume unnecessary context tokens or drift out of date.

## Architecture

Two independent processes: **foreman** (server) and **worker** (agent). They communicate over WebSocket. The foreman has **zero imports from agent code** — `src/agent/` belongs entirely to the worker side.

### Foreman (`src/foreman/`)

MVC structure. Models own state; controllers handle external inputs.

- **Models** (`models/`) — `ActiveRecord` is the abstract base class for all DB-backed models. `Task`, `WebhookEvent`, `ForemanMessage`, and `Repo` are the main active-record models. `TaskManager` owns ephemeral in-memory state (event queues, branch mappings, blocker state) and encapsulates all issue/PR event lifecycle logic — one instance per repo, managed via a static registry (`TaskManager.forRepo(repo)`). `Repo` provides a convenience `get taskManager()` getter. `Worker` is the in-memory model for connected workers (not DB-backed).
- **Controllers** (`controllers/`) — `http-server.ts` handles webhooks + REST + SPA. `wss.ts` (`ForemanWss`) is the WebSocket protocol layer for worker↔foreman communication. `admin-ws.ts` broadcasts to the admin dashboard.
- **Clients** (`clients/`) — `db-client.ts` wires the shared Supabase client. `github.ts` wraps GitHub API calls.

### Agent/Worker (`src/agent/`)

A unified REPL + worker loop. `index.ts` is the composition root; `AgentController` handles running queries via the Claude SDK.

Follows MVC with three subdirectories:

- **Models** (`models/`) — `Workspace` (git/npm workspace management), `Settings` (runtime-settable preferences: model, effort, permissions), `QueryStats` (token usage/turn counts and API cost from SDK messages), `AgentStatus` (pure state model for worker status — emits `"change"` on updates, subscribed to by `Display` for reactive redraws)
- **Views** (`views/`) — `Display` (TUI terminal I/O — the single doorway to stdout), `Renderer` (pure string producers, no I/O), `Input` (readline-based REPL), `Picker` (arrow-key menus), `style.ts` (terminal color/style constants)
- **Controllers** (`controllers/`) — `AgentController` (runs queries), `WorkerController`/`WorkerSession` (WS protocol + task lifecycle), `WorkspaceController` (workspace lifecycle + `/workspace:*` slash commands), `CommandRegistry`/`CommandController` (slash command registration and dispatch), `SettingsController` (model/effort/permissions selection)

### Shared

- `src/` root — `config.ts` (unified config loader with `getConfig()` singleton), `wire.ts` (re-exports from `shared/wire.ts`)
- `shared/` — utilities needed by both Node backend and Vite frontend: `wire.ts` (wire protocol types), `formatters.ts` (pure data-to-string helpers)

## Task lifecycle

Status is **derived from timestamps**, not stored: `completedAt` → complete, `issueClosedAt` → closed, `prMergedAt` → merged, `workerId` → assigned, `prNumber` → pushed, open blockers → blocked, else → pending.

`Task.upsert()` intentionally does not overwrite status fields on conflict, so re-syncing at startup never clobbers existing assignments.

## Worker/Foreman handshake

Every `worker_hello` includes a `repo` field (owner/name parsed from `git remote get-url origin`). The foreman resolves this to a `Repo` via `Repo.findOrCreate()` and stores it on the `Worker` — every registered Worker always has a `Repo`. Missing or unresolvable repo is a fatal error.

Every `worker_hello` gets a `hello_ack` with one of three statuses before any task is sent:
- `idle` — worker is free, foreman may now assign
- `busy` — reconnection accepted, worker may resume
- `cancelled` — task was taken or completed; worker should reset and become idle

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

- `npm test` — unit tests (vitest)
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
- **Tests**: the DB is initialised globally with an in-memory shim via `tests/setup.ts`. See test helper files in `tests/helpers/` for utilities like `seedTask()`, `resetDb()`, `createTestRepo()`, `createTestTaskManager()`, and `registerTestCommands()`. `resetDb()` also clears the TaskManager registry.
- **Browser tests**: the server is shared across all tests — use unique issue numbers per test rather than resetting server state.
