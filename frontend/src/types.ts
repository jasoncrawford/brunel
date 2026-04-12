export type { TaskStatus } from "../../shared/types.ts";
export type { Task, Worker, LogEntry, AdminMessage, BlockerInfo } from "../../shared/wire.ts";

export interface TaskRow {
  taskId: string;
  issueNumber: number;
  repo: string;
  title: string;
  status: import("../../shared/types.ts").TaskStatus;
  workerId: string | null;
  prNumber: number | null;
  branch: string | null;
  createdAt: string;
  assignedAt: string | null;
  completedAt: string | null;
}
