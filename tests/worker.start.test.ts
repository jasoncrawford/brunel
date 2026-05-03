/**
 * Unit tests for the /worker:start command (with /worker:ready as alias).
 *
 * Tests: auto-starting if not connected, prompting to abandon an active task,
 * and the happy path (sends worker_ready to foreman and prints "Waiting for tasks...").
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

const AGENT_ID = "test-worker-start-id";

function sentWorkerReady(ws: FakeWs): { type: string; workerId: string } | undefined {
  for (const call of ws.send.mock.calls) {
    try {
      const msg = JSON.parse(call[0] as string);
      if (msg.type === "worker_ready") return msg;
    } catch { /* ignore */ }
  }
  return undefined;
}

function sentGoodbye(ws: FakeWs): Record<string, unknown> | undefined {
  for (const call of ws.send.mock.calls) {
    try {
      const msg = JSON.parse(call[0] as string);
      if (msg.type === "worker_goodbye") return msg;
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

function makeSession(pickFn?: (options: string[]) => Promise<number>): WorkerController {
  return new WorkerController(
    new AgentStatus({ agentId: AGENT_ID }),
    display,
    undefined,
    undefined,
    "owner/repo",
    { wsFactory, ...(pickFn && { pickFn }) },
  );
}

async function getStartHandler(s: WorkerController): Promise<(args: string) => Promise<void>> {
  const reg = new CommandRegistry();
  s.registerCommands(reg.scoped("worker"));
  const entry = reg.lookup("worker:start");
  if (!entry) throw new Error("worker:start not registered");
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

it("registers worker:start as canonical command", () => {
  expect(registry.lookup("worker:start")).toBeDefined();
  expect(registry.lookup("worker:start")?.aliasFor).toBeUndefined();
});

it("registers worker:ready as alias for worker:start", () => {
  const entry = registry.lookup("worker:ready");
  expect(entry).toBeDefined();
  expect(entry?.aliasFor).toBe("worker:start");
});

// ── Not active: auto-start ─────────────────────────────────────────────────────

describe("when worker mode is not active", () => {
  it("starts worker mode", async () => {
    expect(session.isActive).toBe(false);
    const handler = await getStartHandler(session);
    await handler("");
    expect(session.isActive).toBe(true);
  });

  it("connects as ready (not reserved)", async () => {
    const handler = await getStartHandler(session);
    await handler("");
    // Fire open to trigger hello send
    fakeWs.emit("open");
    await new Promise<void>((r) => setImmediate(r));
    const hello = fakeWs.send.mock.calls
      .map((c) => { try { return JSON.parse(c[0] as string); } catch { return null; } })
      .find((m) => m?.type === "worker_hello");
    expect(hello?.status).toBe("ready");
  });
});

// ── Active task: abandon prompt ────────────────────────────────────────────────

describe("when has an active task", () => {
  function setupActiveTask(s: WorkerController): void {
    (s as any).currentTaskId = "existing-task-id";
    (s as any).currentIssue = FAKE_ISSUE;
  }

  it("shows an abandon prompt", async () => {
    const pickFn = vi.fn().mockResolvedValue(1); // "No, stay"
    const s = makeSession(pickFn);
    await s.start();
    setupActiveTask(s);
    const handler = await getStartHandler(s);
    await handler("");
    expect(pickFn).toHaveBeenCalled();
    const [options] = pickFn.mock.calls[0] as [string[]];
    expect(options[0]).toMatch(/abandon/i);
    expect(options[1]).toMatch(/stay/i);
  });

  it("displays the task number in the prompt", async () => {
    const pickFn = vi.fn().mockResolvedValue(1); // "No, stay"
    const s = makeSession(pickFn);
    await s.start();
    setupActiveTask(s);
    const handler = await getStartHandler(s);
    await handler("");
    const msgs = printedMessages(display);
    expect(msgs.some(m => m.includes(String(FAKE_ISSUE.number)))).toBe(true);
  });

  it("does not send worker_ready or goodbye when user stays", async () => {
    const pickFn = vi.fn().mockResolvedValue(1); // "No, stay"
    const s = makeSession(pickFn);
    await s.start();
    setupActiveTask(s);
    fakeWs.send.mockClear();
    const handler = await getStartHandler(s);
    await handler("");
    expect(sentWorkerReady(fakeWs)).toBeUndefined();
    expect(sentGoodbye(fakeWs)).toBeUndefined();
  });

  it("sends worker_ready (not goodbye) and keeps connection when user abandons", async () => {
    const pickFn = vi.fn().mockResolvedValue(0); // "Yes, abandon"
    const s = makeSession(pickFn);
    await s.start();
    setupActiveTask(s);
    fakeWs.send.mockClear();
    const handler = await getStartHandler(s);
    await handler("");
    expect(sentWorkerReady(fakeWs)).toBeDefined();
    expect(sentGoodbye(fakeWs)).toBeUndefined();
    expect(fakeWs.close).not.toHaveBeenCalled();
  });

  it("clears currentTaskId when user abandons", async () => {
    const pickFn = vi.fn().mockResolvedValue(0); // "Yes, abandon"
    const s = makeSession(pickFn);
    await s.start();
    setupActiveTask(s);
    const handler = await getStartHandler(s);
    await handler("");
    expect((s as any).currentTaskId).toBeUndefined();
  });
});

// ── Happy path: idle worker ────────────────────────────────────────────────────

describe("when active and idle (no active task)", () => {
  beforeEach(async () => {
    await session.start();
    fakeWs.send.mockClear();
  });

  it("sends worker_ready with correct workerId", async () => {
    const handler = await getStartHandler(session);
    await handler("");
    const msg = sentWorkerReady(fakeWs);
    expect(msg).toBeDefined();
    expect(msg?.workerId).toBe(AGENT_ID);
    expect(msg?.type).toBe("worker_ready");
  });

  it("prints 'Waiting for tasks...'", async () => {
    const handler = await getStartHandler(session);
    await handler("");
    const msgs = printedMessages(display);
    expect(msgs.some(m => m.includes("Waiting for tasks"))).toBe(true);
  });
});

// ── Socket closed ─────────────────────────────────────────────────────────────

describe("when socket is not open", () => {
  beforeEach(async () => {
    await session.start();
    fakeWs.readyState = 3; // CLOSED
    fakeWs.send.mockClear();
  });

  it("does not send worker_ready when socket is closed", async () => {
    const handler = await getStartHandler(session);
    await handler("");
    expect(sentWorkerReady(fakeWs)).toBeUndefined();
  });
});
