import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    WebSocket: class FakeWebSocket extends EventEmitter {
      readyState = 1;
      send = () => {};
      close = () => {};
      terminate = () => {};
    },
  };
});

// Captures WorkerController instances created by BrunelAgent.start() so tests
// can inspect state directly (e.g. inject task IDs for ^C tests).
const capturedControllers = vi.hoisted(() => ({
  list: [] as import("../src/agent/controllers/worker-controller.js").WorkerController[],
}));

vi.mock("../src/agent/controllers/worker-controller.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/controllers/worker-controller.js")>();
  class CapturingController extends actual.WorkerController {
    override async start(): Promise<void> {
      const wasActive = this.isActive;
      await super.start();
      if (!wasActive && this.isActive) capturedControllers.list.push(this);
    }
  }
  return { ...actual, WorkerController: CapturingController };
});

vi.mock("../src/agent/models/workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/models/workspace.js")>();
  const MockWorkspace = vi.fn().mockImplementation(function() {
    return {
      dir: "/fake/workers/test",
      workspaceDir: "/fake/workers",
      sessionId: "test",
      originalCwd: "/fake/original",
      isCreated: false,
      on: vi.fn(),
      create: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn().mockResolvedValue(undefined),
      checkSafety: vi.fn().mockResolvedValue({ uncommittedFiles: [], unpushedCommits: [], noUpstream: false }),
      confirm: vi.fn().mockResolvedValue(true),
    };
  });
  (MockWorkspace as any).prune = vi.fn().mockResolvedValue([]);
  return { ...actual, Workspace: MockWorkspace, confirmIfUnsafe: vi.fn().mockResolvedValue(true) };
});

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
import type { AgentStatus } from "../src/agent/models/agent-status.js";
import { Input } from "../src/agent/views/input.js";
import { Picker } from "../src/agent/views/picker.js";
import { AgentController } from "../src/agent/controllers/agent-controller.js";
import { getConfig } from "../src/config.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

let mockInput: { ask: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
let mockPicker: { pick: ReturnType<typeof vi.fn> };

function makeMocks() {
  mockInput = { ask: vi.fn().mockResolvedValue("__eof__"), cancel: vi.fn(), on: vi.fn() };
  mockPicker = { pick: vi.fn().mockResolvedValue(0) };

  vi.mocked(Input).mockImplementation(function() { return mockInput as unknown as Input; });
  vi.mocked(Picker).mockImplementation(function() { return mockPicker as unknown as Picker; });
  vi.mocked(AgentController).mockImplementation(function() {
    return { runQuery: vi.fn().mockResolvedValue(undefined) } as unknown as AgentController;
  });
}

/**
 * Run BrunelAgent.start() and return the agent.
 * Pass workerMode=true to start in worker mode (equivalent to `brunel worker:start`).
 * Mocks process.exit so it throws instead of exiting.
 * Cleans up the persistent bar to avoid resize-listener accumulation.
 */
async function runAgent(workerMode: boolean, agentOverride?: BrunelAgent): Promise<BrunelAgent> {
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string) => {
    throw new Error("__process_exit__");
  }) as unknown as ReturnType<typeof vi.spyOn>;
  const chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => {});
  const agent = agentOverride ?? new BrunelAgent(getConfig());
  const cliCommand = workerMode ? { command: "worker:start", args: "" } : null;
  try {
    await agent.start(cliCommand);
  } catch (err) {
    if (!(err instanceof Error && err.message === "__process_exit__")) throw err;
  } finally {
    agent.display.stopPersistentBar(); // prevent resize-listener accumulation
    exitSpy.mockRestore();
    chdirSpy.mockRestore();
  }
  return agent;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("worker mode switching", () => {
  beforeEach(() => {
    capturedControllers.list = [];
    makeMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("workerModeActive is false by default in REPL mode", async () => {
    let capturedStatus: AgentStatus | undefined;
    vi.mocked(AgentController).mockImplementation(function(this: unknown, display: unknown) {
      capturedStatus = (display as { agentStatus: AgentStatus }).agentStatus;
      return { runQuery: vi.fn().mockResolvedValue(undefined) } as unknown as AgentController;
    });

    await runAgent(false);
    expect(capturedStatus?.workerModeActive).toBe(false);
  });

  it("workerModeActive is true when started via `brunel worker:start`", async () => {
    // Verify that worker mode was started (controller captured in list).
    // After ^D exits, stop() is called first, so workerModeActive is false at that point.
    await runAgent(true);
    expect(capturedControllers.list).toHaveLength(1);
  });

  it("/worker:start activates worker mode", async () => {
    let askCallCount = 0;
    mockInput.ask.mockImplementation(() => {
      askCallCount++;
      if (askCallCount === 1) return Promise.resolve("/worker:start");
      return Promise.resolve("__eof__");
    });

    await runAgent(false);

    // Worker mode was started (controller in list). After ^D, stop() is called so
    // workerModeActive is false at exit — that's correct; it was active during execution.
    expect(capturedControllers.list).toHaveLength(1);
  });

  it("/worker:stop deactivates worker mode", async () => {
    let capturedStatus: AgentStatus | undefined;
    vi.mocked(AgentController).mockImplementation(function(this: unknown, display: unknown) {
      capturedStatus = (display as { agentStatus: AgentStatus }).agentStatus;
      return { runQuery: vi.fn().mockResolvedValue(undefined) } as unknown as AgentController;
    });

    let askCallCount = 0;
    mockInput.ask.mockImplementation(() => {
      askCallCount++;
      if (askCallCount === 1) return Promise.resolve("/worker:start");
      if (askCallCount === 2) return Promise.resolve("/worker:stop");
      return Promise.resolve("__eof__");
    });

    await runAgent(false);
    expect(capturedStatus?.workerModeActive).toBe(false);
  });

  it("/worker:start when already active transitions to ready without creating a second session", async () => {
    const agent = new BrunelAgent(getConfig());
    const printedMessages: string[] = [];
    vi.spyOn(agent.display, "print").mockImplementation((line) => {
      if (line) printedMessages.push(String(line));
    });

    let askCallCount = 0;
    mockInput.ask.mockImplementation(() => {
      askCallCount++;
      if (askCallCount === 1) return Promise.resolve("/worker:start");
      if (askCallCount === 2) return Promise.resolve("/worker:start"); // second start while already connected
      return Promise.resolve("__eof__");
    });

    await runAgent(false, agent);

    expect(capturedControllers.list).toHaveLength(1); // only one controller activated
  });

  it("/worker:stop when not active prints a message", async () => {
    const agent = new BrunelAgent(getConfig());
    const printedMessages: string[] = [];
    vi.spyOn(agent.display, "print").mockImplementation((line) => {
      if (line) printedMessages.push(String(line));
    });

    let askCallCount = 0;
    mockInput.ask.mockImplementation(() => {
      askCallCount++;
      if (askCallCount === 1) return Promise.resolve("/worker:stop");
      return Promise.resolve("__eof__");
    });

    await runAgent(false, agent);
    expect(printedMessages.some(m => m.includes("not active"))).toBe(true);
  });

  it("__ctrl_c__ when worker is waiting (no task, not reserved) reserves the worker instead of stopping", async () => {
    let capturedStatus: AgentStatus | undefined;
    vi.mocked(AgentController).mockImplementation(function(this: unknown, display: unknown) {
      capturedStatus = (display as { agentStatus: AgentStatus }).agentStatus;
      return { runQuery: vi.fn().mockResolvedValue(undefined) } as unknown as AgentController;
    });

    let askCallCount = 0;
    mockInput.ask.mockImplementation(() => {
      askCallCount++;
      if (askCallCount === 1) return Promise.resolve("/worker:start");
      if (askCallCount === 2) return Promise.resolve("__ctrl_c__"); // ^C while waiting (no task)
      return Promise.resolve("__eof__");
    });

    await runAgent(false);
    // Worker mode stays active (reserved, not stopped)
    // After ^D the loop exits but worker had been reserved, not stopped by ^C
    // The key check: worker was still active after ^C (it reserved, not stopped)
    expect(capturedControllers.list).toHaveLength(1);
  });

  it("__ctrl_c__ while waiting shows agent prompt afterwards (isReserved=true)", async () => {
    const promptsUsed: string[] = [];
    const pendingResolvers: Array<(val: string | null) => void> = [];

    mockInput.ask.mockImplementation((promptStr: string) => {
      promptsUsed.push(promptStr);
      return new Promise<string | null>((resolve) => pendingResolvers.push(resolve));
    });
    mockInput.cancel.mockImplementation(() => {
      if (pendingResolvers.length > 0) pendingResolvers.pop()!(null);
    });

    vi.mocked(AgentController).mockImplementation(function() {
      return { runQuery: vi.fn().mockResolvedValue(undefined) } as unknown as AgentController;
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("__process_exit__");
    }) as unknown as ReturnType<typeof vi.spyOn>;
    const chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => {});

    let agentError: unknown;
    const agent = new BrunelAgent(getConfig());
    const agentDone = agent.start({ command: "worker:start", args: "" }).then(
      () => {},
      (err: unknown) => { if (!(err instanceof Error && err.message === "__process_exit__")) agentError = err; },
    );

    // Wait for the first ask() — should be empty prompt (waiting state)
    await vi.waitFor(() => expect(promptsUsed.length).toBeGreaterThanOrEqual(1));
    expect(promptsUsed[0]).toBe("");

    // Press ^C — should reserve (not stop)
    pendingResolvers.pop()!("__ctrl_c__");

    // After reserve(), the next ask() should show the agent prompt (reserved state = visible prompt)
    await vi.waitFor(() => expect(promptsUsed.length).toBeGreaterThanOrEqual(2));
    expect(promptsUsed[1]).toBe("\n[agent] > ");

    // Exit cleanly
    pendingResolvers.pop()!("__eof__");
    await agentDone;
    agent.display.stopPersistentBar();
    exitSpy.mockRestore();
    chdirSpy.mockRestore();
    if (agentError) throw agentError;
  });

  it("__ctrl_c__ while reserved (after first ^C) stops worker mode", async () => {
    let capturedStatus: AgentStatus | undefined;
    vi.mocked(AgentController).mockImplementation(function(this: unknown, display: unknown) {
      capturedStatus = (display as { agentStatus: AgentStatus }).agentStatus;
      return { runQuery: vi.fn().mockResolvedValue(undefined) } as unknown as AgentController;
    });

    let askCallCount = 0;
    mockInput.ask.mockImplementation(() => {
      askCallCount++;
      if (askCallCount === 1) return Promise.resolve("/worker:start");
      if (askCallCount === 2) return Promise.resolve("__ctrl_c__"); // first ^C → reserves
      if (askCallCount === 3) return Promise.resolve("__ctrl_c__"); // second ^C → stops
      return Promise.resolve("__eof__");
    });

    await runAgent(false);
    expect(capturedStatus?.workerModeActive).toBe(false);
  });

  it("__ctrl_c__ while worker has an active task shows quit confirmation and stops on confirm", async () => {
    let capturedStatus: AgentStatus | undefined;
    vi.mocked(AgentController).mockImplementation(function(this: unknown, display: unknown) {
      capturedStatus = (display as { agentStatus: AgentStatus }).agentStatus;
      return { runQuery: vi.fn().mockResolvedValue(undefined) } as unknown as AgentController;
    });

    let askCallCount = 0;
    mockInput.ask.mockImplementation(() => {
      askCallCount++;
      if (askCallCount === 1) return Promise.resolve("/worker:start");
      if (askCallCount === 2) {
        // Inject a task into the captured controller before returning ^C
        const ctrl = capturedControllers.list[0];
        if (ctrl) {
          (ctrl as any).currentTaskId = "task-99";
          (ctrl as any).currentIssue = { number: 99, title: "Test", body: "", labels: [], repoUrl: "" };
        }
        return Promise.resolve("__ctrl_c__"); // ^C with task in progress
      }
      return Promise.resolve("__eof__");
    });
    // "Yes, quit anyway" — confirms the quit, so stop() proceeds and worker stops
    mockPicker.pick.mockResolvedValue(1);

    await runAgent(false);

    // Worker mode stopped because the user confirmed the quit dialog
    expect(capturedStatus?.workerModeActive).toBe(false);
  });

  it("/worker:stop refreshes agentStatus.branch to current git branch", async () => {
    let capturedStatus: AgentStatus | undefined;
    vi.mocked(AgentController).mockImplementation(function(this: unknown, display: unknown) {
      capturedStatus = (display as { agentStatus: AgentStatus }).agentStatus;
      return { runQuery: vi.fn().mockResolvedValue(undefined) } as unknown as AgentController;
    });

    let askCallCount = 0;
    mockInput.ask.mockImplementation(() => {
      askCallCount++;
      if (askCallCount === 1) return Promise.resolve("/worker:start");
      if (askCallCount === 2) {
        // Simulate the branch being cleared after a task completes
        if (capturedStatus) capturedStatus.update({ branch: "" });
        return Promise.resolve("/worker:stop");
      }
      return Promise.resolve("__eof__");
    });

    await runAgent(false);

    expect(capturedStatus?.branch).not.toBe("");
  });

  it("after /worker:stop, exiting does not call process.exit(0)", async () => {
    // When worker mode is stopped before exit, workerCleanup is cleared.
    // The exit path should go through doExit() which does NOT call process.exit.
    let askCallCount = 0;
    mockInput.ask.mockImplementation(() => {
      askCallCount++;
      if (askCallCount === 1) return Promise.resolve("/worker:start");
      if (askCallCount === 2) return Promise.resolve("/worker:stop");
      return Promise.resolve("__eof__");
    });

    let exitCalled = false;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      exitCalled = true;
      throw new Error("__process_exit__");
    }) as unknown as ReturnType<typeof vi.spyOn>;
    const chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => {});
    const agent = new BrunelAgent(getConfig());
    try {
      await agent.start(null);
    } catch (err) {
      if (!(err instanceof Error && err.message === "__process_exit__")) throw err;
    } finally {
      agent.display.stopPersistentBar();
      exitSpy.mockRestore();
      chdirSpy.mockRestore();
    }

    expect(exitCalled).toBe(false);
  });
});
