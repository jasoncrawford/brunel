import { EventEmitter } from "events";
import type { ForWorkerMsg } from "../../types.js";
import type { WebSocket as WsSocket } from "ws";
import type { WorkerSnapshot } from "../admin-ws.js";

const registry = new Map<string, Worker>();

export class Worker {
  static readonly events: EventEmitter = new EventEmitter();

  private constructor(
    readonly workerId: string,
    private ws: WsSocket,
  ) {}

  status: "idle" | "busy" | "disconnected" = "idle";
  currentTaskId?: string;
  disconnectedAt?: Date;

  // Static registry operations

  static register(workerId: string, ws: WsSocket): Worker {
    const worker = new Worker(workerId, ws);
    registry.set(workerId, worker);
    Worker.events.emit("changed");
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

  /** Clear registry — use in tests for isolation. */
  static _reset(): void {
    registry.clear();
  }

  // Instance operations

  assign(taskId: string): void {
    this.status = "busy";
    this.currentTaskId = taskId;
    Worker.events.emit("changed");
  }

  release(): void {
    this.status = "idle";
    this.currentTaskId = undefined;
    Worker.events.emit("changed");
  }

  markDisconnected(): void {
    this.status = "disconnected";
    this.disconnectedAt = new Date();
    Worker.events.emit("changed");
  }

  remove(): void {
    registry.delete(this.workerId);
    Worker.events.emit("changed");
  }

  isCurrentSocket(ws: WsSocket): boolean {
    return this.ws === ws;
  }

  send(msg: ForWorkerMsg): boolean {
    if (this.ws.readyState === 1 /* OPEN */) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  toSnapshot(): WorkerSnapshot {
    return {
      workerId: this.workerId,
      status: this.status,
      currentTaskId: this.currentTaskId,
    };
  }
}

// Disable max-listeners warning — tests call createForemanWss many times,
// each adding a listener to this static emitter.
Worker.events.setMaxListeners(0);
