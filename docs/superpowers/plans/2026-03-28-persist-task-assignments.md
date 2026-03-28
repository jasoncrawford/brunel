# Persist Task Assignments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist foreman task assignments in Supabase so that on restart, assigned tasks are not double-assigned and PR/branch routing tables are rebuilt correctly.

**Architecture:** A new `TaskAssignmentStore` (real + null) lives in `db.ts`. The foreman writes an assignment row to Supabase before sending `task_assigned`, and deletes it on completion or revert. At startup, assignments are loaded before `server.listen` so the queue is seeded correctly and workers that reconnect idle can revert their prior tasks. A `startupDisconnected` map is returned from `createForemanWss` and populated from DB rows in the main block.

**Tech Stack:** TypeScript/ESM, Supabase (`@supabase/supabase-js`), Vitest for tests.

---

## File Map

| File | Change |
|------|--------|
| `supabase/migrations/20260328000000_create_task_assignments.sql` | **Create** — new table |
| `src/db.ts` | **Modify** — add `TaskAssignmentStore` interface, `createTaskAssignmentStore`, `createNullTaskAssignmentStore` |
| `src/foreman.ts` | **Modify** — `tryAssignWork` async + DB write, `handleWorkerHello` revert logic, `handleTaskComplete` delete row, `doRouteEvent` updatePr, main block startup sequence |
| `tests/db.assignments.test.ts` | **Create** — tests for `TaskAssignmentStore` |
| `tests/foreman.startup.test.ts` | **Create** — tests for startup assignment loading + reconnect behavior |

---

### Task 1: SQL Migration

**Files:**
- Create: `supabase/migrations/20260328000000_create_task_assignments.sql`

- [ ] **Step 1: Create migration file**

```sql
create table task_assignments (
  task_id       text primary key,
  worker_id     text not null,
  pr_number     integer,
  branch        text,
  assigned_at   timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260328000000_create_task_assignments.sql
git commit -m "feat: add task_assignments migration"
```

---

### Task 2: TaskAssignmentStore in db.ts

**Files:**
- Modify: `src/db.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/db.assignments.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { createTaskAssignmentStore, createNullTaskAssignmentStore } from "../src/db.js";

function makeSupabase() {
  const rows: Record<string, unknown>[] = [];
  const deleted: string[] = [];

  const builder = (returnRows: Record<string, unknown>[]) => ({
    upsert: vi.fn().mockResolvedValue({ error: null }),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((cb: (v: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve(cb({ data: returnRows, error: null }))
    ),
    delete: vi.fn().mockReturnThis(),
  });

  const upsertBuilder = {
    upsert: vi.fn().mockResolvedValue({ error: null }),
  };
  const updateBuilder = {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    then: vi.fn().mockResolvedValue({ error: null }),
  };
  const deleteBuilder = {
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockResolvedValue({ error: null }),
  };
  const selectBuilder = {
    select: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((cb: (v: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve(cb({ data: rows, error: null }))
    ),
  };

  const supabase = {
    from: vi.fn().mockImplementation((_table: string) => ({
      upsert: upsertBuilder.upsert,
      update: updateBuilder.update,
      eq: updateBuilder.eq,
      delete: deleteBuilder.delete,
      select: selectBuilder.select,
      then: selectBuilder.then,
    })),
    _rows: rows,
    _deleted: deleted,
    _upsertBuilder: upsertBuilder,
    _updateBuilder: updateBuilder,
    _deleteBuilder: deleteBuilder,
    _selectBuilder: selectBuilder,
  };
  return supabase;
}

describe("createTaskAssignmentStore", () => {
  it("upsertAssignment calls supabase upsert on task_assignments", async () => {
    const sb = makeSupabase();
    const store = createTaskAssignmentStore(sb as never);
    await store.upsertAssignment("42", "worker-1");
    expect(sb.from).toHaveBeenCalledWith("task_assignments");
    expect(sb._upsertBuilder.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: "42", worker_id: "worker-1" }),
      expect.objectContaining({ onConflict: "task_id" }),
    );
  });

  it("updatePr calls supabase update with pr_number and branch", async () => {
    const sb = makeSupabase();
    const store = createTaskAssignmentStore(sb as never);
    await store.updatePr("42", 10, "fix-issue-42");
    expect(sb.from).toHaveBeenCalledWith("task_assignments");
    expect(sb._updateBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ pr_number: 10, branch: "fix-issue-42" }),
    );
  });

  it("deleteAssignment calls supabase delete filtered by task_id", async () => {
    const sb = makeSupabase();
    const store = createTaskAssignmentStore(sb as never);
    await store.deleteAssignment("42");
    expect(sb.from).toHaveBeenCalledWith("task_assignments");
    expect(sb._deleteBuilder.delete).toHaveBeenCalled();
    expect(sb._deleteBuilder.eq).toHaveBeenCalledWith("task_id", "42");
  });

  it("listAssignments returns mapped rows", async () => {
    const sb = makeSupabase();
    sb._rows.push({ task_id: "42", worker_id: "w1", pr_number: 10, branch: "fix-42" });
    const store = createTaskAssignmentStore(sb as never);
    const rows = await store.listAssignments();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ taskId: "42", workerId: "w1", prNumber: 10, branch: "fix-42" });
  });

  it("listAssignments handles null pr_number and branch", async () => {
    const sb = makeSupabase();
    sb._rows.push({ task_id: "42", worker_id: "w1", pr_number: null, branch: null });
    const store = createTaskAssignmentStore(sb as never);
    const rows = await store.listAssignments();
    expect(rows[0]).toEqual({ taskId: "42", workerId: "w1", prNumber: null, branch: null });
  });
});

describe("createNullTaskAssignmentStore", () => {
  it("upsertAssignment resolves without error", async () => {
    const store = createNullTaskAssignmentStore();
    await expect(store.upsertAssignment("42", "w1")).resolves.toBeUndefined();
  });

  it("deleteAssignment resolves without error", async () => {
    const store = createNullTaskAssignmentStore();
    await expect(store.deleteAssignment("42")).resolves.toBeUndefined();
  });

  it("updatePr resolves without error", async () => {
    const store = createNullTaskAssignmentStore();
    await expect(store.updatePr("42", 10, "fix")).resolves.toBeUndefined();
  });

  it("listAssignments returns empty array", async () => {
    const store = createNullTaskAssignmentStore();
    expect(await store.listAssignments()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- tests/db.assignments.test.ts 2>&1 | tail -20
```

Expected: error importing `createTaskAssignmentStore` (not yet exported).

- [ ] **Step 3: Implement TaskAssignmentStore in src/db.ts**

Add to the end of `src/db.ts` (before the closing, after `createNullDbLogger`):

```typescript
// ── TaskAssignmentStore ────────────────────────────────────────────────────────

export interface TaskAssignmentRow {
  taskId: string;
  workerId: string;
  prNumber: number | null;
  branch: string | null;
}

export interface TaskAssignmentStore {
  /** Insert or replace the assignment row for this task. */
  upsertAssignment(taskId: string, workerId: string): Promise<void>;
  /** Update the assignment row with PR number and branch (called when PR opened). */
  updatePr(taskId: string, prNumber: number, branch: string | null): Promise<void>;
  /** Delete the assignment row (task complete, or reverted to pending). */
  deleteAssignment(taskId: string): Promise<void>;
  /** Load all persisted assignments at startup. */
  listAssignments(): Promise<TaskAssignmentRow[]>;
}

export function createTaskAssignmentStore(supabase: SupabaseClient): TaskAssignmentStore {
  return {
    async upsertAssignment(taskId, workerId) {
      const { error } = await supabase.from("task_assignments").upsert(
        { task_id: taskId, worker_id: workerId, updated_at: new Date().toISOString() },
        { onConflict: "task_id" },
      );
      if (error) throw error;
    },

    async updatePr(taskId, prNumber, branch) {
      const { error } = await supabase.from("task_assignments")
        .update({ pr_number: prNumber, branch, updated_at: new Date().toISOString() })
        .eq("task_id", taskId);
      if (error) throw error;
    },

    async deleteAssignment(taskId) {
      const { error } = await supabase.from("task_assignments")
        .delete()
        .eq("task_id", taskId);
      if (error) throw error;
    },

    async listAssignments() {
      const { data, error } = await supabase.from("task_assignments")
        .select("task_id, worker_id, pr_number, branch");
      if (error) throw error;
      return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        taskId: row.task_id as string,
        workerId: row.worker_id as string,
        prNumber: (row.pr_number as number | null) ?? null,
        branch: (row.branch as string | null) ?? null,
      }));
    },
  };
}

export function createNullTaskAssignmentStore(): TaskAssignmentStore {
  return {
    async upsertAssignment() {},
    async updatePr() {},
    async deleteAssignment() {},
    async listAssignments() { return []; },
  };
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
npm test -- tests/db.assignments.test.ts 2>&1 | tail -20
```

Expected: all tests PASS.

- [ ] **Step 5: Run full test suite to check for regressions**

```bash
npm test 2>&1 | tail -20
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts tests/db.assignments.test.ts
git commit -m "feat: add TaskAssignmentStore to db.ts"
```

---

### Task 3: tryAssignWork — async with DB-before-send

**Files:**
- Modify: `src/foreman.ts` (the `tryAssignWork` function inside `createForemanWss`)
- Modify: `src/foreman.ts` (the options accepted by `createForemanWss`)
- Create: `tests/foreman.startup.test.ts`

The `createForemanWss` options need a new field:
```typescript
assignStore?: TaskAssignmentStore;
```

`tryAssignWork` needs to become async. It must:
1. Reserve task in memory first (to prevent races in `reconcile` loop)
2. Await the DB write
3. Send `task_assigned` only after DB write succeeds
4. Revert in-memory state and send `standby` if DB write fails

- [ ] **Step 1: Write failing test for DB write before task_assigned**

Create `tests/foreman.startup.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskQueue, WorkerRegistry, createForemanWss } from "../src/foreman.js";
import type { TaskAssignmentStore, TaskAssignmentRow } from "../src/db.js";
import WebSocket, { WebSocketServer } from "ws";
import http from "http";

function makeStore(overrides: Partial<TaskAssignmentStore> = {}): TaskAssignmentStore {
  return {
    upsertAssignment: vi.fn().mockResolvedValue(undefined),
    updatePr: vi.fn().mockResolvedValue(undefined),
    deleteAssignment: vi.fn().mockResolvedValue(undefined),
    listAssignments: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeEnv() {
  const taskQueue = new TaskQueue();
  const registry = new WorkerRegistry();
  const server = http.createServer();
  return { taskQueue, registry, server };
}

async function connectWorker(server: http.Server, port: number, msg: object): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}/worker`);
    ws.on("open", () => {
      ws.send(JSON.stringify(msg));
      resolve(ws);
    });
  });
}

async function waitForMessage(ws: WebSocket): Promise<object> {
  return new Promise((resolve) => {
    ws.on("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

describe("tryAssignWork — DB persistence", () => {
  it("calls upsertAssignment before sending task_assigned", async () => {
    const { taskQueue, registry, server } = makeEnv();
    const callOrder: string[] = [];
    const store = makeStore({
      upsertAssignment: vi.fn().mockImplementation(async () => {
        callOrder.push("db");
      }),
    });

    taskQueue.addTask({
      taskId: "42",
      issueNumber: 42,
      title: "Test task",
      body: "body",
      labels: [],
      repoUrl: "https://github.com/test/repo",
    });

    const { reconcile, startupDisconnected } = createForemanWss(taskQueue, registry, server, {
      taskLabel: "brunel:ready",
      assignStore: store,
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const ws = await connectWorker(server, port, {
      type: "worker_hello",
      workerId: "w1",
      status: "idle",
    });

    const msgPromise = waitForMessage(ws);
    callOrder.push("before-wait");
    const msg = await msgPromise;

    expect(msg).toMatchObject({ type: "task_assigned", taskId: "42" });
    // DB write must have been called
    expect(store.upsertAssignment).toHaveBeenCalledWith("42", "w1");
    // DB write must happen before task_assigned is sent
    expect(callOrder.indexOf("db")).toBeLessThan(callOrder.indexOf("before-wait"));

    ws.close();
    await new Promise<void>((resolve) => server.close(resolve));
  });

  it("sends standby and reverts task if DB write fails", async () => {
    const { taskQueue, registry, server } = makeEnv();
    const store = makeStore({
      upsertAssignment: vi.fn().mockRejectedValue(new Error("db down")),
    });

    taskQueue.addTask({
      taskId: "42",
      issueNumber: 42,
      title: "Test task",
      body: "body",
      labels: [],
      repoUrl: "https://github.com/test/repo",
    });

    createForemanWss(taskQueue, registry, server, {
      taskLabel: "brunel:ready",
      assignStore: store,
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const ws = await connectWorker(server, port, {
      type: "worker_hello",
      workerId: "w1",
      status: "idle",
    });

    const msg = await waitForMessage(ws);
    expect(msg).toMatchObject({ type: "standby" });
    // Task should be reverted to pending
    expect(taskQueue.get("42")?.status).toBe("pending");

    ws.close();
    await new Promise<void>((resolve) => server.close(resolve));
  });
});

describe("startup assignment loading", () => {
  it("startupDisconnected map can be populated and causes idle reconnect to revert task", async () => {
    const { taskQueue, registry, server } = makeEnv();
    const store = makeStore();

    // Simulate a task that was assigned before restart
    taskQueue.addTask({
      taskId: "42",
      issueNumber: 42,
      title: "Test",
      body: "",
      labels: [],
      repoUrl: "",
    });
    taskQueue.assignTask("42", "w1"); // mark as assigned (as startup loading would do)

    const { reconcile, startupDisconnected } = createForemanWss(taskQueue, registry, server, {
      taskLabel: "brunel:ready",
      assignStore: store,
    });

    // Simulate startup: populate the disconnected map
    startupDisconnected.set("w1", "42");

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    // Worker reconnects as idle (it lost its session)
    const ws = await connectWorker(server, port, {
      type: "worker_hello",
      workerId: "w1",
      status: "idle",
    });

    const msg = await waitForMessage(ws);
    // Task should be reverted and worker gets standby (no other pending task for it)
    expect(msg).toMatchObject({ type: "standby" });
    expect(taskQueue.get("42")?.status).toBe("pending");
    expect(store.deleteAssignment).toHaveBeenCalledWith("42");

    ws.close();
    await new Promise<void>((resolve) => server.close(resolve));
  });

  it("busy worker reconnect removes from startupDisconnected and reclaims task", async () => {
    const { taskQueue, registry, server } = makeEnv();
    const store = makeStore();

    taskQueue.addTask({
      taskId: "42",
      issueNumber: 42,
      title: "Test",
      body: "",
      labels: [],
      repoUrl: "",
    });
    taskQueue.assignTask("42", "w1");

    const { startupDisconnected } = createForemanWss(taskQueue, registry, server, {
      taskLabel: "brunel:ready",
      assignStore: store,
    });

    startupDisconnected.set("w1", "42");

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const ws = await connectWorker(server, port, {
      type: "worker_hello",
      workerId: "w1",
      status: "busy",
      taskId: "42",
    });

    // After reclaim, no more messages immediately — task stays assigned
    await new Promise((r) => setTimeout(r, 50));
    expect(taskQueue.get("42")?.status).toBe("assigned");
    expect(taskQueue.get("42")?.assignedWorkerId).toBe("w1");
    expect(startupDisconnected.has("w1")).toBe(false); // cleared

    ws.close();
    await new Promise<void>((resolve) => server.close(resolve));
  });
});

describe("PR tracking persistence", () => {
  it("calls updatePr when PR opened event is routed", async () => {
    const { taskQueue, registry, server } = makeEnv();
    const store = makeStore();

    taskQueue.addTask({
      taskId: "42",
      issueNumber: 42,
      title: "Test",
      body: "",
      labels: [],
      repoUrl: "",
    });
    taskQueue.assignTask("42", "w1");

    const { routeEventToWorker } = createForemanWss(taskQueue, registry, server, {
      taskLabel: "brunel:ready",
      assignStore: store,
    });

    routeEventToWorker("evt-1", "pull_request", {
      action: "opened",
      pull_request: {
        number: 10,
        body: "Fixes #42\n\nSome work.",
        head: { ref: "fix-issue-42" },
      },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(store.updatePr).toHaveBeenCalledWith("42", 10, "fix-issue-42");
  });
});

describe("task_complete deletes DB row", () => {
  it("calls deleteAssignment when task_complete received", async () => {
    const { taskQueue, registry, server } = makeEnv();
    const store = makeStore();

    taskQueue.addTask({
      taskId: "42",
      issueNumber: 42,
      title: "Test",
      body: "",
      labels: [],
      repoUrl: "",
    });
    taskQueue.assignTask("42", "w1");

    createForemanWss(taskQueue, registry, server, {
      taskLabel: "brunel:ready",
      assignStore: store,
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    // First, worker connects as busy and reclaims
    const ws = await connectWorker(server, port, {
      type: "worker_hello",
      workerId: "w1",
      status: "busy",
      taskId: "42",
    });
    await new Promise((r) => setTimeout(r, 50));

    // Then sends task_complete
    ws.send(JSON.stringify({ type: "task_complete", workerId: "w1", taskId: "42" }));
    await new Promise((r) => setTimeout(r, 50));

    expect(store.deleteAssignment).toHaveBeenCalledWith("42");

    ws.close();
    await new Promise<void>((resolve) => server.close(resolve));
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- tests/foreman.startup.test.ts 2>&1 | tail -30
```

Expected: tests fail (no `startupDisconnected` return value, `tryAssignWork` not using `assignStore`).

- [ ] **Step 3: Add `assignStore` and `startupDisconnected` to `createForemanWss`**

In `src/foreman.ts`, update the options type for `createForemanWss`:

```typescript
export function createForemanWss(
  taskQueue: TaskQueue,
  registry: WorkerRegistry,
  server: http.Server,
  options: {
    taskLabel: string;
    labelDone?: (issueNumber: number) => Promise<void>;
    graph?: DependencyGraph;
    openIssues?: Set<number>;
    repo?: string;
    token?: string;
    dbLogger?: DbLogger;
    adminWss?: AdminWss;
    workerSecret?: string;
    labeledIssues?: Map<number, LabeledIssueState>;
    pingIntervalMs?: number;
    assignStore?: TaskAssignmentStore;
  },
): { wss: WebSocketServer; routeEventToWorker: (id: string, name: string, payload: unknown) => void; reconcile: () => void; startupDisconnected: Map<string, string> } {
```

Also add the import at the top of `createForemanWss`:
```typescript
import type { TaskAssignmentStore } from "./db.js";
```

And extract `assignStore` from options inside `createForemanWss`:
```typescript
const assignStore: TaskAssignmentStore = options.assignStore ?? createNullTaskAssignmentStoreInline();
```

Since we can't do a top-level import of `createNullTaskAssignmentStore` (circular?), we inline a minimal null store:
```typescript
const assignStore: import("./db.js").TaskAssignmentStore = options.assignStore ?? {
  async upsertAssignment() {},
  async updatePr() {},
  async deleteAssignment() {},
  async listAssignments() { return []; },
};
```

And create the `startupDisconnected` map:
```typescript
const startupDisconnected = new Map<string, string>(); // workerId → taskId
```

Return it:
```typescript
return { wss, routeEventToWorker: routeEvent, reconcile, startupDisconnected };
```

- [ ] **Step 4: Make `tryAssignWork` async with DB-before-send**

Replace the existing `tryAssignWork` function inside `createForemanWss`:

```typescript
async function tryAssignWork(workerId: string): Promise<void> {
  const task = taskQueue.nextPending(
    (t) => t.depsLoaded && !isBlocked(t.issueNumber, graph, openIssues),
  );
  if (task) {
    // Reserve in memory first to prevent concurrent double-assignment in reconcile loop.
    taskQueue.assignTask(task.taskId, workerId);
    registry.assignTask(workerId, task.taskId);
    broadcastSnapshot();

    // Persist to DB before sending task_assigned to the worker.
    try {
      await assignStore.upsertAssignment(task.taskId, workerId);
    } catch (err) {
      flog(`ERROR Failed to persist assignment for task #${task.taskId}: ${err}`);
      // Revert in-memory state — worker gets standby instead.
      taskQueue.revertTask(task.taskId);
      registry.releaseWorker(workerId);
      broadcastSnapshot();
      const standbyMsg: ForemanMessage = { type: "standby" };
      registry.send(workerId, standbyMsg);
      dbLogger?.logForemanMessage({ direction: "sent", workerId, taskId: null, msgType: standbyMsg.type, payload: standbyMsg as unknown as Record<string, unknown> });
      log(workerId, "→ standby (DB write failed)");
      return;
    }

    const queued = taskQueue.drainEvents(task.taskId);
    const assignMsg: ForemanMessage = {
      type: "task_assigned",
      taskId: task.taskId,
      issue: {
        number: task.issueNumber,
        title: task.title,
        body: task.body,
        labels: task.labels,
        repoUrl: task.repoUrl,
      },
    };
    registry.send(workerId, assignMsg);
    dbLogger?.logForemanMessage({ direction: "sent", workerId, taskId: task.taskId, msgType: assignMsg.type, payload: assignMsg as unknown as Record<string, unknown> });
    log(workerId, `→ task_assigned #${task.issueNumber} "${task.title}"`);
    for (const evt of queued) {
      const evtMsg: ForemanMessage = { type: "event_notification", taskId: task.taskId, event: evt };
      registry.send(workerId, evtMsg);
      dbLogger?.logForemanMessage({ direction: "sent", workerId, taskId: task.taskId, msgType: evtMsg.type, payload: evtMsg as unknown as Record<string, unknown> });
      log(workerId, `→ event_notification #${task.issueNumber} ${evt.name} (queued)`);
    }
  } else {
    const standbyMsg: ForemanMessage = { type: "standby" };
    registry.send(workerId, standbyMsg);
    dbLogger?.logForemanMessage({ direction: "sent", workerId, taskId: null, msgType: standbyMsg.type, payload: standbyMsg as unknown as Record<string, unknown> });
    log(workerId, "→ standby");
  }
}
```

All callers of `tryAssignWork` must handle the returned Promise:
- In `handleWorkerHello` idle path: `tryAssignWork(workerId).catch(err => flog(`ERROR: ${err}`));`
- In `handleTaskComplete`: `tryAssignWork(workerId).catch(err => flog(`ERROR: ${err}`));`
- In `reconcile` loop: `tryAssignWork(w.workerId).catch(err => flog(`ERROR tryAssignWork: ${err}`));`

- [ ] **Step 5: Run tests**

```bash
npm test -- tests/foreman.startup.test.ts 2>&1 | tail -30
```

Expected: "DB persistence" tests PASS; startup reconnect tests still failing (not yet implemented).

- [ ] **Step 6: Run full test suite**

```bash
npm test 2>&1 | tail -20
```

Expected: all existing tests PASS (no regressions from async tryAssignWork).

- [ ] **Step 7: Commit**

```bash
git add src/foreman.ts tests/foreman.startup.test.ts
git commit -m "feat: make tryAssignWork async with DB-before-send ordering"
```

---

### Task 4: Idle Reconnect — revert task and delete DB row

**Files:**
- Modify: `src/foreman.ts` (`handleWorkerHello` idle path, `handleTaskComplete`)

The idle path must check the `startupDisconnected` map first (for post-restart reconnects), then the existing registry check (for mid-session reconnects). Both paths must delete the DB row.

The `handleTaskComplete` must delete the DB row.

- [ ] **Step 1: Update `handleWorkerHello` idle path**

Inside `handleWorkerHello` in `src/foreman.ts`, replace the existing `else` block (idle worker path):

```typescript
} else {
  // Check if this worker had an assignment before the last foreman restart.
  const startupTaskId = startupDisconnected.get(workerId);
  if (startupTaskId) {
    startupDisconnected.delete(workerId);
    taskQueue.revertTask(startupTaskId);
    assignStore.deleteAssignment(startupTaskId).catch(err =>
      flog(`ERROR Failed to delete assignment for #${startupTaskId}: ${err}`)
    );
    log(workerId, `hello idle (startup assignment for task #${startupTaskId}) — reverting to pending`);
  } else {
    // Mid-session reconnect: check registry for an in-session disconnected assignment.
    const existing = registry.get(workerId);
    if (existing?.currentTaskId) {
      log(workerId, `hello idle (had task #${existing.currentTaskId}) — reverting task to pending`);
      taskQueue.revertTask(existing.currentTaskId);
      assignStore.deleteAssignment(existing.currentTaskId).catch(err =>
        flog(`ERROR Failed to delete assignment for #${existing.currentTaskId}: ${err}`)
      );
    } else {
      log(workerId, "hello idle");
    }
  }
  registry.register(workerId, ws, "idle");
  broadcastSnapshot();
  tryAssignWork(workerId).catch(err => flog(`ERROR tryAssignWork: ${err}`));
}
```

- [ ] **Step 2: Clear startupDisconnected in busy reconnect path**

Inside `handleWorkerHello` busy path, add at the top of the `if (msg.status === "busy" && msg.taskId)` block:

```typescript
if (msg.status === "busy" && msg.taskId) {
  // Clear from startup map — worker is reclaiming.
  startupDisconnected.delete(workerId);
  const existing = taskQueue.get(msg.taskId);
  ...
```

- [ ] **Step 3: Update `handleTaskComplete` to delete DB row**

Replace `handleTaskComplete`:

```typescript
function handleTaskComplete(msg: Extract<WorkerMessage, { type: "task_complete" }>) {
  log(workerId, `task_complete #${msg.taskId}`);
  const task = taskQueue.get(msg.taskId);
  if (task) {
    taskQueue.completeTask(msg.taskId);
    assignStore.deleteAssignment(msg.taskId).catch(err =>
      flog(`ERROR Failed to delete assignment for #${msg.taskId}: ${err}`)
    );
    labelDone(task.issueNumber).catch(err =>
      flog(`ERROR Failed to label issue done: ${err}`)
    );
  }
  registry.releaseWorker(workerId);
  broadcastSnapshot();
  tryAssignWork(workerId).catch(err => flog(`ERROR tryAssignWork: ${err}`));
}
```

- [ ] **Step 4: Run startup tests**

```bash
npm test -- tests/foreman.startup.test.ts 2>&1 | tail -30
```

Expected: all startup tests PASS.

- [ ] **Step 5: Run full test suite**

```bash
npm test 2>&1 | tail -20
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/foreman.ts
git commit -m "feat: revert tasks and delete DB rows on idle reconnect and task complete"
```

---

### Task 5: PR Tracking — persist pr_number and branch to DB

**Files:**
- Modify: `src/foreman.ts` (`doRouteEvent` PR opened path)

When a PR opened event links an issue, the DB row for that task should be updated with the PR number and branch so they can be restored on restart.

- [ ] **Step 1: Update the PR opened path in `doRouteEvent`**

In `src/foreman.ts`, inside `doRouteEvent`, find the `if (p.action === "opened" && pr)` block:

```typescript
if (p.action === "opened" && pr) {
  const linkedIssue = extractLinkedIssueNumber(String(pr.body ?? ""));
  if (linkedIssue !== null) {
    const linkedTask = taskQueue.getTaskForIssue(linkedIssue);
    if (linkedTask) {
      taskQueue.registerPr(prNumber, linkedTask.taskId);
      const branch = strProp(pr.head, "ref");
      if (branch) taskQueue.registerBranch(branch, linkedTask.taskId);
      // Persist PR number and branch to DB so routing survives restart.
      assignStore.updatePr(linkedTask.taskId, prNumber, branch ?? null).catch(err =>
        flog(`ERROR Failed to update PR for task #${linkedTask.taskId}: ${err}`)
      );
      flog(`[task #${linkedIssue}] PR #${prNumber} registered`);
      return result(linkedTask);
    }
  }
  return result(null);
}
```

- [ ] **Step 2: Run startup tests**

```bash
npm test -- tests/foreman.startup.test.ts 2>&1 | tail -20
```

Expected: "PR tracking persistence" test PASS.

- [ ] **Step 3: Run full test suite**

```bash
npm test 2>&1 | tail -20
```

Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/foreman.ts
git commit -m "feat: persist PR number and branch to task_assignments on PR opened"
```

---

### Task 6: Startup Sequence — load before server.listen

**Files:**
- Modify: `src/foreman.ts` (main block / `if (isMain)` section)

The startup sequence must be complete before accepting WebSocket connections:
1. Load issues from GitHub (`loadIssuesToQueue`)
2. Call `reconcile()` to materialize tasks as pending
3. Load assignments from DB (`assignStore.listAssignments`)
4. For each row: if task exists → mark assigned + rebuild routing + add to `startupDisconnected`; if task not found → delete orphan row
5. Then call `server.listen`

This requires the `createForemanWss` call to happen BEFORE the DB loading so `reconcile` and `startupDisconnected` are available. The restructured main block:

```typescript
// 1. Setup DB logger and assignStore
let dbLogger: DbLogger;
let assignStore: TaskAssignmentStore;
if (config.supabaseUrl && config.supabaseSecretKey) {
  const { createClient } = await import("@supabase/supabase-js");
  const { createDbLogger, createTaskAssignmentStore } = await import("./db.js");
  const supabase = createClient(config.supabaseUrl, config.supabaseSecretKey);
  dbLogger = createDbLogger(supabase);
  assignStore = createTaskAssignmentStore(supabase);
  flog("Supabase logging enabled");
} else {
  const { createNullDbLogger, createNullTaskAssignmentStore } = await import("./db.js");
  dbLogger = createNullDbLogger();
  assignStore = createNullTaskAssignmentStore();
}

// 2. Create server and WSS (routeEvent/reconcile/startupDisconnected available after this)
const server = createHttpServer(webhooks, (id, name, payload) => routeEvent(id, name, payload), dbLogger);
const adminWss = ...;
({ routeEventToWorker: routeEvent, reconcile, startupDisconnected } = createForemanWss(..., { ..., assignStore }));

// 3. Load issues before listening
try {
  await loadIssuesToQueue(labeledIssues, graph, openIssues, { ... });
  reconcile();
} catch (err) {
  flog(`WARNING Failed to load issues from GitHub: ${err}`);
}

// 4. Load and apply task assignments
try {
  const assignments = await assignStore.listAssignments();
  for (const row of assignments) {
    const task = taskQueue.get(row.taskId);
    if (!task) {
      // Orphaned row — issue was closed or label removed; clean up.
      flog(`[startup] orphaned assignment for task #${row.taskId}, deleting`);
      assignStore.deleteAssignment(row.taskId).catch(err =>
        flog(`ERROR Failed to delete orphaned assignment: ${err}`)
      );
      continue;
    }
    // Seed in-memory state from DB.
    taskQueue.assignTask(row.taskId, row.workerId);
    if (row.prNumber !== null) taskQueue.registerPr(row.prNumber, row.taskId);
    if (row.branch) taskQueue.registerBranch(row.branch, row.taskId);
    startupDisconnected.set(row.workerId, row.taskId);
    flog(`[startup] loaded assignment: task #${row.taskId} → worker ${row.workerId.slice(0, 8)}`);
  }
} catch (err) {
  flog(`WARNING Failed to load task assignments: ${err}`);
}

// 5. Now listen — all state is loaded
server.listen(config.port, () => {
  flog(`Listening on http://localhost:${config.port}/webhook`);
  flog(`WebSocket workers: ws://localhost:${config.port}/worker`);
  flog(`Admin WebSocket: ws://localhost:${config.port}/admin/ws`);
  flog("Waiting for events...");
});
```

- [ ] **Step 1: Write failing test for startup sequence**

Add to `tests/foreman.startup.test.ts`:

```typescript
describe("startup: full loading sequence (integration sketch)", () => {
  it("tasks loaded from initialAssignments are marked assigned and not offered to new workers", async () => {
    // This test verifies that a task pre-seeded via startupDisconnected+assignTask
    // (simulating the startup loading) is not reassigned to a fresh idle worker.
    const { taskQueue, registry, server } = makeEnv();
    const store = makeStore();

    // Simulate loadIssuesToQueue + reconcile having run: task exists as pending.
    taskQueue.addTask({
      taskId: "42",
      issueNumber: 42,
      title: "Test",
      body: "",
      labels: [],
      repoUrl: "",
    });

    const { reconcile, startupDisconnected } = createForemanWss(taskQueue, registry, server, {
      taskLabel: "brunel:ready",
      assignStore: store,
    });

    // Simulate startup loading: mark task as assigned and register in disconnected map.
    taskQueue.assignTask("42", "original-worker");
    startupDisconnected.set("original-worker", "42");

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    // A different idle worker connects — should NOT get the assigned task.
    const ws = await connectWorker(server, port, {
      type: "worker_hello",
      workerId: "new-worker",
      status: "idle",
    });

    const msg = await waitForMessage(ws);
    expect(msg).toMatchObject({ type: "standby" });
    expect(taskQueue.get("42")?.status).toBe("assigned"); // still assigned to original-worker

    ws.close();
    await new Promise<void>((resolve) => server.close(resolve));
  });
});
```

- [ ] **Step 2: Run this test to confirm it passes** (it should pass already since `startupDisconnected` is returned and the task is marked assigned before the worker connects)

```bash
npm test -- tests/foreman.startup.test.ts 2>&1 | tail -20
```

Expected: all tests in this file PASS.

- [ ] **Step 3: Restructure main block in `src/foreman.ts`**

Replace the `if (isMain)` block with the restructured version described above (full code):

```typescript
if (isMain) {
  const config = await loadConfig(process.argv);
  setVerbose(config.verbose);

  const registry = new WorkerRegistry();
  const taskQueue = new TaskQueue();
  const graph: DependencyGraph = new Map();
  const openIssues = new Set<number>();
  const labeledIssues = new Map<number, LabeledIssueState>();
  const webhooks = config.webhookSecret
    ? new Webhooks({ secret: config.webhookSecret })
    : null;

  // Setup DB logger and assignment store
  let dbLogger: DbLogger;
  let assignStore: import("./db.js").TaskAssignmentStore;
  if (config.supabaseUrl && config.supabaseSecretKey) {
    const { createClient } = await import("@supabase/supabase-js");
    const { createDbLogger, createTaskAssignmentStore } = await import("./db.js");
    const supabase = createClient(config.supabaseUrl, config.supabaseSecretKey);
    dbLogger = createDbLogger(supabase);
    assignStore = createTaskAssignmentStore(supabase);
    flog("Supabase logging enabled");
  } else {
    const { createNullDbLogger, createNullTaskAssignmentStore } = await import("./db.js");
    dbLogger = createNullDbLogger();
    assignStore = createNullTaskAssignmentStore();
  }

  let routeEvent: (id: string, name: string, payload: unknown) => void = () => {};
  let reconcile: () => void = () => {};
  let startupDisconnected = new Map<string, string>();
  const server = createHttpServer(webhooks, (id, name, payload) => routeEvent(id, name, payload), dbLogger);

  const { createAdminWss } = await import("./admin-ws.js");
  const adminWss = createAdminWss(server, () => ({
    tasks: taskQueue.getTaskSnapshots(),
    workers: registry.getWorkerSnapshots(),
  }));

  ({ routeEventToWorker: routeEvent, reconcile, startupDisconnected } = createForemanWss(
    taskQueue, registry, server,
    {
      graph,
      openIssues,
      labeledIssues,
      taskLabel: config.taskLabel,
      repo: config.githubRepo,
      token: config.githubToken,
      dbLogger,
      adminWss,
      workerSecret: config.workerSecret,
      assignStore,
      labelDone: (issueNumber) =>
        labelIssueDone(issueNumber, {
          repo: config.githubRepo,
          token: config.githubToken,
          doneLabel: config.doneLabel,
        }),
    },
  ));

  if (webhooks) {
    webhooks.onAny(({ id, name, payload }) => {
      printEvent(id, name as string, payload);
      routeEvent(id, name as string, payload);
    });
  }

  // Load all state before accepting connections.
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

  try {
    const assignments = await assignStore.listAssignments();
    for (const row of assignments) {
      const task = taskQueue.get(row.taskId);
      if (!task) {
        flog(`[startup] orphaned assignment for task #${row.taskId}, deleting`);
        assignStore.deleteAssignment(row.taskId).catch(err =>
          flog(`ERROR Failed to delete orphaned assignment: ${err}`)
        );
        continue;
      }
      taskQueue.assignTask(row.taskId, row.workerId);
      if (row.prNumber !== null) taskQueue.registerPr(row.prNumber, row.taskId);
      if (row.branch) taskQueue.registerBranch(row.branch, row.taskId);
      startupDisconnected.set(row.workerId, row.taskId);
      flog(`[startup] loaded assignment: task #${row.taskId} → worker ${row.workerId.slice(0, 8)}`);
    }
  } catch (err) {
    flog(`WARNING Failed to load task assignments: ${err}`);
  }

  server.listen(config.port, () => {
    flog(`Listening on http://localhost:${config.port}/webhook`);
    flog(`WebSocket workers: ws://localhost:${config.port}/worker`);
    flog(`Admin WebSocket: ws://localhost:${config.port}/admin/ws`);
    flog("Waiting for events...");
  });
}
```

- [ ] **Step 4: Run full test suite**

```bash
npm test 2>&1 | tail -30
```

Expected: all tests PASS.

- [ ] **Step 5: Run type check**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/foreman.ts
git commit -m "feat: load task assignments before server.listen for restart recovery"
```

---

### Task 7: Final polish, smoke test, and PR

- [ ] **Step 1: Run linter**

```bash
npm run lint 2>&1 | head -30
```

Expected: no errors (fix any `no-floating-promises` issues by ensuring async calls have `.catch`).

- [ ] **Step 2: Run full test suite**

```bash
npm test 2>&1 | tail -30
```

Expected: all tests PASS, no skipped tests.

- [ ] **Step 3: Run smoke test**

```bash
npm run smoke 2>&1 | tail -20
```

Expected: PASS (foreman and worker connect successfully).

- [ ] **Step 4: Push and open PR**

```bash
git push -u origin issue-309-persist-task-assignments
gh pr create \
  --title "feat: persist task assignments in Supabase to survive restarts" \
  --body "$(cat <<'EOF'
## Summary
- Adds `task_assignments` Supabase table to persist foreman task assignments across restarts
- `TaskAssignmentStore` (real + null implementations) in `db.ts` for CRUD on the table
- `tryAssignWork` is now async: writes DB row before sending `task_assigned` to prevent double-assignment if foreman crashes mid-send
- Startup sequence loads assignments before `server.listen`: seeds `startupDisconnected` map, rebuilds `prToTaskId`/`branchToTaskId` routing, marks tasks as assigned
- Workers reconnecting idle after restart have their prior task reverted to pending (and DB row deleted); workers reconnecting busy reclaim their task as before
- PR opened events persist `pr_number`/`branch` to the assignment row for routing recovery

Closes #309

## Test plan
- [ ] `npm test` passes (new tests in `tests/db.assignments.test.ts` and `tests/foreman.startup.test.ts`)
- [ ] `npm run smoke` passes
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run lint` passes
EOF
)"
```
