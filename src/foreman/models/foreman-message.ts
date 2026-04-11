import type { Database, Json } from "../../database.types.js";
import { db } from "../db-client.js";

type DbRow = Database["public"]["Tables"]["foreman_messages"]["Row"];

// ── Input type ─────────────────────────────────────────────────────────────────

export interface ForemanMessageData {
  direction: "sent" | "received";
  workerId: string | null;
  taskId: string | null;
  msgType: string;
  payload: Record<string, unknown>;
}

// ── Model ──────────────────────────────────────────────────────────────────────

export class ForemanMessage {
  readonly id: number;
  readonly createdAt: string;
  readonly direction: string;
  readonly workerId: string | null;
  readonly taskId: string | null;
  readonly msgType: string;
  readonly payload: Record<string, unknown>;

  private constructor(row: DbRow) {
    this.id = row.id;
    this.createdAt = row.created_at;
    this.direction = row.direction;
    this.workerId = row.worker_id;
    this.taskId = row.task_id;
    this.msgType = row.msg_type;
    this.payload = (row.payload as Record<string, unknown>) ?? {};
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  /** Fire-and-forget insert into foreman_messages. No-op if DB is not initialized. */
  static log(data: ForemanMessageData): void {
    try {
      if (!db) return;
      void Promise.resolve(db.from("foreman_messages").insert({
        direction: data.direction,
        worker_id: data.workerId,
        task_id: data.taskId,
        msg_type: data.msgType,
        payload: data.payload as Json,
      })).then(({ error }) => {
        if (error) console.error("[db] foreman_messages insert error:", error);
      }).catch((err: unknown) => console.error("[db] unexpected error:", err));
    } catch {
      // Silently ignore if DB is not available
    }
  }

  // ── Queries ──────────────────────────────────────────────────────────────────

  static async queryForTask(taskId: string): Promise<ForemanMessage[]> {
    const { data } = await db.from("foreman_messages")
      .select("*")
      .eq("task_id", taskId)
      .order("created_at", { ascending: false })
      .limit(500);
    return (data ?? []).map((r) => new ForemanMessage(r));
  }

  static async queryForWorker(workerId: string): Promise<ForemanMessage[]> {
    const { data } = await db.from("foreman_messages")
      .select("*")
      .eq("worker_id", workerId)
      .order("created_at", { ascending: false })
      .limit(500);
    return (data ?? []).map((r) => new ForemanMessage(r));
  }

  static async query(opts: { limit?: number } = {}): Promise<ForemanMessage[]> {
    const { data } = await db.from("foreman_messages")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(opts.limit ?? 100);
    return (data ?? []).map((r) => new ForemanMessage(r));
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
    if (msgType === "worker_disconnected") {
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
