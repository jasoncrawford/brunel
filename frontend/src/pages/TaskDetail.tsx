import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { useAdminWs } from "../hooks/useAdminWs.ts";
import { usePageTitle } from "../hooks/usePageTitle.ts";
import type { LogEntry, AdminMessage, Task } from "../types.ts";
import { shortWorkerId } from "../../../shared/utils.ts";

const PAGE_SIZE = 50;

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  usePageTitle(`Task #${id} \u2013 Brunel`);
  const [events, setEvents] = useState<LogEntry[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const fetchPage = useCallback(async (before?: string) => {
    setLoading(true);
    try {
      const url = before
        ? `/api/tasks/${id}/events?before=${encodeURIComponent(before)}`
        : `/api/tasks/${id}/events`;
      const data = await fetch(url).then((r) => r.json() as Promise<LogEntry[]>);
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => `${e.kind}-${e.id}`));
        const fresh = data.filter((e) => !seen.has(`${e.kind}-${e.id}`));
        return [...prev, ...fresh];
      });
      setHasMore(data.length === PAGE_SIZE);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetch(`/api/tasks/${id}`)
      .then((r) => r.json() as Promise<Task>)
      .then(setTask)
      .catch(console.error);
  }, [id]);

  useEffect(() => {
    fetchPage();
  }, [fetchPage]);

  const handleMessage = useCallback((msg: AdminMessage) => {
    if (msg.type === "snapshot") {
      const found = msg.tasks.find((t) => t.taskId === id);
      if (found) setTask(found);
    } else if (msg.type === "log_event" && msg.entry.taskId === id) {
      setEvents((prev) => [msg.entry, ...prev]);
    }
  }, [id]);

  useAdminWs(handleMessage);

  const loadMore = useCallback(() => {
    if (loading || !hasMore || events.length === 0) return;
    fetchPage(events[events.length - 1].timestamp);
  }, [loading, hasMore, events, fetchPage]);

  useEffect(() => {
    if (!hasMore || loading) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) loadMore(); },
      { rootMargin: "0px 0px 200px 0px", threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, loadMore]);

  return (
    <div>
      <h2>Task #{id}</h2>
      <p><Link to="/">← Dashboard</Link></p>

      {task?.repo && (
        <p style={{ fontFamily: "monospace", fontSize: "0.9em", color: "#555" }}>
          Repo: {task.repo}
        </p>
      )}

      {task && (task.inputTokens != null || task.outputTokens != null) && (
        <section style={{ marginBottom: "1rem", fontFamily: "monospace", fontSize: "0.9em", color: "#555" }}>
          <span>Tokens: {(task.inputTokens ?? 0).toLocaleString()} in / {(task.outputTokens ?? 0).toLocaleString()} out</span>
          {task.costUsd != null && <span style={{ marginLeft: "1rem" }}>Cost: ${task.costUsd.toFixed(4)}</span>}
        </section>
      )}

      {task?.blockers && task.blockers.length > 0 && (
        <section style={{ marginBottom: "1.5rem" }}>
          <h3>Dependencies</h3>
          <ul style={{ margin: 0, paddingLeft: "1.5rem" }}>
            {task.blockers.map((b) => (
              <li key={b.issueNumber} style={b.isOpen ? blockerOpen : blockerClosed}>
                #{b.issueNumber}
              </li>
            ))}
          </ul>
        </section>
      )}

      {events.length === 0 && !loading ? <p>No events for this task.</p> : (
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
                <td style={td}>{e.workerId ? <Link to={`/workers/${e.workerId}`}>{shortWorkerId(e.workerId)}</Link> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {hasMore && (
        <div ref={sentinelRef} style={{ padding: "8px", textAlign: "center" }}>
          {loading
            ? <span style={{ color: "#888", fontFamily: "monospace", fontSize: "0.85em" }}>Loading…</span>
            : <button onClick={loadMore} style={loadMoreBtn}>Load more</button>}
        </div>
      )}
    </div>
  );
}

const th: React.CSSProperties = { textAlign: "left", borderBottom: "1px solid #ccc", padding: "4px 8px" };
const td: React.CSSProperties = { padding: "4px 8px", borderBottom: "1px solid #eee" };
const blockerOpen: React.CSSProperties = { color: "#c00" };
const blockerClosed: React.CSSProperties = { color: "#999", textDecoration: "line-through" };
const loadMoreBtn: React.CSSProperties = {
  padding: "4px 16px",
  fontFamily: "monospace",
  fontSize: "0.85em",
  cursor: "pointer",
};
