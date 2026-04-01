# Worker Status Bar Design
Date: 2026-03-30

## Goal

Add a persistent bottom status bar to the worker terminal that shows worker identity, busy/idle state, current task/PR/branch, and connection status. Remove the "Connected to foreman" / "Disconnected from foreman" text messages.

## Status Bar Format

```
worker 7c254628 • busy • task #374 • PR #406 • db-some-branch      Connected
```

```
worker 7c254628 • idle                                           Disconnected
```

- **Left side** (left-justified, `•`-separated): worker ID (first 8 chars), status (busy/idle), task # (if any), PR # (if any), current git branch (if any)
- **Right side** (right-justified): connection status: `Connected`, `Disconnected`, or `Reconnecting...`
- The two sides are padded/joined to fill terminal width

## Architecture

### `src/display.ts` changes

1. **Two-layer status bar**: The existing single-line status system is extended to support two simultaneous lines — the existing primary (query) status line and a new persistent (worker) status line. When a query runs, both lines show:
   ```
   Working… 5s, 2 turns, 500 in / 200 out
   worker 7c254628 • busy • task #374           Connected
   ```
   When idle, only the worker line shows.

2. **New internal state**: `_persistentStatusText`, `_persistentStatusActive`, `_persistentGetText`.

3. **Updated `_clearStatus`/`_drawStatus`**: Use a `_lineCount()` helper to handle N active lines. Clear erases all N status lines plus the blank line from `console.log`. Draw writes each active line on a new line.

4. **New exports**: `startPersistentStatus(getText: () => string)`, `stopPersistentStatus()`, `fmtWorkerStatus(opts)`.

5. **`fmtWorkerStatus(opts)`**: Formats the two-sided worker status line, left-justified left content and right-justified right content, padded to terminal width. Input: `{ workerId, status, taskNumber?, prNumber?, branch?, connectionStatus, width? }`.

### `src/worker.ts` changes

1. **`WorkerDisplay` type**: Add optional `startPersistentStatus?: (getText: () => string) => void` and `stopPersistentStatus?: () => void`.

2. **`WorkerSession` new state**:
   - `connectionStatus: "connecting" | "connected" | "reconnecting"` (initialized to "connecting")
   - `currentPrNumber: number | undefined`
   - `currentBranch: string` (cached branch name)

3. **`getStatusText(): string`**: Public method returning the formatted worker status bar text. Used by the `startPersistentStatus` callback and exposed for unit tests.

4. **Branch refresh**: `refreshBranch()` async method runs `git rev-parse --abbrev-ref HEAD`. Called at: `start()`, task assignment, and after each query loop completes.

5. **PR number tracking**: In `handleMessage`, when we receive an `event_notification` with a `pull_request` event, extract `event.payload.pull_request.number` and store as `currentPrNumber`. Reset on task assignment.

6. **Status updates**: After any state change (connection open/close, task assigned/complete, query start/stop), the status text updates automatically because `startPersistentStatus` uses a `getText` callback. But we also trigger explicit redraws where needed.

7. **Remove old print messages**: Remove `display.print("Connected to foreman")` and `display.print("Disconnected from foreman ...")` calls.

8. **`workerMain`**: Pass `display.startPersistentStatus` and `display.stopPersistentStatus` in the `workerDisplay` object.

## Test Changes

### `tests/worker.test.ts`

- Update display mock to include optional `startPersistentStatus` / `stopPersistentStatus` vi.fn() stubs.
- **"close diagnostics" tests**: Change from checking `display.print` for "Disconnected" / "code 1006" / "47s" to checking `session.getStatusText()` for connection status strings. Since the print messages are removed, there is nothing to check in print calls.
- Add tests verifying `getStatusText()` reflects state changes.

### New `tests/display.worker-status.test.ts`

- Tests for `fmtWorkerStatus()` formatting in various states (idle, busy, with/without PR/branch, connected/disconnected/reconnecting, various terminal widths).
- Tests for the two-layer status bar: `startPersistentStatus` + `startStatus` coexisting, `_lineCount()`, draw/clear sequences.

## Out of scope

- No changes to foreman, database, or admin dashboard.
- Git branch for the REPL (non-worker mode) — status bar is worker-only.
