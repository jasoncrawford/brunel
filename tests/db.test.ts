import { describe, it, expect, beforeEach } from "vitest";
import { createDbLogger, createNullDbLogger } from "../src/db.js";
import { createTestSupabase } from "./helpers/db.js";

const supabase = createTestSupabase();

beforeEach(async () => {
  await Promise.all([
    // Only delete rows this file owns — pipeline.test.ts uses delivery_ids like "evt-*"
    // and runs in a parallel Vitest worker; blanket truncation would delete its rows mid-test.
    supabase.from("webhook_events").delete().or("delivery_id.is.null,delivery_id.eq.abc"),
    supabase.from("foreman_messages").delete().gt("id", 0),
  ]);
});

describe("createDbLogger", () => {
  it("stores a webhook_event row on logWebhookEvent", async () => {
    const logger = createDbLogger(supabase);

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

    // Fire-and-forget: give the insert a tick to land
    await new Promise((r) => setTimeout(r, 50));

    const { data } = await supabase
      .from("webhook_events")
      .select("event_name, action, repo, sender, issue_number, task_id, payload")
      .eq("delivery_id", "abc");
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({
      event_name: "issues",
      action: "labeled",
      repo: "owner/repo",
      sender: "alice",
      issue_number: 42,
      task_id: "42",
      payload: { foo: "bar" },
    });
  });

  it("stores a foreman_messages row on logForemanMessage", async () => {
    const logger = createDbLogger(supabase);

    logger.logForemanMessage({
      direction: "sent",
      workerId: "wid",
      taskId: "42",
      msgType: "task_assigned",
      payload: { type: "task_assigned" },
    });

    await new Promise((r) => setTimeout(r, 50));

    const { data } = await supabase
      .from("foreman_messages")
      .select("direction, worker_id, task_id, msg_type")
      .eq("worker_id", "wid");
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({
      direction: "sent",
      worker_id: "wid",
      task_id: "42",
      msg_type: "task_assigned",
    });
  });

  it("does not throw when Supabase returns an error", async () => {
    // Log to a non-existent table column — the insert will fail but should not
    // propagate as an exception because logWebhookEvent is fire-and-forget.
    const logger = createDbLogger(supabase);
    expect(() =>
      logger.logWebhookEvent({
        deliveryId: null,
        eventName: "push",
        action: null,
        repo: null,
        sender: null,
        issueNumber: null,
        prNumber: null,
        branch: null,
        taskId: null,
        workerId: null,
        payload: {},
      }),
    ).not.toThrow();
  });
});

describe("messageToEntry summary for worker_disconnected", () => {
  it("includes close code in summary for worker_disconnected with no reason", async () => {
    const logger = createDbLogger(supabase);
    logger.logForemanMessage({
      direction: "received",
      workerId: "w1",
      taskId: null,
      msgType: "worker_disconnected",
      payload: { code: 1006, reason: null },
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await logger.queryWorkerMessages("w1");
    expect(entries[0].summary).toMatch(/1006/);
  });

  it("includes close code and reason in summary for worker_disconnected with a reason", async () => {
    const logger = createDbLogger(supabase);
    logger.logForemanMessage({
      direction: "received",
      workerId: "w1",
      taskId: null,
      msgType: "worker_disconnected",
      payload: { code: 1001, reason: "Going Away" },
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await logger.queryWorkerMessages("w1");
    expect(entries[0].summary).toMatch(/1001/);
    expect(entries[0].summary).toMatch(/Going Away/);
  });

  it("uses standard direction+msgType summary for non-disconnect messages", async () => {
    const logger = createDbLogger(supabase);
    logger.logForemanMessage({
      direction: "sent",
      workerId: "w1",
      taskId: "42",
      msgType: "task_assigned",
      payload: {},
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await logger.queryWorkerMessages("w1");
    expect(entries[0].summary).toBe("sent task_assigned");
  });
});

describe("webhookToEntry worker_id mapping", () => {
  it("reads worker_id from webhook row in queryTaskEvents", async () => {
    const logger = createDbLogger(supabase);
    logger.logWebhookEvent({
      deliveryId: null,
      eventName: "issues",
      action: "labeled",
      repo: null,
      sender: null,
      issueNumber: 42,
      prNumber: null,
      branch: null,
      taskId: "42",
      workerId: "worker-1",
      payload: {},
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await logger.queryTaskEvents("42");
    expect(entries[0].workerId).toBe("worker-1");
  });

  it("reads null worker_id from webhook row when not set", async () => {
    const logger = createDbLogger(supabase);
    logger.logWebhookEvent({
      deliveryId: null,
      eventName: "issues",
      action: "labeled",
      repo: null,
      sender: null,
      issueNumber: 42,
      prNumber: null,
      branch: null,
      taskId: "42",
      workerId: null,
      payload: {},
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await logger.queryTaskEvents("42");
    expect(entries[0].workerId).toBeNull();
  });

  it("reads worker_id from webhook row in queryLog", async () => {
    const logger = createDbLogger(supabase);
    logger.logWebhookEvent({
      deliveryId: null,
      eventName: "push",
      action: null,
      repo: null,
      sender: null,
      issueNumber: null,
      prNumber: null,
      branch: null,
      taskId: null,
      workerId: "worker-2",
      payload: {},
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await logger.queryLog({});
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ workerId: "worker-2" }),
    ]));
  });
});

describe("queryTaskEvents ordering", () => {
  it("returns events in reverse-chronological order (newest first)", async () => {
    const logger = createDbLogger(supabase);

    // Insert webhook events and foreman messages with different timestamps
    // by using the DB defaults and then verifying ordering by actual timestamps.
    // We insert three rows, wait a tick between each to get distinct timestamps.
    await supabase.from("webhook_events").insert({
      event_name: "issues", action: "labeled", issue_number: 42,
      task_id: "42", worker_id: null, payload: {},
      received_at: "2026-03-27T01:00:00Z",
    });
    await supabase.from("foreman_messages").insert({
      direction: "sent", worker_id: "w1", task_id: "42",
      msg_type: "task_assigned", payload: {},
      created_at: "2026-03-27T02:00:00Z",
    });
    await supabase.from("webhook_events").insert({
      event_name: "issues", action: "unlabeled", issue_number: 42,
      task_id: "42", worker_id: null, payload: {},
      received_at: "2026-03-27T03:00:00Z",
    });

    const entries = await logger.queryTaskEvents("42");
    expect(entries).toHaveLength(3);
    expect(entries[0].timestamp).toBe("2026-03-27T03:00:00+00:00");
    expect(entries[1].timestamp).toBe("2026-03-27T02:00:00+00:00");
    expect(entries[2].timestamp).toBe("2026-03-27T01:00:00+00:00");
  });
});

describe("queryWorkerMessages includes webhook events", () => {
  it("returns webhook events for a worker alongside foreman messages", async () => {
    const logger = createDbLogger(supabase);
    logger.logWebhookEvent({
      deliveryId: null, eventName: "issues", action: "labeled",
      repo: null, sender: null, issueNumber: 42,
      prNumber: null, branch: null, taskId: "42", workerId: "w1", payload: {},
    });
    logger.logForemanMessage({
      direction: "sent", workerId: "w1", taskId: "42",
      msgType: "task_assigned", payload: {},
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await logger.queryWorkerMessages("w1");
    const kinds = entries.map((e) => e.kind);
    expect(kinds).toContain("webhook");
    expect(kinds).toContain("message");
  });

  it("returns only entries matching the given worker_id", async () => {
    const logger = createDbLogger(supabase);
    logger.logWebhookEvent({
      deliveryId: null, eventName: "push", action: null,
      repo: null, sender: null, issueNumber: null,
      prNumber: null, branch: null, taskId: null, workerId: "w1", payload: {},
    });
    logger.logWebhookEvent({
      deliveryId: null, eventName: "push", action: null,
      repo: null, sender: null, issueNumber: null,
      prNumber: null, branch: null, taskId: null, workerId: "w2", payload: {},
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await logger.queryWorkerMessages("w1");
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("webhook");
    expect(entries[0].workerId).toBe("w1");
  });

  it("returns entries sorted by timestamp descending", async () => {
    const logger = createDbLogger(supabase);
    await supabase.from("webhook_events").insert({
      event_name: "issues", action: "labeled", issue_number: 1,
      task_id: null, worker_id: "w1", payload: {},
      received_at: "2026-03-27T01:00:00Z",
    });
    await supabase.from("foreman_messages").insert({
      direction: "sent", worker_id: "w1", task_id: null,
      msg_type: "task_assigned", payload: {},
      created_at: "2026-03-27T03:00:00Z",
    });

    const entries = await logger.queryWorkerMessages("w1");
    expect(entries[0].timestamp).toBe("2026-03-27T03:00:00+00:00");
    expect(entries[1].timestamp).toBe("2026-03-27T01:00:00+00:00");
  });
});

describe("webhookToEntry richer summaries", () => {
  it("includes check run name and conclusion for check_run/completed", async () => {
    const logger = createDbLogger(supabase);
    logger.logWebhookEvent({
      deliveryId: null, eventName: "check_run", action: "completed",
      repo: null, sender: null, issueNumber: null, prNumber: null, branch: null,
      taskId: "42", workerId: null,
      payload: { action: "completed", check_run: { name: "CI / build", conclusion: "success" } },
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await logger.queryLog({});
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ summary: expect.stringContaining("CI / build") }),
    ]));
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ summary: expect.stringContaining("success") }),
    ]));
  });

  it("includes branch ref for push events", async () => {
    const logger = createDbLogger(supabase);
    logger.logWebhookEvent({
      deliveryId: null, eventName: "push", action: null,
      repo: null, sender: null, issueNumber: null, prNumber: null, branch: null,
      taskId: null, workerId: null,
      payload: { ref: "refs/heads/main", commits: [{}, {}] },
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await logger.queryLog({});
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ summary: expect.stringContaining("refs/heads/main") }),
    ]));
  });

  it("includes PR number and title for pull_request events", async () => {
    const logger = createDbLogger(supabase);
    logger.logWebhookEvent({
      deliveryId: null, eventName: "pull_request", action: "closed",
      repo: null, sender: null, issueNumber: null, prNumber: null, branch: null,
      taskId: "42", workerId: null,
      payload: { action: "closed", pull_request: { number: 10, title: "Fix the bug" } },
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await logger.queryLog({});
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ summary: expect.stringContaining("Fix the bug") }),
    ]));
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ summary: expect.stringContaining("10") }),
    ]));
  });

  it("includes label name for issues/labeled events", async () => {
    const logger = createDbLogger(supabase);
    logger.logWebhookEvent({
      deliveryId: null, eventName: "issues", action: "labeled",
      repo: null, sender: null, issueNumber: 42, prNumber: null, branch: null,
      taskId: "42", workerId: null,
      payload: { action: "labeled", issue: { number: 42, title: "Fix" }, label: { name: "bug" } },
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await logger.queryLog({});
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ summary: expect.stringContaining("bug") }),
    ]));
  });

  it("includes ref_type and ref for delete events", async () => {
    const logger = createDbLogger(supabase);
    logger.logWebhookEvent({
      deliveryId: null, eventName: "delete", action: null,
      repo: null, sender: null, issueNumber: null, prNumber: null, branch: null,
      taskId: null, workerId: null,
      payload: { ref_type: "branch", ref: "feature/old" },
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await logger.queryLog({});
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ summary: expect.stringContaining("branch") }),
    ]));
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ summary: expect.stringContaining("feature/old") }),
    ]));
  });

  it("includes comment text for issue_comment events", async () => {
    const logger = createDbLogger(supabase);
    logger.logWebhookEvent({
      deliveryId: null, eventName: "issue_comment", action: "created",
      repo: null, sender: null, issueNumber: 42, prNumber: null, branch: null,
      taskId: "42", workerId: null,
      payload: { action: "created", comment: { body: "LGTM!" } },
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await logger.queryLog({});
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ summary: expect.stringContaining("LGTM!") }),
    ]));
  });

  it("falls back gracefully for rows without payload content", async () => {
    // Insert a row with an empty payload to simulate minimal data
    const logger = createDbLogger(supabase);
    logger.logWebhookEvent({
      deliveryId: null, eventName: "issues", action: "labeled",
      repo: null, sender: null, issueNumber: 42, prNumber: null, branch: null,
      taskId: "42", workerId: null, payload: {},
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await logger.queryLog({});
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ summary: expect.stringContaining("issues") }),
    ]));
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ summary: expect.stringContaining("labeled") }),
    ]));
  });
});

describe("messageToEntry richer summaries", () => {
  it("includes 'idle' status for worker_hello when idle", async () => {
    const logger = createDbLogger(supabase);
    logger.logForemanMessage({
      direction: "received", workerId: "w1", taskId: null,
      msgType: "worker_hello",
      payload: { type: "worker_hello", workerId: "w1", status: "idle" },
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await logger.queryWorkerMessages("w1");
    expect(entries[0].summary).toContain("idle");
  });

  it("includes 'busy' status and taskId for worker_hello when busy", async () => {
    const logger = createDbLogger(supabase);
    logger.logForemanMessage({
      direction: "received", workerId: "w1", taskId: "42",
      msgType: "worker_hello",
      payload: { type: "worker_hello", workerId: "w1", status: "busy", taskId: "42" },
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await logger.queryWorkerMessages("w1");
    expect(entries[0].summary).toContain("busy");
    expect(entries[0].summary).toContain("42");
  });

  it("includes the forwarded event name for event_notification", async () => {
    const logger = createDbLogger(supabase);
    logger.logForemanMessage({
      direction: "sent", workerId: "w1", taskId: "42",
      msgType: "event_notification",
      payload: { type: "event_notification", taskId: "42", event: { id: "e1", name: "check_run", payload: { action: "completed" } } },
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await logger.queryWorkerMessages("w1");
    expect(entries[0].summary).toContain("check_run");
  });

  it("includes 'idle' status for hello_ack when idle", async () => {
    const logger = createDbLogger(supabase);
    logger.logForemanMessage({
      direction: "sent", workerId: "w1", taskId: null,
      msgType: "hello_ack",
      payload: { type: "hello_ack", workerId: "w1", status: "idle" },
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await logger.queryWorkerMessages("w1");
    expect(entries[0].summary).toContain("hello_ack");
    expect(entries[0].summary).toContain("idle");
  });

  it("includes 'busy' status and taskId for hello_ack when busy", async () => {
    const logger = createDbLogger(supabase);
    logger.logForemanMessage({
      direction: "sent", workerId: "w1", taskId: "42",
      msgType: "hello_ack",
      payload: { type: "hello_ack", workerId: "w1", status: "busy" },
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await logger.queryWorkerMessages("w1");
    expect(entries[0].summary).toContain("hello_ack");
    expect(entries[0].summary).toContain("busy");
    expect(entries[0].summary).toContain("42");
  });

  it("includes 'cancelled' status and taskId for hello_ack when cancelled", async () => {
    const logger = createDbLogger(supabase);
    logger.logForemanMessage({
      direction: "sent", workerId: "w1", taskId: "42",
      msgType: "hello_ack",
      payload: { type: "hello_ack", workerId: "w1", status: "cancelled" },
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await logger.queryWorkerMessages("w1");
    expect(entries[0].summary).toContain("hello_ack");
    expect(entries[0].summary).toContain("cancelled");
    expect(entries[0].summary).toContain("42");
  });
});

describe("createNullDbLogger", () => {
  it("logWebhookEvent is a no-op", () => {
    const logger = createNullDbLogger();
    expect(() =>
      logger.logWebhookEvent({
        deliveryId: null, eventName: "push", action: null, repo: null,
        sender: null, issueNumber: null, prNumber: null, branch: null,
        taskId: null, workerId: null, payload: {},
      }),
    ).not.toThrow();
  });

  it("logForemanMessage is a no-op", () => {
    const logger = createNullDbLogger();
    expect(() =>
      logger.logForemanMessage({
        direction: "sent", workerId: "w1", taskId: "1",
        msgType: "task_assigned", payload: {},
      }),
    ).not.toThrow();
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
