# Code Reorganization & Test Coverage Design

**Date:** 2026-03-15
**Status:** Approved for implementation
**Context:** Motivated by a pattern of basic bugs shipping to production — wrong WebSocket URL, missing webhook handler logic, ReferenceError after a refactor — traced to poor testability and a large, tangled `repl.ts`.

---

## Part 1: Code Reorganization

### Goals

- Increase cohesion: each module owns one clear concern
- Reduce coupling: no re-exports across module boundaries, no module-level singletons
- Improve testability: pure logic and state machines have injectable dependencies; I/O is isolated at the edges

### Current problems

1. **`repl.ts` is doing too much.** It contains the REPL entry point, the worker entry point, the worker state machine (in `workerMain()`), raw stdin/terminal handling (`ask()`), slash command dispatch, autocomplete, and query execution. At 752 lines it's the single biggest source of bugs.

2. **`workerMain()` is untestable.** All worker state (`currentTaskId`, `currentIssue`, `currentSessionId`, `pendingEvents`, `resolveWsInput`, `ws`) lives in closures inside one 140-line function. There is no seam to inject a fake WebSocket, a fake query runner, or fake messages. There are currently **zero tests** for the worker state machine.

3. **`handleForemanMessage` and `connectToForeman` are hacky extractions.** Both were pulled out of `workerMain()` after bugs to create minimal test seams, not because they represent cohesive units. `handleForemanMessage` is a 3-line function whose test only verifies it calls its dependency — the real guard (wrong identifier after refactor) is better served by `tsc --noEmit`. These should be deleted and absorbed into `WorkerSession`.

4. **`repl.ts` re-exports all of `display.ts`** (`export * from "./display.js"`). This creates an accidental façade coupling two unrelated modules.

5. **`foreman.ts` has module-level singletons.** `registry`, `taskQueue`, and `routeEventToWorker` are instantiated at module load time, and `WEBHOOK_SECRET` / the `webhooks` object are constructed unconditionally on import. This means a test cannot configure `WEBHOOK_SECRET`, and the singletons exist even in test imports.

6. **GitHub API calls are in `foreman.ts`.** `loadIssuesToQueue` and `labelIssueDone` are mixed into the WebSocket/orchestration module, requiring tests to mock `fetch` globally.

### Proposed module structure

```
src/
  types.ts       — unchanged: shared protocol types
  display.ts     — unchanged: rendering, formatting, status line
  templates.ts   — unchanged: Claude prompt builders
  worker-id.ts   — unchanged: persistent worker UUID

  github.ts      — NEW: GitHub API calls extracted from foreman.ts
                   Exports: loadIssuesToQueue, labelIssueDone
                   (ghEnv and ghHeaders become private helpers here)

  foreman.ts     — TRIMMED: TaskQueue, WorkerRegistry, createForemanWss,
                   webhook routing. Module-level singletons removed.
                   webhooks setup moved inside isMain block.
                   labelIssueDone injected as a callback parameter to
                   createForemanWss. taskLabel passed as a parameter to
                   createForemanWss (see note on ghEnv below).

  worker.ts      — NEW: WorkerSession class, extracted from workerMain().
                   Owns all worker state and the state machine.
                   Dependencies are injected: wsFactory, runQuery function,
                   print/printForemanMessage display functions.
                   workerMain() entry point lives here and wires everything.

  input.ts       — NEW: ask(), matchCommands(), listCommandNames(), ListDir
                   type, and the raw stdin/terminal handling machinery,
                   extracted from repl.ts. Also: parseSlashCommand(),
                   resolveCommandFilePath(), loadCommandFile(), dispatchInput()
                   (all slash command dispatch logic).

  repl.ts        — TRIMMED: main() entry point and runQuery() only.
                   Wires input.ts + display.ts + worker.ts.
                   No worker state. No `export * from display.js`.
                   Target: under 200 lines.
```

### What moves where

| Current location | New location | Action |
|---|---|---|
| `workerMain()` state machine | `worker.ts` — `WorkerSession` | Extract into class |
| `handleForemanMessage()` | — | **Delete**; absorbed into `WorkerSession.handleMessage()` |
| `connectToForeman()` | `worker.ts` | Inline into `WorkerSession` (private) |
| `export * from "./display.js"` | — | **Delete** |
| `loadIssuesToQueue`, `labelIssueDone` | `github.ts` | Move |
| `ghEnv()`, `ghHeaders()` | `github.ts` (private) | Move |
| `registry`, `taskQueue` module singletons | `foreman.ts` `isMain` block only | Delete from module scope |
| `webhooks` construction at module load | `foreman.ts` `isMain` block only | Move |
| `ask()` + raw stdin machinery | `input.ts` | Move |
| `matchCommands()`, `listCommandNames()`, `ListDir` | `input.ts` | Move |
| `parseSlashCommand()`, `resolveCommandFilePath()`, `loadCommandFile()`, `dispatchInput()` | `input.ts` | Move |
| `main()`, `runQuery()` | `repl.ts` | Keep |
| `workerMain()` entry point | `worker.ts` | Move |

### Note on `ghEnv()` and `taskLabel` in `foreman.ts`

`routeEvent` inside `createForemanWss` currently calls `ghEnv()` to read `TASK_LABEL`. After `ghEnv` moves to `github.ts` as a private helper, `foreman.ts` must not import it. Instead, accept `taskLabel` as a parameter to `createForemanWss` alongside the other injected values:

```typescript
export function createForemanWss(
  taskQueue: TaskQueue,
  registry: WorkerRegistry,
  server: http.Server,
  options?: {
    taskLabel?: string;                              // default: process.env.TASK_LABEL ?? "brunel:ready"
    labelDone?: (issueNumber: number) => Promise<void>; // default: no-op
  }
): { wss: WebSocketServer; routeEventToWorker: (id: string, name: string, payload: unknown) => void }
```

The `isMain` block reads `process.env.TASK_LABEL` and passes it in. Tests that need to control the label pass it directly.

### `WorkerSession` design

**Constructor dependencies (all injectable):**

```typescript
type WsFactory = (workerId: string, taskId?: string) => WebSocket;
type RunQuery = (prompt: string, sessionId: string | undefined) => Promise<string | undefined>;
type WorkerDisplay = {
  print: (line: string | null) => void;
  printForemanMessage: (msg: unknown) => void;
};

class WorkerSession {
  constructor(
    private workerId: string,
    private wsFactory: WsFactory,
    private runQuery: RunQuery,
    private display: WorkerDisplay,
  )
}
```

Color/style helpers (`display.c.*`, `display.s.*`, `display.hr()`) are pure functions with no side effects; `WorkerSession` imports and calls them directly from `display.ts` without injection.

**State:**

```typescript
private currentTaskId: string | undefined;
private currentIssue: TaskIssue | undefined;
private currentSessionId: string | undefined;
private pendingEvents: GitHubEvent[] = [];
private ws: WebSocket | undefined;
private resolveWsInput: ((v: string) => void) | null = null;
```

**State machine transitions:**

```
idle
  → (task_assigned received)         → start runQuery with initial prompt → running_query
  → (event_notification received)    → push to pendingEvents (no-op if idle)

running_query
  → (query returns, no pending events) → idle
  → (query returns, pending events)    → start runQuery with event prompt → running_query
  → (event_notification received)      → push to pendingEvents

any state
  → (user /task-complete)             → send task_complete to foreman, clear state → idle
  → (WebSocket close)                 → schedule wsFactory reconnect → connecting
```

**Reconnect ownership:** `WorkerSession` owns the reconnect loop. When the WebSocket `close` event fires, `WorkerSession` calls `setTimeout(() => this.connect(), 3000)`. The `connect()` method calls `wsFactory(this.workerId, this.currentTaskId)` and attaches message/close/error handlers. Tests provide a `wsFactory` that returns a fake `WebSocket` (e.g., a Node.js `EventEmitter` with a `send()` spy) so reconnect behavior can be driven by calling `fakeWs.emit("close")`.

**Public interface (for testing and wiring):**

```typescript
start(): void                              // calls connect(), begins the worker loop
handleUserInput(input: string): Promise<void>  // process a line from stdin (slash commands, queries)
createWsInputPromise(): Promise<string>    // creates a new one-shot promise that resolves when the WS
                                           // delivers a task/event; each call abandons the previous one,
                                           // matching the per-iteration pattern in the original ask() loop
```

The `workerMain()` function in `worker.ts` is the wiring layer: reads env vars, creates real WebSocket factory, binds real `runQuery`, instantiates `WorkerSession`, then runs an `ask()` loop that feeds input to `handleUserInput` and uses `createWsInputPromise()` as the abort parameter.

---

## Part 2: New Tests Unlocked

### Worker state machine unit tests (`tests/worker.test.ts`)

These become possible once `WorkerSession` has injectable dependencies. No network, no stdin, no real query runner needed.

**Idle → task assignment:**
- Receive `task_assigned` → calls `runQuery` with the correct initial prompt
- Receive `task_assigned` → updates `currentTaskId` and `currentIssue`

**Event handling during query:**
- Receive `event_notification` while `runQuery` is running → event is pushed to `pendingEvents`
- After `runQuery` returns, pending events are drained and `runQuery` is called again with event prompt
- Multiple events queued → `runQuery` is called once with the multi-event prompt

**User commands:**
- User `/task-complete` → sends `task_complete` message to WebSocket, clears task state
- User `/task-complete` with no active task → no WebSocket send
- User `/clear` → clears session ID, does not clear task state

**Reconnect:**
- `ws.emit("close")` → `wsFactory` is called again (with `workerId` and `currentTaskId`)

**State isolation:**
- After task complete, `currentTaskId` / `currentIssue` / `currentSessionId` are cleared

### Foreman protocol tests without global `fetch` mocking (`tests/foreman.websocket.test.ts`)

Once `labelDone` is injected, the protocol tests no longer need `vi.stubGlobal("fetch", ...)`. Replace with a `vi.fn()` passed as the `labelDone` option:

```typescript
const labelDone = vi.fn().mockResolvedValue(undefined);
({ wss, routeEventToWorker: routeEvent } = createForemanWss(queue, registry, httpServer, { labelDone }));
```

Tests become simpler and do not pollute the global `fetch`.

### GitHub API unit tests (`tests/github.test.ts`)

With `github.ts` extracted, these can be tight unit tests:
- `loadIssuesToQueue` — constructs the correct GitHub API URL, maps issue fields correctly, handles API error responses
- `labelIssueDone` — POSTs to the correct endpoint with the correct body, handles API errors

Currently untested except indirectly through the WebSocket protocol tests.

### Input/dispatch unit tests (renamed, not new)

The existing test files will be updated to import from `input.ts` instead of `repl.ts`:

| Old test file | Import change |
|---|---|
| `repl.autocomplete.test.ts` | `from "../src/repl.js"` → `from "../src/input.js"` |
| `repl.input.test.ts` | `from "../src/repl.js"` → `from "../src/input.js"` |
| `repl.dispatch.test.ts` | `from "../src/repl.js"` → `from "../src/input.js"` |
| `repl.slash.test.ts` | `from "../src/repl.js"` → `from "../src/input.js"` |

No new tests needed here — just updated import paths.

### `tsc --noEmit` in CI (Issue #66)

Not a code reorganization item, but should be done in the same pass. Catches the class of bug (wrong identifier after refactor) that `handleForemanMessage`'s regression test was guarding against. Add to `.github/workflows/tests.yml`:

```yaml
- run: npx tsc --noEmit
```

---

## Implementation order and test-green guarantee

Each step must keep all tests passing. Steps that delete exports must update all test imports in the **same commit** (not a separate follow-up), or CI will go red.

1. **Add `tsc --noEmit` to CI** (`tests.yml` only — no source changes, guaranteed green)

2. **Extract `github.ts`** — move `loadIssuesToQueue`, `labelIssueDone`, `ghEnv`, `ghHeaders` from `foreman.ts` to `github.ts`. Update `tests/foreman.github.test.ts` to import from `../src/github.js`. `foreman.ts` imports `labelIssueDone` from `./github.js` (same behavior, just re-imported).

3. **Move `ask()` and dispatch logic to `input.ts`** — move `ask()`, `matchCommands()`, `listCommandNames()`, `ListDir`, `parseSlashCommand()`, `resolveCommandFilePath()`, `loadCommandFile()`, `dispatchInput()` from `repl.ts` to `input.ts`. Update test imports in `repl.autocomplete.test.ts`, `repl.input.test.ts`, `repl.dispatch.test.ts`, `repl.slash.test.ts` in the **same commit**.

4. **Delete `export * from "./display.js"` from `repl.ts`** — several test files currently import `display.ts` symbols through this barrel export. In the **same commit**, update these imports to come from `../src/display.js` directly:

   | Test file | Symbols to move to `../src/display.js` import |
   |---|---|
   | `repl.query.test.ts` | `toolUseNames`, `stopStatus`, `setVerbose` (keep `runQuery` from `repl.js`) |
   | `repl.helpers.test.ts` | `toolResultText`, `fmtEditResult`, `fmtHunk`, `c`, `trunc`, `fmtCount`, `fmtDuration`, `fmtNum`, `fmtStats`, `fmtArgs` |
   | `repl.printing.test.ts` | `printBlock`, `printMessage`, `printHook`, `startStatus`, `stopStatus`, `print`, `toolUseNames`, `setVerbose`, `_statusActive` |
   | `repl.markdown.test.ts` | `mdInline`, `renderMarkdown`, `s` |
   | `repl.formats.test.ts` | `resolve`, `setVerbose`, `ASSISTANT_BLOCK_FMT`, `USER_BLOCK_FMT`, `TOOL_CALL_FMT`, `TOOL_RESULT_FMT`, `TOOL_ERROR_FMT`, `SYSTEM_FMT`, `MESSAGE_FMT`, `HOOK_FMT`, `FmtTable` |

5. **Introduce `WorkerSession` in `worker.ts`** (biggest step — write tests first per TDD practice). Extract the state machine from `workerMain()` into `WorkerSession` with injected `wsFactory`, `runQuery`, and `WorkerDisplay`. Move `workerMain()` to `worker.ts`. **In the same commit**: delete `handleForemanMessage` and `connectToForeman` from `repl.ts`, and update `tests/repl.worker.test.ts`:
   - The three `handleForemanMessage` unit tests (lines 19–55) are superseded by `worker.test.ts` and should be deleted.
   - The two integration tests in the "worker WebSocket connection" describe block (lines 57–90) guard real network behavior — "worker client connects and completes handshake" and "foreman rejects connections not at /worker path" — and should be **moved to `tests/foreman.websocket.test.ts`** rather than deleted.

6. **Clean up `foreman.ts` singletons and inject `labelDone`/`taskLabel`** — remove `registry`, `taskQueue` from module scope (keep only in `isMain` block), move `webhooks` construction into `isMain` block, update `createForemanWss` signature to accept `options?: { taskLabel?, labelDone? }`. Update `tests/foreman.websocket.test.ts` to pass `labelDone` as a `vi.fn()` instead of using `vi.stubGlobal("fetch", ...)`. `tests/foreman.webhook-routing.test.ts` does **not** need changes — it sets `process.env.TASK_LABEL` in `beforeEach`, and the `options?.taskLabel ?? process.env.TASK_LABEL ?? "brunel:ready"` default path in `createForemanWss` preserves existing behavior.
