/**
 * Tests for the HTTP routes in createHttpServer.
 *
 * Verifies that Hono routing correctly handles:
 * - POST /webhook: GitHub webhook ingestion
 * - GET /: health check
 * - GET /api/log: log query
 * - GET /api/tasks/:id/events: task events query
 * - GET /api/workers/:id/messages: worker messages query
 * - 404 fallback when no static dist/ exists
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import { createHttpServer } from "../src/foreman/http-server.js";
import { TaskModel } from "../src/foreman/task-model.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function startServer(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function request(
  port: number,
  method: string,
  path: string,
  options: { body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string; contentType: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "localhost", port, method, path, headers: options.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            contentType: res.headers["content-type"],
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── Test harness ───────────────────────────────────────────────────────────────

let server: http.Server;
let port: number;
let routeEvent: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  routeEvent = vi.fn();
  server = createHttpServer(null, routeEvent);
  port = await startServer(server);
});

afterEach(async () => {
  await stopServer(server);
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("POST /webhook", () => {
  it("returns 400 when x-github-event header is missing", async () => {
    const res = await request(port, "POST", "/webhook", {
      body: JSON.stringify({ action: "labeled" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 200 and calls routeEvent when x-github-event is present (no webhooks secret)", async () => {
    const payload = { action: "labeled", issue: { number: 1 } };
    const res = await request(port, "POST", "/webhook", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-github-delivery": "abc123",
      },
    });
    expect(res.status).toBe(200);
    expect(routeEvent).toHaveBeenCalledOnce();
    expect(routeEvent).toHaveBeenCalledWith("abc123", "issues", payload);
  });

  it("uses 'unknown' as delivery id when header is absent", async () => {
    const payload = { action: "opened" };
    await request(port, "POST", "/webhook", {
      body: JSON.stringify(payload),
      headers: { "x-github-event": "issues" },
    });
    expect(routeEvent).toHaveBeenCalledWith("unknown", "issues", payload);
  });
});

describe("GET /health", () => {
  it("returns 200 with a text/plain response", async () => {
    const res = await request(port, "GET", "/health");
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/plain/);
  });
});

describe("GET /api/log", () => {
  it("returns 200 with an empty JSON array when no dbLogger is provided", async () => {
    const res = await request(port, "GET", "/api/log");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("returns log entries from dbLogger", async () => {
    const entries = [{ id: 1, summary: "test" }];
    const dbLogger = { queryLog: vi.fn().mockResolvedValue(entries) } as never;
    const s = createHttpServer(null, vi.fn(), dbLogger);
    const p = await startServer(s);
    try {
      const res = await request(p, "GET", "/api/log");
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual(entries);
    } finally {
      await stopServer(s);
    }
  });
});

describe("GET /api/tasks/:id/events", () => {
  it("returns 200 with an empty JSON array when no dbLogger is provided", async () => {
    const res = await request(port, "GET", "/api/tasks/42/events");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("returns task events from dbLogger", async () => {
    const entries = [{ id: 1, taskId: "42" }];
    const dbLogger = { queryTaskEvents: vi.fn().mockResolvedValue(entries) } as never;
    const s = createHttpServer(null, vi.fn(), dbLogger);
    const p = await startServer(s);
    try {
      const res = await request(p, "GET", "/api/tasks/42/events");
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual(entries);
      expect(dbLogger.queryTaskEvents).toHaveBeenCalledWith("42");
    } finally {
      await stopServer(s);
    }
  });
});

describe("GET /api/workers/:id/messages", () => {
  it("returns 200 with an empty JSON array when no dbLogger is provided", async () => {
    const res = await request(port, "GET", "/api/workers/w1/messages");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("returns worker messages from dbLogger", async () => {
    const entries = [{ id: 1, workerId: "w1" }];
    const dbLogger = { queryWorkerMessages: vi.fn().mockResolvedValue(entries) } as never;
    const s = createHttpServer(null, vi.fn(), dbLogger);
    const p = await startServer(s);
    try {
      const res = await request(p, "GET", "/api/workers/w1/messages");
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual(entries);
      expect(dbLogger.queryWorkerMessages).toHaveBeenCalledWith("w1");
    } finally {
      await stopServer(s);
    }
  });
});

describe("GET /api/tasks", () => {
  it("returns 200 with an empty JSON array when no taskModel is provided", async () => {
    const res = await request(port, "GET", "/api/tasks");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("returns task list from taskModel", async () => {
    const tasks = [{ taskId: "42", issueNumber: 42, title: "Fix bug", status: "complete" }];
    const store = { listTasks: vi.fn().mockResolvedValue(tasks) } as never;
    const tm = new TaskModel(store);
    const s = createHttpServer(null, vi.fn(), undefined, tm);
    const p = await startServer(s);
    try {
      const res = await request(p, "GET", "/api/tasks");
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual(tasks);
      expect(store.listTasks).toHaveBeenCalled();
    } finally {
      await stopServer(s);
    }
  });

  it("filters tasks by status in memory", async () => {
    const row1 = {
      taskId: "1", issueNumber: 1, repo: "test/repo", title: "T1",
      body: "b", labels: [],
      workerId: null, assignedAt: null, completedAt: new Date().toISOString(), issueClosedAt: null, prMergedAt: null,
      prNumber: null, branch: null, createdAt: new Date().toISOString(),
    };
    const row2 = {
      taskId: "2", issueNumber: 2, repo: "test/repo", title: "T2",
      body: "b", labels: [],
      workerId: null, assignedAt: null, completedAt: null, issueClosedAt: null, prMergedAt: null,
      prNumber: null, branch: null, createdAt: new Date().toISOString(),
    };
    const store = { listTasks: vi.fn().mockResolvedValue([row1, row2]) } as never;
    const tm = new TaskModel(store);
    const s = createHttpServer(null, vi.fn(), undefined, tm);
    const p = await startServer(s);
    try {
      const res = await request(p, "GET", "/api/tasks?status=complete");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveLength(1);
      expect(body[0].taskId).toBe("1");
      expect(body[0].status).toBe("complete");
    } finally {
      await stopServer(s);
    }
  });
});

describe("404 fallback", () => {
  it("returns 404 for unknown routes when no static dist/ exists", async () => {
    const res = await request(port, "GET", "/nonexistent-route");
    expect(res.status).toBe(404);
  });
});
