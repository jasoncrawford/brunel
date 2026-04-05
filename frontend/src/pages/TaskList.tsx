import { useState, useEffect, useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAdminWs } from "../hooks/useAdminWs.ts";
import type { AdminMessage, TaskRow, TaskStatus } from "../types.ts";
import { shortWorkerId } from "../../../shared/utils.ts";

export default function TaskList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const statusFilter = (searchParams.get("status") ?? "all") as "all" | TaskStatus;
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const url = statusFilter === "all" ? "/api/tasks" : `/api/tasks?status=${statusFilter}`;
    setLoading(true);
    fetch(url)
      .then((r) => r.json() as Promise<TaskRow[]>)
      .then((data) => { setTasks(data); setLoading(false); })
      .catch((err) => { console.error(err); setLoading(false); });
  }, [statusFilter]);

  const handleMessage = useCallback((msg: AdminMessage) => {
    if (msg.type === "snapshot") {
      const statusMap = new Map(msg.tasks.map((t) => [t.taskId, t.status]));
      setTasks((prev) => prev.map((row) => {
        const newStatus = statusMap.get(row.taskId);
        return newStatus && newStatus !== row.status ? { ...row, status: newStatus } : row;
      }));
    }
  }, []);

  useAdminWs(handleMessage);

  function setFilter(s: "all" | TaskStatus) {
    if (s === "all") setSearchParams({});
    else setSearchParams({ status: s });
  }

  return (
    <div>
      <h2>Tasks</h2>

      <div style={{ marginBottom: "1rem" }}>
        {(["all", "pending", "blocked", "assigned", "pushed", "merged", "closed", "complete"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            style={{
              marginRight: "0.5rem",
              fontWeight: statusFilter === s ? "bold" : "normal",
              textDecoration: statusFilter === s ? "underline" : "none",
              background: "none",
              border: "1px solid #ccc",
              cursor: "pointer",
              padding: "2px 8px",
            }}
          >
            {s}
          </button>
        ))}
      </div>

      {loading ? <p>Loading…</p> : tasks.length === 0 ? <p>No tasks.</p> : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Issue</th>
              <th style={th}>Title</th>
              <th style={th}>Status</th>
              <th style={th}>Worker</th>
              <th style={th}>PR</th>
              <th style={th}>Created</th>
              <th style={th}>Completed</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.taskId}>
                <td style={td}><Link to={`/tasks/${t.taskId}`}>#{t.issueNumber}</Link></td>
                <td style={td}>{t.title}</td>
                <td style={td}>{t.status}</td>
                <td style={td}>{t.workerId
                  ? <Link to={`/workers/${t.workerId}`}>{shortWorkerId(t.workerId)}</Link>
                  : "—"}</td>
                <td style={td}>{t.prNumber
                  ? <a href={`https://github.com/${t.repo}/pull/${t.prNumber}`} target="_blank" rel="noreferrer">#{t.prNumber}</a>
                  : "—"}</td>
                <td style={td}>{new Date(t.createdAt).toLocaleString()}</td>
                <td style={td}>{t.completedAt ? new Date(t.completedAt).toLocaleString() : "—"}</td>
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
