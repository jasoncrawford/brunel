import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { WebSocket as WsSocket } from "ws";
import type { LogEntry, AdminMessage } from "../../../shared/wire.js";
import { TaskManager } from "../models/task-manager.js";
import { Worker } from "../models/worker.js";
import { Repo } from "../models/repo.js";

const MAX_RECENT_LOG = 30;

function debounce(fn: () => void | Promise<void>, delayMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void fn(); }, delayMs);
  };
}

export class AdminWss {
  private readonly clients = new Set<WsSocket>();
  private readonly recentLog: LogEntry[] = []; // newest first, capped at MAX_RECENT_LOG
  private readonly wss: WebSocketServer;

  constructor(server: http.Server) {
    this.wss = new WebSocketServer({ noServer: true });

    const debouncedBroadcast = debounce(() => this.sendSnapshot(), 10);
    TaskManager.events.on("changed", debouncedBroadcast);
    Worker.events.on("changed", debouncedBroadcast);
    Repo.events.on("changed", debouncedBroadcast);

    server.once("close", () => {
      TaskManager.events.off("changed", debouncedBroadcast);
      Worker.events.off("changed", debouncedBroadcast);
      Repo.events.off("changed", debouncedBroadcast);
    });

    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      const logMsg = JSON.stringify({ type: "initial_log", entries: this.recentLog.slice() } satisfies AdminMessage);
      void this.buildSnapshot().then((snapshot) => {
        ws.send(JSON.stringify({ type: "snapshot", ...snapshot } satisfies AdminMessage));
        ws.send(logMsg);
      });
      ws.on("close", () => this.clients.delete(ws));
    });

    server.on("upgrade", (req, socket, head) => {
      if (req.url === "/admin/ws") {
        this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
      }
      // Other paths (e.g. /worker) are handled by a different upgrade handler
    });
  }

  private async buildSnapshot() {
    return {
      tasks: await TaskManager.getAllTasksForBroadcast(),
      workers: await Worker.allForDashboard(),
      repos: (await Repo.list()).map((r) => r.toWire()),
    };
  }

  private async sendSnapshot(): Promise<void> {
    const snapshot = await this.buildSnapshot();
    this.broadcast({ type: "snapshot", ...snapshot });
  }

  private broadcast(msg: AdminMessage): void {
    const json = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
  }

  broadcastLogEvent(entry: LogEntry): void {
    this.recentLog.unshift(entry);
    if (this.recentLog.length > MAX_RECENT_LOG) this.recentLog.pop();
    this.broadcast({ type: "log_event", entry });
  }
}
