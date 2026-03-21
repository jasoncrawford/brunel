import type { SupabaseClient } from "@supabase/supabase-js";

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

// ── Real implementation ────────────────────────────────────────────────────────

export function createDbLogger(supabase: SupabaseClient): DbLogger {
  function fire(promise: Promise<{ error: unknown }>) {
    promise.then(({ error }) => {
      if (error) console.error("[db] insert error:", error);
    }).catch((err: unknown) => console.error("[db] unexpected error:", err));
  }

  function webhookToEntry(row: Record<string, unknown>): LogEntry {
    const action = row.action ? `/${row.action}` : "";
    const issue = row.issue_number ? ` #${row.issue_number}` : "";
    return {
      kind: "webhook",
      id: row.id as number,
      timestamp: row.received_at as string,
      taskId: (row.task_id as string | null) ?? null,
      workerId: null,
      summary: `${row.event_name}${action}${issue}`,
    };
  }

  function messageToEntry(row: Record<string, unknown>): LogEntry {
    return {
      kind: "message",
      id: row.id as number,
      timestamp: row.created_at as string,
      taskId: (row.task_id as string | null) ?? null,
      workerId: (row.worker_id as string | null) ?? null,
      summary: `${row.direction} ${row.msg_type}`,
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
        payload: data.payload,
      }));
    },

    logForemanMessage(data) {
      fire(supabase.from("foreman_messages").insert({
        direction: data.direction,
        worker_id: data.workerId,
        task_id: data.taskId,
        msg_type: data.msgType,
        payload: data.payload,
      }));
    },

    async queryLog(opts) {
      const limit = opts.limit ?? 100;
      const [wRes, mRes] = await Promise.all([
        supabase.from("webhook_events")
          .select("id, received_at, event_name, action, issue_number, task_id")
          .order("received_at", { ascending: false })
          .limit(limit),
        supabase.from("foreman_messages")
          .select("id, created_at, direction, worker_id, task_id, msg_type")
          .order("created_at", { ascending: false })
          .limit(limit),
      ]);
      const webhooks = ((wRes.data ?? []) as Record<string, unknown>[]).map(webhookToEntry);
      const messages = ((mRes.data ?? []) as Record<string, unknown>[]).map(messageToEntry);
      return [...webhooks, ...messages]
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, limit);
    },

    async queryTaskEvents(taskId) {
      const [wRes, mRes] = await Promise.all([
        supabase.from("webhook_events")
          .select("id, received_at, event_name, action, issue_number, task_id")
          .eq("task_id", taskId)
          .order("received_at", { ascending: true })
          .limit(500),
        supabase.from("foreman_messages")
          .select("id, created_at, direction, worker_id, task_id, msg_type")
          .eq("task_id", taskId)
          .order("created_at", { ascending: true })
          .limit(500),
      ]);
      const webhooks = ((wRes.data ?? []) as Record<string, unknown>[]).map(webhookToEntry);
      const messages = ((mRes.data ?? []) as Record<string, unknown>[]).map(messageToEntry);
      return [...webhooks, ...messages]
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    },

    async queryWorkerMessages(workerId) {
      const { data } = await supabase.from("foreman_messages")
        .select("id, created_at, direction, worker_id, task_id, msg_type")
        .eq("worker_id", workerId)
        .order("created_at", { ascending: false })
        .limit(500);
      return ((data ?? []) as Record<string, unknown>[]).map(messageToEntry);
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
