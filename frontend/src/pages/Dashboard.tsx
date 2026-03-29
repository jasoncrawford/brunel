import { useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { useAdminWs } from "../hooks/useAdminWs.ts";
import type { TaskSnapshot, WorkerSnapshot, LogEntry, AdminMessage } from "../types.ts";

export default function Dashboard() {
  const [tasks, setTasks] = useState<TaskSnapshot[]>([]);
  const [workers, setWorkers] = useState<WorkerSnapshot[]>([]);
  const [recentLog, setRecentLog] = useState<LogEntry[]>([]);

  const handleMessage = useCallback((msg: AdminMessage) => {
    if (msg.type === "snapshot") {
      setTasks(msg.tasks);
      setWorkers(msg.workers);
    } else if (msg.type === "initial_log") {
      setRecentLog(msg.entries.slice(0, 50));
    } else if (msg.type === "log_event") {
      setRecentLog((prev) => [msg.entry, ...prev].slice(0, 50));
    }
  }, []);

  useAdminWs(handleMessage);

  const pending = tasks.filter((t) => t.status === "pending").length;
  const assigned = tasks.filter((t) => t.status === "assigned").length;
  const done = tasks.filter((t) => t.status === "complete").length;

  return (
    <div>
      <h2>Dashboard</h2>

      <section>
        <h3>Tasks ({pending} pending · {assigned} assigned · {done} done)</h3>
        {tasks.length === 0 ? <p>No tasks.</p> : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Issue</th>
                <th style={th}>Title</th>
                <th style={th}>Status</th>
                <th style={th}>Worker</th>
                <th style={th}>PR</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.taskId}>
                  <td style={td}><Link to={`/tasks/${t.taskId}`}>#{t.issueNumber}</Link></td>
                  <td style={td}>{t.title}</td>
                  <td style={td}>{t.status}</td>
                  <td style={td}>{t.assignedWorkerId
                    ? <Link to={`/workers/${t.assignedWorkerId}`}>{t.assignedWorkerId.slice(0, 8)}</Link>
                    : "—"}</td>
                  <td style={td}>{t.prUrl
                    ? <a href={t.prUrl} target="_blank" rel="noreferrer">#{t.prNumber}</a>
                    : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h3>Workers ({workers.filter((w) => w.status === "idle").length} idle · {workers.filter((w) => w.status === "busy").length} busy)</h3>
        {workers.length === 0 ? <p>No workers connected.</p> : (
          <ul>
            {workers.map((w) => (
              <li key={w.workerId}>
                <Link to={`/workers/${w.workerId}`}>{w.workerId.slice(0, 8)}</Link>
                {" — "}{w.status}
                {w.currentTaskId && <> working on <Link to={`/tasks/${w.currentTaskId}`}>#{w.currentTaskId}</Link></>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h3>Recent Events</h3>
        {recentLog.length === 0 ? <p>No events yet.</p> : (
          <LogTable entries={recentLog} />
        )}
      </section>
    </div>
  );
}

function LogTable({ entries }: { entries: LogEntry[] }) {
  return (
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
            <td style={td}>{new Date(e.timestamp).toLocaleTimeString()}</td>
            <td style={td}>{e.kind}</td>
            <td style={td}>{e.summary}</td>
            <td style={td}>{e.taskId ? <Link to={`/tasks/${e.taskId}`}>#{e.taskId}</Link> : "—"}</td>
            <td style={td}>{e.workerId ? <Link to={`/workers/${e.workerId}`}>{e.workerId.slice(0, 8)}</Link> : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const th: React.CSSProperties = { textAlign: "left", borderBottom: "1px solid #ccc", padding: "4px 8px" };
const td: React.CSSProperties = { padding: "4px 8px", borderBottom: "1px solid #eee" };
