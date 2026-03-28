import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { useAdminWs } from "../hooks/useAdminWs.ts";
import type { LogEntry, AdminMessage } from "../types.ts";

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const [events, setEvents] = useState<LogEntry[]>([]);

  useEffect(() => {
    fetch(`/api/tasks/${id}/events`)
      .then((r) => r.json() as Promise<LogEntry[]>)
      .then(setEvents)
      .catch(console.error);
  }, [id]);

  const handleMessage = useCallback((msg: AdminMessage) => {
    if (msg.type === "log_event" && msg.entry.taskId === id) {
      setEvents((prev) => [msg.entry, ...prev]);
    }
  }, [id]);

  useAdminWs(handleMessage);

  return (
    <div>
      <h2>Task #{id}</h2>
      <p><Link to="/">← Dashboard</Link></p>
      {events.length === 0 ? <p>No events for this task.</p> : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace", fontSize: "0.85em" }}>
          <thead>
            <tr>
              <th style={th}>Time</th>
              <th style={th}>Kind</th>
              <th style={th}>Summary</th>
              <th style={th}>Worker</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={`${e.kind}-${e.id}`}>
                <td style={td}>{new Date(e.timestamp).toLocaleString()}</td>
                <td style={td}>{e.kind}</td>
                <td style={td}>{e.summary}</td>
                <td style={td}>{e.workerId ? <Link to={`/workers/${e.workerId}`}>{e.workerId.slice(0, 8)}</Link> : "—"}</td>
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
