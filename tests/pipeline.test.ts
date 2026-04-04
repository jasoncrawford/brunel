/**
 * Full pipeline integration tests: webhook → task store → worker → DB.
 *
 * Spins up a real foreman wired to a real local Supabase instance.
 * Workers are real WebSocket clients. After each action, asserts directly
 * on DB state — not mock call counts.
 *
 * Scenarios:
 *  1. Happy path: webhook → pending in DB → worker → assigned → task_complete → complete in DB
 *  2. Queued then assigned: webhook with no worker → pending → worker connects → assigned
 *  3. Worker disconnect/reclaim: disconnects → reconnects as busy → task still assigned in DB
 *  4. Worker disconnect/expire: reclaim timer fires → task reverted to pending → new worker gets it
 *  5. Dependency blocking: open blocker → worker doesn't get task → blocker closed → assigned
 *  6. PR events forwarded: worker gets task → PR opened → check_run fires → event_notification
 *     sent to worker and webhook_events row in DB has correct task_id
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "net";
import type { ForemanMessage } from "../src/types.js";
import { TaskQueue, WorkerRegistry, createForemanWss } from "../src/foreman.js";
import type { DbLogger } from "../src/db.js";
import {
  createDbLogger,
  createNullDbLogger,
  createTaskStore,
} from "../src/db.js";
import { loadDefaultConfig } from "../src/config.js";
import { createTestSupabase } from "./helpers/db.js";

// ── One-time setup ────────────────────────────────────────────────────────────

const defaultCfg = await loadDefaultConfig();
const supabase = createTestSupabase();
const realDbLogger = createDbLogger(supabase);
const nullDbLogger = createNullDbLogger();
const taskStore = createTaskStore(supabase);

// ── Generic helpers ───────────────────────────────────────────────────────────

/** FIFO queue that buffers all incoming WebSocket messages. */
function makeQueue(ws: WebSocket): { next: () => Promise<ForemanMessage>; isEmpty: () => boolean } {
  const pending: ForemanMessage[] = [];
  const waiters: Array<(m: ForemanMessage) => void> = [];
  ws.on("message", (data: Buffer | string) => {
    const msg = JSON.parse(data.toString()) as ForemanMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else pending.push(msg);
  });
  return {
    next(): Promise<ForemanMessage> {
      if (pending.length > 0) return Promise.resolve(pending.shift()!);
      return new Promise((r) => waiters.push(r));
    },
    isEmpty(): boolean {
      return pending.length === 0;
    },
  };
}

function send(ws: WebSocket, msg: object) {
  ws.send(JSON.stringify(msg));
}

function connectWorker(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/worker`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/**
 * Polls an async predicate until it returns a truthy value.
 * Throws if it doesn't resolve within timeoutMs.
 */
async function pollUntil<T>(
  fn: () => Promise<T | null | undefined>,
  timeoutMs = 10000,
  intervalMs = 30,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
}

/** Fetch the latest DB row for a task. */
async function getDbTask(taskId: string) {
  const tasks = await taskStore.listTasks();
  return tasks.find((t) => t.taskId === taskId);
}

// ── Webhook payload factories ─────────────────────────────────────────────────

function labeledPayload(issueNumber: number, body = "") {
  return {
    action: "labeled",
    label: { name: "brunel:ready" },
    issue: {
      number: issueNumber,
      title: `Issue ${issueNumber}`,
      body,
      labels: [{ name: "brunel:ready" }],
    },
    repository: { html_url: "https://github.com/owner/repo" },
  };
}

function closedPayload(issueNumber: number) {
  return {
    action: "closed",
    issue: {
      number: issueNumber,
      title: `Issue ${issueNumber}`,
      body: "",
      labels: [],
    },
    repository: { html_url: "https://github.com/owner/repo" },
  };
}

function prOpenedPayload(
  prNumber: number,
  body: string,
  headBranch = `branch-pr-${prNumber}`,
) {
  return {
    action: "opened",
    pull_request: {
      number: prNumber,
      title: `PR ${prNumber}`,
      body,
      head: { ref: headBranch },
    },
    repository: { html_url: "https://github.com/owner/repo" },
  };
}

function checkRunPayload(prNumber: number) {
  return {
    action: "completed",
    check_run: {
      name: "CI",
      conclusion: "success",
      output: { summary: "" },
      pull_requests: [{ number: prNumber }],
    },
    repository: { html_url: "https://github.com/owner/repo" },
  };
}

// ── Shared test harness ───────────────────────────────────────────────────────

/**
 * Returns a fetch mock that intercepts GitHub API calls while passing all
 * other requests (e.g. Supabase) through to the real fetch.
 *
 * The Supabase postgrest-js client calls res.text() internally, so a simple
 * stub that only provides res.json() breaks Supabase inserts/queries.
 */
function makeGithubFetchMock(
  handler: (url: string) => Response | null,
): typeof fetch {
  const realFetch = globalThis.fetch;
  return async function mockFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const intercepted = handler(url);
    if (intercepted) return intercepted;
    return realFetch(input, init);
  } as typeof fetch;
}

function makeGithubResponse(jsonBody: unknown): Response {
  const body = JSON.stringify(jsonBody);
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Default mock: fetchNativeBlockers returns empty, fetchIssueStates returns open. */
function stubFetchNoBlockers() {
  vi.stubGlobal(
    "fetch",
    makeGithubFetchMock((url) => {
      const { hostname, pathname } = new URL(url);
      if (hostname === "api.github.com" || pathname === "/graphql") {
        return makeGithubResponse({
          data: { repository: { issue: { blockedBy: { nodes: [] } } } },
        });
      }
      return null; // pass through to real fetch
    }),
  );
}

/**
 * Builds a foreman + HTTP server pair.  Returns a cleanup function.
 * The caller is responsible for closing any open WebSocket clients first.
 */
function buildForeman(opts: {
  reclaimTimeoutMs?: number;
  dbLogger?: DbLogger;
} = {}): {
  queue: TaskQueue;
  registry: WorkerRegistry;
  httpServer: http.Server;
  wss: WebSocketServer;
  routeEvent: (id: string, name: string, payload: unknown) => void;
  port: number;
  openClients: WebSocket[];
  connect: () => Promise<WebSocket>;
  teardown: () => Promise<void>;
} {
  const queue = new TaskQueue();
  const registry = new WorkerRegistry();
  const httpServer = http.createServer();
  const openClients: WebSocket[] = [];

  const { wss, routeEvent } = createForemanWss(queue, registry, httpServer, {
    taskLabel: defaultCfg.taskLabel,
    reclaimTimeoutMs: opts.reclaimTimeoutMs ?? defaultCfg.workerReclaimTimeoutMs,
    pingIntervalMs: defaultCfg.pingIntervalMs,
    dbLogger: opts.dbLogger ?? nullDbLogger,
    taskStore,
    repo: "owner/repo",
    token: "token",
  });

  // port is assigned synchronously when listen() resolves; we'll resolve it
  // asynchronously below, but return the object immediately so the caller can
  // await `teardown` in afterEach regardless.
  let port = 0;
  const ready = new Promise<void>((resolve) => {
    httpServer.listen(0, () => {
      port = (httpServer.address() as AddressInfo).port;
      resolve();
    });
  });

  function connect(): Promise<WebSocket> {
    return connectWorker(port).then((ws) => {
      openClients.push(ws);
      return ws;
    });
  }

  function teardown(): Promise<void> {
    return new Promise((resolve) => {
      const clients = openClients.splice(0);
      const alive = clients.filter((c) => c.readyState !== WebSocket.CLOSED);
      if (alive.length === 0) {
        wss.close(() => httpServer.close(resolve));
        return;
      }
      let pending = alive.length;
      for (const c of alive) {
        c.once("close", () => {
          if (--pending === 0) wss.close(() => httpServer.close(resolve));
        });
        c.close();
      }
    });
  }

  // Expose everything; caller must await `ready` before using `port`.
  const result = { queue, registry, httpServer, wss, routeEvent, port, openClients, connect, teardown };
  // Patch port lazily via a getter so callers don't have to await ready separately
  Object.defineProperty(result, "port", { get: () => port });
  void ready; // ensure listen is called (it is already)
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1 & 2 & 6 — happy path, queued-then-assigned, PR event forwarding
// ─────────────────────────────────────────────────────────────────────────────

describe("pipeline: happy path and queued-then-assigned", () => {
  let foreman: ReturnType<typeof buildForeman>;

  beforeEach(async () => {
    stubFetchNoBlockers();
    process.env.GITHUB_REPO = "owner/repo";
    process.env.GITHUB_TOKEN = "token";
    await supabase.from("tasks").delete().in("task_id", ["42", "55"]);
    foreman = buildForeman();
    await new Promise<void>((resolve) =>
      foreman.httpServer.once("listening", resolve),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_REPO;
    delete process.env.GITHUB_TOKEN;
    await foreman.teardown();
  });

  it("webhook → task pending in DB → worker → task_assigned → task_complete → complete in DB", async () => {
    const { queue, routeEvent, connect } = foreman;

    // 1. Webhook fires; foreman enqueues the task
    routeEvent("evt-1", "issues", labeledPayload(42));

    // 2. Task row appears in DB with status=pending
    const pendingRow = await pollUntil(() => getDbTask("42"));
    expect(pendingRow.status).toBe("pending");
    expect(pendingRow.issueNumber).toBe(42);

    // 3. Worker connects; hello_ack + task_assigned arrive
    const ws = await connect();
    const q = makeQueue(ws);
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    const ack = await q.next();
    expect(ack.type).toBe("hello_ack");

    const assigned = await q.next();
    expect(assigned.type).toBe("task_assigned");
    expect((assigned as any).issue.number).toBe(42);

    // 4. DB should now show assigned
    const assignedRow = await pollUntil(async () => {
      const row = await getDbTask("42");
      return row?.status === "assigned" ? row : null;
    });
    expect(assignedRow.workerId).toBe("w1");

    // 5. Worker completes the task
    send(ws, { type: "task_complete", workerId: "w1", taskId: "42" });

    // 6. DB should now show complete
    await pollUntil(async () => {
      const row = await getDbTask("42");
      return row?.status === "complete" ? row : null;
    });

    // 7. In-memory queue reflects complete status
    expect(queue.get("42")?.status).toBe("complete");
  });

  it("webhook with no worker → task pending in DB → worker connects → task assigned", async () => {
    const { routeEvent, connect } = foreman;

    // 1. Webhook fires but no worker is connected
    routeEvent("evt-1", "issues", labeledPayload(55));

    // 2. Task appears as pending in DB
    const pendingRow = await pollUntil(() => getDbTask("55"));
    expect(pendingRow.status).toBe("pending");

    // 3. Worker connects later
    const ws = await connect();
    const q = makeQueue(ws);
    send(ws, { type: "worker_hello", workerId: "w2", status: "idle" });
    const ack = await q.next();
    expect(ack.type).toBe("hello_ack");

    const assigned = await q.next();
    expect(assigned.type).toBe("task_assigned");
    expect((assigned as any).issue.number).toBe(55);

    // 4. DB reflects assigned status
    await pollUntil(async () => {
      const row = await getDbTask("55");
      return row?.status === "assigned" ? row : null;
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3 — worker disconnect and reclaim within window
// ─────────────────────────────────────────────────────────────────────────────

describe("pipeline: worker disconnect/reclaim (within reclaim window)", () => {
  let foreman: ReturnType<typeof buildForeman>;

  beforeEach(async () => {
    stubFetchNoBlockers();
    process.env.GITHUB_REPO = "owner/repo";
    process.env.GITHUB_TOKEN = "token";
    await supabase.from("tasks").delete().in("task_id", ["70"]);
    // Long enough reclaim window that the reconnect happens before it expires
    foreman = buildForeman({ reclaimTimeoutMs: 30_000 });
    await new Promise<void>((resolve) =>
      foreman.httpServer.once("listening", resolve),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_REPO;
    delete process.env.GITHUB_TOKEN;
    await foreman.teardown();
  });

  it("worker disconnects and reconnects as busy → task stays assigned in DB", async () => {
    const { routeEvent, connect, openClients } = foreman;

    // 1. Assign task to a worker
    routeEvent("evt-1", "issues", labeledPayload(70));
    const ws1 = await connect();
    const q1 = makeQueue(ws1);
    send(ws1, { type: "worker_hello", workerId: "w-reclaim", status: "idle" });
    await q1.next(); // hello_ack
    await q1.next(); // task_assigned

    // Confirm assigned in DB
    await pollUntil(async () => {
      const row = await getDbTask("70");
      return row?.status === "assigned" ? row : null;
    });

    // 2. Worker disconnects abruptly
    const closed = new Promise<void>((resolve) =>
      ws1.once("close", resolve),
    );
    ws1.terminate();
    await closed;
    // Remove from tracked open clients so teardown doesn't double-close it
    const idx = openClients.indexOf(ws1);
    if (idx >= 0) openClients.splice(idx, 1);

    // 3. Worker reconnects as busy within the reclaim window
    const ws2 = await connect();
    const q2 = makeQueue(ws2);
    send(ws2, {
      type: "worker_hello",
      workerId: "w-reclaim",
      taskId: "70",
      status: "busy",
    });
    const ack2 = await q2.next();
    expect(ack2.type).toBe("hello_ack");
    expect((ack2 as any).status).toBe("busy");

    // 4. Task must still show as assigned in DB (not reverted to pending)
    const dbRow = await getDbTask("70");
    expect(dbRow?.status).toBe("assigned");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4 — worker disconnect, reclaim timer expires
// ─────────────────────────────────────────────────────────────────────────────

describe("pipeline: worker disconnect/expire (reclaim timer fires)", () => {
  let foreman: ReturnType<typeof buildForeman>;

  beforeEach(async () => {
    stubFetchNoBlockers();
    process.env.GITHUB_REPO = "owner/repo";
    process.env.GITHUB_TOKEN = "token";
    await supabase.from("tasks").delete().in("task_id", ["80"]);
    // Very short reclaim window so the timer fires quickly
    foreman = buildForeman({ reclaimTimeoutMs: 80 });
    await new Promise<void>((resolve) =>
      foreman.httpServer.once("listening", resolve),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_REPO;
    delete process.env.GITHUB_TOKEN;
    await foreman.teardown();
  });

  it("worker disconnects → reclaim timer fires → task reverted to pending in DB → new worker gets it", async () => {
    const { queue, routeEvent, connect, openClients } = foreman;

    // 1. Assign task to first worker
    routeEvent("evt-1", "issues", labeledPayload(80));
    const ws1 = await connect();
    const q1 = makeQueue(ws1);
    send(ws1, { type: "worker_hello", workerId: "w-expire", status: "idle" });
    await q1.next(); // hello_ack
    await q1.next(); // task_assigned

    await pollUntil(async () => {
      const row = await getDbTask("80");
      return row?.status === "assigned" ? row : null;
    });

    // 2. Worker disconnects; do not reconnect
    const closed = new Promise<void>((resolve) =>
      ws1.once("close", resolve),
    );
    ws1.terminate();
    await closed;
    const idx = openClients.indexOf(ws1);
    if (idx >= 0) openClients.splice(idx, 1);

    // 3. Wait for the reclaim timer to fire and revert the task to pending in DB
    await pollUntil(async () => {
      const row = await getDbTask("80");
      return row?.status === "pending" ? row : null;
    });

    // 4. In-memory queue also shows pending
    expect(queue.get("80")?.status).toBe("pending");

    // 5. New worker connects and receives the task
    const ws2 = await connect();
    const q2 = makeQueue(ws2);
    send(ws2, {
      type: "worker_hello",
      workerId: "w-expire-new",
      status: "idle",
    });
    await q2.next(); // hello_ack
    const assigned = await q2.next();
    expect(assigned.type).toBe("task_assigned");
    expect((assigned as any).issue.number).toBe(80);

    // 6. DB shows assigned to new worker
    await pollUntil(async () => {
      const row = await getDbTask("80");
      return row?.status === "assigned" && row.workerId === "w-expire-new"
        ? row
        : null;
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5 — dependency blocking
// ─────────────────────────────────────────────────────────────────────────────

describe("pipeline: dependency blocking", () => {
  let foreman: ReturnType<typeof buildForeman>;

  beforeEach(async () => {
    // Stub fetch: native blocker query returns empty; issue-state query for #91 returns open.
    // Supabase calls are passed through to real fetch (they call res.text() internally).
    vi.stubGlobal(
      "fetch",
      makeGithubFetchMock((url) => {
        const { hostname, pathname } = new URL(url);
        if (pathname === "/graphql") {
          // fetchNativeBlockers — no native blockers
          return makeGithubResponse({
            data: { repository: { issue: { blockedBy: { nodes: [] } } } },
          });
        }
        if (hostname === "api.github.com") {
          // fetchIssueStates — issue #91 is open
          return makeGithubResponse({ number: 91, state: "open" });
        }
        return null; // pass through to real fetch
      }),
    );
    process.env.GITHUB_REPO = "owner/repo";
    process.env.GITHUB_TOKEN = "token";
    await supabase.from("tasks").delete().in("task_id", ["91", "92"]);
    foreman = buildForeman();
    await new Promise<void>((resolve) =>
      foreman.httpServer.once("listening", resolve),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_REPO;
    delete process.env.GITHUB_TOKEN;
    await foreman.teardown();
  });

  it("task with open blocker is not assigned → blocker closed → worker receives task_assigned", async () => {
    const { routeEvent, connect } = foreman;

    // 1. Connect an idle worker
    const ws = await connect();
    const q = makeQueue(ws);
    send(ws, { type: "worker_hello", workerId: "w-blocked", status: "idle" });
    const ack = await q.next();
    expect(ack.type).toBe("hello_ack");
    expect((ack as any).status).toBe("idle");

    // 2. Issue #92 depends on issue #91 (via body text). Issue #91 is open.
    routeEvent("evt-1", "issues", labeledPayload(92, "Depends on #91"));

    // 3. Wait for the task row to appear in DB as pending (deps loaded, but blocked)
    await pollUntil(() => getDbTask("92"));

    // 4. Give deps-loading enough time to complete; worker should still be idle
    await new Promise((r) => setTimeout(r, 200));
    // No task_assigned should have arrived yet (check buffer without registering a waiter)
    expect(q.isEmpty()).toBe(true);

    // 5. Close the blocker issue — this unblocks task #92
    routeEvent("evt-2", "issues", closedPayload(91));

    // 6. Worker now receives task_assigned
    const assigned = await q.next();
    expect(assigned.type).toBe("task_assigned");
    expect((assigned as any).issue.number).toBe(92);

    // 7. DB reflects assigned status
    await pollUntil(async () => {
      const row = await getDbTask("92");
      return row?.status === "assigned" ? row : null;
    });
  }, 15000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 6 — PR events forwarded; webhook_events row has correct task_id
// ─────────────────────────────────────────────────────────────────────────────

describe("pipeline: PR events forwarded and logged to DB", () => {
  let foreman: ReturnType<typeof buildForeman>;

  beforeEach(async () => {
    stubFetchNoBlockers();
    process.env.GITHUB_REPO = "owner/repo";
    process.env.GITHUB_TOKEN = "token";
    await Promise.all([
      supabase.from("tasks").delete().in("task_id", ["100"]),
      supabase.from("webhook_events").delete().in("delivery_id", ["evt-1", "evt-pr", "evt-cr"]),
      supabase.from("foreman_messages").delete().eq("worker_id", "w-pr"),
    ]);
    foreman = buildForeman({ dbLogger: realDbLogger });
    await new Promise<void>((resolve) =>
      foreman.httpServer.once("listening", resolve),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_REPO;
    delete process.env.GITHUB_TOKEN;
    await foreman.teardown();
  });

  it("check_run for worker's PR is forwarded as event_notification and logged in DB with task_id", async () => {
    const { routeEvent, connect } = foreman;

    // 1. Get a task assigned to a worker
    routeEvent("evt-1", "issues", labeledPayload(100));
    const ws = await connect();
    const q = makeQueue(ws);
    send(ws, { type: "worker_hello", workerId: "w-pr", status: "idle" });
    await q.next(); // hello_ack
    await q.next(); // task_assigned

    // 2. Worker opens a PR that closes issue #100 (now also forwarded as event_notification)
    routeEvent("evt-pr", "pull_request", prOpenedPayload(20, "Closes #100"));
    await q.next(); // pull_request event_notification

    // 3. A check_run fires for PR #20
    routeEvent("evt-cr", "check_run", checkRunPayload(20));

    // 4. Worker receives event_notification
    const evtMsg = await q.next();
    expect(evtMsg.type).toBe("event_notification");
    expect((evtMsg as any).event.name).toBe("check_run");

    // 5. The check_run webhook_events row in DB must have task_id = "100"
    const checkRunRow = await pollUntil(async () => {
      const { data } = await supabase
        .from("webhook_events")
        .select("task_id, event_name")
        .eq("event_name", "check_run")
        .limit(1)
        .single();
      return data?.task_id === "100" ? data : null;
    });
    expect(checkRunRow.task_id).toBe("100");
  }, 15000);
});
