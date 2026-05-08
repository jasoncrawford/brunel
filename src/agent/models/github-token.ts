import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

export const GithubToken = {
  /** Try `gh auth token`. Returns the token string, or null on any failure. */
  async fromCli(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("gh", ["auth", "token"]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  },

  /**
   * Resolve a GitHub token in priority order:
   * 1. gh CLI (`gh auth token`)
   * 2. configToken (from GITHUB_TOKEN / BRUNEL_GITHUB_TOKEN env / config file)
   *
   * Returns null if no token is available.
   */
  async resolve(configToken?: string): Promise<string | null> {
    const cliToken = await this.fromCli();
    if (cliToken) return cliToken;
    if (configToken) return configToken;
    return null;
  },
};
