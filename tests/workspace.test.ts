import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { Workspace, confirmIfUnsafe } from "../src/agent/models/workspace.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFileCb);

// ── Helpers ────────────────────────────────────────────────────────────────

const BASE_DIR = path.join(os.tmpdir(), `brunel-test-${process.pid}`);
const WORKER_ID = "test-worker-abc";
const REPO_URL = "https://token@github.com/owner/repo.git";

/**
 * Set up the execFile mock with default git/npm behavior.
 * On `git clone`, creates the target .git dir and package.json.
 * Other commands return the matching entry from `responses` (or "").
 */
function setupExecMock(responses: Record<string, string> = {}) {
  mockExecFile.mockImplementation((cmd: string, args: string[], _opts: object, cb: Function) => {
    if (cmd === "git" && args[0] === "clone") {
      fs.mkdirSync(path.join(args[2], ".git"), { recursive: true });
      fs.writeFileSync(path.join(args[2], "package.json"), "{}");
    }
    const key = args.join(" ");
    cb(null, { stdout: responses[key] ?? "", stderr: "" });
  });
}

async function makeWorkspace(): Promise<Workspace> {
  const ws = new Workspace(BASE_DIR, WORKER_ID, REPO_URL, "/original-cwd", async () => true);
  await ws.create();
  return ws;
}

beforeEach(() => {
  fs.mkdirSync(BASE_DIR, { recursive: true });
  setupExecMock();
});

afterEach(() => {
  fs.rmSync(BASE_DIR, { recursive: true, force: true });
  mockExecFile.mockReset();
});

// ── create ─────────────────────────────────────────────────────────────────

describe("Workspace.create", () => {
  it("runs git clone when directory does not exist", async () => {
    const ws = await makeWorkspace();
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["clone", REPO_URL, path.join(BASE_DIR, WORKER_ID)],
      {},
      expect.any(Function),
    );
    expect(ws.dir).toBe(path.join(BASE_DIR, WORKER_ID));
  });

  it("skips git clone if .git already exists", async () => {
    const workerDir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(path.join(workerDir, ".git"), { recursive: true });
    await makeWorkspace();
    expect(mockExecFile).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["clone"]),
      expect.anything(),
      expect.any(Function),
    );
  });

  it("writes a PID lockfile containing the current PID", async () => {
    const ws = await makeWorkspace();
    const lockPath = path.join(ws.dir, ".brunel.lock");
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
  });

  it("runs npm install after cloning", async () => {
    await makeWorkspace();
    expect(mockExecFile).toHaveBeenCalledWith(
      "npm",
      ["install"],
      { cwd: path.join(BASE_DIR, WORKER_ID) },
      expect.any(Function),
    );
  });

  it("does not run npm install when directory already exists", async () => {
    const workerDir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(path.join(workerDir, ".git"), { recursive: true });
    await makeWorkspace();
    expect(mockExecFile).not.toHaveBeenCalledWith(
      "npm",
      expect.anything(),
      expect.anything(),
      expect.any(Function),
    );
  });

  it("does not run npm install when cloned repo has no package.json", async () => {
    mockExecFile.mockImplementation((cmd: string, args: string[], _opts: object, cb: Function) => {
      if (cmd === "git" && args[0] === "clone") {
        fs.mkdirSync(path.join(args[2], ".git"), { recursive: true }); // no package.json
      }
      cb(null, { stdout: "", stderr: "" });
    });
    await makeWorkspace();
    expect(mockExecFile).not.toHaveBeenCalledWith(
      "npm",
      expect.anything(),
      expect.anything(),
      expect.any(Function),
    );
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
    mockExecFile.mockImplementation((cmd: string, args: string[], _opts: object, cb: Function) => {
      if (cmd === "git" && args[0] === "fetch") {
        if (fetchCalls++ < 2) { cb(new Error("simulated network failure")); return; }
      }
      if (cmd === "git" && args[0] === "clone") {
        fs.mkdirSync(path.join(args[2], ".git", "info"), { recursive: true });
        fs.writeFileSync(path.join(args[2], "package.json"), "{}");
      }
      cb(null, { stdout: "", stderr: "" });
    });
    const ws = await makeWorkspace();
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
    const ws = await makeWorkspace();
    mockExecFile.mockClear();
    await ws.reset();
    expect(mockExecFile).toHaveBeenCalledWith("git", ["fetch", "origin"], { cwd: ws.dir }, expect.any(Function));
    expect(mockExecFile).toHaveBeenCalledWith("git", ["checkout", "main"], { cwd: ws.dir }, expect.any(Function));
    expect(mockExecFile).toHaveBeenCalledWith("git", ["reset", "--hard", "origin/main"], { cwd: ws.dir }, expect.any(Function));
    expect(mockExecFile).toHaveBeenCalledWith("git", ["clean", "-fdx", "-e", "node_modules", "-e", ".env", "-e", ".brunel.lock"], { cwd: ws.dir }, expect.any(Function));
  });

  it("runs npm install after git operations", async () => {
    const ws = await makeWorkspace();
    // makeWorkspace clone creates package.json; it persists through the mocked clean
    mockExecFile.mockClear();
    await ws.reset();
    expect(mockExecFile).toHaveBeenCalledWith("npm", ["install"], { cwd: ws.dir }, expect.any(Function));
  });

  it("does not run npm install on reset when repo has no package.json", async () => {
    const workerDir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(path.join(workerDir, ".git"), { recursive: true });
    // No package.json in this workspace
    const ws = await makeWorkspace();
    mockExecFile.mockClear();
    await ws.reset();
    expect(mockExecFile).not.toHaveBeenCalledWith("npm", expect.anything(), expect.anything(), expect.any(Function));
  });

  it("retries once on failure before succeeding", async () => {
    fs.mkdirSync(path.join(BASE_DIR, WORKER_ID, ".git"), { recursive: true });
    const ws = await makeWorkspace();

    let callCount = 0;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: object, cb: Function) => {
      callCount++;
      if (callCount === 1) { cb(new Error("network error")); } else { cb(null, { stdout: "", stderr: "" }); }
    });
    await ws.reset();
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("destroys and re-clones if both retries fail, then succeeds", async () => {
    const dir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    const ws = await makeWorkspace();
    mockExecFile.mockClear();

    let nonCloneCount = 0;
    mockExecFile.mockImplementation((cmd: string, args: string[], _opts: object, cb: Function) => {
      if (cmd === "git" && args[0] === "clone") {
        fs.mkdirSync(path.join(args[2], ".git"), { recursive: true });
        cb(null, { stdout: "", stderr: "" });
        return;
      }
      nonCloneCount++;
      if (nonCloneCount <= 2) { cb(new Error("reset fail")); } else { cb(null, { stdout: "", stderr: "" }); }
    });
    nonCloneCount = 0;
    await ws.reset();
    expect(mockExecFile).toHaveBeenCalledWith("git", expect.arrayContaining(["clone"]), {}, expect.any(Function));
  });

  it("throws if reset still fails after destroy + re-clone", async () => {
    const dir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    const ws = await makeWorkspace();

    mockExecFile.mockImplementation((cmd: string, args: string[], _opts: object, cb: Function) => {
      if (cmd === "git" && args[0] === "clone") {
        fs.mkdirSync(path.join(args[2], ".git"), { recursive: true });
        cb(null, { stdout: "", stderr: "" });
        return;
      }
      cb(new Error("always fails"));
    });
    await expect(ws.reset()).rejects.toThrow("always fails");
  });
});

// ── checkSafety ────────────────────────────────────────────────────────────

describe("Workspace.checkSafety", () => {
  it("returns empty arrays when working tree is clean and branch is pushed", async () => {
    setupExecMock({
      "status --porcelain": "",
      "log @{u}..HEAD --oneline": "",
    });
    const ws = await makeWorkspace();
    const result = await ws.checkSafety();
    expect(result.uncommittedFiles).toEqual([]);
    expect(result.unpushedCommits).toEqual([]);
    expect(result.noUpstream).toBe(false);
  });

  it("returns uncommitted files when working tree is dirty", async () => {
    setupExecMock({
      "status --porcelain": " M src/foo.ts\n?? newfile.ts",
      "log @{u}..HEAD --oneline": "",
    });
    const ws = await makeWorkspace();
    const result = await ws.checkSafety();
    expect(result.uncommittedFiles).toEqual(["M src/foo.ts", "?? newfile.ts"]);
  });

  it("returns unpushed commits when ahead of upstream", async () => {
    setupExecMock({
      "status --porcelain": "",
      "log @{u}..HEAD --oneline": "abc1234 feat: my commit",
    });
    const ws = await makeWorkspace();
    const result = await ws.checkSafety();
    expect(result.unpushedCommits).toEqual(["abc1234 feat: my commit"]);
    expect(result.noUpstream).toBe(false);
  });

  it("sets noUpstream when branch has no tracking remote", async () => {
    mockExecFile.mockImplementation((cmd: string, args: string[], _opts: object, cb: Function) => {
      if (cmd === "git" && args[0] === "clone") {
        fs.mkdirSync(path.join(args[2], ".git"), { recursive: true });
        cb(null, { stdout: "", stderr: "" });
        return;
      }
      if (cmd === "git" && args[0] === "status") { cb(null, { stdout: "", stderr: "" }); return; }
      if (cmd === "git" && args[0] === "log") {
        cb(new Error("fatal: no upstream configured for branch 'my-branch'"));
        return;
      }
      cb(null, { stdout: "", stderr: "" });
    });
    const ws = await makeWorkspace();
    const result = await ws.checkSafety();
    expect(result.noUpstream).toBe(true);
  });

  it("re-throws unexpected git errors (not 'no upstream')", async () => {
    mockExecFile.mockImplementation((cmd: string, args: string[], _opts: object, cb: Function) => {
      if (cmd === "git" && args[0] === "clone") {
        fs.mkdirSync(path.join(args[2], ".git"), { recursive: true });
        cb(null, { stdout: "", stderr: "" });
        return;
      }
      if (cmd === "git" && args[0] === "status") { cb(null, { stdout: "", stderr: "" }); return; }
      if (cmd === "git" && args[0] === "log") { cb(new Error("fatal: corrupt object store")); return; }
      cb(null, { stdout: "", stderr: "" });
    });
    const ws = await makeWorkspace();
    await expect(ws.checkSafety()).rejects.toThrow("corrupt object store");
  });
});

// ── confirmIfUnsafe ─────────────────────────────────────────────────────────

describe("confirmIfUnsafe", () => {
  it("returns true without calling confirm when workspace is clean", async () => {
    setupExecMock({
      "status --porcelain": "",
      "log @{u}..HEAD --oneline": "",
    });
    const ws = await makeWorkspace();
    const confirm = vi.fn().mockResolvedValue(true);
    const result = await confirmIfUnsafe(ws, confirm);
    expect(result).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("calls confirm with warning when there are uncommitted files", async () => {
    setupExecMock({
      "status --porcelain": " M src/foo.ts",
      "log @{u}..HEAD --oneline": "",
    });
    const ws = await makeWorkspace();
    const confirm = vi.fn().mockResolvedValue(true);
    const result = await confirmIfUnsafe(ws, confirm);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][0]).toContain("src/foo.ts");
    expect(result).toBe(true);
  });

  it("returns false when user declines", async () => {
    setupExecMock({
      "status --porcelain": " M src/foo.ts",
      "log @{u}..HEAD --oneline": "",
    });
    const ws = await makeWorkspace();
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

// ── attach ─────────────────────────────────────────────────────────────────────

describe("Workspace.attach", () => {
  it("marks isCreated, writes lockfile — skips clone and npm install", async () => {
    const workerDir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(path.join(workerDir, ".git"), { recursive: true });

    const ws = new Workspace(BASE_DIR, WORKER_ID, REPO_URL, "/original-cwd", async () => true);
    await ws.attach();

    expect(ws.isCreated).toBe(true);
    expect(fs.existsSync(path.join(workerDir, ".brunel.lock"))).toBe(true);
    expect(mockExecFile).not.toHaveBeenCalledWith("git", expect.arrayContaining(["clone"]), expect.anything(), expect.any(Function));
    expect(mockExecFile).not.toHaveBeenCalledWith("npm", expect.anything(), expect.anything(), expect.any(Function));
  });

  it("throws when the directory does not exist", async () => {
    const ws = new Workspace(BASE_DIR, "no-such-dir", REPO_URL, "/original-cwd", async () => true);
    await expect(ws.attach()).rejects.toThrow(/not found/i);
  });

  it("throws when directory has no .git", async () => {
    const workerDir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(workerDir, { recursive: true }); // no .git
    const ws = new Workspace(BASE_DIR, WORKER_ID, REPO_URL, "/original-cwd", async () => true);
    await expect(ws.attach()).rejects.toThrow(/not a git repository/i);
  });

  it("re-applies git auth when token is provided", async () => {
    const workerDir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(path.join(workerDir, ".git"), { recursive: true });

    const ws = new Workspace(BASE_DIR, WORKER_ID, REPO_URL, "/original-cwd", async () => true, "ghp_token");
    await ws.attach();

    const expected = "Authorization: Basic " + Buffer.from("x-access-token:ghp_token").toString("base64");
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["config", "--local", "http.https://github.com/.extraheader", expected],
      { cwd: workerDir },
      expect.any(Function),
    );
  });

  it("does not call git config when no token is provided", async () => {
    const workerDir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(path.join(workerDir, ".git"), { recursive: true });

    const ws = new Workspace(BASE_DIR, WORKER_ID, REPO_URL, "/original-cwd", async () => true);
    await ws.attach();

    const configCalls = mockExecFile.mock.calls.filter(
      ([cmd, args]) => cmd === "git" && (args as string[])[0] === "config",
    );
    expect(configCalls).toHaveLength(0);
  });

  it("adds .brunel.lock to .git/info/exclude after attach", async () => {
    const workerDir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(path.join(workerDir, ".git"), { recursive: true });

    const ws = new Workspace(BASE_DIR, WORKER_ID, REPO_URL, "/original-cwd", async () => true);
    await ws.attach();

    const excludePath = path.join(workerDir, ".git", "info", "exclude");
    expect(fs.existsSync(excludePath)).toBe(true);
    const lines = fs.readFileSync(excludePath, "utf8").split("\n").map(l => l.trim());
    expect(lines).toContain(".brunel.lock");
  });

  it("throws without overwriting lock when existing lock PID is alive", async () => {
    const workerDir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(path.join(workerDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(workerDir, ".brunel.lock"), String(process.pid));

    const ws = new Workspace(BASE_DIR, WORKER_ID, REPO_URL, "/original-cwd", async () => true);
    await expect(ws.attach()).rejects.toThrow(/still running/i);
    expect(ws.isCreated).toBe(false);
    // Lock should still have original PID, not be overwritten
    expect(fs.readFileSync(path.join(workerDir, ".brunel.lock"), "utf8").trim()).toBe(String(process.pid));
  });

  it("proceeds when existing lock PID is dead", async () => {
    const workerDir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(path.join(workerDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(workerDir, ".brunel.lock"), "2147483647");

    const ws = new Workspace(BASE_DIR, WORKER_ID, REPO_URL, "/original-cwd", async () => true);
    await ws.attach();
    expect(ws.isCreated).toBe(true);
    expect(fs.readFileSync(path.join(workerDir, ".brunel.lock"), "utf8").trim()).toBe(String(process.pid));
  });
});

// ── detach ─────────────────────────────────────────────────────────────────────

describe("Workspace.detach", () => {
  it("clears isCreated and removes the lock file without deleting the directory", async () => {
    const workerDir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(path.join(workerDir, ".git"), { recursive: true });

    const ws = new Workspace(BASE_DIR, WORKER_ID, REPO_URL, "/original-cwd", async () => true);
    await ws.attach();
    expect(ws.isCreated).toBe(true);

    ws.detach();

    expect(ws.isCreated).toBe(false);
    expect(fs.existsSync(path.join(workerDir, ".brunel.lock"))).toBe(false);
    expect(fs.existsSync(workerDir)).toBe(true);
  });

  it("is a no-op when no lock file exists", async () => {
    const workerDir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(path.join(workerDir, ".git"), { recursive: true });

    const ws = new Workspace(BASE_DIR, WORKER_ID, REPO_URL, "/original-cwd", async () => true);
    expect(() => ws.detach()).not.toThrow();
    expect(ws.isCreated).toBe(false);
  });
});

// ── http.extraHeader auth ─────────────────────────────────────────────────────

const CLEAN_REPO_URL = "https://github.com/owner/repo.git";

async function makeWorkspaceWithToken(token: string): Promise<Workspace> {
  const ws = new Workspace(BASE_DIR, WORKER_ID, CLEAN_REPO_URL, "/original-cwd", async () => true, token);
  await ws.create();
  return ws;
}

describe("Workspace git auth via extraHeader", () => {
  it("sets http.extraHeader via git config after clone when token is provided", async () => {
    await makeWorkspaceWithToken("ghp_mytoken");
    const expected = "Authorization: Basic " + Buffer.from("x-access-token:ghp_mytoken").toString("base64");
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["config", "--local", "http.https://github.com/.extraheader", expected],
      { cwd: path.join(BASE_DIR, WORKER_ID) },
      expect.any(Function),
    );
  });

  it("does not set http.extraHeader when no token is provided", async () => {
    await makeWorkspace();
    const configCalls = mockExecFile.mock.calls.filter(
      ([cmd, args]) => cmd === "git" && (args as string[])[0] === "config",
    );
    expect(configCalls).toHaveLength(0);
  });

  it("sets http.extraHeader after re-clone during reset when token is provided", async () => {
    let fetchCalls = 0;
    mockExecFile.mockImplementation((cmd: string, args: string[], _opts: object, cb: Function) => {
      if (cmd === "git" && args[0] === "fetch") {
        if (fetchCalls++ < 2) { cb(new Error("simulated network failure")); return; }
      }
      if (cmd === "git" && args[0] === "clone") {
        fs.mkdirSync(path.join(args[2], ".git", "info"), { recursive: true });
        fs.writeFileSync(path.join(args[2], "package.json"), "{}");
      }
      cb(null, { stdout: "", stderr: "" });
    });
    const ws = await makeWorkspaceWithToken("ghp_mytoken");
    mockExecFile.mockClear();
    fetchCalls = 0;
    await ws.reset();

    const expected = "Authorization: Basic " + Buffer.from("x-access-token:ghp_mytoken").toString("base64");
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["config", "--local", "http.https://github.com/.extraheader", expected],
      { cwd: path.join(BASE_DIR, WORKER_ID) },
      expect.any(Function),
    );
  });

  it("clone URL does not contain the token", async () => {
    await makeWorkspaceWithToken("ghp_secret");
    const cloneCalls = mockExecFile.mock.calls.filter(
      ([cmd, args]) => cmd === "git" && (args as string[])[0] === "clone",
    );
    expect(cloneCalls.length).toBeGreaterThan(0);
    const cloneUrl = cloneCalls[0][1][1] as string;
    expect(cloneUrl).not.toContain("ghp_secret");
    expect(cloneUrl).toBe(CLEAN_REPO_URL);
  });
});
