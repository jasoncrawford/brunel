import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import * as display from "./display.js";
import { verbose } from "./display.js";
import { fmtError } from "../utils.js";
import type { CommandRegistry } from "./command-registry.js";

const execFileAsync = promisify(execFileCb);

export type GitExec = (args: string[], cwd?: string) => Promise<string>;
export type NpmExec = (args: string[], cwd: string) => Promise<string>;

const defaultGitExec: GitExec = async (args, cwd) => {
  const { stdout } = await execFileAsync("git", args, cwd ? { cwd } : {});
  return stdout.trimEnd();
};

const defaultNpmExec: NpmExec = async (args, cwd) => {
  const { stdout } = await execFileAsync("npm", args, { cwd });
  return stdout.trimEnd();
};

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class Workspace {
  readonly dir: string;
  readonly workspaceDir: string;
  isCreated = false;

  constructor(
    workspaceDir: string,
    readonly sessionId: string,
    private readonly repoUrl: string,
    readonly originalCwd: string,
    readonly confirm: (msg: string) => Promise<boolean>,
    private readonly exec: GitExec = defaultGitExec,
    private readonly npm: NpmExec = defaultNpmExec,
  ) {
    this.workspaceDir = workspaceDir;
    this.dir = path.join(workspaceDir, sessionId);
  }

  /**
   * Clone the repo into workspaceDir/sessionId if not already present.
   * Runs npm install after a fresh clone.
   * Writes a PID lockfile on every call.
   */
  async create(): Promise<void> {
    fs.mkdirSync(path.dirname(this.dir), { recursive: true });
    if (!fs.existsSync(path.join(this.dir, ".git"))) {
      if (fs.existsSync(this.dir)) fs.rmSync(this.dir, { recursive: true, force: true });
      display.print(display.c.sageGreen(`[workspace] Cloning ${this.repoUrl} → ${this.dir}`));
      await this.exec(["clone", this.repoUrl, this.dir], undefined);
      await this._npmInstall();
    }
    fs.writeFileSync(path.join(this.dir, ".brunel.lock"), String(process.pid));
    this.isCreated = true;
  }

  /**
   * Reset to a clean main branch.
   * Retries once on failure. If still failing, destroys and re-clones,
   * then retries one final time.
   */
  async reset(): Promise<void> {
    display.print(display.c.sageGreen(`[workspace] Resetting ${this.dir}`));
    try {
      await this._doReset();
      return;
    } catch (err) {
      display.print(display.c.amber(`[workspace] Reset failed, retrying: ${fmtError(err)}`));
    }
    try {
      await this._doReset();
      return;
    } catch (err) {
      display.print(display.c.amber(`[workspace] Reset failed again, re-cloning: ${fmtError(err)}`));
      fs.rmSync(this.dir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(this.dir), { recursive: true });
      display.print(display.c.sageGreen(`[workspace] Re-cloning ${this.repoUrl} → ${this.dir}`));
      await this.exec(["clone", this.repoUrl, this.dir], undefined);
      fs.writeFileSync(path.join(this.dir, ".brunel.lock"), String(process.pid));
      await this._doReset(); // throws if still broken — propagates to caller
    }
  }

  private async _doReset(): Promise<void> {
    await this.exec(["fetch", "origin"], this.dir);
    await this.exec(["checkout", "main"], this.dir);
    await this.exec(["reset", "--hard", "origin/main"], this.dir);
    await this.exec(["clean", "-fdx", "-e", "node_modules", "-e", ".env", "-e", ".brunel.lock"], this.dir);
    await this._npmInstall();
  }

  /** Run npm install if a package.json is present. */
  private async _npmInstall(): Promise<void> {
    if (!fs.existsSync(path.join(this.dir, "package.json"))) return;
    display.print(display.c.sageGreen(`[workspace] Installing dependencies in ${this.dir}`));
    await this.npm(["install"], this.dir);
  }

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

  /**
   * Remove orphaned workspace directories under workspaceDir.
   * A directory is orphaned if it has no .brunel.lock, or its lock PID is dead.
   * Active workers (live PID) are skipped.
   * Returns the list of directories removed.
   */
  static async prune(workspaceDir: string): Promise<string[]> {
    if (!fs.existsSync(workspaceDir)) return [];
    display.print(display.c.sageGreen(`[workspace] Pruning orphaned workspaces in ${workspaceDir}`));
    const entries = fs.readdirSync(workspaceDir, { withFileTypes: true });
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(workspaceDir, entry.name);
      const lockPath = path.join(dir, ".brunel.lock");
      if (fs.existsSync(lockPath)) {
        const pid = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
        if (isProcessAlive(pid)) {
          if (verbose) display.print(display.c.sageGreen(`[workspace] Skipping active workspace ${dir} (pid ${pid})`));
          continue;
        }
      }
      display.print(display.c.sageGreen(`[workspace] Removing orphaned workspace ${dir}`));
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    }
    return removed;
  }

  /** Remove the entire checkout directory. */
  async destroy(): Promise<void> {
    display.print(display.c.sageGreen(`[workspace] Destroying ${this.dir}`));
    fs.rmSync(this.dir, { recursive: true, force: true });
    this.isCreated = false;
  }
}

// ── Workspace command registration ────────────────────────────────────────────

/**
 * Register workspace commands into the given registry (which should already be
 * scoped, e.g. registry.scoped("workspace")). Call this once at startup.
 *
 * Pass `undefined` when no GitHub repo is configured — commands that require
 * a workspace will print an appropriate error message.
 */
export function registerWorkspaceCommands(workspace: Workspace | undefined, registry: CommandRegistry): void {
  registry.register("create", {
    description: "Create an isolated git checkout for this session",
    handler: async () => {
      if (!workspace) {
        display.print(display.c.boldRed("Cannot create workspace: no GitHub repo configured."));
        return;
      }
      if (workspace.isCreated) {
        display.print(display.c.amber(`Workspace already exists: ${workspace.dir}`));
        return;
      }
      await workspace.create();
      process.chdir(workspace.dir);
      display.print(display.c.sageGreen(`Workspace created: ${workspace.dir}`));
    },
  });

  registry.register("reset", {
    description: "Reset workspace to clean main branch",
    handler: async () => {
      if (!workspace?.isCreated) {
        display.print(display.c.boldRed("No workspace. Use /workspace:create first."));
        return;
      }
      const ok = await confirmIfUnsafe(workspace, workspace.confirm);
      if (!ok) return;
      await workspace.reset();
      display.print(display.c.sageGreen("Workspace reset to main."));
    },
  });

  registry.register("remove", {
    description: "Remove the workspace checkout for this session",
    handler: async () => {
      if (!workspace?.isCreated) {
        display.print(display.c.boldRed("No workspace in this session."));
        return;
      }
      const ok = await confirmIfUnsafe(workspace, workspace.confirm);
      if (!ok) return;
      await workspace.destroy();
      process.chdir(workspace.originalCwd);
      display.print(display.c.sageGreen(`Workspace removed. Now in: ${workspace.originalCwd}`));
    },
  });

  registry.register("prune", {
    description: "Remove orphaned worker workspace directories",
    handler: async () => {
      if (!workspace) {
        display.print(display.c.boldRed("Cannot prune: no workspace directory configured."));
        return;
      }
      const removed = await Workspace.prune(workspace.workspaceDir);
      if (removed.length === 0) {
        display.print(display.c.sageGreen("Nothing to prune."));
      } else {
        for (const dir of removed) display.print(display.c.darkGray(`  Removed: ${dir}`));
        display.print(display.c.sageGreen(`Pruned ${removed.length} orphaned workspace(s).`));
      }
    },
  });
}

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
