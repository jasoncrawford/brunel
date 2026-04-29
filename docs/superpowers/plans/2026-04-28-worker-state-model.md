# Worker & Workspace State Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ad-hoc worker/workspace lifecycle management with an explicit three-state worker model (stopped / waiting / active) and an orthogonal two-state workspace model (absent / present), eliminating the bug class where code paths reaching the same logical state produce inconsistent side-effects.

**Architecture:** `WorkerController` gains `transitionToIdle()` as the canonical entry point for "worker is waiting for tasks" — every code path that reaches state 2 must call it and only it. `WorkspaceController` event listeners move to the constructor (registered once, forever). The routing loop in `index.ts` applies a unified keyboard rule: `^C`/`^D` at a visible prompt = quit, otherwise = interrupt or no-op. SIGTERM is wired to `onForceDestroy()` (skips confirmation). The redundant `cleanup()` / `isCleanupPending` pair is removed. This plan supersedes open PRs #906 and #913 and fixes issues #898, #901, #916, and the SIGTERM hang.

**Tech Stack:** TypeScript, Node.js, Vitest, ws (WebSocket)

---

## State Model Reference

**Worker states:**
- State 1 — stopped: not in worker mode, REPL prompt `>`
- State 2 — waiting: connected to foreman, no task assigned, no visible prompt
- State 3 — active: task assigned; either running an agent loop (no prompt) or at `[agent] >` prompt

**Workspace states** (orthogonal to worker):
- Absent: no checkout directory
- Present: checkout exists (`workspace.isCreated === true`)

**Keyboard rules:**
- At a visible prompt (`^C` or `^D`): quit — stop worker mode (with confirmation if task active), then exit process if `^D`/`/exit`
- Not at a visible prompt (`^C`): interrupt whatever is running (SIGINT handler handles agent loops; for state 2 the `__ctrl_c__` routing loop branch calls `stop()`)
- Not at a visible prompt (`^D`): ignored (no `_promptLine` set on `ask("")`)

**Workspace lifecycle:** created by `worker:start` (if absent) or `/workspace:create`; never destroyed automatically except on process exit (with confirmation) or SIGTERM (forced). Workspace persists across `worker:stop` / `worker:start` cycles.

---

## File Map

| File | What changes |
|---|---|
| `src/agent/models/workspace.ts` | Add `_ensureLocallyIgnored()`; call in `create()` and in `reset()` re-clone path |
| `src/agent/controllers/workspace-controller.ts` | Move all `workspace.on(…)` calls from `onCreate()` to constructor |
| `src/agent/controllers/worker-controller.ts` | Add `transitionToIdle()`; wire `hello_ack idle`, `hello_ack cancelled`, `repo_activated` to it; delete `cleanup()` and `isCleanupPending` |
| `src/agent/views/input.ts` | `^D` with no visible prompt (`_promptLine === ""`) is a no-op |
| `src/agent/index.ts` | `__ctrl_c__` always calls `stop()` when active; `__eof__` simplified; `/exit` command unified; SIGTERM uses `onForceDestroy()`; dead post-loop block removed |
| `tests/workspace.test.ts` | Tests for `_ensureLocallyIgnored` in `create()` and `reset()` re-clone path |
| `tests/repl.workspace.test.ts` | Double-listener regression test |
| `tests/worker.test.ts` | Tests for all `transitionToIdle()` call sites; `stop()` with active task; SIGTERM contract |

---

### Task 1: Workspace fixes — git exclude and event listener deduplication

Supersedes PR #906 and closes issue #901. Also fixes the re-clone path gap identified in review (PR #906 added `_ensureLocallyIgnored` to `create()` but missed the re-clone branch inside `reset()`).

**Files:**
- Modify: `src/agent/models/workspace.ts`
- Modify: `src/agent/controllers/workspace-controller.ts`
- Test: `tests/workspace.test.ts`
- Test: `tests/repl.workspace.test.ts`

- [x] **Step 1: Write failing tests**

Add to `tests/workspace.test.ts`, after the existing `// ── create ──` describe block:

```typescript
// ── create: git excludes ──────────────────────────────────────────────────────

describe("Workspace.create — git excludes", () => {
  it("adds .brunel.lock to .git/info/exclude after create", async () => {
    const ws = await makeWorkspace();
    const excludePath = path.join(ws.dir, ".git", "info", "exclude");
    expect(fs.existsSync(excludePath)).toBe(true);
    const lines = fs.readFileSync(excludePath, "utf8").split("\n").map(l => l.trim());
    expect(lines).toContain(".brunel.lock");
  });

  it("does not duplicate .brunel.lock in .git/info/exclude on repeated create", async () => {
    const ws = await makeWorkspace();
    await ws.create(); // second call — workspace dir already has .git
    const excludePath = path.join(ws.dir, ".git", "info", "exclude");
    const lines = fs.readFileSync(excludePath, "utf8").split("\n").map(l => l.trim()).filter(Boolean);
    expect(lines.filter(l => l === ".brunel.lock")).toHaveLength(1);
  });
});

// ── reset: re-clone path git excludes ────────────────────────────────────────

describe("Workspace.reset — re-clone path", () => {
  it("adds .brunel.lock to .git/info/exclude after a forced re-clone", async () => {
    let fetchCalls = 0;
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "fetch") {
        if (fetchCalls++ < 2) throw new Error("simulated network failure");
      }
      if (args[0] === "clone") {
        // Simulate git clone creating a minimal repo structure
        fs.mkdirSync(path.join(args[2], ".git", "info"), { recursive: true });
        fs.writeFileSync(path.join(args[2], "package.json"), "{}");
      }
      return "";
    });
    const ws = await makeWorkspace(exec);
    await ws.reset(); // fails twice, then re-clones
    const excludePath = path.join(ws.dir, ".git", "info", "exclude");
    expect(fs.existsSync(excludePath)).toBe(true);
    const lines = fs.readFileSync(excludePath, "utf8").split("\n").map(l => l.trim());
    expect(lines).toContain(".brunel.lock");
  });
});
```

Add to `tests/repl.workspace.test.ts`, before the `// ── workspace:prune ──` block:

```typescript
// ── constructor: event listener deduplication ─────────────────────────────────

describe("WorkspaceController constructor listeners", () => {
  it("prints 'Destroying workspace...' exactly once even when onCreate is called twice", async () => {
    const ws = makeWorkspace();
    ws.isCreated = true;
    const controller = new WorkspaceController(ws, testDisplay, testConfig);
    await controller.onCreate();
    await controller.onCreate(); // simulate stop → /worker:start again
    testDisplay.print.mockClear();
    ws.emit("destroy", { dir: WORKSPACE_DIR });
    const destroyMsgs = testDisplay.print.mock.calls
      .map(([l]: [string]) => stripAnsi(l))
      .filter((m: string) => m.includes("Destroying workspace"));
    expect(destroyMsgs).toHaveLength(1);
  });
});
```

- [x] **Step 2: Run tests — expect them to fail**

```bash
npm test -- workspace
```

Expected: FAIL — `_ensureLocallyIgnored` does not exist yet; double-listener test fails because two "Destroying workspace..." messages are printed.

- [x] **Step 3: Add `_ensureLocallyIgnored` to `workspace.ts`**

In `src/agent/models/workspace.ts`, add this method after `_npmInstall()`:

```typescript
private _ensureLocallyIgnored(pattern: string): void {
  const infoDir = path.join(this.dir, ".git", "info");
  fs.mkdirSync(infoDir, { recursive: true });
  const excludesPath = path.join(infoDir, "exclude");
  const existing = fs.existsSync(excludesPath) ? fs.readFileSync(excludesPath, "utf8") : "";
  const lines = existing.split("\n").map(l => l.trim());
  if (lines.includes(pattern)) return;
  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(excludesPath, sep + pattern + "\n");
}
```

In `create()`, after `fs.writeFileSync(path.join(this.dir, ".brunel.lock"), String(process.pid))`, add:

```typescript
this._ensureLocallyIgnored(".brunel.lock");
```

In `reset()`, the last `catch` block currently ends with:
```typescript
await this.exec(["clone", this.repoUrl, this.dir], undefined);
fs.writeFileSync(path.join(this.dir, ".brunel.lock"), String(process.pid));
await this._doReset();
```

Add `_ensureLocallyIgnored` after the lockfile write:
```typescript
await this.exec(["clone", this.repoUrl, this.dir], undefined);
fs.writeFileSync(path.join(this.dir, ".brunel.lock"), String(process.pid));
this._ensureLocallyIgnored(".brunel.lock");
await this._doReset();
```

- [x] **Step 4: Move event listeners to constructor in `workspace-controller.ts`**

Replace the entire constructor and `onCreate()` in `src/agent/controllers/workspace-controller.ts`:

```typescript
constructor(
  readonly workspace: Workspace | undefined,
  private display: WorkerDisplay,
  private config: { verbose: boolean },
) {
  if (!workspace) return;
  const { verbose } = config;
  workspace.on("create-start", () => {
    if (!verbose) display.print(c.sageGreen("Creating workspace..."));
  });
  workspace.on("clone-start", ({ repoUrl: url, dir }: { repoUrl: string; dir: string }) => {
    if (verbose) display.print(c.sageGreen(`Cloning ${url} → ${dir}`));
  });
  workspace.on("npm-install", ({ dir }: { dir: string }) => {
    if (verbose) display.print(c.sageGreen(`Installing dependencies in ${dir}`));
  });
  workspace.on("reset-start", ({ dir }: { dir: string }) => {
    display.print(c.sageGreen(verbose ? `Resetting ${dir}` : "Resetting workspace..."));
  });
  workspace.on("reset-retry", ({ error }: { dir: string; error: string }) => {
    display.print(c.amber(`Reset failed, retrying: ${error}`));
  });
  workspace.on("reset-reclone", ({ dir, error }: { dir: string; error: string; repoUrl: string }) => {
    display.print(c.amber(verbose ? `Reset failed again, re-cloning ${dir}: ${error}` : `Reset failed again, re-cloning: ${error}`));
  });
  workspace.on("destroy", ({ dir }: { dir: string }) => {
    display.print(c.sageGreen(verbose ? `Destroying ${dir}` : "Destroying workspace..."));
  });
  workspace.on("prune-start", ({ workspaceDir: dir }: { workspaceDir: string }) => {
    display.print(c.sageGreen(verbose ? `Pruning orphaned workspaces in ${dir}` : "Pruning orphaned workspaces..."));
  });
  workspace.on("prune-remove", ({ dir }: { dir: string }) => {
    display.print(c.darkGray(`  Removed: ${dir}`));
  });
}

/**
 * Create the workspace directory and change into it.
 * Event listeners are registered once in the constructor.
 * No-op if no workspace is configured.
 */
async onCreate(): Promise<void> {
  if (!this.workspace) return;
  await this.workspace.create();
  process.chdir(this.workspace.dir);
}
```

Delete the old block of `workspace.on(…)` calls that were inside the old `onCreate()`.

- [x] **Step 5: Run tests — expect them to pass**

```bash
npm test -- workspace
npx tsc --noEmit
```

Expected: all workspace tests pass, no type errors.

- [x] **Step 6: Commit**

```bash
git add src/agent/models/workspace.ts src/agent/controllers/workspace-controller.ts tests/workspace.test.ts tests/repl.workspace.test.ts
git commit -m "fix: deduplicate workspace event listeners; exclude .brunel.lock from git status in all paths"
```

---

### Task 2: Explicit `transitionToIdle()` — single entry point for worker state 2

Any transition into "waiting for tasks" must go through `transitionToIdle()`. Supersedes PR #913 and closes issue #898. Also fixes the missing message on `repo_activated` (which PR #913 missed).

**Files:**
- Modify: `src/agent/controllers/worker-controller.ts`
- Test: `tests/worker.test.ts`

- [x] **Step 1: Write failing tests**

Add a new describe block in `tests/worker.test.ts`, near the existing `hello_ack handshake` section:

```typescript
// ── transitionToIdle — single entry for state 2 ───────────────────────────────

function makeSessionWithPick(pickResult: number): { s: WorkerController; ws: FakeWs } {
  const ws = new FakeWs();
  const localWsFactory = vi.fn().mockReturnValue(ws);
  const s = new WorkerController(sb, display, undefined, undefined, "owner/repo", {
    wsFactory: localWsFactory,
    pickFn: async () => pickResult,
  });
  return { s, ws };
}

describe("transitionToIdle — Waiting for tasks message", () => {
  it("prints 'Waiting for tasks...' on hello_ack idle", () => {
    display.print.mockClear();
    sendMsg(fakeWs, { type: "hello_ack", workerId: AGENT_ID, status: "idle" });
    const printed = display.print.mock.calls.map(([l]: [string]) => stripAnsi(l)).join("\n");
    expect(printed).toContain("Waiting for tasks");
  });

  it("does NOT print 'Waiting for tasks...' on hello_ack busy", () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    session.takeNextPrompt();
    display.print.mockClear();
    sendMsg(fakeWs, { type: "hello_ack", workerId: AGENT_ID, status: "busy" });
    const printed = display.print.mock.calls.map(([l]: [string]) => stripAnsi(l)).join("\n");
    expect(printed).not.toContain("Waiting for tasks");
  });

  it("prints 'Waiting for tasks...' on hello_ack cancelled with no workspace", () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "42", issue });
    session.takeNextPrompt();
    display.print.mockClear();
    sendMsg(fakeWs, { type: "hello_ack", workerId: AGENT_ID, status: "cancelled" });
    const printed = display.print.mock.calls.map(([l]: [string]) => stripAnsi(l)).join("\n");
    expect(printed).toContain("Waiting for tasks");
  });

  it("prints 'Waiting for tasks...' on repo_activated", async () => {
    const { s, ws } = makeSessionWithPick(0); // 0 = "Yes, activate"
    await s.start();
    ws.emit("open");
    sendMsg(ws, { type: "hello_ack", workerId: AGENT_ID, status: "idle", repoStatus: "new" });
    await new Promise(r => setTimeout(r, 0)); // let async pick resolve
    display.print.mockClear();
    sendMsg(ws, { type: "repo_activated", workerId: AGENT_ID });
    await new Promise(r => setTimeout(r, 0));
    const printed = display.print.mock.calls.map(([l]: [string]) => stripAnsi(l)).join("\n");
    expect(printed).toContain("Waiting for tasks");
  });
});
```

- [x] **Step 2: Run failing tests**

```bash
npm test -- worker
```

Expected: FAIL — the idle, cancelled, and repo_activated tests fail because the message is not printed in the current code.

- [x] **Step 3: Add `transitionToIdle()` to `worker-controller.ts`**

Immediately after the existing `transitionToRegistered()` method, add:

```typescript
private transitionToIdle(): void {
  this.transitionToRegistered();
  this.display.print(c.sageGreen("Waiting for tasks..."));
}
```

- [x] **Step 4: Wire `hello_ack idle` to `transitionToIdle()`**

In the `hello_ack` handler, find the final `else` branch (currently calls `this.transitionToRegistered()` unconditionally):

```typescript
} else {
  // "idle" or "busy" with repoStatus 'active' (or no repoStatus for back-compat).
  this.transitionToRegistered();
}
```

Replace with:

```typescript
} else {
  // "idle" or "busy" with repoStatus 'active' (or no repoStatus for back-compat).
  if (msg.status === "idle") {
    this.transitionToIdle();
  } else {
    this.transitionToRegistered();
  }
}
```

- [x] **Step 5: Wire `hello_ack cancelled` to `transitionToIdle()`**

In the `cancelled` branch, find the block starting with `const workspace = this.workspaceController?.workspace`. Replace it with:

```typescript
const workspace = this.workspaceController?.workspace;
if (workspace?.isCreated) {
  // Defer the message until the reset finishes — a new task must not run
  // in a dirty workspace, and "Waiting for tasks..." would be misleading
  // while the reset is in progress.
  this._resetPromise = workspace.reset().then(() => {
    this.display.print(c.amber("Workspace reset."));
  }).catch((err: unknown) => {
    this.display.print(c.boldRed(`Workspace reset failed: ${err instanceof Error ? err.message : String(err)}`));
  }).finally(() => {
    this._resetPromise = null;
    this.display.print(c.sageGreen("Waiting for tasks..."));
  });
  this.transitionToRegistered(); // message is in .finally() above
} else {
  this.transitionToIdle(); // immediate
}
```

- [x] **Step 6: Wire `repo_activated` to `transitionToIdle()`**

Find the `repo_activated` handler:

```typescript
if (msg.type === "repo_activated") {
  this.transitionToRegistered();
  this.emit("prompts_ready");
  return;
}
```

Replace with:

```typescript
if (msg.type === "repo_activated") {
  this.transitionToIdle();
  this.emit("prompts_ready");
  return;
}
```

- [x] **Step 7: Run tests — expect them to pass**

```bash
npm test -- worker
npx tsc --noEmit
```

Expected: all worker tests pass, no type errors.

- [x] **Step 8: Commit**

```bash
git add src/agent/controllers/worker-controller.ts tests/worker.test.ts
git commit -m "refactor: add transitionToIdle() as canonical entry for worker waiting state"
```

---

### Task 3: Unified keyboard rules — `^C` at prompt quits, `^D` without prompt is ignored

Implements the keyboard contract from the state model. Closes issue #916. `^D` is ignored when no visible prompt is shown (state 2, `ask("")`). `^C` at the `[agent] >` prompt calls `stop()` — previously it did nothing. The `__eof__` and `/exit` handlers are simplified to always call `stop()` first.

**Files:**
- Modify: `src/agent/views/input.ts`
- Modify: `src/agent/index.ts`
- Test: `tests/worker.test.ts`

- [x] **Step 1: Write tests confirming `stop()` contract with active task**

These tests verify the behaviour that `^C` at a task prompt now triggers (calling `stop()` with a task active):

```typescript
// ── stop() with active task ───────────────────────────────────────────────────

describe("stop() with active task", () => {
  it("remains active if user cancels the quit confirmation", async () => {
    const ws = new FakeWs();
    const s = new WorkerController(sb, display, undefined, undefined, "owner/repo", {
      wsFactory: vi.fn().mockReturnValue(ws),
      pickFn: async () => 1, // last option = cancel
    });
    await s.start();
    sendMsg(ws, { type: "hello_ack", workerId: AGENT_ID, status: "idle" });
    sendMsg(ws, { type: "task_assigned", taskId: "99", issue: makeIssue() });
    s.takeNextPrompt();

    await s.stop();

    expect(s.isActive).toBe(true);
    expect(s.hasTask()).toBe(true);
  });

  it("stops and marks inactive if user confirms quit", async () => {
    const ws = new FakeWs();
    const s = new WorkerController(sb, display, undefined, undefined, "owner/repo", {
      wsFactory: vi.fn().mockReturnValue(ws),
      pickFn: async () => 0, // first option = confirm
    });
    await s.start();
    sendMsg(ws, { type: "hello_ack", workerId: AGENT_ID, status: "idle" });
    sendMsg(ws, { type: "task_assigned", taskId: "99", issue: makeIssue() });
    s.takeNextPrompt();

    await s.stop();

    expect(s.isActive).toBe(false);
  });
});
```

- [x] **Step 2: Run — expect them to pass already**

```bash
npm test -- worker
```

Expected: PASS — `stop()` already has this confirmation logic. These tests document the contract before we update the routing loop to use it.

- [x] **Step 3: Fix `^D` in `input.ts` — no-op when no visible prompt**

In `src/agent/views/input.ts`, find (around line 507):

```typescript
else if (ch === "\x04") { if (!this._buffer) this._exit(); else this._deleteForward(); }
```

Replace with:

```typescript
else if (ch === "\x04") { if (this._buffer) { this._deleteForward(); } else if (this._promptLine) { this._exit(); } }
```

When `ask("")` is called (state 2, worker idle with no task), `this._promptLine` is `""` — falsy — so `^D` does nothing. When `ask("\n[agent] > ")` or `ask("\n> ")` is active, `^D` with an empty buffer still submits `__eof__` as before.

- [x] **Step 4: Update `__ctrl_c__` handler in `index.ts`**

Find (around line 323):

```typescript
if (userInput === "__ctrl_c__") {
  if (workerController.isActive && !workerController.hasTask()) {
    await workerController.stop();
  }
  continue;
}
```

Replace with:

```typescript
if (userInput === "__ctrl_c__") {
  if (workerController.isActive) {
    await workerController.stop();
  }
  continue;
}
```

`stop()` already handles the task-quit confirmation dialog. Removing `!workerController.hasTask()` means `^C` at `[agent] >` (state 3 at prompt) now triggers the same flow as `/worker:stop`. State 3 with a running query never reaches this branch — `interrupt()` in the SIGINT handler handles that path.

- [x] **Step 5: Simplify `__eof__` handler in `index.ts`**

Find (around line 309):

```typescript
if (userInput === "__eof__") {
  if (!workerController.isActive) { await doExit(); break; }
  const taskInfo = workerController.getTaskQuitInfo();
  if (taskInfo) {
    const choice = await workerController.confirmTaskQuit(taskInfo);
    if (choice === "cancel") continue;
    if (choice === "complete-and-quit") await workerController.completeCurrentTask();
  }
  break;
}
```

Replace with:

```typescript
if (userInput === "__eof__") {
  if (workerController.isActive) {
    await workerController.stop();
    if (workerController.isActive) continue; // user cancelled — stay in loop
  }
  await doExit();
  break;
}
```

`stop()` already contains the task-completion confirmation. After `doExit()` pauses stdin, Node.js exits naturally.

- [x] **Step 6: Simplify the `/exit` command handler in `index.ts`**

Find the `/exit` registration (around line 178):

```typescript
registry.register("exit", {
  description: "Exit",
  handler: async () => {
    if (!workerController.isActive) { await doExit(); return "exit"; }
    const taskInfo = workerController.getTaskQuitInfo();
    if (taskInfo) {
      const choice = await workerController.confirmTaskQuit(taskInfo);
      if (choice === "cancel") return undefined;
      if (choice === "complete-and-quit") await workerController.completeCurrentTask();
    }
    return "exit";
  },
});
```

Replace with:

```typescript
registry.register("exit", {
  description: "Exit",
  handler: async () => {
    if (workerController.isActive) {
      await workerController.stop();
      if (workerController.isActive) return undefined; // user cancelled
    }
    await doExit();
    return "exit";
  },
});
```

- [x] **Step 7: Run all tests and smoke test**

```bash
npm test
npx tsc --noEmit
npm run smoke
```

Expected: all unit tests pass, smoke test passes (worker connects, receives and completes a task, exits cleanly).

- [x] **Step 8: Commit**

```bash
git add src/agent/views/input.ts src/agent/index.ts tests/worker.test.ts
git commit -m "fix: unify ^C/^D rules — ^D ignored when no prompt, ^C at prompt stops worker mode"
```

---

### Task 4: Teardown simplification and SIGTERM fix

Removes the now-redundant `cleanup()` / `isCleanupPending` pair from `WorkerController` (all exit paths now call `doExit()` explicitly in their handlers). Fixes SIGTERM to call `onForceDestroy()` instead of `onDestroy()` — the latter prompts for confirmation, which hangs when a signal arrives with no interactive user.

**Files:**
- Modify: `src/agent/controllers/worker-controller.ts`
- Modify: `src/agent/index.ts`
- Test: `tests/worker.test.ts`

- [x] **Step 1: Write a test documenting the SIGTERM contract**

```typescript
// ── onForceDestroy — skips confirmation ───────────────────────────────────────

describe("WorkspaceController.onForceDestroy", () => {
  it("destroys the workspace without calling checkSafety", async () => {
    const { WorkspaceController } = await import(
      "../src/agent/controllers/workspace-controller.js"
    );
    const mockWs = {
      dir: "/tmp/test",
      workspaceDir: "/tmp",
      sessionId: "s",
      originalCwd: "/",
      isCreated: true,
      on: vi.fn(),
      create: vi.fn(),
      confirm: vi.fn(),
      reset: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
      checkSafety: vi.fn(),
    } as unknown as import("../src/agent/models/workspace.js").Workspace;

    const wc = new WorkspaceController(mockWs, display, { verbose: false });
    await wc.onForceDestroy();

    expect(mockWs.destroy).toHaveBeenCalledOnce();
    expect(mockWs.checkSafety).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run — expect it to pass**

```bash
npm test -- worker
```

Expected: PASS — `onForceDestroy()` already skips `checkSafety`. This test locks in the contract so a future refactor can't accidentally add a confirmation prompt to the SIGTERM path.

- [x] **Step 3: Fix SIGTERM in `index.ts`**

Find (around line 146):

```typescript
process.on("SIGTERM", async () => {
  workerController.sendGoodbye();
  await doExit();
  process.exit(0);
});
```

`doExit()` calls `workspaceController.onDestroy()` → `confirmIfUnsafe()` → prompts the user. On SIGTERM there is no user; the process hangs until the orchestrator force-kills it. Replace with:

```typescript
process.on("SIGTERM", async () => {
  workerController.sendGoodbye();
  await workspaceController.onForceDestroy();
  process.stdout.write("\x1b[?2004l\r\n");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.exit(0);
});
```

- [x] **Step 4: Delete `cleanup()` from `worker-controller.ts`**

Delete the entire `cleanup()` method (currently lines ~386–394):

```typescript
// DELETE:
/** Run worker teardown: send goodbye, destroy workspace, tear down I/O. */
async cleanup(): Promise<void> {
  if (this._isActive) {
    this.sendGoodbye();
    await this.workspaceController?.onDestroy();
    process.stdout.write("\x1b[?2004l\r\n");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
```

- [x] **Step 5: Delete `isCleanupPending` getter from `worker-controller.ts`**

Delete these two lines (currently ~172–173):

```typescript
// DELETE:
/** True when a worker cleanup must run on exit (i.e., worker is active). */
get isCleanupPending(): boolean { return this._isActive; }
```

- [x] **Step 6: Inline the post-loop exit logic (replacing `isCleanupPending`/`cleanup()`) in `index.ts`**

After the `while (true)` loop in `BrunelAgent.start()`, delete:

```typescript
// DELETE:
// Worker mode post-loop: send goodbye, destroy workspace, tear down I/O, exit.
if (workerController.isCleanupPending) {
  await workerController.cleanup();
  process.exit(0);
}
```

This block is now unreachable: every `break` from the loop is preceded by `doExit()` (which pauses stdin), so Node.js exits naturally.

- [x] **Step 7: Run all tests, type-check, and smoke test**

```bash
npm test
npx tsc --noEmit
npm run smoke
```

Expected: all pass. If `tsc` reports `isCleanupPending` or `cleanup` still referenced somewhere, delete those references too.

- [x] **Step 8: Commit**

```bash
git add src/agent/controllers/worker-controller.ts src/agent/index.ts tests/worker.test.ts
git commit -m "refactor: remove cleanup()/isCleanupPending; wire SIGTERM to onForceDestroy"
```

---

## Self-Review

**Spec coverage:**

| Requirement | Task |
|---|---|
| Workspace event listeners registered once (never duplicated on worker restart) | 1 |
| `.brunel.lock` excluded from git status after `create()` | 1 |
| `.brunel.lock` excluded after `reset()` re-clone | 1 |
| Single canonical entry point for "waiting for tasks" | 2 |
| `hello_ack idle` → prints message | 2 |
| `hello_ack busy` → no message | 2 |
| `hello_ack cancelled` no workspace → immediate message | 2 |
| `hello_ack cancelled` with workspace → message after reset | 2 |
| `repo_activated` → prints message | 2 |
| `^D` with no visible prompt is ignored | 3 |
| `^C` at `[agent] >` prompt calls `stop()` (with confirmation if task active) | 3 |
| `^D` at any prompt calls `stop()` then exits | 3 |
| `/exit` uses same `stop()` flow as `^D` | 3 |
| SIGTERM uses `onForceDestroy()` — no confirmation hang | 4 |
| `cleanup()` / `isCleanupPending` removed | 4 |
| Dead post-loop block removed | 4 |

**Placeholder scan:** No TBD/TODO/placeholder language. All code blocks are complete.

**Type consistency:** `transitionToIdle()` is defined and used within `worker-controller.ts` only (Task 2). `onForceDestroy()` already exists on `WorkspaceController`; signature unchanged (Task 4). `cleanup()` and `isCleanupPending` are deleted in Task 4 — `tsc` will catch any remaining references.
