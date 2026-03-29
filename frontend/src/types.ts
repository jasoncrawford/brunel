export interface TaskSnapshot {
  taskId: string;
  issueNumber: number;
  title: string;
  status: "pending" | "assigned" | "complete";
  assignedWorkerId?: string;
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
