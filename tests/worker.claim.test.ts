/**
 * Unit tests for the /worker:claim command.
 *
 * Tests the worker-side of task claiming: error cases, immediate send when
 * already registered, deferred send after hello_ack, and auto-starting
 * worker mode when not yet active.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { WorkerController } from "../src/agent/controllers/worker-controller.js";
import { AgentStatus } from "../src/agent/models/agent-status.js";
import { CommandRegistry } from "../src/agent/controllers/command-controller.js";
import * as Wire from "../shared/wire.js";
import { stripAnsi } from "./helpers.js";

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

const AGENT_ID = "test-worker-id";

function sendForemanMsg(ws: FakeWs, msg: Wire.ForemanMessage) {
  ws.emit("message", Buffer.from(JSON.stringify(msg)));
}

function sentClaimTask(ws: FakeWs): { type: string; taskId: string; workerId: string } | undefined {
  for (const call of ws.send.mock.calls) {
    try {
      const msg = JSON.parse(call[0] as string);
      if (msg.type === "claim_task") return msg;
    } catch { /* ignore */ }
  }
  return undefined;
}

function sentHello(ws: FakeWs): Record<string, unknown> | undefined {
  for (const call of ws.send.mock.calls) {
    try {
      const msg = JSON.parse(call[0] as string);
      if (msg.type === "worker_hello") return msg as Record<string, unknown>;
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

async function getClaimHandler(s: WorkerController): Promise<(args: string) => Promise<void>> {
  const reg = new CommandRegistry();
  s.registerCommands(reg.scoped("worker"));
  const entry = reg.lookup("worker:claim");
  if (!entry) throw new Error("worker:claim not registered");
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

// ── Command registration ────────────────────────────────────────────────────────

it("registers worker:claim command", () => {
  expect(registry.lookup("worker:claim")).toBeDefined();
});

// ── Error cases ────────────────────────────────────────────────────────────────

describe("error cases", () => {
  beforeEach(async () => { await session.start(); });

  it("prints usage error when no taskId is given", async () => {
    const handler = await getClaimHandler(session);
    await handler("");
    expect(printedMessages(display).some(m => m.includes("Usage"))).toBe(true);
  });

  it("prints usage error when only whitespace is given", async () => {
    const handler = await getClaimHandler(session);
    await handler("   ");
    expect(printedMessages(display).some(m => m.includes("Usage"))).toBe(true);
  });

  it("prints 'Already working on task' error when session has a task", async () => {
    (session as any).currentTaskId = "existing-task-id";
    const handler = await getClaimHandler(session);
    await handler("new-task-id");
    const msgs = printedMessages(display);
    expect(msgs.some(m => m.includes("Already working on task") && m.includes("existing-task-id"))).toBe(true);
  });

  it("does not send claim_task when already has a task", async () => {
    (session as any).currentTaskId = "existing-task-id";
    fakeWs.send.mockClear();
    const handler = await getClaimHandler(session);
    await handler("new-task-id");
    expect(sentClaimTask(fakeWs)).toBeUndefined();
  });
});

// ── Happy path: already registered ────────────────────────────────────────────

describe("when already registered (connectionState === 'registered')", () => {
  beforeEach(async () => {
    await session.start();
    // start() leaves connectionState as "registered" since FakeWs never fires "open"
    fakeWs.send.mockClear();
  });

  it("sends claim_task immediately", async () => {
    const handler = await getClaimHandler(session);
    await handler("42");
    const msg = sentClaimTask(fakeWs);
    expect(msg).toBeDefined();
    expect(msg?.taskId).toBe("42");
    expect(msg?.workerId).toBe(AGENT_ID);
    expect(msg?.type).toBe("claim_task");
  });
});

// ── Happy path: hello_sent state ──────────────────────────────────────────────

describe("when in hello_sent state (waiting for hello_ack)", () => {
  beforeEach(async () => {
    await session.start();
    // Simulate hello_sent: open fired, waiting for hello_ack
    (session as any).connectionState = "hello_sent";
    fakeWs.send.mockClear();
  });

  it("does not send claim_task immediately", async () => {
    const handler = await getClaimHandler(session);
    await handler("42");
    expect(sentClaimTask(fakeWs)).toBeUndefined();
  });

  it("sends claim_task after hello_ack is received", async () => {
    const handler = await getClaimHandler(session);
    await handler("42");

    sendForemanMsg(fakeWs, { type: "hello_ack", workerId: AGENT_ID, status: "idle", repoStatus: "active" });
    await new Promise<void>((r) => setImmediate(r));

    const msg = sentClaimTask(fakeWs);
    expect(msg).toBeDefined();
    expect(msg?.taskId).toBe("42");
  });

  it("clears the pending claim after sending (doesn't send again on reconnect)", async () => {
    const handler = await getClaimHandler(session);
    await handler("42");

    sendForemanMsg(fakeWs, { type: "hello_ack", workerId: AGENT_ID, status: "idle", repoStatus: "active" });
    await new Promise<void>((r) => setImmediate(r));
    fakeWs.send.mockClear();

    // Simulate a second hello_ack (reconnect scenario)
    (session as any).connectionState = "hello_sent";
    sendForemanMsg(fakeWs, { type: "hello_ack", workerId: AGENT_ID, status: "idle", repoStatus: "active" });
    await new Promise<void>((r) => setImmediate(r));

    expect(sentClaimTask(fakeWs)).toBeUndefined();
  });
});

// ── Auto-start worker mode ──────────────────────────────────────────────────────

describe("when worker mode is not active", () => {
  it("starts worker mode before claiming", async () => {
    expect(session.isActive).toBe(false);
    const handler = await getClaimHandler(session);
    await handler("42");
    expect(session.isActive).toBe(true);
  });

  it("includes claimTaskId in the worker_hello when connecting", async () => {
    const handler = await getClaimHandler(session);
    await handler("42");
    // Fire the open event — this triggers the hello send in connect()'s open handler
    fakeWs.emit("open");
    await new Promise<void>((r) => setImmediate(r));

    const hello = sentHello(fakeWs);
    expect(hello).toBeDefined();
    expect(hello?.claimTaskId).toBe("42");
    expect(hello?.status).toBe("idle");
  });

  it("does not send a separate claim_task message when fresh-connecting", async () => {
    const handler = await getClaimHandler(session);
    await handler("42");
    fakeWs.emit("open");
    await new Promise<void>((r) => setImmediate(r));

    expect(sentClaimTask(fakeWs)).toBeUndefined();
  });

  it("clears the pending claim after the hello so reconnect does not re-send claimTaskId", async () => {
    const handler = await getClaimHandler(session);
    await handler("42");
    fakeWs.emit("open");
    await new Promise<void>((r) => setImmediate(r));

    // Simulate reconnect: reset the send mock and fire open again
    fakeWs.send.mockClear();
    fakeWs.emit("open");
    await new Promise<void>((r) => setImmediate(r));

    const hello2 = sentHello(fakeWs);
    expect(hello2?.claimTaskId).toBeUndefined();
  });
});
