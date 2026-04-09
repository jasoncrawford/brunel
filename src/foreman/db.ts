import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "../database.types.js";

type Row<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];
import { fmtEvent } from "./event-fmt.js";

// ── Input types ────────────────────────────────────────────────────────────────

export interface WebhookEventData {
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
}

export interface ForemanMessageData {
  direction: "sent" | "received";
  workerId: string | null;
  taskId: string | null;
  msgType: string;
  payload: Record<string, unknown>;
}

// ── Output types ───────────────────────────────────────────────────────────────

export interface LogEntry {
  kind: "webhook" | "message";
  id: number;
  timestamp: string;
  taskId: string | null;
  workerId: string | null;
  summary: string;
}

export interface QueryLogOpts {
  limit?: number;
  taskId?: string;
  workerId?: string;
}

// ── Interface ──────────────────────────────────────────────────────────────────

export interface DbLogger {
  logWebhookEvent(data: WebhookEventData): void;
  logForemanMessage(data: ForemanMessageData): void;
  queryLog(opts: QueryLogOpts): Promise<LogEntry[]>;
  queryTaskEvents(taskId: string): Promise<LogEntry[]>;
  queryWorkerMessages(workerId: string): Promise<LogEntry[]>;
}

// ── Shared summary builder (used by both db.ts and wss.ts) ─────────────────

export function buildMessageSummary(
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

// ── Real implementation ────────────────────────────────────────────────────────

export function createDbLogger(supabase: SupabaseClient<Database>): DbLogger {
  function fire(promise: PromiseLike<{ error: unknown }>) {
    Promise.resolve(promise).then(({ error }) => {
      if (error) console.error("[db] insert error:", error);
    }).catch((err: unknown) => console.error("[db] unexpected error:", err));
  }

  function webhookToEntry(row: Row<"webhook_events">): LogEntry {
    // Merge row-level action as fallback for old rows without stored payload
    const payload: Record<string, unknown> = { action: row.action, ...(row.payload as Record<string, unknown>) };
    const summary = fmtEvent({ id: row.delivery_id ?? "", name: row.event_name, payload });
    return {
      kind: "webhook",
      id: row.id,
      timestamp: row.received_at,
      taskId: row.task_id,
      workerId: row.worker_id,
      summary,
    };
  }

  function messageToEntry(row: Row<"foreman_messages">): LogEntry {
    const payload = row.payload as Record<string, unknown>;
    const summary = buildMessageSummary(row.direction, row.msg_type, row.task_id, payload);
    return {
      kind: "message",
      id: row.id,
      timestamp: row.created_at,
      taskId: row.task_id,
      workerId: row.worker_id,
      summary,
    };
  }

  return {
    logWebhookEvent(data) {
      fire(supabase.from("webhook_events").insert({
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
      }));
    },

    logForemanMessage(data) {
      fire(supabase.from("foreman_messages").insert({
        direction: data.direction,
        worker_id: data.workerId,
        task_id: data.taskId,
        msg_type: data.msgType,
        payload: data.payload as Json,
      }));
    },

    async queryLog(opts) {
      const limit = opts.limit ?? 100;
      const [wRes, mRes] = await Promise.all([
        supabase.from("webhook_events")
          .select("*")
          .order("received_at", { ascending: false })
          .limit(limit),
        supabase.from("foreman_messages")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(limit),
      ]);
      const webhooks = (wRes.data ?? []).map(webhookToEntry);
      const messages = (mRes.data ?? []).map(messageToEntry);
      return [...webhooks, ...messages]
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, limit);
    },

    async queryTaskEvents(taskId) {
      const [wRes, mRes] = await Promise.all([
        supabase.from("webhook_events")
          .select("*")
          .eq("task_id", taskId)
          .order("received_at", { ascending: false })
          .limit(500),
        supabase.from("foreman_messages")
          .select("*")
          .eq("task_id", taskId)
          .order("created_at", { ascending: false })
          .limit(500),
      ]);
      const webhooks = (wRes.data ?? []).map(webhookToEntry);
      const messages = (mRes.data ?? []).map(messageToEntry);
      return [...webhooks, ...messages]
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    },

    async queryWorkerMessages(workerId) {
      const [wRes, mRes] = await Promise.all([
        supabase.from("webhook_events")
          .select("*")
          .eq("worker_id", workerId)
          .order("received_at", { ascending: false })
          .limit(500),
        supabase.from("foreman_messages")
          .select("*")
          .eq("worker_id", workerId)
          .order("created_at", { ascending: false })
          .limit(500),
      ]);
      const webhooks = (wRes.data ?? []).map(webhookToEntry);
      const messages = (mRes.data ?? []).map(messageToEntry);
      return [...webhooks, ...messages]
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    },
  };
}

// ── Null implementation (no Supabase configured) ───────────────────────────────

export function createNullDbLogger(): DbLogger {
  return {
    logWebhookEvent() {},
    logForemanMessage() {},
    async queryLog() { return []; },
    async queryTaskEvents() { return []; },
    async queryWorkerMessages() { return []; },
  };
}
