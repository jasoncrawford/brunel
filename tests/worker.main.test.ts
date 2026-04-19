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
    on: ReturnType<typeof vi.fn>;
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
    on: vi.fn(),
  };
  return ws;
});

// Captures the WorkerSession created by startWorkerMode so tests can emit session
// events directly (e.g. "prompts_ready") without a real foreman connection.
const capturedSession = vi.hoisted(() => ({ current: null as import("../src/agent/controllers/worker-controller.js").WorkerSession | null }));

vi.mock("../src/agent/controllers/worker-controller.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/controllers/worker-controller.js")>();
  return {
    ...actual,
    startWorkerMode: async (...args: Parameters<typeof actual.startWorkerMode>) => {
      const result = await actual.startWorkerMode(...args);
      capturedSession.current = result.session;
      return result;
    },
  };
});

vi.mock("../src/agent/models/workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/models/workspace.js")>();
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

// Mock Input, Picker, and AgentController so the BrunelAgent constructor uses
// our test doubles instead of real instances.
vi.mock("../src/agent/views/input.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/views/input.js")>();
  return { ...actual, Input: vi.fn() };
});
vi.mock("../src/agent/views/picker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/views/picker.js")>();
  return { ...actual, Picker: vi.fn() };
});
vi.mock("../src/agent/controllers/agent-controller.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/controllers/agent-controller.js")>();
  return { ...actual, AgentController: vi.fn() };
});

import { BrunelAgent } from "../src/agent/index.js";
import { confirmIfUnsafe } from "../src/agent/models/workspace.js";
import { Input } from "../src/agent/views/input.js";
import { Picker } from "../src/agent/views/picker.js";
import { AgentController } from "../src/agent/controllers/agent-controller.js";
import { getConfig } from "../src/config.js";
import { stripAnsi } from "./helpers.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

let mockInput: { ask: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
let mockPicker: { pick: ReturnType<typeof vi.fn>; pickMultiple: ReturnType<typeof vi.fn>; pickQuestion: ReturnType<typeof vi.fn> };

function makeMockInput() {
  mockInput = {
    ask: vi.fn().mockResolvedValue("__eof__"),
    cancel: vi.fn(),
  };
  mockPicker = {
    pick: vi.fn().mockResolvedValue(0),
    pickMultiple: vi.fn().mockResolvedValue([]),
    pickQuestion: vi.fn().mockResolvedValue({ type: "answer", value: "" }),
  };
}

function installMocks(runQueryFn = vi.fn().mockResolvedValue(undefined)) {
  // Regular functions required — arrow functions cannot be called with `new`.
  // eslint-disable-next-line prefer-arrow-callback
  vi.mocked(Input).mockImplementation(function() { return mockInput as unknown as Input; });
  // eslint-disable-next-line prefer-arrow-callback
  vi.mocked(Picker).mockImplementation(function() { return mockPicker as unknown as Picker; });
  // eslint-disable-next-line prefer-arrow-callback
  vi.mocked(AgentController).mockImplementation(function() { return { runQuery: runQueryFn } as unknown as AgentController; });
}

async function runWorkerMain(runQueryFn = vi.fn().mockResolvedValue(undefined)): Promise<{ exitCalled: boolean; exitCode: number | undefined }> {
  installMocks(runQueryFn);
  let exitCode: number | undefined;
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string) => {
    exitCode = typeof code === "number" ? code : 0;
    throw new Error("__process_exit__");
  }) as unknown as ReturnType<typeof vi.spyOn>;

  try {
    await new BrunelAgent(getConfig()).start(true);
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

  beforeEach(() => {
    makeMockInput();
    chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => {});
    vi.mocked(confirmIfUnsafe).mockResolvedValue(true);
    getConfig().verbose = true;
    getConfig().permissionMode = "bypassPermissions";
  });

  afterEach(() => {
    getConfig().verbose = false;
    getConfig().permissionMode = "default";
    chdirSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("includes permissions, output mode, and logfile in the startup banner", async () => {
    installMocks();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string) => {
      throw new Error("__process_exit__");
    }) as unknown as ReturnType<typeof vi.spyOn>;
    const agent = new BrunelAgent(getConfig());
    const printSpy = vi.spyOn(agent.display, "print").mockImplementation(() => {});
    try {
      await agent.start(true);
    } catch (err) {
      if (!(err instanceof Error && err.message === "__process_exit__")) throw err;
    } finally {
      exitSpy.mockRestore();
    }
    const printed = printSpy.mock.calls.map(([s]: [unknown]) => stripAnsi(String(s))).join("\n");
    expect(printed).toContain("Permissions: bypassPermissions");
    expect(printed).toContain("Output: verbose");
    expect(printed).toContain("Log: repl.log");
  });
});

describe("workerMain exit behavior", () => {
  let chdirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    makeMockInput();
    // Prevent chdir to non-existent workspace dir
    chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => {});
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
    mockInput.ask.mockResolvedValue("/exit");
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
    mockInput.ask.mockImplementation(() => {
      askCallCount++;
      if (askCallCount === 1) return Promise.resolve("do some work");
      return new Promise<string>((resolve) => { resolveSecondAsk = resolve; });
    });

    installMocks(runQueryFn);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string) => {
      throw new Error("__process_exit__");
    }) as unknown as ReturnType<typeof vi.spyOn>;

    let workerDone = false;
    const workerPromise = new BrunelAgent(getConfig()).start(true).then(
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

    installMocks();
    try {
      await new BrunelAgent(getConfig()).start(true);
    } catch (err) {
      if (!(err instanceof Error && err.message === "__process_exit__")) throw err;
    } finally {
      exitSpy.mockRestore();
    }

    // destroy should have been called exactly once, not twice
    expect(fakeWorkspace.destroy).toHaveBeenCalledOnce();
  });
});

describe("workerMain input cancel discipline", () => {
  let chdirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    makeMockInput();
    chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => {});
    vi.mocked(confirmIfUnsafe).mockResolvedValue(true);
    fakeWorkspace.isCreated = false;
    vi.mocked(fakeWorkspace.destroy).mockResolvedValue(undefined);
    vi.mocked(fakeWorkspace.checkSafety).mockResolvedValue({ uncommittedFiles: [], unpushedCommits: [], noUpstream: false });
    vi.mocked(fakeWorkspace.create).mockImplementation(async () => { fakeWorkspace.isCreated = true; });
    capturedSession.current = null;
  });

  afterEach(() => {
    chdirSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("calls cancel() on the active ask() when processing a queued session event", async () => {
    // Regression test for: user input sent to agent multiple times (issue #761).
    //
    // The bug: when "prompts_ready" fires while the routing loop is EXECUTING
    // (not sleeping in nextRoutingEvent), cancel() in the event handler is a no-op
    // because ask() hasn't started yet. The session event lands in routingQueue.
    // Later, listenForInput() starts a new ask(), then nextRoutingEvent() immediately
    // returns the stale queued event. Without the fix, the routing loop handles that
    // event WITHOUT calling cancel() on the newly-started ask(), creating an orphaned
    // ask() that accumulates stdin listeners.
    //
    // The fix: always call this.input.cancel() when processing a session event,
    // even if routingWaiter was set when the event was enqueued.

    const ops: string[] = [];
    let askCount = 0;
    let currentResolveAsk: ((val: string | null) => void) | null = null;

    mockInput.ask.mockImplementation(() => {
      askCount++;
      const n = askCount;
      ops.push(`ask${n}`);
      if (n === 1) {
        // First ask: return user input immediately to trigger runQuery.
        return Promise.resolve("do some work");
      }
      // Subsequent asks: block until cancel() or EOF resolves them.
      return new Promise<string | null>((resolve) => { currentResolveAsk = resolve; });
    });

    // cancel() resolves the current pending ask with null (mirrors real Input behavior).
    mockInput.cancel.mockImplementation(() => {
      if (!currentResolveAsk) return;
      ops.push("cancel");
      const r = currentResolveAsk;
      currentResolveAsk = null;
      r(null);
    });

    let runQueryCallCount = 0;
    const runQueryFn = vi.fn().mockImplementation(async () => {
      runQueryCallCount++;
      if (runQueryCallCount === 1) {
        // Simulate two foreman events arriving while the query is running.
        // enqueuePrompt fires "prompts_ready" which calls cancel() (no-op — ask isn't
        // active yet) and pushes a session event to routingQueue.
        (capturedSession.current as any).enqueuePrompt("foreman event A", false);
        (capturedSession.current as any).enqueuePrompt("foreman event B", false);
      }
    });

    installMocks(runQueryFn);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("__process_exit__");
    }) as unknown as ReturnType<typeof vi.spyOn>;

    let agentError: unknown;
    const agentDone = new BrunelAgent(getConfig()).start(true).then(
      () => {},
      (err: unknown) => {
        if (!(err instanceof Error && err.message === "__process_exit__")) agentError = err;
      },
    );

    // Wait until ask#4 has started — the full bug scenario has played out by then:
    //   ask#1 → runQuery(user) → enqueue 2 session events → drain prompts (runQuery×2)
    //   → ask#2 → stale event1 processed → [cancel ask#2 with fix] → ask#3
    //   → stale event2 processed → [cancel ask#3 with fix] → ask#4 (waiting)
    await vi.waitFor(() => expect(askCount).toBeGreaterThanOrEqual(4));

    // Exit cleanly by resolving ask#4 with EOF.
    currentResolveAsk?.("__eof__" as unknown as string);

    await agentDone;
    exitSpy.mockRestore();

    if (agentError) throw agentError;

    // With the fix: "cancel" must appear between ask#2→ask#3 and ask#3→ask#4,
    // proving cancel() was called for each orphaned ask before the next one started.
    // Without the fix: ops = ["ask1","ask2","ask3","ask4"] — no cancels between asks.
    const ask2Idx = ops.indexOf("ask2");
    const ask3Idx = ops.indexOf("ask3");
    const ask4Idx = ops.indexOf("ask4");
    expect(ops.slice(ask2Idx + 1, ask3Idx)).toContain("cancel");
    expect(ops.slice(ask3Idx + 1, ask4Idx)).toContain("cancel");
  });
});
