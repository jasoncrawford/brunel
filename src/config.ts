import { cosmiconfig } from "cosmiconfig";
import { z } from "zod";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

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
  githubRepo:     z.string().min(1),
  githubToken:    z.string().min(1),
  taskLabel:      z.string().default("brunel:ready"),
  doneLabel:      z.string().default("brunel:done"),
  verbose:        z.preprocess(boolPreprocess, z.boolean()).default(false),
  port:           z.coerce.number().int().positive().default(3000),
  webhookSecret:  z.string().optional(),
  foremanUrl:     z.string().default("ws://localhost:3000"),
  permissionMode: z.enum(VALID_PERMISSION_MODES).default("default"),
});

export type BrunelConfig = z.infer<typeof BrunelConfigSchema> & {
  allowDangerouslySkipPermissions: boolean;
};

// ── Cosmiconfig explorer ──────────────────────────────────────────────────────

const explorer = cosmiconfig("brunel", {
  loaders: {
    ".ts": async (filepath: string) => {
      const mod = await import(filepath);
      return mod.default ?? mod;
    },
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function warnIfSecretsInFile(
  config: Record<string, unknown>,
  filepath: string | undefined,
): void {
  const secretKeys = ["githubToken", "webhookSecret"] as const;
  for (const key of secretKeys) {
    if (config[key] !== undefined && config[key] !== "") {
      const loc = filepath ? ` (${filepath})` : "";
      console.warn(
        `[brunel] Warning: "${key}" found in config file${loc}. ` +
        `Use the BRUNEL_${key === "githubToken" ? "GITHUB_TOKEN" : "WEBHOOK_SECRET"} env var instead to avoid committing secrets.`
      );
    }
  }
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

  // --github-token: warn about exposure
  const tokenIdx = argv.indexOf("--github-token");
  if (tokenIdx !== -1) {
    const next = argv[tokenIdx + 1];
    if (next && !next.startsWith("--")) {
      flags.githubToken = next;
      console.warn(
        "[brunel] Warning: --github-token exposes your token in shell history and process listings. " +
        "Use BRUNEL_GITHUB_TOKEN env var instead."
      );
    }
  }

  // Simple key-value flags
  const flagMap: Array<[string, string]> = [
    ["--github-repo",    "githubRepo"],
    ["--task-label",     "taskLabel"],
    ["--done-label",     "doneLabel"],
    ["--port",           "port"],
    ["--webhook-secret", "webhookSecret"],
    ["--foreman-url",    "foremanUrl"],
  ];

  for (const [flag, key] of flagMap) {
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
  const map: Array<[string, string]> = [
    ["BRUNEL_GITHUB_REPO",      "githubRepo"],
    ["BRUNEL_GITHUB_TOKEN",     "githubToken"],
    ["BRUNEL_TASK_LABEL",       "taskLabel"],
    ["BRUNEL_DONE_LABEL",       "doneLabel"],
    ["BRUNEL_VERBOSE",          "verbose"],
    ["BRUNEL_PORT",             "port"],
    ["BRUNEL_WEBHOOK_SECRET",   "webhookSecret"],
    ["BRUNEL_FOREMAN_URL",      "foremanUrl"],
    ["BRUNEL_PERMISSION_MODE",  "permissionMode"],
  ];
  for (const [envKey, configKey] of map) {
    if (env[envKey] !== undefined) result[configKey] = env[envKey];
  }
  return result;
}

function readFallbackEnvVars(env: NodeJS.ProcessEnv): Record<string, unknown> {
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
    allowDangerouslySkipPermissions: parsed.permissionMode === "bypassPermissions",
  };
}
