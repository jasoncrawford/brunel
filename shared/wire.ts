// ── Wire types shared between the backend (src/) and frontend (frontend/src/)
// Import with a namespace alias for clarity: import * as Wire from "../../shared/wire.js"

export type TaskStatus = "pending" | "assigned" | "pushed" | "merged" | "closed" | "complete" | "blocked";

// ── Admin WebSocket wire types (admin dashboard ↔ server) ────────────────────

export interface BlockerInfo {
  issueNumber: number;
  isOpen: boolean;
}

/** Wire representation of a task — sent over the admin WebSocket and REST API. */
export interface Task {
  taskId: string;
  issueNumber: number;
  title: string;
  status: TaskStatus;
  assignedWorkerId?: string;
  prNumber?: number;
  prUrl?: string;
  blockers?: BlockerInfo[];
  // Extended fields — present in REST responses, optional in WebSocket snapshots
  repo?: string;
  branch?: string;
  createdAt?: string;
  assignedAt?: string;
  completedAt?: string;
}

/** Wire representation of a connected worker — sent over the admin WebSocket. */
export interface Worker {
  workerId: string;
  status: "idle" | "busy" | "disconnected";
  currentTaskId?: string;
}

/** A single entry in the activity log — sent over the admin WebSocket and REST API. */
export interface LogEntry {
  kind: "webhook" | "message";
  id: number | undefined;
  timestamp: string;
  taskId: string | null;
  workerId: string | null;
  summary: string;
}

export interface AdminSnapshot {
  tasks: Task[];
  workers: Worker[];
}

export type AdminMessage =
  | { type: "snapshot"; tasks: Task[]; workers: Worker[] }
  | { type: "initial_log"; entries: LogEntry[] }
  | { type: "log_event"; entry: LogEntry };

// ── Foreman ↔ Worker wire protocol ───────────────────────────────────────────

/** A GitHub event received by a worker via event_notification. */
export interface WebhookEvent {
  id: string;           // x-github-delivery header value
  name: string;         // e.g. "check_run", "pull_request_review_comment"
  payload: Record<string, unknown>;
}

export interface TaskIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  repoUrl: string;
}

// Worker → Foreman messages
export type WorkerMessage =
  | { type: "worker_hello"; workerId: string; taskId?: string; status: "idle" | "busy"; workerSecret?: string }
  | { type: "task_complete"; workerId: string; taskId: string }
  | { type: "worker_goodbye"; workerId: string; taskId?: string };

// Foreman → Worker messages
export type ForemanMessage =
  | { type: "task_assigned"; taskId: string; issue: TaskIssue }
  | { type: "event_notification"; taskId: string; event: WebhookEvent }
  | { type: "hello_ack"; workerId: string; status: "idle" | "busy" | "cancelled" };
