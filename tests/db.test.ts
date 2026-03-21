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
