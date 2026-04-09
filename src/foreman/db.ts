import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "../database.types.js";
import { fmtEvent } from "./event-fmt.js";
import type { TaskStatus } from "../types.js";

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

  type WebhookRow = Pick<Database["public"]["Tables"]["webhook_events"]["Row"],
    "id" | "received_at" | "delivery_id" | "event_name" | "action" | "issue_number" | "task_id" | "worker_id" | "payload">;

  type MessageRow = Pick<Database["public"]["Tables"]["foreman_messages"]["Row"],
    "id" | "created_at" | "direction" | "worker_id" | "task_id" | "msg_type" | "payload">;

  function webhookToEntry(row: WebhookRow): LogEntry {
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

  function messageToEntry(row: MessageRow): LogEntry {
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
          .select("id, received_at, delivery_id, event_name, action, issue_number, task_id, worker_id, payload")
          .order("received_at", { ascending: false })
          .limit(limit),
        supabase.from("foreman_messages")
          .select("id, created_at, direction, worker_id, task_id, msg_type, payload")
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
          .select("id, received_at, delivery_id, event_name, action, issue_number, task_id, worker_id, payload")
          .eq("task_id", taskId)
          .order("received_at", { ascending: false })
          .limit(500),
        supabase.from("foreman_messages")
          .select("id, created_at, direction, worker_id, task_id, msg_type, payload")
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
          .select("id, received_at, delivery_id, event_name, action, issue_number, task_id, worker_id, payload")
          .eq("worker_id", workerId)
          .order("received_at", { ascending: false })
          .limit(500),
        supabase.from("foreman_messages")
          .select("id, created_at, direction, worker_id, task_id, msg_type, payload")
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

// ── TaskStore ──────────────────────────────────────────────────────────────────

export interface TaskRow {
  taskId: string;
  issueNumber: number;
  repo: string;
  title: string;
  body: string;
  labels: string[];
  workerId: string | null;
  prNumber: number | null;
  branch: string | null;
  createdAt: string;
  assignedAt: string | null;
  completedAt: string | null;
  issueClosedAt: string | null;
  prMergedAt: string | null;
}

export interface ListTasksOpts {
  cancelable?: boolean;  // if true, only return tasks that can be deleted (never assigned)
  limit?: number;
}

export interface TaskStore {
  /** Upsert task: insert with all timestamps/status fields null, or on re-label reset an existing row
   * and refresh title/body/labels, clearing assigned_at/completed_at/issue_closed_at/pr_merged_at/worker_id. */
  upsertTask(taskId: string, issueNumber: number, repo: string, title: string, body: string, labels: string[]): Promise<void>;
  /** Refresh title/body/labels for an existing task without touching status or assignment. */
  updateTaskContent(taskId: string, title: string, body: string, labels: string[]): Promise<void>;
  /** Mark task as assigned to a worker. */
  markAssigned(taskId: string, workerId: string): Promise<void>;
  /** Mark task as complete by the worker. */
  markComplete(taskId: string): Promise<void>;
  /** Revert task to pending, clearing worker_id. */
  markPending(taskId: string): Promise<void>;
  /** Record that the issue was closed. */
  setIssueClosed(taskId: string): Promise<void>;
  /** Clear the issue closed marker (when issue is reopened). */
  clearIssueClosed(taskId: string): Promise<void>;
  /** Record that the PR was merged. */
  setPrMerged(taskId: string): Promise<void>;
  /** Delete the task row entirely (e.g. when brunel:ready label is removed). */
  deleteTask(taskId: string): Promise<void>;
  /** Update PR number and branch for a task. Pass null to clear. */
  updateTaskPr(taskId: string, prNumber: number | null, branch: string | null): Promise<void>;
  /** Fetch a single task by ID, or null if not found. */
  getTask(taskId: string): Promise<TaskRow | null>;
  /** Find a task by issue number, or null if not found. */
  getTaskByIssue(issueNumber: number): Promise<TaskRow | null>;
  /** Find a task by PR number, or null if not found. */
  getTaskByPr(prNumber: number): Promise<TaskRow | null>;
  /** Find the assigned task for a worker, or null if none. */
  getTaskByWorker(workerId: string): Promise<TaskRow | null>;
  /** List tasks, optionally filtered. */
  listTasks(opts?: ListTasksOpts): Promise<TaskRow[]>;
}

export function createTaskStore(supabase: SupabaseClient<Database>): TaskStore {
  function rowToTaskRow(row: Database["public"]["Tables"]["tasks"]["Row"]): TaskRow {
    return {
      taskId: row.task_id,
      issueNumber: row.issue_number,
      repo: row.repo,
      title: row.title,
      body: row.body,
      labels: row.labels,
      workerId: row.worker_id,
      prNumber: row.pr_number,
      branch: row.branch,
      createdAt: row.created_at,
      assignedAt: row.assigned_at,
      completedAt: row.completed_at,
      issueClosedAt: row.issue_closed_at,
      prMergedAt: row.pr_merged_at,
    };
  }

  return {
    async upsertTask(taskId, issueNumber, repo, title, body, labels) {
      // Real upsert: on re-label of a completed issue, reset all status markers.
      // Each labeling of an issue acts like a fresh task.
      const { error } = await supabase.from("tasks").upsert(
        {
          task_id: taskId,
          issue_number: issueNumber,
          repo,
          title,
          body,
          labels,
          worker_id: null,
          assigned_at: null,
          completed_at: null,
          issue_closed_at: null,
          pr_merged_at: null,
        },
        { onConflict: "task_id" },
      );
      if (error) throw error;
    },

    async updateTaskContent(taskId, title, body, labels) {
      const { error } = await supabase.from("tasks")
        .update({ title, body, labels })
        .eq("task_id", taskId);
      if (error) throw error;
    },

    async markAssigned(taskId, workerId) {
      const { error } = await supabase.from("tasks")
        .update({ worker_id: workerId, assigned_at: new Date().toISOString() })
        .eq("task_id", taskId);
      if (error) throw error;
    },

    async markComplete(taskId) {
      const { error } = await supabase.from("tasks")
        .update({ completed_at: new Date().toISOString() })
        .eq("task_id", taskId);
      if (error) throw error;
    },

    async markPending(taskId) {
      const { error } = await supabase.from("tasks")
        .update({ worker_id: null })
        .eq("task_id", taskId);
      if (error) throw error;
    },

    async setIssueClosed(taskId) {
      const { error } = await supabase.from("tasks")
        .update({ issue_closed_at: new Date().toISOString() })
        .eq("task_id", taskId);
      if (error) throw error;
    },

    async clearIssueClosed(taskId) {
      const { error } = await supabase.from("tasks")
        .update({ issue_closed_at: null })
        .eq("task_id", taskId);
      if (error) throw error;
    },

    async setPrMerged(taskId) {
      const { error } = await supabase.from("tasks")
        .update({ pr_merged_at: new Date().toISOString() })
        .eq("task_id", taskId);
      if (error) throw error;
    },

    async deleteTask(taskId) {
      // Only delete rows that were never assigned — tasks that had a previous worker
      // (assigned_at IS NOT NULL) retain their history. markPending() leaves assigned_at
      // intact when reverting a worker_goodbye, so this guard is reliable.
      const { error } = await supabase.from("tasks")
        .delete()
        .eq("task_id", taskId)
        .is("assigned_at", null);
      if (error) throw error;
    },

    async updateTaskPr(taskId, prNumber, branch) {
      const { error } = await supabase.from("tasks")
        .update({ pr_number: prNumber, branch })
        .eq("task_id", taskId);
      if (error) throw error;
    },

    async getTask(taskId) {
      const { data, error } = await supabase.from("tasks")
        .select("task_id, issue_number, repo, title, body, labels, worker_id, pr_number, branch, created_at, assigned_at, completed_at, issue_closed_at, pr_merged_at")
        .eq("task_id", taskId)
        .maybeSingle();
      if (error) throw error;
      return data ? rowToTaskRow(data) : null;
    },

    async getTaskByIssue(issueNumber) {
      const { data, error } = await supabase.from("tasks")
        .select("task_id, issue_number, repo, title, body, labels, worker_id, pr_number, branch, created_at, assigned_at, completed_at, issue_closed_at, pr_merged_at")
        .eq("issue_number", issueNumber)
        .maybeSingle();
      if (error) throw error;
      return data ? rowToTaskRow(data) : null;
    },

    async getTaskByPr(prNumber) {
      const { data, error } = await supabase.from("tasks")
        .select("task_id, issue_number, repo, title, body, labels, worker_id, pr_number, branch, created_at, assigned_at, completed_at, issue_closed_at, pr_merged_at")
        .eq("pr_number", prNumber)
        .maybeSingle();
      if (error) throw error;
      return data ? rowToTaskRow(data) : null;
    },

    async getTaskByWorker(workerId) {
      const { data, error } = await supabase.from("tasks")
        .select("task_id, issue_number, repo, title, body, labels, worker_id, pr_number, branch, created_at, assigned_at, completed_at, issue_closed_at, pr_merged_at")
        .eq("worker_id", workerId)
        .is("completed_at", null)
        .maybeSingle();
      if (error) throw error;
      return data ? rowToTaskRow(data) : null;
    },

    async listTasks(opts) {
      const limit = opts?.limit ?? 200;
      let q = supabase.from("tasks").select(
        "task_id, issue_number, repo, title, body, labels, worker_id, pr_number, branch, created_at, assigned_at, completed_at, issue_closed_at, pr_merged_at"
      );
      if (opts?.cancelable) {
        q = q.is("worker_id", null)
          .is("completed_at", null)
          .is("issue_closed_at", null)
          .is("pr_merged_at", null);
      }
      const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return (data ?? []).map(rowToTaskRow);
    },
  };
}

/** In-memory implementation of TaskStore — used when no Supabase is configured
 *  and as the backing store for tests. This is NOT a cache; it's the sole source
 *  of truth when used (no dual-write, no drift). */
export function createMemoryTaskStore(): TaskStore {
  const tasks = new Map<string, TaskRow>();

  return {
    async upsertTask(taskId, issueNumber, repo, title, body, labels) {
      tasks.set(taskId, {
        taskId, issueNumber, repo, title, body, labels,
        workerId: null, prNumber: null, branch: null,
        createdAt: new Date().toISOString(),
        assignedAt: null, completedAt: null, issueClosedAt: null, prMergedAt: null,
      });
    },
    async updateTaskContent(taskId, title, body, labels) {
      const t = tasks.get(taskId);
      if (t) { t.title = title; t.body = body; t.labels = labels; }
    },
    async markAssigned(taskId, workerId) {
      const t = tasks.get(taskId);
      if (t) { t.workerId = workerId; t.assignedAt = new Date().toISOString(); }
    },
    async markComplete(taskId) {
      const t = tasks.get(taskId);
      if (t) { t.completedAt = new Date().toISOString(); }
    },
    async markPending(taskId) {
      const t = tasks.get(taskId);
      if (t) { t.workerId = null; }
    },
    async setIssueClosed(taskId) {
      const t = tasks.get(taskId);
      if (t) { t.issueClosedAt = new Date().toISOString(); }
    },
    async clearIssueClosed(taskId) {
      const t = tasks.get(taskId);
      if (t) { t.issueClosedAt = null; }
    },
    async setPrMerged(taskId) {
      const t = tasks.get(taskId);
      if (t) { t.prMergedAt = new Date().toISOString(); }
    },
    async deleteTask(taskId) {
      const t = tasks.get(taskId);
      if (t && t.assignedAt === null) tasks.delete(taskId);
    },
    async updateTaskPr(taskId, prNumber, branch) {
      const t = tasks.get(taskId);
      if (t) { t.prNumber = prNumber; t.branch = branch; }
    },
    async getTask(taskId) {
      return tasks.get(taskId) ?? null;
    },
    async getTaskByIssue(issueNumber) {
      for (const t of tasks.values()) {
        if (t.issueNumber === issueNumber) return t;
      }
      return null;
    },
    async getTaskByPr(prNumber) {
      for (const t of tasks.values()) {
        if (t.prNumber === prNumber) return t;
      }
      return null;
    },
    async getTaskByWorker(workerId) {
      for (const t of tasks.values()) {
        if (t.workerId === workerId && t.completedAt === null) return t;
      }
      return null;
    },
    async listTasks(opts) {
      let result = [...tasks.values()];
      if (opts?.cancelable) {
        result = result.filter(t =>
          t.workerId === null && t.completedAt === null && t.issueClosedAt === null && t.prMergedAt === null
        );
      }
      return result
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, opts?.limit ?? 200);
    },
  };
}
