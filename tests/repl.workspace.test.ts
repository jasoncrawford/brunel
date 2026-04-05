import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock workspace module before importing repl
vi.mock("../src/agent/workspace.js", () => {
  const mockInstance = {
    dir: "/fake/workspace",
    reset: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    checkSafety: vi.fn().mockResolvedValue({ uncommittedFiles: [], unpushedCommits: [], noUpstream: false }),
  };
  return {
    Workspace: {
      create: vi.fn().mockResolvedValue(mockInstance),
      prune: vi.fn().mockResolvedValue([]),
    },
    confirmIfUnsafe: vi.fn().mockResolvedValue(true),
  };
});

// Prevent repl.ts from writing log entries to disk
vi.mock("fs", () => ({ default: { appendFileSync: vi.fn() } }));

// Prevent SDK import side-effects
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

import { handleWorkspaceAction } from "../src/agent/index.js";
import { Workspace, confirmIfUnsafe } from "../src/agent/workspace.js";
import { stripAnsi } from "./helpers.js";

const cfg = { workspaceDir: "/base", repoUrl: "https://x@github.com/owner/repo.git" };
const SESSION_ID = "test-session-uuid";
const ORIGINAL_CWD = "/original";

function makeParams(
  overrides: Partial<Parameters<typeof handleWorkspaceAction>[1]> = {},
): Parameters<typeof handleWorkspaceAction>[1] {
  return {
    workspaceCfg: cfg,
    workspace: undefined,
    sessionId_: SESSION_ID,
    originalCwd: ORIGINAL_CWD,
    confirm: vi.fn().mockResolvedValue(true),
    print: vi.fn(),
    chdir: vi.fn(),
    ...overrides,
  };
}

// Reset mocks between tests
beforeEach(() => {
  vi.mocked(Workspace.create).mockResolvedValue({ dir: "/fake/workspace", reset: vi.fn(), destroy: vi.fn(), checkSafety: vi.fn() } as any);
  vi.mocked(Workspace.prune).mockResolvedValue([]);
  vi.mocked(confirmIfUnsafe).mockResolvedValue(true);
});

// ── /create-workspace ─────────────────────────────────────────────────────────

describe("handleWorkspaceAction — create-workspace", () => {
  it("prints error and returns undefined if no workspaceCfg", async () => {
    const params = makeParams({ workspaceCfg: undefined });
    const result = await handleWorkspaceAction("create-workspace", params);
    expect(stripAnsi(vi.mocked(params.print).mock.calls[0][0])).toContain("no GitHub repo configured");
    expect(result).toBeUndefined();
    expect(Workspace.create).not.toHaveBeenCalled();
  });

  it("prints error and returns existing workspace if one already exists", async () => {
    const existing = { dir: "/existing" } as any;
    const params = makeParams({ workspace: existing });
    const result = await handleWorkspaceAction("create-workspace", params);
    expect(stripAnsi(vi.mocked(params.print).mock.calls[0][0])).toContain("Workspace already exists");
    expect(result).toBe(existing);
    expect(Workspace.create).not.toHaveBeenCalled();
  });

  it("creates workspace, calls chdir, and returns new workspace", async () => {
    const params = makeParams();
    const result = await handleWorkspaceAction("create-workspace", params);
    expect(Workspace.create).toHaveBeenCalledWith(cfg.workspaceDir, SESSION_ID, cfg.repoUrl);
    expect(vi.mocked(params.chdir)).toHaveBeenCalledWith("/fake/workspace");
    expect(stripAnsi(vi.mocked(params.print).mock.calls[0][0])).toContain("Workspace created");
    expect(result).toBeTruthy();
    expect(result!.dir).toBe("/fake/workspace");
  });
});

// ── /reset-workspace ──────────────────────────────────────────────────────────

describe("handleWorkspaceAction — reset-workspace", () => {
  it("prints error and returns undefined if no workspace exists", async () => {
    const params = makeParams();
    const result = await handleWorkspaceAction("reset-workspace", params);
    expect(stripAnsi(vi.mocked(params.print).mock.calls[0][0])).toContain("No workspace");
    expect(result).toBeUndefined();
  });

  it("resets workspace and prints success when safe", async () => {
    const ws = { dir: "/ws", reset: vi.fn().mockResolvedValue(undefined), destroy: vi.fn(), checkSafety: vi.fn() } as any;
    const params = makeParams({ workspace: ws });
    const result = await handleWorkspaceAction("reset-workspace", params);
    expect(confirmIfUnsafe).toHaveBeenCalledWith(ws, params.confirm);
    expect(ws.reset).toHaveBeenCalled();
    expect(stripAnsi(vi.mocked(params.print).mock.calls[0][0])).toContain("Workspace reset to main");
    expect(result).toBe(ws);
  });

  it("skips reset if user declines confirmation", async () => {
    const ws = { dir: "/ws", reset: vi.fn(), destroy: vi.fn(), checkSafety: vi.fn() } as any;
    vi.mocked(confirmIfUnsafe).mockResolvedValue(false);
    const params = makeParams({ workspace: ws });
    const result = await handleWorkspaceAction("reset-workspace", params);
    expect(ws.reset).not.toHaveBeenCalled();
    expect(result).toBe(ws);
  });
});

// ── /remove-workspace ─────────────────────────────────────────────────────────

describe("handleWorkspaceAction — remove-workspace", () => {
  it("prints error and returns undefined if no workspace exists", async () => {
    const params = makeParams();
    const result = await handleWorkspaceAction("remove-workspace", params);
    expect(stripAnsi(vi.mocked(params.print).mock.calls[0][0])).toContain("No workspace in this session");
    expect(result).toBeUndefined();
  });

  it("destroys workspace, chdir to originalCwd, and returns undefined", async () => {
    const ws = { dir: "/ws", reset: vi.fn(), destroy: vi.fn().mockResolvedValue(undefined), checkSafety: vi.fn() } as any;
    const params = makeParams({ workspace: ws });
    const result = await handleWorkspaceAction("remove-workspace", params);
    expect(confirmIfUnsafe).toHaveBeenCalledWith(ws, params.confirm);
    expect(ws.destroy).toHaveBeenCalled();
    expect(vi.mocked(params.chdir)).toHaveBeenCalledWith(ORIGINAL_CWD);
    expect(stripAnsi(vi.mocked(params.print).mock.calls[0][0])).toContain("Workspace removed");
    expect(result).toBeUndefined();
  });

  it("skips removal if user declines confirmation", async () => {
    const ws = { dir: "/ws", reset: vi.fn(), destroy: vi.fn(), checkSafety: vi.fn() } as any;
    vi.mocked(confirmIfUnsafe).mockResolvedValue(false);
    const params = makeParams({ workspace: ws });
    const result = await handleWorkspaceAction("remove-workspace", params);
    expect(ws.destroy).not.toHaveBeenCalled();
    expect(vi.mocked(params.chdir)).not.toHaveBeenCalled();
    expect(result).toBe(ws);
  });
});

// ── /prune ────────────────────────────────────────────────────────────────────

describe("handleWorkspaceAction — prune", () => {
  it("prints error if no workspaceCfg", async () => {
    const params = makeParams({ workspaceCfg: undefined });
    await handleWorkspaceAction("prune", params);
    expect(stripAnsi(vi.mocked(params.print).mock.calls[0][0])).toContain("no workspace directory configured");
  });

  it("prints 'Nothing to prune' when no orphans found", async () => {
    vi.mocked(Workspace.prune).mockResolvedValue([]);
    const params = makeParams();
    await handleWorkspaceAction("prune", params);
    expect(Workspace.prune).toHaveBeenCalledWith(cfg.workspaceDir);
    expect(stripAnsi(vi.mocked(params.print).mock.calls[0][0])).toContain("Nothing to prune");
  });

  it("lists removed dirs and prints summary when orphans are pruned", async () => {
    vi.mocked(Workspace.prune).mockResolvedValue(["/base/abc", "/base/def"]);
    const params = makeParams();
    await handleWorkspaceAction("prune", params);
    const allOutput = vi.mocked(params.print).mock.calls.map(c => stripAnsi(c[0])).join("\n");
    expect(allOutput).toContain("/base/abc");
    expect(allOutput).toContain("/base/def");
    expect(allOutput).toContain("Pruned 2 orphaned workspace(s)");
  });
});
