import { render, screen, waitFor, act } from "@testing-library/react";
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
});
