import { WebSocket } from "ws";
import * as Wire from "../../../shared/wire.js";
import { ForemanMessage } from "../models/foreman-message.js";
import { Worker } from "../models/worker.js";
import type { AdminWss } from "./admin-ws.js";

type AdminWssLike = Pick<AdminWss, "broadcastLogEvent">;
type LogEntryWithoutId = Omit<Wire.LogEntry, "id">;

export class WorkerMessenger {
  private nextBroadcastId = 1;
  private readonly adminWss?: AdminWssLike;

  constructor({ adminWss }: { adminWss?: AdminWssLike } = {}) {
    this.adminWss = adminWss;
  }

  send(worker: Worker, msg: Wire.ForemanMessage, opts: { logTaskId?: string; onError?: (err: Error) => void } = {}): boolean {
    const taskId = opts.logTaskId ?? (("taskId" in msg ? msg.taskId : null) ?? null);
    const sent = worker.send(msg, opts.onError);
    if (sent) {
      this._logAndBroadcastSent(worker.workerId, taskId, msg.type, msg as unknown as Record<string, unknown>, worker.repo.id, worker.repo.fullName);
    }
    return sent;
  }

  sendError(ws: WebSocket, message: string, fatal: boolean, workerId: string | null, repoId: number | null, taskId: string | null = null): void {
    const payload: Wire.ForemanMessage = { type: "foreman_error", message, fatal };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
    this._logAndBroadcastSent(workerId, taskId, payload.type, payload as unknown as Record<string, unknown>, repoId);
  }

  broadcastLogEvent(entry: LogEntryWithoutId): void {
    this.adminWss?.broadcastLogEvent({ ...entry, id: this.nextBroadcastId++ });
  }

  private _logAndBroadcastSent(workerId: string | null, taskId: string | null, msgType: string, payload: Record<string, unknown>, repoId: number | null, repo?: string): void {
    void ForemanMessage.log({ direction: "sent", workerId, taskId, repoId, msgType, payload });
    this._broadcastMessageEvent({ direction: "sent", workerId, taskId, msgType, payload, repo });
  }

  private _broadcastMessageEvent(data: { direction: string; workerId: string | null; taskId: string | null; msgType: string; payload?: Record<string, unknown>; repo?: string }): void {
    const summary = ForemanMessage.buildSummary(data.direction, data.msgType, data.taskId, data.payload ?? {});
    this.broadcastLogEvent({
      kind: "message",
      timestamp: new Date().toISOString(),
      taskId: data.taskId,
      workerId: data.workerId,
      repo: data.repo,
      summary,
    });
  }
}
