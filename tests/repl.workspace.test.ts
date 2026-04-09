import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Prevent SDK import side-effects
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
// Prevent repl.ts from writing log entries to disk
vi.mock("fs", () => ({ default: { appendFileSync: vi.fn() } }));
// Mock display.print so workspace handlers don't write to stdout in tests
vi.mock("../src/agent/display.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/display.js")>();
  return { ...actual, print: vi.fn() };
});

import { Workspace, registerWorkspaceCommands, type WorkspaceCommandDeps } from "../src/agent/workspace.js";
import * as display from "../src/agent/display.js";
import { execute, _reset } from "../src/agent/commands.js";
import { stripAnsi } from "./helpers.js";

const cfg = { workspaceDir: "/base", repoUrl: "https://x@github.com/owner/repo.git", sessionId: "test-session-uuid" };
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
  vi.spyOn(process, "chdir").mockImplementation(() => undefined);
  vi.mocked(display.print).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeAndRegister(overrides: Partial<WorkspaceCommandDeps> = {}) {
  _reset();
  const workspaceRef: { current: Workspace | undefined } = { current: undefined };
  const deps: WorkspaceCommandDeps = {
    workspace: workspaceRef,
    config: cfg,
    originalCwd: ORIGINAL_CWD,
    confirm: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  registerWorkspaceCommands(deps);
  return deps;
}

// ── workspace:create ──────────────────────────────────────────────────────────

describe("workspace:create", () => {
  it("prints error if no config", async () => {
    makeAndRegister({ config: undefined });
    await execute("workspace:create", "");
    expect(stripAnsi(vi.mocked(display.print).mock.calls[0][0])).toContain("no GitHub repo configured");
    expect(Workspace.create).not.toHaveBeenCalled();
  });

  it("prints error if workspace already exists", async () => {
    const existing = { dir: "/existing" } as any;
    const deps = makeAndRegister();
    deps.workspace.current = existing;
    await execute("workspace:create", "");
    expect(stripAnsi(vi.mocked(display.print).mock.calls[0][0])).toContain("Workspace already exists");
    expect(Workspace.create).not.toHaveBeenCalled();
  });

  it("creates workspace, chdirs to it, and sets workspace.current", async () => {
    const deps = makeAndRegister();
    await execute("workspace:create", "");
    expect(Workspace.create).toHaveBeenCalledWith(cfg.workspaceDir, cfg.sessionId, cfg.repoUrl);
    expect(process.chdir).toHaveBeenCalledWith("/fake/workspace");
    expect(stripAnsi(vi.mocked(display.print).mock.calls[0][0])).toContain("Workspace created");
    expect(deps.workspace.current).toBeTruthy();
    expect(deps.workspace.current!.dir).toBe("/fake/workspace");
  });
});

// ── workspace:reset ───────────────────────────────────────────────────────────

describe("workspace:reset", () => {
  it("prints error if no workspace exists", async () => {
    makeAndRegister();
    await execute("workspace:reset", "");
    expect(stripAnsi(vi.mocked(display.print).mock.calls[0][0])).toContain("No workspace");
  });

  it("resets workspace when clean", async () => {
    const ws = { dir: "/ws", reset: vi.fn().mockResolvedValue(undefined), destroy: vi.fn(),
      checkSafety: vi.fn().mockResolvedValue({ uncommittedFiles: [], unpushedCommits: [], noUpstream: false }) } as any;
    const deps = makeAndRegister();
    deps.workspace.current = ws;
    await execute("workspace:reset", "");
    expect(ws.reset).toHaveBeenCalled();
    expect(stripAnsi(vi.mocked(display.print).mock.calls[0][0])).toContain("Workspace reset to main");
  });

  it("skips reset if user declines confirmation", async () => {
    const ws = { dir: "/ws", reset: vi.fn(), destroy: vi.fn(),
      checkSafety: vi.fn().mockResolvedValue({ uncommittedFiles: ["M foo.ts"], unpushedCommits: [], noUpstream: false }) } as any;
    const deps = makeAndRegister({ confirm: vi.fn().mockResolvedValue(false) });
    deps.workspace.current = ws;
    await execute("workspace:reset", "");
    expect(ws.reset).not.toHaveBeenCalled();
    expect(deps.workspace.current).toBe(ws);
  });
});

// ── workspace:remove ──────────────────────────────────────────────────────────

describe("workspace:remove", () => {
  it("prints error if no workspace exists", async () => {
    makeAndRegister();
    await execute("workspace:remove", "");
    expect(stripAnsi(vi.mocked(display.print).mock.calls[0][0])).toContain("No workspace in this session");
  });

  it("destroys workspace, chdirs to originalCwd, clears workspace.current", async () => {
    const ws = { dir: "/ws", reset: vi.fn(), destroy: vi.fn().mockResolvedValue(undefined),
      checkSafety: vi.fn().mockResolvedValue({ uncommittedFiles: [], unpushedCommits: [], noUpstream: false }) } as any;
    const deps = makeAndRegister();
    deps.workspace.current = ws;
    await execute("workspace:remove", "");
    expect(ws.destroy).toHaveBeenCalled();
    expect(process.chdir).toHaveBeenCalledWith(ORIGINAL_CWD);
    expect(stripAnsi(vi.mocked(display.print).mock.calls[0][0])).toContain("Workspace removed");
    expect(deps.workspace.current).toBeUndefined();
  });

  it("skips removal if user declines confirmation", async () => {
    const ws = { dir: "/ws", reset: vi.fn(), destroy: vi.fn(),
      checkSafety: vi.fn().mockResolvedValue({ uncommittedFiles: ["M foo.ts"], unpushedCommits: [], noUpstream: false }) } as any;
    const deps = makeAndRegister({ confirm: vi.fn().mockResolvedValue(false) });
    deps.workspace.current = ws;
    await execute("workspace:remove", "");
    expect(ws.destroy).not.toHaveBeenCalled();
    expect(process.chdir).not.toHaveBeenCalled();
    expect(deps.workspace.current).toBe(ws);
  });
});

// ── workspace:prune ───────────────────────────────────────────────────────────

describe("workspace:prune", () => {
  it("prints error if no config", async () => {
    makeAndRegister({ config: undefined });
    await execute("workspace:prune", "");
    expect(stripAnsi(vi.mocked(display.print).mock.calls[0][0])).toContain("no workspace directory configured");
  });

  it("prints 'Nothing to prune' when no orphans found", async () => {
    vi.mocked(Workspace.prune).mockResolvedValue([]);
    makeAndRegister();
    await execute("workspace:prune", "");
    expect(Workspace.prune).toHaveBeenCalledWith(cfg.workspaceDir);
    expect(stripAnsi(vi.mocked(display.print).mock.calls[0][0])).toContain("Nothing to prune");
  });

  it("lists removed dirs and prints summary when orphans are pruned", async () => {
    vi.mocked(Workspace.prune).mockResolvedValue(["/base/abc", "/base/def"]);
    makeAndRegister();
    await execute("workspace:prune", "");
    const allOutput = vi.mocked(display.print).mock.calls.map(c => stripAnsi(c[0])).join("\n");
    expect(allOutput).toContain("/base/abc");
    expect(allOutput).toContain("/base/def");
    expect(allOutput).toContain("Pruned 2 orphaned workspace(s)");
  });
});
