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

## Architecture

Two components change:

### 1. `runQuery` (src/repl.ts) — interrupt support

`runQuery` creates an `AbortController` internally and:

- Passes it to the SDK `query()` via `options.abortController`
- Registers a temporary raw-stdin `data` listener before the query loop starts
- The listener catches `\x03` (^C), prints `^C\n`, and calls `controller.abort()`
- The listener is removed in a `finally` block when the query ends (success, error, or cancellation)

When the SDK is aborted it emits a `result` message with `outcome: 'cancelled'` and the async generator ends cleanly. The existing `display.printMessage` call handles rendering it. `runQuery` returns `capturedSessionId` as normal so the session is preserved.

### 2. `ask()` (src/input.ts) — smarter ^C at idle prompt

Replace the current `^C → exit()` handler in `processTyped` with:

```
if buffer non-empty → replaceBuffer("")   // clear
if buffer empty     → exit()              // exit
```

This only fires when `ask()` is active (i.e., no query is running), so there is no overlap with `runQuery`'s listener.

## Data Flow

**Interrupt during query:**
```
user presses ^C
  → runQuery's stdin listener fires
  → prints "^C\n"
  → controller.abort()
  → SDK generator emits result{outcome:'cancelled'}, ends
  → runQuery returns sessionId
  → REPL/worker returns to prompt
```

**^C at idle prompt with text:**
```
user presses ^C
  → ask()'s onData / processTyped fires
  → buffer non-empty → replaceBuffer("")
  → prompt redraws empty
```

**^C at idle prompt, empty buffer:**
```
user presses ^C
  → ask()'s onData / processTyped fires
  → buffer empty → exit()
```

## Files Changed

- `src/repl.ts` — `runQuery`: add `AbortController`, stdin listener, pass to SDK
- `src/input.ts` — `processTyped`: change `^C` from always-exit to clear-or-exit

## Testing

- `runQuery` passes `abortController` in the SDK `query()` call options
- Aborting mid-query causes `runQuery` to return without throwing
- `ask()` `^C` with non-empty buffer clears the buffer, does not exit
- `ask()` `^C` with empty buffer calls `exit()`
