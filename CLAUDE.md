# brunel

A GitHub-driven autonomous agent. Labels a GitHub issue `brunel:ready` → the foreman picks it up, assigns it to a worker → the worker runs a Claude Agent SDK loop and reports completion when finished.

## Architecture

### Foreman (`src/foreman/`)

All foreman/server code lives in `src/foreman/` with clean MVC separation:

- **`src/foreman/index.ts`** — Entry point and orchestrator. Wires components together, starts HTTP + WSS servers. No re-exports — import each symbol from its own module.
- **`src/foreman/task-model.ts`** — `TaskModel` class and `Task` interface: the single owner of all task state. There is no in-memory cache — all reads go through the `TaskStore` (Supabase in production, `createMemoryTaskStore()` for local dev/tests). The only in-memory state is ephemeral data with no DB backing: event queues (buffered GitHub events for pending/disconnected workers), branch mappings (branch→taskId for routing check_run/check_suite events), and GitHub issue tracking (`labeledIssues`/`openIssues` for dependency resolution). All read methods are async. Provides startup methods: `loadActiveTasksFromDb()` and `loadIssuesFromGithub()`.
- **`src/foreman/worker-registry.ts`** — `WorkerRegistry` class. Connected worker map: `register()`, `remove()`, `get()`, `getIdleWorkers()`, `assignTask()`, `releaseWorker()`. No DB or WebSocket knowledge.
- **`src/foreman/event-router.ts`** — `doRouteEvent()` and related GitHub event routing logic. Takes dependencies via an `EventRouterDeps` interface rather than closing over them. Also contains `reconcile()`, `startDepsLoad()`, `forwardEvent()`, `summaryEvent()`, `isMutedEvent()`, and `extractLinkedIssueNumber()`.
- **`src/foreman/http-server.ts`** — `createHttpServer()`: webhook handler, health endpoint, REST API, SPA static files.
- **`src/foreman/wss.ts`** — `createForemanWss()`: WebSocket plumbing + message dispatch. Takes `BrunelConfig` (or a `Pick` of it) directly rather than individual config values. Creates the `EventRouterDeps` and delegates routing to the event router. Contains connection lifecycle handlers (`handleWorkerHello`, `handleTaskComplete`, `handleWorkerGoodbye`) and assignment logic.
- **`src/foreman/admin-ws.ts`** — Admin GUI WebSocket broadcaster. Attaches at `/admin/ws` and exposes `broadcastSnapshot` and `broadcastLogEvent`.
- **`src/foreman/db.ts`** — DB layer: `DbLogger`, `TaskStore`, `buildMessageSummary`, and their Supabase/memory implementations. `createMemoryTaskStore()` is a full in-memory `TaskStore` implementation used for local dev and tests that don't need Supabase.
- **`src/foreman/github.ts`** — GitHub API: `loadIssuesToQueue`, `fetchIssueStates`, `fetchNativeBlockers`.
- **`src/foreman/dependencies.ts`** — Dependency graph: `parseBodyBlockers`, `setBlockers`, `isBlocked`, `fetchBlockers`.
- **`src/foreman/event-fmt.ts`** — `fmtEvent` for formatting GitHub events into human-readable summaries. Foreman-side copy so the foreman module has zero imports from `display.ts`.

The foreman has **zero imports from agent code** — `src/agent/` is a TUI/worker module that belongs entirely to the agent/worker side.

### Agent/Worker (`src/agent/`)

All agent/worker code lives in `src/agent/`:

- **`src/agent/index.ts`** — Entry point: core agent loop. Interactive REPL (default) or worker process (`--worker-mode`). Workers connect to the foreman, receive tasks, run Claude Agent SDK sessions, and report completion.
- **`src/agent/display.ts`** — Display/rendering engine for the worker TUI. Colors, ANSI escapes, status bar, Claude SDK message formatting.
- **`src/agent/worker.ts`** — WebSocket client + task lifecycle. `WorkerSession`, `WorkerStatusModel`, event classification, debouncing.
- **`src/agent/input.ts`** — User input handling: `ask()`, slash command parsing, command dispatch, autocomplete.
- **`src/agent/workspace.ts`** — Git/npm workspace management: `Workspace` class, branch checkout, npm install, safety confirmations.
- **`src/agent/templates.ts`** — Prompt templates: `buildInitialPrompt`, `buildEventPrompt`, event formatting.
- **`src/agent/model.ts`** — Model selection logic: cached model list from the SDK, `/model` command handler, `findModel` exact-match lookup. The SDK returns short aliases (`default`, `opus`, `haiku`, `sonnet[1m]`, `opus[1m]`); `"sonnet"` is hardcoded to map to `"default"`. Unknown strings are accepted with a warning (power-user escape hatch for full model IDs).
- **`src/agent/effort.ts`** — Effort level selection: `/effort` command handler with interactive picker and direct set. Valid levels: `low`, `medium`, `high`, `max`, `auto` (default). `auto` maps to `undefined` (let the SDK decide). Unlike model, effort is a closed set — unknown values are rejected.

### Shared (top-level `src/`)

- **`src/config.ts`** — Unified config loader. Merges CLI flags, `BRUNEL_*` env vars, `brunel.config.ts` file, legacy env vars, and built-in defaults via zod schema.
- **`src/types.ts`** — Shared types: `WorkerMessage`, `ForemanMessage`, `TaskIssue`, `GitHubEvent`.
- **`src/utils.ts`** — Shared utilities.

### Shared

- **`shared/`** — Code shared between the Node backend (`src/`) and the Vite frontend (`frontend/src/`). Both `tsconfig.json` (root) and `frontend/tsconfig.json` include this directory. Import using `../shared/utils.js` (backend, `.js` extension for NodeNext) or `../../../shared/utils.ts` (frontend pages, `.ts` extension ok with `allowImportingTsExtensions`). Put utilities here when they're needed in both build contexts.

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

Config (in `.env` or `brunel.config.ts`; CLI flags also accepted). Precedence: CLI flags > `BRUNEL_*` env vars > config file > legacy env vars > defaults. See `src/config.ts` for the full list of options, env var names, legacy fallbacks, and defaults.

## Useful scripts

- `npm test` — unit tests (vitest)
- `npm run smoke` — end-to-end smoke test: spawns real foreman + worker and asserts they connect
- `npm run test:browser` — Playwright browser tests for the admin dashboard (requires a built frontend: `npm run build` first)
- `npm run lint` — ESLint (`no-floating-promises` as error, `no-explicit-any` as warn)
- `npx tsc --noEmit` — type check

All five run in CI on every PR.

## Running tests locally

Browser tests require a built frontend and Playwright browsers:

```
npm run build                        # build the admin dashboard SPA
npx playwright install chromium      # first time only
npm run test:browser
```

The browser tests start a real foreman on port 14567 via `playwright.config.ts` `webServer`. State is seeded through real `POST /webhook` calls; test-only helpers (`/test/connect-worker`, `/test/workers/:id`) live in `tests/browser/server.ts` and are added by intercepting `rawListeners("request")` so the production `createHttpServer` is never modified.

Most tests run without any external services. Only the four DB test files (`db.*.test.ts`, `pipeline.test.ts`) require a running Supabase instance. Without Supabase, those tests fail with a clear message and the rest pass normally:

```
supabase start   # first time takes a few minutes to pull Docker images
npm test
```

`tests/globalSetup.ts` runs once before the test suite. It reads the service-role key from `supabase status` (or from `SUPABASE_SERVICE_ROLE_KEY` if already set) and injects it into `process.env` so all Vitest worker threads inherit it. If Supabase is unavailable it sets `SUPABASE_UNAVAILABLE=true`; `createTestSupabase()` then throws with a helpful message so only DB tests fail. CI starts Supabase automatically via `supabase/setup-cli@v1` + `supabase start`.


## Database

Supabase (hosted Postgres). Migrations live in `supabase/migrations/`. The GitHub Actions workflow at `.github/workflows/migrate.yml` runs `supabase db push` automatically on push to `main` when migration files change, and can also be triggered manually via `workflow_dispatch`.

Worker IDs are plain text UUIDs generated by each worker and announced to the foreman during the hello/handshake. There is no `workers` table — `worker_id` columns in the DB are plain `text` with no FK constraint.

## Worker/Foreman handshake

Every `worker_hello` is immediately answered by a `hello_ack` before any `task_assigned` is sent. The ack carries a `status` field:

- `"idle"` — worker is free; foreman may now send `task_assigned`
- `"busy"` — worker's reconnection claim was accepted; worker may resume the task
- `"cancelled"` — worker's claimed task was taken by another worker, or the task is already complete (issue closed); worker should abandon it, reset the workspace, and become idle

Workers buffer any `task_complete` messages sent during the `hello_sent` state and flush them only after receiving an `idle` or `busy` ack. On `cancelled` the buffer is discarded.

## Task lifecycle

A task moves through states: **pending → assigned → complete**.

- `TaskModel` owns all task state via a pluggable `TaskStore` (Supabase in production, `createMemoryTaskStore()` for local dev/tests). **There is no in-memory cache — all reads go through the store.** The only in-memory state is ephemeral data with no DB backing (event queues, branch mappings, `labeledIssues`/`openIssues`).
- The `tasks` table stores `task_id`, `issue_number` (unique), `repo`, `title`, `body`, `labels`, `status`, `worker_id`, `assigned_at`, `completed_at`. There is no separate `task_assignments` table.
- `upsertTask` conflicts on `task_id`. If an issue is re-labeled `brunel:ready` (e.g. after completing), it resets `status` back to `pending` and refreshes `title`, `body`, `labels` — it does **not** ignore duplicates.
- When a worker sends `worker_goodbye`, the foreman calls `taskModel.revert()` which resets the DB row to pending.
- When a GitHub issue is closed while a worker is still active, the foreman marks the task `complete` in the DB immediately. The worker stays assigned and will call `task_complete` to release itself when done.
- On foreman restart, `taskModel.loadActiveTasksFromDb()` restores ephemeral branch mappings from DB, then `taskModel.loadIssuesFromGithub()` fetches open issues with the task label and reconciles blocked/unblocked state. Tasks whose issues were closed mid-task are `complete` in the DB and skipped by startup. When a worker reconnects with a busy hello for an unknown task, the foreman creates a placeholder task via `register()` so the worker can complete normally.
- `reconcile()` only removes **pending** and **blocked** tasks that are no longer in `labeledIssues`. Assigned and complete tasks are never removed by reconcile. Removal calls `taskModel.cancel()`, which deletes the DB row — but only if `assigned_at IS NULL`. `markPending()` (called on `worker_goodbye`) leaves `assigned_at` intact, so rows that ever had a worker are preserved even if the task reverts to pending before the label is removed.
- `labeledIssues` and `openIssues` are owned by `TaskModel` (not raw maps in the closure). Use `taskModel.trackIssue()`, `taskModel.untrackIssue()`, `taskModel.closeIssue()` etc. to mutate them. Tests inject state via these methods — not by passing raw maps to `createForemanWss`.

## Design principles

- **Prefer event-based designs for real-time UIs.** Whether it's a terminal status bar (worker side) or a web dashboard (foreman side with WebSocket/React), the cleanest pattern is a model that holds state and emits events on change, with the UI subscribing to refresh automatically. Avoid scattering manual "refresh" calls throughout the code — they drift out of sync as the codebase grows. See `WorkerStatusModel` in `src/agent/worker.ts` for an example: model mutations emit `"change"`, and the display subscribes once in `start()` rather than calling `updatePersistentStatus()` from a dozen places.

## Key conventions

- TypeScript with ESM (`"type": "module"`). New dependencies must be ESM-compatible.
- No compilation step — `tsx` runs TypeScript directly.
- Webhook secret is optional for local dev; set `BRUNEL_WEBHOOK_SECRET` in `.env` to enable signature verification.
- Use `display.print()` (not `console.log`/`console.error`) for any output in worker/agent production code — routes through the status-bar-aware renderer so messages don't corrupt the prompt or status line. The foreman uses `console.log` directly (no TUI).
- In tests, use `loadDefaultConfig()` from `src/config.ts` to get a config object with schema defaults — don't export `DEFAULT_*` constants or repeat `loadConfig([], {...})` inline in each test file.
- `createForemanWss` takes `BrunelConfig` (or a `Pick`) directly rather than individual config values. Runtime dependencies (`graph`, `dbLogger`, `adminWss`) go in a separate `deps` object. Do not re-export symbols from `index.ts` — import each symbol from its own module.
- In WebSocket tests, use the `makeQueue` helper (defined in each test file) instead of sequential `ws.once("message")` calls. Both `hello_ack` and `task_assigned` can arrive in the same TCP packet and fire synchronously — `makeQueue` installs a permanent listener with a FIFO buffer so no message is missed. Never use `q.next()` inside `Promise.race` — the losing branch's resolver stays in the waiters array and silently consumes the next real message. Use `q.isEmpty()` for non-blocking checks instead.
- In DB tests, each test file's `beforeEach` must only truncate the rows that file owns — not all rows in shared tables. Vitest runs test files in parallel workers; if file A's `beforeEach` truncates tables owned by file B, file B's concurrent tests will lose their data. Use `tests/helpers/db.ts`'s `createTestSupabase()` and truncate inline with targeted `.delete()` filters (by `delivery_id`, `worker_id`, `task_id`, etc.). When two test files share a table, also make assertions order-independent (e.g. `arrayContaining`) rather than relying on `entries[0]`. **Reconcile hazard:** `pipeline.test.ts` runs `reconcile()` which deletes unknown pending/blocked rows via `cancel()` (`WHERE assigned_at IS NULL`). If `db.tasks.test.ts` creates pending rows concurrently, reconcile can delete them. Use `insertProtected()` (sets `assigned_at` to make rows immune to cancel) for tests that need stable rows but aren't testing `upsertTask` itself.
- In browser tests, the server is shared across all tests. Use unique issue numbers per test (1001, 2001, …) to avoid cross-test state interference instead of resetting server state. When a test needs to fire an event and verify it appears live on a page, set up `page.waitForEvent("websocket", ws => ws.url().includes("/admin/ws"))` **before** `page.goto()`, then await the returned WebSocket and call `ws.waitForEvent("framereceived")` before firing the event — this prevents the race where the event is broadcast before the page's admin WebSocket has connected.
- `sendMsg(workerId, msg, logTaskId?)` accepts an optional `logTaskId` that overrides the taskId used for logging/broadcasting without changing the wire message. Use this when the wire protocol doesn't include a `taskId` field but the dashboard log entry should show task context (e.g. `sendMsg(workerId, { type: "hello_ack", ... }, taskId)` for `cancelled`/`busy` acks).
- `buildMessageSummary(direction, msgType, taskId, payload)` in `src/foreman/db.ts` is the single source of truth for log entry summaries. It is used by both the real-time broadcast path (`broadcastMessageEvent` in `wss.ts`) and the DB read path (`messageToEntry` in `db.ts`). Add new message type formatting here rather than in both places.
