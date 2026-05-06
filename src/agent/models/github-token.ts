import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

export type GhExec = (cmd: string, args: string[]) => Promise<string>;

const defaultGhExec: GhExec = async (cmd, args) => {
  const { stdout } = await execFileAsync(cmd, args);
  return stdout;
};

/**
 * Try to get a GitHub token from the gh CLI (`gh auth token`).
 * Returns the token string, or null if gh is not installed, not authenticated,
 * or the command fails for any reason.
 */
export async function resolveGithubTokenFromCli(exec: GhExec = defaultGhExec): Promise<string | null> {
  try {
    const output = await exec("gh", ["auth", "token"]);
    const token = output.trim();
    return token || null;
  } catch {
    return null;
  }
}

export type ResolveGithubTokenOptions = {
  /** Token from gh CLI (pass null if not available or failed). */
  cliToken: string | null;
  /** Token from config/env vars (may be undefined if not set). */
  configToken: string | undefined;
  /** Async function to prompt the user for a token. Called only as last resort. */
  promptFn?: () => Promise<string | null>;
};

/**
 * Resolve a GitHub token using the priority order:
 * 1. gh CLI token (cliToken)
 * 2. Config/env-var token (configToken)
 * 3. Prompt the user (promptFn)
 *
 * Returns null if no token could be resolved.
 */
export async function resolveGithubToken(opts: ResolveGithubTokenOptions): Promise<string | null> {
  if (opts.cliToken) return opts.cliToken;
  if (opts.configToken) return opts.configToken;
  if (opts.promptFn) return opts.promptFn();
  return null;
}
