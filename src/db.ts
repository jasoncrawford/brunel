import type { SupabaseClient } from "@supabase/supabase-js";
import { fmtEvent } from "./display.js";

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

// ── Real implementation ────────────────────────────────────────────────────────

export function createDbLogger(supabase: SupabaseClient): DbLogger {
  function fire(promise: PromiseLike<{ error: unknown }>) {
    Promise.resolve(promise).then(({ error }) => {
      if (error) console.error("[db] insert error:", error);
    }).catch((err: unknown) => console.error("[db] unexpected error:", err));
  }

  function webhookToEntry(row: Record<string, unknown>): LogEntry {
    const storedPayload = (row.payload ?? {}) as Record<string, unknown>;
    // Merge row-level action as fallback for old rows without stored payload
    const payload: Record<string, unknown> = { action: row.action, ...storedPayload };
    const summary = fmtEvent({ id: String(row.delivery_id ?? ""), name: String(row.event_name), payload });
    return {
      kind: "webhook",
      id: row.id as number,
      timestamp: row.received_at as string,
      taskId: (row.task_id as string | null) ?? null,
      workerId: (row.worker_id as string | null) ?? null,
      summary,
    };
  }

  function messageToEntry(row: Record<string, unknown>): LogEntry {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    let summary: string;
    if (row.msg_type === "worker_disconnected") {
      const reason = payload.reason ? `: ${payload.reason}` : "";
      summary = `disconnected (code ${payload.code}${reason})`;
    } else if (row.msg_type === "worker_hello") {
      const status = String(payload.status ?? "");
      const taskId = payload.taskId ? ` task=#${payload.taskId}` : "";
      summary = `${row.direction} worker_hello — ${status}${taskId}`;
    } else if (row.msg_type === "event_notification") {
      const event = (payload.event ?? {}) as Record<string, unknown>;
      const eventName = event.name ? ` — ${event.name}` : "";
      summary = `${row.direction} event_notification${eventName}`;
    } else {
      summary = `${row.direction} ${row.msg_type}`;
    }
    return {
      kind: "message",
      id: row.id as number,
      timestamp: row.created_at as string,
      taskId: (row.task_id as string | null) ?? null,
      workerId: (row.worker_id as string | null) ?? null,
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
          .select("id, received_at, delivery_id, event_name, action, issue_number, task_id, worker_id, payload")
          .order("received_at", { ascending: false })
          .limit(limit),
        supabase.from("foreman_messages")
          .select("id, created_at, direction, worker_id, task_id, msg_type, payload")
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
      const webhooks = ((wRes.data ?? []) as Record<string, unknown>[]).map(webhookToEntry);
      const messages = ((mRes.data ?? []) as Record<string, unknown>[]).map(messageToEntry);
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
      const webhooks = ((wRes.data ?? []) as Record<string, unknown>[]).map(webhookToEntry);
      const messages = ((mRes.data ?? []) as Record<string, unknown>[]).map(messageToEntry);
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

// ── TaskAssignmentStore ────────────────────────────────────────────────────────

export interface TaskAssignmentRow {
  taskId: string;
  workerId: string;
  prNumber: number | null;
  branch: string | null;
}

export interface TaskAssignmentStore {
  /** Insert or replace the assignment row for this task. */
  upsertAssignment(taskId: string, workerId: string): Promise<void>;
  /** Update the assignment row with PR number and branch (called when PR opened). */
  updatePr(taskId: string, prNumber: number, branch: string | null): Promise<void>;
  /** Delete the assignment row (task complete, or reverted to pending). */
  deleteAssignment(taskId: string): Promise<void>;
  /** Load all persisted assignments at startup. */
  listAssignments(): Promise<TaskAssignmentRow[]>;
}

export function createTaskAssignmentStore(supabase: SupabaseClient): TaskAssignmentStore {
  return {
    async upsertAssignment(taskId, workerId) {
      const { error } = await supabase.from("task_assignments").upsert(
        { task_id: taskId, worker_id: workerId, updated_at: new Date().toISOString() },
        { onConflict: "task_id" },
      );
      if (error) throw error;
    },

    async updatePr(taskId, prNumber, branch) {
      const { error } = await supabase.from("task_assignments")
        .update({ pr_number: prNumber, branch, updated_at: new Date().toISOString() })
        .eq("task_id", taskId);
      if (error) throw error;
    },

    async deleteAssignment(taskId) {
      const { error } = await supabase.from("task_assignments")
        .delete()
        .eq("task_id", taskId);
      if (error) throw error;
    },

    async listAssignments() {
      const { data, error } = await supabase.from("task_assignments")
        .select("task_id, worker_id, pr_number, branch");
      if (error) throw error;
      return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        taskId: row.task_id as string,
        workerId: row.worker_id as string,
        prNumber: (row.pr_number as number | null) ?? null,
        branch: (row.branch as string | null) ?? null,
      }));
    },
  };
}

export function createNullTaskAssignmentStore(): TaskAssignmentStore {
  return {
    async upsertAssignment() {},
    async updatePr() {},
    async deleteAssignment() {},
    async listAssignments() { return []; },
  };
}

// ── TaskStore ──────────────────────────────────────────────────────────────────

export interface TaskRow {
  taskId: string;
  issueNumber: number;
  repo: string;
  title: string;
  status: "pending" | "assigned" | "complete";
  workerId: string | null;
  prNumber: number | null;
  branch: string | null;
  createdAt: string;
  assignedAt: string | null;
  completedAt: string | null;
}

export interface ListTasksOpts {
  status?: "pending" | "assigned" | "complete";
  limit?: number;
}

export interface TaskStore {
  /** Insert task with status=pending; on conflict (duplicate task_id) do nothing. */
  upsertTask(taskId: string, issueNumber: number, repo: string, title: string): Promise<void>;
  /** Mark task as assigned to a worker. */
  markAssigned(taskId: string, workerId: string): Promise<void>;
  /** Mark task as complete. */
  markComplete(taskId: string): Promise<void>;
  /** Revert task to pending, clearing worker_id. */
  markPending(taskId: string): Promise<void>;
  /** Update PR number and branch for a task. */
  updateTaskPr(taskId: string, prNumber: number, branch: string | null): Promise<void>;
  /** List tasks, optionally filtered by status. */
  listTasks(opts?: ListTasksOpts): Promise<TaskRow[]>;
}

export function createTaskStore(supabase: SupabaseClient): TaskStore {
  function rowToTaskRow(row: Record<string, unknown>): TaskRow {
    return {
      taskId: row.task_id as string,
      issueNumber: row.issue_number as number,
      repo: row.repo as string,
      title: row.title as string,
      status: row.status as "pending" | "assigned" | "complete",
      workerId: (row.worker_id as string | null) ?? null,
      prNumber: (row.pr_number as number | null) ?? null,
      branch: (row.branch as string | null) ?? null,
      createdAt: row.created_at as string,
      assignedAt: (row.assigned_at as string | null) ?? null,
      completedAt: (row.completed_at as string | null) ?? null,
    };
  }

  return {
    async upsertTask(taskId, issueNumber, repo, title) {
      const { error } = await supabase.from("tasks").upsert(
        { task_id: taskId, issue_number: issueNumber, repo, title, status: "pending" },
        { onConflict: "task_id", ignoreDuplicates: true },
      );
      if (error) throw error;
    },

    async markAssigned(taskId, workerId) {
      const { error } = await supabase.from("tasks")
        .update({ status: "assigned", worker_id: workerId, assigned_at: new Date().toISOString() })
        .eq("task_id", taskId);
      if (error) throw error;
    },

    async markComplete(taskId) {
      const { error } = await supabase.from("tasks")
        .update({ status: "complete", completed_at: new Date().toISOString() })
        .eq("task_id", taskId);
      if (error) throw error;
    },

    async markPending(taskId) {
      const { error } = await supabase.from("tasks")
        .update({ status: "pending", worker_id: null })
        .eq("task_id", taskId);
      if (error) throw error;
    },

    async updateTaskPr(taskId, prNumber, branch) {
      const { error } = await supabase.from("tasks")
        .update({ pr_number: prNumber, branch })
        .eq("task_id", taskId);
      if (error) throw error;
    },

    async listTasks(opts) {
      const limit = opts?.limit ?? 200;
      let q = supabase.from("tasks").select(
        "task_id, issue_number, repo, title, status, worker_id, pr_number, branch, created_at, assigned_at, completed_at"
      );
      if (opts?.status) q = q.eq("status", opts.status);
      const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return ((data ?? []) as Record<string, unknown>[]).map(rowToTaskRow);
    },
  };
}

export function createNullTaskStore(): TaskStore {
  return {
    async upsertTask() {},
    async markAssigned() {},
    async markComplete() {},
    async markPending() {},
    async updateTaskPr() {},
    async listTasks() { return []; },
  };
}
