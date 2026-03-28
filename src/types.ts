// ── Shared types for foreman/worker protocol ──────────────────────────────────

export interface GitHubEvent {
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

export interface LabeledIssueState {
  issue: TaskIssue;    // issue metadata (title, body, labels, repoUrl)
  depsLoaded: boolean; // true once fetchBlockers has resolved for this issue
}

// Worker → Foreman messages
export type WorkerMessage =
  | { type: "worker_hello"; workerId: string; taskId?: string; status: "idle" | "busy"; workerSecret?: string }
  | { type: "task_complete"; workerId: string; taskId: string }
  | { type: "worker_goodbye"; workerId: string; taskId?: string };

// Foreman → Worker messages
export type ForemanMessage =
  | { type: "task_assigned"; taskId: string; issue: TaskIssue }
  | { type: "event_notification"; taskId: string; event: GitHubEvent }
  | { type: "standby" };
