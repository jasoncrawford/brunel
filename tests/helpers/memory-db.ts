import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/database.types.js";

type Row = Record<string, unknown>;

type Filter =
  | { op: "eq" | "gt" | "gte" | "lt" | "lte"; col: string; val: unknown }
  | { op: "is" | "not_is"; col: string };

// Mirror Postgres behavior: all column reads return null for missing fields,
// not undefined. Applied to rows returned from query results.
function withNullDefaults(row: Row): Row {
  return new Proxy(row, {
    get(target, prop: string | symbol) {
      if (typeof prop !== "string") return (target as any)[prop];
      const val = target[prop];
      return val === undefined ? null : val;
    },
  });
}

function matches(row: Row, f: Filter): boolean {
  // Treat missing fields as null, matching Postgres column semantics.
  const v = row[f.col] !== undefined ? row[f.col] : null;
  switch (f.op) {
    case "eq":     return v === f.val;
    case "is":     return v === null;
    case "not_is": return v !== null;
    case "gt":     return (v as number) > (f.val as number);
    case "gte":    return (v as number) >= (f.val as number);
    case "lt":     return (v as number | string) < (f.val as number | string);
    case "lte":    return (v as number | string) <= (f.val as number | string);
  }
}

function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  return rows.filter(row => filters.every(f => matches(row, f)));
}

function applyOrder(rows: Row[], col: string, asc: boolean): Row[] {
  return [...rows].sort((a, b) => {
    const av = a[col] !== undefined ? a[col] : null;
    const bv = b[col] !== undefined ? b[col] : null;
    if (av == null && bv == null) return 0;
    if (av == null) return asc ? -1 : 1;
    if (bv == null) return asc ? 1 : -1;
    return asc ? (av < bv ? -1 : av > bv ? 1 : 0) : (av > bv ? -1 : av < bv ? 1 : 0);
  });
}

function ok<T>(data: T): Promise<{ data: T; error: null }> {
  return Promise.resolve({ data, error: null });
}

// Parse join references from select strings like "*, repos(full_name)".
// Derives the foreign key as singularTableName + "_id" (e.g. "repos" → "repo_id").
function parseJoins(sel: string | undefined): Array<{ table: string; fkCol: string; cols: string[] }> {
  if (!sel) return [];
  const joins: Array<{ table: string; fkCol: string; cols: string[] }> = [];
  for (const m of sel.matchAll(/(\w+)\(([^)]+)\)/g)) {
    joins.push({
      table: m[1],
      fkCol: m[1].replace(/s$/, "") + "_id",
      cols: m[2].split(",").map(s => s.trim()),
    });
  }
  return joins;
}

// Adds eq/is/not/gt/gte/lt/lte methods to an existing object, pushing onto `filters`.
function addFilters(target: Record<string, unknown>, filters: Filter[]): void {
  Object.assign(target, {
    eq(col: string, val: unknown)               { filters.push({ op: "eq",     col, val }); return target; },
    is(col: string, _val: unknown)              { filters.push({ op: "is",     col });      return target; },
    not(col: string, op: string, _val: unknown) { if (op === "is") filters.push({ op: "not_is", col }); return target; },
    gt(col: string, val: unknown)               { filters.push({ op: "gt",     col, val }); return target; },
    gte(col: string, val: unknown)              { filters.push({ op: "gte",    col, val }); return target; },
    lt(col: string, val: unknown)               { filters.push({ op: "lt",     col, val }); return target; },
    lte(col: string, val: unknown)              { filters.push({ op: "lte",    col, val }); return target; },
  });
}

// DB column defaults — mirrors NOT NULL DEFAULT values from schema migrations.
// Only needed for columns models read but don't provide in INSERT data.
// Implemented as factory functions so each insert gets fresh values.
const columnDefaultFns: Partial<Record<string, () => Row>> = {
  repos:            () => ({ status: "new", created_at: new Date().toISOString() }),
  tasks:            () => ({ created_at: new Date().toISOString() }),
  installations:    () => ({ created_at: new Date().toISOString() }),
  webhook_events:   () => ({ received_at: new Date().toISOString() }),
  foreman_messages: () => ({ created_at: new Date().toISOString() }),
};

function applyColumnDefaults(tableName: string, rowData: Row): Row {
  const fn = columnDefaultFns[tableName];
  return fn ? { ...fn(), ...rowData } : rowData;
}

/** Returns a fake Supabase client backed by in-memory Maps. */
export function createMemoryTaskDb(): SupabaseClient<Database> {
  const tables = new Map<string, Row[]>();
  const counters = new Map<string, number>();

  function getTable(name: string): Row[] {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  }

  function nextId(table: string): number {
    const n = (counters.get(table) ?? 0) + 1;
    counters.set(table, n);
    return n;
  }

  function withJoins(rows: Row[], joins: ReturnType<typeof parseJoins>): Row[] {
    if (joins.length === 0) return rows;
    return rows.map(row => {
      let result = { ...row };
      for (const j of joins) {
        const fkVal = row[j.fkCol] !== undefined ? row[j.fkCol] : null;
        const refRow = getTable(j.table).find(r => r.id === fkVal) ?? null;
        const joined = refRow ? Object.fromEntries(j.cols.map(c => [c, refRow[c] !== undefined ? refRow[c] : null])) : null;
        result = { ...result, [j.table]: joined };
      }
      return result;
    });
  }

  return {
    from(tableName: string) {
      return {

        select(sel?: string) {
          const filters: Filter[] = [];
          const joins = parseJoins(sel);
          let orderCol: string | null = null;
          let orderAsc = true;

          function execute(): Row[] {
            let rows = applyFilters(getTable(tableName), filters);
            if (orderCol !== null) rows = applyOrder(rows, orderCol, orderAsc);
            // Apply withNullDefaults so models see null (not undefined) for absent columns.
            return withJoins(rows, joins).map(withNullDefaults);
          }

          const sb: Record<string, unknown> = {
            order(col: string, opts?: { ascending?: boolean }) {
              orderCol = col;
              orderAsc = opts?.ascending !== false;
              return sb;
            },
            limit(n: number)  { return ok(execute().slice(0, n)); },
            single()          { return ok(execute()[0] ?? null);  },
            maybeSingle()     { return ok(execute()[0] ?? null);  },
            then(resolve: (v: { data: Row[]; error: null }) => void) {
              resolve({ data: execute(), error: null });
            },
          };
          addFilters(sb, filters);
          return sb;
        },

        insert(rowData: Row) {
          const row: Row = withNullDefaults({ id: nextId(tableName), ...applyColumnDefaults(tableName, rowData) });
          getTable(tableName).push(row);
          return {
            select: () => ({ single: () => ok(row), maybeSingle: () => ok(row) }),
            single:      () => ok(row),
            maybeSingle: () => ok(row),
          };
        },

        upsert(rowData: Row, opts?: { onConflict?: string }) {
          const table = getTable(tableName);
          const conflictCol = opts?.onConflict;
          let row: Row;
          if (conflictCol !== undefined) {
            const idx = table.findIndex(r => r[conflictCol] === rowData[conflictCol]);
            if (idx >= 0) {
              const existing = table[idx];
              // Merge new data onto existing; always preserve the original created_at.
              row = withNullDefaults({ ...existing, ...rowData, created_at: existing.created_at ?? rowData.created_at });
              table[idx] = row;
            } else {
              row = withNullDefaults({ id: nextId(tableName), ...applyColumnDefaults(tableName, rowData) });
              table.push(row);
            }
          } else {
            row = withNullDefaults({ id: nextId(tableName), ...applyColumnDefaults(tableName, rowData) });
            table.push(row);
          }
          return {
            select: () => ({ single: () => ok(row), maybeSingle: () => ok(row) }),
            single:      () => ok(row),
            maybeSingle: () => ok(row),
          };
        },

        update(changes: Row) {
          const filters: Filter[] = [];
          function doUpdate() {
            const matching = applyFilters(getTable(tableName), filters);
            for (const r of matching) Object.assign(r, changes);
            const first = matching[0] ?? null;
            return first ? withNullDefaults(first) : null;
          }
          const chain: Record<string, unknown> = {
            select: () => chain,
            single: () => ok(doUpdate()),
            then(resolve: (v: { data: Row | null; error: null }) => void) {
              resolve({ data: doUpdate(), error: null });
            },
          };
          addFilters(chain, filters);
          return chain;
        },

        delete() {
          const filters: Filter[] = [];
          const chain: Record<string, unknown> = {
            then(resolve: (v: { data: null; error: null }) => void) {
              const table = getTable(tableName);
              const toRemove = new Set(applyFilters(table, filters));
              tables.set(tableName, table.filter(r => !toRemove.has(r)));
              resolve({ data: null, error: null });
            },
          };
          addFilters(chain, filters);
          return chain;
        },

      };
    },
  } as unknown as SupabaseClient<Database>;
}
