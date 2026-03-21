# Design: Reactive Task Queue (Issue #215)

## Background

The foreman's `routeEvent` function currently uses imperative state transitions: each webhook action directly mutates the task queue (`labeled` → enqueue, `unlabeled` → dequeue, `closed`/`reopened` → update `openIssues`). This creates a correctness dependency on processing every relevant action explicitly and in order.

## Goal

Replace imperative mutations with a reactive model: event handlers make minimal updates to canonical state, and a single `reconcile()` function derives all consequences (task creation, task removal, worker assignment).

---

## Canonical State

Two maps constitute the sources of truth for the task queue:

**`labeledIssues: Map<number, LabeledIssueState>`** — issues that currently have the task label, plus whether their dependency graph has been loaded. New type, defined in `types.ts`.

```typescript
export interface LabeledIssueState {
  issue: TaskIssue;    // issue metadata (title, body, labels, repoUrl)
  depsLoaded: boolean; // true once fetchBlockers has resolved for this issue
}
```

**`openIssues: Set<number>`** — open issues relevant for blocker resolution (already exists; same semantics, now updated before calling `reconcile()` rather than alongside ad hoc `tryAssignWork()` calls).

**`graph: DependencyGraph`** — blocker relationships (already exists; unchanged).

The `TaskQueue` and its `Task` entries are **derived state** — materialized and maintained by `reconcile()`. Runtime task state (`status`, `assignedWorkerId`, `eventQueue`) is preserved across reconcile calls; only truly-new entries are created, only pending entries with no label are removed.

---

## `reconcile()` Function

A new private function inside `createForemanWss`, called after every canonical state change. Steps (in order):

1. **Materialize new tasks**: for each `(num, { issue, depsLoaded })` in `labeledIssues`, if `taskQueue` has no task for that issue number → `taskQueue.addTask({ taskId: String(num), issueNumber: num, ...issue, depsLoaded })`. This step is strictly "create if absent" — it never updates an existing task.

2. **Sync `depsLoaded`**: for each existing task where `labeledIssues.get(num)?.depsLoaded` is `true` but `task.depsLoaded` is `false` → call `taskQueue.markDepsLoaded([num])`. This is required because `addTask` in step 1 only runs when the task is first created; subsequent updates to `depsLoaded` in `labeledIssues` (from `startDepsLoad`) must be propagated to the existing task here.

3. **Remove stale pending tasks**: for each pending task whose `issueNumber` is not in `labeledIssues` → `taskQueue.removeTask(taskId)`. Non-pending (assigned or complete) tasks are never removed, enforced by the existing `removeTask` guard.

4. **Try assignment + broadcast**: call `tryAssignWork(w.workerId)` for each idle worker; call `broadcastSnapshot()`. Workers that receive no task will get a `standby` message, which is idempotent on the worker side (the worker just re-displays "waiting for tasks"). Calling for all idle workers is safe because JS is single-threaded — each sequential `tryAssignWork` call either claims the next pending task or sends `standby`.

`tryAssignWork()` is unchanged — it remains the function that sends `task_assigned` messages. `reconcile()` replaces the scattered `tryAssignWork()` call sites in event handlers. No event handler calls `tryAssignWork()` directly anymore.

---

## `startDepsLoad(issueNumber, body)` Helper

A new private async helper inside `createForemanWss`, called fire-and-forget (not awaited) from event handlers when a task label is applied or an issue body is edited.

```
1. fetchBlockers(issueNumber, body, { repo, token })
   → setBlockers(issueNumber, blockers, graph)
2. fetchIssueStates(blockers, { repo, token })
   → for each [num, state]: openIssues.add/delete(num)
     (both add and delete, so stale closed-blocker state is cleaned up)
3. if (labeledIssues.has(issueNumber)):
     labeledIssues.get(issueNumber).depsLoaded = true
4. reconcile()
```

This replaces the inline `.then()` chains currently embedded in the `labeled` and `edited` handlers.

**Concurrent calls**: if `startDepsLoad` is called twice for the same issue (e.g., rapid re-label or edit while a previous load is in flight), both async chains complete independently. The last one to finish sets `depsLoaded = true` and updates `openIssues` / `graph` with its fetched results. This is a benign last-writer-wins race: at worst, one load's blocker data is immediately overwritten by another, but `depsLoaded` ends up `true` and `reconcile()` fires correctly. No guard or abort mechanism is needed.

---

## Simplified `routeEvent` Issue Handlers

Each `issues` action becomes a minimal state update + `reconcile()` call:

| Action | Canonical update |
|--------|-----------------|
| `labeled` (task label) | `labeledIssues.set(num, {issue, depsLoaded: false})` + `openIssues.add(num)` + `startDepsLoad(num, body)` + `reconcile()` |
| `unlabeled` (task label) | `labeledIssues.delete(num)` + `openIssues.delete(num)` + `reconcile()` |
| `opened` (issue already has task label) | same as `labeled` |
| `closed` | `openIssues.delete(num)` + `reconcile()` |
| `reopened` | `openIssues.add(num)` + `reconcile()` |
| `edited` (body changed, issue is labeled) | set `labeledIssues.get(num).depsLoaded = false` + update `labeledIssues` entry's `issue.body` + `startDepsLoad(num, newBody)` (calls `reconcile()` internally) |

Resetting `depsLoaded = false` in the `edited` handler prevents the task from being assigned using stale blocker data while the fresh `startDepsLoad` is in flight.

PR events, `check_run`/`check_suite`, and `forwardEvent` are **unchanged**.

---

## `createForemanWss` Interface Changes

### Options

`labeledIssues?: Map<number, LabeledIssueState>` — added alongside existing `graph` and `openIssues` options (defaults to a new empty map if not provided, consistent with existing defaults for `graph` and `openIssues`).

### Return value

`reconcile` is added to the returned object alongside `wss` and `routeEventToWorker`:

```typescript
return { wss, routeEventToWorker: routeEvent, reconcile };
```

This allows the startup boot code to call `reconcile()` after `loadIssuesToQueue` returns.

### `TaskQueue` — no new methods needed

`markDepsLoaded(issueNumbers: number[])` already exists and is reused by `reconcile()` step 2 (called with a one-element array for the individual issue).

---

## `loadIssuesToQueue` Refactor (`github.ts`)

Signature changes from:
```typescript
loadIssuesToQueue(queue: TaskQueue, graph, openIssues, opts)
```
to:
```typescript
loadIssuesToQueue(labeledIssues: Map<number, LabeledIssueState>, graph, openIssues, opts)
```

Behaviour:
1. Fetch all open issues with the task label from GitHub.
2. For each issue: `labeledIssues.set(num, { issue: {...}, depsLoaded: false })` + `openIssues.add(num)`.
3. Load blockers into `graph`; fetch blocker open/closed states and add to `openIssues`. Only additions are needed here because `openIssues` starts empty at startup — no stale state to clean up.
4. Mark all entries added in this call: `entry.depsLoaded = true`.
5. Return (caller calls `reconcile()`).

`github.ts` no longer imports `TaskQueue`.

### Boot code (main block in `foreman.ts`)

```typescript
const labeledIssues = new Map<number, LabeledIssueState>();
// ...
const { wss, routeEventToWorker, reconcile } = createForemanWss(
  taskQueue, registry, server, { labeledIssues, graph, openIssues, ... }
);
// ... server.listen:
await loadIssuesToQueue(labeledIssues, graph, openIssues, opts);
reconcile();  // creates tasks with depsLoaded: true, assigns to idle workers
```

---

## Testing

All changes follow TDD. New unit tests cover:

- `reconcile()` creates tasks for new `labeledIssues` entries (with correct `depsLoaded` value).
- `reconcile()` does not duplicate tasks that already exist.
- `reconcile()` syncs `depsLoaded` from `labeledIssues` to an existing task.
- `reconcile()` removes a pending task when its issue is removed from `labeledIssues`.
- `reconcile()` does NOT remove an assigned or complete task even if removed from `labeledIssues`.
- `reconcile()` calls `tryAssignWork` for each idle worker.
- `labeled` event: task is created; `unlabeled` event: pending task is removed and `openIssues` entry is cleaned up.
- `closed` event: `openIssues` is updated; previously-blocked task becomes assignable after reconcile.
- `edited` event: `depsLoaded` is reset to `false` before dep reload.
- `loadIssuesToQueue` populates `labeledIssues` (not `taskQueue` directly), with `depsLoaded: true` after loading.
- Startup sequence: `reconcile()` after `loadIssuesToQueue` creates tasks with `depsLoaded: true`.

Existing tests for `WorkerRegistry`, `TaskQueue`, and all existing `foreman.*.test.ts` files are preserved. Integration/smoke tests (`npm run smoke`) are expected to pass without changes.

---

## Files Changed

| File | Change |
|------|--------|
| `src/types.ts` | Add `LabeledIssueState` interface |
| `src/foreman.ts` | Add `reconcile()`, `startDepsLoad()`; simplify `routeEvent`; update `createForemanWss` options/return; update boot code |
| `src/github.ts` | Change `loadIssuesToQueue` signature to accept `labeledIssues` instead of `queue` |
| `tests/foreman.reconcile.test.ts` | New test file for `reconcile()` behaviour |
| `tests/foreman.registry.test.ts` | Unchanged |
