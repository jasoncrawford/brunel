import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { fmtError } from "../../utils.js";

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

export class Workspace extends EventEmitter {
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
    private readonly githubToken?: string,
  ) {
    super();
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
      this.emit("create-start", { dir: this.dir });
      this.emit("clone-start", { repoUrl: this.repoUrl, dir: this.dir });
      await this.exec(["clone", this.repoUrl, this.dir], undefined);
      await this._configureAuth();
      await this._npmInstall();
    }
    fs.writeFileSync(path.join(this.dir, ".brunel.lock"), String(process.pid));
    this._ensureLocallyIgnored(".brunel.lock");
    this.isCreated = true;
  }

  /**
   * Reset to a clean main branch.
   * Retries once on failure. If still failing, destroys and re-clones,
   * then retries one final time.
   */
  async reset(): Promise<void> {
    this.emit("reset-start", { dir: this.dir });
    try {
      await this._doReset();
      return;
    } catch (err) {
      this.emit("reset-retry", { dir: this.dir, error: fmtError(err) });
    }
    try {
      await this._doReset();
      return;
    } catch (err) {
      this.emit("reset-reclone", { dir: this.dir, error: fmtError(err), repoUrl: this.repoUrl });
      fs.rmSync(this.dir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(this.dir), { recursive: true });
      this.emit("clone-start", { repoUrl: this.repoUrl, dir: this.dir });
      await this.exec(["clone", this.repoUrl, this.dir], undefined);
      await this._configureAuth();
      fs.writeFileSync(path.join(this.dir, ".brunel.lock"), String(process.pid));
      this._ensureLocallyIgnored(".brunel.lock");
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

  /** Set http.extraHeader so git auth uses a Bearer token instead of a token-in-URL. */
  private async _configureAuth(): Promise<void> {
    if (!this.githubToken) return;
    await this.exec(
      ["config", "--local", "http.https://github.com/.extraheader", `Authorization: Bearer ${this.githubToken}`],
      this.dir,
    );
  }

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

  /** Run npm install if a package.json is present. */
  private async _npmInstall(): Promise<void> {
    if (!fs.existsSync(path.join(this.dir, "package.json"))) return;
    this.emit("npm-install", { dir: this.dir });
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
      } else {
        throw err;
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
  async prune(): Promise<string[]> {
    this.emit("prune-start", { workspaceDir: this.workspaceDir });
    if (!fs.existsSync(this.workspaceDir)) return [];
    const entries = fs.readdirSync(this.workspaceDir, { withFileTypes: true });
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.workspaceDir, entry.name);
      const lockPath = path.join(dir, ".brunel.lock");
      if (fs.existsSync(lockPath)) {
        const pid = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
        if (isProcessAlive(pid)) {
          this.emit("prune-skip", { dir, pid });
          continue;
        }
      }
      this.emit("prune-remove", { dir });
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    }
    return removed;
  }

  /** Remove the entire checkout directory. */
  async destroy(): Promise<void> {
    this.emit("destroy", { dir: this.dir });
    fs.rmSync(this.dir, { recursive: true, force: true });
    this.isCreated = false;
  }
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
