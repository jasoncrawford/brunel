import { EventEmitter } from "node:events";
import type { Database } from "../../database.types.js";
import * as Wire from "../../../shared/wire.js";
import { db } from "../clients/db-client.js";
import { ActiveRecord } from "./active-record.js";
import { Installation } from "./installation.js";
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
  installationId: number | null;

  private constructor(row: DbRow) {
    super();
    this.id = row.id;
    this.fullName = row.full_name;
    this.status = row.status as RepoStatus;
    this.createdAt = row.created_at;
    this.installationId = row.installation_id;
  }

  protected getPrimaryKeyValue(): number {
    return this.id;
  }

  toWire(): Wire.Repo {
    return { repoId: this.id, fullName: this.fullName, status: this.status };
  }

  static async get(id: number): Promise<Repo | null> {
    return super.get(id) as Promise<Repo | null>;
  }

  static async getByFullName(fullName: string): Promise<Repo | null> {
    return super.getBy("full_name", fullName) as Promise<Repo | null>;
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

  /** Returns the GitHub App installation linked to this repo, or null if not set. */
  get installation(): Promise<Installation | null> {
    if (this.installationId === null) return Promise.resolve(null);
    return Installation.get(this.installationId);
  }

  async getTaskByIssue(issueNumber: number): Promise<Task | null> {
    return Task.getByRepoIssue(this.id, issueNumber);
  }

  async getTaskByPr(prNumber: number): Promise<Task | null> {
    return Task.getByRepoPr(this.id, prNumber);
  }

  /** Sets status to 'active' and persists. Returns the updated Repo instance. */
  async activate(): Promise<Repo> {
    const updated = await this.update({ status: "active" });
    this.status = "active";
    return updated;
  }

  /** Sets status to 'new' and persists. Returns the updated Repo instance. */
  async deactivate(): Promise<Repo> {
    const updated = await this.update({ status: "new" });
    this.status = "new";
    return updated;
  }

  /** Sets installation_id to the given value and persists. Returns the updated Repo instance. */
  async linkInstallation(installationId: number): Promise<Repo> {
    const updated = await this.update({ installation_id: installationId });
    this.installationId = installationId;
    return updated;
  }

  /** Clears installation_id and persists. Returns the updated Repo instance. */
  async unlinkInstallation(): Promise<Repo> {
    const updated = await this.update({ installation_id: null });
    this.installationId = null;
    return updated;
  }

  /** Lists all repos linked to the given installation DB id. */
  static async listByInstallation(installationId: number): Promise<Repo[]> {
    return super.listBy("installation_id", installationId) as Promise<Repo[]>;
  }

  /** Finds a repo by full_name without creating one. Returns null if not found. */
  static async findByFullName(fullName: string): Promise<Repo | null> {
    return super.getBy("full_name", fullName) as Promise<Repo | null>;
  }

  /**
   * Find or create a repo by full_name (e.g. "owner/repo").
   * Uses SELECT-first to avoid burning sequence values on the hot path (every webhook).
   * Returns the persisted Repo instance.
   */
  static async findOrCreate(fullName: string): Promise<Repo> {
    const existing = await Repo.getBy("full_name", fullName) as Repo | null;
    if (existing) return existing;
    // Attempt INSERT; a concurrent insert may win the race.
    const { data } = await db.from("repos")
      .insert({ full_name: fullName })
      .select()
      .single();
    if (data) {
      Repo.events.emit("changed");
      return new Repo(data);
    }
    // Concurrent insert won — fetch the winner.
    return (await Repo.getBy("full_name", fullName) as Repo)!;
  }
}
