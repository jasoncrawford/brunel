import { cosmiconfig } from "cosmiconfig";
import { z } from "zod";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { fmtError } from "./utils.js";

const DEFAULT_TASK_LABEL = "brunel:ready";

// ── Permission modes ──────────────────────────────────────────────────────────

export const VALID_PERMISSION_MODES = [
  "default", "acceptEdits", "bypassPermissions", "plan", "dontAsk",
] as const satisfies readonly PermissionMode[];

// ── Schema ────────────────────────────────────────────────────────────────────

const boolPreprocess = (v: unknown) => {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return v; // pass through to let zod reject it
};

const BrunelConfigSchema = z.object({
  // ── Shared (foreman + worker) ───────────────────────────────────────────────

  /** GitHub repo in "owner/repo" format. Optional; workers detect it from git remote automatically. */
  githubRepo:     z.string().min(1).optional(),
  /** GitHub personal access token with `repo` scope. Prefer env var over config file. Optional for the foreman when GitHub App auth is configured; workers fall back to `gh auth token` if this is unset. */
  githubToken:    z.string().min(1).optional(),
  /** Issue label that triggers work (foreman picks up issues with this label). */
  taskLabel:      z.string().default(DEFAULT_TASK_LABEL),
  /** Enable verbose output (shows full Claude message stream). */
  verbose:        z.preprocess(boolPreprocess, z.boolean()).default(false),
  /** Show full agent thinking text. Defaults to the value of verbose. */
  thinkOutLoud:   z.preprocess(boolPreprocess, z.boolean()).optional(),
  /** Interval in ms between pings. Used by both foreman and worker to detect dead connections. */
  pingIntervalMs: z.coerce.number().int().positive().default(25_000),

  // ── Foreman-only ───────────────────────────────────────────────────────────

  /** Port the foreman HTTP/WebSocket server listens on. */
  port:           z.coerce.number().int().positive().default(3000),
  /** GitHub webhook secret for signature verification. Optional; skip for local dev. */
  webhookSecret:  z.string().optional(),
  /** GitHub API base URL. Override for testing with a local mock server. */
  githubApiUrl:   z.string().default("https://api.github.com"),

  // ── Worker-only ────────────────────────────────────────────────────────────

  /** WebSocket URL that workers connect to. */
  foremanUrl:     z.string().default("wss://brunel.dev"),
  /** Maximum reconnect delay in ms. Reconnect uses full jitter: random(0, min(cap, 1s * 2^attempt)). */
  maxReconnectDelayMs: z.coerce.number().int().positive().default(300_000),
  /** Claude permission mode for worker sessions. */
  permissionMode: z.enum(VALID_PERMISSION_MODES).default("default"),
  /** Base directory for worker checkout directories. Defaults to ~/.brunel/workers at runtime. */
  workspaceDir:   z.string().optional(),
  /** Override the git repo URL used for workspace clones. Defaults to https://github.com/{repo}.git. */
  repoUrl:        z.string().optional(),
  /** Claude model alias (e.g. 'sonnet', 'opus') or full model ID (e.g. 'claude-sonnet-4-6'). */
  model:          z.string().optional(),
  /** Effort level for Claude's thinking/reasoning: low, medium, high, max, or auto (default). */
  effort:         z.enum(["low", "medium", "high", "max", "auto"]).optional(),

  // ── Cloud deployment ───────────────────────────────────────────────────────

  /** Supabase project URL. Optional; required for cloud deployment. */
  supabaseUrl:            z.string().optional(),
  /** Supabase secret key. Optional; required for cloud deployment. Prefer env var over config file. */
  supabaseSecretKey: z.string().optional(),
  /** Shared secret used to authenticate workers connecting to the foreman. Optional. Prefer env var over config file. */
  workerSecret:           z.string().optional(),

  // ── GitHub App ─────────────────────────────────────────────────────────────

  /** GitHub App ID. Optional; required for App-based auth. */
  appId:               z.string().optional(),
  /** PEM private key for signing GitHub App JWTs. Optional; required for App-based auth. Prefer env var over config file. */
  appPrivateKey:       z.string().optional(),
  /** Webhook secret for verifying GitHub App webhook signatures. Optional. Prefer env var over config file. */
  appWebhookSecret:    z.string().optional(),
});

export type BrunelConfig = Omit<z.infer<typeof BrunelConfigSchema>, "thinkOutLoud" | "effort"> & {
  thinkOutLoud: boolean;
  allowDangerouslySkipPermissions: boolean;
  /** Resolved effort level. "auto" in config is normalized to undefined here. */
  effort?: "low" | "medium" | "high" | "max";
};

// ── Cosmiconfig explorer ──────────────────────────────────────────────────────

const explorer = cosmiconfig("brunel", {
  searchStrategy: "none",
  loaders: {
    ".ts": async (filepath: string) => {
      const mod = await import(filepath);
      return mod.default ?? mod;
    },
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Config keys whose values should never be committed to source control. */
const SECRET_KEYS = ["githubToken", "webhookSecret", "supabaseSecretKey", "workerSecret", "appPrivateKey", "appWebhookSecret"] as const;

function warnIfSecretsInFile(
  config: Record<string, unknown>,
  filepath: string | undefined,
): void {
  for (const key of SECRET_KEYS) {
    if (config[key] !== undefined && config[key] !== "") {
      const loc = filepath ? ` (${filepath})` : "";
      console.warn(
        `[brunel] Warning: "${key}" found in config file${loc}. ` +
        `Use the BRUNEL_${camelToScreamingSnake(key)} env var instead to avoid committing secrets.`
      );
    }
  }
}

/** Converts a camelCase key to SCREAMING_SNAKE_CASE (e.g. "githubRepo" → "GITHUB_REPO"). */
function camelToScreamingSnake(key: string): string {
  return key.replace(/([A-Z])/g, "_$1").toUpperCase();
}

/** Converts a camelCase key to kebab-case (e.g. "githubRepo" → "github-repo"). */
function camelToKebab(key: string): string {
  return key.replace(/([A-Z])/g, "-$1").toLowerCase();
}

function parseCliFlags(argv: string[]): Record<string, unknown> {
  const flags: Record<string, unknown> = {};

  const hasDangerous = argv.includes("--dangerously-skip-permissions");
  const modeIdx = argv.indexOf("--permission-mode");
  let explicitMode: string | null = null;

  if (modeIdx !== -1) {
    const next = argv[modeIdx + 1];
    if (!next || next.startsWith("--")) {
      process.stderr.write(
        `Error: --permission-mode requires a value. Valid modes: ${VALID_PERMISSION_MODES.join(", ")}\n`
      );
      process.exit(1);
    }
    if (!(VALID_PERMISSION_MODES as readonly string[]).includes(next)) {
      process.stderr.write(
        `Error: Unknown permission mode "${next}". Valid modes: ${VALID_PERMISSION_MODES.join(", ")}\n`
      );
      process.exit(1);
    }
    explicitMode = next;
  }

  if (hasDangerous && explicitMode !== null && explicitMode !== "bypassPermissions") {
    process.stderr.write(
      `Error: --dangerously-skip-permissions conflicts with --permission-mode ${explicitMode}. ` +
      `Use --permission-mode bypassPermissions or omit --permission-mode.\n`
    );
    process.exit(1);
  }

  if (hasDangerous || explicitMode === "bypassPermissions") {
    flags.permissionMode = "bypassPermissions";
  } else if (explicitMode) {
    flags.permissionMode = explicitMode;
  }

  if (argv.includes("--verbose")) flags.verbose = true;

  // Secret flags: parse value and warn about exposure risk
  for (const key of SECRET_KEYS) {
    const flag = `--${camelToKebab(key)}`;
    const idx = argv.indexOf(flag);
    if (idx !== -1) {
      const next = argv[idx + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        console.warn(
          `[brunel] Warning: ${flag} exposes your secret in shell history and process listings. ` +
          `Use BRUNEL_${camelToScreamingSnake(key)} env var instead.`
        );
      }
    }
  }

  // Simple key-value flags: derived from schema keys via camelToKebab.
  // Keys handled separately above (permissionMode, verbose, and secret keys) are excluded.
  const SPECIAL_KEYS = new Set<string>(["permissionMode", "verbose", ...SECRET_KEYS]);
  for (const key of Object.keys(BrunelConfigSchema.shape)) {
    if (SPECIAL_KEYS.has(key)) continue;
    const flag = `--${camelToKebab(key)}`;
    const idx = argv.indexOf(flag);
    if (idx !== -1) {
      const next = argv[idx + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
      }
    }
  }

  return flags;
}

/** CLI flags that are boolean (take no value argument). */
const BOOLEAN_CLI_FLAGS = new Set(["--verbose", "--dangerously-skip-permissions"]);

/**
 * Parse a command invocation from CLI argv.
 * Returns the first positional arg (not a flag or its value) as the command name,
 * and any subsequent positional args joined with spaces as the args string.
 * Returns null if no positional args are present.
 *
 * Example: ["node", "brunel.js", "--effort", "high", "worker:claim", "512"]
 *   → { command: "worker:claim", args: "512" }
 */
export function parseCommandFromArgs(argv: string[]): { command: string; args: string } | null {
  const args = argv.slice(2);
  const consumed = new Set<number>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    consumed.add(i);
    if (BOOLEAN_CLI_FLAGS.has(arg)) continue;
    // All other --flags consume the next arg as their value.
    if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
      consumed.add(i + 1);
      i++;
    }
  }

  const positional = args.filter((_, i) => !consumed.has(i));
  if (positional.length === 0) return null;
  return { command: positional[0], args: positional.slice(1).join(" ") };
}

function readBrunelEnvVars(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(BrunelConfigSchema.shape)) {
    const envKey = `BRUNEL_${camelToScreamingSnake(key)}`;
    if (env[envKey] !== undefined) result[key] = env[envKey];
  }
  return result;
}

function readFallbackEnvVars(env: NodeJS.ProcessEnv): Record<string, unknown> {
  // Legacy env var names supported for backward compatibility.
  // These are intentionally hardcoded — they don't follow the BRUNEL_* pattern
  // and the set is fixed (we won't add new legacy names as the system evolves).
  const result: Record<string, unknown> = {};
  if (env.GITHUB_REPO)     result.githubRepo    = env.GITHUB_REPO;
  if (env.GITHUB_TOKEN)    result.githubToken   = env.GITHUB_TOKEN;
  else if (env.GH_TOKEN)   result.githubToken   = env.GH_TOKEN;
  if (env.TASK_LABEL)      result.taskLabel     = env.TASK_LABEL;
  if (env.PORT)            result.port          = env.PORT;
  if (env.WEBHOOK_SECRET)  result.webhookSecret = env.WEBHOOK_SECRET;
  return result;
}

// ── Config singleton ──────────────────────────────────────────────────────────

let _config: BrunelConfig | null = null;

/**
 * Returns the loaded config. Throws if called before loadConfig() completes.
 * Entry points call loadConfig() before anything else, so this is always
 * safe by the time any module reads it at runtime.
 */
export function getConfig(): BrunelConfig {
  if (!_config) throw new Error("Config not initialized — call loadConfig() first");
  return _config;
}

// ── loadConfig ────────────────────────────────────────────────────────────────

export async function loadConfig(
  argv: string[],
  fileConfigOverride?: Record<string, unknown>,
): Promise<BrunelConfig> {
  // 1. File config
  let fileConfig: Record<string, unknown> = {};
  let filepath: string | undefined;
  if (fileConfigOverride !== undefined) {
    fileConfig = fileConfigOverride;
  } else {
    const result = await explorer.search();
    fileConfig = result?.config ?? {};
    filepath = result?.filepath;
  }
  warnIfSecretsInFile(fileConfig, filepath);

  // 2. CLI flags
  const cliFlags = parseCliFlags(argv);

  // 3. Env vars (BRUNEL_* then fallback)
  const brunelEnv = readBrunelEnvVars(process.env);
  const fallbackEnv = readFallbackEnvVars(process.env);

  // 4. Merge (later wins) and validate
  const raw = { ...fallbackEnv, ...fileConfig, ...brunelEnv, ...cliFlags };

  let parsed: z.infer<typeof BrunelConfigSchema>;
  try {
    parsed = BrunelConfigSchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      process.stderr.write(
        `Error: Invalid configuration:\n` +
        err.issues.map((e) => `  ${e.path.join(".") || "(root)"}: ${e.message}`).join("\n") + "\n"
      );
    } else {
      process.stderr.write(`Error: ${fmtError(err)}\n`);
    }
    process.exit(1);
    // Satisfy TypeScript — process.exit never returns but TS doesn't know that
    return {} as BrunelConfig;
  }

  const result: BrunelConfig = {
    ...parsed,
    thinkOutLoud: parsed.thinkOutLoud ?? parsed.verbose,
    allowDangerouslySkipPermissions: parsed.permissionMode === "bypassPermissions",
    effort: parsed.effort === "auto" ? undefined : parsed.effort,
  };
  _config = result;
  return result;
}

/**
 * Returns a config object populated with schema defaults. Useful in tests
 * that need default values (e.g. taskLabel) without a real GitHub repo or .env.
 * Passes a placeholder githubToken so GithubClient.resolveToken() doesn't throw
 * in tests that exercise code paths involving GithubClient (fetch is mocked separately).
 */
export function loadDefaultConfig(): Promise<BrunelConfig> {
  return loadConfig([], { githubToken: "tok" });
}
