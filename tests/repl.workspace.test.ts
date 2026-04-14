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

import { Workspace, registerWorkspaceCommands } from "../src/agent/workspace.js";
import * as display from "../src/agent/display.js";
import { CommandRegistry } from "../src/agent/command-registry.js";
import { stripAnsi } from "./helpers.js";

const WORKSPACE_DIR = "/base";
const SESSION_ID = "test-session-uuid";
const REPO_URL = "https://x@github.com/owner/repo.git";
const ORIGINAL_CWD = "/original";

beforeEach(() => {
  vi.spyOn(Workspace, "prune").mockResolvedValue([]);
  vi.spyOn(process, "chdir").mockImplementation(() => undefined);
  vi.mocked(display.print).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

let registry: CommandRegistry;

/** Create a Workspace instance for testing (not yet cloned). */
function makeWorkspace(confirm = vi.fn().mockResolvedValue(true)): Workspace {
  const ws = new Workspace(WORKSPACE_DIR, SESSION_ID, REPO_URL, ORIGINAL_CWD, confirm);
  vi.spyOn(ws, "create").mockImplementation(async () => { ws.isCreated = true; });
  vi.spyOn(ws, "reset").mockResolvedValue(undefined);
  vi.spyOn(ws, "destroy").mockImplementation(async () => { ws.isCreated = false; });
  vi.spyOn(ws, "checkSafety").mockResolvedValue({ uncommittedFiles: [], unpushedCommits: [], noUpstream: false });
  return ws;
}

function makeAndRegister(workspace: Workspace | undefined): void {
  registry = new CommandRegistry();
  registerWorkspaceCommands(workspace, registry.scoped("workspace"));
}

// ── workspace:create ──────────────────────────────────────────────────────────

describe("workspace:create", () => {
  it("prints error if no workspace (no config)", async () => {
    makeAndRegister(undefined);
    await registry.execute("workspace:create", "");
    expect(stripAnsi(vi.mocked(display.print).mock.calls[0][0])).toContain("no GitHub repo configured");
  });

  it("prints error if workspace already exists", async () => {
    const ws = makeWorkspace();
    ws.isCreated = true;
    makeAndRegister(ws);
    await registry.execute("workspace:create", "");
    expect(stripAnsi(vi.mocked(display.print).mock.calls[0][0])).toContain("Workspace already exists");
    expect(ws.create).not.toHaveBeenCalled();
  });

  it("creates workspace, chdirs to it, and sets isCreated", async () => {
    const ws = makeWorkspace();
    makeAndRegister(ws);
    await registry.execute("workspace:create", "");
    expect(ws.create).toHaveBeenCalledOnce();
    expect(process.chdir).toHaveBeenCalledWith(ws.dir);
    expect(stripAnsi(vi.mocked(display.print).mock.calls[0][0])).toContain("Workspace created");
    expect(ws.isCreated).toBe(true);
  });
});

// ── workspace:reset ───────────────────────────────────────────────────────────

describe("workspace:reset", () => {
  it("prints error if no workspace exists", async () => {
    makeAndRegister(undefined);
    await registry.execute("workspace:reset", "");
    expect(stripAnsi(vi.mocked(display.print).mock.calls[0][0])).toContain("No workspace");
  });

  it("prints error if workspace not yet created", async () => {
    const ws = makeWorkspace();
    makeAndRegister(ws);
    await registry.execute("workspace:reset", "");
    expect(stripAnsi(vi.mocked(display.print).mock.calls[0][0])).toContain("No workspace");
    expect(ws.reset).not.toHaveBeenCalled();
  });

  it("resets workspace when clean", async () => {
    const ws = makeWorkspace();
    ws.isCreated = true;
    makeAndRegister(ws);
    await registry.execute("workspace:reset", "");
    expect(ws.reset).toHaveBeenCalled();
    expect(stripAnsi(vi.mocked(display.print).mock.calls[0][0])).toContain("Workspace reset to main");
  });

  it("skips reset if user declines confirmation", async () => {
    const ws = makeWorkspace(vi.fn().mockResolvedValue(false));
    ws.isCreated = true;
    vi.mocked(ws.checkSafety).mockResolvedValue({ uncommittedFiles: ["M foo.ts"], unpushedCommits: [], noUpstream: false });
    makeAndRegister(ws);
    await registry.execute("workspace:reset", "");
    expect(ws.reset).not.toHaveBeenCalled();
  });
});

// ── workspace:remove ──────────────────────────────────────────────────────────

describe("workspace:remove", () => {
  it("prints error if no workspace exists", async () => {
    makeAndRegister(undefined);
    await registry.execute("workspace:remove", "");
    expect(stripAnsi(vi.mocked(display.print).mock.calls[0][0])).toContain("No workspace in this session");
  });

  it("prints error if workspace not yet created", async () => {
    const ws = makeWorkspace();
    makeAndRegister(ws);
    await registry.execute("workspace:remove", "");
    expect(stripAnsi(vi.mocked(display.print).mock.calls[0][0])).toContain("No workspace in this session");
    expect(ws.destroy).not.toHaveBeenCalled();
  });

  it("destroys workspace, chdirs to originalCwd, sets isCreated to false", async () => {
    const ws = makeWorkspace();
    ws.isCreated = true;
    makeAndRegister(ws);
    await registry.execute("workspace:remove", "");
    expect(ws.destroy).toHaveBeenCalled();
    expect(process.chdir).toHaveBeenCalledWith(ORIGINAL_CWD);
    expect(stripAnsi(vi.mocked(display.print).mock.calls[0][0])).toContain("Workspace removed");
    expect(ws.isCreated).toBe(false);
  });

  it("skips removal if user declines confirmation", async () => {
    const ws = makeWorkspace(vi.fn().mockResolvedValue(false));
    ws.isCreated = true;
    vi.mocked(ws.checkSafety).mockResolvedValue({ uncommittedFiles: ["M foo.ts"], unpushedCommits: [], noUpstream: false });
    makeAndRegister(ws);
    await registry.execute("workspace:remove", "");
    expect(ws.destroy).not.toHaveBeenCalled();
    expect(process.chdir).not.toHaveBeenCalled();
    expect(ws.isCreated).toBe(true);
  });
});

// ── workspace:prune ───────────────────────────────────────────────────────────

describe("workspace:prune", () => {
  it("prints error if no workspace (no config)", async () => {
    makeAndRegister(undefined);
    await registry.execute("workspace:prune", "");
    expect(stripAnsi(vi.mocked(display.print).mock.calls[0][0])).toContain("no workspace directory configured");
  });

  it("prints 'Nothing to prune' when no orphans found", async () => {
    vi.mocked(Workspace.prune).mockResolvedValue([]);
    const ws = makeWorkspace();
    makeAndRegister(ws);
    await registry.execute("workspace:prune", "");
    expect(Workspace.prune).toHaveBeenCalledWith(WORKSPACE_DIR);
    expect(stripAnsi(vi.mocked(display.print).mock.calls[0][0])).toContain("Nothing to prune");
  });

  it("lists removed dirs and prints summary when orphans are pruned", async () => {
    vi.mocked(Workspace.prune).mockResolvedValue(["/base/abc", "/base/def"]);
    const ws = makeWorkspace();
    makeAndRegister(ws);
    await registry.execute("workspace:prune", "");
    const allOutput = vi.mocked(display.print).mock.calls.map(c => stripAnsi(c[0])).join("\n");
    expect(allOutput).toContain("/base/abc");
    expect(allOutput).toContain("/base/def");
    expect(allOutput).toContain("Pruned 2 orphaned workspace(s)");
  });
});
