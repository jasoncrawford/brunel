import type { TaskStatus } from "../../shared/types.ts";
export type { TaskStatus };

export interface BlockerInfo {
  issueNumber: number;
  isOpen: boolean;
}

export interface TaskSnapshot {
  taskId: string;
  issueNumber: number;
  title: string;
  status: TaskStatus;
  assignedWorkerId?: string;
  prNumber?: number;
  prUrl?: string;
  blockers?: BlockerInfo[];
}

export interface WorkerSnapshot {
  workerId: string;
  status: "idle" | "busy";
  currentTaskId?: string;
}

export interface LogEntry {
  kind: "webhook" | "message";
  id: number | undefined;
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
  status: TaskStatus;
  workerId: string | null;
  prNumber: number | null;
  branch: string | null;
  createdAt: string;
  assignedAt: string | null;
  completedAt: string | null;
}
