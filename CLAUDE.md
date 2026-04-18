# brunel

A GitHub-driven autonomous agent. Labels a GitHub issue `brunel:ready` → the foreman picks it up, assigns it to a worker → the worker runs a Claude Agent SDK loop and reports completion when finished.

## Architecture

Two independent processes: **foreman** (server) and **worker** (agent). They communicate over WebSocket. The foreman has **zero imports from agent code** — `src/agent/` belongs entirely to the worker side.

### Foreman (`src/foreman/`)

MVC structure. Models own state; controllers handle external inputs.

- **Models** (`models/`) — `ActiveRecord` (`active-record.ts`) is the abstract base class for all DB-backed models; it provides `select()`, `get()`, `getBy()`, `list()`, `insert()`, `update()`, and `delete()` using `db.from(tableName)` with `as any` casts since the table name is a runtime string. `Task` is the active-record for tasks; `task.toAssignmentPayload()` returns the issue object for the `task_assigned` wire message. `WebhookEvent` is the active-record for incoming GitHub webhook events (`webhook_events` table); `WebhookEvent.fromIncoming()` builds an in-memory instance and `toWorkerPayload()` maps `eventName` → `name` for the wire protocol; `WebhookEvent.format()` returns a human-readable admin-dashboard string (event formatting helpers are private static methods on this class, kept here so the foreman has zero imports from agent/worker TUI code). `ForemanMessage` is the active-record for foreman↔worker messages (`foreman_messages` table); `ForemanMessage.buildSummary()` is the single source of truth for log entry summaries. `queryActivityLog()` (in `activity-log.ts`) merges both tables by timestamp. `EventQueue` (`event-queue.ts`) buffers GitHub webhook events per task for workers that aren't yet connected. `TaskManager` owns ephemeral in-memory state only (event queues, branch mappings, blocker state) and encapsulates all issue/PR event lifecycle logic — `handleIssueLabeledEvent()`, `handleIssueBodyEditedEvent()`, `handlePrOpenedEvent()`, `handlePrEditedEvent()`, `handlePrClosedEvent()`, `getTaskForCheckEvent()`. It also exposes `assignIdleWorkers()` (assigns all pending tasks to idle workers, returns `Promise<AssignOutcome[]>`) and `startDepsLoad()` (fire-and-forget dep fetch; emits `"deps_loaded"` on completion so the controller can subscribe once and call `assignWork()`). `Worker` is the in-memory model for connected workers (module-level registry, static finders, `Worker._reset()` for test isolation) — it does not extend `ActiveRecord` since workers are not DB-backed.
- **Controllers** (`controllers/`) — `http-server.ts` handles webhooks + REST + SPA. `wss.ts` is the protocol layer: handles both directions of the worker WebSocket channel and webhook routing. `ForemanWss` is a thin controller — it parses webhook payloads, calls one `TaskManager` method per event action, and sends wire messages. Instance methods: routing (`routePrEvent`, `routeCheckEvent`, `routeIssueEvent`, `forwardEvent`, `assignWork`), hello handling (`handleBusyHello`, `handleIdleHello`), and helpers (`sendMsg`, `workerLog`). No standalone functions or deps objects exist; everything is on the class.
- **Clients** (`clients/`) — `db-client.ts` wires the shared Supabase client and exports `DbRow<T>`, a helper type that makes `id` optional for in-memory (unsaved) model instances. `github.ts` wraps GitHub API calls (Supabase and GitHub API adapters live here).
- `admin-ws.ts` (in `controllers/`) broadcasts to the admin dashboard WebSocket — a WebSocket server that belongs alongside `wss.ts` in the controllers layer.

### Agent/Worker (`src/agent/`)

A unified REPL + worker loop. `AgentController` in `controllers/agent-controller.ts` handles the single action of running a query; `index.ts` owns setup, routing, and the prompt loop.

Follows MVC with three subdirectories:

- **Models** (`models/`) — `workspace.ts` (git/npm workspace management; extends `EventEmitter`, emits `"clone-start"`, `"reset-start"`, `"reset-retry"`, `"reset-reclone"`, `"npm-install"`, `"destroy"`, `"prune-start"`, `"prune-remove"`, `"prune-skip"` events instead of calling `print()` directly — callers subscribe in `startWorkerMode()`; `prune()` is an instance method, not static), `settings.ts` (pure model for runtime-settable preferences; `Settings` is the only value export — owns model and effort state, emits `"change"` on updates via `_setModel`/`_setEffort`; effort/model constants and cache helpers (`EFFORT_LEVELS`, `VALID_EFFORT_VALUES`, `getCachedModels`, `setCachedModels`, `_resetCachedModels`, `findModel`) are all static members of `Settings` — no interactive methods), `query-stats.ts` (tracks token usage and turn counts; exports `QueryStats` class only — `WORKING_VERBS` and `pickWorkingVerb` are private to the module; no view imports)
- **Views** (`views/`) — `display.ts` (TUI rendering; exports `Display` class with `BrunelConfig` and `StatusBar` injected in constructor — class methods use `this.config.verbose` and `this.statusBar`; `display.clearBreak()` and `display.fmtArgs(input)` delegate to module-level utilities; all pure utilities like `c`, `s`, `resolve`, `fmtEvent`, etc.; no singletons or standalone delegates), `status-bar.ts` (status bar state and rendering; exports `StatusBar` class only — holds all worker status state; constructed in `index.ts` startup and injected into `Display` and `startWorkerMode`; no singleton or `initStatusBar` export), `input.ts` (readline-based REPL input; exports `Input` class with `display: Display` injected in constructor — `input.ask(promptStr, getCommands?, abort?)` is the core readline method with bracketed paste, multiline, and status bar integration; also exports `_resetStash` for testing), `picker.ts` (arrow-key picker menus; exports `Picker` class with instance methods `pick(options, config?)`, `pickMultiple(options, promptStr?)`, `pickQuestion(options)`, `promptLine(prompt)`; stateless — instantiate once in `index.ts` startup and inject where needed; also exports types `PickConfig`, `PickResult`, `PickQuestionResult`)
- **Controllers** (`controllers/`) — `agent-controller.ts` (`AgentController` class — handles the "run a query" action; constructor takes `(display, picker, permConfig, settings)`; `runQuery(prompt, sessionId, ac?, model?, effort?)` runs a single turn via the SDK (handles `AskUserQuestion`/tool-permission callbacks, session ID capture, status bar lifecycle, ^C interrupt); also exports `logFull` (appends structured JSON to `repl.log`) and `createFetchModelsFn(permConfig)` (returns a function that fetches available models from the SDK)), `worker-controller.ts` (WS protocol + task lifecycle; defines `WorkerDisplay` interface `{ print, printForemanMessage }` — used by all controllers; owns `WorkerSession` with `session.confirmTaskQuit(info, pickFn?)` as a method and `WorkerSession.generateAgentId()` as a static method; exports `startWorkerMode(display, statusBar, picker)` and `registerWorkerCommands(session, registry, display)`), `workspace-controller.ts` (registers `/workspace:*` slash commands; `registerWorkspaceCommands(workspace, registry, display)` takes injected `display: WorkerDisplay`), `command-controller.ts` (`CommandRegistry` class — registration only (`register`, `scoped`, `lookup`, `listAll`, `execute`, `_reset`); `CommandController` class — has-a `CommandRegistry` (not extends), adds `dispatch`, `parseSlashCommand`, `listCommandNames`, `listCommands`, `suggest`; exposes `controller.registry` getter for registration in tests; `index.ts` creates `new CommandRegistry()` for registration and `new CommandController(registry)` for dispatch; pass `CommandRegistry` to functions that only register commands), `settings-controller.ts` (`SettingsController` class — wraps `Settings` model with `display: WorkerDisplay`; exposes `pickModel(args, pickFn, fetchModelsFn)` and `pickEffort(args, pickFn)`)

Other key files: `index.ts` (composition root + routing loop; exports `main(runQueryFn, permConfig, display, settings, input, picker, runWorkerMode?, workspaceCfg?)` which sets up worker mode/workspace, prints the startup banner, registers all commands, and runs the routing loop — dispatching commands to their handlers, user prompts to `runQueryFn` i.e. `AgentController.runQuery`, and foreman signals to `WorkerSession`; the startup block at the bottom constructs objects in order (`settings` → `statusBar` → `display` → `new Input(display)` → `new Picker()`) and calls `main()`), `worker-prompts.ts` (prompt templates).

### Shared

- `src/` root — `config.ts` (unified config loader; exports `loadConfig()` and `getConfig()` singleton — call `getConfig()` anywhere after startup to read config without passing it around), `wire.ts` (wire protocol types: `ForemanMessage` for foreman→worker messages, `WebhookEvent` for event payloads delivered to workers, `WorkerMessage` for worker→foreman messages, `TaskIssue` for issue data), `utils.ts`
- `shared/` — utilities needed by both the Node backend and the Vite frontend

## Task lifecycle

Status is **derived from timestamps**, not stored: `completedAt` → complete, `issueClosedAt` → closed, `prMergedAt` → merged, `workerId` → assigned, `prNumber` → pushed, open blockers → blocked, else → pending.

`Task.upsert()` intentionally does not overwrite status fields on conflict, so re-syncing at startup never clobbers existing assignments.

## Worker/Foreman handshake

Every `worker_hello` gets a `hello_ack` with one of three statuses before any task is sent:
- `idle` — worker is free, foreman may now assign
- `busy` — reconnection accepted, worker may resume
- `cancelled` — task was taken or completed; worker should reset and become idle

If a catastrophic error occurs during hello handling or message processing, the foreman sends `foreman_error` (`{ type, message, fatal }`) instead of silently dropping the connection. `fatal: true` causes the worker to stop reconnecting and return to interactive REPL mode; `fatal: false` is informational and the worker continues.

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

See **`docs/type-system.md`** for the full design. In brief: one server model class per concept, one `Wire.*` interface per concept in `shared/wire.ts` (imported as `import * as Wire from "../../shared/wire.js"`), shared domain types in `shared/wire.ts`. Prefer a single wire type with optional fields over multiple types for the same concept. Name things after the concept, not the form — `Wire.Task` not `Wire.TaskSnapshot`.

## Key conventions

- For output in agent/worker code, use `display.print(...)` on an injected `display: WorkerDisplay` instance — it routes through the status-bar-aware renderer so messages don't corrupt the TUI. Controllers receive `display` as a constructor parameter or function argument. `WorkerDisplay` interface (`{ print, printForemanMessage }`) is defined in and imported from `controllers/worker-controller.ts`. `Display` (the concrete class) is created once in `index.ts` startup and passed down.
- Prefer event-based designs for real-time UIs: a model holds state and emits on change; the UI subscribes once rather than scattering manual refresh calls.
- Pass model objects between internal methods, not raw ID strings. Controllers parse IDs from wire messages first, look up the model object (e.g. `Worker.get(workerId)`, `Task.get(taskId)`), then pass the object to helpers. `task.assign(worker: Worker)`, `sendMsg(worker: Worker, ...)`, `cancelWorker(worker, task)`, etc. all take objects. Use `import type` for circular type-only references (e.g. `task.ts` imports `Worker` type, `worker.ts` imports `Task` type).
- In unit tests, use `setupInMemoryTasks()` from `tests/helpers/task.ts` instead of `initDb()` — it mocks the `Task` layer with an in-memory map. `WebhookEvent.log()` and `ForemanMessage.log()` return `Promise<void>`; production callers use `void` to discard the promise; tests can `await` them for deterministic setup. `tests/setup.ts` (a vitest `setupFiles` entry) always initialises the DB with the in-memory shim from `tests/helpers/memory-db.ts`; DB tests override `initDb` with `initDb(createTestSupabase())` at module level. Tests that need a `Display` construct their own `new StatusBar({ agentId: "test-agent" })` and pass it to `new Display(getConfig(), statusBar)` — there is no global singleton.
- All wire types live in `shared/wire.ts` and are imported as `import * as Wire from "../../shared/wire.js"` (adjust relative path as needed). `src/wire.ts` re-exports from `shared/wire.ts` for backward compatibility. The DB model class for foreman messages is `ForemanMessage` (in `src/foreman/models/foreman-message.ts`), distinct from the wire type `Wire.ForemanMessage`.
- In agent tests that need slash commands, use `registerTestCommands()` from `tests/helpers.ts` (returns a `CommandController`). Use `controller.dispatch(input, readFile?)` for dispatch, `controller.parseSlashCommand(input)` for slash command parsing, `controller.suggest(query, listDir?, readFile?)` for autocomplete filtering; call `controller.listCommandNames()` and `controller.listCommands()` (with injectable `listDir`/`readFile` args for testing). To register additional commands in tests, access the underlying registry via `controller.registry.register(...)` or `controller.registry.scoped(...)`. When constructing a registry from scratch (e.g. in `worker.test.ts`), create `new CommandRegistry()` and pass it (or a scoped version) to `registerWorkspaceCommands`/`registerWorkerCommands`. `SlashCommandResult` and `DispatchResult` are exported from `controllers/command-controller.ts`. `registerWorkspaceCommands` (in `controllers/workspace-controller.ts`) takes `(workspace: Workspace | undefined, registry: CommandRegistry, display: WorkerDisplay)` — `undefined` workspace means no GitHub repo configured, commands degrade gracefully. `Workspace` is constructed with `(workspaceDir, sessionId, repoUrl, originalCwd, confirm)` at startup before any clone; `workspace.isCreated` tracks whether `create()` has been called; `WorkerSession.workspace` exposes the session's workspace for command registration.
- In foreman tests that use `new ForemanWss(...)`, call `Worker._reset()` in `beforeEach` to clear the module-level worker registry between tests. `ForemanWss` takes a single options object `{ config, taskManager, server, adminWss? }` — `Worker` is imported directly by `wss.ts` (no registry injection). To unit-test hello handlers or event routing, instantiate `ForemanWss` with `http.createServer()`, a mock config, and a mock `taskManager` (include `on: vi.fn()` in the mock); then spy with `vi.spyOn(wss, "sendMsg").mockImplementation(() => {})` and `vi.spyOn(utils, "log").mockImplementation(() => {})` (import `* as utils from "../src/utils.js"`) before calling methods like `wss.handleBusyHello(...)`, `wss.handleIdleHello(...)`, `wss.routePrEvent(...)`, or `wss.forwardEvent(...)`. Mock `taskManager.assignIdleWorkers()` to return `[]` and `taskManager.fetchAndLoadDeps()` to return `Promise.resolve()`.
- In browser tests, the server is shared across all tests — use unique issue numbers per test rather than resetting server state.
