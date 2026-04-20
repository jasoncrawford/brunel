/**
 * In-memory Supabase client shim for use when Supabase is not configured.
 * Implements just the query patterns that Task (task.ts) uses.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/database.types.js";

type DbRow = Database["public"]["Tables"]["tasks"]["Row"];
type Filters = Array<{ col: keyof DbRow; op: "eq" | "is"; val: unknown }>;

function applyFilters(rows: DbRow[], filters: Filters): DbRow[] {
  return rows.filter((r) =>
    filters.every((f) => {
      const val = r[f.col];
      if (f.op === "eq") return val === f.val;
      if (f.op === "is") return f.val === null ? val === null : val !== null;
      return true;
    }),
  );
}

function ok<T>(data: T): Promise<{ data: T; error: null }> {
  return Promise.resolve({ data, error: null });
}

/** Returns a fake Supabase client backed by an in-memory Map. */
export function createMemoryTaskDb(): SupabaseClient<Database> {
  const store = new Map<string, DbRow>();

  function buildSelectQuery(filters: Filters) {
    const sb = {
      eq(col: string, val: unknown) {
        filters.push({ col: col as keyof DbRow, op: "eq", val });
        return sb;
      },
      is(col: string, val: unknown) {
        filters.push({ col: col as keyof DbRow, op: "is", val });
        return sb;
      },
      order(_col: string, _opts?: unknown) { return sb; },
      limit(n: number) {
        const rows = applyFilters([...store.values()], filters);
        rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
        return ok(rows.slice(0, n));
      },
      maybeSingle() {
        const rows = applyFilters([...store.values()], filters);
        return ok(rows[0] ?? null);
      },
    };
    return sb;
  }

  function buildMutateQuery(
    execute: (filters: Filters) => void,
  ) {
    const filters: Filters = [];
    const thenable = {
      eq(col: string, val: unknown) {
        filters.push({ col: col as keyof DbRow, op: "eq", val });
        return thenable;
      },
      is(col: string, val: unknown) {
        filters.push({ col: col as keyof DbRow, op: "is", val });
        return thenable;
      },
      then(
        resolve: (v: { data: null; error: null }) => void,
        _reject?: (e: unknown) => void,
      ) {
        execute(filters);
        resolve({ data: null, error: null });
      },
    };
    return thenable;
  }

  // Stub for tables other than "tasks" — always returns empty results so that
  // WebhookEvent.query() / ForemanMessage.query() calls don't return task rows
  // by accident (the real tables don't exist in the in-memory store).
  // insert().select().single() returns an error so ActiveRecord.insert() throws,
  // which is swallowed by the fire-and-forget log() callers.
  const emptyInsertStub = {
    select() { return emptyInsertStub; },
    single() { return Promise.resolve({ data: null, error: new Error("stub: table not tracked in memory-db") }); },
  };
  const emptyBuilder: Record<string, (...args: unknown[]) => unknown> = {
    select(_cols?: string) { return emptyBuilder; },
    eq(_col: string, _val: unknown) { return emptyBuilder; },
    is(_col: string, _val: unknown) { return emptyBuilder; },
    order(_col: string, _opts?: unknown) { return emptyBuilder; },
    limit(_n: number) { return ok([] as DbRow[]); },
    maybeSingle() { return ok(null as DbRow | null); },
    single() { return ok(null as DbRow | null); },
    insert(_data: unknown) { return emptyInsertStub; },
  };

  return {
    from(table: string) {
      if (table !== "tasks") {
        return emptyBuilder;
      }
      return {
        select(_cols?: string) {
          return buildSelectQuery([]);
        },
        upsert(rowData: Partial<DbRow> & { task_id: string }, _opts?: unknown) {
          const existing = store.get(rowData.task_id);
          const now = new Date().toISOString();
          const row: DbRow = {
            // Defaults for new rows:
            repo: "",
            title: "",
            body: "",
            labels: [],
            worker_id: null,
            pr_number: null,
            branch: null,
            assigned_at: null,
            completed_at: null,
            issue_closed_at: null,
            pr_merged_at: null,
            created_at: now,
            // Preserve all existing field values (mirrors ON CONFLICT DO UPDATE
            // which only updates the columns listed in the UPDATE SET — all other
            // columns retain their existing values).
            ...(existing ?? {}),
            // Apply only the fields explicitly provided in rowData.
            ...(rowData as Partial<DbRow>),
            // Always preserve the original created_at.
            created_at: existing?.created_at ?? now,
          } as DbRow;
          store.set(row.task_id, row);
          const result = store.get(row.task_id)!;
          const sb = {
            select() { return sb; },
            maybeSingle() { return ok(result); },
          };
          return sb;
        },
        update(changes: Partial<DbRow>) {
          // Build a fluent chain that supports both the old pattern
          // (.update(changes).eq(...)) and the new base-class pattern
          // (.update(changes).eq(...).select().single()) used by ActiveRecord.update().
          const filters: Filters = [];
          const builder = {
            eq(col: string, val: unknown) {
              filters.push({ col: col as keyof DbRow, op: "eq", val });
              return builder;
            },
            is(col: string, val: unknown) {
              filters.push({ col: col as keyof DbRow, op: "is", val });
              return builder;
            },
            select(_cols?: string) { return builder; },
            single() { return builder; },
            then(
              resolve: (v: { data: DbRow | null; error: null }) => void,
              _reject?: (e: unknown) => void,
            ) {
              const matching = applyFilters([...store.values()], filters);
              for (const row of matching) {
                store.set(row.task_id, { ...row, ...changes });
              }
              const updated = applyFilters([...store.values()], filters);
              resolve({ data: updated[0] ?? null, error: null });
            },
          };
          return builder;
        },
        delete() {
          return buildMutateQuery((filters) => {
            for (const row of applyFilters([...store.values()], filters)) {
              store.delete(row.task_id);
            }
          });
        },
      };
    },
  } as unknown as SupabaseClient<Database>;
}
