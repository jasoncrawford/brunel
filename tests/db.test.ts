import { describe, it, expect, beforeEach } from "vitest";
import { WebhookEvent } from "../src/foreman/models/webhook-event.js";
import { ForemanMessage } from "../src/foreman/models/foreman-message.js";
import { queryActivityLog } from "../src/foreman/models/activity-log.js";
import { initDb } from "../src/foreman/db-client.js";
import { createTestSupabase } from "./helpers/db.js";

const supabase = createTestSupabase();
initDb(supabase);

beforeEach(async () => {
  await Promise.all([
    // Only delete rows this file owns — pipeline.test.ts uses delivery_ids like "evt-*"
    // and runs in a parallel Vitest worker; blanket truncation would delete its rows mid-test.
    supabase.from("webhook_events").delete().or("delivery_id.is.null,delivery_id.eq.abc"),
    supabase.from("foreman_messages").delete().gt("id", 0),
  ]);
});

describe("WebhookEvent.log", () => {
  it("stores a webhook_events row", async () => {
    WebhookEvent.log({
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

  it("does not throw on fire-and-forget call", () => {
    expect(() =>
      WebhookEvent.log({
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

describe("ForemanMessage.log", () => {
  it("stores a foreman_messages row", async () => {
    ForemanMessage.log({
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
});

describe("ForemanMessage.buildSummary for worker_disconnected", () => {
  it("includes close code in summary for worker_disconnected with no reason", () => {
    const summary = ForemanMessage.buildSummary("received", "worker_disconnected", null, { code: 1006, reason: null });
    expect(summary).toMatch(/1006/);
  });

  it("includes close code and reason in summary for worker_disconnected with a reason", () => {
    const summary = ForemanMessage.buildSummary("received", "worker_disconnected", null, { code: 1001, reason: "Going Away" });
    expect(summary).toMatch(/1001/);
    expect(summary).toMatch(/Going Away/);
  });

  it("uses standard direction+msgType summary for non-disconnect messages", () => {
    const summary = ForemanMessage.buildSummary("sent", "task_assigned", "42", {});
    expect(summary).toBe("sent task_assigned");
  });
});

describe("ForemanMessage.buildSummary richer summaries", () => {
  it("includes 'idle' status for worker_hello when idle", () => {
    const summary = ForemanMessage.buildSummary("received", "worker_hello", null,
      { type: "worker_hello", workerId: "w1", status: "idle" });
    expect(summary).toContain("idle");
  });

  it("includes 'busy' status and taskId for worker_hello when busy", () => {
    const summary = ForemanMessage.buildSummary("received", "worker_hello", "42",
      { type: "worker_hello", workerId: "w1", status: "busy", taskId: "42" });
    expect(summary).toContain("busy");
    expect(summary).toContain("42");
  });

  it("includes the forwarded event name for event_notification", () => {
    const summary = ForemanMessage.buildSummary("sent", "event_notification", "42",
      { type: "event_notification", taskId: "42", event: { id: "e1", name: "check_run", payload: { action: "completed" } } });
    expect(summary).toContain("check_run");
  });

  it("includes 'idle' status for hello_ack when idle", () => {
    const summary = ForemanMessage.buildSummary("sent", "hello_ack", null,
      { type: "hello_ack", workerId: "w1", status: "idle" });
    expect(summary).toContain("hello_ack");
    expect(summary).toContain("idle");
  });

  it("includes 'busy' status and taskId for hello_ack when busy", () => {
    const summary = ForemanMessage.buildSummary("sent", "hello_ack", "42",
      { type: "hello_ack", workerId: "w1", status: "busy" });
    expect(summary).toContain("hello_ack");
    expect(summary).toContain("busy");
    expect(summary).toContain("42");
  });

  it("includes 'cancelled' status and taskId for hello_ack when cancelled", () => {
    const summary = ForemanMessage.buildSummary("sent", "hello_ack", "42",
      { type: "hello_ack", workerId: "w1", status: "cancelled" });
    expect(summary).toContain("hello_ack");
    expect(summary).toContain("cancelled");
    expect(summary).toContain("42");
  });
});

describe("WebhookEvent.format (richer summaries)", () => {
  function fmt(eventName: string, payload: Record<string, unknown>): string {
    return WebhookEvent.fromIncoming("test", eventName, payload).format();
  }

  it("includes check run name and conclusion for check_run/completed", () => {
    const summary = fmt("check_run", { action: "completed", check_run: { name: "CI / build", conclusion: "success" } });
    expect(summary).toContain("CI / build");
    expect(summary).toContain("success");
  });

  it("includes branch ref for push events", () => {
    const summary = fmt("push", { ref: "refs/heads/main", commits: [{}, {}] });
    expect(summary).toContain("refs/heads/main");
  });

  it("includes PR number and title for pull_request events", () => {
    const summary = fmt("pull_request", { action: "closed", pull_request: { number: 10, title: "Fix the bug" } });
    expect(summary).toContain("Fix the bug");
    expect(summary).toContain("10");
  });

  it("includes label name for issues/labeled events", () => {
    const summary = fmt("issues", { action: "labeled", issue: { number: 42, title: "Fix" }, label: { name: "bug" } });
    expect(summary).toContain("bug");
  });

  it("includes ref_type and ref for delete events", () => {
    const summary = fmt("delete", { ref_type: "branch", ref: "feature/old" });
    expect(summary).toContain("branch");
    expect(summary).toContain("feature/old");
  });

  it("includes comment text for issue_comment events", () => {
    const summary = fmt("issue_comment", { action: "created", comment: { body: "LGTM!" } });
    expect(summary).toContain("LGTM!");
  });

  it("falls back gracefully for empty payload", () => {
    const summary = fmt("issues", {});
    expect(summary).toContain("issues");
  });
});

describe("queryActivityLog", () => {
  it("returns entries sorted by timestamp descending", async () => {
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

    const entries = await queryActivityLog({ taskId: "42" });
    expect(entries).toHaveLength(3);
    expect(entries[0].timestamp).toBe("2026-03-27T03:00:00+00:00");
    expect(entries[1].timestamp).toBe("2026-03-27T02:00:00+00:00");
    expect(entries[2].timestamp).toBe("2026-03-27T01:00:00+00:00");
  });

  it("filters by taskId", async () => {
    WebhookEvent.log({
      deliveryId: null, eventName: "issues", action: "labeled",
      repo: null, sender: null, issueNumber: 42,
      prNumber: null, branch: null, taskId: "42", workerId: "worker-1", payload: {},
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await queryActivityLog({ taskId: "42" });
    expect(entries[0].workerId).toBe("worker-1");
  });

  it("filters by workerId and includes both kinds", async () => {
    WebhookEvent.log({
      deliveryId: null, eventName: "issues", action: "labeled",
      repo: null, sender: null, issueNumber: 42,
      prNumber: null, branch: null, taskId: "42", workerId: "w1", payload: {},
    });
    ForemanMessage.log({
      direction: "sent", workerId: "w1", taskId: "42",
      msgType: "task_assigned", payload: {},
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await queryActivityLog({ workerId: "w1" });
    const kinds = entries.map((e) => e.kind);
    expect(kinds).toContain("webhook");
    expect(kinds).toContain("message");
  });

  it("filters by workerId and excludes other workers", async () => {
    await Promise.all([
      supabase.from("webhook_events").insert({
        event_name: "push", action: null, task_id: null, worker_id: "w1", payload: {},
      }),
      supabase.from("webhook_events").insert({
        event_name: "push", action: null, task_id: null, worker_id: "w2", payload: {},
      }),
    ]);

    const entries = await queryActivityLog({ workerId: "w1" });
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("webhook");
    expect(entries[0].workerId).toBe("w1");
  });

  it("returns entries with workerId from webhook rows in queryLog", async () => {
    WebhookEvent.log({
      deliveryId: null, eventName: "push", action: null,
      repo: null, sender: null, issueNumber: null,
      prNumber: null, branch: null, taskId: null, workerId: "worker-2", payload: {},
    });
    await new Promise((r) => setTimeout(r, 50));

    const entries = await queryActivityLog();
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ workerId: "worker-2" }),
    ]));
  });
});
