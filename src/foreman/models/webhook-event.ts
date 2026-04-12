import type { Database, Json } from "../../database.types.js";
import { db } from "../db-client.js";
import { fmtEvent } from "../event-fmt.js";
import * as Wire from "../../wire.js";

type DbRow = Database["public"]["Tables"]["webhook_events"]["Row"];

// ── Model ──────────────────────────────────────────────────────────────────────

export class WebhookEvent {
  readonly id: number;
  readonly deliveryId: string | null;
  readonly eventName: string;
  readonly action: string | null;
  readonly repo: string | null;
  readonly sender: string | null;
  readonly issueNumber: number | null;
  readonly prNumber: number | null;
  readonly branch: string | null;
  readonly taskId: string | null;
  readonly workerId: string | null;
  readonly payload: Record<string, unknown>;
  readonly receivedAt: string;

  private constructor(row: DbRow) {
    this.id = row.id;
    this.deliveryId = row.delivery_id;
    this.eventName = row.event_name;
    this.action = row.action;
    this.repo = row.repo;
    this.sender = row.sender;
    this.issueNumber = row.issue_number;
    this.prNumber = row.pr_number;
    this.branch = row.branch;
    this.taskId = row.task_id;
    this.workerId = row.worker_id;
    this.payload = (row.payload as Record<string, unknown>) ?? {};
    this.receivedAt = row.received_at;
  }

  // ── Factory (in-memory, before DB insert) ───────────────────────────────────

  /** Create an in-memory event from an incoming GitHub webhook, before logging to DB. */
  static fromIncoming(deliveryId: string, eventName: string, payload: Record<string, unknown>): WebhookEvent {
    type R = Record<string, unknown>;
    const action = typeof payload.action === "string" ? payload.action : null;
    const repo = typeof (payload.repository as R | undefined)?.full_name === "string"
      ? (payload.repository as R).full_name as string : null;
    const issueNumber = typeof (payload.issue as R | undefined)?.number === "number"
      ? (payload.issue as R).number as number : null;
    const prNumber = typeof (payload.pull_request as R | undefined)?.number === "number"
      ? (payload.pull_request as R).number as number : null;
    const sender = typeof (payload.sender as R | undefined)?.login === "string"
      ? (payload.sender as R).login as string : null;
    return new WebhookEvent({
      id: 0,
      delivery_id: deliveryId,
      event_name: eventName,
      action,
      repo,
      sender,
      issue_number: issueNumber,
      pr_number: prNumber,
      branch: null,
      task_id: null,
      worker_id: null,
      payload: payload as Json,
      received_at: new Date().toISOString(),
    });
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  /** Insert into webhook_events. Returns a promise (usually ignored). No-op if DB is not initialized. */
  static log(data: {
    deliveryId: string | null;
    eventName: string;
    action: string | null;
    repo: string | null;
    sender: string | null;
    issueNumber: number | null;
    prNumber: number | null;
    branch: string | null;
    taskId: string | null;
    workerId: string | null;
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      if (!db) return Promise.resolve();
      return Promise.resolve(db.from("webhook_events").insert({
        delivery_id: data.deliveryId,
        event_name: data.eventName,
        action: data.action,
        repo: data.repo,
        sender: data.sender,
        issue_number: data.issueNumber,
        pr_number: data.prNumber,
        branch: data.branch,
        task_id: data.taskId,
        worker_id: data.workerId,
        payload: data.payload as Json,
      })).then(({ error }) => {
        if (error) console.error("[db] webhook_events insert error:", error);
      }).catch((err: unknown) => console.error("[db] unexpected error:", err));
    } catch {
      return Promise.resolve();
    }
  }

  // ── Queries ──────────────────────────────────────────────────────────────────

  static async queryForTask(taskId: string): Promise<WebhookEvent[]> {
    const { data } = await db.from("webhook_events")
      .select("*")
      .eq("task_id", taskId)
      .order("received_at", { ascending: false })
      .limit(500);
    return (data ?? []).map((r) => new WebhookEvent(r));
  }

  static async queryForWorker(workerId: string): Promise<WebhookEvent[]> {
    const { data } = await db.from("webhook_events")
      .select("*")
      .eq("worker_id", workerId)
      .order("received_at", { ascending: false })
      .limit(500);
    return (data ?? []).map((r) => new WebhookEvent(r));
  }

  static async query(opts: { limit?: number } = {}): Promise<WebhookEvent[]> {
    const { data } = await db.from("webhook_events")
      .select("*")
      .order("received_at", { ascending: false })
      .limit(opts.limit ?? 100);
    return (data ?? []).map((r) => new WebhookEvent(r));
  }

  // ── Wire / display helpers ───────────────────────────────────────────────────

  /** Returns the payload for forwarding to workers via event_notification. */
  toWorkerPayload(): Wire.WebhookEvent {
    return {
      id: this.deliveryId ?? "",
      name: this.eventName,
      payload: this.payload,
    };
  }

  /** Human-readable summary for the admin dashboard log. */
  format(): string {
    return fmtEvent({ name: this.eventName, payload: this.payload });
  }
}
