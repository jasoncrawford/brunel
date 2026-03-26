# Worker Isolated Checkouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each worker (and optionally the REPL) its own isolated git clone of the target repo, eliminating conflicts from the shared-worktree approach.

**Architecture:** A new `Workspace` class manages a single git checkout's full lifecycle (create, reset, destroy, prune). Workers create a workspace at startup and `process.chdir()` into it so Claude SDK runs in the right directory. Safety checks via `checkSafety()` + `confirmIfUnsafe()` protect against losing uncommitted/unpushed work on any destructive operation.

**Tech Stack:** TypeScript/ESM, Node.js `child_process.execFile`, `node:fs`, vitest

---

## File Map

| File | Change |
|------|--------|
| `src/workspace.ts` | **New** — `Workspace` class + `confirmIfUnsafe` helper |
| `src/templates.ts` | **Modify** — remove worktree instructions from prompts |
| `src/config.ts` | **Modify** — add `workspaceDir` config key |
| `src/input.ts` | **Modify** — add 4 new slash command types to `SlashCommandResult` and `DispatchResult` |
| `src/worker.ts` | **Modify** — `WorkerSession` gains workspace state + slash handlers; `workerMain` startup lifecycle |
| `src/repl.ts` | **Modify** — REPL `main()` gains session UUID + workspace slash handlers |
| `CLAUDE.md` | **Modify** — document `BRUNEL_WORKSPACE_DIR` |
| `tests/workspace.test.ts` | **New** — unit tests for `Workspace` |
| `tests/templates.test.ts` | **Modify** — update prompt assertions |
| `tests/config.test.ts` | **Modify** — add `workspaceDir` test |
| `tests/worker.test.ts` | **Modify** — add `afterTask` tests |
| `tests/repl.slash.test.ts` | **Modify** — add new command type assertions |
| `tests/repl.dispatch.test.ts` | **Modify** — add new command dispatch assertions |

---

## Task 1: Update prompts in `src/templates.ts`

**Files:**
- Modify: `src/templates.ts`
- Test: `tests/templates.test.ts`

- [ ] **Step 1: Update the failing tests first**

In `tests/templates.test.ts`, find the test that checks `buildInitialPrompt` and add assertions that the old worktree language is gone and the new language is present. Also add a test for the PR-closed event prompt.

Add these tests to `tests/templates.test.ts`:

```ts
it("does not mention worktree", () => {
  const p = buildInitialPrompt({
    number: 1, title: "T", body: "B", labels: [], repoUrl: "https://github.com/x/y",
  });
  expect(p).not.toContain("worktree");
  expect(p).toContain("Create a new branch for this task");
});
```

And at the bottom of the templates test file, add:

```ts
describe("pull_request closed event", () => {
  it("says delete the branch, not remove the worktree", () => {
    const event: GitHubEvent = {
      id: "e1",
      name: "pull_request",
      payload: { action: "closed", pull_request: { number: 7, merged: true } },
    };
    const result = buildEventPrompt([event]);
    expect(result).not.toContain("worktree");
    expect(result).toContain("delete the branch");
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npm test -- tests/templates.test.ts
```

Expected: failures on the new assertions.

- [ ] **Step 3: Update `src/templates.ts`**

In `buildInitialPrompt`, replace:

```ts
2. Create a new branch and an isolated worktree for this task. Make no changes in the main workspace, only in the worktree.
```

With:

```ts
2. Create a new branch for this task.
```

In the `pull_request` event handler inside `EVENT_FMT`, replace:

```ts
return `PR #${prNumber} was ${pr?.merged ? 'merged' : 'closed without merging'}. Please remove your worktree and delete the branch.
```

With:

```ts
return `PR #${prNumber} was ${pr?.merged ? 'merged' : 'closed without merging'}. Please delete the branch.
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npm test -- tests/templates.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/templates.ts tests/templates.test.ts
git commit -m "feat: remove worktree instructions from agent prompts"
```

---

## Task 2: Add `workspaceDir` to config

**Files:**
- Modify: `src/config.ts`
- Modify: `CLAUDE.md`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write a failing test**

In `tests/config.test.ts`, add `"BRUNEL_WORKSPACE_DIR"` to the `ENV_KEYS` array, then add this test:

```ts
it("reads workspaceDir from BRUNEL_WORKSPACE_DIR env var", async () => {
  process.env.BRUNEL_GITHUB_REPO = "owner/repo";
  process.env.BRUNEL_GITHUB_TOKEN = "tok";
  process.env.BRUNEL_WORKSPACE_DIR = "/custom/workspace";
  const config = await loadConfig([]);
  expect(config.workspaceDir).toBe("/custom/workspace");
});

it("defaults workspaceDir to undefined when not set", async () => {
  process.env.BRUNEL_GITHUB_REPO = "owner/repo";
  process.env.BRUNEL_GITHUB_TOKEN = "tok";
  const config = await loadConfig([]);
  expect(config.workspaceDir).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- tests/config.test.ts
```

Expected: failures on new assertions (property doesn't exist yet).

- [ ] **Step 3: Add `workspaceDir` to the schema in `src/config.ts`**

In the `BrunelConfigSchema` object, after the `foremanUrl` line, add:

```ts
/** Base directory for worker checkout directories. Defaults to ~/.brunel/workers at runtime. */
workspaceDir: z.string().optional(),
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/config.test.ts
```

Expected: all pass.

- [ ] **Step 5: Document in `CLAUDE.md`**

In `CLAUDE.md`, in the optional config section, add after the `BRUNEL_VERBOSE` line:

```
- `BRUNEL_WORKSPACE_DIR` — base directory for worker checkout directories (default: `~/.brunel/workers`)
```

- [ ] **Step 6: Commit**

```bash
git add src/config.ts CLAUDE.md tests/config.test.ts
git commit -m "feat: add workspaceDir config key"
```

---

## Task 3: `src/workspace.ts` — `Workspace.create()` and `destroy()`

**Files:**
- Create: `src/workspace.ts`
- Create: `tests/workspace.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/workspace.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Workspace } from "../src/workspace.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const BASE_DIR = path.join(os.tmpdir(), `brunel-test-${process.pid}`);
const WORKER_ID = "test-worker-abc";
const REPO_URL = "https://token@github.com/owner/repo.git";

function makeExec(responses: Record<string, string> = {}) {
  return vi.fn().mockImplementation(async (args: string[]) => {
    const key = args.join(" ");
    return responses[key] ?? "";
  });
}

beforeEach(() => {
  fs.mkdirSync(BASE_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(BASE_DIR, { recursive: true, force: true });
});

// ── create ─────────────────────────────────────────────────────────────────

describe("Workspace.create", () => {
  it("runs git clone when directory does not exist", async () => {
    const exec = makeExec();
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    expect(exec).toHaveBeenCalledWith(
      ["clone", REPO_URL, path.join(BASE_DIR, WORKER_ID)],
      undefined,
    );
    expect(ws.dir).toBe(path.join(BASE_DIR, WORKER_ID));
  });

  it("skips git clone if directory already exists", async () => {
    const workerDir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(workerDir);
    const exec = makeExec();
    await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    expect(exec).not.toHaveBeenCalledWith(
      expect.arrayContaining(["clone"]),
      expect.anything(),
    );
  });

  it("writes a PID lockfile containing the current PID", async () => {
    const exec = makeExec();
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    // create() only writes the lockfile when cloning (dir didn't exist before)
    const lockPath = path.join(ws.dir, ".brunel.lock");
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
  });
});

// ── destroy ────────────────────────────────────────────────────────────────

describe("Workspace.destroy", () => {
  it("removes the workspace directory", async () => {
    const exec = makeExec();
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    expect(fs.existsSync(ws.dir)).toBe(true);
    await ws.destroy();
    expect(fs.existsSync(ws.dir)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```bash
npm test -- tests/workspace.test.ts
```

Expected: "Cannot find module" or similar — the file doesn't exist yet.

- [ ] **Step 3: Create `src/workspace.ts` with `create` and `destroy`**

```ts
import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

export type GitExec = (args: string[], cwd?: string) => Promise<string>;

const defaultGitExec: GitExec = async (args, cwd) => {
  const { stdout } = await execFileAsync("git", args, cwd ? { cwd } : {});
  return stdout.trimEnd();
};

export class Workspace {
  private constructor(
    readonly dir: string,
    private readonly repoUrl: string,
    private readonly exec: GitExec,
  ) {}

  /**
   * Clone the repo into baseDir/workerId if not already present.
   * Writes a PID lockfile after cloning (or on any create call).
   */
  static async create(
    baseDir: string,
    workerId: string,
    repoUrl: string,
    exec: GitExec = defaultGitExec,
  ): Promise<Workspace> {
    const dir = path.join(baseDir, workerId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(baseDir, { recursive: true });
      await exec(["clone", repoUrl, dir], undefined);
    }
    fs.writeFileSync(path.join(dir, ".brunel.lock"), String(process.pid));
    return new Workspace(dir, repoUrl, exec);
  }

  /** Remove the entire checkout directory. */
  async destroy(): Promise<void> {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/workspace.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/workspace.ts tests/workspace.test.ts
git commit -m "feat: Workspace.create() and destroy()"
```

---

## Task 4: `Workspace.reset()` with error recovery

**Files:**
- Modify: `src/workspace.ts`
- Modify: `tests/workspace.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/workspace.test.ts`:

```ts
// ── reset ──────────────────────────────────────────────────────────────────

describe("Workspace.reset", () => {
  it("runs fetch, checkout main, reset --hard, clean -fdx", async () => {
    const exec = makeExec();
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    exec.mockClear();
    await ws.reset();
    expect(exec).toHaveBeenCalledWith(["fetch", "origin"], ws.dir);
    expect(exec).toHaveBeenCalledWith(["checkout", "main"], ws.dir);
    expect(exec).toHaveBeenCalledWith(["reset", "--hard", "origin/main"], ws.dir);
    expect(exec).toHaveBeenCalledWith(["clean", "-fdx"], ws.dir);
  });

  it("retries once on failure before succeeding", async () => {
    const exec = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("");
    // Pre-create the dir so create() skips cloning
    fs.mkdirSync(path.join(BASE_DIR, WORKER_ID), { recursive: true });
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    exec.mockClear();
    // First reset attempt fails, second succeeds
    exec
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValue("");
    await ws.reset();
    // reset was called at least twice (first fail, then success)
    expect(exec.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("destroys and re-clones if both retries fail, then succeeds", async () => {
    const dir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(dir, { recursive: true });
    let callCount = 0;
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "clone") return ""; // clone always succeeds
      callCount++;
      if (callCount <= 2) throw new Error("reset fail");
      return ""; // third attempt (after re-clone) succeeds
    });
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    exec.mockClear();
    callCount = 0;
    await ws.reset();
    expect(exec).toHaveBeenCalledWith(expect.arrayContaining(["clone"]), undefined);
  });

  it("throws if reset still fails after destroy + re-clone", async () => {
    const dir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(dir, { recursive: true });
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "clone") return "";
      throw new Error("always fails");
    });
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    exec.mockClear();
    await expect(ws.reset()).rejects.toThrow("always fails");
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```bash
npm test -- tests/workspace.test.ts
```

Expected: `ws.reset is not a function` or similar.

- [ ] **Step 3: Implement `reset()` in `src/workspace.ts`**

Add this method to the `Workspace` class (before `destroy()`):

```ts
/**
 * Reset to a clean main branch.
 * Retries once on failure. If still failing, destroys and re-clones,
 * then retries one final time.
 */
async reset(): Promise<void> {
  try {
    await this._doReset();
    return;
  } catch {
    // first retry
  }
  try {
    await this._doReset();
    return;
  } catch (err) {
    // destroy + re-clone + final attempt
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(this.dir), { recursive: true });
    await this.exec(["clone", this.repoUrl, this.dir], undefined);
    fs.writeFileSync(path.join(this.dir, ".brunel.lock"), String(process.pid));
    await this._doReset(); // throws if still broken — propagates to caller
  }
}

private async _doReset(): Promise<void> {
  await this.exec(["fetch", "origin"], this.dir);
  await this.exec(["checkout", "main"], this.dir);
  await this.exec(["reset", "--hard", "origin/main"], this.dir);
  await this.exec(["clean", "-fdx"], this.dir);
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/workspace.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/workspace.ts tests/workspace.test.ts
git commit -m "feat: Workspace.reset() with retry + re-clone recovery"
```

---

## Task 5: `Workspace.checkSafety()` and `confirmIfUnsafe()`

**Files:**
- Modify: `src/workspace.ts`
- Modify: `tests/workspace.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/workspace.test.ts`:

```ts
// ── checkSafety ────────────────────────────────────────────────────────────

describe("Workspace.checkSafety", () => {
  it("returns empty arrays when working tree is clean and branch is pushed", async () => {
    const exec = makeExec({
      "status --porcelain": "",
      "log @{u}..HEAD --oneline": "",
    });
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    const result = await ws.checkSafety();
    expect(result.uncommittedFiles).toEqual([]);
    expect(result.unpushedCommits).toEqual([]);
    expect(result.noUpstream).toBe(false);
  });

  it("returns uncommitted files when working tree is dirty", async () => {
    const exec = makeExec({
      "status --porcelain": " M src/foo.ts\n?? newfile.ts",
      "log @{u}..HEAD --oneline": "",
    });
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    const result = await ws.checkSafety();
    expect(result.uncommittedFiles).toEqual(["M src/foo.ts", "?? newfile.ts"]);
  });

  it("returns unpushed commits when ahead of upstream", async () => {
    const exec = makeExec({
      "status --porcelain": "",
      "log @{u}..HEAD --oneline": "abc1234 feat: my commit",
    });
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    const result = await ws.checkSafety();
    expect(result.unpushedCommits).toEqual(["abc1234 feat: my commit"]);
    expect(result.noUpstream).toBe(false);
  });

  it("sets noUpstream when branch has no tracking remote", async () => {
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "status") return "";
      if (args[0] === "log") throw new Error("fatal: no upstream configured for branch 'my-branch'");
      return "";
    });
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    const result = await ws.checkSafety();
    expect(result.noUpstream).toBe(true);
  });
});

// ── confirmIfUnsafe ─────────────────────────────────────────────────────────

import { confirmIfUnsafe } from "../src/workspace.js";

describe("confirmIfUnsafe", () => {
  it("returns true without calling confirm when workspace is clean", async () => {
    const exec = makeExec({
      "status --porcelain": "",
      "log @{u}..HEAD --oneline": "",
    });
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    const confirm = vi.fn().mockResolvedValue(true);
    const result = await confirmIfUnsafe(ws, confirm);
    expect(result).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("calls confirm with warning when there are uncommitted files", async () => {
    const exec = makeExec({
      "status --porcelain": " M src/foo.ts",
      "log @{u}..HEAD --oneline": "",
    });
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    const confirm = vi.fn().mockResolvedValue(true);
    const result = await confirmIfUnsafe(ws, confirm);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][0]).toContain("src/foo.ts");
    expect(result).toBe(true);
  });

  it("returns false when user declines", async () => {
    const exec = makeExec({
      "status --porcelain": " M src/foo.ts",
      "log @{u}..HEAD --oneline": "",
    });
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    const confirm = vi.fn().mockResolvedValue(false);
    const result = await confirmIfUnsafe(ws, confirm);
    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```bash
npm test -- tests/workspace.test.ts
```

Expected: `checkSafety is not a function` and `confirmIfUnsafe` import error.

- [ ] **Step 3: Implement `checkSafety()` in `src/workspace.ts`**

Add this method to the `Workspace` class:

```ts
/** Return safety info about the current checkout state. */
async checkSafety(): Promise<{
  uncommittedFiles: string[];
  unpushedCommits: string[];
  noUpstream: boolean;
}> {
  const statusOut = await this.exec(["status", "--porcelain"], this.dir);
  const uncommittedFiles = statusOut
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

  let unpushedCommits: string[] = [];
  let noUpstream = false;
  try {
    const logOut = await this.exec(["log", "@{u}..HEAD", "--oneline"], this.dir);
    unpushedCommits = logOut
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean);
  } catch (err) {
    const msg = String(err);
    if (msg.includes("no upstream") || msg.includes("no tracking information")) {
      noUpstream = true;
    }
  }

  return { uncommittedFiles, unpushedCommits, noUpstream };
}
```

- [ ] **Step 4: Implement `confirmIfUnsafe()` in `src/workspace.ts`** (add as a top-level export after the class)

```ts
/**
 * Check whether it is safe to reset or destroy the workspace.
 * If there are uncommitted or unpushed changes, calls confirm(warningMessage).
 * Returns true if safe to proceed, false if the user declined.
 */
export async function confirmIfUnsafe(
  workspace: Workspace,
  confirm: (message: string) => Promise<boolean>,
): Promise<boolean> {
  const safety = await workspace.checkSafety();
  const issues: string[] = [];

  if (safety.uncommittedFiles.length > 0) {
    issues.push(
      `Uncommitted changes:\n${safety.uncommittedFiles.map(f => `  ${f}`).join("\n")}`,
    );
  }
  if (safety.noUpstream) {
    issues.push("Current branch has no upstream — any commits may be lost.");
  } else if (safety.unpushedCommits.length > 0) {
    issues.push(
      `Unpushed commits:\n${safety.unpushedCommits.map(c => `  ${c}`).join("\n")}`,
    );
  }

  if (issues.length === 0) return true;
  return confirm(issues.join("\n\n"));
}
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
npm test -- tests/workspace.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/workspace.ts tests/workspace.test.ts
git commit -m "feat: Workspace.checkSafety() and confirmIfUnsafe()"
```

---

## Task 6: `Workspace.prune()`

**Files:**
- Modify: `src/workspace.ts`
- Modify: `tests/workspace.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/workspace.test.ts`:

```ts
// ── prune ──────────────────────────────────────────────────────────────────

import { Workspace } from "../src/workspace.js"; // already imported above

describe("Workspace.prune", () => {
  it("returns empty array when baseDir does not exist", async () => {
    const result = await Workspace.prune(path.join(BASE_DIR, "nonexistent"));
    expect(result).toEqual([]);
  });

  it("removes directories with no lockfile", async () => {
    const orphanDir = path.join(BASE_DIR, "orphan-no-lock");
    fs.mkdirSync(orphanDir);
    const removed = await Workspace.prune(BASE_DIR);
    expect(removed).toContain(orphanDir);
    expect(fs.existsSync(orphanDir)).toBe(false);
  });

  it("removes directories whose lockfile has a dead PID", async () => {
    const orphanDir = path.join(BASE_DIR, "orphan-dead-pid");
    fs.mkdirSync(orphanDir);
    // PID 2147483647 is the max int32 — almost certainly not running
    fs.writeFileSync(path.join(orphanDir, ".brunel.lock"), "2147483647");
    const removed = await Workspace.prune(BASE_DIR);
    expect(removed).toContain(orphanDir);
    expect(fs.existsSync(orphanDir)).toBe(false);
  });

  it("keeps directories whose lockfile has a live PID", async () => {
    const activeDir = path.join(BASE_DIR, "active-worker");
    fs.mkdirSync(activeDir);
    // Current process PID is definitely alive
    fs.writeFileSync(path.join(activeDir, ".brunel.lock"), String(process.pid));
    const removed = await Workspace.prune(BASE_DIR);
    expect(removed).not.toContain(activeDir);
    expect(fs.existsSync(activeDir)).toBe(true);
  });

  it("ignores non-directory entries", async () => {
    fs.writeFileSync(path.join(BASE_DIR, "somefile.txt"), "content");
    const removed = await Workspace.prune(BASE_DIR);
    expect(fs.existsSync(path.join(BASE_DIR, "somefile.txt"))).toBe(true);
    expect(removed).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```bash
npm test -- tests/workspace.test.ts
```

Expected: `Workspace.prune is not a function`.

- [ ] **Step 3: Implement `Workspace.prune()` in `src/workspace.ts`**

Add as a static method on the `Workspace` class:

```ts
/**
 * Remove orphaned workspace directories under baseDir.
 * A directory is orphaned if it has no .brunel.lock, or its lock PID is dead.
 * Active workers (live PID) are skipped.
 * Returns the list of directories removed.
 */
static async prune(baseDir: string): Promise<string[]> {
  if (!fs.existsSync(baseDir)) return [];
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(baseDir, entry.name);
    const lockPath = path.join(dir, ".brunel.lock");
    if (fs.existsSync(lockPath)) {
      const pid = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
      if (isProcessAlive(pid)) continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}
```

Also add this helper function at the module level (before the class):

```ts
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/workspace.test.ts
```

Expected: all pass.

- [ ] **Step 5: Run the full test suite to catch regressions**

```bash
npm test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/workspace.ts tests/workspace.test.ts
git commit -m "feat: Workspace.prune() using PID lockfile"
```

---

## Task 7: New slash command types in `src/input.ts`

**Files:**
- Modify: `src/input.ts`
- Modify: `tests/repl.slash.test.ts`
- Modify: `tests/repl.dispatch.test.ts`

- [ ] **Step 1: Write failing tests**

In `tests/repl.slash.test.ts`, add to the `parseSlashCommand` describe block:

```ts
it("recognizes /create-workspace", () => {
  expect(parseSlashCommand("/create-workspace")).toEqual({ type: "create_workspace" });
});
it("recognizes /reset-workspace", () => {
  expect(parseSlashCommand("/reset-workspace")).toEqual({ type: "reset_workspace" });
});
it("recognizes /remove-workspace", () => {
  expect(parseSlashCommand("/remove-workspace")).toEqual({ type: "remove_workspace" });
});
it("recognizes /prune", () => {
  expect(parseSlashCommand("/prune")).toEqual({ type: "prune" });
});
```

In `tests/repl.dispatch.test.ts`, look at the existing pattern and add tests for the new commands dispatching directly (not resolving to a file):

```ts
it("dispatches /create-workspace as create_workspace action", async () => {
  const result = await dispatchInput("/create-workspace", () => null);
  expect(result).toEqual({ type: "create_workspace" });
});
it("dispatches /reset-workspace as reset_workspace action", async () => {
  const result = await dispatchInput("/reset-workspace", () => null);
  expect(result).toEqual({ type: "reset_workspace" });
});
it("dispatches /remove-workspace as remove_workspace action", async () => {
  const result = await dispatchInput("/remove-workspace", () => null);
  expect(result).toEqual({ type: "remove_workspace" });
});
it("dispatches /prune as prune action", async () => {
  const result = await dispatchInput("/prune", () => null);
  expect(result).toEqual({ type: "prune" });
});
```

- [ ] **Step 2: Run to confirm they fail**

```bash
npm test -- tests/repl.slash.test.ts tests/repl.dispatch.test.ts
```

Expected: failures on new assertions.

- [ ] **Step 3: Update `src/input.ts`**

In `src/input.ts`, update `SlashCommandResult` to add the four new types:

```ts
export type SlashCommandResult =
  | { type: "exit" }
  | { type: "clear" }
  | { type: "task_complete" }
  | { type: "create_workspace" }
  | { type: "reset_workspace" }
  | { type: "remove_workspace" }
  | { type: "prune" }
  | { type: "unknown_command"; command: string };
```

Update `DispatchResult` to include the four new types:

```ts
export type DispatchResult =
  | { type: "skip" }
  | { type: "exit" }
  | { type: "clear" }
  | { type: "task_complete" }
  | { type: "create_workspace" }
  | { type: "reset_workspace" }
  | { type: "remove_workspace" }
  | { type: "prune" }
  | { type: "query"; prompt: string }
  | { type: "unknown_command"; command: string };
```

Add four new entries to `BUILTIN_COMMANDS`:

```ts
{ name: "create-workspace", description: "Create an isolated git checkout for this session",    result: { type: "create_workspace" } },
{ name: "reset-workspace",  description: "Reset workspace to clean main branch",                result: { type: "reset_workspace" } },
{ name: "remove-workspace", description: "Remove the workspace checkout for this session",      result: { type: "remove_workspace" } },
{ name: "prune",            description: "Remove orphaned worker workspace directories",        result: { type: "prune" } },
```

Update `dispatchInput` to pass through the new types (in the slash-handling block, after the `task_complete` check):

```ts
if (
  slash.type === "create_workspace" ||
  slash.type === "reset_workspace" ||
  slash.type === "remove_workspace" ||
  slash.type === "prune"
) return slash;
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/repl.slash.test.ts tests/repl.dispatch.test.ts
```

Expected: all pass.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: all pass. (TypeScript compiler may surface type errors in worker.ts/repl.ts where the new action types need handling — fix them by adding `else if` branches that just `continue` for now.)

- [ ] **Step 6: Commit**

```bash
git add src/input.ts tests/repl.slash.test.ts tests/repl.dispatch.test.ts
git commit -m "feat: add workspace slash command types to input dispatcher"
```

---

## Task 8: `WorkerSession` — `afterTask` callback and `/task-complete` integration

**Files:**
- Modify: `src/worker.ts`
- Modify: `tests/worker.test.ts`

- [ ] **Step 1: Write failing tests**

In `tests/worker.test.ts`, find the `beforeEach` where `session` is constructed and note the existing signature:

```ts
session = new WorkerSession(WORKER_ID, wsFactory, runQuery, display);
```

Add these tests:

```ts
describe("afterTask callback on /task-complete", () => {
  it("calls afterTask before sending task_complete to foreman", async () => {
    const afterTask = vi.fn().mockResolvedValue(undefined);
    const sessionWithAfterTask = new WorkerSession(
      WORKER_ID, wsFactory, runQuery, display, { afterTask }
    );
    sessionWithAfterTask.start();

    // Assign a task
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalled());

    // Trigger task-complete
    await sessionWithAfterTask.handleUserInput("/task-complete");
    expect(afterTask).toHaveBeenCalledOnce();
    const sentMsg = JSON.parse(fakeWs.send.mock.calls.at(-1)[0]);
    expect(sentMsg.type).toBe("task_complete");
  });

  it("does not send task_complete if afterTask throws", async () => {
    const afterTask = vi.fn().mockRejectedValue(new Error("reset failed"));
    const sessionWithAfterTask = new WorkerSession(
      WORKER_ID, wsFactory, runQuery, display, { afterTask }
    );
    sessionWithAfterTask.start();

    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalled());

    const sendCountBefore = fakeWs.send.mock.calls.length;
    await sessionWithAfterTask.handleUserInput("/task-complete");
    // No new task_complete message sent
    const taskCompleteSent = fakeWs.send.mock.calls
      .slice(sendCountBefore)
      .some(([data]: [string]) => JSON.parse(data).type === "task_complete");
    expect(taskCompleteSent).toBe(false);
  });

  it("sends task_complete normally with no afterTask", async () => {
    const issue = makeIssue();
    sendMsg(fakeWs, { type: "task_assigned", taskId: "t1", issue });
    await vi.waitFor(() => expect(runQuery).toHaveBeenCalled());
    await session.handleUserInput("/task-complete");
    const lastMsg = JSON.parse(fakeWs.send.mock.calls.at(-1)[0]);
    expect(lastMsg.type).toBe("task_complete");
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```bash
npm test -- tests/worker.test.ts
```

Expected: failures on the new tests (constructor doesn't accept 5th arg yet).

- [ ] **Step 3: Update `WorkerSession` in `src/worker.ts`**

Add a `WorkerSessionOptions` type and update the constructor. Find the constructor in `worker.ts`:

```ts
constructor(
  private workerId: string,
  private wsFactory: WsFactory,
  private runQuery: RunQuery,
  private display: WorkerDisplay,
) {}
```

Replace with:

```ts
export type WorkerSessionOptions = {
  afterTask?: () => Promise<void>;
};

constructor(
  private workerId: string,
  private wsFactory: WsFactory,
  private runQuery: RunQuery,
  private display: WorkerDisplay,
  private options: WorkerSessionOptions = {},
) {}
```

In `handleSlashCommand`, find the `task-complete` branch. The current code sends `task_complete` immediately. Update it to call `afterTask` first:

```ts
if (command === "task-complete") {
  if (this.currentTaskId && this.ws && this.ws.readyState === WebSocket.OPEN) {
    if (this.options.afterTask) {
      try {
        await this.options.afterTask();
      } catch (err) {
        this.display.print(display.c.boldRed(`Workspace reset failed: ${err}. Task not marked complete.`));
        return;
      }
    }
    this.ws.send(JSON.stringify({
      type: "task_complete",
      workerId: this.workerId,
      taskId: this.currentTaskId,
    }));
    this.currentTaskId = undefined;
    this.currentIssue = undefined;
    this.currentSessionId = undefined;
    this.display.print(display.c.sageGreen("Task complete. Waiting for next task..."));
  }
  return;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/worker.test.ts
```

Expected: all pass.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/worker.ts tests/worker.test.ts
git commit -m "feat: WorkerSession afterTask callback for /task-complete"
```

---

## Task 9: `WorkerSession` workspace slash command handlers

**Files:**
- Modify: `src/worker.ts`
- Modify: `tests/worker.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/worker.test.ts`:

```ts
import { Workspace } from "../src/workspace.js";

describe("workspace slash commands in WorkerSession", () => {
  function makeWorkspace(exec = vi.fn().mockResolvedValue("")): Workspace {
    // Use the private constructor via cast; or just test the output
    // We'll test by mocking the workspace methods directly
    return {
      dir: "/tmp/test-workspace",
      reset: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      checkSafety: vi.fn().mockResolvedValue({
        uncommittedFiles: [], unpushedCommits: [], noUpstream: false,
      }),
    } as unknown as Workspace;
  }

  it("/reset-workspace calls workspace.reset() when clean", async () => {
    const workspace = makeWorkspace();
    const confirm = vi.fn().mockResolvedValue(true);
    const sessionWs = new WorkerSession(WORKER_ID, wsFactory, runQuery, display, {
      workspaceCtx: {
        workspace,
        originalCwd: "/original",
        workspaceDir: "/tmp/workers",
        repoUrl: "https://token@github.com/owner/repo.git",
        confirm,
      },
    });
    sessionWs.start();
    await sessionWs.handleUserInput("/reset-workspace");
    expect(workspace.reset).toHaveBeenCalledOnce();
  });

  it("/reset-workspace does not reset if user declines", async () => {
    const workspace = makeWorkspace();
    (workspace.checkSafety as ReturnType<typeof vi.fn>).mockResolvedValue({
      uncommittedFiles: ["M foo.ts"], unpushedCommits: [], noUpstream: false,
    });
    const confirm = vi.fn().mockResolvedValue(false);
    const sessionWs = new WorkerSession(WORKER_ID, wsFactory, runQuery, display, {
      workspaceCtx: {
        workspace,
        originalCwd: "/original",
        workspaceDir: "/tmp/workers",
        repoUrl: "https://token@github.com/owner/repo.git",
        confirm,
      },
    });
    sessionWs.start();
    await sessionWs.handleUserInput("/reset-workspace");
    expect(workspace.reset).not.toHaveBeenCalled();
  });

  it("/remove-workspace calls destroy() and prints confirmation", async () => {
    const workspace = makeWorkspace();
    const confirm = vi.fn().mockResolvedValue(true);
    const sessionWs = new WorkerSession(WORKER_ID, wsFactory, runQuery, display, {
      workspaceCtx: {
        workspace,
        originalCwd: "/original",
        workspaceDir: "/tmp/workers",
        repoUrl: "https://token@github.com/owner/repo.git",
        confirm,
      },
    });
    sessionWs.start();
    await sessionWs.handleUserInput("/remove-workspace");
    expect(workspace.destroy).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```bash
npm test -- tests/worker.test.ts
```

Expected: failures (workspaceCtx not in options yet).

- [ ] **Step 3: Add `WorkspaceCtx` type and update `WorkerSession` in `src/worker.ts`**

Add the `WorkspaceCtx` type and update `WorkerSessionOptions`:

```ts
import { Workspace, confirmIfUnsafe } from "./workspace.js";

export type WorkspaceCtx = {
  workspace: Workspace;
  originalCwd: string;
  workspaceDir: string;
  repoUrl: string;
  confirm: (msg: string) => Promise<boolean>;
};

export type WorkerSessionOptions = {
  afterTask?: () => Promise<void>;
  workspaceCtx?: WorkspaceCtx;
};
```

Add handlers for the new action types in `handleUserInput()`. Find the section that handles `action.type === "task_complete"` and add after it:

```ts
if (action.type === "reset_workspace") {
  await this.handleSlashCommand("/reset-workspace");
  return;
}
if (action.type === "remove_workspace") {
  await this.handleSlashCommand("/remove-workspace");
  return;
}
if (action.type === "create_workspace") {
  this.display.print(display.c.amber("Workspace is managed automatically in worker mode."));
  return;
}
if (action.type === "prune") {
  await this.handleSlashCommand("/prune");
  return;
}
```

Add handlers in `handleSlashCommand()`:

```ts
if (command === "reset-workspace") {
  const ctx = this.options.workspaceCtx;
  if (!ctx) { this.display.print(display.c.boldRed("No workspace in this session.")); return; }
  const ok = await confirmIfUnsafe(ctx.workspace, ctx.confirm);
  if (!ok) return;
  await ctx.workspace.reset();
  this.display.print(display.c.sageGreen("Workspace reset to main."));
  return;
}

if (command === "remove-workspace") {
  const ctx = this.options.workspaceCtx;
  if (!ctx) { this.display.print(display.c.boldRed("No workspace in this session.")); return; }
  const ok = await confirmIfUnsafe(ctx.workspace, ctx.confirm);
  if (!ok) return;
  await ctx.workspace.destroy();
  process.chdir(ctx.originalCwd);
  this.options.workspaceCtx = undefined;
  this.display.print(display.c.sageGreen(`Workspace removed. Now in: ${ctx.originalCwd}`));
  return;
}

if (command === "prune") {
  const ctx = this.options.workspaceCtx;
  const workspaceDir = ctx?.workspaceDir;
  if (!workspaceDir) { this.display.print(display.c.boldRed("No workspace directory configured.")); return; }
  const removed = await Workspace.prune(workspaceDir);
  if (removed.length === 0) {
    this.display.print(display.c.sageGreen("Nothing to prune."));
  } else {
    for (const dir of removed) this.display.print(display.c.darkGray(`  Removed: ${dir}`));
    this.display.print(display.c.sageGreen(`Pruned ${removed.length} orphaned workspace(s).`));
  }
  return;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/worker.test.ts
```

Expected: all pass.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/worker.ts tests/worker.test.ts
git commit -m "feat: workspace slash commands in WorkerSession"
```

---

## Task 10: `workerMain` startup — workspace creation, chdir, signals

**Files:**
- Modify: `src/worker.ts`

- [ ] **Step 1: Add imports at the top of `src/worker.ts`**

Add these imports (after existing imports):

```ts
import os from "node:os";
import path from "node:path";
import { pick } from "./input.js";
```

(The `Workspace` and `confirmIfUnsafe` imports were added in Task 9.)

- [ ] **Step 2: Update `workerMain` in `src/worker.ts`**

`workerMain` currently starts like:

```ts
export async function workerMain(
  runQueryFn: RunQuery,
  config: { foremanUrl: string },
): Promise<void> {
```

Update the signature to include workspace config:

```ts
export async function workerMain(
  runQueryFn: RunQuery,
  config: {
    foremanUrl: string;
    workspaceDir?: string;
    githubToken: string;
    githubRepo: string;
  },
): Promise<void> {
```

At the start of `workerMain`, after `const workerId = crypto.randomUUID();`, add:

```ts
const originalCwd = process.cwd();
const workspaceDir = config.workspaceDir ?? path.join(os.homedir(), ".brunel", "workers");
const repoUrl = `https://${config.githubToken}@github.com/${config.githubRepo}.git`;

const workspace = await Workspace.create(workspaceDir, workerId, repoUrl);
process.chdir(workspace.dir);

const confirm = async (msg: string): Promise<boolean> => {
  display.print(display.c.amber(`\n⚠ Potential data loss:\n${msg}`));
  const idx = await pick(["Yes, proceed", "No, cancel"]);
  return idx === 0;
};

const afterTask = async () => {
  const ok = await confirmIfUnsafe(workspace, confirm);
  if (!ok) throw new Error("User declined workspace reset.");
  await workspace.reset();
};

// Register signal handlers for graceful shutdown
const shutdown = async () => {
  const ok = await confirmIfUnsafe(workspace, confirm);
  if (ok) await workspace.destroy();
  process.exit(0);
};
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT",  () => { void shutdown(); });
```

Update the `WorkerSession` construction to pass `workspaceCtx` and `afterTask`:

```ts
const session = new WorkerSession(workerId, wsFactory, runQueryFn, workerDisplay, {
  afterTask,
  workspaceCtx: { workspace, originalCwd, workspaceDir, repoUrl, confirm },
});
```

At the end of `workerMain`, before the process exits, add workspace cleanup:

```ts
// Clean shutdown
const ok = await confirmIfUnsafe(workspace, confirm);
if (ok) await workspace.destroy();
```

Add this just before the final `process.stdout.write` and stdin cleanup lines.

- [ ] **Step 3: Update the entry point in `src/repl.ts`** to pass the new config fields to `workerMain`

Find the `workerMain` call:

```ts
void workerMain(boundRunQuery, { foremanUrl: config.foremanUrl });
```

Replace with:

```ts
void workerMain(boundRunQuery, {
  foremanUrl: config.foremanUrl,
  workspaceDir: config.workspaceDir,
  githubToken: config.githubToken,
  githubRepo: config.githubRepo,
});
```

- [ ] **Step 4: Run the smoke test to verify workers connect**

```bash
npm run smoke
```

Expected: passes (foreman and worker connect successfully).

- [ ] **Step 5: Run the full test suite**

```bash
npm test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/worker.ts src/repl.ts
git commit -m "feat: worker startup clones workspace and chdirs into it"
```

---

## Task 11: REPL session UUID and workspace slash commands in `main()`

**Files:**
- Modify: `src/repl.ts`

- [ ] **Step 1: Add imports at the top of `src/repl.ts`**

Add these imports (after existing imports):

```ts
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Workspace, confirmIfUnsafe } from "./workspace.js";
```

- [ ] **Step 2: Update `main()` to handle workspace actions**

`main()` currently takes `permConfig`. Update its signature to also accept optional workspace config:

```ts
async function main(
  permConfig: { permissionMode: PermissionMode; allowDangerouslySkipPermissions: boolean },
  workspaceCfg?: { workspaceDir: string; repoUrl: string },
): Promise<void>
```

At the start of `main()`, after `let sessionId: string | undefined;`, add:

```ts
const sessionId_ = crypto.randomUUID();
const originalCwd = process.cwd();
let workspace: Workspace | undefined = undefined;

const confirm = async (msg: string): Promise<boolean> => {
  display.stopStatus();
  display.print(display.c.amber(`\n⚠ Potential data loss:\n${msg}`));
  const idx = await pick(["Yes, proceed", "No, cancel"]);
  return idx === 0;
};
```

In the `while (true)` loop, after the `if (action.type === "task_complete")` block, add handlers for the four new action types:

```ts
if (action.type === "create_workspace") {
  if (!workspaceCfg) {
    display.print(display.c.boldRed("Cannot create workspace: no GitHub repo configured."));
    continue;
  }
  if (workspace) {
    display.print(display.c.amber(`Workspace already exists: ${workspace.dir}`));
    continue;
  }
  workspace = await Workspace.create(workspaceCfg.workspaceDir, sessionId_, workspaceCfg.repoUrl);
  process.chdir(workspace.dir);
  display.print(display.c.sageGreen(`Workspace created: ${workspace.dir}`));
  continue;
}

if (action.type === "reset_workspace") {
  if (!workspace) {
    display.print(display.c.boldRed("No workspace. Use /create-workspace first."));
    continue;
  }
  const ok = await confirmIfUnsafe(workspace, confirm);
  if (!ok) continue;
  await workspace.reset();
  display.print(display.c.sageGreen("Workspace reset to main."));
  continue;
}

if (action.type === "remove_workspace") {
  if (!workspace) {
    display.print(display.c.boldRed("No workspace in this session."));
    continue;
  }
  const ok = await confirmIfUnsafe(workspace, confirm);
  if (!ok) continue;
  await workspace.destroy();
  process.chdir(originalCwd);
  workspace = undefined;
  display.print(display.c.sageGreen(`Workspace removed. Now in: ${originalCwd}`));
  continue;
}

if (action.type === "prune") {
  if (!workspaceCfg) {
    display.print(display.c.boldRed("Cannot prune: no workspace directory configured."));
    continue;
  }
  const removed = await Workspace.prune(workspaceCfg.workspaceDir);
  if (removed.length === 0) {
    display.print(display.c.sageGreen("Nothing to prune."));
  } else {
    for (const dir of removed) display.print(display.c.darkGray(`  Removed: ${dir}`));
    display.print(display.c.sageGreen(`Pruned ${removed.length} orphaned workspace(s).`));
  }
  continue;
}
```

Also update the clean `exit` path at the end of `main()` to destroy the workspace if one exists. Find the `break` in the exit block and add before it:

```ts
if (workspace) {
  const ok = await confirmIfUnsafe(workspace, confirm);
  if (ok) await workspace.destroy();
}
```

- [ ] **Step 3: Update the entry point to pass workspace config to `main()`**

Find the `void main(permConfig);` call at the bottom of `src/repl.ts` and replace with:

```ts
const workspaceCfg = (config.githubRepo && config.githubToken)
  ? {
      workspaceDir: config.workspaceDir ?? path.join(os.homedir(), ".brunel", "workers"),
      repoUrl: `https://${config.githubToken}@github.com/${config.githubRepo}.git`,
    }
  : undefined;

void main(permConfig, workspaceCfg);
```

- [ ] **Step 4: Run the full test suite**

```bash
npm test
```

Expected: all pass.

- [ ] **Step 5: Run the smoke test**

```bash
npm run smoke
```

Expected: passes.

- [ ] **Step 6: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/repl.ts
git commit -m "feat: REPL workspace slash commands and session UUID"
```

---

## Self-Review

Checking spec coverage:

| Spec requirement | Task |
|-----------------|------|
| `Workspace.create()` — clone, skip if exists, write lockfile | Task 3 |
| `Workspace.reset()` — fetch+checkout+reset+clean, error recovery | Task 4 |
| `Workspace.destroy()` — rm -rf | Task 3 |
| `Workspace.checkSafety()` — uncommitted files, unpushed commits, noUpstream | Task 5 |
| `confirmIfUnsafe()` helper | Task 5 |
| `Workspace.prune()` — PID lockfile, skip live, remove dead/missing | Task 6 |
| `workspaceDir` config key + CLAUDE.md doc | Task 2 |
| `process.chdir(workspace.dir)` in workerMain | Task 10 |
| `afterTask` callback on WorkerSession | Task 8 |
| confirmIfUnsafe on `/task-complete` | Task 8 |
| SIGTERM/SIGINT signal handlers | Task 10 |
| Clean shutdown calls confirmIfUnsafe + destroy | Tasks 10, 11 |
| Prompt changes (no more worktree instructions) | Task 1 |
| `/create-workspace`, `/reset-workspace`, `/remove-workspace`, `/prune` commands | Tasks 7, 9, 11 |
| Safety checks on all destructive operations | Tasks 5, 8, 9, 11 |
| REPL session UUID | Task 11 |
| Worker startup: clone → chdir | Task 10 |
