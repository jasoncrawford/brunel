import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { useAdminWs } from "../hooks/useAdminWs.ts";
import type { LogEntry, Worker, AdminMessage } from "../types.ts";
import { shortWorkerId } from "../../../shared/utils.ts";

export default function WorkerDetail() {
  const { id } = useParams<{ id: string }>();
  const [messages, setMessages] = useState<LogEntry[]>([]);
  const [worker, setWorker] = useState<Worker | null>(null);

  useEffect(() => {
    fetch(`/api/workers/${id}/messages`)
      .then((r) => r.json() as Promise<LogEntry[]>)
      .then(setMessages)
      .catch(console.error);
  }, [id]);

  const handleMessage = useCallback((msg: AdminMessage) => {
    if (msg.type === "snapshot") {
      const found = msg.workers.find((w) => w.workerId === id);
      if (found) setWorker(found);
    } else if (msg.type === "log_event" && msg.entry.workerId === id) {
      setMessages((prev) => [msg.entry, ...prev]);
    }
  }, [id]);

  useAdminWs(handleMessage);

  return (
    <div>
      <h2>Worker {id ? shortWorkerId(id) : ""}</h2>
      <p><Link to="/">← Dashboard</Link></p>

      {worker?.repo && (
        <p style={{ fontFamily: "monospace", fontSize: "0.9em", color: "#555" }}>
          Repo: {worker.repo}
        </p>
      )}

      {messages.length === 0 ? <p>No messages for this worker.</p> : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace", fontSize: "0.85em" }}>
          <thead>
            <tr>
              <th style={th}>Time</th>
              <th style={th}>Kind</th>
              <th style={th}>Summary</th>
              <th style={th}>Task</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((e) => (
              <tr key={`${e.kind}-${e.id}`}>
                <td style={td}>{new Date(e.timestamp).toLocaleString()}</td>
                <td style={td}>{e.kind}</td>
                <td style={td}>{e.summary}</td>
                <td style={td}>{e.taskId ? <Link to={`/tasks/${e.taskId}`}>#{e.taskId}</Link> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const th: React.CSSProperties = { textAlign: "left", borderBottom: "1px solid #ccc", padding: "4px 8px" };
const td: React.CSSProperties = { padding: "4px 8px", borderBottom: "1px solid #eee" };
