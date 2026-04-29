import type { Json } from "../../database.types.js";
import type { DbRow } from "../clients/db-client.js";
import * as Wire from "../../../shared/wire.js";
import { ActiveRecord } from "./active-record.js";
import { log, fmtError } from "../../utils.js";
import { trunc, fmtEvent, fmtEventDetails } from "../../../shared/formatters.js";

type Row = DbRow<"webhook_events">;

// ── Model ──────────────────────────────────────────────────────────────────────

export class WebhookEvent extends ActiveRecord {
  protected static readonly tableName = "webhook_events";
  protected static readonly primaryKey = "id";

  readonly id: number | undefined;
  readonly deliveryId: string | null;
  readonly eventName: string;
  readonly action: string | null;
  readonly repoId: number | null;
  readonly sender: string | null;
  readonly issueNumber: number | null;
  readonly prNumber: number | null;
  readonly branch: string | null;
  readonly taskId: string | null;
  readonly workerId: string | null;
  readonly payload: Record<string, unknown>;
  readonly receivedAt: string;

  private constructor(row: Row) {
    super();
    this.id = row.id;
    this.deliveryId = row.delivery_id;
    this.eventName = row.event_name;
    this.action = row.action;
    this.repoId = row.repo_id;
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
    const issueNumber = typeof (payload.issue as R | undefined)?.number === "number"
      ? (payload.issue as R).number as number : null;
    const prNumber = typeof (payload.pull_request as R | undefined)?.number === "number"
      ? (payload.pull_request as R).number as number : null;
    const sender = typeof (payload.sender as R | undefined)?.login === "string"
      ? (payload.sender as R).login as string : null;
    return new WebhookEvent({
      delivery_id: deliveryId,
      event_name: eventName,
      action,
      repo_id: null,
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

  /** Insert into webhook_events. Returns a promise (usually ignored with `void`). */
  static log(data: {
    deliveryId: string | null;
    eventName: string;
    action: string | null;
    repoId: number | null;
    sender: string | null;
    issueNumber: number | null;
    prNumber: number | null;
    branch: string | null;
    taskId: string | null;
    workerId: string | null;
    payload: Record<string, unknown>;
  }): Promise<void> {
    return WebhookEvent.insert({
      delivery_id: data.deliveryId,
      event_name: data.eventName,
      action: data.action,
      repo_id: data.repoId,
      sender: data.sender,
      issue_number: data.issueNumber,
      pr_number: data.prNumber,
      branch: data.branch,
      task_id: data.taskId,
      worker_id: data.workerId,
      payload: data.payload as Json,
    }).then(() => undefined).catch((err: unknown) => log(`[db] webhook_events insert error: ${fmtError(err)}`));
  }

  // ── Queries ──────────────────────────────────────────────────────────────────

  static async queryForTask(taskId: string, opts: { limit?: number; before?: string } = {}): Promise<WebhookEvent[]> {
    let query = WebhookEvent.select()
      .eq("task_id", taskId)
      .order("received_at", { ascending: false });
    if (opts.before) query = query.lt("received_at", opts.before);
    const { data } = await query.limit(opts.limit ?? 500);
    return (data ?? []).map((r: Row) => new WebhookEvent(r));
  }

  static async queryForWorker(workerId: string, opts: { limit?: number; before?: string } = {}): Promise<WebhookEvent[]> {
    let query = WebhookEvent.select()
      .eq("worker_id", workerId)
      .order("received_at", { ascending: false });
    if (opts.before) query = query.lt("received_at", opts.before);
    const { data } = await query.limit(opts.limit ?? 500);
    return (data ?? []).map((r: Row) => new WebhookEvent(r));
  }

  static async queryForRepo(repoId: number, opts: { limit?: number; before?: string } = {}): Promise<WebhookEvent[]> {
    let query = WebhookEvent.select()
      .eq("repo_id", repoId)
      .order("received_at", { ascending: false });
    if (opts.before) query = query.lt("received_at", opts.before);
    const { data } = await query.limit(opts.limit ?? 500);
    return (data ?? []).map((r: Row) => new WebhookEvent(r));
  }

  static async list(opts: { limit?: number; before?: string } = {}): Promise<WebhookEvent[]> {
    let query = WebhookEvent.select().order("received_at", { ascending: false });
    if (opts.before) query = query.lt("received_at", opts.before);
    const { data } = await query.limit(opts.limit ?? 100);
    return (data ?? []).map((r: Row) => new WebhookEvent(r));
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
    return fmtEvent(this.toWorkerPayload());
  }

  /** True if this event type should not appear in the foreman log. */
  isMuted(): boolean {
    return this.eventName === "workflow_job" || this.eventName === "workflow_run";
  }

  /** One-line summary for foreman log output. */
  summary(): string {
    const p = this.payload;
    const name = this.eventName;
    const action = typeof p.action === "string" ? `/${p.action}` : "";
    const repo = (p.repository as Record<string, unknown> | undefined)?.full_name;
    const sender = (p.sender as Record<string, unknown> | undefined)?.login;

    let detail = "";
    const issue = p.issue as Record<string, unknown> | undefined;
    const pr = p.pull_request as Record<string, unknown> | undefined;

    if (issue) {
      detail = ` #${issue.number} "${truncTitle(issue.title)}"`;
    } else if (pr) {
      detail = ` #${pr.number} "${truncTitle(pr.title)}"`;
    } else if (name === "push") {
      const ref = String(p.ref ?? "");
      const count = (p.commits as unknown[] | undefined)?.length ?? 0;
      detail = ` ${ref} (${count} commit${count === 1 ? "" : "s"})`;
    } else if (name === "delete") {
      const ref = String(p.ref ?? "");
      if (ref) detail = ` ${ref}`;
    } else if (name === "check_run" || name === "check_suite" || name === "workflow_run" || name === "workflow_job") {
      const inner = p[name] as Record<string, unknown> | undefined;
      const prs = inner?.pull_requests as Array<{ number: number }> | undefined;
      if (prs && prs.length > 0) {
        detail = ` PR #${prs[0].number}`;
      } else {
        const headBranch = name === "check_run"
          ? String((inner?.check_suite as Record<string, unknown> | undefined)?.head_branch ?? "")
          : String(inner?.head_branch ?? "");
        if (headBranch) detail = ` ${headBranch}`;
      }
    }

    const parts: string[] = [`${name}${action}${detail}`];
    if (sender) parts.push(`by ${sender}`);
    if (repo) parts.push(`(${repo})`);
    return `[event] ${parts.join(" ")}`;
  }
}

function truncTitle(title: unknown, max = 50): string {
  const s = String(title ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
