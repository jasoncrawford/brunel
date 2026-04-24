import { EventEmitter } from "node:events";
import * as Wire from "../../../shared/wire.js";
import { WebSocket } from "ws";
import type { WebSocket as WsSocket } from "ws";
import type { Task } from "./task.js";
import type { Repo } from "./repo.js";
import { db } from "../clients/db-client.js";
import type { Database } from "../../database.types.js";
import { log } from "../../utils.js";

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

export class Worker {
  static readonly events: EventEmitter = new EventEmitter();

  private constructor(readonly workerId: string) {}

  status: "idle" | "busy" | "disconnected" = "idle";
  currentTask?: Task;
  disconnectedAt?: Date;
  /** The repo this worker declared in its worker_hello. Always set at registration. */
  repo!: Repo;

  /** Serialized DB write chain — ensures mutations are persisted in order. */
  private _pendingWrite: Promise<void> = Promise.resolve();

  get currentTaskId(): string | undefined {
    return this.currentTask?.taskId;
  }

  /** Chain a DB write onto this worker's serialized write queue (fire-and-forget). */
  private _chain(fn: () => Promise<void>): void {
    this._pendingWrite = this._pendingWrite.then(fn).catch((err) =>
      log(`ERROR persisting worker ${this.workerId} to DB: ${String(err)}`),
    );
  }

  // ── Static registry operations ───────────────────────────────────────────

  static register(workerId: string, ws: WsSocket, repo: Repo): Worker {
    let worker = registry.get(workerId);
    if (!worker) {
      worker = new Worker(workerId);
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

  static get(workerId: string): Worker | undefined {
    return registry.get(workerId);
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
      const { data, error } = await (db.from as any)("workers")
        .select("*")
        .not("current_task_id", "is", null);
      if (!error && data) {
        fromDb = (data as WorkerDbRow[])
          .filter((row) => !connectedIds.has(row.worker_id))
          .map((row) => Worker._rowToWire(row));
      }
    } catch {
      // Non-critical: dashboard degrades to just connected workers on DB error
    }

    return [...connected, ...fromDb];
  }

  /**
   * Load a worker's DB row by ID.
   * Works even when the worker is disconnected (not in runtime registry).
   * Returns null if no record exists.
   */
  static async getDbRow(workerId: string): Promise<WorkerDbRow | null> {
    const { data, error } = await (db.from as any)("workers")
      .select("*")
      .eq("worker_id", workerId)
      .maybeSingle();
    if (error) throw error;
    return (data as WorkerDbRow | null) ?? null;
  }

  /** Clear registry and sockets — use in tests for isolation. */
  static _reset(): void {
    registry.clear();
    sockets.clear();
  }

  // ── DB persistence helpers ───────────────────────────────────────────────

  private static async _persistRegister(workerId: string, repo: Repo): Promise<void> {
    const now = new Date().toISOString();
    // Check if record already exists (reconnect vs. first connect)
    const { data: existing } = await (db.from as any)("workers")
      .select("*")
      .eq("worker_id", workerId)
      .maybeSingle() as { data: WorkerDbRow | null };

    if (existing) {
      await (db.from as any)("workers")
        .update({
          repo_id: repo.id,
          repo_full_name: repo.fullName,
          status: "idle",
          current_task_id: null,
          last_connected_at: now,
          num_connections: existing.num_connections + 1,
          disconnected_at: null,
          goodbye_at: null,
        })
        .eq("worker_id", workerId)
        .select()
        .single();
    } else {
      await (db.from as any)("workers")
        .insert({
          worker_id: workerId,
          repo_id: repo.id,
          repo_full_name: repo.fullName,
          status: "idle",
          current_task_id: null,
          first_connected_at: now,
          last_connected_at: now,
          num_connections: 1,
          disconnected_at: null,
          goodbye_at: null,
        })
        .select()
        .single();
    }
  }

  private static async _updateDb(workerId: string, changes: Partial<WorkerDbRow>): Promise<void> {
    await (db.from as any)("workers")
      .update(changes)
      .eq("worker_id", workerId)
      .select()
      .single();
  }

  static _rowToWire(row: WorkerDbRow): Wire.Worker {
    return {
      workerId: row.worker_id,
      status: row.status as "idle" | "busy" | "disconnected",
      currentTaskId: row.current_task_id ?? undefined,
      repo: row.repo_full_name,
      firstConnectedAt: row.first_connected_at,
      lastConnectedAt: row.last_connected_at,
      numConnections: row.num_connections,
      disconnectedAt: row.disconnected_at ?? undefined,
    };
  }

  // ── Instance operations ──────────────────────────────────────────────────

  assign(task: Task): void {
    this.status = "busy";
    this.currentTask = task;
    Worker.events.emit("changed");
    this._chain(() => Worker._updateDb(this.workerId, { status: "busy", current_task_id: task.taskId }));
  }

  release(): void {
    this.status = "idle";
    this.currentTask = undefined;
    Worker.events.emit("changed");
    this._chain(() => Worker._updateDb(this.workerId, { status: "idle", current_task_id: null }));
  }

  markDisconnected(): void {
    this.status = "disconnected";
    this.disconnectedAt = new Date();
    const disconnectedAt = this.disconnectedAt.toISOString();
    sockets.delete(this.workerId);
    Worker.events.emit("changed");
    this._chain(() => Worker._updateDb(this.workerId, {
      status: "disconnected",
      disconnected_at: disconnectedAt,
    }));
  }

  remove(): void {
    const now = new Date().toISOString();
    registry.delete(this.workerId);
    sockets.delete(this.workerId);
    Worker.events.emit("changed");
    this._chain(() => Worker._updateDb(this.workerId, {
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
      currentTaskId: this.currentTask?.taskId,
      repo: this.repo?.fullName,
    };
  }
}

// Disable max-listeners warning — tests call createForemanWss many times,
// each adding a listener to this static emitter.
Worker.events.setMaxListeners(0);
