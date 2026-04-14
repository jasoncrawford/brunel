import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mocks ────────────────────────────────────────────────────────────

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  // Use a real class so `new WebSocket(...)` works correctly
  return {
    WebSocket: class FakeWebSocket extends EventEmitter {
      readyState = 1;
      send = () => {};
      close = () => {};
    },
  };
});

// Singleton fake workspace returned by the mocked Workspace constructor.
// vi.hoisted() is required so it is defined before vi.mock() factories run.
const fakeWorkspace = vi.hoisted(() => {
  const ws: {
    dir: string;
    workspaceDir: string;
    sessionId: string;
    originalCwd: string;
    isCreated: boolean;
    confirm: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    checkSafety: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  } = {
    dir: "/fake/workers/test-worker",
    workspaceDir: "/fake/workers",
    sessionId: "test-worker",
    originalCwd: "/fake/original",
    isCreated: false,
    confirm: vi.fn().mockResolvedValue(true),
    destroy: vi.fn().mockResolvedValue(undefined),
    checkSafety: vi.fn().mockResolvedValue({
      uncommittedFiles: [],
      unpushedCommits: [],
      noUpstream: false,
    }),
    reset: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockImplementation(async () => { ws.isCreated = true; }),
  };
  return ws;
});

vi.mock("../src/agent/workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/workspace.js")>();
  // Use a regular function (not arrow) so it can be called with `new`.
  // A constructor that returns an object explicitly uses that object (JS spec).
  // eslint-disable-next-line prefer-arrow-callback
  const MockWorkspace = vi.fn().mockImplementation(function() { return fakeWorkspace; });
  // Keep the static prune method
  (MockWorkspace as any).prune = vi.fn().mockResolvedValue([]);
  return {
    ...actual,
    Workspace: MockWorkspace,
    confirmIfUnsafe: vi.fn().mockResolvedValue(true),
  };
});

vi.mock("../src/agent/input.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/input.js")>();
  return {
    ...actual,
    ask: vi.fn().mockResolvedValue("__eof__"),
    pick: vi.fn().mockResolvedValue(0),
  };
});

import { main } from "../src/agent/index.js";
import type { WorkerModeConfig } from "../src/agent/worker.js";
import { confirmIfUnsafe } from "../src/agent/workspace.js";
import * as inputModule from "../src/agent/input.js";
import * as displayModule from "../src/agent/display.js";
import { stripAnsi } from "./helpers.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

const permConfig = {
  permissionMode: "bypassPermissions" as const,
  allowDangerouslySkipPermissions: false,
};

const WORKER_CONFIG: WorkerModeConfig = {
  foremanUrl: "ws://localhost:3000",
  workspaceDir: "/fake/workers",
  githubToken: "test-token",
  githubRepo: "owner/repo",
  verbose: true,
  logFile: "worker.log",
  pingIntervalMs: 25_000,
};

async function runWorkerMain(runQueryFn = vi.fn().mockResolvedValue(undefined)): Promise<{ exitCalled: boolean; exitCode: number | undefined }> {
  let exitCode: number | undefined;
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string) => {
    exitCode = typeof code === "number" ? code : 0;
    throw new Error("__process_exit__");
  }) as unknown as ReturnType<typeof vi.spyOn>;

  try {
    await main(runQueryFn, permConfig, WORKER_CONFIG);
    return { exitCalled: false, exitCode: undefined };
  } catch (err) {
    if (err instanceof Error && err.message === "__process_exit__") {
      return { exitCalled: true, exitCode };
    }
    throw err;
  } finally {
    exitSpy.mockRestore();
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("workerMain startup banner", () => {
  let chdirSpy: ReturnType<typeof vi.spyOn>;
  let printSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => {});
    printSpy = vi.spyOn(displayModule, "print").mockImplementation(() => {});
    vi.mocked(inputModule.ask).mockResolvedValue("__eof__");
    vi.mocked(confirmIfUnsafe).mockResolvedValue(true);
  });

  afterEach(() => {
    chdirSpy.mockRestore();
    printSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("includes permissions, output mode, and logfile in the startup banner", async () => {
    await runWorkerMain();
    const printed = printSpy.mock.calls.map(([s]: [unknown]) => stripAnsi(String(s))).join("\n");
    expect(printed).toContain("Permissions: bypassPermissions");
    expect(printed).toContain("Output: verbose");
    expect(printed).toContain("Log: worker.log");
  });
});

describe("workerMain exit behavior", () => {
  let chdirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Prevent chdir to non-existent workspace dir
    chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => {});
    // Default: ask returns __eof__ immediately (^D pressed)
    vi.mocked(inputModule.ask).mockResolvedValue("__eof__");
    vi.mocked(confirmIfUnsafe).mockResolvedValue(true);
    // Reset fake workspace mocks between tests
    fakeWorkspace.isCreated = false;
    vi.mocked(fakeWorkspace.destroy).mockResolvedValue(undefined);
    vi.mocked(fakeWorkspace.checkSafety).mockResolvedValue({ uncommittedFiles: [], unpushedCommits: [], noUpstream: false });
    vi.mocked(fakeWorkspace.create).mockImplementation(async () => { fakeWorkspace.isCreated = true; });
  });

  afterEach(() => {
    chdirSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("calls process.exit(0) when user presses ^D", async () => {
    const { exitCalled, exitCode } = await runWorkerMain();
    expect(exitCalled).toBe(true);
    expect(exitCode).toBe(0);
  });

  it("calls process.exit(0) when user types /exit", async () => {
    // First ask() returns "/exit", which dispatchInput converts to type "exit"
    vi.mocked(inputModule.ask).mockResolvedValue("/exit");
    const { exitCalled, exitCode } = await runWorkerMain();
    expect(exitCalled).toBe(true);
    expect(exitCode).toBe(0);
  });

  it("destroys workspace before exiting when workspace is safe", async () => {
    await runWorkerMain();
    expect(fakeWorkspace.destroy).toHaveBeenCalledOnce();
  });

  it("does not call workspace.destroy when SIGINT fires while a query is running", async () => {
    // runQuery blocks until resolved — simulates a running query
    let resolveQuery!: (value: string | undefined) => void;
    const runQueryFn = vi.fn().mockImplementation(
      () => new Promise<string | undefined>((resolve) => { resolveQuery = resolve; }),
    );

    // ask: first call returns a user query to trigger runQuery, second call blocks
    let resolveSecondAsk!: (value: string) => void;
    let askCallCount = 0;
    vi.mocked(inputModule.ask).mockImplementation(() => {
      askCallCount++;
      if (askCallCount === 1) return Promise.resolve("do some work");
      return new Promise<string>((resolve) => { resolveSecondAsk = resolve; });
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string) => {
      throw new Error("__process_exit__");
    }) as unknown as ReturnType<typeof vi.spyOn>;

    let workerDone = false;
    const workerPromise = main(runQueryFn, permConfig, WORKER_CONFIG).then(
      () => { workerDone = true; },
      () => { workerDone = true; },
    );

    // Wait for runQuery to be called (query is now running)
    await vi.waitFor(() => expect(runQueryFn).toHaveBeenCalled());

    // Emit SIGINT while query is running — should NOT destroy workspace
    process.emit("SIGINT");
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(fakeWorkspace.destroy).not.toHaveBeenCalled();

    // Clean up: resolve the query and unblock ask so workerMain can exit
    resolveQuery(undefined);
    await vi.waitFor(() => expect(resolveSecondAsk).toBeDefined());
    resolveSecondAsk("__eof__");

    await workerPromise;
    expect(workerDone).toBe(true);

    exitSpy.mockRestore();
  });

  it("does not call workspace.destroy a second time if SIGINT fires after loop exits", async () => {
    // Simulate: user types /exit, cleanup runs, process tries to exit.
    // Before process.exit completes (in our mock it throws), emit SIGINT.
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string) => {
      // Fire SIGINT to simulate user pressing ^C during or after cleanup
      process.emit("SIGINT");
      throw new Error("__process_exit__");
    }) as unknown as ReturnType<typeof vi.spyOn>;

    try {
      await main(vi.fn().mockResolvedValue(undefined), permConfig, WORKER_CONFIG);
    } catch (err) {
      if (!(err instanceof Error && err.message === "__process_exit__")) throw err;
    } finally {
      exitSpy.mockRestore();
    }

    // destroy should have been called exactly once, not twice
    expect(fakeWorkspace.destroy).toHaveBeenCalledOnce();
  });
});
