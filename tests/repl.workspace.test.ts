import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Prevent SDK import side-effects
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
// Prevent repl.ts from writing log entries to disk
vi.mock("fs", () => ({ default: { appendFileSync: vi.fn() } }));

import { Workspace } from "../src/agent/models/workspace.js";
import { WorkspaceController } from "../src/agent/controllers/workspace-controller.js";
import { CommandRegistry, CommandController } from "../src/agent/controllers/command-controller.js";
import { stripAnsi } from "./helpers.js";

const WORKSPACE_DIR = "/base";
const SESSION_ID = "test-session-uuid";
const REPO_URL = "https://x@github.com/owner/repo.git";
const ORIGINAL_CWD = "/original";

let testDisplay: { print: ReturnType<typeof vi.fn>; printForemanMessage: ReturnType<typeof vi.fn> };
let testConfig: { verbose: boolean };

beforeEach(() => {
  testDisplay = { print: vi.fn(), printForemanMessage: vi.fn() };
  testConfig = { verbose: false };
  vi.spyOn(process, "chdir").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

let registry: CommandController;

/** Create a Workspace instance for testing (not yet cloned). */
function makeWorkspace(confirm = vi.fn().mockResolvedValue(true)): Workspace {
  const ws = new Workspace(WORKSPACE_DIR, SESSION_ID, REPO_URL, ORIGINAL_CWD, confirm);
  vi.spyOn(ws, "create").mockImplementation(async () => { ws.isCreated = true; });
  vi.spyOn(ws, "reset").mockResolvedValue(undefined);
  vi.spyOn(ws, "destroy").mockImplementation(async () => { ws.isCreated = false; });
  vi.spyOn(ws, "checkSafety").mockResolvedValue({ uncommittedFiles: [], unpushedCommits: [], noUpstream: false });
  vi.spyOn(ws, "prune").mockResolvedValue([]);
  return ws;
}

function makeAndRegister(workspace: Workspace | undefined): void {
  const reg = new CommandRegistry();
  registry = new CommandController(reg);
  new WorkspaceController(workspace, testDisplay, testConfig).registerCommands(reg.scoped("workspace"));
}

// ── workspace:create ──────────────────────────────────────────────────────────

describe("workspace:create", () => {
  it("prints error if no workspace (no config)", async () => {
    makeAndRegister(undefined);
    await registry.registry.execute("workspace:create", "");
    expect(stripAnsi(testDisplay.print.mock.calls[0][0])).toContain("no GitHub repo configured");
  });

  it("prints error if workspace already exists", async () => {
    const ws = makeWorkspace();
    ws.isCreated = true;
    makeAndRegister(ws);
    await registry.registry.execute("workspace:create", "");
    expect(stripAnsi(testDisplay.print.mock.calls[0][0])).toContain("Workspace already exists");
    expect(ws.create).not.toHaveBeenCalled();
  });

  it("creates workspace, chdirs to it, and sets isCreated", async () => {
    const ws = makeWorkspace();
    makeAndRegister(ws);
    await registry.registry.execute("workspace:create", "");
    expect(ws.create).toHaveBeenCalledOnce();
    expect(process.chdir).toHaveBeenCalledWith(ws.dir);
    expect(stripAnsi(testDisplay.print.mock.calls[0][0])).toContain("Workspace created");
    expect(ws.isCreated).toBe(true);
  });
});

// ── workspace:reset ───────────────────────────────────────────────────────────

describe("workspace:reset", () => {
  it("prints error if no workspace exists", async () => {
    makeAndRegister(undefined);
    await registry.registry.execute("workspace:reset", "");
    expect(stripAnsi(testDisplay.print.mock.calls[0][0])).toContain("No workspace");
  });

  it("prints error if workspace not yet created", async () => {
    const ws = makeWorkspace();
    makeAndRegister(ws);
    await registry.registry.execute("workspace:reset", "");
    expect(stripAnsi(testDisplay.print.mock.calls[0][0])).toContain("No workspace");
    expect(ws.reset).not.toHaveBeenCalled();
  });

  it("resets workspace when clean", async () => {
    const ws = makeWorkspace();
    ws.isCreated = true;
    makeAndRegister(ws);
    await registry.registry.execute("workspace:reset", "");
    expect(ws.reset).toHaveBeenCalled();
    expect(stripAnsi(testDisplay.print.mock.calls[0][0])).toContain("Workspace reset to main");
  });

  it("skips reset if user declines confirmation", async () => {
    const ws = makeWorkspace(vi.fn().mockResolvedValue(false));
    ws.isCreated = true;
    vi.mocked(ws.checkSafety).mockResolvedValue({ uncommittedFiles: ["M foo.ts"], unpushedCommits: [], noUpstream: false });
    makeAndRegister(ws);
    await registry.registry.execute("workspace:reset", "");
    expect(ws.reset).not.toHaveBeenCalled();
  });
});

// ── workspace:remove ──────────────────────────────────────────────────────────

describe("workspace:remove", () => {
  it("prints error if no workspace exists", async () => {
    makeAndRegister(undefined);
    await registry.registry.execute("workspace:remove", "");
    expect(stripAnsi(testDisplay.print.mock.calls[0][0])).toContain("No workspace in this session");
  });

  it("prints error if workspace not yet created", async () => {
    const ws = makeWorkspace();
    makeAndRegister(ws);
    await registry.registry.execute("workspace:remove", "");
    expect(stripAnsi(testDisplay.print.mock.calls[0][0])).toContain("No workspace in this session");
    expect(ws.destroy).not.toHaveBeenCalled();
  });

  it("destroys workspace, chdirs to originalCwd, sets isCreated to false", async () => {
    const ws = makeWorkspace();
    ws.isCreated = true;
    makeAndRegister(ws);
    await registry.registry.execute("workspace:remove", "");
    expect(ws.destroy).toHaveBeenCalled();
    expect(process.chdir).toHaveBeenCalledWith(ORIGINAL_CWD);
    expect(stripAnsi(testDisplay.print.mock.calls[0][0])).toContain("Workspace removed");
    expect(ws.isCreated).toBe(false);
  });

  it("skips removal if user declines confirmation", async () => {
    const ws = makeWorkspace(vi.fn().mockResolvedValue(false));
    ws.isCreated = true;
    vi.mocked(ws.checkSafety).mockResolvedValue({ uncommittedFiles: ["M foo.ts"], unpushedCommits: [], noUpstream: false });
    makeAndRegister(ws);
    await registry.registry.execute("workspace:remove", "");
    expect(ws.destroy).not.toHaveBeenCalled();
    expect(process.chdir).not.toHaveBeenCalled();
    expect(ws.isCreated).toBe(true);
  });
});

// ── onCreate ─────────────────────────────────────────────────────────────────

describe("WorkspaceController.onCreate", () => {
  it("prints 'Creating workspace...' via create-start event and chdirs to workspace dir", async () => {
    const ws = makeWorkspace();
    vi.spyOn(ws, "create").mockImplementation(async () => {
      ws.emit("create-start", { dir: ws.dir });
      ws.isCreated = true;
    });
    await new WorkspaceController(ws, testDisplay, testConfig).onCreate();
    expect(ws.create).toHaveBeenCalledOnce();
    expect(process.chdir).toHaveBeenCalledWith(ws.dir);
    const printed = testDisplay.print.mock.calls.map(([l]: [string]) => stripAnsi(l)).join("\n");
    expect(printed).toContain("Creating workspace...");
  });

  it("does not print 'Creating workspace...' when create-start is not emitted (workspace already exists)", async () => {
    const ws = makeWorkspace(); // mock does not emit create-start
    await new WorkspaceController(ws, testDisplay, testConfig).onCreate();
    const printed = testDisplay.print.mock.calls.map(([l]: [string]) => stripAnsi(l)).join("\n");
    expect(printed).not.toContain("Creating workspace...");
  });

  it("does not print clone URL or dir in non-verbose mode", async () => {
    const ws = makeWorkspace();
    vi.spyOn(ws, "create").mockImplementation(async () => {
      ws.emit("clone-start", { repoUrl: REPO_URL, dir: ws.dir });
      ws.isCreated = true;
    });
    await new WorkspaceController(ws, testDisplay, testConfig).onCreate();
    const printed = testDisplay.print.mock.calls.map(([l]: [string]) => stripAnsi(l)).join("\n");
    expect(printed).not.toContain("Cloning");
    expect(printed).not.toContain(REPO_URL);
  });

  it("prints clone URL and dir in verbose mode", async () => {
    const ws = makeWorkspace();
    vi.spyOn(ws, "create").mockImplementation(async () => {
      ws.emit("clone-start", { repoUrl: REPO_URL, dir: ws.dir });
      ws.isCreated = true;
    });
    testConfig.verbose = true;
    await new WorkspaceController(ws, testDisplay, testConfig).onCreate();
    const printed = testDisplay.print.mock.calls.map(([l]: [string]) => stripAnsi(l)).join("\n");
    expect(printed).toContain("Cloning");
    expect(printed).toContain(REPO_URL);
  });

  it("prints 'Resetting workspace...' on reset-start in non-verbose", async () => {
    const ws = makeWorkspace();
    await new WorkspaceController(ws, testDisplay, testConfig).onCreate();
    testDisplay.print.mockClear();
    ws.emit("reset-start", { dir: ws.dir });
    const printed = testDisplay.print.mock.calls.map(([l]: [string]) => stripAnsi(l)).join("\n");
    expect(printed).toContain("Resetting workspace...");
    expect(printed).not.toContain(ws.dir);
  });

  it("prints dir path on reset-start in verbose mode", async () => {
    const ws = makeWorkspace();
    testConfig.verbose = true;
    await new WorkspaceController(ws, testDisplay, testConfig).onCreate();
    testDisplay.print.mockClear();
    ws.emit("reset-start", { dir: ws.dir });
    const printed = testDisplay.print.mock.calls.map(([l]: [string]) => stripAnsi(l)).join("\n");
    expect(printed).toContain(ws.dir);
  });

  it("does not include [workspace] prefix in any message", async () => {
    const ws = makeWorkspace();
    vi.spyOn(ws, "create").mockImplementation(async () => {
      ws.emit("create-start", { dir: ws.dir });
      ws.emit("clone-start", { repoUrl: REPO_URL, dir: ws.dir });
      ws.emit("npm-install", { dir: ws.dir });
      ws.isCreated = true;
    });
    testConfig.verbose = true;
    await new WorkspaceController(ws, testDisplay, testConfig).onCreate();
    ws.emit("reset-start", { dir: ws.dir });
    ws.emit("reset-retry", { dir: ws.dir, error: "err" });
    ws.emit("destroy", { dir: ws.dir });
    const printed = testDisplay.print.mock.calls.map(([l]: [string]) => stripAnsi(l)).join("\n");
    expect(printed).not.toContain("[workspace]");
  });
});

// ── constructor: event listener deduplication ─────────────────────────────────

describe("WorkspaceController constructor listeners", () => {
  it("prints 'Destroying workspace...' exactly once even when onCreate is called twice", async () => {
    const ws = makeWorkspace();
    ws.isCreated = true;
    const controller = new WorkspaceController(ws, testDisplay, testConfig);
    await controller.onCreate();
    await controller.onCreate(); // simulate stop → /worker:start again
    testDisplay.print.mockClear();
    ws.emit("destroy", { dir: WORKSPACE_DIR });
    const destroyMsgs = testDisplay.print.mock.calls
      .map(([l]: [string]) => stripAnsi(l))
      .filter((m: string) => m.includes("Destroying workspace"));
    expect(destroyMsgs).toHaveLength(1);
  });
});

// ── workspace:prune ───────────────────────────────────────────────────────────

describe("workspace:prune", () => {
  it("prints error if no workspace (no config)", async () => {
    makeAndRegister(undefined);
    await registry.registry.execute("workspace:prune", "");
    expect(stripAnsi(testDisplay.print.mock.calls[0][0])).toContain("no workspace directory configured");
  });

  it("prints 'Nothing to prune' when no orphans found", async () => {
    const ws = makeWorkspace();
    vi.mocked(ws.prune).mockResolvedValue([]);
    makeAndRegister(ws);
    await registry.registry.execute("workspace:prune", "");
    expect(ws.prune).toHaveBeenCalled();
    expect(stripAnsi(testDisplay.print.mock.calls[0][0])).toContain("Nothing to prune");
  });

  it("lists removed dirs via prune-remove events and prints summary", async () => {
    const ws = makeWorkspace();
    vi.mocked(ws.prune).mockImplementation(async () => {
      ws.emit("prune-remove", { dir: "/base/abc" });
      ws.emit("prune-remove", { dir: "/base/def" });
      return ["/base/abc", "/base/def"];
    });
    // Register event handlers via onCreate, then commands
    const reg = new CommandRegistry();
    registry = new CommandController(reg);
    const controller = new WorkspaceController(ws, testDisplay, testConfig);
    await controller.onCreate();
    controller.registerCommands(reg.scoped("workspace"));
    testDisplay.print.mockClear();

    await registry.registry.execute("workspace:prune", "");
    const allOutput = testDisplay.print.mock.calls.map(([l]: [string]) => stripAnsi(l)).join("\n");
    expect(allOutput).toContain("/base/abc");
    expect(allOutput).toContain("/base/def");
    expect(allOutput).toContain("Pruned 2 orphaned workspace(s)");
  });
});
