import { cosmiconfig } from "cosmiconfig";
import { z } from "zod";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

// ── Permission modes ──────────────────────────────────────────────────────────

export const VALID_PERMISSION_MODES = [
  "default", "acceptEdits", "bypassPermissions", "plan", "dontAsk",
] as const satisfies readonly PermissionMode[];

// ── Schema defaults (exported so other modules don't duplicate these values) ──

const DEFAULT_TASK_LABEL = "brunel:ready";
const DEFAULT_DONE_LABEL = "brunel:done";
const DEFAULT_WORKER_RECLAIM_TIMEOUT_MS = 300_000;

// ── Schema ────────────────────────────────────────────────────────────────────

const boolPreprocess = (v: unknown) => {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return v; // pass through to let zod reject it
};

const BrunelConfigSchema = z.object({
  // ── Shared (foreman + worker) ───────────────────────────────────────────────

  /** GitHub repo in "owner/repo" format. Required. */
  githubRepo:     z.string().min(1),
  /** GitHub personal access token with `repo` scope. Required. Prefer env var over config file. */
  githubToken:    z.string().min(1),
  /** Issue label that triggers work (foreman picks up issues with this label). */
  taskLabel:      z.string().default(DEFAULT_TASK_LABEL),
  /** Issue label applied to issues when work is complete. */
  doneLabel:      z.string().default(DEFAULT_DONE_LABEL),
  /** Enable verbose output (shows full Claude message stream). */
  verbose:        z.preprocess(boolPreprocess, z.boolean()).default(false),
  /** Show full agent thinking text. Defaults to the value of verbose. */
  thinkOutLoud:   z.preprocess(boolPreprocess, z.boolean()).optional(),

  // ── Foreman-only ───────────────────────────────────────────────────────────

  /** Port the foreman HTTP/WebSocket server listens on. */
  port:           z.coerce.number().int().positive().default(3000),
  /** GitHub webhook secret for signature verification. Optional; skip for local dev. */
  webhookSecret:  z.string().optional(),
  /** GitHub API base URL. Override for testing with a local mock server. */
  githubApiUrl:   z.string().default("https://api.github.com"),

  // ── Worker-only ────────────────────────────────────────────────────────────

  /** WebSocket URL that workers connect to. */
  foremanUrl:     z.string().default("ws://localhost:3000"),
  /** Claude permission mode for worker sessions. */
  permissionMode: z.enum(VALID_PERMISSION_MODES).default("default"),
  /** Base directory for worker checkout directories. Defaults to ~/.brunel/workers at runtime. */
  workspaceDir:   z.string().optional(),
  /** Override the git repo URL used for workspace clones. Defaults to https://{token}@github.com/{repo}.git. */
  repoUrl:        z.string().optional(),

  // ── Cloud deployment ───────────────────────────────────────────────────────

  /** Supabase project URL. Optional; required for cloud deployment. */
  supabaseUrl:            z.string().optional(),
  /** Supabase secret key. Optional; required for cloud deployment. Prefer env var over config file. */
  supabaseSecretKey: z.string().optional(),
  /** Shared secret used to authenticate workers connecting to the foreman. Optional. Prefer env var over config file. */
  workerSecret:           z.string().optional(),
  /** How long (ms) to wait before reclaiming a disconnected worker's task. Default: 5 minutes. */
  workerReclaimTimeoutMs: z.coerce.number().int().positive().default(DEFAULT_WORKER_RECLAIM_TIMEOUT_MS),
});

export type BrunelConfig = Omit<z.infer<typeof BrunelConfigSchema>, "thinkOutLoud"> & {
  thinkOutLoud: boolean;
  allowDangerouslySkipPermissions: boolean;
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
const SECRET_KEYS = ["githubToken", "webhookSecret", "supabaseSecretKey", "workerSecret"] as const;

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
  if (env.DONE_LABEL)      result.doneLabel     = env.DONE_LABEL;
  if (env.PORT)            result.port          = env.PORT;
  if (env.WEBHOOK_SECRET)  result.webhookSecret = env.WEBHOOK_SECRET;
  return result;
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
      process.stderr.write(`Error: ${err}\n`);
    }
    process.exit(1);
    // Satisfy TypeScript — process.exit never returns but TS doesn't know that
    return {} as BrunelConfig;
  }

  return {
    ...parsed,
    thinkOutLoud: parsed.thinkOutLoud ?? parsed.verbose,
    allowDangerouslySkipPermissions: parsed.permissionMode === "bypassPermissions",
  };
}
