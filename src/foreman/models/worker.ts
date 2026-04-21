import { EventEmitter } from "node:events";
import * as Wire from "../../../shared/wire.js";
import { WebSocket } from "ws";
import type { WebSocket as WsSocket } from "ws";
import type { Task } from "./task.js";
import type { Repo } from "./repo.js";

const registry = new Map<string, Worker>();

export class Worker {
  static readonly events: EventEmitter = new EventEmitter();

  private constructor(
    readonly workerId: string,
    private ws: WsSocket,
  ) {}

  status: "idle" | "busy" | "disconnected" = "idle";
  currentTask?: Task;
  disconnectedAt?: Date;
  /** The repo this worker declared in its worker_hello. Set on first hello_ack. */
  repo?: Repo;

  get currentTaskId(): string | undefined {
    return this.currentTask?.taskId;
  }

  // Static registry operations

  static register(workerId: string, ws: WsSocket, repo?: Repo): Worker {
    const worker = new Worker(workerId, ws);
    worker.repo = repo;
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

  assign(task: Task): void {
    this.status = "busy";
    this.currentTask = task;
    Worker.events.emit("changed");
  }

  release(): void {
    this.status = "idle";
    this.currentTask = undefined;
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

  send(msg: Wire.ForemanMessage): boolean {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  toWire(): Wire.Worker {
    return {
      workerId: this.workerId,
      status: this.status,
      currentTaskId: this.currentTask?.taskId,
    };
  }
}

// Disable max-listeners warning — tests call createForemanWss many times,
// each adding a listener to this static emitter.
Worker.events.setMaxListeners(0);
