# Reconnection Hardening: Findings and Plan

**Date:** 2026-03-27
**Status:** Investigation complete; staged implementation plan approved

---

## Problem

Workers connecting to the cloud foreman (hosted on Railway) disconnect frequently and reconnect constantly. Related symptoms:

- Workers miss GitHub events (CI results, code reviews, etc.)
- Tasks occasionally get assigned to multiple workers simultaneously
- Workers appear to restart their task context unexpectedly

---

## Relevant Architecture

- **Foreman** (`src/foreman.ts`) — HTTP + WebSocket server on Railway. All state (task queue, worker registry) is in-memory. Polls GitHub for `brunel:ready` issues at startup, then relies on webhooks.
- **Worker** (`src/worker.ts`) — Connects to foreman over WebSocket. On connection, sends `worker_hello`. Receives `task_assigned` and `event_notification` messages. On disconnect, waits 3 seconds and reconnects.
- **Railway** — Hosts the foreman. Railway routes all traffic through its own edge proxy (nginx-based) even without a custom load balancer or Cloudflare configured. This proxy has an idle connection timeout.

---

## Hypotheses

### H1 — Railway's proxy is dropping idle WebSocket connections [MOST LIKELY]

Railway's edge proxy will forcibly close TCP connections that carry no traffic after a timeout (commonly 30–60 seconds). When a worker is running a Claude task, the WebSocket between it and the foreman is completely silent — no messages flow in either direction. After the timeout elapses, the proxy drops the connection with no close frame, which appears as close code `1006` (abnormal closure).

This perfectly explains the "constant disconnection" symptom: connect → run task → idle for N seconds → proxy kills it → reconnect → repeat.

**Current code has no ping/pong or any keepalive mechanism.**

**Diagnosis signal:** Add close code logging. Code `1006` confirms proxy timeout; code `1000`/`1001` indicates a clean close from one side.

**Fix:** Foreman-side `WebSocketServer` ping on a short interval (e.g., every 25 seconds) to each connected worker. The `ws` library sends pings automatically and clients respond with pong — this is transparent to application code and keeps the proxy from seeing an idle connection.

---

### H2 — Events are silently dropped during the reconnect window [CONFIRMED BUG]

When a worker disconnects, `registry.remove(workerId)` removes it from the registry map. The task, however, stays in `"assigned"` status pointing to that workerId.

If a GitHub event arrives during the reconnect window (typically 3+ seconds):

```
forwardEvent() sees task.status === "assigned" → calls registry.send(disconnectedWorkerId, msg)
  → registry.workers.get(workerId) === undefined → message silently discarded
```

The event is not queued (that only happens when `status === "pending"`). On reconnect, `drainEvents()` returns nothing. **The event is permanently lost.**

This explains why workers miss CI results and code review notifications — they frequently arrive while a worker is mid-reconnect.

**Fix:** When a worker disconnects, revert the task back to `"pending"` status. Events will then queue normally. On reconnect, the task is reclaimed and queued events are forwarded.

---

### H3 — Task double-assignment after foreman restart [CONFIRMED RACE CONDITION]

Railway's restart policy is `ON_FAILURE`. When the foreman restarts, all in-memory state is gone. The startup sequence:

1. Polls GitHub for `brunel:ready` issues → adds them as **pending** tasks
2. Calls `reconcile()` → assigns pending tasks to any connected idle workers

If worker A was mid-task when the foreman restarted, and the issue still has `brunel:ready`:

1. A new worker B connects before A → gets assigned the task
2. Worker A reconnects, sends `worker_hello { status: busy, taskId: T }`
3. Foreman: `task.assignedWorkerId === B ≠ A` → sends **standby** to A
4. But A **ignores standby** (standby only affects idle waiting, not a running query loop) and keeps running

**Both A and B are now working on the same task simultaneously.**

**Fix options:**
- **Short-term (grace period):** Delay `reconcile()` by N seconds on startup to let reconnecting workers claim their tasks before new assignments are made. Simple but imprecise.
- **Medium-term (persisted state):** Log task assignments to Supabase. On restart, reload assigned tasks from DB and don't re-queue them. More reliable.

---

### H4 — No diagnostic information on close [OPERATIONAL ISSUE]

Current close handler:
```typescript
ws.on("close", () => {
  this.display.print(display.c.amber("Disconnected from foreman. Reconnecting..."));
  setTimeout(() => this.connect(), 3000);
});

ws.on("error", () => { /* close will fire */ });
```

Close code and reason are discarded. Error object is discarded. This makes it impossible to distinguish proxy timeouts, server-side closes, auth rejections, and network failures.

---

### H5 — Fixed reconnect delay, no jitter [MINOR]

All workers reconnect after exactly 3 seconds. If many workers disconnect simultaneously (e.g., foreman restart), they all hammer the foreman at the same moment 3 seconds later. Not a root cause, but can amplify other problems.

---

## Staged Implementation Plan

### Stage 1 — Diagnostics (implement first; learn before fixing)

Goal: Get enough signal to confirm hypotheses before investing in fixes.

1. **Log WebSocket close code and reason** on the worker side:
   ```typescript
   ws.on("close", (code, reason) => {
     this.display.print(display.c.amber(`Disconnected (code ${code}${reason ? `: ${reason}` : ""}). Reconnecting...`));
     setTimeout(() => this.connect(), 3000);
   });
   ```
   Code `1006` = proxy/network timeout (confirms H1). Code `1000` = clean close. Code `4001` = auth rejected by foreman.

2. **Log connection lifetime** — record a timestamp on `ws.on("open")` and log elapsed seconds on close. A pattern of disconnections after ~30–60 seconds confirms H1.

3. **Log close events on the foreman side** too — the foreman's `ws.on("close")` handler just logs "disconnected"; add the close code there as well.

4. **Log event-drop attempts** — in `forwardEvent()`, if `registry.send()` is called for a worker that isn't in the registry, log it explicitly rather than silently dropping.

---

### Stage 2 — Reduce connection drops

Goal: Stop the disconnections from happening in the first place.

1. **Add foreman-side WebSocket ping** — use `ws` library's built-in ping support on the `WebSocketServer`:
   ```typescript
   const wss = new WebSocketServer({ noServer: true });
   const PING_INTERVAL = 25_000; // 25s, safely under any 30s proxy timeout
   const pingInterval = setInterval(() => {
     for (const client of wss.clients) {
       if (client.readyState === WebSocket.OPEN) client.ping();
     }
   }, PING_INTERVAL);
   ```
   Workers respond with pong automatically (built into the `ws` library). This keeps connections alive through Railway's proxy.

2. **Add jitter to reconnect delay** — randomize the reconnect wait between 2–5 seconds to avoid thundering-herd on foreman restart.

---

### Stage 3 — Improve robustness when drops do occur

Goal: Reduce the impact of disconnections, foreman restarts, and worker interruptions.

1. **Fix the event-drop bug (H2)** — On worker disconnect in the foreman's `ws.on("close")` handler: if the worker had an assigned task, set the task status back to `"pending"`. Events arriving during reconnection will queue normally and be forwarded when the worker reclaims the task.

2. **Address double-assignment on foreman restart (H3)** — Two approaches (in order of complexity):
   - **Grace period:** Delay `reconcile()` on startup by a configurable number of seconds (e.g., 10s) to allow reconnecting workers to claim their tasks before new assignments are made.
   - **Persisted assignment state (stronger):** Record task assignments to the Supabase `foreman_messages` table (or a dedicated table). On startup, query for tasks that were `assigned` but not `complete` and skip re-queuing them (or mark them as pending-reclaim rather than pending).

3. **Worker-side standby handling** — Currently, `standby` is only meaningful to a worker waiting for a task (it just means "no work available"). A worker mid-task ignores it. Consider whether the foreman should send a stronger signal when it believes a task is already assigned to someone else (e.g., a `task_conflict` message), and whether the worker should handle that gracefully (pause, check in, etc.).

4. **Persist worker session state across reconnections** — When a worker reconnects while running a task, it continues using the same `currentSessionId`. This is already correct. But if the worker process itself dies and restarts (not just reconnects), it loses the session. No clean fix for this without persisting session IDs to disk, but worth being aware of.

---

## Open Questions

- What close codes are actually being seen? (Stage 1 will answer this)
- How long do connections stay up before dropping? (Stage 1 will answer this)
- Does the foreman itself restart frequently, or is it stable and only workers are disconnecting? (Check Railway deployment logs)
- Are there cases where the worker process itself is being killed (SIGTERM from Railway), or is it always a network-level drop?

---

## Files to Modify

| File | Relevant to |
|------|-------------|
| `src/worker.ts` | H1 diagnosis, H2 reconnect logging, reconnect jitter |
| `src/foreman.ts` | H1 ping/keepalive, H2 event-drop fix, H3 grace period, H3 close code logging |
