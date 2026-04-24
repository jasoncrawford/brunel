import type { LogEntry } from "../../../shared/wire.js";
import { WebhookEvent } from "./webhook-event.js";
import { ForemanMessage } from "./foreman-message.js";
import { Repo } from "./repo.js";

// ── Cross-table activity log query ─────────────────────────────────────────────
// Merges webhook_events and foreman_messages by timestamp for the admin dashboard.

export interface QueryActivityLogOpts {
  limit?: number;
  taskId?: string;
  workerId?: string;
  repoId?: number;
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
  } else if (opts.repoId != null) {
    [webhooks, messages] = await Promise.all([
      WebhookEvent.queryForRepo(opts.repoId),
      ForemanMessage.queryForRepo(opts.repoId),
    ]);
  } else {
    [webhooks, messages] = await Promise.all([
      WebhookEvent.list({ limit }),
      ForemanMessage.list({ limit }),
    ]);
  }

  // Build a repoId → fullName map for annotating log entries
  const repoIds = new Set<number>();
  webhooks.forEach((w) => { if (w.repoId != null) repoIds.add(w.repoId); });
  messages.forEach((m) => { if (m.repoId != null) repoIds.add(m.repoId); });
  const repoMap = new Map<number, string>();
  if (repoIds.size > 0) {
    const repos = await Repo.list();
    repos.forEach((r) => repoMap.set(r.id, r.fullName));
  }

  const entries: LogEntry[] = [
    ...webhooks.map((w) => ({
      kind: "webhook" as const,
      id: w.id,
      timestamp: w.receivedAt,
      taskId: w.taskId,
      workerId: w.workerId,
      repo: w.repoId != null ? repoMap.get(w.repoId) : undefined,
      summary: w.format(),
    })),
    ...messages.map((m) => ({
      kind: "message" as const,
      id: m.id,
      timestamp: m.createdAt,
      taskId: m.taskId,
      workerId: m.workerId,
      repo: m.repoId != null ? repoMap.get(m.repoId) : undefined,
      summary: m.format(),
    })),
  ];

  return entries
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);
}
