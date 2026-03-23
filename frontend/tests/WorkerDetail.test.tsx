import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import WorkerDetail from "../src/pages/WorkerDetail.tsx";
import type { LogEntry, AdminMessage } from "../src/types.ts";

let capturedHandler: ((msg: AdminMessage) => void) | null = null;

vi.mock("../src/hooks/useAdminWs.ts", () => ({
  useAdminWs: (handler: (msg: AdminMessage) => void) => {
    capturedHandler = handler;
  },
}));

function renderWorkerDetail(workerId = "worker-abc-def-123") {
  return render(
    <MemoryRouter initialEntries={[`/workers/${workerId}`]}>
      <Routes>
        <Route path="/workers/:id" element={<WorkerDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

const msg1: LogEntry = {
  kind: "message",
  id: 1,
  timestamp: "2026-01-01T10:00:00.000Z",
  taskId: "42",
  workerId: "worker-abc-def-123",
  summary: "→ assign task 42",
};

const msg2: LogEntry = {
  kind: "message",
  id: 2,
  timestamp: "2026-01-01T10:01:00.000Z",
  taskId: "42",
  workerId: "worker-abc-def-123",
  summary: "← done task 42",
};

const otherWorkerMsg: LogEntry = {
  kind: "message",
  id: 3,
  timestamp: "2026-01-01T10:02:00.000Z",
  taskId: null,
  workerId: "other-worker-999",
  summary: "→ some other message",
};

describe("WorkerDetail", () => {
  beforeEach(() => {
    capturedHandler = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches from /api/workers/:id/messages on mount", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([]) }));
    renderWorkerDetail("worker-abc-def-123");
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/workers/worker-abc-def-123/messages")
    );
  });

  it("shows truncated worker id in heading", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([]) }));
    renderWorkerDetail("worker-abc-def-123");
    await waitFor(() => expect(screen.getByText(/Worker worker-a/)).toBeInTheDocument());
  });

  it("shows empty state when no messages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([]) }));
    renderWorkerDetail("worker-abc-def-123");
    await waitFor(() =>
      expect(screen.getByText("No messages for this worker.")).toBeInTheDocument()
    );
  });

  it("renders messages from API", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([msg1]) }));
    renderWorkerDetail("worker-abc-def-123");
    await waitFor(() => expect(screen.getByText("→ assign task 42")).toBeInTheDocument());
  });

  it("renders task link for messages with taskId", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([msg1]) }));
    renderWorkerDetail("worker-abc-def-123");
    await waitFor(() => expect(screen.getByText("#42")).toBeInTheDocument());
  });

  it("prepends new matching log_event messages from WebSocket", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([msg1]) }));
    renderWorkerDetail("worker-abc-def-123");
    await waitFor(() => expect(screen.getByText("→ assign task 42")).toBeInTheDocument());

    act(() => {
      capturedHandler!({ type: "log_event", entry: msg2 });
    });

    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(3); // header + 2 data rows
    // msg2 prepended — appears first
    expect(rows[1].textContent).toContain("← done task 42");
    expect(rows[2].textContent).toContain("→ assign task 42");
  });

  it("ignores log_event messages for different workers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([msg1]) }));
    renderWorkerDetail("worker-abc-def-123");
    await waitFor(() => expect(screen.getByText("→ assign task 42")).toBeInTheDocument());

    act(() => {
      capturedHandler!({ type: "log_event", entry: otherWorkerMsg });
    });

    expect(screen.getAllByRole("row")).toHaveLength(2); // header + 1 only
    expect(screen.queryByText("→ some other message")).not.toBeInTheDocument();
  });

  it("ignores snapshot WebSocket messages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([msg1]) }));
    renderWorkerDetail("worker-abc-def-123");
    await waitFor(() => expect(screen.getByText("→ assign task 42")).toBeInTheDocument());

    act(() => {
      capturedHandler!({ type: "snapshot", tasks: [], workers: [] });
    });

    expect(screen.getAllByRole("row")).toHaveLength(2); // header + 1 only
  });
});
