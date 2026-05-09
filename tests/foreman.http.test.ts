/**
 * Tests for the HTTP routes in new HttpServer.
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
import { Webhooks } from "@octokit/webhooks";
import { HttpServer } from "../src/foreman/http-server.js";
import { Task } from "../src/foreman/models/task.js";
import { resetDb, createTestTaskManager, createTestRepo, seedRepoWithInstallation } from "./helpers/task.js";

vi.mock("../src/foreman/models/activity-log.js", () => ({
  queryActivityLog: vi.fn().mockResolvedValue([]),
}));

import { queryActivityLog } from "../src/foreman/models/activity-log.js";

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

/** Create a test HttpServer with a Webhooks instance and an onAny spy. */
function makeTestServer(): { webhooks: InstanceType<typeof Webhooks>; handler: ReturnType<typeof vi.fn>; server: http.Server } {
  const webhooks = new Webhooks({ secret: "test-secret" });
  const handler = vi.fn();
  webhooks.onAny(({ id, name, payload }) => {
    handler(id, name as string, payload);
  });
  const server = new HttpServer({ webhooks, verifySignature: false }).server;
  return { webhooks, handler, server };
}

// ── Test harness ───────────────────────────────────────────────────────────────

let server: http.Server;
let port: number;
let handler: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.mocked(queryActivityLog).mockResolvedValue([]);
  ({ server, handler } = makeTestServer());
  port = await startServer(server);
});

afterEach(async () => {
  vi.restoreAllMocks();
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

  it("returns 200 and dispatches to webhook registry when x-github-event is present (no signature required)", async () => {
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
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith("abc123", "issues", payload);
  });

  it("uses 'unknown' as delivery id when header is absent", async () => {
    const payload = { action: "opened" };
    await request(port, "POST", "/webhook", {
      body: JSON.stringify(payload),
      headers: { "x-github-event": "issues" },
    });
    expect(handler).toHaveBeenCalledWith("unknown", "issues", payload);
  });

  it("requires signature when verifySignature=true and returns 401 if missing", async () => {
    const webhooks = new Webhooks({ secret: "mysecret" });
    const s = new HttpServer({ webhooks, verifySignature: true }).server;
    const p = await startServer(s);
    try {
      const res = await request(p, "POST", "/webhook", {
        body: JSON.stringify({ action: "labeled" }),
        headers: { "x-github-event": "issues" },
      });
      expect(res.status).toBe(401);
    } finally {
      await stopServer(s);
    }
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
  it("returns 200 with an empty JSON array when queryActivityLog returns empty", async () => {
    const res = await request(port, "GET", "/api/log");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("returns log entries from queryActivityLog with default limit", async () => {
    const entries = [{ id: 1, summary: "test" }];
    vi.mocked(queryActivityLog).mockResolvedValue(entries as never);
    const res = await request(port, "GET", "/api/log");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(entries);
    expect(queryActivityLog).toHaveBeenCalledWith({ limit: 50 });
  });

  it("passes before cursor to queryActivityLog when provided", async () => {
    const before = "2024-06-01T12:00:00.000Z";
    vi.mocked(queryActivityLog).mockResolvedValue([]);
    const res = await request(port, "GET", `/api/log?before=${encodeURIComponent(before)}`);
    expect(res.status).toBe(200);
    expect(queryActivityLog).toHaveBeenCalledWith({ limit: 50, before });
  });
});

describe("GET /api/tasks/:id", () => {
  it("returns 404 when task does not exist", async () => {
    resetDb();
    const { server: s } = makeTestServer();
    const p = await startServer(s);
    try {
      const res = await request(p, "GET", "/api/tasks/nonexistent");
      expect(res.status).toBe(404);
    } finally {
      await stopServer(s);
    }
  });

  it("returns 200 with task data including stats for a completed task", async () => {
    resetDb();
    await createTestTaskManager();

    const t = await Task.upsert("http-t1", 9901, "test/repo", "Fix bug", "body", []);
    await t.complete({ inputTokens: 1000, outputTokens: 500, costUsd: 0.05 });

    const { server: s } = makeTestServer();
    const p = await startServer(s);
    try {
      const res = await request(p, "GET", "/api/tasks/http-t1");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        taskId: "http-t1",
        status: "complete",
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 0.05,
      });
    } finally {
      vi.restoreAllMocks();
      await stopServer(s);
    }
  });
});

describe("GET /api/tasks/:id/events", () => {
  it("returns 200 with an empty JSON array when queryActivityLog returns empty", async () => {
    const res = await request(port, "GET", "/api/tasks/42/events");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("returns task events from queryActivityLog with limit 50", async () => {
    const entries = [{ id: 1, taskId: "42" }];
    vi.mocked(queryActivityLog).mockResolvedValue(entries as never);
    const res = await request(port, "GET", "/api/tasks/42/events");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(entries);
    expect(queryActivityLog).toHaveBeenCalledWith({ taskId: "42", limit: 50 });
  });

  it("passes before cursor to queryActivityLog for task events when provided", async () => {
    const before = "2024-06-01T12:00:00.000Z";
    vi.mocked(queryActivityLog).mockResolvedValue([]);
    const res = await request(port, "GET", `/api/tasks/42/events?before=${encodeURIComponent(before)}`);
    expect(res.status).toBe(200);
    expect(queryActivityLog).toHaveBeenCalledWith({ taskId: "42", limit: 50, before });
  });
});

describe("GET /api/workers/:id/messages", () => {
  it("returns 200 with an empty JSON array when queryActivityLog returns empty", async () => {
    const res = await request(port, "GET", "/api/workers/w1/messages");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("returns worker messages from queryActivityLog with limit 50", async () => {
    const entries = [{ id: 1, workerId: "w1" }];
    vi.mocked(queryActivityLog).mockResolvedValue(entries as never);
    const res = await request(port, "GET", "/api/workers/w1/messages");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(entries);
    expect(queryActivityLog).toHaveBeenCalledWith({ workerId: "w1", limit: 50 });
  });

  it("passes before cursor to queryActivityLog for worker messages when provided", async () => {
    const before = "2024-06-01T12:00:00.000Z";
    vi.mocked(queryActivityLog).mockResolvedValue([]);
    const res = await request(port, "GET", `/api/workers/w1/messages?before=${encodeURIComponent(before)}`);
    expect(res.status).toBe(200);
    expect(queryActivityLog).toHaveBeenCalledWith({ workerId: "w1", limit: 50, before });
  });
});

describe("GET /api/tasks", () => {
  it("returns 200 with an empty JSON array when no taskManager is provided", async () => {
    const res = await request(port, "GET", "/api/tasks");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("returns active tasks with derived status and date fields, excluding complete", async () => {
    resetDb();
    const tm = await createTestTaskManager();

    await Task.upsert("1", 1, "test/repo", "Pending bug", "Description", []);
    const t2 = await Task.upsert("2", 2, "test/repo", "Done bug", "Description", []);
    await t2.complete();

    const { server: s } = makeTestServer();
    const p = await startServer(s);
    try {
      const res = await request(p, "GET", "/api/tasks");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      // complete task is excluded by default
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({
        taskId: "1",
        repo: "test/repo",
        status: "pending",
      });
      expect(body[0].assignedWorkerId).toBeUndefined();
      expect(body[0].completedAt).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      await stopServer(s);
    }
  });

  it("returns complete tasks when ?status=complete is requested", async () => {
    resetDb();
    const tm = await createTestTaskManager();

    const t = await Task.upsert("42", 42, "test/repo", "Fix bug", "Description", []);
    await t.complete();

    const { server: s } = makeTestServer();
    const p = await startServer(s);
    try {
      const res = await request(p, "GET", "/api/tasks?status=complete");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({ taskId: "42", status: "complete" });
    } finally {
      vi.restoreAllMocks();
      await stopServer(s);
    }
  });

  it("filters tasks by status in memory", async () => {
    resetDb();
    const tm = await createTestTaskManager();

    const t1 = await Task.upsert("1", 1, "test/repo", "T1", "b", []);
    await t1.complete();
    await Task.upsert("2", 2, "test/repo", "T2", "b", []);

    const { server: s } = makeTestServer();
    const p = await startServer(s);
    try {
      const res = await request(p, "GET", "/api/tasks?status=complete");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveLength(1);
      expect(body[0].taskId).toBe("1");
      expect(body[0].status).toBe("complete");
    } finally {
      vi.restoreAllMocks();
      await stopServer(s);
    }
  });
});

describe("GET /api/repos/:owner/:repo", () => {
  it("returns 404 when repo does not exist", async () => {
    resetDb();
    const { server: s } = makeTestServer();
    const p = await startServer(s);
    try {
      const res = await request(p, "GET", "/api/repos/owner/nonexistent");
      expect(res.status).toBe(404);
    } finally {
      await stopServer(s);
    }
  });

  it("returns repo with installation: null when no installation is linked", async () => {
    resetDb();
    await createTestRepo("owner/http-repo-1");
    const { server: s } = makeTestServer();
    const p = await startServer(s);
    try {
      const res = await request(p, "GET", "/api/repos/owner/http-repo-1");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ fullName: "owner/http-repo-1", installation: null });
    } finally {
      await stopServer(s);
    }
  });

  it("returns repo with installation details when App is linked", async () => {
    resetDb();
    await seedRepoWithInstallation("owner/http-repo-2", 77001);
    const { server: s } = makeTestServer();
    const p = await startServer(s);
    try {
      const res = await request(p, "GET", "/api/repos/owner/http-repo-2");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        fullName: "owner/http-repo-2",
        installation: {
          accountLogin: "test-account",
          accountType: "Organization",
          githubId: 77001,
        },
      });
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
