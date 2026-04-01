import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useAdminWs } from "../hooks/useAdminWs.ts";
import type { LogEntry, AdminMessage } from "../types.ts";
import { shortWorkerId } from "../../shared/utils.ts";

export default function EventLog() {
  const [entries, setEntries] = useState<LogEntry[]>([]);

  useEffect(() => {
    fetch("/api/log")
      .then((r) => r.json() as Promise<LogEntry[]>)
      .then(setEntries)
      .catch(console.error);
  }, []);

  const handleMessage = useCallback((msg: AdminMessage) => {
    if (msg.type === "log_event") {
      setEntries((prev) => [msg.entry, ...prev]);
    }
  }, []);

  useAdminWs(handleMessage);

  return (
    <div>
      <h2>Event Log</h2>
      {entries.length === 0 ? <p>No events.</p> : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace", fontSize: "0.85em" }}>
          <thead>
            <tr>
              <th style={th}>Time</th>
              <th style={th}>Kind</th>
              <th style={th}>Summary</th>
              <th style={th}>Task</th>
              <th style={th}>Worker</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={`${e.kind}-${e.id}`}>
                <td style={td}>{new Date(e.timestamp).toLocaleString()}</td>
                <td style={td}>{e.kind}</td>
                <td style={td}>{e.summary}</td>
                <td style={td}>{e.taskId ? <Link to={`/tasks/${e.taskId}`}>#{e.taskId}</Link> : "—"}</td>
                <td style={td}>{e.workerId ? <Link to={`/workers/${e.workerId}`}>{shortWorkerId(e.workerId)}</Link> : "—"}</td>
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
