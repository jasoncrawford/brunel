# Interrupt Feature Design

**Issue:** #13
**Date:** 2026-03-20

## Overview

Allow the user to press `^C` to interrupt a running Claude Agent SDK query and return to the prompt, similar to Claude Code. The session is preserved so the user can continue from where they left off.

## ^C Behavior

| State | ^C action |
|---|---|
| Query running | Abort the query, print "Interrupted.", return to prompt |
| Idle prompt, buffer non-empty | Clear the buffer |
| Idle prompt, buffer empty | Exit |

This behavior applies in both REPL mode and worker mode, since both call `runQuery`. In worker mode, interrupt is a TTY-only feature: if `process.stdin` is not a TTY (e.g. piped input in tests), raw `\x03` bytes will not arrive and the listener is a no-op.

## Architecture

Two components change:

### 1. `runQuery` (src/repl.ts) — interrupt support

`runQuery` creates an `AbortController` and registers a temporary raw-stdin `data` listener **before** the `for await` loop:

- The listener catches `\x03` (^C), echoes `^C\n` to stdout, and calls `controller.abort()`
- `abortController` is passed to the SDK's `query()` via `options.abortController`
- A `try/finally` wraps **only the stdin listener** — the listener is removed unconditionally in `finally` when the query ends for any reason

**What the SDK does on abort:** When `controller.abort()` is called the async generator ends immediately — **no `result` message is emitted** and no error is thrown. The `for await` loop simply exits. This means `display.printMessage` is never called for the cancellation, and the `try/catch` in `main()` that wraps `runQuery` is not triggered.

**Detecting abort vs. normal completion:** Track a boolean `resultReceived` flag, set to `true` when a `result` message arrives. After the loop:
- If `!resultReceived`: the query was aborted — print "Interrupted."
- If `resultReceived`: normal completion — no extra output

The existing `display.stopStatus()` call after the loop (already present, no-op if result already stopped it) handles spinner cleanup in both cases.

The `savedInputCallback` restore (lines 99-100 in the current code) remains unconditional and **outside** the `try/finally` — it runs on both abort and normal completion, ensuring the worker prompt redraws correctly in all cases.

### 2. `ask()` (src/input.ts) — smarter ^C at idle prompt

Replace the current `^C → exit()` handler in `processTyped` (inside `ask()`) with:

```
if buffer non-empty → replaceBuffer("")   // clear (no ^C echo)
if buffer empty     → process.stdout.write("^C"); exit()   // echo then exit
```

The `process.stdout.write("^C")` that currently precedes `exit()` is retained only for the empty-buffer (exit) path, matching the current behavior. It is not emitted on the clear-buffer path (clearing is silent). `replaceBuffer` is defined inside `ask()` and is already in scope within `processTyped` — no extra wiring needed.

This only fires when `ask()` is active (no query is running), so it is never active at the same time as `runQuery`'s listener.

### Worker mode

In worker mode `runQuery` is called from `WorkerSession.runQueryLoop()`. The interrupt mechanism is identical — `runQuery`'s temporary listener catches `^C` and aborts the query.

`runQueryLoop` has a post-query event drain loop (`while (this.pendingEvents.length > 0) ...`) that feeds any queued events into further `runQuery` calls. **When the query is aborted, `runQueryLoop` must skip the drain and return immediately** — if the user hit ^C they want to stop, not continue processing queued events.

To communicate abort state to `runQueryLoop`, `runQuery` optionally accepts a caller-provided `AbortController`. When provided, `runQuery` uses that controller (registers the `^C` listener on it) instead of creating its own. `runQueryLoop` creates an `AbortController`, passes it to each `runQuery` call, and after the call checks `controller.signal.aborted` to decide whether to skip the drain.

REPL mode (`main()`) does not pass an `AbortController` — `runQuery` creates one internally as before.

After checking `signal.aborted`, `runQueryLoop` must return before reaching `notifyQueryDone()` so the foreman is not notified of completion on an interrupted query. `isRunningQuery` is set to false in `runQueryLoop`'s `finally` block, and the worker returns to its idle prompt as normal. The task remains in the assigned state, which is acceptable since the user manually interrupted.

## Data Flow

**Interrupt during query:**
```
user presses ^C
  → runQuery's temporary stdin listener fires
  → echoes "^C\n" to stdout
  → controller.abort()
  → SDK generator ends (no result message emitted; resultReceived = false)
  → for await loop exits
  → finally: stdin listener removed
  → display.stopStatus() called (clears spinner)
  → savedInputCallback restored (prompt redraws in worker mode)
  → resultReceived is false → print "Interrupted."
  → runQuery returns capturedSessionId (session preserved)
  → REPL/worker returns to prompt
```

**Normal query completion:**
```
  → result message received → resultReceived = true; display.stopStatus()
  → for await loop exits
  → finally: stdin listener removed
  → display.stopStatus() (no-op)
  → savedInputCallback restored
  → resultReceived is true → no extra output
  → runQuery returns capturedSessionId
```

**^C at idle prompt with text:**
```
user presses ^C
  → ask()'s processTyped fires
  → buffer non-empty → replaceBuffer("")
  → prompt redraws empty
```

**^C at idle prompt, empty buffer:**
```
user presses ^C
  → ask()'s processTyped fires
  → buffer empty → exit()
```

## Files Changed

- `src/repl.ts` — `runQuery`: add `AbortController`, `resultReceived` flag, temporary stdin listener in `try/finally`, pass to SDK, print "Interrupted." conditionally after loop
- `src/input.ts` — `processTyped`: change `^C` from always-exit to clear-or-exit

## Testing

- `runQuery` passes `abortController` in the SDK `query()` call options
- Aborting mid-query causes `runQuery` to return without throwing, and "Interrupted." appears in output
- Normal query completion does NOT print "Interrupted."
- Session ID is returned correctly after a cancelled query (session preserved)
- `process.stdin` listener count is the same before and after a normal `runQuery` call (no listener leak)
- `ask()` `^C` with non-empty buffer clears the buffer, does not exit
- `ask()` `^C` with empty buffer calls `exit()`
