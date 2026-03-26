# Worker Isolated Checkouts Design

**Date:** 2026-03-26

## Problem

Workers sharing a single git checkout (using worktrees) causes conflicts and messy state when multiple workers run concurrently. Each worker should operate in its own fully isolated checkout of the target repo.

## Approach

Each worker clones the target repo into a dedicated directory at startup and operates entirely within it. The checkout is reset to a clean state after each task completes (before reporting idle to the foreman), ensuring the next task always starts from a known-good baseline. Worker checkouts live under a configurable base directory, defaulting to `~/.brunel/workers/`.

## Components

### New: `src/workspace.ts`

A `Workspace` class owning the full lifecycle of a single checkout.

```ts
class Workspace {
  readonly dir: string  // e.g. ~/.brunel/workers/worker-{id}

  // Clones the repo into baseDir/workerId if the directory doesn't exist.
  // If the directory already exists, assumes it is a valid clone and skips.
  // Writes a PID lockfile after cloning.
  static async create(baseDir: string, workerId: string, repoUrl: string): Promise<Workspace>

  // Resets the checkout to a clean main branch:
  //   git fetch origin
  //   git checkout main
  //   git reset --hard origin/main
  //   git clean -fdx
  async reset(): Promise<void>

  // Removes the entire checkout directory (rm -rf this.dir).
  // Called on clean worker shutdown.
  async destroy(): Promise<void>

  // Scans baseDir for subdirectories and removes orphaned checkouts.
  // A checkout is orphaned if it has no lockfile, or its lockfile contains
  // a PID that is no longer running (checked via process.kill(pid, 0)).
  // Active worker directories (live PID) are skipped.
  // Returns the list of directories removed.
  static async prune(baseDir: string): Promise<string[]>
}
```

**PID lockfile:** Each checkout contains `.brunel.lock` with the worker's PID. Written by `create()`, removed implicitly when `destroy()` deletes the directory. Used by `prune()` to distinguish active from orphaned checkouts.

**Clone URL:** Constructed from config as `https://{githubToken}@github.com/{githubRepo}.git`.

**Error handling in `reset()`:** If reset fails, retry once. If it still fails, call `destroy()` explicitly (rm -rf the directory), then call `create()` to re-clone from scratch, then retry `reset()`. The explicit `destroy()` before `create()` ensures the directory doesn't already exist, preventing `create()` from skipping the clone. If that also fails, propagate the error. The caller (worker) treats a failed reset as a reason not to report idle — see lifecycle below.

### Config changes (`src/config.ts`)

One new optional key:

```ts
workspaceDir: z.string().optional()
// env var: BRUNEL_WORKSPACE_DIR
// default: ~/.brunel/workers (resolved at runtime via os.homedir())
```

Document in `CLAUDE.md` under optional config.

### `cwd` threading (`src/repl.ts`)

No changes to `runQuery()` or the `RunQuery` type. Instead, the worker calls `process.chdir(workspace.dir)` after the workspace is created, so `process.cwd()` already returns the correct path when the SDK is called.

Bonus: the Claude SDK's `settingSources: ["user", "project"]` will load the target repo's `CLAUDE.md` automatically, which is the desired behavior.

The REPL (non-worker mode) continues to use `process.cwd()` unchanged.

### Worker lifecycle changes (`src/worker.ts`, existing file)

Note: `src/worker.ts` already exists in the codebase and contains `WorkerSession` and `workerMain`. The entry point `src/repl.ts` imports from it and calls `workerMain` when `--worker-mode` is passed. Changes described here apply to the existing `src/worker.ts`.

**Startup:**
1. Build `repoUrl` from `githubToken` + `githubRepo`
2. `Workspace.create(workspaceDir, workerId, repoUrl)` — clones if needed, writes PID lockfile (lockfile is written inside `create()`, before `chdir`)
3. `process.chdir(workspace.dir)`
4. Register SIGTERM and SIGINT (as signal) handlers: `await workspace.destroy(); process.exit()`

**`WorkerSession` constructor** gains an optional callback:

```ts
afterTask?: () => Promise<void>
```

Called inside `handleSlashCommand("task-complete")` **before** sending `task_complete` to the foreman. If `afterTask()` throws, the worker logs the error and does not send `task_complete` — it stays busy. The foreman never sees it as idle, so no task is stranded.

`workerMain` passes `() => workspace.reset()` as `afterTask`.

**Clean shutdown** (end of `workerMain` loop, `/exit`, `^D`):
- `await workspace.destroy()`
- Process exits normally

**Unclean shutdown** (SIGKILL, crash):
- Checkout is left as an orphan under `workspaceDir/`
- Cleaned up later by `Workspace.prune()`

### Prompt changes (`src/templates.ts`)

**`buildInitialPrompt`** — remove worktree instructions. Replace:

> *"Create a new branch and an isolated worktree for this task. Make no changes in the main workspace, only in the worktree."*

With:

> *"Create a new branch for this task."*

**`pull_request` closed event** — remove worktree cleanup instruction. Replace:

> *"Please remove your worktree and delete the branch."*

With:

> *"Please delete the branch."*

### Workspace slash commands

Four workspace management commands are available in both worker and REPL modes. The session carries an optional `workspace: Workspace | undefined` reference that these commands read and update.

**`/create-workspace`**
- Creates a workspace for the current session (useful in REPL mode; in worker mode the workspace is created automatically at startup)
- Calls `Workspace.create(workspaceDir, sessionId, repoUrl)`, then `process.chdir(workspace.dir)`
- If a workspace already exists for this session, prints a message and does nothing
- Saves the original `process.cwd()` before the first `chdir` so `/remove-workspace` can restore it

**`/reset-workspace`**
- Before resetting, runs `git status --porcelain` in the workspace. If the output is non-empty, shows the dirty files and prompts "This will discard all uncommitted changes. Continue? [Yes/No]". Aborts if the user says no.
- Calls `workspace.reset()` on the current session's workspace
- Useful for manually cleaning up mid-task or recovering from a bad state
- Errors if no workspace exists for this session

**`/remove-workspace`**
- Before removing, performs two safety checks:
  1. `git status --porcelain` — warns if there are uncommitted changes
  2. `git log @{u}..HEAD --oneline` — warns if the current branch has unpushed commits; also warns if the branch has no upstream (never pushed)
- If either check finds potential data loss, shows what would be lost and prompts "This will permanently delete the workspace. Continue? [Yes/No]". Aborts if the user says no.
- Calls `workspace.destroy()`, removes the checkout directory
- Restores `process.cwd()` to the directory saved at `/create-workspace` time (or the original startup cwd for workers)
- Clears the session's `workspace` reference
- Errors if no workspace exists for this session

**`/prune`**
- Calls `Workspace.prune(workspaceDir)` — scans `workspaceDir`, removes orphaned checkouts, skips active ones (PID lockfile check)
- Prints each removed directory and a summary count
- If `workspaceDir` doesn't exist, prints a "nothing to prune" message
- Safe to run at any time

### REPL

The REPL gains workspace support via `/create-workspace`. By default it continues to use `process.cwd()` unchanged; the user opts in by running `/create-workspace`. The REPL generates a random UUID at startup to use as its session ID for workspace naming (the same pattern workers already use for `workerId`).

Making the REPL and worker share the same workspace lifecycle API is intentional — the longer-term direction is to reduce the sharp distinction between the two modes, potentially allowing mode changes at runtime.

## Full Worker Lifecycle Summary

1. **Startup:** clone + write lockfile (inside `create()`) → chdir → connect to foreman
2. **Task assigned:** Claude works in the checkout (already on clean main from previous reset or initial clone)
3. **Task complete:** `workspace.reset()` → if successful, send `task_complete` to foreman → idle; if failed, stay busy and log error
4. **Clean shutdown:** `workspace.destroy()` → exit
5. **Unclean shutdown:** orphaned dir cleaned up by `Workspace.prune()`

## Out of scope

- Prompting the user about uncommitted changes on shutdown (can be added later)
- Workspace pool / pre-provisioning (not needed at current scale)
