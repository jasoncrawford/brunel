import { useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { useAdminWs } from "../hooks/useAdminWs.ts";
import type { Task, Worker, Repo, LogEntry, AdminMessage } from "../types.ts";
import { shortWorkerId } from "../../../shared/utils.ts";

export default function Dashboard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [recentLog, setRecentLog] = useState<LogEntry[]>([]);

  const handleMessage = useCallback((msg: AdminMessage) => {
    if (msg.type === "snapshot") {
      setTasks(msg.tasks);
      setWorkers(msg.workers);
      setRepos(msg.repos ?? []);
    } else if (msg.type === "initial_log") {
      setRecentLog(msg.entries.slice(0, 50));
    } else if (msg.type === "log_event") {
      setRecentLog((prev) => [msg.entry, ...prev].slice(0, 50));
    }
  }, []);

  useAdminWs(handleMessage);

  const stats = [
    { label: "blocked", count: tasks.filter((t) => t.status === "blocked").length },
    { label: "pending", count: tasks.filter((t) => t.status === "pending").length },
    { label: "assigned", count: tasks.filter((t) => t.status === "assigned").length },
    { label: "pushed", count: tasks.filter((t) => t.status === "pushed").length },
    { label: "merged", count: tasks.filter((t) => t.status === "merged").length },
    { label: "closed", count: tasks.filter((t) => t.status === "closed").length },
    { label: "done", count: tasks.filter((t) => t.status === "complete").length },
  ].filter((s) => s.count > 0);

  const statsText = stats.length > 0
    ? stats.map((s) => `${s.count} ${s.label}`).join(" · ")
    : "none";

  const multiRepo = repos.length > 1;

  return (
    <div>
      <h2>Dashboard</h2>

      {repos.length > 0 && (
        <section style={{ marginBottom: "2rem" }}>
          <h3>Repos ({repos.length})</h3>
          <ul>
            {repos.map((r) => (
              <li key={r.repoId}>
                <Link to={`/repos/${r.repoId}`}>{r.fullName}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3>Tasks ({statsText})</h3>
        {tasks.length === 0 ? <p>No tasks.</p> : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Issue</th>
                <th style={th}>Title</th>
                <th style={th}>Status</th>
                <th style={th}>Worker</th>
                <th style={th}>PR</th>
                {multiRepo && <th style={th}>Repo</th>}
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
                  {multiRepo && <td style={td}>{repoLink(t.repo, repos)}</td>}
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
                {multiRepo && w.repo && <> · {repoLink(w.repo, repos)}</>}
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
            <td style={td}>{e.workerId ? <Link to={`/workers/${e.workerId}`}>{shortWorkerId(e.workerId)}</Link> : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function repoLink(fullName: string | undefined, repos: Repo[]): React.ReactNode {
  if (!fullName) return "—";
  const repo = repos.find((r) => r.fullName === fullName);
  if (repo) return <Link to={`/repos/${repo.repoId}`}>{fullName}</Link>;
  return fullName;
}

const th: React.CSSProperties = { textAlign: "left", borderBottom: "1px solid #ccc", padding: "4px 8px" };
const td: React.CSSProperties = { padding: "4px 8px", borderBottom: "1px solid #eee" };
