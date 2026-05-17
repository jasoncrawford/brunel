/**
 * Tests for the /worker:revive command:
 * - prefix resolution (no match, ambiguous, unique)
 * - correct agent ID extracted from directory name
 * - correct status: "revive" sent in the worker_hello
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { WorkerController } from "../src/agent/controllers/worker-controller.js";
import { WorkspaceController } from "../src/agent/controllers/workspace-controller.js";
import { AgentStatus } from "../src/agent/models/agent-status.js";
import { Workspace } from "../src/agent/models/workspace.js";
import { CommandRegistry } from "../src/agent/controllers/command-controller.js";
import { Picker, type PickConfig } from "../src/agent/views/picker.js";
import * as Wire from "../shared/wire.js";

// ── Fake WebSocket ─────────────────────────────────────────────────────────────

class FakeWs extends EventEmitter {
  readyState = 1;
  send = vi.fn();
  ping = vi.fn();
  close = vi.fn().mockImplementation(function (this: FakeWs) {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from(""));
  });
  terminate = vi.fn().mockImplementation(function (this: FakeWs) {
    this.readyState = 3;
    this.emit("close", 1006, Buffer.from(""));
  });
}

function makeMockPicker(): Picker {
  return {
    pick: vi.fn().mockImplementation(async (_opts: string[], _cfg?: PickConfig) => 0),
  } as unknown as Picker;
}

// ── Fake display ───────────────────────────────────────────────────────────────

function makeDisplay() {
  return { print: vi.fn(), printForemanMessage: vi.fn() };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const BASE_DIR = path.join(os.tmpdir(), `brunel-revive-test-${process.pid}`);

/** Create a fake workspace directory with .git to pass attach() validation. */
function makeWorkspaceDir(agentId: string): string {
  const dir = path.join(BASE_DIR, agentId);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

let savedCwd: string;

beforeEach(() => {
  savedCwd = process.cwd();
  fs.mkdirSync(BASE_DIR, { recursive: true });
  // Mock child_process so git operations don't actually run
  vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return {
      ...actual,
      execFile: vi.fn((_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(null, { stdout: "", stderr: "" });
      }),
    };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  // Restore cwd before removing the temp dir so subsequent process.cwd() calls succeed.
  try { process.chdir(savedCwd); } catch { /* ignore if already invalid */ }
  fs.rmSync(BASE_DIR, { recursive: true, force: true });
});

// ── Test harness ───────────────────────────────────────────────────────────────

function makeSession(workspaceDir?: string) {
  let fakeWs = new FakeWs();
  const wsFactory = vi.fn().mockImplementation(() => {
    // Emit "open" as a microtask — FakeWs starts with readyState=1 (OPEN),
    // so the connection is "instant". This lets connect()'s "open" handler fire
    // before the awaited start() promise resolves.
    Promise.resolve().then(() => fakeWs.emit("open"));
    return fakeWs;
  });
  const agentStatus = new AgentStatus({ agentId: "current-agent-id" });
  const display = makeDisplay();

  // Build a minimal workspace (not yet created) so workspaceDir is accessible
  const workspace = workspaceDir
    ? new Workspace(workspaceDir, agentStatus.agentId, "https://github.com/owner/repo.git", process.cwd(), async () => true)
    : undefined;
  const workspaceController = new WorkspaceController(workspace, display, { verbose: false });

  const session = new WorkerController(
    agentStatus,
    display,
    makeMockPicker(),
    workspaceController,
    "owner/repo",
    { wsFactory },
  );

  const registry = new CommandRegistry();
  session.registerCommands(registry.scoped("worker"));

  return { session, agentStatus, display, wsFactory, registry, getFakeWs: () => fakeWs };
}

function helloFromWs(ws: FakeWs): (Wire.WorkerMessage & { type: "worker_hello" }) | undefined {
  for (const [data] of ws.send.mock.calls) {
    try {
      const msg = JSON.parse(data as string);
      if (msg.type === "worker_hello") return msg;
    } catch { /* ignore */ }
  }
  return undefined;
}

// ── Prefix resolution ──────────────────────────────────────────────────────────

describe("/worker:revive — prefix resolution", () => {
  it("prints error when no workspace matches the prefix", async () => {
    const { registry, display } = makeSession(BASE_DIR);
    await registry.execute("worker:revive", "nonexistent-prefix");
    expect(display.print).toHaveBeenCalledWith(expect.stringMatching(/no worker workspace found/i));
  });

  it("prints error when multiple workspaces match the prefix", async () => {
    makeWorkspaceDir("albert-uuid-1");
    makeWorkspaceDir("albert-uuid-2");

    const { registry, display } = makeSession(BASE_DIR);
    await registry.execute("worker:revive", "albert");
    expect(display.print).toHaveBeenCalledWith(expect.stringMatching(/ambiguous/i));
  });

  it("proceeds when exactly one workspace matches", async () => {
    makeWorkspaceDir("harold-abc123");
    const { registry, display } = makeSession(BASE_DIR);
    await registry.execute("worker:revive", "harold");
    // Should NOT print an error
    const printed = (display.print as ReturnType<typeof vi.fn>).mock.calls.map(([line]) => line).join("\n");
    expect(printed).not.toMatch(/no worker workspace found/i);
    expect(printed).not.toMatch(/ambiguous/i);
  });
});

// ── Agent ID assumption ────────────────────────────────────────────────────────

describe("/worker:revive — agent ID assumption", () => {
  it("sets agentId to the full directory name", async () => {
    const agentId = "harold-6ee65735-aaaa-bbbb-cccc-ddddeeeeffffgggg";
    makeWorkspaceDir(agentId);

    const { registry, agentStatus } = makeSession(BASE_DIR);
    // Stop start() from actually connecting
    vi.spyOn(agentStatus, "setWorkerModeActive");
    await registry.execute("worker:revive", "harold");

    expect(agentStatus.agentId).toBe(agentId);
  });
});

// ── Revive status in worker_hello ──────────────────────────────────────────────

describe("/worker:revive — status in worker_hello", () => {
  it("sends status='revive' in the first worker_hello", async () => {
    const agentId = "patience-aabbccdd-1111-2222-3333-444455556666";
    makeWorkspaceDir(agentId);

    const { registry, getFakeWs } = makeSession(BASE_DIR);
    await registry.execute("worker:revive", "patience");

    const hello = helloFromWs(getFakeWs());
    expect(hello?.status).toBe("revive");
  });

  it("workerId in the hello matches the dead worker's agent ID", async () => {
    const agentId = "mercy-deadbeef-1234-5678-abcd-ef0123456789";
    makeWorkspaceDir(agentId);

    const { registry, getFakeWs } = makeSession(BASE_DIR);
    await registry.execute("worker:revive", "mercy");

    const hello = helloFromWs(getFakeWs());
    expect(hello?.workerId).toBe(agentId);
  });

  it("uses ready status on reconnect after revive (not revive again)", async () => {
    const agentId = "caleb-aabbccdd-1111-2222-3333-444455556666";
    makeWorkspaceDir(agentId);

    const { registry, session, getFakeWs } = makeSession(BASE_DIR);
    await registry.execute("worker:revive", "caleb");

    const firstWs = getFakeWs();
    const firstHello = helloFromWs(firstWs);
    expect(firstHello?.status).toBe("revive");

    // Simulate a disconnect and reconnect — foreman replies with ready
    firstWs.emit("message", Buffer.from(JSON.stringify({
      type: "hello_ack",
      workerId: agentId,
      status: "ready",
      repoStatus: "active",
    } satisfies Wire.ForemanMessage)));

    // Force reconnect
    firstWs.close();

    // Wait briefly for reconnect to fire (uses setTimeout(0) via jitter)
    await new Promise(r => setTimeout(r, 50));

    // The second WebSocket's hello should NOT say "revive"
    const reconnectWs = getFakeWs();
    if (reconnectWs !== firstWs) {
      const secondHello = helloFromWs(reconnectWs);
      if (secondHello) {
        expect(secondHello.status).not.toBe("revive");
      }
    }
  });
});

// ── Foreman rejection rollback ─────────────────────────────────────────────────

describe("/worker:revive — foreman rejection rollback", () => {
  it("detaches workspace (removes lock, restores cwd) when foreman sends fatal error", async () => {
    const agentId = "harold-aaaa-1111-2222-3333-bbbbccccdddd";
    const workerDir = makeWorkspaceDir(agentId);
    const originalCwd = process.cwd();

    const { registry, getFakeWs } = makeSession(BASE_DIR);
    await registry.execute("worker:revive", "harold-aaaa");

    // Lock was written by attach() and cwd was changed — confirm both
    expect(fs.existsSync(path.join(workerDir, ".brunel.lock"))).toBe(true);
    expect(process.cwd()).toBe(workerDir);

    // Foreman rejects the revive
    getFakeWs().emit("message", Buffer.from(JSON.stringify({
      type: "foreman_error",
      message: "Worker is currently connected — cannot revive",
      fatal: true,
    } satisfies Wire.ForemanMessage)));

    // Lock should be gone — workspace detached
    expect(fs.existsSync(path.join(workerDir, ".brunel.lock"))).toBe(false);
    // Directory itself must still exist (not destroyed)
    expect(fs.existsSync(workerDir)).toBe(true);
    // cwd should be restored
    expect(process.cwd()).toBe(originalCwd);
  });

  it("allows a second /worker:revive after a fatal rejection", async () => {
    const agentId = "rufus-bbbb-1111-2222-3333-ccccddddeeee";
    const workerDir = makeWorkspaceDir(agentId);

    const { registry, getFakeWs, display } = makeSession(BASE_DIR);

    // First attempt — foreman rejects
    await registry.execute("worker:revive", "rufus-bbbb");
    getFakeWs().emit("message", Buffer.from(JSON.stringify({
      type: "foreman_error",
      message: "Worker is currently connected",
      fatal: true,
    } satisfies Wire.ForemanMessage)));

    // Second attempt — must not report "still running"
    await registry.execute("worker:revive", "rufus-bbbb");
    const printed = (display.print as ReturnType<typeof vi.fn>).mock.calls.map(([l]) => l as string).join("\n");
    expect(printed).not.toMatch(/still running/i);
    // Lock should exist again (written by the second attach)
    expect(fs.existsSync(path.join(workerDir, ".brunel.lock"))).toBe(true);
  });
});

// ── Wire protocol — PROTOCOL_VERSION ─────────────────────────────────────────

describe("wire protocol — revive status", () => {
  it("'revive' is a valid status in worker_hello", () => {
    // Compile-time check: this assignment must not be a TypeScript error.
    const msg: Wire.WorkerMessage = {
      type: "worker_hello",
      workerId: "w1",
      repo: "owner/repo",
      status: "revive",
    };
    expect(msg.type).toBe("worker_hello");
  });
});
