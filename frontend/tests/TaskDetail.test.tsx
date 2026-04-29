import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import TaskDetail from "../src/pages/TaskDetail.tsx";
import type { LogEntry, AdminMessage } from "../src/types.ts";

let capturedHandler: ((msg: AdminMessage) => void) | null = null;

vi.mock("../src/hooks/useAdminWs.ts", () => ({
  useAdminWs: (handler: (msg: AdminMessage) => void) => {
    capturedHandler = handler;
  },
}));

function renderTaskDetail(taskId = "99") {
  return render(
    <MemoryRouter initialEntries={[`/tasks/${taskId}`]}>
      <Routes>
        <Route path="/tasks/:id" element={<TaskDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

const event1: LogEntry = {
  kind: "webhook",
  id: 1,
  timestamp: "2026-01-01T10:00:00.000Z",
  taskId: "99",
  workerId: null,
  summary: "issue labeled",
};

const event2: LogEntry = {
  kind: "message",
  id: 2,
  timestamp: "2026-01-01T10:01:00.000Z",
  taskId: "99",
  workerId: "worker-abc-123",
  summary: "task assigned",
};

const otherTaskEvent: LogEntry = {
  kind: "webhook",
  id: 3,
  timestamp: "2026-01-01T10:02:00.000Z",
  taskId: "55",
  workerId: null,
  summary: "other task event",
};

describe("TaskDetail", () => {
  beforeEach(() => {
    capturedHandler = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sets document.title to 'Task #99 – Brunel'", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([]) }));
    renderTaskDetail("99");
    expect(document.title).toBe("Task #99 \u2013 Brunel");
  });

  it("fetches from /api/tasks/:id/events on mount", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([]) }));
    renderTaskDetail("99");
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tasks/99/events"));
  });

  it("shows empty state when no events", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([]) }));
    renderTaskDetail("99");
    await waitFor(() => expect(screen.getByText("No events for this task.")).toBeInTheDocument());
  });

  it("renders events from API", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([event1]) }));
    renderTaskDetail("99");
    await waitFor(() => expect(screen.getByText("issue labeled")).toBeInTheDocument());
  });

  it("renders worker link for events with workerId", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([event2]) }));
    renderTaskDetail("99");
    await waitFor(() => expect(screen.getByText("worker-abc-123")).toBeInTheDocument());
  });

  it("appends matching log_event messages from WebSocket", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([event1]) }));
    renderTaskDetail("99");
    await waitFor(() => expect(screen.getByText("issue labeled")).toBeInTheDocument());

    act(() => {
      capturedHandler!({ type: "log_event", entry: event2 });
    });

    const rows = screen.getAllByRole("row");
    // header + 2 data rows
    expect(rows).toHaveLength(3);
    expect(rows[1].textContent).toContain("task assigned"); // prepended at top
  });

  it("ignores log_event messages for different tasks", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([event1]) }));
    renderTaskDetail("99");
    await waitFor(() => expect(screen.getByText("issue labeled")).toBeInTheDocument());

    act(() => {
      capturedHandler!({ type: "log_event", entry: otherTaskEvent });
    });

    expect(screen.getAllByRole("row")).toHaveLength(2); // header + 1 only
    expect(screen.queryByText("other task event")).not.toBeInTheDocument();
  });

  it("ignores snapshot WebSocket messages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([event1]) }));
    renderTaskDetail("99");
    await waitFor(() => expect(screen.getByText("issue labeled")).toBeInTheDocument());

    act(() => {
      capturedHandler!({ type: "snapshot", tasks: [], workers: [] });
    });

    expect(screen.getAllByRole("row")).toHaveLength(2); // header + 1 only
  });

  it("shows load-more button when first page is full (PAGE_SIZE entries)", async () => {
    const PAGE_SIZE = 50;
    const fullPage: LogEntry[] = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      kind: "webhook",
      id: i + 1,
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
      taskId: "99",
      workerId: null,
      summary: `event-${i}`,
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve(fullPage) }));
    renderTaskDetail("99");
    await waitFor(() => expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument());
  });

  it("does not show load-more button when first page is partial", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([event1, event2]) }));
    renderTaskDetail("99");
    await waitFor(() => expect(screen.getByText("issue labeled")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("clicking load-more fetches next page with before cursor", async () => {
    const PAGE_SIZE = 50;
    const firstPage: LogEntry[] = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      kind: "webhook",
      id: i + 1,
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
      taskId: "99",
      workerId: null,
      summary: `event-${i}`,
    }));
    const secondPage: LogEntry[] = [
      { kind: "webhook", id: PAGE_SIZE + 1, timestamp: new Date(Date.now() - PAGE_SIZE * 1000).toISOString(), taskId: "99", workerId: null, summary: "older-event" },
    ];
    const expectedCursor = firstPage[firstPage.length - 1].timestamp;

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("before")) {
        return Promise.resolve({ json: () => Promise.resolve(secondPage) });
      }
      return Promise.resolve({ json: () => Promise.resolve(firstPage) });
    }));

    renderTaskDetail("99");
    const btn = await screen.findByRole("button", { name: "Load more" });

    act(() => { fireEvent.click(btn); });

    await waitFor(() => expect(screen.getByText("older-event")).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith(
      `/api/tasks/99/events?before=${encodeURIComponent(expectedCursor)}`
    );
  });

  it("appends second page entries after first page", async () => {
    const PAGE_SIZE = 50;
    const firstPage: LogEntry[] = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      kind: "webhook",
      id: i + 1,
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
      taskId: "99",
      workerId: null,
      summary: `event-${i}`,
    }));
    const secondPage: LogEntry[] = [
      { kind: "webhook", id: PAGE_SIZE + 1, timestamp: new Date(Date.now() - PAGE_SIZE * 1000).toISOString(), taskId: "99", workerId: null, summary: "page-two-event" },
    ];

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("before")) {
        return Promise.resolve({ json: () => Promise.resolve(secondPage) });
      }
      return Promise.resolve({ json: () => Promise.resolve(firstPage) });
    }));

    renderTaskDetail("99");
    const btn = await screen.findByRole("button", { name: "Load more" });
    act(() => { fireEvent.click(btn); });

    await waitFor(() => expect(screen.getByText("page-two-event")).toBeInTheDocument());
    // All first-page entries still present
    expect(screen.getByText("event-0")).toBeInTheDocument();
    // Load-more gone after partial second page
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });
});
