import type { Database, Json } from "../../database.types.js";
import { ActiveRecord } from "./active-record.js";
import { log, fmtError } from "../../utils.js";

type DbRow = Database["public"]["Tables"]["foreman_messages"]["Row"];

// ── Model ──────────────────────────────────────────────────────────────────────

export class ForemanMessage extends ActiveRecord {
  protected static readonly tableName = "foreman_messages";
  protected static readonly primaryKey = "id";

  readonly id: number;
  readonly createdAt: string;
  readonly direction: string;
  readonly workerId: string | null;
  readonly taskId: string | null;
  readonly repoId: number | null;
  readonly msgType: string;
  readonly payload: Record<string, unknown>;

  private constructor(row: DbRow) {
    super();
    this.id = row.id;
    this.createdAt = row.created_at;
    this.direction = row.direction;
    this.workerId = row.worker_id;
    this.taskId = row.task_id;
    this.repoId = row.repo_id;
    this.msgType = row.msg_type;
    this.payload = (row.payload as Record<string, unknown>) ?? {};
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  /** Insert into foreman_messages. Returns a promise (usually ignored with `void`). */
  static log(data: {
    direction: "sent" | "received";
    workerId: string | null;
    taskId: string | null;
    repoId?: number | null;
    msgType: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    return ForemanMessage.insert({
      direction: data.direction,
      worker_id: data.workerId,
      task_id: data.taskId,
      repo_id: data.repoId ?? null,
      msg_type: data.msgType,
      payload: data.payload as Json,
    }).then(() => undefined).catch((err: unknown) => log(`[db] foreman_messages insert error: ${fmtError(err)}`));
  }

  // ── Queries ──────────────────────────────────────────────────────────────────

  static async queryForTask(taskId: string): Promise<ForemanMessage[]> {
    const { data } = await ForemanMessage.select()
      .eq("task_id", taskId)
      .order("created_at", { ascending: false })
      .limit(500);
    return (data ?? []).map((r: DbRow) => new ForemanMessage(r));
  }

  static async queryForWorker(workerId: string): Promise<ForemanMessage[]> {
    const { data } = await ForemanMessage.select()
      .eq("worker_id", workerId)
      .order("created_at", { ascending: false })
      .limit(500);
    return (data ?? []).map((r: DbRow) => new ForemanMessage(r));
  }

  static async list(opts: { limit?: number } = {}): Promise<ForemanMessage[]> {
    const { data } = await ForemanMessage.select()
      .order("created_at", { ascending: false })
      .limit(opts.limit ?? 100);
    return (data ?? []).map((r: DbRow) => new ForemanMessage(r));
  }

  // ── Display helper ───────────────────────────────────────────────────────────

  /** Human-readable summary for the admin dashboard log. */
  format(): string {
    return ForemanMessage.buildSummary(this.direction, this.msgType, this.taskId, this.payload);
  }

  // ── Shared summary builder (single source of truth for log entry summaries) ──

  static buildSummary(
    direction: string,
    msgType: string,
    taskId: string | null,
    payload: Record<string, unknown>,
  ): string {
    if (msgType === "foreman_error") {
      const fatalStr = payload.fatal ? " (fatal)" : "";
      return `sent foreman_error${fatalStr}: ${payload.message ?? ""}`;
    } else if (msgType === "worker_disconnected") {
      const reason = payload.reason ? `: ${payload.reason}` : "";
      return `disconnected (code ${payload.code}${reason})`;
    } else if (msgType === "worker_hello") {
      const status = String(payload.status ?? "");
      const taskIdStr = taskId ? ` task=#${taskId}` : "";
      return `${direction} worker_hello — ${status}${taskIdStr}`;
    } else if (msgType === "hello_ack") {
      const status = String(payload.status ?? "");
      const taskIdStr = taskId ? ` task=#${taskId}` : "";
      return `${direction} hello_ack — ${status}${taskIdStr}`;
    } else if (msgType === "event_notification") {
      const event = (payload.event ?? {}) as Record<string, unknown>;
      const eventName = event.name ? ` — ${event.name}` : "";
      return `${direction} event_notification${eventName}`;
    } else {
      return `${direction} ${msgType}`;
    }
  }
}
