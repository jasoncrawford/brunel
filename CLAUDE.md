# brunel

A GitHub-driven autonomous agent. Labels a GitHub issue `brunel:ready` → the foreman picks it up, assigns it to a worker → the worker runs a Claude Agent SDK loop and reports completion when finished.

## Architecture

### Foreman (`src/foreman/`)

All foreman/server code lives in `src/foreman/` with clean MVC separation. Models own state; controllers handle external inputs and orchestrate.

**Entry point:**
- **`src/foreman/index.ts`** — Entry point and orchestrator. Wires components together, starts HTTP + WSS servers. No re-exports — import each symbol from its own module.

**Models (`src/foreman/models/`)** — classes that own and manage application state:
- **`src/foreman/db-client.ts`** — Shared DB module. Exports `db` (the live `SupabaseClient`) and `initDb(supabase)` to initialise it. All models import `db` from here; `index.ts` calls `initDb` once at startup.
- **`src/foreman/models/task.ts`** — `Task` active-record class. Owns all DB reads/writes for the `tasks` table. Imports `db` from `db-client.ts`. Static finders: `Task.get()`, `Task.getByIssue()`, `Task.getByPr()`, `Task.getByWorker()`, `Task.list()`, `Task.upsert()`. Static helpers: `Task.parseBodyBlockers(body)` parses "Depends on / Blocked by" refs; `Task.fetchBlockers(issueNumber, body, opts)` merges body-parsed and native GitHub blockers. Instance mutations: `assign()`, `complete()`, `revert()`, `close()`, `reopen()`, `registerPr()`, `unregisterPr()`, `mergePr()`, `updateContent()`, `delete()`. In-memory fields (not persisted): `blockers: BlockerInfo[]` (each entry has `{issueNumber, isOpen}`) and `blockersLoaded: boolean` — set by `TaskManager.hydrateBlockers()` before tasks are returned to callers. The `status` getter derives the current status from timestamps and returns `"blocked"` when `blockersLoaded && blockers.some(b => b.isOpen)`. `toSnapshot()` returns a self-describing `TaskSnapshot`. Use `Task.fromTest()` in tests to create instances without DB. `Task.events` is a static `EventEmitter` that fires `"changed"` after every mutation — any number of observers can subscribe independently.
- **`src/foreman/models/task-manager.ts`** — `TaskManager` class. Owns only ephemeral in-memory state with no DB backing: event queues (buffered GitHub events for pending/disconnected workers), branch mappings (branch→taskId for routing check_run/check_suite events), open-issue tracking (`_openIssues`), and per-issue blocker state (`_blockers`, `_blockersLoaded`). All DB reads go through `Task` statics. Emits `"changed"` (subscribed to `Task.events` in its own constructor) so the admin dashboard can refresh. Provides startup methods: `loadActiveTasksFromDb()` and `loadIssuesFromGithub()`. Blocker API: `setBlockers(n, blockers)`, `markBlockersLoaded(n)`, `resetBlockers(n)`, `isBlockersLoaded(n)`, `isBlocked(n)`. Issue lifecycle: `trackIssue(n)` (in-memory only, for tests/startup), `enqueueIssue(taskId, n, ...)` (track + DB upsert), `dequeueIssue(n)` (untrack + DB delete), `closeIssue(n)`, `reopenIssue(n)`, `setIssueOpenState(n, isOpen)`. Private `hydrateBlockers(task)` annotates task instances with in-memory blocker state before returning them.
- **`src/foreman/models/worker-registry.ts`** — `WorkerRegistry` class. Connected worker map: `register()`, `remove()`, `get()`, `getIdleWorkers()`, `assignTask()`, `releaseWorker()`. No DB or WebSocket knowledge.

**Controllers (`src/foreman/controllers/`)** — handle external inputs and orchestrate business logic:
- **`src/foreman/controllers/event-router.ts`** — `doRouteEvent()` and related GitHub event routing logic. Takes dependencies via an `EventRouterDeps` interface rather than closing over them. Also contains `reconcile()`, `startDepsLoad()`, `forwardEvent()`, `summaryEvent()`, `isMutedEvent()`, and `extractLinkedIssueNumber()`.
- **`src/foreman/controllers/http-server.ts`** — `createHttpServer()`: webhook handler, health endpoint, REST API, SPA static files.
- **`src/foreman/controllers/wss.ts`** — `createForemanWss()`: WebSocket plumbing + message dispatch. Takes `BrunelConfig` (or a `Pick` of it) directly rather than individual config values. Creates the `EventRouterDeps` and delegates routing to the event router. Contains connection lifecycle handlers (`handleWorkerHello`, `handleTaskComplete`, `handleWorkerGoodbye`) and assignment logic.

**Infrastructure (root `src/foreman/`)** — shared services and utilities used by both models and controllers:
- **`src/foreman/admin-ws.ts`** — Admin GUI WebSocket broadcaster. Attaches at `/admin/ws` and exposes `broadcastSnapshot` and `broadcastLogEvent`.
- **`src/foreman/db.ts`** — DB layer: `DbLogger`, `buildMessageSummary`, and their Supabase/null implementations. Logging only — task storage is handled by `task.ts`.
- **`src/foreman/github.ts`** — GitHub API: `loadIssuesToQueue`, `fetchIssueStates`, `fetchNativeBlockers`. `loadIssuesToQueue` calls `Task.upsert`, `Task.fetchBlockers`, and `taskModel.setBlockers/markBlockersLoaded` — no external graph parameter.
- **`src/foreman/event-queue.ts`** — `EventQueue` class with `enqueue(taskId, event)` and `drain(taskId)` methods. Held by `TaskManager` for buffering GitHub events for pending/disconnected workers.
- **`src/foreman/event-fmt.ts`** — `fmtEvent` for formatting GitHub events into human-readable summaries. Foreman-side copy so the foreman module has zero imports from `display.ts`.

The foreman has **zero imports from agent code** — `src/agent/` is a TUI/worker module that belongs entirely to the agent/worker side.

### Agent/Worker (`src/agent/`)

All agent/worker code lives in `src/agent/`:

- **`src/agent/index.ts`** — Entry point and unified agent loop. `main()` owns the full lifecycle: optionally calls `startWorkerMode()` if `--worker-mode` is set, prints the startup banner, runs the input/query loop, and calls `cleanup()` on exit. The bottom-of-file startup block is a single `await main(...)` with no mode fork. Also exports `runQuery` (the Claude SDK query runner) and `main` (for integration tests).
- **`src/agent/display.ts`** — Display/rendering engine for the worker TUI. Colors, ANSI escapes, status bar, Claude SDK message formatting.
- **`src/agent/worker.ts`** — WebSocket client, task lifecycle, and worker mode setup. `WorkerSession` owns the WebSocket connection, foreman protocol (hello/ack/task_assigned/event_notification/task_complete/goodbye), task state, prompt queuing, and `WorkerStatusModel`. Exposes `notifyQueryStart(ac)`, `notifyQueryEnd(aborted?)`, `hasPendingPrompts()`, `takeNextPrompt()`, `createWsInputPromise()`, `completeCurrentTask()`, `interrupt()`, `sendGoodbye()`, and `workspaceCommandDeps`. `WorkerSession.isWsSignal(input)` lets `main()` detect WS-triggered prompts without knowing the internal sentinel. `startWorkerMode(config)` sets up the workspace, session, and signal handlers and returns `{ session, cleanup }` — it does NOT call `main()`. Also exports `WorkerModeConfig`, `classifyEvent`, `debounceMs`, `WorkerStatusModel`, `registerWorkerCommands`.
- **`src/agent/commands.ts`** — Command registry: `register(name, opts)`, `lookup(name)`, `listAll(workerMode)`, `execute(name, args)`, `_reset()`. Also exports `scoped(prefix)` which returns a bound register that auto-prepends the namespace (e.g. `scoped("workspace")("create", opts)` registers `"workspace:create"`). Each command is registered with its implementation handler (`CommandHandler`). No built-in registrations at module load — commands are registered at startup by their owning modules. `HandlerResult = void | "exit" | "task-complete"` propagates signals through `execute()`. `_reset()` clears the registry for test isolation.
- **`src/agent/input.ts`** — User input handling: `ask()`, slash command parsing (uses canonical names only via `lookup()`), `dispatchInput()` (returns `{ type: "command"; name; args }` for registry commands), autocomplete.
- **`src/agent/workspace.ts`** — Git/npm workspace management: `Workspace` class, branch checkout, npm install, safety confirmations. Also exports `registerWorkspaceCommands(deps, workerMode?)` which registers `workspace:create/reset/remove/prune` using `scoped("workspace")`. `WorkspaceCommandDeps` has four fields: `workspace: { current }` (mutable ref), `config: { workspaceDir, repoUrl, sessionId } | undefined`, `originalCwd`, and `confirm`. Handlers call `display.print` and `process.chdir` directly.
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

TypeScript types are generated from the schema and committed at `src/database.types.ts`. After adding a migration, regenerate with:
```
supabase gen types typescript --local > src/database.types.ts
```
The `Database` type is passed to `createClient<Database>()` wherever a Supabase client is created, so TypeScript enforces the schema on all queries.

Worker IDs are plain text UUIDs generated by each worker and announced to the foreman during the hello/handshake. There is no `workers` table — `worker_id` columns in the DB are plain `text` with no FK constraint.

## Worker/Foreman handshake

Every `worker_hello` is immediately answered by a `hello_ack` before any `task_assigned` is sent. The ack carries a `status` field:

- `"idle"` — worker is free; foreman may now send `task_assigned`
- `"busy"` — worker's reconnection claim was accepted; worker may resume the task
- `"cancelled"` — worker's claimed task was taken by another worker, or the task is already complete (issue closed); worker should abandon it, reset the workspace, and become idle

Workers buffer any `task_complete` messages sent during the `hello_sent` state and flush them only after receiving an `idle` or `busy` ack. On `cancelled` the buffer is discarded.

## Task lifecycle

A task moves through states: **pending → assigned → pushed → merged/closed → complete** (derived from timestamps and runtime state).

- `Task` (active-record in `task.ts`) owns all DB reads/writes. `TaskManager` (`task-manager.ts`) owns only ephemeral state (event queues, branch maps, issue tracking). **There is no in-memory cache — all reads go through `Task` statics.** `initDb(supabase)` from `db-client.ts` must be called once at startup to wire the DB; `TaskManager` subscribes to `Task.events` in its own constructor. Supabase is required to run the foreman; `index.ts` exits with a clear error if credentials are not configured.
- The `tasks` table stores `task_id`, `issue_number` (unique), `repo`, `title`, `body`, `labels`, `worker_id`, `assigned_at`, `completed_at`, `issue_closed_at`, `pr_merged_at`. There is no separate `task_assignments` table or stored `status` column.
- **Status is derived** via the `Task.status` getter based on priorities: `completedAt` → 'complete', `issueClosedAt` → 'closed', `prMergedAt` → 'merged', `workerId` → 'assigned', `prNumber` → 'pushed', `blockersLoaded && blockers.some(b => b.isOpen)` → 'blocked', else → 'pending'.
- `Task.upsert()` conflicts on `task_id`. On conflict it refreshes only content fields (`title`, `body`, `labels`, `repo`, `issue_number`) — **status fields (`worker_id`, `assigned_at`, `completed_at`, `issue_closed_at`, `pr_merged_at`) are intentionally omitted from the ON CONFLICT DO UPDATE** so that existing assignments are preserved (e.g. during startup sync when `loadIssuesFromGithub` re-upserts already-assigned tasks). New rows get null status fields via DB defaults. Returns the `Task` instance.
- When a worker sends `worker_goodbye`, the foreman calls `task.revert()` which clears `worker_id` (reverting to pending). `assigned_at` is preserved so the row is immune to reconcile's cancel filter.
- When a GitHub issue is closed, `task.close()` sets `issue_closed_at`. When a PR is merged, `task.mergePr()` sets `pr_merged_at`. When a worker completes, `task.complete()` sets `completed_at`. These timestamp-based markers enable clean derivation of task status without a stored status column.
- On foreman restart, `taskManager.loadActiveTasksFromDb()` restores ephemeral branch mappings from DB, then `taskManager.loadIssuesFromGithub()` fetches open issues with the task label (calling `Task.upsert`, `Task.fetchBlockers`, etc.) and reconciles blocked/unblocked state. Stale pending DB tasks (issues that no longer have the task label) are deleted during `loadIssuesFromGithub()`. Tasks with `completedAt` set are skipped at startup. When a worker reconnects with a busy hello for an unknown task, the foreman creates a placeholder task via `Task.upsert()` so the worker can complete normally.
- `ForemanWss.reconcile` **only triggers worker assignment** (`assignIdleWorkers()`). It does not create, sync, or delete tasks. Task creation happens in `doRouteEvent` when `issues/labeled` fires (calling `taskManager.enqueueIssue`). Task deletion on label removal happens in `doRouteEvent`'s `issues/unlabeled` handler (calling `taskManager.dequeueIssue`). Stale task cleanup at startup happens in `loadIssuesToQueue`.
- `task.delete()` deletes the DB row only if `assigned_at IS NULL`. `task.revert()` (called on `worker_goodbye`) clears `worker_id` but preserves `assigned_at`, so rows that ever had a worker are immune to accidental deletion.
- `_openIssues`, `_blockers`, and `_blockersLoaded` are owned by `TaskManager`. Use `taskManager.trackIssue()`, `taskManager.enqueueIssue()`, `taskManager.dequeueIssue()`, `taskManager.closeIssue()`, `taskManager.setBlockers()`, `taskManager.markBlockersLoaded()` etc. to mutate them. Tests inject state via these methods — not by passing raw maps to `createForemanWss`. There is no `DependencyGraph` type or `dependencies.ts` module; blocker logic lives on `Task` (static methods) and `TaskManager` (state management).

## Design principles

- **Prefer event-based designs for real-time UIs.** Whether it's a terminal status bar (worker side) or a web dashboard (foreman side with WebSocket/React), the cleanest pattern is a model that holds state and emits events on change, with the UI subscribing to refresh automatically. Avoid scattering manual "refresh" calls throughout the code — they drift out of sync as the codebase grows. See `WorkerStatusModel` in `src/agent/worker.ts` for an example: model mutations emit `"change"`, and the display subscribes once in `start()` rather than calling `updatePersistentStatus()` from a dozen places.

## Key conventions

- TypeScript with ESM (`"type": "module"`). New dependencies must be ESM-compatible.
- No compilation step — `tsx` runs TypeScript directly.
- Webhook secret is optional for local dev; set `BRUNEL_WEBHOOK_SECRET` in `.env` to enable signature verification.
- Use `display.print()` (not `console.log`/`console.error`) for any output in worker/agent production code — routes through the status-bar-aware renderer so messages don't corrupt the prompt or status line. The foreman uses `console.log` directly (no TUI).
- In tests, use `loadDefaultConfig()` from `src/config.ts` to get a config object with schema defaults — don't export `DEFAULT_*` constants or repeat `loadConfig([], {...})` inline in each test file.
- In unit tests that exercise foreman logic without Supabase, call `setupInMemoryTasks(taskManager?)` from `tests/helpers/task.ts` in `beforeEach`. This spies on all `Task` statics and instance methods with an in-memory `Map` backing. Mutations emit on `Task.events` (and `TaskManager` instances pick them up via their own constructor subscription). Do not call `initDb()` in unit tests — `setupInMemoryTasks` handles mocking at the `Task` layer directly.
- For integration-level tests that spin up a real foreman process in-process (e.g. browser tests in `tests/browser/server.ts`), call `initDb(createMemoryTaskDb())` from `db-client.ts` and subscribe `Task.events.on("changed", ...)` as needed. The smoke test uses a real Supabase instance (started by CI) rather than the in-memory shim.
- `createForemanWss` takes `BrunelConfig` (or a `Pick`) directly rather than individual config values. Runtime dependencies (`dbLogger`, `adminWss`) go in a separate `deps` object. Do not re-export symbols from `index.ts` — import each symbol from its own module.
- In WebSocket tests, use the `makeQueue` helper (defined in each test file) instead of sequential `ws.once("message")` calls. Both `hello_ack` and `task_assigned` can arrive in the same TCP packet and fire synchronously — `makeQueue` installs a permanent listener with a FIFO buffer so no message is missed. Never use `q.next()` inside `Promise.race` — the losing branch's resolver stays in the waiters array and silently consumes the next real message. Use `q.isEmpty()` for non-blocking checks instead.
- In DB tests, each test file's `beforeEach` must only truncate the rows that file owns — not all rows in shared tables. Vitest runs test files in parallel workers; if file A's `beforeEach` truncates tables owned by file B, file B's concurrent tests will lose their data. Use `tests/helpers/db.ts`'s `createTestSupabase()` and truncate inline with targeted `.delete()` filters (by `delivery_id`, `worker_id`, `task_id`, etc.). When two test files share a table, also make assertions order-independent (e.g. `arrayContaining`) rather than relying on `entries[0]`. **Reconcile hazard:** `pipeline.test.ts` runs `reconcile()` which deletes unknown pending/blocked rows via `task.delete()` (`WHERE assigned_at IS NULL`). If `db.tasks.test.ts` creates pending rows concurrently, reconcile can delete them. Use `insertProtected()` (sets `assigned_at` to make rows immune to delete) for tests that need stable rows but aren't testing `Task.upsert()` itself. When a test must call `Task.upsert()` directly (e.g. testing the upsert itself), use `Task.get()` (direct PK lookup) immediately after the upsert rather than `Task.list()` to minimise the race window. The `cancelable=true` filter checks `worker_id IS NULL` — not `assigned_at IS NULL` — so `insertProtected` rows (assigned_at set, worker_id null) still satisfy the cancelable filter and can be used to test cancelable behaviour without reconcile risk. When routing multiple events in a pipeline test and the resulting WebSocket notifications may arrive out of order, route all events first then collect the expected number of messages and assert with `arrayContaining` rather than awaiting each in strict sequence. When querying `webhook_events` in pipeline tests, filter by `delivery_id` (unique per test) rather than `event_name` alone to avoid matching rows from concurrent Vitest workers.
- In browser tests, the server is shared across all tests. Use unique issue numbers per test (1001, 2001, …) to avoid cross-test state interference instead of resetting server state. When a test needs to fire an event and verify it appears live on a page, set up `page.waitForEvent("websocket", ws => ws.url().includes("/admin/ws"))` **before** `page.goto()`, then await the returned WebSocket and call `ws.waitForEvent("framereceived")` before firing the event — this prevents the race where the event is broadcast before the page's admin WebSocket has connected.
- `sendMsg(workerId, msg, logTaskId?)` accepts an optional `logTaskId` that overrides the taskId used for logging/broadcasting without changing the wire message. Use this when the wire protocol doesn't include a `taskId` field but the dashboard log entry should show task context (e.g. `sendMsg(workerId, { type: "hello_ack", ... }, taskId)` for `cancelled`/`busy` acks).
- `buildMessageSummary(direction, msgType, taskId, payload)` in `src/foreman/db.ts` is the single source of truth for log entry summaries. It is used by both the real-time broadcast path (`broadcastMessageEvent` in `wss.ts`) and the DB read path (`messageToEntry` in `db.ts`). Add new message type formatting here rather than in both places.
