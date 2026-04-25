import { EventEmitter } from "node:events";
import * as Wire from "../../../shared/wire.js";
import { WebSocket } from "ws";
import type { WebSocket as WsSocket } from "ws";
import type { Task } from "./task.js";
import type { Repo } from "./repo.js";
import type { Database } from "../../database.types.js";
import { log } from "../../utils.js";
import { ActiveRecord } from "./active-record.js";
import { db } from "../clients/db-client.js";

type WorkerDbRow = Database["public"]["Tables"]["workers"]["Row"];

// ── In-memory state ──────────────────────────────────────────────────────────
//
// Workers are persisted in the `workers` DB table. The two maps below serve as
// a runtime cache for connected workers only:
//   - registry: Worker instances (status, currentTask, repo) for connected workers
//   - sockets:  live WebSocket connections keyed by workerId
//
// When a worker disconnects, its entry is removed from the registry (and socket
// map) but its DB record is retained for diagnostics and the admin dashboard.

const registry = new Map<string, Worker>();

/** Active WebSocket connections keyed by workerId. */
const sockets = new Map<string, WsSocket>();

export class Worker extends ActiveRecord {
  static readonly events: EventEmitter = new EventEmitter();

  protected static readonly tableName = "workers";
  protected static readonly primaryKey = "worker_id";

  /** Join repos so that repoFullName is available on DB-fetched instances. */
  protected static select() {
    return (db.from as any)(this.tableName).select("*, repos(full_name)");
  }

  readonly workerId: string;
  status: "idle" | "busy" | "disconnected";
  disconnectedAt?: Date;

  // Fields populated from DB row (undefined for synthetic registry instances)
  readonly repoFullName?: string;
  readonly numConnections?: number;
  readonly firstConnectedAt?: string;
  readonly lastConnectedAt?: string;
  readonly dbCurrentTaskId?: string;

  // In-memory only — not persisted to DB
  currentTask?: Task;
  repo!: Repo;

  /** Serialized DB write chain — ensures mutations are persisted in order. */
  private _pendingWrite: Promise<unknown> = Promise.resolve();

  protected getPrimaryKeyValue(): string {
    return this.workerId;
  }

  private constructor(row: WorkerDbRow) {
    super();
    this.workerId = row.worker_id;
    this.status = row.status as "idle" | "busy" | "disconnected";
    this.repoFullName = (row as any).repos?.full_name ?? undefined;
    this.numConnections = row.num_connections ?? undefined;
    this.firstConnectedAt = row.first_connected_at ?? undefined;
    this.lastConnectedAt = row.last_connected_at ?? undefined;
    this.dbCurrentTaskId = row.current_task_id ?? undefined;
    this.disconnectedAt = row.disconnected_at ? new Date(row.disconnected_at) : undefined;
  }

  /** Chain a DB write onto this worker's serialized write queue (fire-and-forget). */
  private _chain(fn: () => Promise<unknown>): void {
    this._pendingWrite = this._pendingWrite.then(fn).catch((err) =>
      log(`ERROR persisting worker ${this.workerId} to DB: ${String(err)}`),
    );
  }

  // ── Static registry operations ───────────────────────────────────────────

  static register(workerId: string, ws: WsSocket, repo: Repo): Worker {
    let worker = registry.get(workerId);
    if (!worker) {
      // Synthetic row for the in-memory registry instance — diagnostic fields
      // (first_connected_at, last_connected_at, num_connections) are not yet
      // known and will be written by _persistRegister. They resolve to undefined
      // in toWire(), so the dashboard omits them for connected workers.
      worker = new Worker({
        worker_id: workerId,
        status: "idle",
        current_task_id: null,
        repo_id: repo.id,
        first_connected_at: null,
        last_connected_at: null,
        num_connections: null,
        disconnected_at: null,
        goodbye_at: null,
      } as unknown as WorkerDbRow);
    }
    worker.repo = repo;
    worker.status = "idle";
    worker.currentTask = undefined;
    worker.disconnectedAt = undefined;
    sockets.set(workerId, ws);
    registry.set(workerId, worker);
    Worker.events.emit("changed");
    worker._chain(() => Worker._persistRegister(workerId, repo));
    return worker;
  }

  /** Look up a connected worker in the runtime registry (sync). Use Worker.get() for a DB lookup. */
  static fromRegistry(workerId: string): Worker | undefined {
    return registry.get(workerId);
  }

  // Worker.get(id) is inherited from ActiveRecord — async DB lookup by worker_id.
  static get(id: string): Promise<Worker | null> {
    return super.get(id) as Promise<Worker | null>;
  }

  static getIdle(): Worker[] {
    return [...registry.values()].filter((w) => w.status === "idle");
  }

  static getByTask(taskId: string): Worker | undefined {
    for (const w of registry.values()) {
      if (w.currentTaskId === taskId) return w;
    }
    return undefined;
  }

  static all(): Worker[] {
    return [...registry.values()];
  }

  /**
   * For the admin dashboard: connected workers from memory plus disconnected
   * workers from DB that still have a currently assigned task.
   */
  static async allForDashboard(): Promise<Wire.Worker[]> {
    const connected = [...registry.values()].map((w) => w.toWire());
    const connectedIds = new Set(connected.map((w) => w.workerId));

    let fromDb: Wire.Worker[] = [];
    try {
      const { data, error } = await Worker.select().not("current_task_id", "is", null);
      if (!error && data) {
        fromDb = (data as WorkerDbRow[])
          .filter((row) => !connectedIds.has(row.worker_id))
          .map((row) => new Worker(row).toWire());
      }
    } catch {
      // Non-critical: dashboard degrades to just connected workers on DB error
    }

    return [...connected, ...fromDb];
  }

  /** Clear registry and sockets — use in tests for isolation. */
  static _reset(): void {
    registry.clear();
    sockets.clear();
  }

  // ── DB persistence helpers ───────────────────────────────────────────────

  private static async _persistRegister(workerId: string, repo: Repo): Promise<void> {
    const now = new Date().toISOString();
    const existing = await Worker.get(workerId);
    if (existing) {
      await existing.update({
        repo_id: repo.id,
        status: "idle",
        current_task_id: null,
        last_connected_at: now,
        num_connections: (existing.numConnections ?? 0) + 1,
        disconnected_at: null,
        goodbye_at: null,
      });
    } else {
      await Worker.insert({
        worker_id: workerId,
        repo_id: repo.id,
        status: "idle",
        current_task_id: null,
        first_connected_at: now,
        last_connected_at: now,
        num_connections: 1,
        disconnected_at: null,
        goodbye_at: null,
      });
    }
  }

  // ── Instance operations ──────────────────────────────────────────────────

  get currentTaskId(): string | undefined {
    return this.currentTask?.taskId ?? this.dbCurrentTaskId;
  }

  assign(task: Task): void {
    this.status = "busy";
    this.currentTask = task;
    Worker.events.emit("changed");
    this._chain(() => this.update({ status: "busy", current_task_id: task.taskId }));
  }

  release(): void {
    this.status = "idle";
    this.currentTask = undefined;
    Worker.events.emit("changed");
    this._chain(() => this.update({ status: "idle", current_task_id: null }));
  }

  markDisconnected(): void {
    this.status = "disconnected";
    this.disconnectedAt = new Date();
    const disconnectedAt = this.disconnectedAt.toISOString();
    sockets.delete(this.workerId);
    Worker.events.emit("changed");
    this._chain(() => this.update({ status: "disconnected", disconnected_at: disconnectedAt }));
  }

  remove(): void {
    const now = new Date().toISOString();
    registry.delete(this.workerId);
    sockets.delete(this.workerId);
    Worker.events.emit("changed");
    this._chain(() => this.update({
      status: "disconnected",
      disconnected_at: now,
      goodbye_at: now,
      current_task_id: null,
    }));
  }

  isCurrentSocket(ws: WsSocket): boolean {
    return sockets.get(this.workerId) === ws;
  }

  send(msg: Wire.ForemanMessage): boolean {
    const ws = sockets.get(this.workerId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  toWire(): Wire.Worker {
    return {
      workerId: this.workerId,
      status: this.status,
      currentTaskId: this.currentTaskId,
      repo: this.repo?.fullName ?? this.repoFullName,
      numConnections: this.numConnections,
      firstConnectedAt: this.firstConnectedAt,
      lastConnectedAt: this.lastConnectedAt,
      disconnectedAt: this.disconnectedAt?.toISOString(),
    };
  }
}

// Disable max-listeners warning — tests call createForemanWss many times,
// each adding a listener to this static emitter.
Worker.events.setMaxListeners(0);
