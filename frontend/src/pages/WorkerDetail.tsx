import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { useAdminWs } from "../hooks/useAdminWs.ts";
import { usePageTitle } from "../hooks/usePageTitle.ts";
import type { LogEntry, Worker, AdminMessage } from "../types.ts";
import { shortWorkerId } from "../../../shared/utils.ts";

const PAGE_SIZE = 50;

export default function WorkerDetail() {
  const { id } = useParams<{ id: string }>();
  usePageTitle(id ? `${shortWorkerId(id)} \u2013 Brunel` : "Brunel");
  const [messages, setMessages] = useState<LogEntry[]>([]);
  const [worker, setWorker] = useState<Worker | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const fetchPage = useCallback(async (before?: string) => {
    setLoading(true);
    try {
      const url = before
        ? `/api/workers/${id}/messages?before=${encodeURIComponent(before)}`
        : `/api/workers/${id}/messages`;
      const data = await fetch(url).then((r) => r.json() as Promise<LogEntry[]>);
      setMessages((prev) => {
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
    // Fetch worker data from DB — works for disconnected workers too
    fetch(`/api/workers/${id}`)
      .then((r) => (r.ok ? (r.json() as Promise<Worker>) : Promise.resolve(null)))
      .then((data) => { if (data) setWorker(data); })
      .catch(console.error);
  }, [id]);

  useEffect(() => {
    fetchPage();
  }, [fetchPage]);

  const handleMessage = useCallback((msg: AdminMessage) => {
    if (msg.type === "snapshot") {
      const found = msg.workers.find((w) => w.workerId === id);
      if (found) setWorker(found); // live snapshot takes priority over REST data
    } else if (msg.type === "log_event" && msg.entry.workerId === id) {
      setMessages((prev) => [msg.entry, ...prev]);
    }
  }, [id]);

  useAdminWs(handleMessage);

  const loadMore = useCallback(() => {
    if (loading || !hasMore || messages.length === 0) return;
    fetchPage(messages[messages.length - 1].timestamp);
  }, [loading, hasMore, messages, fetchPage]);

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
      <h2>Worker {id ? shortWorkerId(id) : ""}</h2>
      <p><Link to="/">← Dashboard</Link></p>

      {worker?.repo && (
        <p style={{ fontFamily: "monospace", fontSize: "0.9em", color: "#555" }}>
          Repo: {worker.repo}
        </p>
      )}

      {worker?.status && (
        <p style={{ fontSize: "0.9em", color: "#555" }}>
          Status: {worker.status}
          {worker.version && (
            <span title={worker.protocolVersion !== undefined ? `Protocol v${worker.protocolVersion}` : undefined}>
              {` · v${worker.version}`}
            </span>
          )}
          {worker.numConnections !== undefined && ` · ${worker.numConnections} connection${worker.numConnections !== 1 ? "s" : ""}`}
          {worker.disconnectedAt && ` · disconnected ${new Date(worker.disconnectedAt).toLocaleString()}`}
        </p>
      )}

      {messages.length === 0 && !loading ? <p>No messages for this worker.</p> : (
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
const loadMoreBtn: React.CSSProperties = {
  padding: "4px 16px",
  fontFamily: "monospace",
  fontSize: "0.85em",
  cursor: "pointer",
};
