import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

export class GithubToken {
  constructor(private readonly config: { githubToken?: string }) {}

  /**
   * Resolve a GitHub token in priority order:
   * 1. Config/env token (GITHUB_TOKEN / BRUNEL_GITHUB_TOKEN)
   * 2. gh CLI (`gh auth token`)
   *
   * Returns null if no token is available.
   */
  async resolve(): Promise<string | null> {
    if (this.config.githubToken) return this.config.githubToken;
    return this._fromCli();
  }

  private async _fromCli(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("gh", ["auth", "token"]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
}
