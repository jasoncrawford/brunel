// ── Wire types shared between the backend (src/) and frontend (frontend/src/)
// Import with a namespace alias for clarity: import * as Wire from "../../shared/wire.js"

export type TaskStatus = "pending" | "assigned" | "pushed" | "merged" | "closed" | "complete" | "blocked";

// ── Admin WebSocket wire types (admin dashboard ↔ server) ────────────────────

export interface BlockerInfo {
  issueNumber: number;
  isOpen: boolean;
}

/** Wire representation of a repo — sent over the admin WebSocket and REST API. */
export interface Repo {
  repoId: number;
  fullName: string;
  status: "new" | "active";
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
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/** Wire representation of a worker — sent over the admin WebSocket and REST API. */
export interface Worker {
  workerId: string;
  status: "ready" | "reserved" | "assigned" | "disconnected";
  currentTaskId?: string;
  repo?: string;
  // Diagnostic fields — present in REST responses, optional in WebSocket snapshots
  firstConnectedAt?: string;
  lastConnectedAt?: string;
  numConnections?: number;
  disconnectedAt?: string;
}

/** A single entry in the activity log — sent over the admin WebSocket and REST API. */
export interface LogEntry {
  kind: "webhook" | "message";
  id: number | undefined;
  timestamp: string;
  taskId: string | null;
  workerId: string | null;
  repo?: string;
  summary: string;
}

export interface AdminSnapshot {
  tasks: Task[];
  workers: Worker[];
  repos: Repo[];
}

export type AdminMessage =
  | { type: "snapshot"; tasks: Task[]; workers: Worker[]; repos: Repo[] }
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
  status: TaskStatus;
  prNumber?: number | null;
  branch?: string | null;
}

// Worker → Foreman messages
export type WorkerMessage =
  | { type: "worker_hello"; workerId: string; repo: string; taskId?: string; status: "ready" | "reserved" | "assigned"; workerSecret?: string; lastSeenEventSeqId?: number; githubToken?: string }
  | { type: "task_complete"; workerId: string; taskId: string; nextState?: "ready" | "reserved"; stats?: { inputTokens: number; outputTokens: number; costUsd?: number } }
  | { type: "worker_goodbye"; workerId: string; taskId?: string; task_complete?: boolean; stats?: { inputTokens: number; outputTokens: number; costUsd?: number } }
  | { type: "activate_repo"; workerId: string }
  | { type: "claim_task"; workerId: string; taskId: string }
  | { type: "worker_ready"; workerId: string }
  | { type: "worker_reserved"; workerId: string };

// Foreman → Worker messages
export type ForemanMessage =
  | { type: "task_assigned"; taskId: string; issue: TaskIssue; baseSeqId?: number }
  | { type: "event_notification"; taskId: string; event: WebhookEvent; seqId?: number }
  | { type: "hello_ack"; workerId: string; status: "ready" | "reserved" | "assigned" | "cancelled"; repoStatus: "new" | "active" }
  | { type: "repo_activated"; workerId: string }
  | { type: "foreman_error"; message: string; fatal: boolean; errorType?: string };
