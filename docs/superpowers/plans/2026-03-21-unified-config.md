# Unified Config System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a layered config system (`brunel.config.ts` file + env vars + CLI flags) with deterministic naming conventions and zod validation, replacing all scattered env var reads.

**Architecture:** New `src/config.ts` exports `loadConfig(argv, fileConfigOverride?)` which merges CLI flags > `BRUNEL_*` env vars > config file > fallback env vars > defaults, validates with zod, and returns a typed `BrunelConfig`. Entry points call it once at startup; all scattered `process.env.*` reads are removed.

**Tech Stack:** `cosmiconfig` (config file discovery), `zod` (validation/schema), TypeScript ESM, vitest

---

## Chunk 1: `src/config.ts` — the core module

**Files:**
- Create: `src/config.ts`
- Create: `tests/config.test.ts`

### Task 1: Install dependencies

- [ ] **Step 1: Install cosmiconfig and zod**

```bash
cd /workspace/.worktrees/issue-161-unified-config
npm install cosmiconfig zod
```

Expected: both added to `dependencies` in `package.json`

- [ ] **Step 2: Verify they import correctly**

```bash
node --input-type=module <<'EOF'
import { cosmiconfig } from "cosmiconfig";
import { z } from "zod";
console.log("ok");
EOF
```

Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git -C /workspace/.worktrees/issue-161-unified-config add package.json package-lock.json
git -C /workspace/.worktrees/issue-161-unified-config commit -m "chore: add cosmiconfig and zod dependencies"
```

---

### Task 2: Write `tests/config.test.ts` (failing first)

- [ ] **Step 1: Create the test file**

```typescript
// tests/config.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { loadConfig, VALID_PERMISSION_MODES } from "../src/config.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

let exitSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

// Save/restore a set of env var keys around each test
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "GITHUB_REPO", "GITHUB_TOKEN", "GH_TOKEN",
  "TASK_LABEL", "DONE_LABEL", "PORT", "WEBHOOK_SECRET",
  "BRUNEL_GITHUB_REPO", "BRUNEL_GITHUB_TOKEN",
  "BRUNEL_TASK_LABEL", "BRUNEL_DONE_LABEL",
  "BRUNEL_VERBOSE", "BRUNEL_PORT", "BRUNEL_WEBHOOK_SECRET",
  "BRUNEL_FOREMAN_URL", "BRUNEL_PERMISSION_MODE",
];

beforeEach(() => {
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as () => never);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// Minimal argv that satisfies required fields via env
function baseEnv() {
  process.env.BRUNEL_GITHUB_REPO = "owner/repo";
  process.env.BRUNEL_GITHUB_TOKEN = "tok";
}

// ── VALID_PERMISSION_MODES ────────────────────────────────────────────────────

describe("VALID_PERMISSION_MODES", () => {
  it("contains the five SDK modes", () => {
    expect(VALID_PERMISSION_MODES).toEqual(
      expect.arrayContaining(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"])
    );
    expect(VALID_PERMISSION_MODES).toHaveLength(5);
  });
});

// ── Defaults ─────────────────────────────────────────────────────────────────

describe("defaults", () => {
  it("returns correct defaults for all optional fields", async () => {
    baseEnv();
    const cfg = await loadConfig(["node", "repl.js"]);
    expect(cfg.taskLabel).toBe("brunel:ready");
    expect(cfg.doneLabel).toBe("brunel:done");
    expect(cfg.verbose).toBe(false);
    expect(cfg.port).toBe(3000);
    expect(cfg.webhookSecret).toBeUndefined();
    expect(cfg.foremanUrl).toBe("ws://localhost:3000");
    expect(cfg.permissionMode).toBe("default");
    expect(cfg.allowDangerouslySkipPermissions).toBe(false);
  });
});

// ── Required fields ───────────────────────────────────────────────────────────

describe("required field validation", () => {
  it("exits 1 when githubRepo is missing", async () => {
    process.env.BRUNEL_GITHUB_TOKEN = "tok";
    await loadConfig(["node", "repl.js"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits 1 when githubToken is missing", async () => {
    process.env.BRUNEL_GITHUB_REPO = "owner/repo";
    await loadConfig(["node", "repl.js"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ── Layer precedence ──────────────────────────────────────────────────────────

describe("layer precedence", () => {
  it("CLI flag beats BRUNEL_* env var", async () => {
    baseEnv();
    process.env.BRUNEL_TASK_LABEL = "env-label";
    const cfg = await loadConfig(["node", "repl.js", "--task-label", "cli-label"]);
    expect(cfg.taskLabel).toBe("cli-label");
  });

  it("BRUNEL_* env var beats file config", async () => {
    baseEnv();
    process.env.BRUNEL_TASK_LABEL = "env-label";
    const cfg = await loadConfig(["node", "repl.js"], { taskLabel: "file-label" });
    expect(cfg.taskLabel).toBe("env-label");
  });

  it("file config beats fallback env var", async () => {
    baseEnv();
    process.env.TASK_LABEL = "fallback-label";
    const cfg = await loadConfig(["node", "repl.js"], { taskLabel: "file-label" });
    expect(cfg.taskLabel).toBe("file-label");
  });

  it("fallback env var beats built-in default", async () => {
    baseEnv();
    process.env.TASK_LABEL = "fallback-label";
    const cfg = await loadConfig(["node", "repl.js"]);
    expect(cfg.taskLabel).toBe("fallback-label");
  });
});

// ── Legacy fallback env vars ──────────────────────────────────────────────────

describe("legacy fallback env vars", () => {
  it("GITHUB_REPO provides githubRepo", async () => {
    process.env.GITHUB_REPO = "owner/repo";
    process.env.BRUNEL_GITHUB_TOKEN = "tok";
    const cfg = await loadConfig(["node", "repl.js"]);
    expect(cfg.githubRepo).toBe("owner/repo");
  });

  it("GITHUB_TOKEN provides githubToken", async () => {
    process.env.BRUNEL_GITHUB_REPO = "owner/repo";
    process.env.GITHUB_TOKEN = "gh-tok";
    const cfg = await loadConfig(["node", "repl.js"]);
    expect(cfg.githubToken).toBe("gh-tok");
  });

  it("GH_TOKEN provides githubToken when GITHUB_TOKEN absent", async () => {
    process.env.BRUNEL_GITHUB_REPO = "owner/repo";
    process.env.GH_TOKEN = "ghat";
    const cfg = await loadConfig(["node", "repl.js"]);
    expect(cfg.githubToken).toBe("ghat");
  });

  it("GITHUB_TOKEN wins over GH_TOKEN", async () => {
    process.env.BRUNEL_GITHUB_REPO = "owner/repo";
    process.env.GITHUB_TOKEN = "primary";
    process.env.GH_TOKEN = "secondary";
    const cfg = await loadConfig(["node", "repl.js"]);
    expect(cfg.githubToken).toBe("primary");
  });

  it("TASK_LABEL, DONE_LABEL, PORT, WEBHOOK_SECRET all resolve", async () => {
    baseEnv();
    process.env.TASK_LABEL = "my-task";
    process.env.DONE_LABEL = "my-done";
    process.env.PORT = "4567";
    process.env.WEBHOOK_SECRET = "shh";
    const cfg = await loadConfig(["node", "repl.js"]);
    expect(cfg.taskLabel).toBe("my-task");
    expect(cfg.doneLabel).toBe("my-done");
    expect(cfg.port).toBe(4567);
    expect(cfg.webhookSecret).toBe("shh");
  });
});

// ── Boolean coercion ──────────────────────────────────────────────────────────

describe("boolean coercion for BRUNEL_VERBOSE", () => {
  it('"true" → true', async () => {
    baseEnv();
    process.env.BRUNEL_VERBOSE = "true";
    const cfg = await loadConfig(["node", "repl.js"]);
    expect(cfg.verbose).toBe(true);
  });

  it('"1" → true', async () => {
    baseEnv();
    process.env.BRUNEL_VERBOSE = "1";
    const cfg = await loadConfig(["node", "repl.js"]);
    expect(cfg.verbose).toBe(true);
  });

  it('"false" → false', async () => {
    baseEnv();
    process.env.BRUNEL_VERBOSE = "false";
    const cfg = await loadConfig(["node", "repl.js"]);
    expect(cfg.verbose).toBe(false);
  });

  it('"0" → false', async () => {
    baseEnv();
    process.env.BRUNEL_VERBOSE = "0";
    const cfg = await loadConfig(["node", "repl.js"]);
    expect(cfg.verbose).toBe(false);
  });

  it('"yes" → exit 1', async () => {
    baseEnv();
    process.env.BRUNEL_VERBOSE = "yes";
    await loadConfig(["node", "repl.js"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ── CLI flag parsing ──────────────────────────────────────────────────────────

describe("CLI flag parsing", () => {
  it("--verbose sets verbose: true", async () => {
    baseEnv();
    const cfg = await loadConfig(["node", "repl.js", "--verbose"]);
    expect(cfg.verbose).toBe(true);
  });

  it("--port 4000 sets port: 4000", async () => {
    baseEnv();
    const cfg = await loadConfig(["node", "repl.js", "--port", "4000"]);
    expect(cfg.port).toBe(4000);
  });

  it("--port abc exits 1", async () => {
    baseEnv();
    await loadConfig(["node", "repl.js", "--port", "abc"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("--github-repo overrides BRUNEL_GITHUB_REPO", async () => {
    baseEnv();
    const cfg = await loadConfig(["node", "repl.js", "--github-repo", "other/repo"]);
    expect(cfg.githubRepo).toBe("other/repo");
  });

  it("--task-label overrides env", async () => {
    baseEnv();
    const cfg = await loadConfig(["node", "repl.js", "--task-label", "my:task"]);
    expect(cfg.taskLabel).toBe("my:task");
  });

  it("--done-label overrides env", async () => {
    baseEnv();
    const cfg = await loadConfig(["node", "repl.js", "--done-label", "my:done"]);
    expect(cfg.doneLabel).toBe("my:done");
  });

  it("--foreman-url sets foremanUrl", async () => {
    baseEnv();
    const cfg = await loadConfig(["node", "repl.js", "--foreman-url", "ws://other:9000"]);
    expect(cfg.foremanUrl).toBe("ws://other:9000");
  });

  it("--webhook-secret sets webhookSecret", async () => {
    baseEnv();
    const cfg = await loadConfig(["node", "repl.js", "--webhook-secret", "mysecret"]);
    expect(cfg.webhookSecret).toBe("mysecret");
  });
});

// ── Secrets warnings ──────────────────────────────────────────────────────────

describe("secrets warnings", () => {
  it("warns when githubToken in file config", async () => {
    process.env.BRUNEL_GITHUB_REPO = "owner/repo";
    await loadConfig(["node", "repl.js"], { githubToken: "file-tok" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("githubToken"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[brunel]"));
  });

  it("warns when webhookSecret in file config", async () => {
    baseEnv();
    await loadConfig(["node", "repl.js"], { webhookSecret: "shh" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("webhookSecret"));
  });

  it("does NOT warn when token from env var", async () => {
    baseEnv();
    await loadConfig(["node", "repl.js"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns when --github-token passed as CLI flag", async () => {
    process.env.BRUNEL_GITHUB_REPO = "owner/repo";
    await loadConfig(["node", "repl.js", "--github-token", "tok"]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("--github-token"));
  });
});

// ── Permission mode flags ─────────────────────────────────────────────────────

describe("permission mode", () => {
  it("--permission-mode acceptEdits sets mode", async () => {
    baseEnv();
    const cfg = await loadConfig(["node", "repl.js", "--permission-mode", "acceptEdits"]);
    expect(cfg.permissionMode).toBe("acceptEdits");
    expect(cfg.allowDangerouslySkipPermissions).toBe(false);
  });

  it("--permission-mode bypassPermissions sets allowDangerouslySkipPermissions: true", async () => {
    baseEnv();
    const cfg = await loadConfig(["node", "repl.js", "--permission-mode", "bypassPermissions"]);
    expect(cfg.permissionMode).toBe("bypassPermissions");
    expect(cfg.allowDangerouslySkipPermissions).toBe(true);
  });

  it("--dangerously-skip-permissions → bypassPermissions + allowBypass: true", async () => {
    baseEnv();
    const cfg = await loadConfig(["node", "repl.js", "--dangerously-skip-permissions"]);
    expect(cfg.permissionMode).toBe("bypassPermissions");
    expect(cfg.allowDangerouslySkipPermissions).toBe(true);
  });

  it("BRUNEL_PERMISSION_MODE=bypassPermissions → allowDangerouslySkipPermissions: true", async () => {
    baseEnv();
    process.env.BRUNEL_PERMISSION_MODE = "bypassPermissions";
    const cfg = await loadConfig(["node", "repl.js"]);
    expect(cfg.allowDangerouslySkipPermissions).toBe(true);
  });

  it("--dangerously-skip-permissions + --permission-mode default → exit 1", async () => {
    baseEnv();
    await loadConfig(["node", "repl.js", "--dangerously-skip-permissions", "--permission-mode", "default"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("--permission-mode with no value → exit 1", async () => {
    baseEnv();
    await loadConfig(["node", "repl.js", "--permission-mode"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("--permission-mode unknown value → exit 1", async () => {
    baseEnv();
    await loadConfig(["node", "repl.js", "--permission-mode", "badval"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("--permission-mode followed by another flag → exit 1", async () => {
    baseEnv();
    await loadConfig(["node", "repl.js", "--permission-mode", "--verbose"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("BRUNEL_PERMISSION_MODE=badvalue → exit 1", async () => {
    baseEnv();
    process.env.BRUNEL_PERMISSION_MODE = "badvalue";
    await loadConfig(["node", "repl.js"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /workspace/.worktrees/issue-161-unified-config && npm test -- --reporter=verbose tests/config.test.ts 2>&1 | head -30
```

Expected: FAIL — `Cannot find module '../src/config.js'`

---

### Task 3: Implement `src/config.ts`

- [ ] **Step 1: Create `src/config.ts`**

```typescript
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
        err.errors.map((e) => `  ${e.path.join(".") || "(root)"}: ${e.message}`).join("\n") + "\n"
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
```

- [ ] **Step 2: Run config tests**

```bash
cd /workspace/.worktrees/issue-161-unified-config && npm test -- tests/config.test.ts 2>&1 | tail -15
```

Expected: all config tests pass

- [ ] **Step 3: Run full test suite**

```bash
cd /workspace/.worktrees/issue-161-unified-config && npm test 2>&1 | tail -10
```

Expected: all 685+ tests pass (config tests added, nothing broken)

- [ ] **Step 4: Commit**

```bash
git -C /workspace/.worktrees/issue-161-unified-config add src/config.ts tests/config.test.ts
git -C /workspace/.worktrees/issue-161-unified-config commit -m "feat: add src/config.ts with loadConfig, zod schema, and full test suite"
```

---

## Chunk 2: Refactor `github.ts` and `dependencies.ts`

**Files:**
- Modify: `src/github.ts`
- Modify: `src/dependencies.ts`
- Modify: `tests/foreman.github.test.ts`

### Task 4: Update `foreman.github.test.ts` for new explicit-opts signatures

- [ ] **Step 1: Replace the test file with this updated version**

```typescript
// tests/foreman.github.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadIssuesToQueue, labelIssueDone, fetchIssueStates, fetchNativeBlockers } from "../src/github.js";
import { TaskQueue } from "../src/foreman.js";
import { fetchBlockers } from "../src/dependencies.js";
import type { DependencyGraph } from "../src/dependencies.js";

vi.mock("../src/dependencies.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/dependencies.js")>();
  return { ...actual, fetchBlockers: vi.fn().mockResolvedValue([]) };
});

const OPTS = { repo: "owner/repo", token: "token123" };
const QUEUE_OPTS = { ...OPTS, taskLabel: "brunel:ready" };
const LABEL_OPTS = { ...OPTS, doneLabel: "brunel:done" };

const mockIssues = [
  { number: 1, title: "First issue", body: "body 1", labels: [{ name: "brunel:ready" }] },
  { number: 2, title: "Second issue", body: null, labels: [{ name: "brunel:ready" }] },
];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadIssuesToQueue", () => {
  it("fetches open issues with the task label and adds them to queue", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockIssues,
    } as any);

    const q = new TaskQueue();
    await loadIssuesToQueue(q, new Map(), new Set(), QUEUE_OPTS);

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("owner/repo/issues"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token123" }) }),
    );
    expect(q.get("1")?.title).toBe("First issue");
    expect(q.get("2")?.body).toBe(""); // null coerced to ""
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 403 } as any);
    await expect(loadIssuesToQueue(new TaskQueue(), new Map(), new Set(), QUEUE_OPTS)).rejects.toThrow("403");
  });
});

describe("labelIssueDone", () => {
  it("POSTs the done label to the issue", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as any);
    await labelIssueDone(42, LABEL_OPTS);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("owner/repo/issues/42/labels"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ labels: ["brunel:done"] }),
      }),
    );
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 422 } as any);
    await expect(labelIssueDone(42, LABEL_OPTS)).rejects.toThrow("422");
  });
});

describe("fetchIssueStates", () => {
  it("returns open/closed state for each issue number", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ number: 1, state: "open" }) } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ number: 2, state: "closed" }) } as any);
    const states = await fetchIssueStates([1, 2], OPTS);
    expect(states.get(1)).toBe("open");
    expect(states.get(2)).toBe("closed");
  });

  it("returns empty map for empty input without calling fetch", async () => {
    const states = await fetchIssueStates([], OPTS);
    expect(fetch).not.toHaveBeenCalled();
    expect(states.size).toBe(0);
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as any);
    await expect(fetchIssueStates([1], OPTS)).rejects.toThrow("500");
  });
});

describe("fetchNativeBlockers", () => {
  it("returns blocker issue numbers from GraphQL response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          repository: {
            issue: {
              blockedBy: { nodes: [{ number: 5 }, { number: 7 }] },
            },
          },
        },
      }),
    } as any);
    const blockers = await fetchNativeBlockers(42, OPTS);
    expect(blockers).toEqual([5, 7]);
  });

  it("returns empty array when issue has no blockers", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { repository: { issue: { blockedBy: { nodes: [] } } } },
      }),
    } as any);
    expect(await fetchNativeBlockers(42, OPTS)).toEqual([]);
  });

  it("returns empty array when GraphQL field is null (feature unavailable)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { repository: { issue: { blockedBy: null } } },
      }),
    } as any);
    expect(await fetchNativeBlockers(42, OPTS)).toEqual([]);
  });

  it("throws on non-ok HTTP response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 403 } as any);
    await expect(fetchNativeBlockers(42, OPTS)).rejects.toThrow("403");
  });
});

describe("loadIssuesToQueue with dependency graph", () => {
  it("populates graph and openIssues from blockers returned by fetchBlockers", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { number: 1, title: "Do thing", body: "Depends on #99", labels: [{ name: "brunel:ready" }] },
        ],
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ number: 99, state: "open" }),
      } as any);

    vi.mocked(fetchBlockers).mockResolvedValueOnce([99]);

    const graph: DependencyGraph = new Map();
    const openIssues = new Set<number>();
    const q = new TaskQueue();
    await loadIssuesToQueue(q, graph, openIssues, QUEUE_OPTS);

    expect(graph.get(1)).toEqual(new Set([99]));
    expect(openIssues.has(99)).toBe(true);
    expect(openIssues.has(1)).toBe(true);
  });

  it("does not add closed blocker to openIssues", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { number: 2, title: "Another", body: "Depends on #50", labels: [{ name: "brunel:ready" }] },
        ],
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ number: 50, state: "closed" }),
      } as any);

    vi.mocked(fetchBlockers).mockResolvedValueOnce([50]);

    const graph: DependencyGraph = new Map();
    const openIssues = new Set<number>();
    await loadIssuesToQueue(new TaskQueue(), graph, openIssues, QUEUE_OPTS);

    expect(openIssues.has(50)).toBe(false);
  });
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd /workspace/.worktrees/issue-161-unified-config && npm test -- tests/foreman.github.test.ts 2>&1 | tail -20
```

Expected: FAIL — functions don't accept opts yet

---

### Task 5: Refactor `src/github.ts` and `src/dependencies.ts`

- [ ] **Step 1: Replace `src/github.ts`**

Replace the entire file with this implementation (preserving `ghHeaders`, removing `ghEnv`, adding `opts` to all exported functions, and updating the two internal calls inside `loadIssuesToQueue`):

```typescript
import type { TaskQueue } from "./foreman.js";
import { fetchBlockers, setBlockers } from "./dependencies.js";
import type { DependencyGraph } from "./dependencies.js";

// ── GitHub API helpers ────────────────────────────────────────────────────────

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// ── Exported functions ────────────────────────────────────────────────────────

export async function loadIssuesToQueue(
  queue: TaskQueue,
  graph: DependencyGraph,
  openIssues: Set<number>,
  opts: { repo: string; token: string; taskLabel: string },
): Promise<void> {
  const { repo, token, taskLabel } = opts;
  const [owner, repoName] = repo.split("/");
  const url = `https://api.github.com/repos/${owner}/${repoName}/issues?labels=${encodeURIComponent(taskLabel)}&state=open&per_page=100`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const issues = await res.json() as Array<{
    number: number; title: string; body: string | null; labels: Array<{ name: string }>;
  }>;

  const allBlockerNumbers = new Set<number>();
  const loadedIssueNumbers: number[] = [];

  for (const issue of issues) {
    queue.addTask({
      taskId: String(issue.number),
      issueNumber: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      labels: issue.labels.map((l) => l.name),
      repoUrl: `https://github.com/${owner}/${repoName}`,
      depsLoaded: false,
    });
    openIssues.add(issue.number);
    const blockers = await fetchBlockers(issue.number, issue.body ?? "", { repo, token });
    setBlockers(issue.number, blockers, graph);
    for (const b of blockers) allBlockerNumbers.add(b);
    loadedIssueNumbers.push(issue.number);
  }

  if (allBlockerNumbers.size > 0) {
    const states = await fetchIssueStates(Array.from(allBlockerNumbers), { repo, token });
    for (const [num, state] of states) {
      if (state === "open") openIssues.add(num);
    }
  }

  queue.markDepsLoaded(loadedIssueNumbers);
}

export async function labelIssueDone(
  issueNumber: number,
  opts: { repo: string; token: string; doneLabel: string },
): Promise<void> {
  const { repo, token, doneLabel } = opts;
  const [owner, repoName] = repo.split("/");
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}/labels`,
    {
      method: "POST",
      headers: { ...ghHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ labels: [doneLabel] }),
    },
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
}

export async function fetchIssueStates(
  issueNumbers: number[],
  opts: { repo: string; token: string },
): Promise<Map<number, "open" | "closed">> {
  if (issueNumbers.length === 0) return new Map();
  const { repo, token } = opts;
  const [owner, repoName] = repo.split("/");
  const result = new Map<number, "open" | "closed">();
  await Promise.all(
    issueNumbers.map(async (n) => {
      const url = `https://api.github.com/repos/${owner}/${repoName}/issues/${n}`;
      const res = await fetch(url, { headers: ghHeaders(token) });
      if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
      const issue = await res.json() as { number: number; state: string };
      result.set(issue.number, issue.state === "open" ? "open" : "closed");
    }),
  );
  return result;
}

export async function fetchNativeBlockers(
  issueNumber: number,
  opts: { repo: string; token: string },
): Promise<number[]> {
  const { repo, token } = opts;
  const [owner, repoName] = repo.split("/");
  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          blockedBy(first: 50) {
            nodes { number }
          }
        }
      }
    }
  `;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { owner, repo: repoName, number: issueNumber } }),
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const body = await res.json() as {
    data?: { repository?: { issue?: { blockedBy?: { nodes: Array<{ number: number }> } | null } | null } | null };
  };
  return body.data?.repository?.issue?.blockedBy?.nodes?.map((n) => n.number) ?? [];
}
```

- [ ] **Step 2: Update `src/dependencies.ts`**

Update `fetchBlockers` to accept and forward `opts` to `fetchNativeBlockers`:

```typescript
import { fetchNativeBlockers } from "./github.js";

// ... (parseBodyBlockers, setBlockers, isBlocked unchanged) ...

export async function fetchBlockers(
  issueNumber: number,
  body: string,
  opts: { repo: string; token: string },
): Promise<number[]> {
  const [bodyBlockers, nativeBlockers] = await Promise.all([
    Promise.resolve(parseBodyBlockers(body)),
    fetchNativeBlockers(issueNumber, opts),
  ]);
  return Array.from(new Set([...bodyBlockers, ...nativeBlockers]));
}
```

- [ ] **Step 3: Update `tests/dependencies.test.ts` `fetchBlockers` describe block**

The `fetchBlockers` tests set `process.env.GITHUB_REPO` / `GITHUB_TOKEN` and call `fetchBlockers(n, body)` with 2 args. Update to pass explicit `opts` as the third argument and remove the env var setup:

```typescript
// Replace the existing describe("fetchBlockers", ...) block:
describe("fetchBlockers", () => {
  const OPTS = { repo: "owner/repo", token: "token123" };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns body-parsed blockers when native returns empty", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { repository: { issue: { blockedBy: { nodes: [] } } } } }),
    } as any);
    const blockers = await fetchBlockers(42, "Depends on #5\nBlocked by #6", OPTS);
    expect(blockers).toEqual(expect.arrayContaining([5, 6]));
    expect(blockers).toHaveLength(2);
  });

  it("merges and deduplicates body and native blockers", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { repository: { issue: { blockedBy: { nodes: [{ number: 5 }, { number: 9 }] } } } },
      }),
    } as any);
    const blockers = await fetchBlockers(42, "Depends on #5", OPTS);
    expect(new Set(blockers)).toEqual(new Set([5, 9]));
  });

  it("returns empty array when no deps in body or native", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { repository: { issue: { blockedBy: { nodes: [] } } } } }),
    } as any);
    expect(await fetchBlockers(42, "No dependencies here", OPTS)).toEqual([]);
  });
});
```

- [ ] **Step 4: Run github + dependencies tests**

```bash
cd /workspace/.worktrees/issue-161-unified-config && npm test -- tests/foreman.github.test.ts tests/dependencies.test.ts 2>&1 | tail -15
```

Expected: all github and dependencies tests pass

- [ ] **Step 5: Run full test suite**

```bash
cd /workspace/.worktrees/issue-161-unified-config && npm test 2>&1 | tail -10
```

Expected: all tests pass (type errors will also surface here — fix any)

- [ ] **Step 6: Typecheck**

```bash
cd /workspace/.worktrees/issue-161-unified-config && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors (any callers of old signatures surface here — fix them)

- [ ] **Step 7: Commit**

```bash
git -C /workspace/.worktrees/issue-161-unified-config add src/github.ts src/dependencies.ts tests/foreman.github.test.ts tests/dependencies.test.ts
git -C /workspace/.worktrees/issue-161-unified-config commit -m "refactor: github.ts and dependencies.ts accept explicit opts instead of reading env vars"
```

---

## Chunk 3: `display.ts` and `worker.ts`

**Files:**
- Modify: `src/display.ts`
- Modify: `src/worker.ts`
- Modify: `tests/worker.test.ts` (for `workerMain` signature)

### Task 6: Update `display.ts`

- [ ] **Step 1: Remove `process.argv` read from `display.ts`**

In `src/display.ts`, change line 10:
```typescript
// Before:
export let VERBOSE = process.argv.includes("--verbose");
// After:
export let VERBOSE = false;
```

- [ ] **Step 2: Run tests to verify nothing breaks**

```bash
cd /workspace/.worktrees/issue-161-unified-config && npm test 2>&1 | tail -10
```

Expected: all tests pass (display tests rely on `setVerbose()` anyway)

---

### Task 7: Update `worker.ts` — `workerMain` signature

- [ ] **Step 1: Update `src/worker.ts`**

`workerMain` gains a `config` parameter, removes `process.env.FOREMAN_URL` read:

```typescript
export async function workerMain(
  runQueryFn: RunQuery,
  config: { foremanUrl: string },
): Promise<void> {
  const FOREMAN_URL = config.foremanUrl;  // replaces process.env.FOREMAN_URL ?? "ws://localhost:3000"
  const workerId = crypto.randomUUID();
  // ... rest unchanged ...
}
```

- [ ] **Step 2: Run tests**

```bash
cd /workspace/.worktrees/issue-161-unified-config && npm test 2>&1 | tail -10
```

Expected: all tests pass (`worker.test.ts` doesn't test `workerMain` directly — tests `WorkerSession`)

- [ ] **Step 3: Typecheck**

```bash
cd /workspace/.worktrees/issue-161-unified-config && npx tsc --noEmit 2>&1 | head -20
```

Expected: `repl.ts` will show an error (call site not updated yet) — note it, proceed

- [ ] **Step 4: Commit**

```bash
git -C /workspace/.worktrees/issue-161-unified-config add src/display.ts src/worker.ts
git -C /workspace/.worktrees/issue-161-unified-config commit -m "refactor: display.ts removes process.argv read; workerMain accepts config param"
```

---

## Chunk 4: `foreman.ts` integration

**Files:**
- Modify: `src/foreman.ts`
- Possibly modify: `tests/foreman.websocket.test.ts`

### Task 8: Update `foreman.ts`

- [ ] **Step 1: Add `import { loadConfig } from "./config.js"` to `foreman.ts`**

At the top of `foreman.ts` add:
```typescript
import { loadConfig } from "./config.js";
```

- [ ] **Step 2: Remove module-level `PORT` and `WEBHOOK_SECRET` reads**

Delete lines 19–20:
```typescript
// DELETE these two lines:
const PORT = parseInt(process.env.PORT ?? "3000");
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
```

- [ ] **Step 3: Add `repo` and `token` to `createForemanWss` options**

In the `createForemanWss` function signature, extend the options type:
```typescript
export function createForemanWss(
  taskQueue: TaskQueue,
  registry: WorkerRegistry,
  server: http.Server,
  options?: {
    taskLabel?: string;
    labelDone?: (issueNumber: number) => Promise<void>;
    graph?: DependencyGraph;
    openIssues?: Set<number>;
    repo?: string;    // ← new
    token?: string;   // ← new
  },
): { wss: WebSocketServer; routeEventToWorker: (id: string, name: string, payload: unknown) => void }
```

- [ ] **Step 4: Remove `process.env.TASK_LABEL` fallback inside `createForemanWss`**

Change:
```typescript
const taskLabel = options?.taskLabel ?? process.env.TASK_LABEL ?? "brunel:ready";
```
to:
```typescript
const taskLabel = options?.taskLabel ?? "brunel:ready";
```

Also capture `repo` and `token`, and update the `labelDone` fallback (bare `labelIssueDone` no longer compiles since its signature changed):
```typescript
const repo = options?.repo ?? "";
const token = options?.token ?? "";
// The bare labelIssueDone no longer matches (issueNumber: number) => Promise<void>
// since it now requires opts. Remove the fallback entirely:
const labelDone = options?.labelDone ?? (() => Promise.resolve());
```

- [ ] **Step 5: Update internal `fetchBlockers` / `fetchIssueStates` calls in `routeEvent`**

Find the two places inside `routeEvent` that call `fetchBlockers` and `fetchIssueStates` and add `{ repo, token }` opts:
```typescript
// Where fetchBlockers is called (two places):
fetchBlockers(issueNumber, String(issue.body ?? ""))
// becomes:
fetchBlockers(issueNumber, String(issue.body ?? ""), { repo, token })

// Where fetchIssueStates is called (two places):
fetchIssueStates(blockers)
// becomes:
fetchIssueStates(blockers, { repo, token })
```

- [ ] **Step 6: Update the `isMain` block**

Replace the existing `isMain` block at the bottom of `foreman.ts`:
```typescript
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const config = await loadConfig(process.argv);
  setVerbose(config.verbose);

  const registry = new WorkerRegistry();
  const taskQueue = new TaskQueue();
  const graph: DependencyGraph = new Map();
  const openIssues = new Set<number>();
  const webhooks = config.webhookSecret
    ? new Webhooks({ secret: config.webhookSecret })
    : null;

  let routeEvent: (id: string, name: string, payload: unknown) => void = () => {};
  const server = createHttpServer(webhooks, (id, name, payload) => routeEvent(id, name, payload));
  ({ routeEventToWorker: routeEvent } = createForemanWss(
    taskQueue, registry, server,
    {
      graph,
      openIssues,
      taskLabel: config.taskLabel,
      repo: config.githubRepo,
      token: config.githubToken,
      labelDone: (issueNumber) =>
        labelIssueDone(issueNumber, {
          repo: config.githubRepo,
          token: config.githubToken,
          doneLabel: config.doneLabel,
        }),
    },
  ));

  if (webhooks) {
    webhooks.onAny(({ id, name, payload }) => {
      printEvent(id, name as string, payload);
      routeEvent(id, name as string, payload);
    });
  }

  server.listen(config.port, async () => {
    flog(`Listening on http://localhost:${config.port}/webhook`);
    flog(`WebSocket workers: ws://localhost:${config.port}/worker`);
    flog("Waiting for events...");
    try {
      await loadIssuesToQueue(taskQueue, graph, openIssues, {
        repo: config.githubRepo,
        token: config.githubToken,
        taskLabel: config.taskLabel,
      });
    } catch (err) {
      flog(`WARNING Failed to load issues from GitHub: ${err}`);
    }
  });
}
```

Note: the `import { setVerbose } from "./display.js"` line must also be added if not already present.

- [ ] **Step 7: Run tests**

```bash
cd /workspace/.worktrees/issue-161-unified-config && npm test 2>&1 | tail -10
```

Expected: all tests pass

- [ ] **Step 8: Typecheck**

```bash
cd /workspace/.worktrees/issue-161-unified-config && npx tsc --noEmit 2>&1 | head -20
```

Expected: only `repl.ts` errors remain (call site not updated yet)

- [ ] **Step 9: Commit**

```bash
git -C /workspace/.worktrees/issue-161-unified-config add src/foreman.ts
git -C /workspace/.worktrees/issue-161-unified-config commit -m "refactor: foreman.ts reads config via loadConfig, passes explicit opts to github functions"
```

---

## Chunk 5: `repl.ts` integration and cleanup

**Files:**
- Modify: `src/repl.ts`
- Delete: `tests/repl.permission-mode.test.ts`

### Task 9: Refactor `repl.ts`

- [ ] **Step 1: Add `import "dotenv/config"` to the top of `repl.ts`**

This line is currently missing from `repl.ts`. Add it as the first import.

- [ ] **Step 2: Add `import { loadConfig } from "./config.js"` and `import { setVerbose } from "./display.js"`**

These imports are needed for the config integration.

- [ ] **Step 3: Remove the module-level permission parsing and constants**

Delete from `repl.ts`:
- The `ParsedPermissionConfig` type definition (lines 32–35)
- The `parsePermissionMode` function (lines 37–76)
- The module-level `const { mode: PERMISSION_MODE, allowDangerouslySkipPermissions: ALLOW_BYPASS } = parsePermissionMode(process.argv);` (lines 78–79)
- The `VALID_PERMISSION_MODES` export (moves to `config.ts` — check it's already there)

Also remove the `export { parsePermissionMode, VALID_PERMISSION_MODES }` re-exports if present.

- [ ] **Step 4: Update `runQuery` signature**

Change `runQuery` from:
```typescript
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  abortController?: AbortController,
): Promise<string | undefined>
```
to:
```typescript
async function runQuery(
  permConfig: { permissionMode: PermissionMode; allowDangerouslySkipPermissions: boolean },
  prompt: string,
  sessionId: string | undefined,
  abortController?: AbortController,
): Promise<string | undefined>
```

Replace `PERMISSION_MODE` with `permConfig.permissionMode` and `ALLOW_BYPASS` with `permConfig.allowDangerouslySkipPermissions` inside the function body.

- [ ] **Step 5: Update `main()` to accept and use `permConfig`**

```typescript
async function main(
  permConfig: { permissionMode: PermissionMode; allowDangerouslySkipPermissions: boolean },
): Promise<void> {
  // ...
  display.print(display.c.lavender(`  Permissions: ${permConfig.permissionMode} | ...`));
  // ...
  // Inside the query loop, change:
  sessionId = await runQuery(action.prompt, sessionId);
  // to:
  sessionId = await runQuery(permConfig, action.prompt, sessionId);
}
```

- [ ] **Step 6: Update the `isMain` block**

Replace the current `isMain` block:
```typescript
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = await loadConfig(process.argv);
  setVerbose(config.verbose);
  const permConfig = {
    permissionMode: config.permissionMode,
    allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions,
  };
  const boundRunQuery: RunQuery = (prompt, sessionId, ac) =>
    runQuery(permConfig, prompt, sessionId, ac);

  if (process.argv.includes("--worker-mode")) {
    void workerMain(boundRunQuery, { foremanUrl: config.foremanUrl });
  } else {
    void main(permConfig);
  }
}
```

- [ ] **Step 7: Delete the old permission-mode test file**

```bash
rm /workspace/.worktrees/issue-161-unified-config/tests/repl.permission-mode.test.ts
```

- [ ] **Step 8: Run tests**

```bash
cd /workspace/.worktrees/issue-161-unified-config && npm test 2>&1 | tail -15
```

Expected: all tests pass (config.test.ts covers the migrated permission tests)

- [ ] **Step 9: Typecheck**

```bash
cd /workspace/.worktrees/issue-161-unified-config && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 10: Lint**

```bash
cd /workspace/.worktrees/issue-161-unified-config && npm run lint 2>&1 | tail -20
```

Expected: no errors

- [ ] **Step 11: Run smoke test**

```bash
cd /workspace/.worktrees/issue-161-unified-config && GITHUB_REPO=test/test GITHUB_TOKEN=fake npm run smoke 2>&1 | tail -15
```

Expected: foreman and worker connect successfully

- [ ] **Step 12: Commit**

```bash
git -C /workspace/.worktrees/issue-161-unified-config add src/repl.ts
git -C /workspace/.worktrees/issue-161-unified-config rm tests/repl.permission-mode.test.ts
git -C /workspace/.worktrees/issue-161-unified-config commit -m "refactor: repl.ts uses loadConfig; remove parsePermissionMode; runQuery accepts permConfig"
```

---

## Chunk 6: Final verification and PR

### Task 10: Full verification and PR

- [ ] **Step 1: Run full test suite**

```bash
cd /workspace/.worktrees/issue-161-unified-config && npm test 2>&1 | tail -10
```

Expected: all tests pass

- [ ] **Step 2: Typecheck**

```bash
cd /workspace/.worktrees/issue-161-unified-config && npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 3: Lint**

```bash
cd /workspace/.worktrees/issue-161-unified-config && npm run lint
```

Expected: no errors

- [ ] **Step 4: Smoke test with real env**

```bash
cd /workspace/.worktrees/issue-161-unified-config && npm run smoke 2>&1 | tail -10
```

Expected: passes (foreman + worker connect)

- [ ] **Step 5: Push branch**

Use the token-embedding workaround for git push (see feedback memory):
```bash
TOKEN=$(gh auth token) && git -C /workspace/.worktrees/issue-161-unified-config remote set-url origin "https://${TOKEN}@github.com/jasoncrawford/brunel.git"
git -C /workspace/.worktrees/issue-161-unified-config push -u origin worktree-feat/issue-161-unified-config
git -C /workspace/.worktrees/issue-161-unified-config remote set-url origin "https://github.com/jasoncrawford/brunel.git"
```

- [ ] **Step 6: Create PR**

```bash
gh pr create \
  --title "feat: unified config system (file + env vars + CLI flags)" \
  --body "$(cat <<'EOF'
## Summary

- Adds `src/config.ts` with `loadConfig(argv)` — merges CLI flags > `BRUNEL_*` env vars > `brunel.config.ts` file > fallback env vars > built-in defaults
- All scattered `process.env.*` reads removed from `foreman.ts`, `worker.ts`, `github.ts`, `dependencies.ts`, `display.ts`, `repl.ts`
- Zod validation at startup with clear error messages
- Legacy env vars (`GITHUB_REPO`, `TASK_LABEL`, `DONE_LABEL`, `PORT`, `WEBHOOK_SECRET`) supported as fallbacks for backwards compatibility
- `VALID_PERMISSION_MODES` and `parsePermissionMode` logic move into `config.ts`; `repl.permission-mode.test.ts` migrated to `config.test.ts`

## Test plan

- [ ] `npm test` passes
- [ ] `npx tsc --noEmit` clean
- [ ] `npm run lint` clean
- [ ] `npm run smoke` passes
- [ ] Test that `.env` file with `GITHUB_REPO`, `GITHUB_TOKEN` still works (backwards compat)
- [ ] Test that `BRUNEL_GITHUB_REPO`, `BRUNEL_GITHUB_TOKEN` also work

Closes #161

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Quick Reference

| Worktree path | `/workspace/.worktrees/issue-161-unified-config` |
|---|---|
| Branch | `worktree-feat/issue-161-unified-config` |
| Test command | `npm test` (run from worktree) |
| Typecheck | `npx tsc --noEmit` |
| Lint | `npm run lint` |
| Smoke | `npm run smoke` |
