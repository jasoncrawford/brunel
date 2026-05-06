import { EventEmitter } from "node:events";
import type { Database } from "../../database.types.js";
import { ActiveRecord } from "./active-record.js";

type DbRow = Database["public"]["Tables"]["installations"]["Row"];

export class Installation extends ActiveRecord {
  static readonly events = new EventEmitter();

  protected static readonly tableName = "installations";
  protected static readonly primaryKey = "id";

  readonly id: number;
  readonly githubId: number;
  readonly accountLogin: string;
  readonly accountType: "User" | "Organization";
  readonly createdAt: string;

  private constructor(row: DbRow) {
    super();
    this.id = row.id;
    this.githubId = row.github_id;
    this.accountLogin = row.account_login;
    this.accountType = row.account_type as "User" | "Organization";
    this.createdAt = row.created_at;
  }

  protected getPrimaryKeyValue(): number {
    return this.id;
  }

  static async get(id: number): Promise<Installation | null> {
    return super.get(id) as Promise<Installation | null>;
  }

  static async getByGithubId(githubId: number): Promise<Installation | null> {
    return super.getBy("github_id", githubId) as Promise<Installation | null>;
  }

  static async list(): Promise<Installation[]> {
    return super.list() as Promise<Installation[]>;
  }

  static async insert(data: {
    github_id: number;
    account_login: string;
    account_type: string;
  }): Promise<Installation> {
    return super.insert(data) as Promise<Installation>;
  }
}
