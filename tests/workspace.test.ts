import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Workspace, confirmIfUnsafe } from "../src/agent/models/workspace.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const BASE_DIR = path.join(os.tmpdir(), `brunel-test-${process.pid}`);
const WORKER_ID = "test-worker-abc";
const REPO_URL = "https://token@github.com/owner/repo.git";

function makeExec(responses: Record<string, string> = {}) {
  return vi.fn().mockImplementation(async (args: string[]) => {
    // Simulate git clone creating the target directory with .git and package.json
    if (args[0] === "clone") {
      fs.mkdirSync(path.join(args[2], ".git"), { recursive: true });
      fs.writeFileSync(path.join(args[2], "package.json"), "{}");
    }
    const key = args.join(" ");
    return responses[key] ?? "";
  });
}

function makeNpmExec() {
  return vi.fn().mockResolvedValue("");
}

async function makeWorkspace(
  exec = makeExec(),
  npm = makeNpmExec(),
): Promise<Workspace> {
  const ws = new Workspace(BASE_DIR, WORKER_ID, REPO_URL, "/original-cwd", async () => true, exec, npm);
  await ws.create();
  return ws;
}

beforeEach(() => {
  fs.mkdirSync(BASE_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(BASE_DIR, { recursive: true, force: true });
});

// ── create ─────────────────────────────────────────────────────────────────

describe("Workspace.create", () => {
  it("runs git clone when directory does not exist", async () => {
    const exec = makeExec();
    const npm = makeNpmExec();
    const ws = await makeWorkspace(exec, npm);
    expect(exec).toHaveBeenCalledWith(
      ["clone", REPO_URL, path.join(BASE_DIR, WORKER_ID)],
      undefined,
    );
    expect(ws.dir).toBe(path.join(BASE_DIR, WORKER_ID));
  });

  it("skips git clone if .git already exists", async () => {
    const workerDir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(path.join(workerDir, ".git"), { recursive: true });
    const exec = makeExec();
    const npm = makeNpmExec();
    await makeWorkspace(exec, npm);
    expect(exec).not.toHaveBeenCalledWith(
      expect.arrayContaining(["clone"]),
      expect.anything(),
    );
  });

  it("writes a PID lockfile containing the current PID", async () => {
    const ws = await makeWorkspace();
    const lockPath = path.join(ws.dir, ".brunel.lock");
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
  });

  it("runs npm install after cloning", async () => {
    const exec = makeExec();
    const npm = makeNpmExec();
    await makeWorkspace(exec, npm);
    expect(npm).toHaveBeenCalledWith(["install"], path.join(BASE_DIR, WORKER_ID));
  });

  it("does not run npm install when directory already exists", async () => {
    const workerDir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(path.join(workerDir, ".git"), { recursive: true });
    const exec = makeExec();
    const npm = makeNpmExec();
    await makeWorkspace(exec, npm);
    expect(npm).not.toHaveBeenCalled();
  });

  it("does not run npm install when cloned repo has no package.json", async () => {
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      // Clone creates .git but no package.json
      if (args[0] === "clone") fs.mkdirSync(path.join(args[2], ".git"), { recursive: true });
      return "";
    });
    const npm = makeNpmExec();
    await makeWorkspace(exec, npm);
    expect(npm).not.toHaveBeenCalled();
  });
});

// ── create: git excludes ──────────────────────────────────────────────────────

describe("Workspace.create — git excludes", () => {
  it("adds .brunel.lock to .git/info/exclude after create", async () => {
    const ws = await makeWorkspace();
    const excludePath = path.join(ws.dir, ".git", "info", "exclude");
    expect(fs.existsSync(excludePath)).toBe(true);
    const lines = fs.readFileSync(excludePath, "utf8").split("\n").map(l => l.trim());
    expect(lines).toContain(".brunel.lock");
  });

  it("does not duplicate .brunel.lock in .git/info/exclude on repeated create", async () => {
    const ws = await makeWorkspace();
    await ws.create(); // second call — workspace dir already has .git
    const excludePath = path.join(ws.dir, ".git", "info", "exclude");
    const lines = fs.readFileSync(excludePath, "utf8").split("\n").map(l => l.trim()).filter(Boolean);
    expect(lines.filter(l => l === ".brunel.lock")).toHaveLength(1);
  });
});

// ── reset: re-clone path git excludes ────────────────────────────────────────

describe("Workspace.reset — re-clone path", () => {
  it("adds .brunel.lock to .git/info/exclude after a forced re-clone", async () => {
    let fetchCalls = 0;
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "fetch") {
        if (fetchCalls++ < 2) throw new Error("simulated network failure");
      }
      if (args[0] === "clone") {
        // Simulate git clone creating a minimal repo structure
        fs.mkdirSync(path.join(args[2], ".git", "info"), { recursive: true });
        fs.writeFileSync(path.join(args[2], "package.json"), "{}");
      }
      return "";
    });
    const ws = await makeWorkspace(exec);
    await ws.reset(); // fails twice, then re-clones
    const excludePath = path.join(ws.dir, ".git", "info", "exclude");
    expect(fs.existsSync(excludePath)).toBe(true);
    const lines = fs.readFileSync(excludePath, "utf8").split("\n").map(l => l.trim());
    expect(lines).toContain(".brunel.lock");
  });
});

// ── destroy ────────────────────────────────────────────────────────────────

describe("Workspace.destroy", () => {
  it("removes the workspace directory", async () => {
    const ws = await makeWorkspace();
    expect(fs.existsSync(ws.dir)).toBe(true);
    await ws.destroy();
    expect(fs.existsSync(ws.dir)).toBe(false);
  });
});

// ── reset ──────────────────────────────────────────────────────────────────

describe("Workspace.reset", () => {
  it("runs fetch, checkout main, reset --hard, clean -fdx", async () => {
    const exec = makeExec();
    const npm = makeNpmExec();
    const ws = await makeWorkspace(exec, npm);
    exec.mockClear();
    await ws.reset();
    expect(exec).toHaveBeenCalledWith(["fetch", "origin"], ws.dir);
    expect(exec).toHaveBeenCalledWith(["checkout", "main"], ws.dir);
    expect(exec).toHaveBeenCalledWith(["reset", "--hard", "origin/main"], ws.dir);
    expect(exec).toHaveBeenCalledWith(["clean", "-fdx", "-e", "node_modules", "-e", ".env", "-e", ".brunel.lock"], ws.dir);
  });

  it("runs npm install after git operations", async () => {
    const exec = makeExec();
    const npm = makeNpmExec();
    const ws = await makeWorkspace(exec, npm);
    // makeExec clone creates package.json; it persists through the mocked clean
    npm.mockClear();
    await ws.reset();
    expect(npm).toHaveBeenCalledWith(["install"], ws.dir);
  });

  it("does not run npm install on reset when repo has no package.json", async () => {
    const workerDir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(path.join(workerDir, ".git"), { recursive: true });
    // No package.json in this workspace
    const exec = makeExec();
    const npm = makeNpmExec();
    const ws = await makeWorkspace(exec, npm);
    npm.mockClear();
    await ws.reset();
    expect(npm).not.toHaveBeenCalled();
  });

  it("retries once on failure before succeeding", async () => {
    const exec = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("");
    const npm = makeNpmExec();
    // Pre-create the .git dir so create() skips cloning
    fs.mkdirSync(path.join(BASE_DIR, WORKER_ID, ".git"), { recursive: true });
    const ws = await makeWorkspace(exec, npm);
    exec.mockReset();
    // First reset attempt fails, second succeeds
    exec
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValue("");
    await ws.reset();
    // reset was called at least twice (first fail, then success)
    expect(exec.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("destroys and re-clones if both retries fail, then succeeds", async () => {
    const dir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    let callCount = 0;
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "clone") { fs.mkdirSync(path.join(args[2], ".git"), { recursive: true }); return ""; }
      callCount++;
      if (callCount <= 2) throw new Error("reset fail");
      return ""; // third attempt (after re-clone) succeeds
    });
    const npm = makeNpmExec();
    const ws = await makeWorkspace(exec, npm);
    exec.mockClear();
    callCount = 0;
    await ws.reset();
    expect(exec).toHaveBeenCalledWith(expect.arrayContaining(["clone"]), undefined);
  });

  it("throws if reset still fails after destroy + re-clone", async () => {
    const dir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "clone") { fs.mkdirSync(path.join(args[2], ".git"), { recursive: true }); return ""; }
      throw new Error("always fails");
    });
    const npm = makeNpmExec();
    const ws = await makeWorkspace(exec, npm);
    exec.mockClear();
    await expect(ws.reset()).rejects.toThrow("always fails");
  });
});

// ── checkSafety ────────────────────────────────────────────────────────────

describe("Workspace.checkSafety", () => {
  it("returns empty arrays when working tree is clean and branch is pushed", async () => {
    const exec = makeExec({
      "status --porcelain": "",
      "log @{u}..HEAD --oneline": "",
    });
    const ws = await makeWorkspace(exec);
    const result = await ws.checkSafety();
    expect(result.uncommittedFiles).toEqual([]);
    expect(result.unpushedCommits).toEqual([]);
    expect(result.noUpstream).toBe(false);
  });

  it("returns uncommitted files when working tree is dirty", async () => {
    const exec = makeExec({
      "status --porcelain": " M src/foo.ts\n?? newfile.ts",
      "log @{u}..HEAD --oneline": "",
    });
    const ws = await makeWorkspace(exec);
    const result = await ws.checkSafety();
    expect(result.uncommittedFiles).toEqual(["M src/foo.ts", "?? newfile.ts"]);
  });

  it("returns unpushed commits when ahead of upstream", async () => {
    const exec = makeExec({
      "status --porcelain": "",
      "log @{u}..HEAD --oneline": "abc1234 feat: my commit",
    });
    const ws = await makeWorkspace(exec);
    const result = await ws.checkSafety();
    expect(result.unpushedCommits).toEqual(["abc1234 feat: my commit"]);
    expect(result.noUpstream).toBe(false);
  });

  it("sets noUpstream when branch has no tracking remote", async () => {
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "clone") { fs.mkdirSync(path.join(args[2], ".git"), { recursive: true }); return ""; }
      if (args[0] === "status") return "";
      if (args[0] === "log") throw new Error("fatal: no upstream configured for branch 'my-branch'");
      return "";
    });
    const ws = await makeWorkspace(exec);
    const result = await ws.checkSafety();
    expect(result.noUpstream).toBe(true);
  });

  it("re-throws unexpected git errors (not 'no upstream')", async () => {
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "clone") { fs.mkdirSync(path.join(args[2], ".git"), { recursive: true }); return ""; }
      if (args[0] === "status") return "";
      if (args[0] === "log") throw new Error("fatal: corrupt object store");
      return "";
    });
    const ws = await makeWorkspace(exec);
    await expect(ws.checkSafety()).rejects.toThrow("corrupt object store");
  });
});

// ── confirmIfUnsafe ─────────────────────────────────────────────────────────

describe("confirmIfUnsafe", () => {
  it("returns true without calling confirm when workspace is clean", async () => {
    const exec = makeExec({
      "status --porcelain": "",
      "log @{u}..HEAD --oneline": "",
    });
    const ws = await makeWorkspace(exec);
    const confirm = vi.fn().mockResolvedValue(true);
    const result = await confirmIfUnsafe(ws, confirm);
    expect(result).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("calls confirm with warning when there are uncommitted files", async () => {
    const exec = makeExec({
      "status --porcelain": " M src/foo.ts",
      "log @{u}..HEAD --oneline": "",
    });
    const ws = await makeWorkspace(exec);
    const confirm = vi.fn().mockResolvedValue(true);
    const result = await confirmIfUnsafe(ws, confirm);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][0]).toContain("src/foo.ts");
    expect(result).toBe(true);
  });

  it("returns false when user declines", async () => {
    const exec = makeExec({
      "status --porcelain": " M src/foo.ts",
      "log @{u}..HEAD --oneline": "",
    });
    const ws = await makeWorkspace(exec);
    const confirm = vi.fn().mockResolvedValue(false);
    const result = await confirmIfUnsafe(ws, confirm);
    expect(result).toBe(false);
  });
});

// ── prune ──────────────────────────────────────────────────────────────────

function makeWorkspaceForPrune(workspaceDir: string): Workspace {
  return new Workspace(workspaceDir, WORKER_ID, REPO_URL, "/cwd", async () => true);
}

describe("Workspace.prune", () => {
  it("returns empty array when baseDir does not exist", async () => {
    const ws = makeWorkspaceForPrune(path.join(BASE_DIR, "nonexistent"));
    const result = await ws.prune();
    expect(result).toEqual([]);
  });

  it("removes directories with no lockfile", async () => {
    const ws = makeWorkspaceForPrune(BASE_DIR);
    const orphanDir = path.join(BASE_DIR, "orphan-no-lock");
    fs.mkdirSync(orphanDir);
    const removed = await ws.prune();
    expect(removed).toContain(orphanDir);
    expect(fs.existsSync(orphanDir)).toBe(false);
  });

  it("removes directories whose lockfile has a dead PID", async () => {
    const ws = makeWorkspaceForPrune(BASE_DIR);
    const orphanDir = path.join(BASE_DIR, "orphan-dead-pid");
    fs.mkdirSync(orphanDir);
    // PID 2147483647 is the max int32 — almost certainly not running
    fs.writeFileSync(path.join(orphanDir, ".brunel.lock"), "2147483647");
    const removed = await ws.prune();
    expect(removed).toContain(orphanDir);
    expect(fs.existsSync(orphanDir)).toBe(false);
  });

  it("keeps directories whose lockfile has a live PID", async () => {
    const ws = makeWorkspaceForPrune(BASE_DIR);
    const activeDir = path.join(BASE_DIR, "active-worker");
    fs.mkdirSync(activeDir);
    // Current process PID is definitely alive
    fs.writeFileSync(path.join(activeDir, ".brunel.lock"), String(process.pid));
    const removed = await ws.prune();
    expect(removed).not.toContain(activeDir);
    expect(fs.existsSync(activeDir)).toBe(true);
  });

  it("ignores non-directory entries", async () => {
    const ws = makeWorkspaceForPrune(BASE_DIR);
    fs.writeFileSync(path.join(BASE_DIR, "somefile.txt"), "content");
    const removed = await ws.prune();
    expect(fs.existsSync(path.join(BASE_DIR, "somefile.txt"))).toBe(true);
    expect(removed).toHaveLength(0);
  });
});

// ── http.extraHeader auth ─────────────────────────────────────────────────────

const CLEAN_REPO_URL = "https://github.com/owner/repo.git";

async function makeWorkspaceWithToken(
  token: string,
  exec = makeExec(),
  npm = makeNpmExec(),
): Promise<Workspace> {
  const ws = new Workspace(BASE_DIR, WORKER_ID, CLEAN_REPO_URL, "/original-cwd", async () => true, exec, npm, token);
  await ws.create();
  return ws;
}

describe("Workspace git auth via extraHeader", () => {
  it("sets http.extraHeader via git config after clone when token is provided", async () => {
    const exec = makeExec();
    await makeWorkspaceWithToken("ghp_mytoken", exec);
    expect(exec).toHaveBeenCalledWith(
      ["config", "--local", "http.https://github.com/.extraheader", "Authorization: Bearer ghp_mytoken"],
      path.join(BASE_DIR, WORKER_ID),
    );
  });

  it("does not set http.extraHeader when no token is provided", async () => {
    const exec = makeExec();
    await makeWorkspace(exec);
    const configCalls = exec.mock.calls.filter((args) => args[0][0] === "config");
    expect(configCalls).toHaveLength(0);
  });

  it("sets http.extraHeader after re-clone during reset when token is provided", async () => {
    let fetchCalls = 0;
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "fetch") {
        if (fetchCalls++ < 2) throw new Error("simulated network failure");
      }
      if (args[0] === "clone") {
        fs.mkdirSync(path.join(args[2], ".git", "info"), { recursive: true });
        fs.writeFileSync(path.join(args[2], "package.json"), "{}");
      }
      return "";
    });
    const ws = await makeWorkspaceWithToken("ghp_mytoken", exec);
    exec.mockClear();
    fetchCalls = 0;
    await ws.reset();

    expect(exec).toHaveBeenCalledWith(
      ["config", "--local", "http.https://github.com/.extraheader", "Authorization: Bearer ghp_mytoken"],
      path.join(BASE_DIR, WORKER_ID),
    );
  });

  it("clone URL does not contain the token", async () => {
    const exec = makeExec();
    await makeWorkspaceWithToken("ghp_secret", exec);
    const cloneCalls = exec.mock.calls.filter((args) => args[0][0] === "clone");
    expect(cloneCalls.length).toBeGreaterThan(0);
    const cloneUrl: string = cloneCalls[0][0][1];
    expect(cloneUrl).not.toContain("ghp_secret");
    expect(cloneUrl).toBe(CLEAN_REPO_URL);
  });
});
