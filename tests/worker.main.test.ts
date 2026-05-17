import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mocks ────────────────────────────────────────────────────────────

// Mock GithubToken to prevent real `gh` CLI calls. resolve() returns
// configToken directly (preserving env-token → workspace creation) with no CLI subprocess.
vi.mock("../src/agent/models/github-token.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/models/github-token.js")>();
  class MockGithubToken {
    constructor(private config?: { githubToken?: string }) {}
    resolve() { return Promise.resolve(this.config?.githubToken ?? null); }
  }
  return { ...actual, GithubToken: MockGithubToken };
});

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
    prune: ReturnType<typeof vi.fn>;
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
    prune: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
  };
  return ws;
});

// Captures the WorkerController instance so tests can emit events directly
// (e.g. "prompts_ready") and inspect task state without a real foreman connection.
const capturedSession = vi.hoisted(() => ({ current: null as import("../src/agent/controllers/worker-controller.js").WorkerController | null }));

vi.mock("../src/agent/controllers/worker-controller.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/controllers/worker-controller.js")>();
  class CapturingController extends actual.WorkerController {
    override async start(): Promise<void> {
      await super.start();
      capturedSession.current = this;
    }
  }
  return { ...actual, WorkerController: CapturingController };
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

let mockInput: { ask: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
let mockPicker: { pick: ReturnType<typeof vi.fn>; pickMultiple: ReturnType<typeof vi.fn>; pickQuestion: ReturnType<typeof vi.fn> };

function makeMockInput() {
  mockInput = {
    ask: vi.fn().mockResolvedValue("__eof__"),
    cancel: vi.fn(),
    on: vi.fn(),
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
    await new BrunelAgent(getConfig()).start({ command: "worker:start", args: "" });
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
      await agent.start({ command: "worker:start", args: "" });
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

describe("workerMain query error display", () => {
  let chdirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    makeMockInput();
    chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => {});
    vi.mocked(confirmIfUnsafe).mockResolvedValue(true);
    fakeWorkspace.isCreated = false;
    vi.mocked(fakeWorkspace.destroy).mockResolvedValue(undefined);
    vi.mocked(fakeWorkspace.checkSafety).mockResolvedValue({ uncommittedFiles: [], unpushedCommits: [], noUpstream: false });
    vi.mocked(fakeWorkspace.create).mockImplementation(async () => { fakeWorkspace.isCreated = true; });
  });

  afterEach(() => {
    chdirSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("query errors are routed through display.print, not console.error", async () => {
    // runQuery throws → runPrompt catch should call display.print, not console.error.
    // This prevents status bar text from being appended to the error line (issue #962).
    const runQueryFn = vi.fn().mockRejectedValue(new Error("API Error: Connection refused"));
    installMocks(runQueryFn);
    mockInput.ask
      .mockResolvedValueOnce("do some work")
      .mockResolvedValue("__eof__");

    const agent = new BrunelAgent(getConfig());
    const printSpy = vi.spyOn(agent.display, "print").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("__process_exit__");
    }) as unknown as ReturnType<typeof vi.spyOn>;

    try {
      await agent.start({ command: "worker:start", args: "" });
    } catch (err) {
      if (!(err instanceof Error && err.message === "__process_exit__")) throw err;
    } finally {
      exitSpy.mockRestore();
    }

    const errorPrints = printSpy.mock.calls
      .map(([s]: [unknown]) => stripAnsi(String(s ?? "")))
      .filter((s) => s.includes("ERROR"));
    expect(errorPrints.length).toBeGreaterThan(0);
    expect(errSpy).not.toHaveBeenCalled();
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

  it("exits cleanly (no process.exit) when user presses ^D in worker mode", async () => {
    // ^D calls stop() then doExit(), then the loop breaks and start() returns normally.
    // process.exit(0) is NOT called — Node exits naturally once stdin is paused.
    const { exitCalled } = await runWorkerMain();
    expect(exitCalled).toBe(false);
  });

  it("exits cleanly (no process.exit) when user types /exit in worker mode", async () => {
    // /exit calls stop() then returns "exit"; the routing loop calls doExit() and breaks.
    mockInput.ask.mockResolvedValue("/exit");
    const { exitCalled } = await runWorkerMain();
    expect(exitCalled).toBe(false);
  });

  it("destroys workspace before exiting when workspace is safe", async () => {
    await runWorkerMain();
    expect(fakeWorkspace.destroy).toHaveBeenCalledOnce();
  });

  it("destroys workspace when user types /exit", async () => {
    // Regression: /exit now returns "exit" without calling doExit() itself;
    // the routing loop is responsible for calling doExit() on any "exit" result.
    mockInput.ask.mockResolvedValue("/exit");
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
    const workerPromise = new BrunelAgent(getConfig()).start({ command: "worker:start", args: "" }).then(
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
      await new BrunelAgent(getConfig()).start({ command: "worker:start", args: "" });
    } catch (err) {
      if (!(err instanceof Error && err.message === "__process_exit__")) throw err;
    } finally {
      exitSpy.mockRestore();
    }

    // destroy should have been called exactly once, not twice
    expect(fakeWorkspace.destroy).toHaveBeenCalledOnce();
  });
});

describe("workerMain prompt suppression while waiting for task", () => {
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

  it("uses empty prompt string while waiting for a task, not '[agent] > '", async () => {
    // Regression test for issue #774.
    //
    // The bug: after completing a task (or before any task is assigned), the routing
    // loop used "\n[agent] > " as the prompt string unconditionally, displaying the
    // interactive prompt even though the worker was idle and waiting for a task.
    //
    // The fix: use an empty prompt string when session.hasTask() is false. stdin
    // remains active (^D / ^C still work) but no "[agent] > " is shown.

    const promptsUsed: string[] = [];
    const pendingResolvers: Array<(val: string | null) => void> = [];

    mockInput.ask.mockImplementation((promptStr: string) => {
      promptsUsed.push(promptStr);
      return new Promise<string | null>((resolve) => pendingResolvers.push(resolve));
    });
    mockInput.cancel.mockImplementation(() => {
      if (pendingResolvers.length > 0) pendingResolvers.pop()!(null);
    });

    const runQueryFn = vi.fn().mockResolvedValue(undefined);
    installMocks(runQueryFn);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("__process_exit__");
    }) as unknown as ReturnType<typeof vi.spyOn>;

    let agentError: unknown;
    const agentDone = new BrunelAgent(getConfig()).start({ command: "worker:start", args: "" }).then(
      () => {},
      (err: unknown) => { if (!(err instanceof Error && err.message === "__process_exit__")) agentError = err; },
    );

    // Wait for the first ask() call — the routing loop starts immediately.
    await vi.waitFor(() => expect(promptsUsed.length).toBeGreaterThanOrEqual(1));

    // With the fix: prompt should be empty string (no task assigned yet).
    expect(promptsUsed[0]).toBe("");

    // Now assign a task so hasTask() returns true, then wake the routing loop via
    // prompts_ready (cancel the current empty-prompt ask, loop continues, calls
    // listenForInput() again with the real prompt).
    const session = capturedSession.current!;
    (session as any).currentTaskId = "task-123";
    (session as any).currentIssue = { number: 42, title: "Test task", body: "", labels: [], repoUrl: "" };
    session.emit("prompts_ready"); // cancel() + enqueueRoutingEvent handled by session listener

    // Wait for the next ask() call — now with task active, prompt should be "[agent] > ".
    await vi.waitFor(() => expect(promptsUsed.length).toBeGreaterThanOrEqual(2));
    expect(promptsUsed[1]).toBe("\n[agent] > ");

    // Complete the task — user types /worker:complete (clears currentTaskId).
    pendingResolvers.pop()!("/worker:complete");
    await vi.waitFor(() => expect(session.hasTask()).toBe(false));

    // The loop should issue another ask() with empty prompt (no task again).
    await vi.waitFor(() => expect(promptsUsed.length).toBeGreaterThanOrEqual(3));
    expect(promptsUsed[2]).toBe("");

    // Exit cleanly via __eof__ on the current (empty-prompt) ask.
    pendingResolvers.pop()!("__eof__");

    await agentDone;
    exitSpy.mockRestore();
    if (agentError) throw agentError;
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

  it("does not send user input to the agent multiple times when session events were queued during a query", async () => {
    // Regression test for issues #761 and #770 (triple input after PR merged).
    //
    // The bug: when "prompts_ready" fires while the routing loop is executing (not
    // sleeping in nextRoutingEvent), cancel() in the event handler is a no-op because
    // ask() hasn't started yet. The event lands in routingQueue. Later, listenForInput()
    // starts a new ask(), nextRoutingEvent() returns the stale event immediately, and
    // the routing loop processes it WITHOUT cancelling the newly-started ask(). That
    // ask() becomes orphaned — it stays pending, keeping an active stdin listener. When
    // the user types something next, every orphaned listener fires, causing the typed
    // characters to be inserted once per listener (triplicating them) and runQuery to
    // be invoked once per orphaned ask instead of once.
    //
    // The mock tracks ALL pending ask() resolvers. Resolving every resolver simultaneously
    // mirrors how real stdin data events are delivered to every active readline listener.

    // All currently-pending ask() resolvers.
    const pendingResolvers: Array<(val: string | null) => void> = [];
    let askCallCount = 0;
    let currentResolve: ((val: string | null) => void) | null = null;

    mockInput.ask.mockImplementation(() => {
      askCallCount++;
      if (askCallCount === 1) return Promise.resolve("do some work");
      return new Promise<string | null>((resolve) => {
        pendingResolvers.push(resolve);
        currentResolve = resolve;
      });
    });

    // cancel() resolves the most recent ask with null and removes it, mirroring
    // real cancel() which only cancels the currently-active ask (not prior ones).
    mockInput.cancel.mockImplementation(() => {
      if (pendingResolvers.length === 0) return;
      const r = pendingResolvers.pop()!;
      currentResolve = pendingResolvers.at(-1) ?? null;
      r(null);
    });

    const runQueryFn = vi.fn().mockImplementation(async () => {
      if (runQueryFn.mock.calls.length === 1) {
        // Simulate two foreman events arriving while the query runs.
        // enqueuePrompt emits "prompts_ready", which calls cancel() (no-op — no ask is
        // pending yet) and pushes a session event to routingQueue.
        (capturedSession.current as any).enqueuePrompt("foreman event A", false);
        (capturedSession.current as any).enqueuePrompt("foreman event B", false);
      }
    });

    installMocks(runQueryFn);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("__process_exit__");
    }) as unknown as ReturnType<typeof vi.spyOn>;

    let agentError: unknown;
    const agentDone = new BrunelAgent(getConfig()).start({ command: "worker:start", args: "" }).then(
      () => {},
      (err: unknown) => {
        if (!(err instanceof Error && err.message === "__process_exit__")) agentError = err;
      },
    );

    // Wait for ask#4 — both queued session events have been processed by this point:
    //   ask#1 → runQuery("do some work") → 2 session events queued → drain (runQuery×2)
    //   → ask#2 → stale event1 processed → [with fix: cancel ask#2] → ask#3
    //   → stale event2 processed → [with fix: cancel ask#3] → ask#4 (blocking)
    await vi.waitFor(() => expect(askCallCount).toBeGreaterThanOrEqual(4));

    // With the fix: 1 pending ask (each session event cancelled the previous one).
    // Without the fix: 3 pending asks (ask#2 and ask#3 were never cancelled).
    // The number of pending asks directly determines how many times the next user
    // input invokes runQuery.
    const pendingAtSteadyState = pendingResolvers.length;
    expect(pendingAtSteadyState).toBe(1);

    // Deliver one user input to all currently-pending asks simultaneously,
    // mirroring how a stdin data event reaches every active readline listener at once.
    const toFire = pendingResolvers.splice(0);
    currentResolve = null;
    for (const r of toFire) r("user-input");

    // Wait for the routing loop to process all resulting line events (one per fired ask).
    await vi.waitFor(() => expect(askCallCount).toBeGreaterThanOrEqual(4 + toFire.length));

    // With the fix: runQuery is called exactly once for "user-input".
    // Without the fix: runQuery would be called 3 times (once per pending ask).
    expect(runQueryFn.mock.calls.filter(([p]) => p === "user-input").length).toBe(1);

    // Exit cleanly.
    currentResolve?.("__eof__");
    await agentDone;
    exitSpy.mockRestore();
    if (agentError) throw agentError;
  });
});

describe("workerMain stall retry exhaustion", () => {
  let chdirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    makeMockInput();
    chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => {});
    vi.mocked(confirmIfUnsafe).mockResolvedValue(true);
    fakeWorkspace.isCreated = false;
    vi.mocked(fakeWorkspace.destroy).mockResolvedValue(undefined);
    vi.mocked(fakeWorkspace.checkSafety).mockResolvedValue({ uncommittedFiles: [], unpushedCommits: [], noUpstream: false });
    vi.mocked(fakeWorkspace.create).mockImplementation(async () => { fakeWorkspace.isCreated = true; });
  });

  afterEach(() => {
    chdirSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("prints a 'giving up' message when all stall retries are exhausted", async () => {
    // ask: first call returns a prompt, second call exits
    let askCallCount = 0;
    mockInput.ask.mockImplementation(() => {
      askCallCount++;
      if (askCallCount === 1) return Promise.resolve("do some work");
      return Promise.resolve("__eof__");
    });

    const stallResult = { stallRetry: true, sessionId: undefined, stats: { inputTokens: 0, outputTokens: 0, costUsd: undefined } };
    const runQueryFn = vi.fn().mockResolvedValue(stallResult);
    installMocks(runQueryFn);

    const agent = new BrunelAgent(getConfig());
    const printSpy = vi.spyOn(agent.display, "print");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("__process_exit__");
    }) as unknown as ReturnType<typeof vi.spyOn>;

    try {
      await agent.start({ command: "worker:start", args: "" });
    } catch (err) {
      if (!(err instanceof Error && err.message === "__process_exit__")) throw err;
    } finally {
      exitSpy.mockRestore();
    }

    const printed = printSpy.mock.calls.map(([s]: [unknown]) => stripAnsi(String(s))).join("\n");
    expect(printed).toContain("Connection stalled");
    expect(printed).toContain("giving up");
    expect(printed).toContain("retries");
  });
});

describe("CLI command dispatch", () => {
  let chdirSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    makeMockInput();
    chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => {});
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    fakeWorkspace.isCreated = false;
    vi.mocked(fakeWorkspace.destroy).mockResolvedValue(undefined);
    vi.mocked(fakeWorkspace.checkSafety).mockResolvedValue({ uncommittedFiles: [], unpushedCommits: [], noUpstream: false });
    vi.mocked(fakeWorkspace.create).mockImplementation(async () => { fakeWorkspace.isCreated = true; });
    vi.mocked(fakeWorkspace.prune).mockResolvedValue([]);
  });

  afterEach(() => {
    chdirSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("workspace:prune exits after running (exitAfterRunFromArgs)", async () => {
    installMocks();
    let exitCode: number | undefined;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string) => {
      exitCode = typeof code === "number" ? code : undefined;
      throw new Error("__process_exit__");
    }) as unknown as ReturnType<typeof vi.spyOn>;

    let startCalled = false;
    try {
      await new BrunelAgent(getConfig()).start({ command: "workspace:prune", args: "" });
      startCalled = true;
    } catch (err) {
      if (!(err instanceof Error && err.message === "__process_exit__")) throw err;
    } finally {
      exitSpy.mockRestore();
    }

    // start() should return normally (no process.exit) — doExit() + return exits cleanly
    expect(startCalled).toBe(true);
    // ask() should NOT have been called (routing loop skipped)
    expect(mockInput.ask).not.toHaveBeenCalled();
  });

  it("unknown command writes to stderr and exits with code 1", async () => {
    installMocks();
    let exitCode: number | undefined;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string) => {
      exitCode = typeof code === "number" ? code : undefined;
      throw new Error("__process_exit__");
    }) as unknown as ReturnType<typeof vi.spyOn>;

    try {
      await new BrunelAgent(getConfig()).start({ command: "nonexistent-command", args: "" });
    } catch (err) {
      if (!(err instanceof Error && err.message === "__process_exit__")) throw err;
    } finally {
      exitSpy.mockRestore();
    }

    expect(exitCode).toBe(1);
    const stderrOutput = stderrSpy.mock.calls.map(([s]: [unknown]) => String(s)).join("");
    expect(stderrOutput).toContain("Unknown command: nonexistent-command");
  });

  it("command without canRunFromArgs writes to stderr and exits with code 1", async () => {
    installMocks();
    let exitCode: number | undefined;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string) => {
      exitCode = typeof code === "number" ? code : undefined;
      throw new Error("__process_exit__");
    }) as unknown as ReturnType<typeof vi.spyOn>;

    // /clear is a real registered command but does not have canRunFromArgs
    try {
      await new BrunelAgent(getConfig()).start({ command: "clear", args: "" });
    } catch (err) {
      if (!(err instanceof Error && err.message === "__process_exit__")) throw err;
    } finally {
      exitSpy.mockRestore();
    }

    expect(exitCode).toBe(1);
    const stderrOutput = stderrSpy.mock.calls.map(([s]: [unknown]) => String(s)).join("");
    expect(stderrOutput).toContain("cannot be invoked from command line args");
  });

  it("worker:start does not exit after running (enters routing loop)", async () => {
    installMocks();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("__process_exit__");
    }) as unknown as ReturnType<typeof vi.spyOn>;

    try {
      await new BrunelAgent(getConfig()).start({ command: "worker:start", args: "" });
    } catch (err) {
      if (!(err instanceof Error && err.message === "__process_exit__")) throw err;
    } finally {
      exitSpy.mockRestore();
    }

    // The routing loop ran — ask() was called (got __eof__ and exited)
    expect(mockInput.ask).toHaveBeenCalled();
  });

  it("version command prints version string to stdout and exits", async () => {
    installMocks();
    const stdoutWrites: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
      stdoutWrites.push(String(s));
      return true;
    });

    let startCalled = false;
    try {
      await new BrunelAgent(getConfig()).start({ command: "version", args: "" });
      startCalled = true;
    } finally {
      stdoutSpy.mockRestore();
    }

    expect(startCalled).toBe(true);
    expect(mockInput.ask).not.toHaveBeenCalled();
    const output = stdoutWrites.join("");
    expect(output).toMatch(/^v\d+\.\d+\.\d+ \(protocol version \d+\)\n/);
  });

  it("version command does not print the startup banner", async () => {
    installMocks();
    const agent = new BrunelAgent(getConfig());
    const printSpy = vi.spyOn(agent.display, "print").mockImplementation(() => {});
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await agent.start({ command: "version", args: "" });
    } finally {
      printSpy.mockRestore();
      stdoutSpy.mockRestore();
    }

    const printed = printSpy.mock.calls.map(([s]: [unknown]) => stripAnsi(String(s))).join("\n");
    expect(printed).not.toContain("brunel-agent");
    expect(printed).not.toContain("Permissions:");
  });
});
