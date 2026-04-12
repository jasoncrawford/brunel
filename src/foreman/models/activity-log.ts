import type { LogEntry } from "../../../shared/wire.js";
import { WebhookEvent } from "./webhook-event.js";
import { ForemanMessage } from "./foreman-message.js";

// ── Cross-table activity log query ─────────────────────────────────────────────
// Merges webhook_events and foreman_messages by timestamp for the admin dashboard.

export interface QueryActivityLogOpts {
  limit?: number;
  taskId?: string;
  workerId?: string;
}

export async function queryActivityLog(opts: QueryActivityLogOpts = {}): Promise<LogEntry[]> {
  const limit = opts.limit ?? 100;
  let webhooks: WebhookEvent[];
  let messages: ForemanMessage[];

  if (opts.taskId) {
    [webhooks, messages] = await Promise.all([
      WebhookEvent.queryForTask(opts.taskId),
      ForemanMessage.queryForTask(opts.taskId),
    ]);
  } else if (opts.workerId) {
    [webhooks, messages] = await Promise.all([
      WebhookEvent.queryForWorker(opts.workerId),
      ForemanMessage.queryForWorker(opts.workerId),
    ]);
  } else {
    [webhooks, messages] = await Promise.all([
      WebhookEvent.query({ limit }),
      ForemanMessage.query({ limit }),
    ]);
  }

  const entries: LogEntry[] = [
    ...webhooks.map((w) => ({
      kind: "webhook" as const,
      id: w.id,
      timestamp: w.receivedAt,
      taskId: w.taskId,
      workerId: w.workerId,
      summary: w.format(),
    })),
    ...messages.map((m) => ({
      kind: "message" as const,
      id: m.id,
      timestamp: m.createdAt,
      taskId: m.taskId,
      workerId: m.workerId,
      summary: m.format(),
    })),
  ];

  return entries
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);
}
