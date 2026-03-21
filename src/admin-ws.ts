import http from "http";
import { WebSocketServer } from "ws";
import type { WebSocket as WsSocket } from "ws";

export interface LogEntry {
  kind: string;
  id: number;
  timestamp: string;
  taskId: string | null;
  workerId: string | null;
  summary: string;
}

export interface TaskSnapshot {
  taskId: string;
  issueNumber: number;
  title: string;
  status: "pending" | "assigned" | "complete";
  assignedWorkerId?: string;
}

export interface WorkerSnapshot {
  workerId: string;
  status: "idle" | "busy";
  currentTaskId?: string;
}

export interface AdminSnapshot {
  tasks: TaskSnapshot[];
  workers: WorkerSnapshot[];
}

export type AdminMessage =
  | { type: "snapshot"; tasks: TaskSnapshot[]; workers: WorkerSnapshot[] }
  | { type: "log_event"; entry: LogEntry };

export interface AdminWss {
  broadcastSnapshot(snapshot: AdminSnapshot): void;
  broadcastLogEvent(entry: LogEntry): void;
}

export function createAdminWss(server: http.Server): AdminWss {
  const clients = new Set<WsSocket>();
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/admin/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
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
      broadcast({ type: "log_event", entry });
    },
  };
}
