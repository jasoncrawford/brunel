/**
 * In-memory Supabase client shim for use when Supabase is not configured.
 * Implements just the query patterns that Task (task.ts) and Repo (repo.ts) use.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/database.types.js";

type DbRow = Database["public"]["Tables"]["tasks"]["Row"];
type RepoRow = Database["public"]["Tables"]["repos"]["Row"];
type WorkerRow = Database["public"]["Tables"]["workers"]["Row"];
type WebhookRow = Database["public"]["Tables"]["webhook_events"]["Row"];
type Filters = Array<{ col: keyof DbRow; op: "eq" | "is" | "gt" | "gte" | "lt" | "lte"; val: unknown }>;
type WorkerFilters = Array<{ col: keyof WorkerRow; op: "eq" | "is" | "not_is"; val: unknown }>;
type WebhookFilters = Array<{ col: keyof WebhookRow; op: "eq" | "gt" | "gte" | "lt" | "lte"; val: unknown }>;

function applyFilters(rows: DbRow[], filters: Filters): DbRow[] {
  return rows.filter((r) =>
    filters.every((f) => {
      const val = r[f.col];
      if (f.op === "eq") return val === f.val;
      if (f.op === "is") return f.val === null ? val === null : val !== null;
      if (f.op === "gt") return (val as number) > (f.val as number);
      if (f.op === "gte") return (val as number) >= (f.val as number);
      if (f.op === "lt") return (val as string | number) < (f.val as string | number);
      if (f.op === "lte") return (val as string | number) <= (f.val as string | number);
      return true;
    }),
  );
}

function applyWebhookFilters(rows: WebhookRow[], filters: WebhookFilters): WebhookRow[] {
  return rows.filter((r) =>
    filters.every((f) => {
      const val = (r as Record<string, unknown>)[f.col as string];
      if (f.op === "eq") return val === f.val;
      if (f.op === "gt") return (val as number) > (f.val as number);
      if (f.op === "gte") return (val as number) >= (f.val as number);
      if (f.op === "lt") return (val as string | number) < (f.val as string | number);
      if (f.op === "lte") return (val as string | number) <= (f.val as string | number);
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

  // ── Repos store ───────────────────────────────────────────────────────────
  const reposStore = new Map<string, RepoRow>();
  let nextRepoId = 1;

  // ── Workers store ─────────────────────────────────────────────────────────
  const workersStore = new Map<string, WorkerRow>();

  function applyWorkerFilters(rows: WorkerRow[], filters: WorkerFilters): WorkerRow[] {
    return rows.filter((r) =>
      filters.every((f) => {
        const val = (r as Record<string, unknown>)[f.col as string];
        if (f.op === "eq") return val === f.val;
        if (f.op === "is") return f.val === null ? val === null : val !== null;
        if (f.op === "not_is") return f.val === null ? val !== null : val === null;
        return true;
      }),
    );
  }

  function buildWorkersTable() {
    function withReposJoin(row: WorkerRow) {
      const repo = [...reposStore.values()].find((r) => r.id === row.repo_id);
      return repo ? { ...row, repos: { full_name: repo.full_name } } : { ...row, repos: null };
    }

    return {
      insert(rowData: WorkerRow) {
        const now = new Date().toISOString();
        const row: WorkerRow = {
          status: "ready",
          current_task_id: null,
          first_connected_at: now,
          last_connected_at: now,
          num_connections: 1,
          disconnected_at: null,
          goodbye_at: null,
          ...rowData,
        };
        workersStore.set(row.worker_id, row);
        const sb = {
          select() { return sb; },
          single() { return ok(row); },
          maybeSingle() { return ok(row); },
        };
        return sb;
      },
      update(changes: Partial<WorkerRow>) {
        let matchId: string | null = null;
        const thenable = {
          eq(_col: string, val: unknown) { matchId = val as string; return thenable; },
          select() { return thenable; },
          single(): Promise<{ data: WorkerRow | null; error: null }> {
            if (matchId !== null) {
              const existing = workersStore.get(matchId);
              if (existing) {
                const updated = { ...existing, ...changes };
                workersStore.set(matchId, updated);
                return Promise.resolve({ data: updated, error: null });
              }
            }
            return Promise.resolve({ data: null, error: null });
          },
          then(resolve: (v: { data: WorkerRow | null; error: null }) => void) {
            if (matchId !== null) {
              const existing = workersStore.get(matchId);
              if (existing) {
                const updated = { ...existing, ...changes };
                workersStore.set(matchId, updated);
                resolve({ data: updated, error: null });
                return;
              }
            }
            resolve({ data: null, error: null });
          },
        };
        return thenable;
      },
      select(_cols?: string) {
        const filters: WorkerFilters = [];
        let rows = [...workersStore.values()];
        const sb = {
          eq(col: string, val: unknown) {
            filters.push({ col: col as keyof WorkerRow, op: "eq", val });
            rows = applyWorkerFilters([...workersStore.values()], filters);
            return sb;
          },
          not(col: string, op: string, val: unknown) {
            if (op === "is") {
              filters.push({ col: col as keyof WorkerRow, op: "not_is", val });
              rows = applyWorkerFilters([...workersStore.values()], filters);
            }
            return sb;
          },
          order(_col: string, _opts?: unknown) { return sb; },
          limit(n: number) { return ok(rows.slice(0, n).map(withReposJoin)); },
          maybeSingle() { return ok(rows[0] ? withReposJoin(rows[0]) : null); },
          single() { return ok(rows[0] ? withReposJoin(rows[0]) : null); },
          then(resolve: (v: { data: ReturnType<typeof withReposJoin>[]; error: null }) => void) {
            resolve({ data: rows.map(withReposJoin), error: null });
          },
        };
        return sb;
      },
    };
  }

  // ── WebhookEvents store ───────────────────────────────────────────────────────
  const webhookEventsStore: WebhookRow[] = [];
  let nextWebhookId = 1;

  function buildWebhookEventsTable() {
    return {
      insert(data: Partial<WebhookRow> & { event_name: string; payload: unknown }) {
        const id = (data as Record<string, unknown>).id as number | undefined ?? nextWebhookId++;
        const now = new Date().toISOString();
        const row: WebhookRow = {
          id,
          received_at: now,
          delivery_id: null,
          action: null,
          repo_id: null,
          sender: null,
          issue_number: null,
          pr_number: null,
          branch: null,
          task_id: null,
          worker_id: null,
          ...data,
          id,
        } as WebhookRow;
        webhookEventsStore.push(row);
        const sb = {
          select() { return sb; },
          single() { return ok(row); },
        };
        return sb;
      },
      select(_cols?: string) {
        const filters: WebhookFilters = [];
        let orderCol: keyof WebhookRow | null = null;
        let orderAsc = true;
        const sb = {
          eq(col: string, val: unknown) {
            filters.push({ col: col as keyof WebhookRow, op: "eq", val });
            return sb;
          },
          gt(col: string, val: unknown) {
            filters.push({ col: col as keyof WebhookRow, op: "gt", val });
            return sb;
          },
          gte(col: string, val: unknown) {
            filters.push({ col: col as keyof WebhookRow, op: "gte", val });
            return sb;
          },
          lt(col: string, val: unknown) {
            filters.push({ col: col as keyof WebhookRow, op: "lt", val });
            return sb;
          },
          lte(col: string, val: unknown) {
            filters.push({ col: col as keyof WebhookRow, op: "lte", val });
            return sb;
          },
          order(col: string, opts?: { ascending?: boolean }) {
            orderCol = col as keyof WebhookRow;
            orderAsc = opts?.ascending !== false;
            return sb;
          },
          limit(n: number) {
            let rows = applyWebhookFilters([...webhookEventsStore], filters);
            if (orderCol !== null) {
              const col = orderCol;
              const asc = orderAsc;
              rows = [...rows].sort((a, b) => {
                const av = (a as Record<string, unknown>)[col as string];
                const bv = (b as Record<string, unknown>)[col as string];
                if (av == null && bv == null) return 0;
                if (av == null) return asc ? -1 : 1;
                if (bv == null) return asc ? 1 : -1;
                return asc ? (av < bv ? -1 : av > bv ? 1 : 0) : (av > bv ? -1 : av < bv ? 1 : 0);
              });
            }
            return ok(rows.slice(0, n));
          },
          maybeSingle() {
            const rows = applyWebhookFilters([...webhookEventsStore], filters);
            return ok(rows[0] ?? null);
          },
          single() {
            const rows = applyWebhookFilters([...webhookEventsStore], filters);
            return ok(rows[0] ?? null);
          },
          then(resolve: (v: { data: WebhookRow[]; error: null }) => void) {
            resolve({ data: applyWebhookFilters([...webhookEventsStore], filters), error: null });
          },
        };
        return sb;
      },
    };
  }

  function buildReposTable() {
    return {
      insert(rowData: { full_name: string }) {
        if (reposStore.has(rowData.full_name)) {
          // Simulate a unique constraint violation — caller falls back to SELECT.
          const sb = {
            select() { return sb; },
            single(): Promise<{ data: null; error: Error }> {
              return Promise.resolve({ data: null, error: new Error("duplicate key value violates unique constraint") });
            },
          };
          return sb;
        }
        const newRow: RepoRow = {
          id: nextRepoId++,
          full_name: rowData.full_name,
          status: "new",
          created_at: new Date().toISOString(),
        };
        reposStore.set(rowData.full_name, newRow);
        const sb = {
          select() { return sb; },
          single() { return ok(newRow); },
        };
        return sb;
      },
      update(changes: Partial<RepoRow>) {
        let matchId: number | null = null;
        const thenable = {
          eq(_col: string, val: unknown) {
            matchId = val as number;
            return thenable;
          },
          select() { return thenable; },
          single(): Promise<{ data: RepoRow | null; error: null }> {
            const entry = [...reposStore.entries()].find(([, r]) => r.id === matchId);
            if (entry) {
              const updated = { ...entry[1], ...changes };
              reposStore.set(entry[0], updated);
              return Promise.resolve({ data: updated, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
        };
        return thenable;
      },
      select(_cols?: string) {
        let filteredRows = [...reposStore.values()];
        const sb = {
          eq(col: string, val: unknown) {
            filteredRows = filteredRows.filter((r) => (r as Record<string, unknown>)[col] === val);
            return sb;
          },
          order(_col: string, _opts?: unknown) { return sb; },
          limit(n: number) { return ok(filteredRows.slice(0, n)); },
          maybeSingle() { return ok(filteredRows[0] ?? null); },
          single() { return ok(filteredRows[0] ?? null); },
          // Support `await select().eq(col, val)` used by listBy()
          then(resolve: (v: { data: RepoRow[]; error: null }) => void) {
            resolve({ data: filteredRows, error: null });
          },
        };
        return sb;
      },
    };
  }


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
      gt(col: string, val: unknown) {
        filters.push({ col: col as keyof DbRow, op: "gt", val });
        return sb;
      },
      gte(col: string, val: unknown) {
        filters.push({ col: col as keyof DbRow, op: "gte", val });
        return sb;
      },
      lt(col: string, val: unknown) {
        filters.push({ col: col as keyof DbRow, op: "lt", val });
        return sb;
      },
      lte(col: string, val: unknown) {
        filters.push({ col: col as keyof DbRow, op: "lte", val });
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
    gt(_col: string, _val: unknown) { return emptyBuilder; },
    gte(_col: string, _val: unknown) { return emptyBuilder; },
    lt(_col: string, _val: unknown) { return emptyBuilder; },
    lte(_col: string, _val: unknown) { return emptyBuilder; },
    order(_col: string, _opts?: unknown) { return emptyBuilder; },
    limit(_n: number) { return ok([] as DbRow[]); },
    maybeSingle() { return ok(null as DbRow | null); },
    single() { return ok(null as DbRow | null); },
    insert(_data: unknown) { return emptyInsertStub; },
  };

  return {
    from(table: string) {
      if (table === "repos") {
        return buildReposTable();
      }
      if (table === "workers") {
        return buildWorkersTable();
      }
      if (table === "webhook_events") {
        return buildWebhookEventsTable();
      }
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
            repo_id: 0,
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
            input_tokens: null,
            output_tokens: null,
            cost_usd: null,
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
