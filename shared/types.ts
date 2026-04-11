// Types shared between the backend (src/) and frontend (frontend/src/).

import type { Database } from "./database.types.js";

export type TaskStatus = "pending" | "assigned" | "pushed" | "merged" | "closed" | "complete" | "blocked";

// The shape of a task row as returned by GET /api/tasks.
// Field types are derived from the generated DB schema so that column type
// changes in migrations are caught at compile time.
type DbTaskRow = Database["public"]["Tables"]["tasks"]["Row"];
export type TaskRow = {
  taskId: DbTaskRow["task_id"];
  issueNumber: DbTaskRow["issue_number"];
  repo: DbTaskRow["repo"];
  title: DbTaskRow["title"];
  status: TaskStatus;
  workerId: DbTaskRow["worker_id"];
  prNumber: DbTaskRow["pr_number"];
  branch: DbTaskRow["branch"];
  createdAt: DbTaskRow["created_at"];
  assignedAt: DbTaskRow["assigned_at"];
  completedAt: DbTaskRow["completed_at"];
};
