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
      workerId: null,
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
      taskId: null, workerId: null, payload: {},
    })).not.toThrow();
  });
});

describe("messageToEntry summary for worker_disconnected", () => {
  function makeSupabaseReturning(rows: Record<string, unknown>[]) {
    const makeBuilder = (data: Record<string, unknown>[]) => ({
      insert: vi.fn().mockResolvedValue({ error: null }),
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      then: vi.fn().mockImplementation((cb: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve(cb({ data, error: null }))
      ),
    });
    return {
      from: vi.fn().mockImplementation((t: string) =>
        t === "foreman_messages" ? makeBuilder(rows) : makeBuilder([])
      ),
    };
  }

  it("includes close code in summary for worker_disconnected with no reason", async () => {
    const supabase = makeSupabaseReturning([{
      id: 1, created_at: "2026-03-27T00:00:00Z",
      direction: "received", worker_id: "w1", task_id: null,
      msg_type: "worker_disconnected", payload: { code: 1006, reason: null },
    }]);
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);
    const entries = await logger.queryWorkerMessages("w1");
    expect(entries[0].summary).toMatch(/1006/);
  });

  it("includes close code and reason in summary for worker_disconnected with a reason", async () => {
    const supabase = makeSupabaseReturning([{
      id: 1, created_at: "2026-03-27T00:00:00Z",
      direction: "received", worker_id: "w1", task_id: null,
      msg_type: "worker_disconnected", payload: { code: 1001, reason: "Going Away" },
    }]);
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);
    const entries = await logger.queryWorkerMessages("w1");
    expect(entries[0].summary).toMatch(/1001/);
    expect(entries[0].summary).toMatch(/Going Away/);
  });

  it("uses standard direction+msgType summary for non-disconnect messages", async () => {
    const supabase = makeSupabaseReturning([{
      id: 1, created_at: "2026-03-27T00:00:00Z",
      direction: "sent", worker_id: "w1", task_id: "42",
      msg_type: "task_assigned", payload: {},
    }]);
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);
    const entries = await logger.queryWorkerMessages("w1");
    expect(entries[0].summary).toBe("sent task_assigned");
  });
});

describe("webhookToEntry worker_id mapping", () => {
  function makeSupabaseReturningWebhooks(rows: Record<string, unknown>[]) {
    const webhookBuilder = {
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      then: vi.fn().mockImplementation((cb: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve(cb({ data: rows, error: null }))
      ),
    };
    const emptyBuilder = {
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      then: vi.fn().mockImplementation((cb: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve(cb({ data: [], error: null }))
      ),
    };
    return {
      from: vi.fn().mockImplementation((t: string) =>
        t === "webhook_events" ? webhookBuilder : emptyBuilder
      ),
    };
  }

  it("reads worker_id from webhook row in queryTaskEvents", async () => {
    const supabase = makeSupabaseReturningWebhooks([{
      id: 1, received_at: "2026-03-27T00:00:00Z",
      event_name: "issues", action: "labeled", issue_number: 42,
      task_id: "42", worker_id: "worker-1",
    }]);
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);
    const entries = await logger.queryTaskEvents("42");
    expect(entries[0].workerId).toBe("worker-1");
  });

  it("reads null worker_id from webhook row when not set", async () => {
    const supabase = makeSupabaseReturningWebhooks([{
      id: 1, received_at: "2026-03-27T00:00:00Z",
      event_name: "issues", action: "labeled", issue_number: 42,
      task_id: "42", worker_id: null,
    }]);
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);
    const entries = await logger.queryTaskEvents("42");
    expect(entries[0].workerId).toBeNull();
  });

  it("reads worker_id from webhook row in queryLog", async () => {
    const supabase = makeSupabaseReturningWebhooks([{
      id: 1, received_at: "2026-03-27T00:00:00Z",
      event_name: "push", action: null, issue_number: null,
      task_id: null, worker_id: "worker-2",
    }]);
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);
    const entries = await logger.queryLog({});
    expect(entries[0].workerId).toBe("worker-2");
  });
});

describe("queryTaskEvents ordering", () => {
  function makeSupabaseReturningTaskRows(webhookRows: Record<string, unknown>[], messageRows: Record<string, unknown>[]) {
    const webhookBuilder = {
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      then: vi.fn().mockImplementation((cb: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve(cb({ data: webhookRows, error: null }))
      ),
    };
    const messageBuilder = {
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      then: vi.fn().mockImplementation((cb: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve(cb({ data: messageRows, error: null }))
      ),
    };
    return {
      from: vi.fn().mockImplementation((t: string) =>
        t === "webhook_events" ? webhookBuilder : messageBuilder
      ),
    };
  }

  it("returns events in reverse-chronological order (newest first)", async () => {
    const supabase = makeSupabaseReturningTaskRows(
      [
        { id: 1, received_at: "2026-03-27T01:00:00Z", event_name: "issues", action: "labeled", issue_number: 42, task_id: "42", worker_id: null },
        { id: 2, received_at: "2026-03-27T03:00:00Z", event_name: "issues", action: "unlabeled", issue_number: 42, task_id: "42", worker_id: null },
      ],
      [
        { id: 10, created_at: "2026-03-27T02:00:00Z", direction: "sent", worker_id: "w1", task_id: "42", msg_type: "task_assigned", payload: {} },
      ]
    );
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);
    const entries = await logger.queryTaskEvents("42");
    expect(entries[0].timestamp).toBe("2026-03-27T03:00:00Z");
    expect(entries[1].timestamp).toBe("2026-03-27T02:00:00Z");
    expect(entries[2].timestamp).toBe("2026-03-27T01:00:00Z");
  });
});

describe("queryWorkerMessages includes webhook events", () => {
  function makeSupabaseTwoTables(
    webhookRows: Record<string, unknown>[],
    messageRows: Record<string, unknown>[],
  ) {
    const makeBuilder = (rows: Record<string, unknown>[]) => ({
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      then: vi.fn().mockImplementation((cb: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve(cb({ data: rows, error: null }))
      ),
    });
    return {
      from: vi.fn().mockImplementation((t: string) =>
        t === "webhook_events" ? makeBuilder(webhookRows) : makeBuilder(messageRows)
      ),
    };
  }

  it("returns webhook events for a worker alongside foreman messages", async () => {
    const supabase = makeSupabaseTwoTables(
      [{
        id: 10, received_at: "2026-03-27T01:00:00Z",
        event_name: "issues", action: "labeled", issue_number: 42,
        task_id: "42", worker_id: "w1",
      }],
      [{
        id: 20, created_at: "2026-03-27T02:00:00Z",
        direction: "sent", worker_id: "w1", task_id: "42",
        msg_type: "task_assigned", payload: {},
      }],
    );
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);
    const entries = await logger.queryWorkerMessages("w1");
    const kinds = entries.map((e) => e.kind);
    expect(kinds).toContain("webhook");
    expect(kinds).toContain("message");
  });

  it("returns only entries matching the given worker_id", async () => {
    const supabase = makeSupabaseTwoTables(
      [{
        id: 10, received_at: "2026-03-27T01:00:00Z",
        event_name: "push", action: null, issue_number: null,
        task_id: null, worker_id: "w1",
      }],
      [],
    );
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);
    const entries = await logger.queryWorkerMessages("w1");
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("webhook");
    expect(entries[0].workerId).toBe("w1");
  });

  it("returns entries sorted by timestamp descending", async () => {
    const supabase = makeSupabaseTwoTables(
      [{
        id: 10, received_at: "2026-03-27T01:00:00Z",
        event_name: "issues", action: "labeled", issue_number: 1,
        task_id: null, worker_id: "w1",
      }],
      [{
        id: 20, created_at: "2026-03-27T03:00:00Z",
        direction: "sent", worker_id: "w1", task_id: null,
        msg_type: "standby", payload: {},
      }],
    );
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);
    const entries = await logger.queryWorkerMessages("w1");
    expect(entries[0].timestamp).toBe("2026-03-27T03:00:00Z");
    expect(entries[1].timestamp).toBe("2026-03-27T01:00:00Z");
  });
});

describe("webhookToEntry richer summaries", () => {
  function makeSupabaseWithWebhookRow(row: Record<string, unknown>) {
    const makeBuilder = (data: Record<string, unknown>[]) => ({
      insert: vi.fn().mockResolvedValue({ error: null }),
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      then: vi.fn().mockImplementation((cb: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve(cb({ data, error: null }))
      ),
    });
    return {
      from: vi.fn().mockImplementation((t: string) =>
        t === "webhook_events" ? makeBuilder([row]) : makeBuilder([])
      ),
    };
  }

  it("includes check run name and conclusion for check_run/completed", async () => {
    const supabase = makeSupabaseWithWebhookRow({
      id: 1, received_at: "2026-03-27T00:00:00Z",
      event_name: "check_run", action: "completed", issue_number: null,
      task_id: "42", worker_id: null,
      payload: { action: "completed", check_run: { name: "CI / build", conclusion: "success" } },
    });
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);
    const entries = await logger.queryLog({});
    expect(entries[0].summary).toContain("CI / build");
    expect(entries[0].summary).toContain("success");
  });

  it("includes branch ref for push events", async () => {
    const supabase = makeSupabaseWithWebhookRow({
      id: 1, received_at: "2026-03-27T00:00:00Z",
      event_name: "push", action: null, issue_number: null,
      task_id: null, worker_id: null,
      payload: { ref: "refs/heads/main", commits: [{}, {}] },
    });
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);
    const entries = await logger.queryLog({});
    expect(entries[0].summary).toContain("refs/heads/main");
  });

  it("includes PR number and title for pull_request events", async () => {
    const supabase = makeSupabaseWithWebhookRow({
      id: 1, received_at: "2026-03-27T00:00:00Z",
      event_name: "pull_request", action: "closed", issue_number: null,
      task_id: "42", worker_id: null,
      payload: { action: "closed", pull_request: { number: 10, title: "Fix the bug" } },
    });
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);
    const entries = await logger.queryLog({});
    expect(entries[0].summary).toContain("10");
    expect(entries[0].summary).toContain("Fix the bug");
  });

  it("includes label name for issues/labeled events", async () => {
    const supabase = makeSupabaseWithWebhookRow({
      id: 1, received_at: "2026-03-27T00:00:00Z",
      event_name: "issues", action: "labeled", issue_number: 42,
      task_id: "42", worker_id: null,
      payload: { action: "labeled", issue: { number: 42, title: "Fix" }, label: { name: "bug" } },
    });
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);
    const entries = await logger.queryLog({});
    expect(entries[0].summary).toContain("bug");
  });

  it("includes ref_type and ref for delete events", async () => {
    const supabase = makeSupabaseWithWebhookRow({
      id: 1, received_at: "2026-03-27T00:00:00Z",
      event_name: "delete", action: null, issue_number: null,
      task_id: null, worker_id: null,
      payload: { ref_type: "branch", ref: "feature/old" },
    });
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);
    const entries = await logger.queryLog({});
    expect(entries[0].summary).toContain("branch");
    expect(entries[0].summary).toContain("feature/old");
  });

  it("includes comment text for issue_comment events", async () => {
    const supabase = makeSupabaseWithWebhookRow({
      id: 1, received_at: "2026-03-27T00:00:00Z",
      event_name: "issue_comment", action: "created", issue_number: 42,
      task_id: "42", worker_id: null,
      payload: { action: "created", comment: { body: "LGTM!" } },
    });
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);
    const entries = await logger.queryLog({});
    expect(entries[0].summary).toContain("LGTM!");
  });

  it("falls back gracefully for rows without payload", async () => {
    const supabase = makeSupabaseWithWebhookRow({
      id: 1, received_at: "2026-03-27T00:00:00Z",
      event_name: "issues", action: "labeled", issue_number: 42,
      task_id: "42", worker_id: null,
      payload: null,
    });
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);
    const entries = await logger.queryLog({});
    expect(entries[0].summary).toContain("issues");
    expect(entries[0].summary).toContain("labeled");
  });
});

describe("messageToEntry richer summaries", () => {
  function makeSupabaseWithMessageRow(row: Record<string, unknown>) {
    const makeBuilder = (data: Record<string, unknown>[]) => ({
      insert: vi.fn().mockResolvedValue({ error: null }),
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      then: vi.fn().mockImplementation((cb: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve(cb({ data, error: null }))
      ),
    });
    return {
      from: vi.fn().mockImplementation((t: string) =>
        t === "foreman_messages" ? makeBuilder([row]) : makeBuilder([])
      ),
    };
  }

  it("includes 'idle' status for worker_hello when idle", async () => {
    const supabase = makeSupabaseWithMessageRow({
      id: 1, created_at: "2026-03-27T00:00:00Z",
      direction: "received", worker_id: "w1", task_id: null,
      msg_type: "worker_hello",
      payload: { type: "worker_hello", workerId: "w1", status: "idle" },
    });
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);
    const entries = await logger.queryWorkerMessages("w1");
    expect(entries[0].summary).toContain("idle");
  });

  it("includes 'busy' status and taskId for worker_hello when busy", async () => {
    const supabase = makeSupabaseWithMessageRow({
      id: 1, created_at: "2026-03-27T00:00:00Z",
      direction: "received", worker_id: "w1", task_id: "42",
      msg_type: "worker_hello",
      payload: { type: "worker_hello", workerId: "w1", status: "busy", taskId: "42" },
    });
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);
    const entries = await logger.queryWorkerMessages("w1");
    expect(entries[0].summary).toContain("busy");
    expect(entries[0].summary).toContain("42");
  });

  it("includes the forwarded event name for event_notification", async () => {
    const supabase = makeSupabaseWithMessageRow({
      id: 1, created_at: "2026-03-27T00:00:00Z",
      direction: "sent", worker_id: "w1", task_id: "42",
      msg_type: "event_notification",
      payload: { type: "event_notification", taskId: "42", event: { id: "e1", name: "check_run", payload: { action: "completed" } } },
    });
    const logger = createDbLogger(supabase as unknown as Parameters<typeof createDbLogger>[0]);
    const entries = await logger.queryWorkerMessages("w1");
    expect(entries[0].summary).toContain("check_run");
  });
});

describe("createNullDbLogger", () => {
  it("logWebhookEvent is a no-op", () => {
    const logger = createNullDbLogger();
    expect(() => logger.logWebhookEvent({
      deliveryId: null, eventName: "push", action: null, repo: null,
      sender: null, issueNumber: null, prNumber: null, branch: null,
      taskId: null, workerId: null, payload: {},
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
