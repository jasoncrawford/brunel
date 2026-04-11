// Types shared between the backend (src/) and frontend (frontend/src/).

import type { Row } from "./database.types.js";

export type TaskStatus = "pending" | "assigned" | "pushed" | "merged" | "closed" | "complete" | "blocked";

// The shape of a task as returned by GET /api/tasks (camelCase for JS
// conventions). Field types are indexed from Row<"tasks"> so that column type
// changes in migrations are caught at compile time. Task.toJSON() is annotated
// with this return type, so the compiler enforces that the two stay in sync.
type DbRow = Row<"tasks">;
export type TaskRow = {
  taskId: DbRow["task_id"];
  issueNumber: DbRow["issue_number"];
  repo: DbRow["repo"];
  title: DbRow["title"];
  body: DbRow["body"];
  labels: DbRow["labels"];
  status: TaskStatus;
  workerId: DbRow["worker_id"];
  prNumber: DbRow["pr_number"];
  branch: DbRow["branch"];
  createdAt: DbRow["created_at"];
  assignedAt: DbRow["assigned_at"];
  completedAt: DbRow["completed_at"];
  issueClosedAt: DbRow["issue_closed_at"];
  prMergedAt: DbRow["pr_merged_at"];
};
