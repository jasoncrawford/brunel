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
  "BRUNEL_SUPABASE_URL", "BRUNEL_SUPABASE_SECRET_KEY", "BRUNEL_WORKER_SECRET",
  "BRUNEL_WORKSPACE_DIR",
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
    const cfg = await loadConfig(["node", "repl.js"], {});
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

// ── New optional fields: supabaseUrl, supabaseSecretKey, workerSecret ────

describe("supabaseUrl", () => {
  it("is undefined by default", async () => {
    baseEnv();
    const cfg = await loadConfig(["node", "repl.js"]);
    expect(cfg.supabaseUrl).toBeUndefined();
  });

  it("BRUNEL_SUPABASE_URL sets supabaseUrl", async () => {
    baseEnv();
    process.env.BRUNEL_SUPABASE_URL = "https://abc.supabase.co";
    const cfg = await loadConfig(["node", "repl.js"]);
    expect(cfg.supabaseUrl).toBe("https://abc.supabase.co");
  });

  it("--supabase-url CLI flag sets supabaseUrl", async () => {
    baseEnv();
    const cfg = await loadConfig(["node", "repl.js", "--supabase-url", "https://cli.supabase.co"]);
    expect(cfg.supabaseUrl).toBe("https://cli.supabase.co");
  });

  it("CLI flag beats BRUNEL_SUPABASE_URL", async () => {
    baseEnv();
    process.env.BRUNEL_SUPABASE_URL = "https://env.supabase.co";
    const cfg = await loadConfig(["node", "repl.js", "--supabase-url", "https://cli.supabase.co"]);
    expect(cfg.supabaseUrl).toBe("https://cli.supabase.co");
  });

  it("BRUNEL_SUPABASE_URL beats file config", async () => {
    baseEnv();
    process.env.BRUNEL_SUPABASE_URL = "https://env.supabase.co";
    const cfg = await loadConfig(["node", "repl.js"], { supabaseUrl: "https://file.supabase.co" });
    expect(cfg.supabaseUrl).toBe("https://env.supabase.co");
  });
});

describe("supabaseSecretKey", () => {
  it("is undefined by default", async () => {
    baseEnv();
    const cfg = await loadConfig(["node", "repl.js"]);
    expect(cfg.supabaseSecretKey).toBeUndefined();
  });

  it("BRUNEL_SUPABASE_SECRET_KEY sets supabaseSecretKey", async () => {
    baseEnv();
    process.env.BRUNEL_SUPABASE_SECRET_KEY = "service-role-key";
    const cfg = await loadConfig(["node", "repl.js"]);
    expect(cfg.supabaseSecretKey).toBe("service-role-key");
  });

  it("--supabase-secret-key CLI flag sets supabaseSecretKey", async () => {
    baseEnv();
    const cfg = await loadConfig(["node", "repl.js", "--supabase-secret-key", "cli-key"]);
    expect(cfg.supabaseSecretKey).toBe("cli-key");
  });

  it("warns when supabaseSecretKey in file config", async () => {
    baseEnv();
    await loadConfig(["node", "repl.js"], { supabaseSecretKey: "file-key" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("supabaseSecretKey"));
  });

  it("does NOT warn when supabaseSecretKey from env var", async () => {
    baseEnv();
    process.env.BRUNEL_SUPABASE_SECRET_KEY = "env-key";
    await loadConfig(["node", "repl.js"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("workerSecret", () => {
  it("is undefined by default", async () => {
    baseEnv();
    const cfg = await loadConfig(["node", "repl.js"]);
    expect(cfg.workerSecret).toBeUndefined();
  });

  it("BRUNEL_WORKER_SECRET sets workerSecret", async () => {
    baseEnv();
    process.env.BRUNEL_WORKER_SECRET = "my-worker-secret";
    const cfg = await loadConfig(["node", "repl.js"]);
    expect(cfg.workerSecret).toBe("my-worker-secret");
  });

  it("--worker-secret CLI flag sets workerSecret", async () => {
    baseEnv();
    const cfg = await loadConfig(["node", "repl.js", "--worker-secret", "cli-secret"]);
    expect(cfg.workerSecret).toBe("cli-secret");
  });

  it("warns when workerSecret in file config", async () => {
    baseEnv();
    await loadConfig(["node", "repl.js"], { workerSecret: "file-secret" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("workerSecret"));
  });

  it("does NOT warn when workerSecret from env var", async () => {
    baseEnv();
    process.env.BRUNEL_WORKER_SECRET = "env-secret";
    await loadConfig(["node", "repl.js"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("workspaceDir", () => {
  it("reads workspaceDir from BRUNEL_WORKSPACE_DIR env var", async () => {
    process.env.BRUNEL_GITHUB_REPO = "owner/repo";
    process.env.BRUNEL_GITHUB_TOKEN = "tok";
    process.env.BRUNEL_WORKSPACE_DIR = "/custom/workspace";
    const config = await loadConfig([]);
    expect(config.workspaceDir).toBe("/custom/workspace");
  });

  it("defaults workspaceDir to undefined when not set", async () => {
    process.env.BRUNEL_GITHUB_REPO = "owner/repo";
    process.env.BRUNEL_GITHUB_TOKEN = "tok";
    const config = await loadConfig([]);
    expect(config.workspaceDir).toBeUndefined();
  });
});
