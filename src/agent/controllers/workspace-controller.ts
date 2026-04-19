import { c } from "../views/style.js";
import type { CommandRegistry } from "./command-controller.js";
import type { WorkerDisplay } from "./worker-controller.js";
import { Workspace, confirmIfUnsafe } from "../models/workspace.js";
import { fmtError } from "../../utils.js";

/**
 * WorkspaceController owns workspace lifecycle (creation, reset between tasks,
 * and destruction on exit) and registers the /workspace:* slash commands.
 * Constructed once in index.ts and injected into startWorkerMode.
 *
 * Pass `undefined` workspace when no GitHub repo is configured — commands that
 * require a workspace will print an appropriate error message, and lifecycle
 * methods are no-ops.
 */
export class WorkspaceController {
  constructor(
    readonly workspace: Workspace | undefined,
    private display: WorkerDisplay,
  ) {}

  /**
   * Register workspace commands into the given registry (which should already
   * be scoped, e.g. registry.scoped("workspace")). Call this once at startup.
   */
  registerCommands(registry: CommandRegistry): void {
    const { workspace, display } = this;

    registry.register("create", {
      description: "Create an isolated git checkout for this session",
      handler: async () => {
        if (!workspace) {
          display.print(c.boldRed("Cannot create workspace: no GitHub repo configured."));
          return;
        }
        if (workspace.isCreated) {
          display.print(c.amber(`Workspace already exists: ${workspace.dir}`));
          return;
        }
        await workspace.create();
        process.chdir(workspace.dir);
        display.print(c.sageGreen(`Workspace created: ${workspace.dir}`));
      },
    });

    registry.register("reset", {
      description: "Reset workspace to clean main branch",
      handler: async () => {
        if (!workspace?.isCreated) {
          display.print(c.boldRed("No workspace. Use /workspace:create first."));
          return;
        }
        const ok = await confirmIfUnsafe(workspace, workspace.confirm);
        if (!ok) return;
        await workspace.reset();
        display.print(c.sageGreen("Workspace reset to main."));
      },
    });

    registry.register("remove", {
      description: "Remove the workspace checkout for this session",
      handler: async () => {
        if (!workspace?.isCreated) {
          display.print(c.boldRed("No workspace in this session."));
          return;
        }
        const ok = await confirmIfUnsafe(workspace, workspace.confirm);
        if (!ok) return;
        await workspace.destroy();
        process.chdir(workspace.originalCwd);
        display.print(c.sageGreen(`Workspace removed. Now in: ${workspace.originalCwd}`));
      },
    });

    registry.register("prune", {
      description: "Remove orphaned worker workspace directories",
      handler: async () => {
        if (!workspace) {
          display.print(c.boldRed("Cannot prune: no workspace directory configured."));
          return;
        }
        const removed = await workspace.prune();
        if (removed.length === 0) {
          display.print(c.sageGreen("Nothing to prune."));
        } else {
          for (const dir of removed) display.print(c.darkGray(`  Removed: ${dir}`));
          display.print(c.sageGreen(`Pruned ${removed.length} orphaned workspace(s).`));
        }
      },
    });
  }

  /**
   * Subscribe to workspace events (for progress display) and create the
   * workspace directory. Changes the process working directory to the workspace.
   * No-op if no workspace is configured.
   */
  async onCreate(): Promise<void> {
    const { workspace, display } = this;
    if (!workspace) return;

    workspace.on("clone-start", ({ repoUrl: url, dir }: { repoUrl: string; dir: string }) => {
      display.print(c.sageGreen(`[workspace] Cloning ${url} → ${dir}`));
    });
    workspace.on("npm-install", ({ dir }: { dir: string }) => {
      display.print(c.sageGreen(`[workspace] Installing dependencies in ${dir}`));
    });
    workspace.on("reset-start", ({ dir }: { dir: string }) => {
      display.print(c.sageGreen(`[workspace] Resetting ${dir}`));
    });
    workspace.on("reset-retry", ({ error }: { dir: string; error: string }) => {
      display.print(c.amber(`[workspace] Reset failed, retrying: ${error}`));
    });
    workspace.on("reset-reclone", ({ repoUrl: url, dir, error }: { dir: string; error: string; repoUrl: string }) => {
      display.print(c.amber(`[workspace] Reset failed again, re-cloning: ${error}`));
      display.print(c.sageGreen(`[workspace] Re-cloning ${url} → ${dir}`));
    });
    workspace.on("destroy", ({ dir }: { dir: string }) => {
      display.print(c.sageGreen(`[workspace] Destroying ${dir}`));
    });
    workspace.on("prune-start", ({ workspaceDir: dir }: { workspaceDir: string }) => {
      display.print(c.sageGreen(`[workspace] Pruning orphaned workspaces in ${dir}`));
    });
    workspace.on("prune-remove", ({ dir }: { dir: string }) => {
      display.print(c.sageGreen(`[workspace] Removing orphaned workspace ${dir}`));
    });

    await workspace.create();
    process.chdir(workspace.dir);
  }

  /**
   * Reset the workspace to a clean state after a task completes. Used as the
   * `afterTask` callback in WorkerSession — throws on cancellation or failure
   * so the task is NOT marked complete when reset fails.
   * No-op if no workspace is configured.
   */
  async onReset(): Promise<void> {
    const { workspace, display } = this;
    if (!workspace) return;

    const ok = await confirmIfUnsafe(workspace, workspace.confirm);
    if (!ok) {
      display.print(c.amber("Workspace reset cancelled. Task not marked complete."));
      throw new Error("cancelled");
    }
    try {
      await workspace.reset();
    } catch (err) {
      display.print(c.boldRed(`Workspace reset failed: ${fmtError(err)}. Task not marked complete.`));
      throw err;
    }
  }

  /**
   * Confirm if unsafe, then destroy the workspace. Used during clean shutdown
   * (^D, /exit, SIGINT). No-op if no workspace is configured or not yet created.
   */
  async onDestroy(): Promise<void> {
    const { workspace } = this;
    if (!workspace?.isCreated) return;
    const ok = await confirmIfUnsafe(workspace, workspace.confirm);
    if (ok) await workspace.destroy();
  }

  /**
   * Destroy the workspace immediately without prompting. Used on SIGTERM
   * (system/orchestrator shutdown). No-op if no workspace is configured
   * or not yet created.
   */
  async onForceDestroy(): Promise<void> {
    const { workspace } = this;
    if (!workspace?.isCreated) return;
    await workspace.destroy();
  }
}
