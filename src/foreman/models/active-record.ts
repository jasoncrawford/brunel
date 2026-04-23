/* eslint-disable @typescript-eslint/no-explicit-any */
// `any` is intentional throughout this file: db.from(tableName) uses a runtime
// string so Supabase cannot infer per-table types, and `new (this as any)(row)`
// is the standard pattern for polymorphic static factory methods in TypeScript.
import { EventEmitter } from "node:events";
import { db } from "../clients/db-client.js";

/**
 * Abstract base class for foreman active-record model classes.
 * Provides shared CRUD boilerplate: select, get, getBy, list, insert, update, delete.
 *
 * Each subclass must declare:
 *   protected static readonly tableName: string;
 *   protected static readonly primaryKey: string;
 *   static readonly events: EventEmitter;  // own instance per subclass
 *
 * db.from(tableName) with a runtime string loses Supabase's per-table type inference, so
 * this file uses `as any` casts internally throughout. This is intentional and acceptable
 * per the type-system design doc. All public API surface has explicit return types.
 */
export abstract class ActiveRecord {
  /**
   * Each subclass should redeclare its own `static readonly events = new EventEmitter()`
   * to get an isolated emitter. This base instance is a fallback for subclasses that
   * don't need change events.
   */
  static readonly events: EventEmitter = new EventEmitter();

  protected static readonly tableName: string;
  protected static readonly primaryKey: string;

  /**
   * Returns the value of this instance's primary key column.
   * Override in subclasses where the JS property name differs from the DB column name
   * (e.g. Task uses `taskId` for the `task_id` column).
   */
  protected getPrimaryKeyValue(): string | number {
    const key = (this.constructor as typeof ActiveRecord).primaryKey;
    return (this as any)[key];
  }

  /** Base query builder — `db.from(tableName).select("*")`. */
  protected static select(): any {
    return (db.from as any)(this.tableName).select("*");
  }

  /**
   * Find a single record by primary key. Returns null if not found.
   * Subclasses may override to narrow the return type (e.g. `Promise<Task | null>`).
   */
  static async get(id: string | number): Promise<any> {
    const { data, error } = await (this as any).select().eq((this as any).primaryKey, id).maybeSingle();
    if (error) throw error;
    return data ? new (this as any)(data) : null;
  }

  /**
   * Find a single record by an arbitrary column. Returns null if not found.
   * Subclasses may override to narrow the return type.
   */
  static async getBy(col: string, val: string | number | null): Promise<any> {
    const { data, error } = await (this as any).select().eq(col, val).maybeSingle();
    if (error) throw error;
    return data ? new (this as any)(data) : null;
  }

  /**
   * List all records with an optional limit.
   * Subclasses may override to add default ordering, filters, or narrow the return type.
   */
  static async list(opts?: { limit?: number }): Promise<any[]> {
    const { data, error } = await (this as any).select().limit(opts?.limit ?? 100);
    if (error) throw error;
    return ((data ?? []) as unknown[]).map((row) => new (this as any)(row));
  }

  /**
   * List all records where `col` equals `val`.
   * Subclasses may override to narrow the return type (e.g. `Promise<Repo[]>`).
   */
  protected static async listBy(col: string, val: string | number): Promise<any[]> {
    const { data, error } = await (this as any).select().eq(col, val);
    if (error) throw error;
    return ((data ?? []) as unknown[]).map((row) => new (this as any)(row));
  }

  /**
   * Insert a new record and return the persisted instance (including server-generated fields).
   * Subclasses may override to narrow the return type.
   * Throws on error.
   */
  static async insert(data: Record<string, unknown>): Promise<any> {
    const { data: row, error } = await (db.from as any)((this as any).tableName)
      .insert(data)
      .select()
      .single();
    if (error) throw error;
    return new (this as any)(row);
  }

  /**
   * Update this record and return a new model instance reflecting the updated row.
   * Emits "changed" on the subclass's event emitter. Throws on error.
   */
  protected async update(changes: Record<string, unknown>): Promise<this> {
    const cls = this.constructor as typeof ActiveRecord;
    const { data, error } = await (db.from as any)(cls.tableName)
      .update(changes)
      .eq(cls.primaryKey, this.getPrimaryKeyValue())
      .select()
      .single();
    if (error) throw error;
    cls.events.emit("changed");
    return new (cls as any)(data) as this;
  }

  /** Delete this record. Emits "changed" on the subclass's event emitter. Throws on error. */
  async delete(): Promise<void> {
    const cls = this.constructor as typeof ActiveRecord;
    const { error } = await (db.from as any)(cls.tableName)
      .delete()
      .eq(cls.primaryKey, this.getPrimaryKeyValue());
    if (error) throw error;
    cls.events.emit("changed");
  }
}
