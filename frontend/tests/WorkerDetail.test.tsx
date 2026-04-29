import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
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

  it("sets document.title to short worker id", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([]) }));
    renderWorkerDetail("justice-a9bdda00-1234-5678-abcd-ef0123456789");
    expect(document.title).toBe("justice-a9bdda00 \u2013 Brunel");
  });

  it("fetches from /api/workers/:id/messages on mount", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([]) }));
    renderWorkerDetail("worker-abc-def-123");
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/workers/worker-abc-def-123/messages")
    );
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

  it("shows load-more button when first page is full (PAGE_SIZE messages)", async () => {
    const PAGE_SIZE = 50;
    const fullPage: LogEntry[] = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      kind: "message",
      id: i + 1,
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
      taskId: null,
      workerId: "worker-abc-def-123",
      summary: `msg-${i}`,
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve(fullPage) }));
    renderWorkerDetail("worker-abc-def-123");
    await waitFor(() => expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument());
  });

  it("does not show load-more button when first page is partial", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([msg1, msg2]) }));
    renderWorkerDetail("worker-abc-def-123");
    await waitFor(() => expect(screen.getByText("→ assign task 42")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("clicking load-more fetches next page with before cursor", async () => {
    const PAGE_SIZE = 50;
    const firstPage: LogEntry[] = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      kind: "message",
      id: i + 1,
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
      taskId: null,
      workerId: "worker-abc-def-123",
      summary: `msg-${i}`,
    }));
    const secondPage: LogEntry[] = [
      { kind: "message", id: PAGE_SIZE + 1, timestamp: new Date(Date.now() - PAGE_SIZE * 1000).toISOString(), taskId: null, workerId: "worker-abc-def-123", summary: "older-msg" },
    ];
    const expectedCursor = firstPage[firstPage.length - 1].timestamp;

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("before")) {
        return Promise.resolve({ json: () => Promise.resolve(secondPage) });
      }
      return Promise.resolve({ json: () => Promise.resolve(firstPage) });
    }));

    renderWorkerDetail("worker-abc-def-123");
    const btn = await screen.findByRole("button", { name: "Load more" });

    act(() => { fireEvent.click(btn); });

    await waitFor(() => expect(screen.getByText("older-msg")).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith(
      `/api/workers/worker-abc-def-123/messages?before=${encodeURIComponent(expectedCursor)}`
    );
  });

  it("appends second page entries after first page", async () => {
    const PAGE_SIZE = 50;
    const firstPage: LogEntry[] = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      kind: "message",
      id: i + 1,
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
      taskId: null,
      workerId: "worker-abc-def-123",
      summary: `msg-${i}`,
    }));
    const secondPage: LogEntry[] = [
      { kind: "message", id: PAGE_SIZE + 1, timestamp: new Date(Date.now() - PAGE_SIZE * 1000).toISOString(), taskId: null, workerId: "worker-abc-def-123", summary: "page-two-msg" },
    ];

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("before")) {
        return Promise.resolve({ json: () => Promise.resolve(secondPage) });
      }
      return Promise.resolve({ json: () => Promise.resolve(firstPage) });
    }));

    renderWorkerDetail("worker-abc-def-123");
    const btn = await screen.findByRole("button", { name: "Load more" });
    act(() => { fireEvent.click(btn); });

    await waitFor(() => expect(screen.getByText("page-two-msg")).toBeInTheDocument());
    expect(screen.getByText("msg-0")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });
});
