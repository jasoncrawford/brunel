import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Workspace } from "../src/workspace.js";

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
