# brunel

A GitHub-driven autonomous agent. Labels a GitHub issue `brunel:ready` → the foreman picks it up, assigns it to a worker → the worker runs a Claude Agent SDK loop and reports completion when finished.

## Architecture

Two independent processes: **foreman** (server) and **worker** (agent). They communicate over WebSocket. The foreman has **zero imports from agent code** — `src/agent/` belongs entirely to the worker side.

### Foreman (`src/foreman/`)

MVC structure. Models own state; controllers handle external inputs.

- **Models** (`models/`) — `Task` is the active-record for tasks. `WebhookEvent` is the active-record for incoming GitHub webhook events (`webhook_events` table); `WebhookEvent.fromIncoming()` builds an in-memory instance and `toWorkerPayload()` maps `eventName` → `name` for the wire protocol. `MessageLog` is the active-record for foreman↔worker messages (`foreman_messages` table); `MessageLog.buildSummary()` is the single source of truth for log entry summaries. `queryActivityLog()` (in `activity-log.ts`) merges both tables by timestamp. `TaskManager` owns ephemeral in-memory state only (event queues, branch mappings, blocker state). `Worker` is the active-record for connected workers (module-level registry, static finders, `Worker._reset()` for test isolation).
- **Controllers** (`controllers/`) — `http-server.ts` handles webhooks + REST + SPA. `wss.ts` handles the WebSocket lifecycle with workers. `event-router.ts` routes GitHub events to the right worker or queue.
- **Infrastructure** — `db-client.ts` wires the shared Supabase client. `admin-ws.ts` broadcasts to the admin dashboard. `github.ts` wraps GitHub API calls.

### Agent/Worker (`src/agent/`)

A unified REPL + worker loop. `main()` in `index.ts` runs both interactive and worker modes; `startWorkerMode()` in `worker.ts` sets up the WebSocket session and returns before `main()` takes over the query loop.

Key files: `worker.ts` (WS protocol + task lifecycle), `display.ts` (TUI rendering), `command-registry.ts` (`CommandRegistry` class — instantiated in `index.ts` and injected into all modules; supports scoped sub-registries via `scoped(prefix)`; `registry.listCommandNames()` and `registry.listCommands()` return all available commands including file-based commands and skills), `workspace.ts` (git/npm workspace management), `templates.ts` (prompt templates).

### Shared

- `src/` root — `config.ts` (unified config loader), `wire.ts` (wire protocol types: `ForemanMessage` for foreman→worker messages, `WebhookEvent` for event payloads delivered to workers, `WorkerMessage` for worker→foreman messages, `TaskIssue` for issue data), `types.ts` (re-exports `TaskStatus` only), `utils.ts`
- `shared/` — utilities needed by both the Node backend and the Vite frontend

## Task lifecycle

Status is **derived from timestamps**, not stored: `completedAt` → complete, `issueClosedAt` → closed, `prMergedAt` → merged, `workerId` → assigned, `prNumber` → pushed, open blockers → blocked, else → pending.

`Task.upsert()` intentionally does not overwrite status fields on conflict, so re-syncing at startup never clobbers existing assignments.

## Worker/Foreman handshake

Every `worker_hello` gets a `hello_ack` with one of three statuses before any task is sent:
- `idle` — worker is free, foreman may now assign
- `busy` — reconnection accepted, worker may resume
- `cancelled` — task was taken or completed; worker should reset and become idle

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

See **`docs/type-system.md`** for the full design. In brief: one server model class per concept, one `Wire.*` interface per concept in `src/wire.ts` (imported as `import * as Wire from "./wire.js"`), shared domain types in `shared/types.ts`. Prefer a single wire type with optional fields over multiple types for the same concept. Name things after the concept, not the form — `Wire.Task` not `Wire.TaskSnapshot`.

## Key conventions

- Use `display.print()` (not `console.log`) for output in agent/worker code — it routes through the status-bar-aware renderer so messages don't corrupt the TUI.
- Prefer event-based designs for real-time UIs: a model holds state and emits on change; the UI subscribes once rather than scattering manual refresh calls.
- In unit tests, use `setupInMemoryTasks()` from `tests/helpers/task.ts` instead of `initDb()` — it mocks the `Task` layer with an in-memory map. `WebhookEvent.log()` and `MessageLog.log()` are fire-and-forget and guarded with `if (!db) return` inside a try-catch, so they silently no-op when Supabase is not initialized.
- Wire protocol types (foreman↔worker) live in `src/wire.ts` and are imported as `import * as Wire from "./wire.js"`. The DB model class for foreman messages is `MessageLog` (in `src/foreman/models/message-log.ts`), distinct from the wire type `Wire.ForemanMessage`.
- In agent tests that need slash commands, create a `CommandRegistry` instance directly (`new CommandRegistry()`) and populate it via `registerTestCommands()` from `tests/helpers.ts` (which returns the registry). Pass the registry to functions like `dispatchInput`, `parseSlashCommand`, etc.; call `registry.listCommandNames()` and `registry.listCommands()` directly on the registry (with injectable `listDir`/`readFile` args for testing). When calling `registerWorkspaceCommands` or `registerWorkerCommands` in tests, pass a pre-scoped registry (e.g. `registry.scoped("workspace")`) — scoping is always the caller's responsibility.
- In foreman tests that call `createForemanWss`, call `Worker._reset()` in `beforeEach` to clear the module-level worker registry between tests. `createForemanWss` takes no `registry` parameter — `Worker` is imported directly by `wss.ts` and `event-router.ts`.
- In browser tests, the server is shared across all tests — use unique issue numbers per test rather than resetting server state.
