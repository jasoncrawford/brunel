import { EventEmitter } from "events";
import type { ForemanMessage } from "../types.js";
import type { WebSocket as WsSocket } from "ws";
import type { WorkerSnapshot } from "./admin-ws.js";

export interface WorkerState {
  workerId: string;
  ws: WsSocket;
  status: "idle" | "busy" | "disconnected";
  currentTaskId?: string;
  disconnectedAt?: Date;
  disconnectTimer?: ReturnType<typeof setTimeout>;
}

export class WorkerRegistry extends EventEmitter {
  private workers = new Map<string, WorkerState>();

  register(workerId: string, ws: WsSocket, status: "idle" | "busy", taskId?: string): void {
    this.workers.set(workerId, { workerId, ws, status, currentTaskId: taskId });
    this.emit("changed");
  }

  get(workerId: string): WorkerState | undefined {
    return this.workers.get(workerId);
  }

  remove(workerId: string) {
    this.workers.delete(workerId);
    this.emit("changed");
  }

  markDisconnected(workerId: string) {
    const w = this.workers.get(workerId);
    if (!w) return;
    w.status = "disconnected";
    w.disconnectedAt = new Date();
    this.emit("changed");
  }

  getIdleWorker(): WorkerState | null {
    for (const w of this.workers.values()) {
      if (w.status === "idle") return w;
    }
    return null;
  }

  getIdleWorkers(): WorkerState[] {
    return [...this.workers.values()].filter((w) => w.status === "idle");
  }

  getWorkerForTask(taskId: string): WorkerState | null {
    for (const w of this.workers.values()) {
      if (w.currentTaskId === taskId) return w;
    }
    return null;
  }

  assignTask(workerId: string, taskId: string) {
    const w = this.workers.get(workerId);
    if (!w) return;
    w.status = "busy";
    w.currentTaskId = taskId;
    this.emit("changed");
  }

  releaseWorker(workerId: string) {
    const w = this.workers.get(workerId);
    if (!w) return;
    w.status = "idle";
    w.currentTaskId = undefined;
    this.emit("changed");
  }

  startReclaimTimer(workerId: string, timeoutMs: number, onReclaim: () => void): void {
    const w = this.workers.get(workerId);
    if (!w) return;
    if (w.disconnectTimer) clearTimeout(w.disconnectTimer);
    w.disconnectTimer = setTimeout(onReclaim, timeoutMs);
  }

  cancelReclaimTimer(workerId: string): void {
    const w = this.workers.get(workerId);
    if (!w?.disconnectTimer) return;
    clearTimeout(w.disconnectTimer);
    w.disconnectTimer = undefined;
  }

  send(workerId: string, msg: ForemanMessage) {
    const w = this.workers.get(workerId);
    if (w?.ws.readyState === 1 /* OPEN */) {
      w.ws.send(JSON.stringify(msg));
    }
  }

  getWorkerSnapshots(): WorkerSnapshot[] {
    return [...this.workers.values()].map((w) => ({
      workerId: w.workerId,
      status: w.status,
      currentTaskId: w.currentTaskId,
    }));
  }
}
