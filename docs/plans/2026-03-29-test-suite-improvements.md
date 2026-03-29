# Test Suite Improvement Plan

## The Core Problem

The test suite has strong coverage at the unit level but a structural gap: most tests verify that **method X was called with arguments Y**, not that **the system behaves correctly when Z happens**. These are different things. The first tests internals; the second tests behavior. Internals can be refactored freely. Behavior is what users and operators depend on.

The symptom is a high mock:test ratio in specific areas — particularly the logging and broadcast tests — where each layer mocks the layer below it, so bugs that live in the seams between layers are invisible to every individual test that covers either side of the seam.

The goal is not to rewrite everything. The unit tests for `TaskQueue`, `WorkerRegistry`, `dependencies.ts`, `config.ts`, `workspace.ts`, and `templates.ts` are good and should stay. The problem is confined to the parts of the system that communicate with each other: foreman ↔ worker, foreman ↔ database, foreman ↔ admin dashboard, admin dashboard ↔ browser.

---

## Principles

**Test behavior, not implementation.** A test should describe what the system does, not how it does it. "When a webhook fires, the task appears in the database" is behavior. "When a webhook fires, `dbLogger.logWebhookEvent()` is called" is an implementation detail.

**Mock at system boundaries, not internal interfaces.** It's appropriate to mock the GitHub API (external HTTP), the Claude SDK (external service), and optionally the foreman when testing just the worker or vice versa. It is not appropriate to mock `DbLogger`, `AdminWss`, or `createAdminWss` — these are internal implementations of the same system.

**Tests should break when behavior breaks.** The current logging tests would pass even if the database never received anything, because they mock the database logger. This is the definition of a test that provides false confidence.

---

## Phase 1: Replace Fake Supabase with a Real Local Instance

**What to do.** Use `supabase start` to provide a local Postgres instance in CI and local dev. Wire a real `createDbLogger(supabase)` into tests that currently use `makeMockDbLogger()`.

**Infrastructure.** Vitest's `globalSetup` runs the migration (`supabase db push`) once before the suite starts. Each test file gets fresh state via `beforeEach` truncation of the relevant tables — `webhook_events`, `foreman_messages`, `tasks`, `task_assignments`.

**What improves.** The `db.test.ts`, `db.tasks.test.ts`, and `db.assignments.test.ts` files currently verify that the fake Supabase builder was called with the right chain of methods. With a real DB, they verify that data is actually stored correctly and retrieved correctly — including real ordering, real conflict resolution on upsert, and real column constraints. Schema migrations become tested as a side effect.

**What to delete.** The fake-builder pattern files can be simplified or deleted once real-DB equivalents exist. The boilerplate (`makeSupabase()`, the five repeated builder factories) disappears.

---

## Phase 2: Full Pipeline Integration Tests

This is the most important phase.

**What to add.** A new test file — `tests/pipeline.test.ts` — that spins up a real foreman (using `createForemanWss` and `createHttpServer`) wired to a real local database, then exercises the end-to-end sequence of events. Workers are real WebSocket clients.

The key scenarios this should cover:

- **Happy path**: POST a webhook payload → task appears in DB with `status='pending'` → worker connects → receives `task_assigned` → sends `task_complete` → task record in DB shows `status='complete'`
- **Queued then assigned**: webhook fires with no worker → task stays pending in DB → worker connects → gets the task
- **Worker disconnect/reclaim**: worker gets task → disconnects → reconnects as busy within reclaim window → no re-assignment
- **Worker disconnect/expire**: worker gets task → disconnects → reclaim timer fires → task reverts to pending in DB → new worker gets it
- **Dependency blocking**: task with blocker issue → worker doesn't receive it → `issues/closed` webhook for the blocker → worker receives it
- **PR events forwarded**: worker gets task → opens PR → check run fires → worker receives `event_notification`

**What this replaces.** The five logging test files (`foreman.webhook-logging`, `foreman.worker-logging`, `foreman.event-forwarding-logging`, and parts of `foreman.admin-broadcast`) can be deleted or dramatically reduced. Their behaviors are all implied by the pipeline tests: if an event appears in the DB and the admin client received the right broadcast, then the logging call clearly happened. Testing that `dbLogger.logWebhookEvent()` was called is no longer meaningful when you can just check the DB directly.

**The pattern to follow.** `foreman.websocket.test.ts` and `foreman.webhook-routing.test.ts` already demonstrate the right approach — real servers, real clients, real observable outcomes. The pipeline tests extend this pattern with a real database added.

---

## Phase 3: Admin Dashboard Browser Tests with Playwright

**What to add.** A new `tests/browser/` directory with Playwright tests that start a real foreman server, connect a real admin WebSocket client (the browser), and verify the dashboard renders correctly in response to real system events.

The key scenarios:

- **Initial load**: foreman has tasks and workers → browser opens `/` → dashboard shows correct task list and worker list
- **Live task assignment**: browser is open → webhook fires → worker connects → dashboard updates in real time without page reload, showing the task as assigned and the worker as busy
- **Log stream**: webhook events arrive → event log in dashboard shows them in order with correct summaries
- **Worker detail page**: navigate to `/workers/:id` → page shows correct history of messages and events for that worker
- **Task detail page**: navigate to `/tasks/:id` → page shows the events associated with that task

**Why Playwright rather than React Testing Library.** The current `Dashboard.test.tsx` uses hardcoded `LogEntry` objects that have no relationship to what the server actually produces. Playwright tests the real path: server produces a real snapshot → browser WebSocket receives it → React renders it. This catches format mismatches, schema drift between server and frontend types, and rendering bugs that only appear with real data shapes.

**Test data strategy.** Playwright tests should seed state by posting real webhook payloads to the foreman's `/webhook` endpoint — the same path that GitHub uses in production. This exercises the full ingestion pipeline, not just the rendering logic.

---

## Phase 4: Rationalize Existing Tests

With the above in place, several categories of tests become redundant or should be reconsidered.

**Delete or consolidate:**
- `foreman.webhook-logging.test.ts` — replaced by pipeline tests that verify DB state directly
- `foreman.worker-logging.test.ts` — same
- `foreman.event-forwarding-logging.test.ts` — same
- `foreman.admin-broadcast.test.ts` — replaced by pipeline tests that include a real admin WS client
- The five near-identical `makeSupabase()` / `makeFakeSupabase()` factory functions across DB test files

**Keep but simplify:**
- `foreman.websocket.test.ts` and `foreman.webhook-routing.test.ts` — already good; remove tests that overlap with pipeline tests, keep the edge cases
- `admin-ws.test.ts` — keep as-is; tests a standalone module in appropriate isolation

**Keep unchanged:**
- All unit tests for `TaskQueue`, `WorkerRegistry`, `dependencies.ts`, `config.ts`, `workspace.ts`, `templates.ts` — correct and valuable

**Reconsider:**
- The `frontend/tests/` component tests that mock `useAdminWs` — once Playwright covers the real data flow, these can be deleted or kept only for purely presentational edge cases (empty states, error states) with synthetic data that matches what the server actually produces

---

## Smoke Test Extension

The existing smoke test (`tests/smoke.ts`) stops at "worker connected." Extend it to:

1. POST a webhook to the foreman
2. Assert the worker receives `task_assigned` within timeout
3. Have the worker send `task_complete`
4. Assert the task label would be applied (verify the GitHub API mock received the call)

This becomes the canary that the assembled system works at all — the test that catches the class of integration bugs that narrow unit tests miss.

---

## Summary

| Phase | What | Impact |
|-------|------|--------|
| 1 | Real local Supabase | Catches schema drift, real query behavior, migration bugs |
| 2 | Pipeline integration tests | Catches seam bugs between foreman, worker, and DB |
| 3 | Playwright browser tests | Catches server↔frontend contract bugs, real-time update bugs |
| 4 | Delete method-call tests | Removes false confidence, forces real behavior coverage |
| Smoke | Full pipeline smoke | CI canary for assembled system |

The unit tests that test pure logic (parsing, queue operations, config loading) stay. The tests that test "did this method get called" go away once there are tests that verify the observable behavior that calling that method is supposed to produce.
