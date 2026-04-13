import { EventEmitter } from "node:events";
import { db } from "../db-client.js";

/**
 * Abstract base class for foreman active-record model classes.
 * Provides shared CRUD boilerplate: select, get, getBy, list, insert, update, delete.
 *
 * Each subclass must declare:
 *   protected static readonly tableName: string;
 *   protected static readonly primaryKey: string;
 *   static readonly events: EventEmitter;  // own instance per subclass
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any)[key];
  }

  /** Base query builder — `db.from(tableName).select("*")`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected static select(): any {
    // db.from(tableName) with a runtime string loses per-table type inference;
    // cast to any is intentional and acceptable per the type-system design doc.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (db.from as any)(this.tableName).select("*");
  }

  /**
   * Find a single record by primary key. Returns null if not found.
   * Subclasses may override to return a more specific type.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static async get(id: string | number): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this as any).select().eq((this as any).primaryKey, id).maybeSingle();
    if (error) throw error;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return data ? new (this as any)(data) : null;
  }

  /**
   * Find a single record by an arbitrary column. Returns null if not found.
   * Subclasses may override to return a more specific type.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static async getBy(col: string, val: string | number | null): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this as any).select().eq(col, val).maybeSingle();
    if (error) throw error;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return data ? new (this as any)(data) : null;
  }

  /**
   * List all records with an optional limit.
   * Subclasses may override to add default ordering or filters.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static async list(opts?: { limit?: number }): Promise<any[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this as any).select().limit(opts?.limit ?? 100);
    if (error) throw error;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((data ?? []) as unknown[]).map((row) => new (this as any)(row));
  }

  /**
   * Insert a new record and return the persisted instance (including server-generated fields).
   * Throws on error.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static async insert(data: Record<string, unknown>): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: row, error } = await (db.from as any)((this as any).tableName)
      .insert(data)
      .select()
      .single();
    if (error) throw error;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (this as any)(row);
  }

  /**
   * Update this record and return a new model instance reflecting the updated row.
   * Emits "changed" on the subclass's event emitter. Throws on error.
   */
  protected async update(changes: Record<string, unknown>): Promise<this> {
    const cls = this.constructor as typeof ActiveRecord;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db.from as any)(cls.tableName)
      .update(changes)
      .eq(cls.primaryKey, this.getPrimaryKeyValue())
      .select()
      .single();
    if (error) throw error;
    cls.events.emit("changed");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (cls as any)(data) as this;
  }

  /** Delete this record. Emits "changed" on the subclass's event emitter. Throws on error. */
  async delete(): Promise<void> {
    const cls = this.constructor as typeof ActiveRecord;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db.from as any)(cls.tableName)
      .delete()
      .eq(cls.primaryKey, this.getPrimaryKeyValue());
    if (error) throw error;
    cls.events.emit("changed");
  }
}
