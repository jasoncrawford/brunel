import { useState, useEffect, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import { useAdminWs } from "../hooks/useAdminWs.ts";
import type { LogEntry, AdminMessage } from "../types.ts";
import { shortWorkerId } from "../../../shared/utils.ts";

const PAGE_SIZE = 50;

export default function EventLog() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const fetchPage = useCallback(async (before?: string) => {
    setLoading(true);
    try {
      const url = before ? `/api/log?before=${encodeURIComponent(before)}` : "/api/log";
      const data = await fetch(url).then((r) => r.json() as Promise<LogEntry[]>);
      setEntries((prev) => {
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
  }, []);

  useEffect(() => {
    fetchPage();
  }, [fetchPage]);

  const handleMessage = useCallback((msg: AdminMessage) => {
    if (msg.type === "log_event") {
      setEntries((prev) => {
        const key = `${msg.entry.kind}-${msg.entry.id}`;
        if (prev.some((e) => `${e.kind}-${e.id}` === key)) return prev;
        return [msg.entry, ...prev];
      });
    }
  }, []);

  useAdminWs(handleMessage);

  const loadMore = useCallback(() => {
    if (loading || !hasMore || entries.length === 0) return;
    fetchPage(entries[entries.length - 1].timestamp);
  }, [loading, hasMore, entries, fetchPage]);

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
      <h2>Event Log</h2>
      {entries.length === 0 && !loading ? <p>No events.</p> : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace", fontSize: "0.85em" }}>
          <thead>
            <tr>
              <th style={th}>Time</th>
              <th style={th}>Kind</th>
              <th style={th}>Summary</th>
              <th style={th}>Task</th>
              <th style={th}>Worker</th>
              <th style={th}>Repo</th>
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
                <td style={td}>{e.repo ?? "—"}</td>
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
