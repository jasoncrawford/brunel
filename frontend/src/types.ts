export interface TaskSnapshot {
  taskId: string;
  issueNumber: number;
  title: string;
  status: "pending" | "assigned" | "complete";
  assignedWorkerId?: string;
  prNumber?: number;
  prUrl?: string;
}

export interface WorkerSnapshot {
  workerId: string;
  status: "idle" | "busy";
  currentTaskId?: string;
}

export interface LogEntry {
  kind: "webhook" | "message";
  id: number;
  timestamp: string;
  taskId: string | null;
  workerId: string | null;
  summary: string;
}

export type AdminMessage =
  | { type: "snapshot"; tasks: TaskSnapshot[]; workers: WorkerSnapshot[] }
  | { type: "initial_log"; entries: LogEntry[] }
  | { type: "log_event"; entry: LogEntry };

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
