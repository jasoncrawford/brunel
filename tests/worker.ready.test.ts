/**
 * Unit tests for the /worker:ready command.
 *
 * Tests the worker-side of opting back into auto-assignment: error cases
 * (not active, active task) and the happy path (sends worker_ready to foreman).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { WorkerController } from "../src/agent/controllers/worker-controller.js";
import { AgentStatus } from "../src/agent/models/agent-status.js";
import { CommandRegistry } from "../src/agent/controllers/command-controller.js";
import * as Wire from "../shared/wire.js";
import { stripAnsi } from "./helpers.js";

const FAKE_ISSUE: Wire.TaskIssue = {
  number: 978,
  title: "Some task",
  body: "Task body",
  labels: [],
  repoUrl: "https://github.com/owner/repo",
  status: "assigned",
};

// ── Fake WebSocket ─────────────────────────────────────────────────────────────

class FakeWs extends EventEmitter {
  readyState = 1; // OPEN
  send = vi.fn();
  ping = vi.fn();
  close = vi.fn().mockImplementation(() => {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from(""));
  });
  terminate = vi.fn().mockImplementation(() => {
    this.readyState = 3;
    this.emit("close", 1006, Buffer.from(""));
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const AGENT_ID = "test-worker-ready-id";

function sentWorkerReady(ws: FakeWs): { type: string; workerId: string } | undefined {
  for (const call of ws.send.mock.calls) {
    try {
      const msg = JSON.parse(call[0] as string);
      if (msg.type === "worker_ready") return msg;
    } catch { /* ignore */ }
  }
  return undefined;
}

function printedMessages(display: { print: ReturnType<typeof vi.fn> }): string[] {
  return display.print.mock.calls.map((a) => stripAnsi(String(a[0])));
}

// ── Test harness ──────────────────────────────────────────────────────────────

let fakeWs: FakeWs;
let wsFactory: ReturnType<typeof vi.fn>;
let display: { print: ReturnType<typeof vi.fn>; printForemanMessage: ReturnType<typeof vi.fn> };
let session: WorkerController;
let registry: CommandRegistry;

function makeSession(): WorkerController {
  return new WorkerController(
    new AgentStatus({ agentId: AGENT_ID }),
    display,
    undefined,
    undefined,
    "owner/repo",
    { wsFactory },
  );
}

async function getReadyHandler(s: WorkerController): Promise<(args: string) => Promise<void>> {
  const reg = new CommandRegistry();
  s.registerCommands(reg.scoped("worker"));
  const entry = reg.lookup("worker:ready");
  if (!entry) throw new Error("worker:ready not registered");
  return entry.handler as (args: string) => Promise<void>;
}

beforeEach(() => {
  fakeWs = new FakeWs();
  wsFactory = vi.fn().mockReturnValue(fakeWs);
  display = { print: vi.fn(), printForemanMessage: vi.fn() };
  session = makeSession();
  registry = new CommandRegistry();
  session.registerCommands(registry.scoped("worker"));
});

afterEach(() => { vi.useRealTimers(); });

// ── Command registration ───────────────────────────────────────────────────────

it("registers worker:ready command", () => {
  expect(registry.lookup("worker:ready")).toBeDefined();
});

// ── Error cases ────────────────────────────────────────────────────────────────

describe("when worker mode is not active", () => {
  it("prints an error and does not send worker_ready", async () => {
    const handler = await getReadyHandler(session);
    await handler("");
    const msgs = printedMessages(display);
    expect(msgs.some(m => m.toLowerCase().includes("not connected"))).toBe(true);
    expect(sentWorkerReady(fakeWs)).toBeUndefined();
  });
});

describe("when has an active task", () => {
  beforeEach(async () => {
    await session.start();
    (session as any).currentTaskId = "existing-task-id";
    (session as any).currentIssue = FAKE_ISSUE;
    fakeWs.send.mockClear();
  });

  it("prints an error and does not send worker_ready", async () => {
    const handler = await getReadyHandler(session);
    await handler("");
    const msgs = printedMessages(display);
    expect(msgs.some(m => m.toLowerCase().includes("task"))).toBe(true);
    expect(sentWorkerReady(fakeWs)).toBeUndefined();
  });
});

// ── Happy path ─────────────────────────────────────────────────────────────────

describe("when active and idle (no active task)", () => {
  beforeEach(async () => {
    await session.start();
    fakeWs.send.mockClear();
  });

  it("sends worker_ready with correct workerId", async () => {
    const handler = await getReadyHandler(session);
    await handler("");
    const msg = sentWorkerReady(fakeWs);
    expect(msg).toBeDefined();
    expect(msg?.workerId).toBe(AGENT_ID);
    expect(msg?.type).toBe("worker_ready");
  });

  it("prints a confirmation message", async () => {
    const handler = await getReadyHandler(session);
    await handler("");
    const msgs = printedMessages(display);
    expect(msgs.some(m => m.length > 0)).toBe(true);
  });
});

describe("when socket is not open", () => {
  beforeEach(async () => {
    await session.start();
    fakeWs.readyState = 3; // CLOSED
    fakeWs.send.mockClear();
  });

  it("does not send worker_ready when socket is closed", async () => {
    const handler = await getReadyHandler(session);
    await handler("");
    expect(sentWorkerReady(fakeWs)).toBeUndefined();
  });
});
