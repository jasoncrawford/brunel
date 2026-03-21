# Cloud Deployment Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the brunel foreman to Railway with Supabase event logging and a React admin GUI, eliminating the need for smee.io and enabling always-on operation for beta users.

**Architecture:** The foreman stays a single Node.js process. Three layers are added: a Supabase logging module (`src/db.ts`), an admin WebSocket broadcaster (`src/admin-ws.ts`), and a Vite+React frontend (`frontend/`) served as static files. In-memory state remains authoritative for live dashboard data; Supabase is append-only log storage.

**Tech Stack:** TypeScript+ESM+tsx (existing), Supabase JS client (`@supabase/supabase-js`), React 18 + React Router v6, Vite, Railway (deployment).

**Prerequisites:** Issue #161 (unified config system) must be merged before this plan begins. All config changes build on `src/config.ts` and `BrunelConfig` from that PR.

---

## Chunk 1: Config Extensions, DB Logging, and Environments

### Task 1: Extend BrunelConfig with Supabase and worker-secret fields

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write failing tests for new config fields**

Add to `tests/config.test.ts`:

```ts
// Supabase fields
it("reads supabaseUrl from BRUNEL_SUPABASE_URL", async () => {
  const saved = process.env.BRUNEL_SUPABASE_URL;
  process.env.BRUNEL_SUPABASE_URL = "https://abc.supabase.co";
  try {
    const cfg = await loadConfig([]);
    expect(cfg.supabaseUrl).toBe("https://abc.supabase.co");
  } finally {
    if (saved === undefined) delete process.env.BRUNEL_SUPABASE_URL;
    else process.env.BRUNEL_SUPABASE_URL = saved;
  }
});

it("supabaseUrl defaults to undefined", async () => {
  const saved = process.env.BRUNEL_SUPABASE_URL;
  delete process.env.BRUNEL_SUPABASE_URL;
  try {
    const cfg = await loadConfig([]);
    expect(cfg.supabaseUrl).toBeUndefined();
  } finally {
    if (saved !== undefined) process.env.BRUNEL_SUPABASE_URL = saved;
  }
});

it("reads supabaseServiceRoleKey from BRUNEL_SUPABASE_SERVICE_ROLE_KEY", async () => {
  const saved = process.env.BRUNEL_SUPABASE_SERVICE_ROLE_KEY;
  process.env.BRUNEL_SUPABASE_SERVICE_ROLE_KEY = "secret-key";
  try {
    const cfg = await loadConfig([]);
    expect(cfg.supabaseServiceRoleKey).toBe("secret-key");
  } finally {
    if (saved === undefined) delete process.env.BRUNEL_SUPABASE_SERVICE_ROLE_KEY;
    else process.env.BRUNEL_SUPABASE_SERVICE_ROLE_KEY = saved;
  }
});

it("reads workerSecret from BRUNEL_WORKER_SECRET", async () => {
  const saved = process.env.BRUNEL_WORKER_SECRET;
  process.env.BRUNEL_WORKER_SECRET = "shh";
  try {
    const cfg = await loadConfig([]);
    expect(cfg.workerSecret).toBe("shh");
  } finally {
    if (saved === undefined) delete process.env.BRUNEL_WORKER_SECRET;
    else process.env.BRUNEL_WORKER_SECRET = saved;
  }
});

it("warns when supabaseServiceRoleKey is in file config", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await loadConfig([], { supabaseServiceRoleKey: "secret" });
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

it("warns when workerSecret is in file config", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await loadConfig([], { workerSecret: "shh" });
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- --reporter=verbose tests/config.test.ts
```

Expected: tests fail with property not found / undefined.

- [ ] **Step 3: Add fields to `src/config.ts`**

In `BrunelConfig`, add:
```ts
supabaseUrl:            string | undefined;
supabaseServiceRoleKey: string | undefined;
workerSecret:           string | undefined;
```

In the Zod schema, add:
```ts
supabaseUrl:            z.string().optional(),
supabaseServiceRoleKey: z.string().optional(),
workerSecret:           z.string().optional(),
```

In `readBrunelEnvVars`, add:
```ts
supabaseUrl:            process.env.BRUNEL_SUPABASE_URL,
supabaseServiceRoleKey: process.env.BRUNEL_SUPABASE_SERVICE_ROLE_KEY,
workerSecret:           process.env.BRUNEL_WORKER_SECRET,
```

In `parseCliFlags`, add:
```ts
"--supabase-url":             { key: "supabaseUrl" },
"--supabase-service-role-key": { key: "supabaseServiceRoleKey" },
"--worker-secret":            { key: "workerSecret" },
```

In `warnIfSecretsInFile`, add `"supabaseServiceRoleKey"` and `"workerSecret"` to the keys checked.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- --reporter=verbose tests/config.test.ts
```

Expected: all new tests pass, no existing tests broken.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add supabase and workerSecret config fields"
```

---

### Task 2: Create `src/db.ts` — Supabase logging module

**Files:**
- Create: `src/db.ts`
- Create: `tests/db.test.ts`

- [ ] **Step 1: Install Supabase JS client**

```bash
npm install @supabase/supabase-js
```

- [ ] **Step 2: Write failing tests for db.ts**

Create `tests/db.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDbLogger, createNullDbLogger } from "../src/db.js";
import type { DbLogger } from "../src/db.js";

// Minimal fake Supabase client
function makeFakeSupabase() {
  const inserts: Array<{ table: string; data: Record<string, unknown> }> = [];
  const queries: Array<{ table: string; filters: Record<string, unknown> }> = [];

  const fakeBuilder = (table: string) => ({
    insert: vi.fn().mockImplementation((data: Record<string, unknown>) => {
      inserts.push({ table, data });
      return Promise.resolve({ error: null });
    }),
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((cb: (v: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve(cb({ data: [], error: null }))
    ),
  });

  return {
    from: vi.fn().mockImplementation((t: string) => fakeBuilder(t)),
    inserts,
    queries,
  };
}

describe("createDbLogger", () => {
  it("inserts into webhook_events on logWebhookEvent", async () => {
    const supabase = makeFakeSupabase();
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);

    logger.logWebhookEvent({
      deliveryId: "abc",
      eventName: "issues",
      action: "labeled",
      repo: "owner/repo",
      sender: "alice",
      issueNumber: 42,
      prNumber: null,
      branch: null,
      taskId: "42",
      payload: { foo: "bar" },
    });

    // Fire-and-forget: give microtasks a tick to run
    await new Promise((r) => setTimeout(r, 0));
    expect(supabase.from).toHaveBeenCalledWith("webhook_events");
  });

  it("inserts into foreman_messages on logForemanMessage", async () => {
    const supabase = makeFakeSupabase();
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);

    logger.logForemanMessage({
      direction: "sent",
      workerId: "wid",
      taskId: "42",
      msgType: "task_assigned",
      payload: { type: "task_assigned" },
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(supabase.from).toHaveBeenCalledWith("foreman_messages");
  });

  it("does not throw when Supabase returns an error", async () => {
    const supabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockResolvedValue({ error: new Error("db down") }),
      }),
    };
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);
    expect(() => logger.logWebhookEvent({
      deliveryId: null, eventName: "push", action: null, repo: null,
      sender: null, issueNumber: null, prNumber: null, branch: null,
      taskId: null, payload: {},
    })).not.toThrow();
  });
});

describe("createNullDbLogger", () => {
  it("logWebhookEvent is a no-op", () => {
    const logger = createNullDbLogger();
    expect(() => logger.logWebhookEvent({
      deliveryId: null, eventName: "push", action: null, repo: null,
      sender: null, issueNumber: null, prNumber: null, branch: null,
      taskId: null, payload: {},
    })).not.toThrow();
  });

  it("logForemanMessage is a no-op", () => {
    const logger = createNullDbLogger();
    expect(() => logger.logForemanMessage({
      direction: "sent", workerId: "w1", taskId: "1",
      msgType: "standby", payload: {},
    })).not.toThrow();
  });

  it("queryLog returns empty array", async () => {
    const logger = createNullDbLogger();
    expect(await logger.queryLog({})).toEqual([]);
  });

  it("queryTaskEvents returns empty array", async () => {
    const logger = createNullDbLogger();
    expect(await logger.queryTaskEvents("1")).toEqual([]);
  });

  it("queryWorkerMessages returns empty array", async () => {
    const logger = createNullDbLogger();
    expect(await logger.queryWorkerMessages("w1")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npm test -- tests/db.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/db.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Input types ────────────────────────────────────────────────────────────────

export interface WebhookEventData {
  deliveryId: string | null;
  eventName: string;
  action: string | null;
  repo: string | null;
  sender: string | null;
  issueNumber: number | null;
  prNumber: number | null;
  branch: string | null;
  taskId: string | null;
  payload: Record<string, unknown>;
}

export interface ForemanMessageData {
  direction: "sent" | "received";
  workerId: string | null;
  taskId: string | null;
  msgType: string;
  payload: Record<string, unknown>;
}

// ── Output types ───────────────────────────────────────────────────────────────

export interface LogEntry {
  kind: "webhook" | "message";
  id: number;
  timestamp: string;
  taskId: string | null;
  workerId: string | null;
  summary: string;
}

export interface QueryLogOpts {
  limit?: number;
  taskId?: string;
  workerId?: string;
}

// ── Interface ──────────────────────────────────────────────────────────────────

export interface DbLogger {
  logWebhookEvent(data: WebhookEventData): void;
  logForemanMessage(data: ForemanMessageData): void;
  queryLog(opts: QueryLogOpts): Promise<LogEntry[]>;
  queryTaskEvents(taskId: string): Promise<LogEntry[]>;
  queryWorkerMessages(workerId: string): Promise<LogEntry[]>;
}

// ── Real implementation ────────────────────────────────────────────────────────

export function createDbLogger(supabase: SupabaseClient): DbLogger {
  function fire(promise: Promise<{ error: unknown }>) {
    promise.then(({ error }) => {
      if (error) console.error("[db] insert error:", error);
    }).catch((err: unknown) => console.error("[db] unexpected error:", err));
  }

  function webhookToEntry(row: Record<string, unknown>): LogEntry {
    const action = row.action ? `/${row.action}` : "";
    const issue = row.issue_number ? ` #${row.issue_number}` : "";
    return {
      kind: "webhook",
      id: row.id as number,
      timestamp: row.received_at as string,
      taskId: (row.task_id as string | null) ?? null,
      workerId: null,
      summary: `${row.event_name}${action}${issue}`,
    };
  }

  function messageToEntry(row: Record<string, unknown>): LogEntry {
    return {
      kind: "message",
      id: row.id as number,
      timestamp: row.created_at as string,
      taskId: (row.task_id as string | null) ?? null,
      workerId: (row.worker_id as string | null) ?? null,
      summary: `${row.direction} ${row.msg_type}`,
    };
  }

  return {
    logWebhookEvent(data) {
      fire(supabase.from("webhook_events").insert({
        delivery_id: data.deliveryId,
        event_name: data.eventName,
        action: data.action,
        repo: data.repo,
        sender: data.sender,
        issue_number: data.issueNumber,
        pr_number: data.prNumber,
        branch: data.branch,
        task_id: data.taskId,
        payload: data.payload,
      }));
    },

    logForemanMessage(data) {
      fire(supabase.from("foreman_messages").insert({
        direction: data.direction,
        worker_id: data.workerId,
        task_id: data.taskId,
        msg_type: data.msgType,
        payload: data.payload,
      }));
    },

    async queryLog(opts) {
      const limit = opts.limit ?? 100;
      const [wRes, mRes] = await Promise.all([
        supabase.from("webhook_events")
          .select("id, received_at, event_name, action, issue_number, task_id")
          .order("received_at", { ascending: false })
          .limit(limit),
        supabase.from("foreman_messages")
          .select("id, created_at, direction, worker_id, task_id, msg_type")
          .order("created_at", { ascending: false })
          .limit(limit),
      ]);
      const webhooks = ((wRes.data ?? []) as Record<string, unknown>[]).map(webhookToEntry);
      const messages = ((mRes.data ?? []) as Record<string, unknown>[]).map(messageToEntry);
      return [...webhooks, ...messages]
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, limit);
    },

    async queryTaskEvents(taskId) {
      const [wRes, mRes] = await Promise.all([
        supabase.from("webhook_events")
          .select("id, received_at, event_name, action, issue_number, task_id")
          .eq("task_id", taskId)
          .order("received_at", { ascending: true })
          .limit(500),
        supabase.from("foreman_messages")
          .select("id, created_at, direction, worker_id, task_id, msg_type")
          .eq("task_id", taskId)
          .order("created_at", { ascending: true })
          .limit(500),
      ]);
      const webhooks = ((wRes.data ?? []) as Record<string, unknown>[]).map(webhookToEntry);
      const messages = ((mRes.data ?? []) as Record<string, unknown>[]).map(messageToEntry);
      return [...webhooks, ...messages]
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    },

    async queryWorkerMessages(workerId) {
      const { data } = await supabase.from("foreman_messages")
        .select("id, created_at, direction, worker_id, task_id, msg_type")
        .eq("worker_id", workerId)
        .order("created_at", { ascending: false })
        .limit(500);
      return ((data ?? []) as Record<string, unknown>[]).map(messageToEntry);
    },
  };
}

// ── Null implementation (no Supabase configured) ───────────────────────────────

export function createNullDbLogger(): DbLogger {
  return {
    logWebhookEvent() {},
    logForemanMessage() {},
    async queryLog() { return []; },
    async queryTaskEvents() { return []; },
    async queryWorkerMessages() { return []; },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test -- tests/db.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/db.ts tests/db.test.ts package.json package-lock.json
git commit -m "feat: add db logging module with Supabase backend"
```

---

### Task 3: Supabase migrations and environment setup

**Files:**
- Create: `supabase/migrations/20260321000000_create_logging_tables.sql`
- Modify: `.env`
- Modify: `.env.test`

- [ ] **Step 1: Create migration file**

Create `supabase/migrations/20260321000000_create_logging_tables.sql`:

```sql
create table webhook_events (
  id            bigint generated always as identity primary key,
  received_at   timestamptz not null default now(),
  delivery_id   text,
  event_name    text not null,
  action        text,
  repo          text,
  sender        text,
  issue_number  int,
  pr_number     int,
  branch        text,
  task_id       text,
  payload       jsonb not null
);

create index on webhook_events (task_id);
create index on webhook_events (received_at desc);

create table foreman_messages (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  direction   text not null,
  worker_id   text,
  task_id     text,
  msg_type    text not null,
  payload     jsonb not null
);

create index on foreman_messages (task_id);
create index on foreman_messages (worker_id);
create index on foreman_messages (created_at desc);
```

- [ ] **Step 2: Add optional Supabase vars to `.env`**

Add at the end of `.env`:

```bash
# Supabase (optional — logging disabled if absent)
# For local dev: run `supabase start` and copy values from its output
# BRUNEL_SUPABASE_URL=http://localhost:54321
# BRUNEL_SUPABASE_SERVICE_ROLE_KEY=<service_role key from supabase start>
```

- [ ] **Step 3: Add optional Supabase vars to `.env.test`**

Add at the end of `.env.test` (create the file if it doesn't exist):

```bash
# .env.test — test environment config
# Copy all vars from .env, then override as needed:
# - Leave BRUNEL_SUPABASE_URL unset to skip DB logging in tests (recommended)
# - If testing DB paths, use a separate schema:
#   BRUNEL_SUPABASE_URL=http://localhost:54321
#   BRUNEL_SUPABASE_SERVICE_ROLE_KEY=<service_role key from supabase start>
```

- [ ] **Step 4: Verify `.env.local` is in `.gitignore`**

```bash
grep -q '\.env\.local' .gitignore && echo "already present" || echo "MISSING"
```

If missing, add `.env.local` to `.gitignore`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260321000000_create_logging_tables.sql .env .env.test .gitignore
git commit -m "feat: add Supabase migration and env config for logging tables"
```

---

## Chunk 2: Admin WebSocket and Foreman Integration

### Task 4: Create `src/admin-ws.ts` — admin GUI broadcaster

**Files:**
- Create: `src/admin-ws.ts`
- Create: `tests/admin-ws.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/admin-ws.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import http from "http";
import { WebSocket } from "ws";
import type { AddressInfo } from "net";
import { createAdminWss } from "../src/admin-ws.js";
import type { AdminMessage } from "../src/admin-ws.js";

function startServer(): Promise<{ server: http.Server; port: number; adminWss: ReturnType<typeof createAdminWss> }> {
  return new Promise((resolve) => {
    const server = http.createServer();
    const adminWss = createAdminWss(server);
    server.listen(0, () => {
      resolve({ server, port: (server.address() as AddressInfo).port, adminWss });
    });
  });
}

function connectAdmin(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/admin/ws`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMsg(ws: WebSocket): Promise<AdminMessage> {
  return new Promise((resolve) => {
    ws.once("message", (d) => resolve(JSON.parse(d.toString())));
  });
}

function closeAll(...ws: WebSocket[]): Promise<void> {
  return Promise.all(ws.map((w) => new Promise<void>((r) => {
    if (w.readyState === WebSocket.CLOSED) { r(); return; }
    w.once("close", r);
    w.close();
  }))).then(() => {});
}

describe("createAdminWss", () => {
  const servers: http.Server[] = [];
  afterEach(() => {
    const s = servers.splice(0);
    return Promise.all(s.map((srv) => new Promise<void>((r) => srv.close(() => r()))));
  });

  it("broadcasts snapshot to connected clients", async () => {
    const { server, port, adminWss } = await startServer();
    servers.push(server);
    const ws = await connectAdmin(port);
    const msgP = nextMsg(ws);
    adminWss.broadcastSnapshot({ tasks: [], workers: [] });
    const msg = await msgP;
    expect(msg).toEqual({ type: "snapshot", tasks: [], workers: [] });
    await closeAll(ws);
  });

  it("broadcasts log_event to connected clients", async () => {
    const { server, port, adminWss } = await startServer();
    servers.push(server);
    const ws = await connectAdmin(port);
    const msgP = nextMsg(ws);
    adminWss.broadcastLogEvent({ kind: "webhook", id: 1, timestamp: "2026-01-01T00:00:00Z", taskId: null, workerId: null, summary: "issues/labeled #1" });
    const msg = await msgP;
    expect(msg).toEqual({ type: "log_event", entry: { kind: "webhook", id: 1, timestamp: "2026-01-01T00:00:00Z", taskId: null, workerId: null, summary: "issues/labeled #1" } });
    await closeAll(ws);
  });

  it("broadcasts to multiple connected clients", async () => {
    const { server, port, adminWss } = await startServer();
    servers.push(server);
    const [ws1, ws2] = await Promise.all([connectAdmin(port), connectAdmin(port)]);
    const [p1, p2] = [nextMsg(ws1), nextMsg(ws2)];
    adminWss.broadcastSnapshot({ tasks: [], workers: [] });
    const [m1, m2] = await Promise.all([p1, p2]);
    expect(m1.type).toBe("snapshot");
    expect(m2.type).toBe("snapshot");
    await closeAll(ws1, ws2);
  });

  it("ignores requests to /worker path (does not hijack worker upgrade)", async () => {
    const { server, port } = await startServer();
    servers.push(server);
    const ws = new WebSocket(`ws://localhost:${port}/worker`);
    await new Promise<void>((resolve) => ws.once("error", () => resolve()));
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/admin-ws.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/admin-ws.ts`**

```ts
import http from "http";
import { WebSocketServer } from "ws";
import type { WebSocket as WsSocket } from "ws";
import type { LogEntry } from "./db.js";

export interface TaskSnapshot {
  taskId: string;
  issueNumber: number;
  title: string;
  status: "pending" | "assigned" | "complete";
  assignedWorkerId?: string;
}

export interface WorkerSnapshot {
  workerId: string;
  status: "idle" | "busy";
  currentTaskId?: string;
}

export interface AdminSnapshot {
  tasks: TaskSnapshot[];
  workers: WorkerSnapshot[];
}

export type AdminMessage =
  | { type: "snapshot"; tasks: TaskSnapshot[]; workers: WorkerSnapshot[] }
  | { type: "log_event"; entry: LogEntry };

export interface AdminWss {
  broadcastSnapshot(snapshot: AdminSnapshot): void;
  broadcastLogEvent(entry: LogEntry): void;
}

export function createAdminWss(server: http.Server): AdminWss {
  const clients = new Set<WsSocket>();
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/admin/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    }
    // Other paths (e.g. /worker) handled elsewhere — do not destroy socket here.
  });

  function broadcast(msg: AdminMessage) {
    const json = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === 1 /* OPEN */) ws.send(json);
    }
  }

  return {
    broadcastSnapshot(snapshot) {
      broadcast({ type: "snapshot", ...snapshot });
    },
    broadcastLogEvent(entry) {
      broadcast({ type: "log_event", entry });
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- tests/admin-ws.test.ts
```

Expected: all pass.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/admin-ws.ts tests/admin-ws.test.ts
git commit -m "feat: add admin WebSocket broadcaster"
```

---

### Task 5: Wire DB logging, admin WS, static files, and worker secret into foreman

**Files:**
- Modify: `src/foreman.ts`
- Modify: `src/types.ts`
- Modify: `tests/foreman.websocket.test.ts`

- [ ] **Step 1: Add `workerSecret` to `worker_hello` message type in `src/types.ts`**

In the `WorkerMessage` union in `src/types.ts`, add `workerSecret?: string` to the `worker_hello` variant:

```ts
// Before:
| { type: "worker_hello"; workerId: string; status: "idle" | "busy"; taskId?: string }

// After:
| { type: "worker_hello"; workerId: string; status: "idle" | "busy"; taskId?: string; workerSecret?: string }
```

- [ ] **Step 2: Write failing tests for worker secret enforcement**

Add to `tests/foreman.websocket.test.ts` (in a new `describe` block):

```ts
describe("worker secret enforcement", () => {
  it("rejects worker_hello with wrong secret when workerSecret is configured", async () => {
    // Re-create the WSS with a workerSecret
    wss.close();
    ({ wss, routeEventToWorker: routeEvent } = createForemanWss(
      queue, registry, httpServer,
      { labelDone, graph, openIssues, workerSecret: "correct-secret" },
    ));
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle", workerSecret: "wrong" });
    await new Promise<void>((resolve) => ws.once("close", resolve));
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it("accepts worker_hello with correct secret", async () => {
    wss.close();
    ({ wss, routeEventToWorker: routeEvent } = createForemanWss(
      queue, registry, httpServer,
      { labelDone, graph, openIssues, workerSecret: "correct-secret" },
    ));
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle", workerSecret: "correct-secret" });
    const msg = await nextMsg(ws);
    expect(msg.type).toBe("standby");
  });

  it("accepts any worker when workerSecret is not configured", async () => {
    // Default setup (no workerSecret) — already tested elsewhere, just assert no regression
    const ws = await connect();
    send(ws, { type: "worker_hello", workerId: "w1", status: "idle" });
    const msg = await nextMsg(ws);
    expect(msg.type).toBe("standby");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npm test -- tests/foreman.websocket.test.ts
```

Expected: new tests fail (workerSecret option not yet handled).

- [ ] **Step 4: Update `createForemanWss` options to accept `dbLogger`, `adminWss`, and `workerSecret`**

In `src/foreman.ts`, update the options type for `createForemanWss`:

```ts
import type { DbLogger } from "./db.js";
import type { AdminWss, TaskSnapshot, WorkerSnapshot } from "./admin-ws.js";

// In the options parameter:
options?: {
  taskLabel?: string;
  labelDone?: (issueNumber: number) => Promise<void>;
  graph?: DependencyGraph;
  openIssues?: Set<number>;
  repo?: string;
  token?: string;
  dbLogger?: DbLogger;      // ← new
  adminWss?: AdminWss;      // ← new
  workerSecret?: string;    // ← new
}
```

Extract them at the top of `createForemanWss`:
```ts
const dbLogger = options?.dbLogger;
const adminWss = options?.adminWss;
const workerSecret = options?.workerSecret;
```

- [ ] **Step 5: Add worker secret check to `worker_hello` handler**

In the `ws.on("message", ...)` handler, at the top of the `worker_hello` branch, before any registration logic:

```ts
if (msg.type === "worker_hello") {
  if (workerSecret && msg.workerSecret !== workerSecret) {
    ws.close(4001, "unauthorized");
    return;
  }
  // ... rest of existing hello logic unchanged
}
```

- [ ] **Step 6: Add `broadcastSnapshot` helper and call it after state changes**

First, add `getTaskSnapshots()` and `getWorkerSnapshots()` accessor methods to the `TaskQueue` and `WorkerRegistry` classes (they currently use private `Map` fields):

Add to `TaskQueue`:
```ts
getTaskSnapshots(): TaskSnapshot[] {
  return [...this.tasks.values()].map((t) => ({
    taskId: t.taskId, issueNumber: t.issueNumber, title: t.title,
    status: t.status, assignedWorkerId: t.assignedWorkerId,
  }));
}
```

Add to `WorkerRegistry`:
```ts
getWorkerSnapshots(): WorkerSnapshot[] {
  return [...this.workers.values()].map((w) => ({
    workerId: w.workerId, status: w.status, currentTaskId: w.currentTaskId,
  }));
}
```

Then add this helper inside `createForemanWss`:
```ts
function broadcastSnapshot() {
  if (!adminWss) return;
  adminWss.broadcastSnapshot({
    tasks: taskQueue.getTaskSnapshots(),
    workers: registry.getWorkerSnapshots(),
  });
}
```

Call `broadcastSnapshot()` after each state-changing operation: worker registration (`worker_hello` handled), worker release (`task_complete` handled), task enqueue (after `taskQueue.addTask`), task assignment (after `tryAssignWork` assigns), task completion.

- [ ] **Step 7: Add DB logging calls**

In `routeEvent`, after routing a webhook, log it:

```ts
const webhookData: WebhookEventData = {
  deliveryId: id,
  eventName: name,
  action: typeof p.action === "string" ? p.action : null,
  repo: (p.repository as Record<string, unknown> | undefined)?.full_name as string ?? null,
  sender: (p.sender as Record<string, unknown> | undefined)?.login as string ?? null,
  issueNumber: issueNumber,
  prNumber: typeof (p.pull_request as Record<string, unknown> | undefined)?.number === "number"
    ? (p.pull_request as Record<string, unknown>).number as number : null,
  branch: null,
  taskId: task?.taskId ?? null,
  payload: p,
};
dbLogger?.logWebhookEvent(webhookData);

// Broadcast a LogEntry to the GUI immediately (no DB id available; use 0 as sentinel)
adminWss?.broadcastLogEvent({
  kind: "webhook",
  id: 0,
  timestamp: new Date().toISOString(),
  taskId: webhookData.taskId,
  workerId: null,
  summary: `${name}${webhookData.action ? `/${webhookData.action}` : ""}${issueNumber ? ` #${issueNumber}` : ""}`,
});
```

In `registry.send`, wrap the existing send to also log outbound messages. The cleanest approach: add an `onSend` callback to `WorkerRegistry` or log in `createForemanWss` at the call sites for `registry.send`. Choose call-site logging in `createForemanWss` since that's where the message context is known.

After each `registry.send(workerId, msg)` call, add:
```ts
dbLogger?.logForemanMessage({ direction: "sent", workerId, taskId: (msg as {taskId?: string}).taskId ?? null, msgType: msg.type, payload: msg as unknown as Record<string, unknown> });
```

In the `ws.on("message", ...)` handler, after parsing `msg`, add:
```ts
dbLogger?.logForemanMessage({ direction: "received", workerId: workerId || (msg as {workerId?: string}).workerId ?? null, taskId: (msg as {taskId?: string}).taskId ?? null, msgType: msg.type, payload: msg as unknown as Record<string, unknown> });
```

- [ ] **Step 8: Add REST API routes and static file serving to `createHttpServer`**

Update `createHttpServer` to accept `dbLogger` and add routes:

```ts
function createHttpServer(
  webhooks: InstanceType<typeof Webhooks> | null,
  routeEvent: (id: string, name: string, payload: unknown) => void,
  dbLogger?: DbLogger,
): http.Server {
  return http.createServer(async (req, res) => {
    // ... existing /webhook and / handlers unchanged ...

    // ── REST API ──────────────────────────────────────────────────────────────
    if (req.method === "GET" && req.url?.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json");
      try {
        if (req.url === "/api/log" || req.url?.startsWith("/api/log?")) {
          const entries = dbLogger ? await dbLogger.queryLog({ limit: 100 }) : [];
          res.writeHead(200); res.end(JSON.stringify(entries)); return;
        }
        const taskMatch = /^\/api\/tasks\/([^/]+)\/events$/.exec(req.url ?? "");
        if (taskMatch) {
          const entries = dbLogger ? await dbLogger.queryTaskEvents(taskMatch[1]) : [];
          res.writeHead(200); res.end(JSON.stringify(entries)); return;
        }
        const workerMatch = /^\/api\/workers\/([^/]+)\/messages$/.exec(req.url ?? "");
        if (workerMatch) {
          const entries = dbLogger ? await dbLogger.queryWorkerMessages(workerMatch[1]) : [];
          res.writeHead(200); res.end(JSON.stringify(entries)); return;
        }
      } catch (err) {
        flog(`ERROR API query failed: ${err}`);
        res.writeHead(500); res.end(JSON.stringify({ error: "internal error" })); return;
      }
    }

    // ── Static files (React SPA) ──────────────────────────────────────────────
    // Serve dist/ for all other routes. Falls back to index.html for SPA routing.
    // Only active when dist/ exists (production build); in dev, Vite serves the frontend.
    const { createReadStream, existsSync } = await import("fs");
    const { join, extname } = await import("path");
    const { fileURLToPath } = await import("url");
    const root = join(fileURLToPath(import.meta.url), "../../dist");

    if (existsSync(root)) {
      const safePath = (req.url ?? "/").split("?")[0];
      const filePath = join(root, safePath);
      const target = existsSync(filePath) && !safePath.endsWith("/")
        ? filePath : join(root, "index.html");
      const mime: Record<string, string> = {
        ".html": "text/html", ".js": "application/javascript",
        ".css": "text/css", ".svg": "image/svg+xml", ".ico": "image/x-icon",
      };
      res.writeHead(200, { "Content-Type": mime[extname(target)] ?? "application/octet-stream" });
      createReadStream(target).pipe(res);
      return;
    }

    res.writeHead(404); res.end("Not Found");
  });
}
```

- [ ] **Step 9: Update `isMain` block to wire everything together**

In the `isMain` block at the bottom of `foreman.ts`:

```ts
if (isMain) {
  const config = await loadConfig(process.argv);
  // ... existing registry, taskQueue, graph, openIssues, webhooks setup ...

  // DB logger
  let dbLogger: DbLogger;
  if (config.supabaseUrl && config.supabaseServiceRoleKey) {
    const { createClient } = await import("@supabase/supabase-js");
    const { createDbLogger } = await import("./db.js");
    dbLogger = createDbLogger(createClient(config.supabaseUrl, config.supabaseServiceRoleKey));
    flog("Supabase logging enabled");
  } else {
    const { createNullDbLogger } = await import("./db.js");
    dbLogger = createNullDbLogger();
  }

  let routeEvent: (id: string, name: string, payload: unknown) => void = () => {};
  const server = createHttpServer(webhooks, (id, name, payload) => routeEvent(id, name, payload), dbLogger);

  // Admin WebSocket
  const { createAdminWss } = await import("./admin-ws.js");
  const adminWss = createAdminWss(server);

  ({ routeEventToWorker: routeEvent } = createForemanWss(taskQueue, registry, server, {
    graph, openIssues,
    dbLogger,
    adminWss,
    workerSecret: config.workerSecret,
  }));

  // ... rest of isMain unchanged ...
}
```

- [ ] **Step 10: Run tests to verify they pass**

```bash
npm test
```

Expected: all tests pass, including new worker secret tests.

- [ ] **Step 11: Type check**

```bash
npx tsc --noEmit
```

Expected: no type errors.

- [ ] **Step 12: Commit**

```bash
git add src/foreman.ts src/types.ts src/admin-ws.ts tests/foreman.websocket.test.ts
git commit -m "feat: wire DB logging, admin WebSocket, static file serving, and worker secret into foreman"
```

---

## Chunk 3: Frontend and Railway Deployment

### Task 6: Set up frontend project

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/index.html`
- Create: `frontend/vite.config.ts`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/types.ts`
- Modify: `package.json` (root)

- [ ] **Step 1: Create `frontend/package.json`**

```json
{
  "name": "brunel-frontend",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.6.2",
    "vite": "^6.0.5"
  }
}
```

- [ ] **Step 2: Install frontend dependencies**

```bash
cd frontend && npm install
```

- [ ] **Step 3: Create `frontend/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Brunel</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Create `frontend/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/admin/ws": {
        target: "ws://localhost:3000",
        ws: true,
      },
    },
  },
});
```

- [ ] **Step 5: Create `frontend/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true
  },
  "include": ["src"]
}
```

- [ ] **Step 6: Create shared types in `frontend/src/types.ts`**

```ts
export interface TaskSnapshot {
  taskId: string;
  issueNumber: number;
  title: string;
  status: "pending" | "assigned" | "complete";
  assignedWorkerId?: string;
}

export interface WorkerSnapshot {
  workerId: string;
  status: "idle" | "busy";
  currentTaskId?: string;
}

export interface LogEntry {
  kind: "webhook" | "message";
  id: number;
  timestamp: string;
  taskId: string | null;
  workerId: string | null;
  summary: string;
}

export type AdminMessage =
  | { type: "snapshot"; tasks: TaskSnapshot[]; workers: WorkerSnapshot[] }
  | { type: "log_event"; entry: LogEntry };
```

- [ ] **Step 7: Create `frontend/src/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
```

- [ ] **Step 8: Create `frontend/src/App.tsx`** (routing shell)

```tsx
import { Routes, Route, NavLink } from "react-router-dom";
import Dashboard from "./pages/Dashboard.tsx";
import EventLog from "./pages/EventLog.tsx";
import TaskDetail from "./pages/TaskDetail.tsx";
import WorkerDetail from "./pages/WorkerDetail.tsx";

export default function App() {
  return (
    <div style={{ fontFamily: "monospace", padding: "1rem", maxWidth: "1200px", margin: "0 auto" }}>
      <header style={{ marginBottom: "1rem", borderBottom: "1px solid #ccc", paddingBottom: "0.5rem" }}>
        <strong>Brunel</strong>
        {" · "}
        <NavLink to="/">Dashboard</NavLink>
        {" · "}
        <NavLink to="/log">Event Log</NavLink>
      </header>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/log" element={<EventLog />} />
        <Route path="/tasks/:id" element={<TaskDetail />} />
        <Route path="/workers/:id" element={<WorkerDetail />} />
      </Routes>
    </div>
  );
}
```

- [ ] **Step 9: Update root `package.json` to add build script**

```json
"build": "cd frontend && npm install && npm run build"
```

Add to the existing `"scripts"` block. The `npm install` ensures Railway installs frontend dependencies during deploy (Railway only runs `npm install` at the root level before running the build command).

- [ ] **Step 10: Verify frontend builds**

```bash
npm run build
```

Expected: `dist/` created with `index.html` and JS assets.

- [ ] **Step 11: Commit**

First, add `/dist` to `.gitignore` (built assets must not be committed — Railway builds at deploy time):

```bash
echo '/dist' >> .gitignore
```

Then commit:

```bash
git add frontend/ package.json .gitignore
git commit -m "feat: scaffold Vite+React frontend project"
```

---

### Task 7: Implement `useAdminWs` hook

**Files:**
- Create: `frontend/src/hooks/useAdminWs.ts`

- [ ] **Step 1: Implement the hook**

Create `frontend/src/hooks/useAdminWs.ts`:

```ts
import { useEffect, useRef, useCallback } from "react";
import type { AdminMessage } from "../types.ts";

export function useAdminWs(onMessage: (msg: AdminMessage) => void) {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const reconnectDelay = useRef(1000);
  const stopped = useRef(false);

  const connect = useCallback(() => {
    if (stopped.current) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/admin/ws`);

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data) as AdminMessage;
        onMessageRef.current(msg);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onopen = () => {
      reconnectDelay.current = 1000;
    };

    ws.onclose = () => {
      if (!stopped.current) {
        setTimeout(connect, reconnectDelay.current);
        reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30000);
      }
    };

    return ws;
  }, []);

  useEffect(() => {
    stopped.current = false;
    const ws = connect();
    return () => {
      stopped.current = true;
      ws?.close();
    };
  }, [connect]);
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/hooks/useAdminWs.ts
git commit -m "feat: add useAdminWs hook for real-time admin WebSocket"
```

---

### Task 8: Dashboard page

**Files:**
- Create: `frontend/src/pages/Dashboard.tsx`

- [ ] **Step 1: Implement `Dashboard.tsx`**

```tsx
import { useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { useAdminWs } from "../hooks/useAdminWs.ts";
import type { TaskSnapshot, WorkerSnapshot, LogEntry, AdminMessage } from "../types.ts";

export default function Dashboard() {
  const [tasks, setTasks] = useState<TaskSnapshot[]>([]);
  const [workers, setWorkers] = useState<WorkerSnapshot[]>([]);
  const [recentLog, setRecentLog] = useState<LogEntry[]>([]);

  const handleMessage = useCallback((msg: AdminMessage) => {
    if (msg.type === "snapshot") {
      setTasks(msg.tasks);
      setWorkers(msg.workers);
    } else if (msg.type === "log_event") {
      setRecentLog((prev) => [msg.entry, ...prev].slice(0, 50));
    }
  }, []);

  useAdminWs(handleMessage);

  const pending = tasks.filter((t) => t.status === "pending").length;
  const assigned = tasks.filter((t) => t.status === "assigned").length;
  const done = tasks.filter((t) => t.status === "complete").length;

  return (
    <div>
      <h2>Dashboard</h2>

      <section>
        <h3>Tasks ({pending} pending · {assigned} assigned · {done} done)</h3>
        {tasks.length === 0 ? <p>No tasks.</p> : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Issue</th>
                <th style={th}>Title</th>
                <th style={th}>Status</th>
                <th style={th}>Worker</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.taskId}>
                  <td style={td}><Link to={`/tasks/${t.taskId}`}>#{t.issueNumber}</Link></td>
                  <td style={td}>{t.title}</td>
                  <td style={td}>{t.status}</td>
                  <td style={td}>{t.assignedWorkerId
                    ? <Link to={`/workers/${t.assignedWorkerId}`}>{t.assignedWorkerId.slice(0, 8)}</Link>
                    : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h3>Workers ({workers.filter((w) => w.status === "idle").length} idle · {workers.filter((w) => w.status === "busy").length} busy)</h3>
        {workers.length === 0 ? <p>No workers connected.</p> : (
          <ul>
            {workers.map((w) => (
              <li key={w.workerId}>
                <Link to={`/workers/${w.workerId}`}>{w.workerId.slice(0, 8)}</Link>
                {" — "}{w.status}
                {w.currentTaskId && <> working on <Link to={`/tasks/${w.currentTaskId}`}>#{w.currentTaskId}</Link></>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h3>Recent Events</h3>
        {recentLog.length === 0 ? <p>No events yet.</p> : (
          <LogTable entries={recentLog} />
        )}
      </section>
    </div>
  );
}

function LogTable({ entries }: { entries: LogEntry[] }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace", fontSize: "0.85em" }}>
      <thead>
        <tr>
          <th style={th}>Time</th>
          <th style={th}>Kind</th>
          <th style={th}>Summary</th>
          <th style={th}>Task</th>
          <th style={th}>Worker</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={`${e.kind}-${e.id}`}>
            <td style={td}>{new Date(e.timestamp).toLocaleTimeString()}</td>
            <td style={td}>{e.kind}</td>
            <td style={td}>{e.summary}</td>
            <td style={td}>{e.taskId ? <Link to={`/tasks/${e.taskId}`}>#{e.taskId}</Link> : "—"}</td>
            <td style={td}>{e.workerId ? <Link to={`/workers/${e.workerId}`}>{e.workerId.slice(0, 8)}</Link> : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const th: React.CSSProperties = { textAlign: "left", borderBottom: "1px solid #ccc", padding: "4px 8px" };
const td: React.CSSProperties = { padding: "4px 8px", borderBottom: "1px solid #eee" };
```

- [ ] **Step 2: Verify it builds**

```bash
npm run build
```

Expected: no TypeScript or build errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Dashboard.tsx
git commit -m "feat: add Dashboard page with task queue, workers, and live event feed"
```

---

### Task 9: Event Log, Task Detail, and Worker Detail pages

**Files:**
- Create: `frontend/src/pages/EventLog.tsx`
- Create: `frontend/src/pages/TaskDetail.tsx`
- Create: `frontend/src/pages/WorkerDetail.tsx`

- [ ] **Step 1: Implement `EventLog.tsx`**

```tsx
import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useAdminWs } from "../hooks/useAdminWs.ts";
import type { LogEntry, AdminMessage } from "../types.ts";

export default function EventLog() {
  const [entries, setEntries] = useState<LogEntry[]>([]);

  useEffect(() => {
    fetch("/api/log")
      .then((r) => r.json() as Promise<LogEntry[]>)
      .then(setEntries)
      .catch(console.error);
  }, []);

  const handleMessage = useCallback((msg: AdminMessage) => {
    if (msg.type === "log_event") {
      setEntries((prev) => [msg.entry, ...prev]);
    }
  }, []);

  useAdminWs(handleMessage);

  return (
    <div>
      <h2>Event Log</h2>
      {entries.length === 0 ? <p>No events.</p> : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace", fontSize: "0.85em" }}>
          <thead>
            <tr>
              <th style={th}>Time</th>
              <th style={th}>Kind</th>
              <th style={th}>Summary</th>
              <th style={th}>Task</th>
              <th style={th}>Worker</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={`${e.kind}-${e.id}`}>
                <td style={td}>{new Date(e.timestamp).toLocaleString()}</td>
                <td style={td}>{e.kind}</td>
                <td style={td}>{e.summary}</td>
                <td style={td}>{e.taskId ? <Link to={`/tasks/${e.taskId}`}>#{e.taskId}</Link> : "—"}</td>
                <td style={td}>{e.workerId ? <Link to={`/workers/${e.workerId}`}>{e.workerId.slice(0, 8)}</Link> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const th: React.CSSProperties = { textAlign: "left", borderBottom: "1px solid #ccc", padding: "4px 8px" };
const td: React.CSSProperties = { padding: "4px 8px", borderBottom: "1px solid #eee" };
```

- [ ] **Step 2: Implement `TaskDetail.tsx`**

```tsx
import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { useAdminWs } from "../hooks/useAdminWs.ts";
import type { LogEntry, AdminMessage } from "../types.ts";

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const [events, setEvents] = useState<LogEntry[]>([]);

  useEffect(() => {
    fetch(`/api/tasks/${id}/events`)
      .then((r) => r.json() as Promise<LogEntry[]>)
      .then(setEvents)
      .catch(console.error);
  }, [id]);

  const handleMessage = useCallback((msg: AdminMessage) => {
    if (msg.type === "log_event" && msg.entry.taskId === id) {
      setEvents((prev) => [...prev, msg.entry]);
    }
  }, [id]);

  useAdminWs(handleMessage);

  return (
    <div>
      <h2>Task #{id}</h2>
      <p><Link to="/">← Dashboard</Link></p>
      {events.length === 0 ? <p>No events for this task.</p> : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace", fontSize: "0.85em" }}>
          <thead>
            <tr>
              <th style={th}>Time</th>
              <th style={th}>Kind</th>
              <th style={th}>Summary</th>
              <th style={th}>Worker</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={`${e.kind}-${e.id}`}>
                <td style={td}>{new Date(e.timestamp).toLocaleString()}</td>
                <td style={td}>{e.kind}</td>
                <td style={td}>{e.summary}</td>
                <td style={td}>{e.workerId ? <Link to={`/workers/${e.workerId}`}>{e.workerId.slice(0, 8)}</Link> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const th: React.CSSProperties = { textAlign: "left", borderBottom: "1px solid #ccc", padding: "4px 8px" };
const td: React.CSSProperties = { padding: "4px 8px", borderBottom: "1px solid #eee" };
```

- [ ] **Step 3: Implement `WorkerDetail.tsx`**

```tsx
import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { useAdminWs } from "../hooks/useAdminWs.ts";
import type { LogEntry, AdminMessage } from "../types.ts";

export default function WorkerDetail() {
  const { id } = useParams<{ id: string }>();
  const [messages, setMessages] = useState<LogEntry[]>([]);

  useEffect(() => {
    fetch(`/api/workers/${id}/messages`)
      .then((r) => r.json() as Promise<LogEntry[]>)
      .then(setMessages)
      .catch(console.error);
  }, [id]);

  const handleMessage = useCallback((msg: AdminMessage) => {
    if (msg.type === "log_event" && msg.entry.workerId === id) {
      setMessages((prev) => [msg.entry, ...prev]);
    }
  }, [id]);

  useAdminWs(handleMessage);

  return (
    <div>
      <h2>Worker {id?.slice(0, 8)}</h2>
      <p><Link to="/">← Dashboard</Link></p>
      {messages.length === 0 ? <p>No messages for this worker.</p> : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace", fontSize: "0.85em" }}>
          <thead>
            <tr>
              <th style={th}>Time</th>
              <th style={th}>Direction</th>
              <th style={th}>Type</th>
              <th style={th}>Task</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((e) => (
              <tr key={`${e.kind}-${e.id}`}>
                <td style={td}>{new Date(e.timestamp).toLocaleString()}</td>
                <td style={td}>{e.summary.split(" ")[0]}</td>
                <td style={td}>{e.summary.split(" ").slice(1).join(" ")}</td>
                <td style={td}>{e.taskId ? <Link to={`/tasks/${e.taskId}`}>#{e.taskId}</Link> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const th: React.CSSProperties = { textAlign: "left", borderBottom: "1px solid #ccc", padding: "4px 8px" };
const td: React.CSSProperties = { padding: "4px 8px", borderBottom: "1px solid #eee" };
```

- [ ] **Step 4: Verify it all builds**

```bash
npm run build
```

Expected: clean build, no TypeScript errors.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/
git commit -m "feat: add Event Log, Task Detail, and Worker Detail pages"
```

---

### Task 10: Railway deployment configuration

**Files:**
- Create: `railway.json` (or `Procfile`)
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Ensure `/dist` is gitignored**

In `.gitignore`, add:
```
/dist
```

- [ ] **Step 2: Confirm root `package.json` has the correct start and build scripts**

Railway runs `npm run build` (if present) then `npm start`. The root `package.json` `"scripts"` should have exactly:
```json
"build": "cd frontend && npm install && npm run build",
"start": "tsx src/foreman.ts"
```

Both were set in prior tasks. Verify no drift:

```bash
node -e "const p = JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log(p.scripts.build, p.scripts.start)"
```

Expected: `cd frontend && npm install && npm run build  tsx src/foreman.ts`

- [ ] **Step 3: Create Railway config file**

Create `railway.json`:
```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "npm start",
    "healthcheckPath": "/",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

- [ ] **Step 4: Verify all required env vars are documented**

Ensure `.env` lists all vars workers and admins will need to configure, with comments:

```bash
# Required
BRUNEL_GITHUB_REPO=owner/repo
BRUNEL_GITHUB_TOKEN=ghp_...
BRUNEL_WEBHOOK_SECRET=<random string, must match GitHub repo webhook secret>

# Optional
BRUNEL_SUPABASE_URL=...
BRUNEL_SUPABASE_SERVICE_ROLE_KEY=...
BRUNEL_WORKER_SECRET=...
```

- [ ] **Step 5: Run smoke test**

```bash
npm run smoke
```

Expected: foreman and worker connect successfully.

- [ ] **Step 6: Commit**

```bash
git add railway.json .gitignore package.json .env
git commit -m "feat: add Railway deployment config and finalize env documentation"
```

---

## Deployment Checklist (manual steps)

After all code is merged to `main`:

- [ ] Create Railway project, connect to GitHub repo
- [ ] Set Railway env vars: `BRUNEL_GITHUB_REPO`, `BRUNEL_GITHUB_TOKEN`, `BRUNEL_WEBHOOK_SECRET`, `BRUNEL_SUPABASE_URL`, `BRUNEL_SUPABASE_SERVICE_ROLE_KEY`, and optionally `BRUNEL_WORKER_SECRET`
- [ ] Create Supabase project, run migrations (`supabase db push` or apply via dashboard)
- [ ] Update GitHub repo webhook URL to `https://<railway-url>/webhook`, set secret to match `BRUNEL_WEBHOOK_SECRET`
- [ ] Confirm foreman starts and responds at `https://<railway-url>/`
- [ ] Update worker `.env` files: `BRUNEL_FOREMAN_URL=wss://<railway-url>`
- [ ] Run a worker and verify it connects and receives tasks
