import { c } from "../views/display.js";
import type { CommandRegistry } from "./command-controller.js";
import type { WorkerDisplay } from "./worker-controller.js";
import { confirmIfUnsafe } from "../models/workspace.js";
import type { Workspace } from "../models/workspace.js";

/**
 * Register workspace commands into the given registry (which should already be
 * scoped, e.g. registry.scoped("workspace")). Call this once at startup.
 *
 * Pass `undefined` when no GitHub repo is configured — commands that require
 * a workspace will print an appropriate error message.
 */
export function registerWorkspaceCommands(workspace: Workspace | undefined, registry: CommandRegistry, display: WorkerDisplay): void {
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
