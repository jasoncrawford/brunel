import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import EventLog from "../src/pages/EventLog.tsx";
import type { LogEntry, AdminMessage } from "../src/types.ts";

// Capture useAdminWs callback so tests can trigger fake WS messages
let capturedHandler: ((msg: AdminMessage) => void) | null = null;

vi.mock("../src/hooks/useAdminWs.ts", () => ({
  useAdminWs: (handler: (msg: AdminMessage) => void) => {
    capturedHandler = handler;
  },
}));

function renderEventLog() {
  return render(
    <MemoryRouter>
      <EventLog />
    </MemoryRouter>
  );
}

const entry1: LogEntry = {
  kind: "webhook",
  id: 1,
  timestamp: "2026-01-01T10:00:00.000Z",
  taskId: "42",
  workerId: null,
  summary: "issue labeled",
};

const entry2: LogEntry = {
  kind: "message",
  id: 2,
  timestamp: "2026-01-01T10:01:00.000Z",
  taskId: "42",
  workerId: "worker-abc-123",
  summary: "task assigned",
};

describe("EventLog", () => {
  beforeEach(() => {
    capturedHandler = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches from /api/log on mount", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([]) }));
    renderEventLog();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/log"));
  });

  it("shows empty state when no events", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([]) }));
    renderEventLog();
    await waitFor(() => expect(screen.getByText("No events.")).toBeInTheDocument());
  });

  it("renders entries returned by the API", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([entry1]) }));
    renderEventLog();
    await waitFor(() => expect(screen.getByText("issue labeled")).toBeInTheDocument());
    expect(screen.getByText("webhook")).toBeInTheDocument();
  });

  it("renders task and worker links", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([entry2]) }));
    renderEventLog();
    await waitFor(() => expect(screen.getByText("#42")).toBeInTheDocument());
    expect(screen.getByText("worker-a")).toBeInTheDocument(); // first 8 chars of "worker-abc-123"
  });

  it("shows — when taskId or workerId is null", async () => {
    const noIds: LogEntry = { ...entry1, taskId: null, workerId: null };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([noIds]) }));
    renderEventLog();
    await waitFor(() => expect(screen.getAllByText("—").length).toBeGreaterThan(0));
  });

  it("prepends new log_event messages from WebSocket", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([entry1]) }));
    renderEventLog();
    await waitFor(() => expect(screen.getByText("issue labeled")).toBeInTheDocument());

    act(() => {
      capturedHandler!({ type: "log_event", entry: entry2 });
    });

    const rows = screen.getAllByRole("row");
    // header row + 2 data rows
    expect(rows).toHaveLength(3);
    // entry2 should appear before entry1 (prepended)
    expect(rows[1].textContent).toContain("task assigned");
    expect(rows[2].textContent).toContain("issue labeled");
  });

  it("ignores non-log_event WebSocket messages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([entry1]) }));
    renderEventLog();
    await waitFor(() => expect(screen.getByText("issue labeled")).toBeInTheDocument());

    act(() => {
      capturedHandler!({ type: "snapshot", tasks: [], workers: [] });
    });

    expect(screen.getAllByRole("row")).toHaveLength(2); // header + 1
  });
});
