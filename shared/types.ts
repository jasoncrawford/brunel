// Types shared between the backend (src/) and frontend (frontend/src/).

import type { Row } from "./database.types.js";

export type TaskStatus = "pending" | "assigned" | "pushed" | "merged" | "closed" | "complete" | "blocked";

// Utility: convert a snake_case string literal to camelCase.
type SnakeToCamel<S extends string> =
  S extends `${infer H}_${infer T}` ? `${H}${Capitalize<SnakeToCamel<T>>}` : S;

// Utility: re-key an object type from snake_case to camelCase.
// Reuse for any other DB row type that needs to cross the HTTP boundary.
export type CamelCaseKeys<T> = { [K in keyof T as SnakeToCamel<string & K>]: T[K] };

// The shape of a task as returned by GET /api/tasks. Derived automatically
// from Row<"tasks"> so new DB columns appear here without manual updates.
// Task.toJSON() is annotated with this return type so the compiler enforces
// that the camelCase mapping stays in sync with the schema.
export type TaskRow = CamelCaseKeys<Row<"tasks">> & { status: TaskStatus };
