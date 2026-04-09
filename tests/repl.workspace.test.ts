import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Prevent SDK import side-effects
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
// Prevent repl.ts from writing log entries to disk
vi.mock("fs", () => ({ default: { appendFileSync: vi.fn() } }));

import { Workspace, registerWorkspaceCommands } from "../src/agent/workspace.js";
import { execute, _reset } from "../src/agent/commands.js";
import { stripAnsi } from "./helpers.js";

const cfg = { workspaceDir: "/base", repoUrl: "https://x@github.com/owner/repo.git" };
const SESSION_ID = "test-session-uuid";
const ORIGINAL_CWD = "/original";

const mockInstance = {
  dir: "/fake/workspace",
  reset: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
  checkSafety: vi.fn().mockResolvedValue({ uncommittedFiles: [], unpushedCommits: [], noUpstream: false }),
} as unknown as Workspace;

beforeEach(() => {
  vi.spyOn(Workspace, "create").mockResolvedValue(mockInstance);
  vi.spyOn(Workspace, "prune").mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeAndRegister(overrides: Record<string, unknown> = {}) {
  _reset();
  let workspace: Workspace | undefined = undefined;
  const deps = {
    getWorkspace: () => workspace,
    setWorkspace: (ws: Workspace | undefined) => { workspace = ws; },
    workspaceCfg: cfg as { workspaceDir: string; repoUrl: string } | undefined,
    sessionId: SESSION_ID,
    originalCwd: ORIGINAL_CWD,
    confirmIfUnsafe: vi.fn().mockResolvedValue(true),
    confirm: vi.fn().mockResolvedValue(true),
    print: vi.fn(),
    chdir: vi.fn(),
    ...overrides,
  };
  registerWorkspaceCommands("workspace", deps);
  return deps;
}

// ── workspace:create ──────────────────────────────────────────────────────────

describe("workspace:create", () => {
  it("prints error if no workspaceCfg", async () => {
    const deps = makeAndRegister({ workspaceCfg: undefined });
    await execute("workspace:create", "");
    expect(stripAnsi(vi.mocked(deps.print).mock.calls[0][0])).toContain("no GitHub repo configured");
    expect(Workspace.create).not.toHaveBeenCalled();
  });

  it("prints error if workspace already exists", async () => {
    const existing = { dir: "/existing" } as any;
    const deps = makeAndRegister();
    deps.setWorkspace(existing);
    await execute("workspace:create", "");
    expect(stripAnsi(vi.mocked(deps.print).mock.calls[0][0])).toContain("Workspace already exists");
    expect(Workspace.create).not.toHaveBeenCalled();
  });

  it("creates workspace, calls chdir, and sets workspace via setWorkspace", async () => {
    const deps = makeAndRegister();
    await execute("workspace:create", "");
    expect(Workspace.create).toHaveBeenCalledWith(cfg.workspaceDir, SESSION_ID, cfg.repoUrl);
    expect(vi.mocked(deps.chdir)).toHaveBeenCalledWith("/fake/workspace");
    expect(stripAnsi(vi.mocked(deps.print).mock.calls[0][0])).toContain("Workspace created");
    expect(deps.getWorkspace()).toBeTruthy();
    expect(deps.getWorkspace()!.dir).toBe("/fake/workspace");
  });
});

// ── workspace:reset ───────────────────────────────────────────────────────────

describe("workspace:reset", () => {
  it("prints error if no workspace exists", async () => {
    const deps = makeAndRegister();
    await execute("workspace:reset", "");
    expect(stripAnsi(vi.mocked(deps.print).mock.calls[0][0])).toContain("No workspace");
  });

  it("resets workspace and prints success when safe", async () => {
    const ws = { dir: "/ws", reset: vi.fn().mockResolvedValue(undefined), destroy: vi.fn(), checkSafety: vi.fn().mockResolvedValue({ uncommittedFiles: [], unpushedCommits: [], noUpstream: false }) } as any;
    const deps = makeAndRegister();
    deps.setWorkspace(ws);
    await execute("workspace:reset", "");
    expect(deps.confirmIfUnsafe).toHaveBeenCalledWith(ws, deps.confirm);
    expect(ws.reset).toHaveBeenCalled();
    expect(stripAnsi(vi.mocked(deps.print).mock.calls[0][0])).toContain("Workspace reset to main");
  });

  it("skips reset if user declines confirmation", async () => {
    const ws = { dir: "/ws", reset: vi.fn(), destroy: vi.fn(), checkSafety: vi.fn() } as any;
    const deps = makeAndRegister({ confirmIfUnsafe: vi.fn().mockResolvedValue(false) });
    deps.setWorkspace(ws);
    await execute("workspace:reset", "");
    expect(ws.reset).not.toHaveBeenCalled();
    expect(deps.getWorkspace()).toBe(ws);
  });
});

// ── workspace:remove ──────────────────────────────────────────────────────────

describe("workspace:remove", () => {
  it("prints error if no workspace exists", async () => {
    const deps = makeAndRegister();
    await execute("workspace:remove", "");
    expect(stripAnsi(vi.mocked(deps.print).mock.calls[0][0])).toContain("No workspace in this session");
  });

  it("destroys workspace, chdir to originalCwd, clears workspace", async () => {
    const ws = { dir: "/ws", reset: vi.fn(), destroy: vi.fn().mockResolvedValue(undefined), checkSafety: vi.fn().mockResolvedValue({ uncommittedFiles: [], unpushedCommits: [], noUpstream: false }) } as any;
    const deps = makeAndRegister();
    deps.setWorkspace(ws);
    await execute("workspace:remove", "");
    expect(deps.confirmIfUnsafe).toHaveBeenCalledWith(ws, deps.confirm);
    expect(ws.destroy).toHaveBeenCalled();
    expect(vi.mocked(deps.chdir)).toHaveBeenCalledWith(ORIGINAL_CWD);
    expect(stripAnsi(vi.mocked(deps.print).mock.calls[0][0])).toContain("Workspace removed");
    expect(deps.getWorkspace()).toBeUndefined();
  });

  it("skips removal if user declines confirmation", async () => {
    const ws = { dir: "/ws", reset: vi.fn(), destroy: vi.fn(), checkSafety: vi.fn() } as any;
    const deps = makeAndRegister({ confirmIfUnsafe: vi.fn().mockResolvedValue(false) });
    deps.setWorkspace(ws);
    await execute("workspace:remove", "");
    expect(ws.destroy).not.toHaveBeenCalled();
    expect(vi.mocked(deps.chdir)).not.toHaveBeenCalled();
    expect(deps.getWorkspace()).toBe(ws);
  });
});

// ── workspace:prune ───────────────────────────────────────────────────────────

describe("workspace:prune", () => {
  it("prints error if no workspaceCfg", async () => {
    const deps = makeAndRegister({ workspaceCfg: undefined });
    await execute("workspace:prune", "");
    expect(stripAnsi(vi.mocked(deps.print).mock.calls[0][0])).toContain("no workspace directory configured");
  });

  it("prints 'Nothing to prune' when no orphans found", async () => {
    vi.mocked(Workspace.prune).mockResolvedValue([]);
    const deps = makeAndRegister();
    await execute("workspace:prune", "");
    expect(Workspace.prune).toHaveBeenCalledWith(cfg.workspaceDir);
    expect(stripAnsi(vi.mocked(deps.print).mock.calls[0][0])).toContain("Nothing to prune");
  });

  it("lists removed dirs and prints summary when orphans are pruned", async () => {
    vi.mocked(Workspace.prune).mockResolvedValue(["/base/abc", "/base/def"]);
    const deps = makeAndRegister();
    await execute("workspace:prune", "");
    const allOutput = vi.mocked(deps.print).mock.calls.map(c => stripAnsi(c[0])).join("\n");
    expect(allOutput).toContain("/base/abc");
    expect(allOutput).toContain("/base/def");
    expect(allOutput).toContain("Pruned 2 orphaned workspace(s)");
  });
});
