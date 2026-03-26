import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Workspace, confirmIfUnsafe } from "../src/workspace.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const BASE_DIR = path.join(os.tmpdir(), `brunel-test-${process.pid}`);
const WORKER_ID = "test-worker-abc";
const REPO_URL = "https://token@github.com/owner/repo.git";

function makeExec(responses: Record<string, string> = {}) {
  return vi.fn().mockImplementation(async (args: string[]) => {
    const key = args.join(" ");
    return responses[key] ?? "";
  });
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
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    expect(exec).toHaveBeenCalledWith(
      ["clone", REPO_URL, path.join(BASE_DIR, WORKER_ID)],
      undefined,
    );
    expect(ws.dir).toBe(path.join(BASE_DIR, WORKER_ID));
  });

  it("skips git clone if directory already exists", async () => {
    const workerDir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(workerDir);
    const exec = makeExec();
    await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    expect(exec).not.toHaveBeenCalledWith(
      expect.arrayContaining(["clone"]),
      expect.anything(),
    );
  });

  it("writes a PID lockfile containing the current PID", async () => {
    const exec = makeExec();
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    // create() only writes the lockfile when cloning (dir didn't exist before)
    const lockPath = path.join(ws.dir, ".brunel.lock");
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
  });
});

// ── destroy ────────────────────────────────────────────────────────────────

describe("Workspace.destroy", () => {
  it("removes the workspace directory", async () => {
    const exec = makeExec();
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    expect(fs.existsSync(ws.dir)).toBe(true);
    await ws.destroy();
    expect(fs.existsSync(ws.dir)).toBe(false);
  });
});

// ── reset ──────────────────────────────────────────────────────────────────

describe("Workspace.reset", () => {
  it("runs fetch, checkout main, reset --hard, clean -fdx", async () => {
    const exec = makeExec();
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    exec.mockClear();
    await ws.reset();
    expect(exec).toHaveBeenCalledWith(["fetch", "origin"], ws.dir);
    expect(exec).toHaveBeenCalledWith(["checkout", "main"], ws.dir);
    expect(exec).toHaveBeenCalledWith(["reset", "--hard", "origin/main"], ws.dir);
    expect(exec).toHaveBeenCalledWith(["clean", "-fdx"], ws.dir);
  });

  it("retries once on failure before succeeding", async () => {
    const exec = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("");
    // Pre-create the dir so create() skips cloning
    fs.mkdirSync(path.join(BASE_DIR, WORKER_ID), { recursive: true });
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    exec.mockClear();
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
    fs.mkdirSync(dir, { recursive: true });
    let callCount = 0;
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "clone") return ""; // clone always succeeds
      callCount++;
      if (callCount <= 2) throw new Error("reset fail");
      return ""; // third attempt (after re-clone) succeeds
    });
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    exec.mockClear();
    callCount = 0;
    await ws.reset();
    expect(exec).toHaveBeenCalledWith(expect.arrayContaining(["clone"]), undefined);
  });

  it("throws if reset still fails after destroy + re-clone", async () => {
    const dir = path.join(BASE_DIR, WORKER_ID);
    fs.mkdirSync(dir, { recursive: true });
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "clone") return "";
      throw new Error("always fails");
    });
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
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
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
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
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    const result = await ws.checkSafety();
    expect(result.uncommittedFiles).toEqual(["M src/foo.ts", "?? newfile.ts"]);
  });

  it("returns unpushed commits when ahead of upstream", async () => {
    const exec = makeExec({
      "status --porcelain": "",
      "log @{u}..HEAD --oneline": "abc1234 feat: my commit",
    });
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    const result = await ws.checkSafety();
    expect(result.unpushedCommits).toEqual(["abc1234 feat: my commit"]);
    expect(result.noUpstream).toBe(false);
  });

  it("sets noUpstream when branch has no tracking remote", async () => {
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "status") return "";
      if (args[0] === "log") throw new Error("fatal: no upstream configured for branch 'my-branch'");
      return "";
    });
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    const result = await ws.checkSafety();
    expect(result.noUpstream).toBe(true);
  });
});

// ── confirmIfUnsafe ─────────────────────────────────────────────────────────

describe("confirmIfUnsafe", () => {
  it("returns true without calling confirm when workspace is clean", async () => {
    const exec = makeExec({
      "status --porcelain": "",
      "log @{u}..HEAD --oneline": "",
    });
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
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
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
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
    const ws = await Workspace.create(BASE_DIR, WORKER_ID, REPO_URL, exec);
    const confirm = vi.fn().mockResolvedValue(false);
    const result = await confirmIfUnsafe(ws, confirm);
    expect(result).toBe(false);
  });
});
