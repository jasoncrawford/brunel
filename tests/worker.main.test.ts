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

vi.mock("../src/agent/workspace.js", () => ({
  Workspace: {
    create: vi.fn().mockResolvedValue({
      dir: "/fake/workers/test-worker",
      destroy: vi.fn().mockResolvedValue(undefined),
      checkSafety: vi.fn().mockResolvedValue({
        uncommittedFiles: [],
        unpushedCommits: [],
        noUpstream: false,
      }),
      reset: vi.fn().mockResolvedValue(undefined),
    }),
  },
  confirmIfUnsafe: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/agent/input.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/input.js")>();
  return {
    ...actual,
    ask: vi.fn().mockResolvedValue("__eof__"),
    pick: vi.fn().mockResolvedValue(0),
  };
});

import { workerMain } from "../src/agent/worker.js";
import { Workspace, confirmIfUnsafe } from "../src/agent/workspace.js";
import * as inputModule from "../src/agent/input.js";
import * as displayModule from "../src/agent/display.js";
import { stripAnsi } from "./helpers.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

const WORKER_CONFIG = {
  foremanUrl: "ws://localhost:3000",
  workspaceDir: "/fake/workers",
  githubToken: "test-token",
  githubRepo: "owner/repo",
  permissionMode: "bypassPermissions" as const,
  verbose: true,
  logFile: "worker.log",
  pingIntervalMs: 25_000,
};

async function runWorkerMain(): Promise<{ exitCalled: boolean; exitCode: number | undefined }> {
  let exitCode: number | undefined;
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string) => {
    exitCode = typeof code === "number" ? code : 0;
    throw new Error("__process_exit__");
  }) as unknown as ReturnType<typeof vi.spyOn>;

  try {
    await workerMain(vi.fn().mockResolvedValue(undefined), WORKER_CONFIG);
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
    const fakeWorkspace = {
      dir: "/fake/workers/test-worker",
      destroy: vi.fn().mockResolvedValue(undefined),
      checkSafety: vi.fn().mockResolvedValue({ uncommittedFiles: [], unpushedCommits: [], noUpstream: false }),
      reset: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(Workspace.create).mockResolvedValue(fakeWorkspace as any);

    await runWorkerMain();

    expect(fakeWorkspace.destroy).toHaveBeenCalledOnce();
  });

  it("does not call workspace.destroy when SIGINT fires while a query is running", async () => {
    const fakeWorkspace = {
      dir: "/fake/workers/test-worker",
      destroy: vi.fn().mockResolvedValue(undefined),
      checkSafety: vi.fn().mockResolvedValue({ uncommittedFiles: [], unpushedCommits: [], noUpstream: false }),
      reset: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(Workspace.create).mockResolvedValue(fakeWorkspace as any);

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

    const chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => {});

    let workerDone = false;
    const workerPromise = workerMain(runQueryFn, WORKER_CONFIG).then(
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
    chdirSpy.mockRestore();
  });

  it("does not call workspace.destroy a second time if SIGINT fires after loop exits", async () => {
    const fakeWorkspace = {
      dir: "/fake/workers/test-worker",
      destroy: vi.fn().mockResolvedValue(undefined),
      checkSafety: vi.fn().mockResolvedValue({ uncommittedFiles: [], unpushedCommits: [], noUpstream: false }),
      reset: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(Workspace.create).mockResolvedValue(fakeWorkspace as any);

    // Simulate: user types /exit, cleanup runs, process tries to exit.
    // Before process.exit completes (in our mock it throws), emit SIGINT.
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string) => {
      // Fire SIGINT to simulate user pressing ^C during or after cleanup
      process.emit("SIGINT");
      throw new Error("__process_exit__");
    }) as unknown as ReturnType<typeof vi.spyOn>;

    try {
      await workerMain(vi.fn().mockResolvedValue(undefined), WORKER_CONFIG);
    } catch (err) {
      if (!(err instanceof Error && err.message === "__process_exit__")) throw err;
    } finally {
      exitSpy.mockRestore();
    }

    // destroy should have been called exactly once, not twice
    expect(fakeWorkspace.destroy).toHaveBeenCalledOnce();
  });
});
