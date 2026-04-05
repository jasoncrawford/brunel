import http from "http";
import { WebSocketServer } from "ws";
import type { WebSocket as WsSocket } from "ws";
import type { TaskStatus } from "../types.js";

export interface LogEntry {
  kind: string;
  id: number;
  timestamp: string;
  taskId: string | null;
  workerId: string | null;
  summary: string;
}

export interface BlockerInfo {
  issueNumber: number;
  isOpen: boolean;
}

export interface TaskSnapshot {
  taskId: string;
  issueNumber: number;
  title: string;
  status: TaskStatus;
  assignedWorkerId?: string;
  prNumber?: number;
  prUrl?: string;
  blockers?: BlockerInfo[];
}

export interface WorkerSnapshot {
  workerId: string;
  status: "idle" | "busy" | "disconnected";
  currentTaskId?: string;
}

export interface AdminSnapshot {
  tasks: TaskSnapshot[];
  workers: WorkerSnapshot[];
}

export type AdminMessage =
  | { type: "snapshot"; tasks: TaskSnapshot[]; workers: WorkerSnapshot[] }
  | { type: "initial_log"; entries: LogEntry[] }
  | { type: "log_event"; entry: LogEntry };

export interface AdminWss {
  broadcastSnapshot(snapshot: AdminSnapshot): void;
  broadcastLogEvent(entry: LogEntry): void;
}

const MAX_RECENT_LOG = 30;

export function createAdminWss(server: http.Server, getSnapshot?: () => AdminSnapshot): AdminWss {
  const clients = new Set<WsSocket>();
  const recentLog: LogEntry[] = []; // newest first, capped at MAX_RECENT_LOG
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    clients.add(ws);
    if (getSnapshot) {
      const snapshot = getSnapshot();
      ws.send(JSON.stringify({ type: "snapshot", ...snapshot } satisfies AdminMessage));
    }
    ws.send(JSON.stringify({ type: "initial_log", entries: recentLog.slice() } satisfies AdminMessage));
    ws.on("close", () => clients.delete(ws));
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/admin/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    }
    // Other paths (e.g. /worker) are handled by a different upgrade handler
  });

  function broadcast(msg: AdminMessage) {
    const json = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === 1 /* OPEN */) ws.send(json);
    }
  }

  return {
    broadcastSnapshot(snapshot) {
      broadcast({ type: "snapshot", ...snapshot });
    },
    broadcastLogEvent(entry) {
      recentLog.unshift(entry);
      if (recentLog.length > MAX_RECENT_LOG) recentLog.pop();
      broadcast({ type: "log_event", entry });
    },
  };
}
