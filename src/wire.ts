// ── Wire protocol types for foreman/worker communication ──────────────────────

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
