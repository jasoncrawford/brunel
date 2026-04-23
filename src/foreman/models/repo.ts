import { EventEmitter } from "node:events";
import type { Database } from "../../database.types.js";
import { db } from "../clients/db-client.js";
import { ActiveRecord } from "./active-record.js";
import { Task } from "./task.js";
import { TaskManager } from "./task-manager.js";

type DbRow = Database["public"]["Tables"]["repos"]["Row"];

export type RepoStatus = "new" | "active";

export class Repo extends ActiveRecord {
  static readonly events = new EventEmitter();

  protected static readonly tableName = "repos";
  protected static readonly primaryKey = "id";

  readonly id: number;
  readonly fullName: string;
  status: RepoStatus;
  readonly createdAt: string;

  private constructor(row: DbRow) {
    super();
    this.id = row.id;
    this.fullName = row.full_name;
    this.status = row.status as RepoStatus;
    this.createdAt = row.created_at;
  }

  protected getPrimaryKeyValue(): number {
    return this.id;
  }

  static async get(id: number): Promise<Repo | null> {
    return super.get(id) as Promise<Repo | null>;
  }

  static async list(): Promise<Repo[]> {
    return super.list() as Promise<Repo[]>;
  }

  static async listActive(): Promise<Repo[]> {
    return super.listBy("status", "active") as Promise<Repo[]>;
  }

  /** Convenience accessor — returns the per-repo TaskManager instance. */
  get taskManager(): TaskManager {
    return TaskManager.forRepo(this);
  }

  async getTaskByIssue(issueNumber: number): Promise<Task | null> {
    return Task.getByRepoIssue(this.id, issueNumber);
  }

  async getTaskByPr(prNumber: number): Promise<Task | null> {
    return Task.getByRepoPr(this.id, prNumber);
  }

  /**
   * Find or create a repo by full_name (e.g. "owner/repo").
   * Upserts on full_name so it's safe to call on every webhook.
   * Returns the persisted Repo instance.
   */
  static async findOrCreate(fullName: string): Promise<Repo> {
    const { data, error } = await db.from("repos")
      .upsert({ full_name: fullName }, { onConflict: "full_name" })
      .select()
      .single();
    if (error) throw error;
    Repo.events.emit("changed");
    return new Repo(data);
  }
}
