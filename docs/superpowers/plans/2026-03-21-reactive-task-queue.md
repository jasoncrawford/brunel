# Reactive Task Queue Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace imperative state mutations in `foreman.ts` with a canonical `labeledIssues` map and a `reconcile()` function that derives all task-queue consequences.

**Architecture:** A new `LabeledIssueState` type captures per-issue label state (`issue` metadata + `depsLoaded`). Event handlers update this map and call `reconcile()`, which materialises/removes tasks in `TaskQueue` and triggers worker assignment. A `startDepsLoad()` helper handles async blocker fetching and sets `depsLoaded` in the canonical map before calling `reconcile()` again.

**Tech Stack:** TypeScript/ESM, vitest (tests), tsx (no compile step). Run tests with `npm test`, type-check with `npx tsc --noEmit`, lint with `npm run lint`.

---

## File Map

| File | Role |
|------|------|
| `src/types.ts` | Add `LabeledIssueState` interface |
| `src/foreman.ts` | Add `reconcile()` + `startDepsLoad()`; update `createForemanWss` options/return; simplify issue event handlers; update boot code |
| `src/github.ts` | Change `loadIssuesToQueue` to accept `Map<number, LabeledIssueState>` instead of `TaskQueue` |
| `tests/foreman.reconcile.test.ts` | New: unit tests for `reconcile()` |
| `tests/foreman.github.test.ts` | Update: `loadIssuesToQueue` call sites |
| `tests/foreman.webhook-routing.test.ts` | Update: pass `labeledIssues` in `createForemanWss` options |

---

## Chunk 1: `LabeledIssueState` type + `reconcile()` core

### Task 1: Add `LabeledIssueState` to `types.ts`

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add the interface**

In `src/types.ts`, add after the `TaskIssue` interface:

```typescript
export interface LabeledIssueState {
  issue: TaskIssue;    // issue metadata (title, body, labels, repoUrl)
  depsLoaded: boolean; // true once fetchBlockers has resolved for this issue
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add LabeledIssueState type to types.ts"
```

---

### Task 2: Add `labeledIssues` option and expose `reconcile` from `createForemanWss`

**Files:**
- Modify: `src/foreman.ts`
- Create: `tests/foreman.reconcile.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/foreman.reconcile.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import http from "http";
import { TaskQueue, WorkerRegistry, createForemanWss } from "../src/foreman.js";
import type { LabeledIssueState } from "../src/types.js";

const TASK_LABEL = "brunel:ready";

function makeIssue(n: number): LabeledIssueState["issue"] {
  return { number: n, title: `Issue ${n}`, body: "body", labels: [TASK_LABEL], repoUrl: "https://github.com/o/r" };
}

describe("reconcile()", () => {
  let queue: TaskQueue;
  let registry: WorkerRegistry;
  let labeledIssues: Map<number, LabeledIssueState>;
  let reconcile: () => void;

  beforeEach(() => {
    queue = new TaskQueue();
    registry = new WorkerRegistry();
    labeledIssues = new Map();
    const server = http.createServer();
    ({ reconcile } = createForemanWss(queue, registry, server, {
      taskLabel: TASK_LABEL,
      labeledIssues,
    }));
  });

  it("is exposed in the return value of createForemanWss", () => {
    expect(typeof reconcile).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/foreman.reconcile.test.ts
```
Expected: FAIL — `reconcile` is not in the return value / not a function.

- [ ] **Step 3: Add `labeledIssues` option and `reconcile` stub to `createForemanWss`**

In `src/foreman.ts`, locate the `createForemanWss` options type and add:

```typescript
labeledIssues?: Map<number, LabeledIssueState>;
```

Add `LabeledIssueState` to the existing `types.js` import in `foreman.ts` (line 6). Change:
```typescript
import type { WorkerMessage, ForemanMessage, GitHubEvent } from "./types.js";
```
to:
```typescript
import type { WorkerMessage, ForemanMessage, GitHubEvent, LabeledIssueState } from "./types.js";
```

Inside `createForemanWss`, resolve the option (after the existing `openIssues` line):
```typescript
const labeledIssues = options.labeledIssues ?? new Map<number, LabeledIssueState>();
```

Add a stub `reconcile` function (will be filled in next tasks):
```typescript
function reconcile() {
  // TODO: implement
}
```

Change the return statement from:
```typescript
return { wss, routeEventToWorker: routeEvent };
```
to:
```typescript
return { wss, routeEventToWorker: routeEvent, reconcile };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/foreman.reconcile.test.ts
```
Expected: PASS.

- [ ] **Step 5: Full test suite**

```bash
npm test
```
Expected: all tests pass (existing tests unaffected by additive return field).

- [ ] **Step 6: Commit**

```bash
git add src/foreman.ts src/types.ts tests/foreman.reconcile.test.ts
git commit -m "feat: add labeledIssues option and expose reconcile() stub from createForemanWss"
```

---

### Task 3: `reconcile()` — step 1: materialise new tasks

**Files:**
- Modify: `src/foreman.ts`, `tests/foreman.reconcile.test.ts`

- [ ] **Step 1: Write failing tests**

Add to the `describe("reconcile()")` block in `tests/foreman.reconcile.test.ts`:

```typescript
  it("creates a task for each entry in labeledIssues that has no task yet", () => {
    labeledIssues.set(42, { issue: makeIssue(42), depsLoaded: true });
    reconcile();
    const t = queue.get("42");
    expect(t?.issueNumber).toBe(42);
    expect(t?.title).toBe("Issue 42");
    expect(t?.depsLoaded).toBe(true);
    expect(t?.status).toBe("pending");
  });

  it("creates task with depsLoaded: false when entry says false", () => {
    labeledIssues.set(7, { issue: makeIssue(7), depsLoaded: false });
    reconcile();
    expect(queue.get("7")?.depsLoaded).toBe(false);
  });

  it("does not create a duplicate task if one already exists for the issue", () => {
    queue.addTask({ taskId: "42", issueNumber: 42, title: "Existing", body: "b", labels: [], repoUrl: "", depsLoaded: true });
    labeledIssues.set(42, { issue: makeIssue(42), depsLoaded: true });
    reconcile();
    // Title must not be overwritten by reconcile
    expect(queue.get("42")?.title).toBe("Existing");
  });
```

- [ ] **Step 2: Run to verify they fail**

```bash
npm test -- tests/foreman.reconcile.test.ts
```
Expected: FAIL — no tasks created.

- [ ] **Step 3: Implement step 1 in `reconcile()`**

Replace the `// TODO: implement` stub:

```typescript
function reconcile() {
  // Step 1: materialise tasks for new labeledIssues entries
  for (const [num, { issue, depsLoaded }] of labeledIssues) {
    if (!taskQueue.getTaskForIssue(num)) {
      taskQueue.addTask({
        taskId: String(num),
        issueNumber: num,
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
        repoUrl: issue.repoUrl,
        depsLoaded,
      });
    }
  }
}
```

Note: we spread the `issue` fields explicitly rather than using `...issue` because `TaskIssue.number` would collide with `issueNumber`; we pass `issueNumber: num` separately.

- [ ] **Step 4: Run to verify tests pass**

```bash
npm test -- tests/foreman.reconcile.test.ts
```
Expected: PASS.

- [ ] **Step 5: Full test suite**

```bash
npm test
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/foreman.ts tests/foreman.reconcile.test.ts
git commit -m "feat: reconcile() step 1 — materialise tasks for new labeledIssues entries"
```

---

### Task 4: `reconcile()` — step 2: sync `depsLoaded` to existing tasks

**Files:**
- Modify: `src/foreman.ts`, `tests/foreman.reconcile.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
  it("syncs depsLoaded from labeledIssues to an existing task that has depsLoaded: false", () => {
    queue.addTask({ taskId: "5", issueNumber: 5, title: "T", body: "b", labels: [], repoUrl: "", depsLoaded: false });
    labeledIssues.set(5, { issue: makeIssue(5), depsLoaded: true });
    reconcile();
    expect(queue.get("5")?.depsLoaded).toBe(true);
  });

  it("does not change depsLoaded on an existing task when labeledIssues also says false", () => {
    queue.addTask({ taskId: "5", issueNumber: 5, title: "T", body: "b", labels: [], repoUrl: "", depsLoaded: false });
    labeledIssues.set(5, { issue: makeIssue(5), depsLoaded: false });
    reconcile();
    expect(queue.get("5")?.depsLoaded).toBe(false);
  });
```

- [ ] **Step 2: Run to verify they fail**

```bash
npm test -- tests/foreman.reconcile.test.ts
```
Expected: first test FAILs (depsLoaded not synced).

- [ ] **Step 3: Add step 2 to `reconcile()`**

After the step-1 loop, add:

```typescript
  // Step 2: sync depsLoaded from labeledIssues to existing tasks
  for (const [num, { depsLoaded }] of labeledIssues) {
    if (depsLoaded) {
      const t = taskQueue.getTaskForIssue(num);
      if (t && !t.depsLoaded) {
        taskQueue.markDepsLoaded([num]);
      }
    }
  }
```

- [ ] **Step 4: Run to verify tests pass**

```bash
npm test -- tests/foreman.reconcile.test.ts
```
Expected: PASS.

- [ ] **Step 5: Full test suite**

```bash
npm test
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/foreman.ts tests/foreman.reconcile.test.ts
git commit -m "feat: reconcile() step 2 — sync depsLoaded from labeledIssues to existing tasks"
```

---

### Task 5: `reconcile()` — step 3: remove stale pending tasks

**Files:**
- Modify: `src/foreman.ts`, `tests/foreman.reconcile.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
  it("removes a pending task whose issue is no longer in labeledIssues", () => {
    queue.addTask({ taskId: "9", issueNumber: 9, title: "T", body: "b", labels: [], repoUrl: "" });
    // labeledIssues is empty — issue 9 has no label
    reconcile();
    expect(queue.get("9")).toBeUndefined();
  });

  it("does NOT remove an assigned task even if its issue is not in labeledIssues", () => {
    queue.addTask({ taskId: "9", issueNumber: 9, title: "T", body: "b", labels: [], repoUrl: "" });
    queue.assignTask("9", "worker-1");
    reconcile();
    expect(queue.get("9")).toBeDefined();
    expect(queue.get("9")?.status).toBe("assigned");
  });

  it("does NOT remove a complete task even if its issue is not in labeledIssues", () => {
    queue.addTask({ taskId: "9", issueNumber: 9, title: "T", body: "b", labels: [], repoUrl: "" });
    queue.completeTask("9");
    reconcile();
    expect(queue.get("9")).toBeDefined();
    expect(queue.get("9")?.status).toBe("complete");
  });
```

- [ ] **Step 2: Run to verify they fail**

```bash
npm test -- tests/foreman.reconcile.test.ts
```
Expected: first test FAILs (stale task not removed).

- [ ] **Step 3: Add `getPendingTasks()` to `TaskQueue` and step 3 to `reconcile()`**

`TaskQueue.tasks` is private and `nextPending()` only returns one match. Add a public method to `TaskQueue` in `src/foreman.ts`:

```typescript
  getPendingTasks(): Task[] {
    return [...this.tasks.values()].filter((t) => t.status === "pending");
  }
```

Then add step 3 to `reconcile()` after the step-2 loop:

```typescript
  // Step 3: remove pending tasks whose issue no longer has the label
  for (const t of taskQueue.getPendingTasks()) {
    if (!labeledIssues.has(t.issueNumber)) {
      taskQueue.removeTask(t.taskId);
    }
  }
```

- [ ] **Step 4: Run to verify tests pass**

```bash
npm test -- tests/foreman.reconcile.test.ts
```
Expected: PASS.

- [ ] **Step 5: Full test suite**

```bash
npm test
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/foreman.ts tests/foreman.reconcile.test.ts
git commit -m "feat: reconcile() step 3 — remove pending tasks not in labeledIssues; add TaskQueue.getPendingTasks()"
```

---

### Task 6: `reconcile()` — step 4: try assignment for all idle workers

**Files:**
- Modify: `src/foreman.ts`, `tests/foreman.reconcile.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
  it("calls tryAssignWork for each idle worker, assigning pending ready tasks", () => {
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    registry.register("w1", fakeWs, "idle");

    labeledIssues.set(42, { issue: makeIssue(42), depsLoaded: true });
    reconcile();

    // task_assigned message should have been sent to the idle worker
    expect(fakeWs.send).toHaveBeenCalledWith(expect.stringContaining('"task_assigned"'));
    expect(queue.get("42")?.status).toBe("assigned");
    expect(registry.get("w1")?.status).toBe("busy");
  });
```

Add `vi` to the import at the top of the test file:
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- tests/foreman.reconcile.test.ts
```
Expected: FAIL — no assignment happens.

- [ ] **Step 3: Add step 4 to `reconcile()`**

After the step-3 loop, add:

```typescript
  // Step 4: try assignment for all idle workers
  // Note: tryAssignWork calls broadcastSnapshot() internally when a task is assigned.
  // We call it once at the end to cover the case where no assignment happened
  // (e.g. all workers got standby). This may result in a redundant snapshot on
  // assignment, which is harmless — snapshots are idempotent.
  for (const w of registry.getIdleWorkers()) {
    tryAssignWork(w.workerId);
  }
  broadcastSnapshot();
```

- [ ] **Step 4: Run to verify tests pass**

```bash
npm test -- tests/foreman.reconcile.test.ts
```
Expected: PASS.

- [ ] **Step 5: Full test suite**

```bash
npm test
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/foreman.ts tests/foreman.reconcile.test.ts
git commit -m "feat: reconcile() step 4 — call tryAssignWork for all idle workers"
```

---

## Chunk 2: `startDepsLoad()` helper + event handler simplification

### Task 7: Extract `startDepsLoad()` helper

**Files:**
- Modify: `src/foreman.ts`, `tests/foreman.reconcile.test.ts`

**Prerequisite:** Chunk 1 must be complete — `LabeledIssueState` must exist in `types.ts` and `reconcile` must be returned by `createForemanWss`.

- [ ] **Step 2: Add `startDepsLoad()` to `createForemanWss`**

Add the following private async helper inside `createForemanWss`, before `reconcile()`:

```typescript
  function startDepsLoad(issueNumber: number, body: string): void {
    fetchBlockers(issueNumber, body, { repo, token })
      .then((blockers) => {
        setBlockers(issueNumber, blockers, graph);
        return blockers.length > 0
          ? fetchIssueStates(blockers, { repo, token })
          : Promise.resolve(new Map<number, "open" | "closed">());
      })
      .then((states) => {
        for (const [num, state] of states) {
          if (state === "open") openIssues.add(num);
          else openIssues.delete(num);
        }
        const entry = labeledIssues.get(issueNumber);
        if (entry) entry.depsLoaded = true;
        reconcile();
      })
      .catch((err) => flog(`ERROR fetching deps for #${issueNumber}: ${err}`));
  }
```

Note: `startDepsLoad` returns `void` (not a Promise) — callers fire-and-forget without `await`.

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Full test suite**

```bash
npm test
```
Expected: all pass (nothing broken yet, helper is not called anywhere).

- [ ] **Step 5: Commit**

```bash
git add src/foreman.ts tests/foreman.reconcile.test.ts
git commit -m "feat: add startDepsLoad() helper to createForemanWss"
```

---

### Task 8: Simplify `labeled` / `opened` event handlers

**Files:**
- Modify: `src/foreman.ts`, `tests/foreman.reconcile.test.ts`

The current `labeled` handler in `routeEvent` (look for `if (labeledNow || openedWithLabel)`) does inline dep loading. Replace it entirely.

- [ ] **Step 1: Locate the handler to replace**

In `src/foreman.ts`, find the block starting at roughly:
```typescript
    if (!task && name === "issues" && issue) {
      const action = p.action as string | undefined;
      const labeledNow = ...
      const openedWithLabel = ...
      if (labeledNow || openedWithLabel) {
        ...
        return;
      }
    }
```

- [ ] **Step 2: Replace `labeled`/`opened` handler**

Replace the entire `if (labeledNow || openedWithLabel) { ... return; }` block (including the inline `.then()` chain and the `return`) with:

```typescript
      if (labeledNow || openedWithLabel) {
        const repoUrl =
          ((p.repository as Record<string, unknown> | undefined)?.html_url as string | undefined) ?? "";
        const labels =
          (issue.labels as Array<{ name: string }> | undefined)?.map((l) => l.name) ?? [];
        const issueData: TaskIssue = {
          number: issueNumber,
          title: String(issue.title ?? ""),
          body: String(issue.body ?? ""),
          labels,
          repoUrl,
        };
        labeledIssues.set(issueNumber, { issue: issueData, depsLoaded: false });
        openIssues.add(issueNumber);
        startDepsLoad(issueNumber, issueData.body);
        reconcile();
        // Don't return — fall through to let forwardEvent run if task is assigned
        task = taskQueue.getTaskForIssue(issueNumber);
      }
```

Note: we need to import `TaskIssue` in the file — it's already in `types.ts`. Check `foreman.ts` imports. If not imported, add it:
```typescript
import type { WorkerMessage, ForemanMessage, GitHubEvent, TaskIssue, LabeledIssueState } from "./types.js";
```

- [ ] **Step 3: Run full test suite**

```bash
npm test
```
Expected: all tests pass. If any fail, investigate — the `foreman.webhook-routing.test.ts` tests for `labeled` should still pass because the observable behavior is identical.

- [ ] **Step 4: Add a real `startDepsLoad` error test**

`startDepsLoad` is not directly accessible — test it by triggering a `labeled` event via `routeEventToWorker`, which calls `startDepsLoad` internally. We need `routeEventToWorker` in the test, so add it to the `beforeEach` captures.

At the top of `tests/foreman.reconcile.test.ts`, update the variable declarations to also capture `routeEventToWorker`:

```typescript
  let queue: TaskQueue;
  let registry: WorkerRegistry;
  let labeledIssues: Map<number, LabeledIssueState>;
  let reconcile: () => void;
  let routeEventToWorker: (id: string, name: string, payload: unknown) => void;
```

Update `beforeEach` to capture it:

```typescript
    ({ reconcile, routeEventToWorker } = createForemanWss(queue, registry, server, {
      taskLabel: TASK_LABEL,
      labeledIssues,
    }));
```

Then add this `describe` block (outside the main `describe("reconcile()")` block) at the end of the file:

```typescript
describe("startDepsLoad() error handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("task remains pending with depsLoaded: false when dep fetch fails", async () => {
    // Mock fetch to reject — this causes fetchNativeBlockers (called by fetchBlockers
    // inside startDepsLoad) to reject, which propagates to the .catch handler.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    // Trigger startDepsLoad by routing a labeled event
    routeEventToWorker("evt-1", "issues", {
      action: "labeled",
      label: { name: TASK_LABEL },
      issue: {
        number: 42,
        title: "Issue 42",
        body: "body",
        labels: [{ name: TASK_LABEL }],
      },
      repository: { html_url: "https://github.com/o/r" },
    });

    // Task created synchronously by reconcile() with depsLoaded: false
    expect(queue.get("42")?.depsLoaded).toBe(false);

    // Wait for the async startDepsLoad chain to fail and settle
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    // After failure, depsLoaded must still be false and task still pending
    expect(queue.get("42")?.depsLoaded).toBe(false);
    expect(queue.get("42")?.status).toBe("pending");
  });
});
```

- [ ] **Step 5: Run tests**

```bash
npm test -- tests/foreman.reconcile.test.ts
```
Expected: PASS.

- [ ] **Step 6: Full test suite**

```bash
npm test
```
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/foreman.ts tests/foreman.reconcile.test.ts
git commit -m "feat: simplify labeled/opened handlers to use labeledIssues + reconcile()"
```

---

### Task 9: Simplify `unlabeled` handler

**Files:**
- Modify: `src/foreman.ts`

- [ ] **Step 1: Locate and replace the `unlabeled` handler**

Find (roughly):
```typescript
      if (
        action === "unlabeled" &&
        (p.label as Record<string, unknown> | undefined)?.name === taskLabel
      ) {
        const existingTask = taskQueue.getTaskForIssue(issueNumber);
        if (existingTask?.status === "pending") {
          taskQueue.removeTask(existingTask.taskId);
          openIssues.delete(issueNumber);
          broadcastSnapshot();
          flog(`[task #${issueNumber}] dequeued (label removed)`);
        }
        return;
      }
```

Replace with:

```typescript
      if (
        action === "unlabeled" &&
        (p.label as Record<string, unknown> | undefined)?.name === taskLabel
      ) {
        labeledIssues.delete(issueNumber);
        openIssues.delete(issueNumber);
        flog(`[task #${issueNumber}] dequeued (label removed)`);
        reconcile();
        return;
      }
```

- [ ] **Step 2: Run full test suite**

```bash
npm test
```
Expected: all pass. The `unlabeled` tests in `foreman.webhook-routing.test.ts` should pass because `reconcile()` removes the pending task.

- [ ] **Step 3: Commit**

```bash
git add src/foreman.ts
git commit -m "feat: simplify unlabeled handler to use labeledIssues + reconcile()"
```

---

### Task 10: Simplify `closed` and `reopened` handlers

**Files:**
- Modify: `src/foreman.ts`

- [ ] **Step 1: Locate and replace `closed` handler**

Find:
```typescript
      if (action === "closed") {
        openIssues.delete(issueNumber);
        for (const w of registry.getIdleWorkers()) {
          tryAssignWork(w.workerId);
        }
        return;
      }
```

Replace with:
```typescript
      if (action === "closed") {
        openIssues.delete(issueNumber);
        reconcile();
        return;
      }
```

- [ ] **Step 2: Locate and replace `reopened` handler**

Find:
```typescript
      if (action === "reopened") {
        openIssues.add(issueNumber);
        return;
      }
```

Replace with:
```typescript
      if (action === "reopened") {
        openIssues.add(issueNumber);
        reconcile();
        return;
      }
```

- [ ] **Step 3: Run full test suite**

```bash
npm test
```
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/foreman.ts
git commit -m "feat: simplify closed/reopened handlers to use reconcile()"
```

---

### Task 11: Simplify `edited` handler

**Files:**
- Modify: `src/foreman.ts`

- [ ] **Step 1: Locate the `edited` handler**

Find (roughly):
```typescript
      if (action === "edited") {
        const changes = p.changes as Record<string, unknown> | undefined;
        if (changes?.body) {
          const body = String(issue.body ?? "");
          fetchBlockers(issueNumber, body, { repo, token })
            .then((blockers) => {
              ...
              for (const w of registry.getIdleWorkers()) {
                tryAssignWork(w.workerId);
              }
            })
            .catch((err) => flog(`ERROR updating deps for #${issueNumber}: ${err}`));
        }
        // fall through: let existing forwardEvent logic run for assigned tasks
      }
```

- [ ] **Step 2: Replace the `edited` handler**

```typescript
      if (action === "edited") {
        const changes = p.changes as Record<string, unknown> | undefined;
        if (changes?.body) {
          const newBody = String(issue.body ?? "");
          const entry = labeledIssues.get(issueNumber);
          if (entry) {
            entry.depsLoaded = false;
            entry.issue = { ...entry.issue, body: newBody };
            startDepsLoad(issueNumber, newBody);
          }
        }
        // fall through: let forwardEvent run for assigned tasks
      }
```

- [ ] **Step 3: Run full test suite**

```bash
npm test
```
Expected: all pass.

- [ ] **Step 4: Remove now-redundant `broadcastSnapshot()` and `flog` calls from `labeled` path**

Review the `labeled` handler added in Task 8. The old code had explicit `broadcastSnapshot()` and `flog(...)` calls after task creation. With `reconcile()`, `broadcastSnapshot()` is always called at the end. Add an explicit log line for new task enqueue in the `labeled` handler if the task is truly new (for observability, matching existing behavior):

In the `labeled`/`opened` handler, after `reconcile()`:
```typescript
        flog(`[task #${issueNumber}] enqueued via ${name}/${action}`);
```

- [ ] **Step 5: Run full test suite**

```bash
npm test
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/foreman.ts
git commit -m "feat: simplify edited handler to update labeledIssues + startDepsLoad"
```

---

## Chunk 3: `loadIssuesToQueue` refactor + test updates

### Task 12: Refactor `loadIssuesToQueue` in `github.ts`

**Files:**
- Modify: `src/github.ts`

- [ ] **Step 1: Update the signature and implementation**

In `src/github.ts`:

1. Add import at the top:
```typescript
import type { LabeledIssueState, TaskIssue } from "./types.js";
```

2. Remove the `TaskQueue` import (it's currently imported from `./foreman.js`).

3. Change the `loadIssuesToQueue` signature from:
```typescript
export async function loadIssuesToQueue(
  queue: TaskQueue,
  graph: DependencyGraph,
  openIssues: Set<number>,
  opts: { repo: string; token: string; taskLabel: string },
): Promise<void>
```
to:
```typescript
export async function loadIssuesToQueue(
  labeledIssues: Map<number, LabeledIssueState>,
  graph: DependencyGraph,
  openIssues: Set<number>,
  opts: { repo: string; token: string; taskLabel: string },
): Promise<void>
```

4. Replace the body. The current body calls `queue.addTask(...)` and `openIssues.add(...)` and `queue.markDepsLoaded(...)`. Replace with:

```typescript
  const { repo, token, taskLabel } = opts;
  const [owner, repoName] = repo.split("/");
  const url = `https://api.github.com/repos/${owner}/${repoName}/issues?labels=${encodeURIComponent(taskLabel)}&state=open&per_page=100`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const issues = await res.json() as Array<{
    number: number; title: string; body: string | null; labels: Array<{ name: string }>;
  }>;

  const allBlockerNumbers = new Set<number>();
  const loadedIssueNumbers: number[] = [];

  for (const issue of issues) {
    const issueData: TaskIssue = {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      labels: issue.labels.map((l) => l.name),
      repoUrl: `https://github.com/${owner}/${repoName}`,
    };
    labeledIssues.set(issue.number, { issue: issueData, depsLoaded: false });
    openIssues.add(issue.number);
    const blockers = await fetchBlockers(issue.number, issue.body ?? "", { repo, token });
    setBlockers(issue.number, blockers, graph);
    for (const b of blockers) allBlockerNumbers.add(b);
    loadedIssueNumbers.push(issue.number);
  }

  if (allBlockerNumbers.size > 0) {
    const states = await fetchIssueStates(Array.from(allBlockerNumbers), { repo, token });
    for (const [num, state] of states) {
      if (state === "open") openIssues.add(num);
    }
  }

  // Mark all loaded entries as having their deps resolved
  for (const num of loadedIssueNumbers) {
    const entry = labeledIssues.get(num);
    if (entry) entry.depsLoaded = true;
  }
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```
Expected: errors in `foreman.ts` boot code (still passes `TaskQueue`) and `foreman.github.test.ts`. That's expected — fix in next tasks.

- [ ] **Step 3: Update boot code in `foreman.ts`**

In the main boot block (bottom of `src/foreman.ts`), find:

```typescript
  const registry = new WorkerRegistry();
  const taskQueue = new TaskQueue();
  const graph: DependencyGraph = new Map();
  const openIssues = new Set<number>();
```

Add after `openIssues`:
```typescript
  const labeledIssues = new Map<number, LabeledIssueState>();
```

Update the `createForemanWss` call to pass `labeledIssues`:
```typescript
  ({ routeEventToWorker: routeEvent } = createForemanWss(
    taskQueue, registry, server,
    {
      graph,
      openIssues,
      labeledIssues,
      taskLabel: config.taskLabel,
      ...
    },
  ));
```

Wait — currently the boot code destructures: `({ routeEventToWorker: routeEvent } = createForemanWss(...))`. We now also get `reconcile` back. Update the destructuring:
```typescript
  let reconcile: () => void = () => {};
  // ...
  ({ routeEventToWorker: routeEvent, reconcile } = createForemanWss(...));
```

Update the `server.listen` callback to call `reconcile()` after `loadIssuesToQueue`:

```typescript
  server.listen(config.port, async () => {
    // ... existing log lines ...
    try {
      await loadIssuesToQueue(labeledIssues, graph, openIssues, {
        repo: config.githubRepo,
        token: config.githubToken,
        taskLabel: config.taskLabel,
      });
      reconcile();
    } catch (err) {
      flog(`WARNING Failed to load issues from GitHub: ${err}`);
    }
  });
```

- [ ] **Step 4: Type-check again**

```bash
npx tsc --noEmit
```
Expected: only errors in test files (github.test.ts). That's fine — fix next.

- [ ] **Step 5: Commit**

```bash
git add src/foreman.ts src/github.ts
git commit -m "feat: refactor loadIssuesToQueue to accept labeledIssues; update boot code"
```

---

### Task 13: Update `tests/foreman.github.test.ts`

**Files:**
- Modify: `tests/foreman.github.test.ts`

- [ ] **Step 1: Update imports**

Remove the `TaskQueue` import. Add `LabeledIssueState`:
```typescript
import type { LabeledIssueState } from "../src/types.js";
```

Remove:
```typescript
import { TaskQueue } from "../src/foreman.js";
```

- [ ] **Step 2: Update `loadIssuesToQueue` tests**

Replace every occurrence of `new TaskQueue()` or `q = new TaskQueue()` passed to `loadIssuesToQueue` with a `Map<number, LabeledIssueState>`.

Test "fetches open issues and adds them to queue":
```typescript
  it("fetches open issues with the task label and populates labeledIssues", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockIssues,
    } as any);

    const labeledIssues = new Map<number, LabeledIssueState>();
    await loadIssuesToQueue(labeledIssues, new Map(), new Set(), QUEUE_OPTS);

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("owner/repo/issues"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token123" }) }),
    );
    expect(labeledIssues.get(1)?.issue.title).toBe("First issue");
    expect(labeledIssues.get(2)?.issue.body).toBe(""); // null coerced to ""
    expect(labeledIssues.get(1)?.depsLoaded).toBe(true);
  });
```

Test "throws on non-ok response":
```typescript
  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 403 } as any);
    await expect(loadIssuesToQueue(new Map(), new Map(), new Set(), QUEUE_OPTS)).rejects.toThrow("403");
  });
```

Test in "with dependency graph" suite — replace `const q = new TaskQueue()` and assertions about `q.get(...)`:
```typescript
  it("populates graph and openIssues from blockers returned by fetchBlockers", async () => {
    // ... (same fetch mock setup) ...
    const graph: DependencyGraph = new Map();
    const openIssues = new Set<number>();
    const labeledIssues = new Map<number, LabeledIssueState>();
    await loadIssuesToQueue(labeledIssues, graph, openIssues, QUEUE_OPTS);

    expect(graph.get(1)).toEqual(new Set([99]));
    expect(openIssues.has(99)).toBe(true);
    expect(openIssues.has(1)).toBe(true);
    expect(labeledIssues.get(1)?.depsLoaded).toBe(true);
  });

  it("does not add closed blocker to openIssues", async () => {
    // ... (same fetch mock setup) ...
    const graph: DependencyGraph = new Map();
    const openIssues = new Set<number>();
    await loadIssuesToQueue(new Map(), graph, openIssues, QUEUE_OPTS);

    expect(openIssues.has(50)).toBe(false);
  });
```

- [ ] **Step 3: Run the github tests**

```bash
npm test -- tests/foreman.github.test.ts
```
Expected: PASS.

- [ ] **Step 4: Full test suite**

```bash
npm test
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add tests/foreman.github.test.ts
git commit -m "test: update foreman.github.test.ts for new loadIssuesToQueue signature"
```

---

### Task 14: Update `tests/foreman.webhook-routing.test.ts`

**Files:**
- Modify: `tests/foreman.webhook-routing.test.ts`

- [ ] **Step 1: Add `labeledIssues` to the test harness**

In the `beforeEach` block (around line 183), add:

```typescript
  const labeledIssues = new Map<number, LabeledIssueState>();
```

Update the `createForemanWss` call to pass `labeledIssues`:
```typescript
  ({ wss, routeEventToWorker: routeEvent } = createForemanWss(queue, registry, httpServer, {
    taskLabel: DEFAULT_TASK_LABEL,
    labeledIssues,
  }));
```

Add the import:
```typescript
import type { LabeledIssueState } from "../src/types.js";
```

- [ ] **Step 2: Run the webhook-routing tests**

```bash
npm test -- tests/foreman.webhook-routing.test.ts
```
Expected: PASS. If any tests fail, investigate and fix.

- [ ] **Step 3: Fix test "issues/labeled does not enqueue duplicate"**

The test at line 285 pre-populates `queue.addTask({ taskId: "42", ... })` then fires `labeled`. After the refactor, `labeled` sets `labeledIssues.set(42, {...})` and calls `reconcile()`. `reconcile()` step 1 checks `taskQueue.getTaskForIssue(42)` — the pre-populated task exists — so no new task is created. The existing test expects `queue.get("42")?.title` to be "Existing Issue" (the pre-populated title). This should still pass because `reconcile()` only creates tasks if absent.

If the test fails, investigate whether the issue is in the `task = taskQueue.getTaskForIssue(issueNumber)!;` line that previously ran after enqueue. The `task` variable is used to fall through to `forwardEvent`. With the refactor, the labeled handler now does:
```typescript
task = taskQueue.getTaskForIssue(issueNumber);
```
at the end of the `labeled` block. Since the task was already there, this still returns the pre-populated task. The fall-through to `forwardEvent` should work correctly.

- [ ] **Step 4: Full test suite**

```bash
npm test
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add tests/foreman.webhook-routing.test.ts
git commit -m "test: update webhook-routing test harness to pass labeledIssues to createForemanWss"
```

---

### Task 15: Final verification

**Files:** None

- [ ] **Step 1: Full test suite**

```bash
npm test
```
Expected: all tests pass, no failures.

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Lint**

```bash
npm run lint
```
Expected: no errors (fix any `no-floating-promises` issues if `startDepsLoad` is accidentally awaited anywhere).

- [ ] **Step 4: Smoke test**

```bash
npm run smoke
```
Expected: "Worker connected to foreman and received standby" — PASS.

- [ ] **Step 5: Commit any lint fixes**

If lint fixes were needed:
```bash
git add -p
git commit -m "fix: address lint issues from reactive task queue refactor"
```

---

## Summary of Key Invariants

**`taskId === String(issueNumber)` must hold** for all tasks created through `reconcile()`. `markDepsLoaded` (used in step 2) looks up tasks by `String(issueNumber)` — if this invariant is violated, `depsLoaded` sync silently does nothing.

**`reconcile()` is safe to call any number of times** — it is idempotent given the same canonical state. Step 1 is "create if absent", step 2 is a no-op if already synced, step 3 only removes genuinely stale tasks.

**`startDepsLoad()` is fire-and-forget** — never `await` it. It catches its own errors with `flog`.

**Tests that pre-populate tasks via `queue.addTask()` and then fire issue label events** — reconcile step 3 only removes *pending* tasks not in `labeledIssues`. Since most such tests assign the pre-populated task to a worker before firing events, the task is "assigned" and won't be removed.
