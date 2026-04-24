import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { useAdminWs } from "../hooks/useAdminWs.ts";
import type { Task, Worker, Repo, LogEntry, AdminMessage } from "../types.ts";
import { shortWorkerId } from "../../../shared/utils.ts";

export default function RepoDetail() {
  const { id } = useParams<{ id: string }>();
  const repoId = Number(id);

  const [repo, setRepo] = useState<Repo | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [recentLog, setRecentLog] = useState<LogEntry[]>([]);

  useEffect(() => {
    fetch(`/api/repos/${repoId}`)
      .then((r) => r.json() as Promise<Repo>)
      .then(setRepo)
      .catch(console.error);
    fetch(`/api/repos/${repoId}/log`)
      .then((r) => r.json() as Promise<LogEntry[]>)
      .then((entries) => setRecentLog(entries.slice(0, 50)))
      .catch(console.error);
  }, [repoId]);

  const handleMessage = useCallback((msg: AdminMessage) => {
    if (msg.type === "snapshot") {
      const repoRecord = msg.repos.find((r) => r.repoId === repoId);
      if (repoRecord) {
        setRepo(repoRecord);
        const repoTasks = msg.tasks.filter((t) => t.repo === repoRecord.fullName);
        setTasks(repoTasks);
        setWorkers(msg.workers.filter((w) => w.repo === repoRecord.fullName));
      }
    } else if (msg.type === "log_event") {
      if (repo && msg.entry.repo === repo.fullName) {
        setRecentLog((prev) => [msg.entry, ...prev].slice(0, 50));
      }
    }
  }, [repoId, repo]);

  useAdminWs(handleMessage);

  return (
    <div>
      <h2>{repo ? repo.fullName : `Repo #${id}`}</h2>
      <p><Link to="/">← Dashboard</Link></p>

      <section>
        <h3>Tasks ({tasks.length})</h3>
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
                    ? <Link to={`/workers/${t.assignedWorkerId}`}>{shortWorkerId(t.assignedWorkerId)}</Link>
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
                <Link to={`/workers/${w.workerId}`}>{shortWorkerId(w.workerId)}</Link>
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
              {recentLog.map((e) => (
                <tr key={`${e.kind}-${e.id}`}>
                  <td style={td}>{new Date(e.timestamp).toLocaleTimeString()}</td>
                  <td style={td}>{e.kind}</td>
                  <td style={td}>{e.summary}</td>
                  <td style={td}>{e.taskId ? <Link to={`/tasks/${e.taskId}`}>#{e.taskId}</Link> : "—"}</td>
                  <td style={td}>{e.workerId ? <Link to={`/workers/${e.workerId}`}>{shortWorkerId(e.workerId)}</Link> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

const th: React.CSSProperties = { textAlign: "left", borderBottom: "1px solid #ccc", padding: "4px 8px" };
const td: React.CSSProperties = { padding: "4px 8px", borderBottom: "1px solid #eee" };
