// Types shared between the backend (src/) and frontend (frontend/src/).

import type { Row } from "./database.types.js";

export type TaskStatus = "pending" | "assigned" | "pushed" | "merged" | "closed" | "complete" | "blocked";

// The shape of a task row as returned by GET /api/tasks: the DB row plus a
// derived status field. Using Row<"tasks"> ensures column type changes in
// migrations are caught at compile time.
export type TaskRow = Row<"tasks"> & { status: TaskStatus };
