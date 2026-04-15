import type { Json } from "../../database.types.js";
import type { DbRow } from "../clients/db-client.js";
import * as Wire from "../../../shared/wire.js";
import { ActiveRecord } from "./active-record.js";

type Row = DbRow<"webhook_events">;

// ── Model ──────────────────────────────────────────────────────────────────────

export class WebhookEvent extends ActiveRecord {
  protected static readonly tableName = "webhook_events";
  protected static readonly primaryKey = "id";

  readonly id: number | undefined;
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

  private constructor(row: Row) {
    super();
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

  /** Insert into webhook_events. Returns a promise (usually ignored with `void`). */
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
    return WebhookEvent.insert({
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
    }).then(() => undefined).catch((err: unknown) => console.error("[db] webhook_events insert error:", err));
  }

  // ── Queries ──────────────────────────────────────────────────────────────────

  static async queryForTask(taskId: string): Promise<WebhookEvent[]> {
    const { data } = await WebhookEvent.select()
      .eq("task_id", taskId)
      .order("received_at", { ascending: false })
      .limit(500);
    return (data ?? []).map((r: Row) => new WebhookEvent(r));
  }

  static async queryForWorker(workerId: string): Promise<WebhookEvent[]> {
    const { data } = await WebhookEvent.select()
      .eq("worker_id", workerId)
      .order("received_at", { ascending: false })
      .limit(500);
    return (data ?? []).map((r: Row) => new WebhookEvent(r));
  }

  static async list(opts: { limit?: number } = {}): Promise<WebhookEvent[]> {
    const { data } = await WebhookEvent.select()
      .order("received_at", { ascending: false })
      .limit(opts.limit ?? 100);
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
    const nameAction = `${this.eventName}${this.payload["action"] ? `/${this.payload["action"]}` : ""}`;
    const details = WebhookEvent.fmtEventDetails(this.eventName, this.payload);
    return `${nameAction}${details ? ` — ${details}` : ""}`;
  }

  /** True if this event type should not appear in the foreman log. */
  isMuted(): boolean {
    return this.eventName === "workflow_job" || this.eventName === "workflow_run";
  }

  private static fmtEventDetails(name: string, p: Record<string, unknown>): string {
    switch (name) {
      case "check_run": {
        const run = asObj(p.check_run) as CheckRun | null;
        if (!run) return "";
        const status = str(run.conclusion || run.status);
        return `"${str(run.name)}" ${status}`.trim();
      }
      case "check_suite": {
        const suite = asObj(p.check_suite) as CheckSuite | null;
        if (!suite) return "";
        return str(suite.conclusion || suite.status).trim();
      }
      case "issue_comment":
      case "pull_request_review_comment": {
        const comment = asObj(p.comment) as Comment | null;
        return comment?.body ? `"${trunc(str(comment.body), 60)}"` : "";
      }
      case "pull_request_review": {
        const review = asObj(p.review) as Review | null;
        if (!review) return "";
        const parts: string[] = [str(review.state)];
        if (review.body) parts.push(`"${trunc(str(review.body), 40)}"`);
        return parts.filter(Boolean).join(" ");
      }
      case "pull_request": {
        const pr = asObj(p.pull_request) as PullRequest | null;
        if (!pr) return "";
        return `#${num(pr.number)} "${trunc(str(pr.title), 50)}"`;
      }
      case "push": {
        const commits = Array.isArray(p.commits) ? p.commits : [];
        return `${commits.length} commit${commits.length === 1 ? "" : "s"} to ${str(p.ref) || "?"}`;
      }
      case "workflow_run": {
        const run = asObj(p.workflow_run) as WorkflowRun | null;
        if (!run) return "";
        const status = str(run.conclusion || run.status);
        return `"${str(run.name)}" ${status}`.trim();
      }
      case "delete": {
        const refType = str(p.ref_type);
        const ref = str(p.ref);
        return `${refType} ${ref}`.trim();
      }
      case "issues": {
        const label = asObj(p.label) as { name?: string } | null;
        return label?.name ? `label: ${label.name}` : "";
      }
      default:
        return "";
    }
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

// ── Event formatting helpers (foreman-side copy of display.ts formatting) ────
// These live here so the foreman module has zero imports from display.ts,
// which is a TUI module that belongs to the agent/worker side.

interface CheckRun { name: string; conclusion: string | null; status: string }
interface CheckSuite { conclusion: string | null; status: string }
interface Comment { body: string }
interface Review { state: string; body: string }
interface PullRequest { number: number; title: string }
interface WorkflowRun { name: string; conclusion: string | null; status: string }

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string { return typeof v === "string" ? v : ""; }
function num(v: unknown): number { return typeof v === "number" ? v : 0; }

function trunc(s: string, n = 80) {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
