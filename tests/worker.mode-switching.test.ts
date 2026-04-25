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

// Captures sessions created by startWorkerMode so tests can inspect state.
const capturedSessions = vi.hoisted(() => ({
  list: [] as import("../src/agent/controllers/worker-controller.js").WorkerSession[],
}));

vi.mock("../src/agent/controllers/worker-controller.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/controllers/worker-controller.js")>();
  return {
    ...actual,
    startWorkerMode: async (...args: Parameters<typeof actual.startWorkerMode>) => {
      const result = await actual.startWorkerMode(...args);
      capturedSessions.list.push(result.session);
      return result;
    },
  };
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

let mockInput: { ask: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
let mockPicker: { pick: ReturnType<typeof vi.fn> };

function makeMocks() {
  mockInput = { ask: vi.fn().mockResolvedValue("__eof__"), cancel: vi.fn() };
  mockPicker = { pick: vi.fn().mockResolvedValue(0) };

  vi.mocked(Input).mockImplementation(function() { return mockInput as unknown as Input; });
  vi.mocked(Picker).mockImplementation(function() { return mockPicker as unknown as Picker; });
  vi.mocked(AgentController).mockImplementation(function() {
    return { runQuery: vi.fn().mockResolvedValue(undefined) } as unknown as AgentController;
  });
}

/**
 * Run BrunelAgent.start(runWorkerMode) and return the agent.
 * Mocks process.exit so it throws instead of exiting.
 * Cleans up the persistent bar to avoid resize-listener accumulation.
 */
async function runAgent(runWorkerMode: boolean, agentOverride?: BrunelAgent): Promise<BrunelAgent> {
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string) => {
    throw new Error("__process_exit__");
  }) as unknown as ReturnType<typeof vi.spyOn>;
  const chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => {});
  const agent = agentOverride ?? new BrunelAgent(getConfig());
  try {
    await agent.start(runWorkerMode);
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
    capturedSessions.list = [];
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

  it("workerModeActive is true when --worker-mode flag is used", async () => {
    let capturedStatus: AgentStatus | undefined;
    vi.mocked(AgentController).mockImplementation(function(this: unknown, display: unknown) {
      capturedStatus = (display as { agentStatus: AgentStatus }).agentStatus;
      return { runQuery: vi.fn().mockResolvedValue(undefined) } as unknown as AgentController;
    });

    await runAgent(true);
    expect(capturedStatus?.workerModeActive).toBe(true);
  });

  it("/worker:start activates worker mode", async () => {
    let capturedStatus: AgentStatus | undefined;
    vi.mocked(AgentController).mockImplementation(function(this: unknown, display: unknown) {
      capturedStatus = (display as { agentStatus: AgentStatus }).agentStatus;
      return { runQuery: vi.fn().mockResolvedValue(undefined) } as unknown as AgentController;
    });

    let askCallCount = 0;
    mockInput.ask.mockImplementation(() => {
      askCallCount++;
      if (askCallCount === 1) return Promise.resolve("/worker:start");
      return Promise.resolve("__eof__");
    });

    await runAgent(false);

    expect(capturedSessions.list).toHaveLength(1);
    expect(capturedStatus?.workerModeActive).toBe(true);
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

  it("/worker:start when already active prints a message and does not create a second session", async () => {
    const agent = new BrunelAgent(getConfig());
    const printedMessages: string[] = [];
    vi.spyOn(agent.display, "print").mockImplementation((line) => {
      if (line) printedMessages.push(String(line));
    });

    let askCallCount = 0;
    mockInput.ask.mockImplementation(() => {
      askCallCount++;
      if (askCallCount === 1) return Promise.resolve("/worker:start");
      if (askCallCount === 2) return Promise.resolve("/worker:start"); // second start
      return Promise.resolve("__eof__");
    });

    await runAgent(false, agent);

    expect(capturedSessions.list).toHaveLength(1); // only one session created
    expect(printedMessages.some(m => m.includes("already active"))).toBe(true);
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

  it("__ctrl_c__ when worker is idle stops worker mode", async () => {
    let capturedStatus: AgentStatus | undefined;
    vi.mocked(AgentController).mockImplementation(function(this: unknown, display: unknown) {
      capturedStatus = (display as { agentStatus: AgentStatus }).agentStatus;
      return { runQuery: vi.fn().mockResolvedValue(undefined) } as unknown as AgentController;
    });

    let askCallCount = 0;
    mockInput.ask.mockImplementation(() => {
      askCallCount++;
      if (askCallCount === 1) return Promise.resolve("/worker:start");
      if (askCallCount === 2) return Promise.resolve("__ctrl_c__"); // ^C while idle (no task)
      return Promise.resolve("__eof__");
    });

    await runAgent(false);
    expect(capturedStatus?.workerModeActive).toBe(false);
  });

  it("__ctrl_c__ while worker has an active task does not stop worker mode", async () => {
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
        // Inject a task into the session before returning ^C
        const s = capturedSessions.list[0];
        if (s) {
          (s as any).currentTaskId = "task-99";
          (s as any).currentIssue = { number: 99, title: "Test", body: "", labels: [], repoUrl: "" };
        }
        return Promise.resolve("__ctrl_c__"); // ^C with task in progress
      }
      return Promise.resolve("__eof__");
    });
    // "Yes, quit anyway" so the exit confirmation allows the loop to break
    mockPicker.pick.mockResolvedValue(1);

    await runAgent(false);

    // Worker mode should still be active — ^C did not stop it (task was in progress)
    expect(capturedStatus?.workerModeActive).toBe(true);
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
      await agent.start(false);
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
