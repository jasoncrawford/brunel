import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Dashboard from "../src/pages/Dashboard.tsx";
import type { LogEntry, AdminMessage } from "../src/types.ts";

// Capture useAdminWs callback so tests can trigger fake WS messages
let capturedHandler: ((msg: AdminMessage) => void) | null = null;

vi.mock("../src/hooks/useAdminWs.ts", () => ({
  useAdminWs: (handler: (msg: AdminMessage) => void) => {
    capturedHandler = handler;
  },
}));

function renderDashboard() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>
  );
}

const webhookEntry: LogEntry = {
  kind: "webhook",
  id: 1,
  timestamp: "2026-01-01T10:00:00.000Z",
  taskId: "42",
  workerId: null,
  summary: "issues/labeled #42",
};

const messageEntry: LogEntry = {
  kind: "message",
  id: 2,
  timestamp: "2026-01-01T10:01:00.000Z",
  taskId: "42",
  workerId: "worker-abc-123",
  summary: "sent task_assigned",
};

describe("Dashboard", () => {
  beforeEach(() => {
    capturedHandler = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows empty state when no events", () => {
    renderDashboard();
    expect(screen.getByText("No events yet.")).toBeInTheDocument();
  });

  it("renders events from initial_log WebSocket message", async () => {
    renderDashboard();
    act(() => {
      capturedHandler!({ type: "initial_log", entries: [webhookEntry, messageEntry] });
    });
    expect(screen.getByText("issues/labeled #42")).toBeInTheDocument();
    expect(screen.getByText("sent task_assigned")).toBeInTheDocument();
  });

  it("shows both webhook and message kinds from initial_log", async () => {
    renderDashboard();
    act(() => {
      capturedHandler!({ type: "initial_log", entries: [webhookEntry, messageEntry] });
    });
    expect(screen.getByText("webhook")).toBeInTheDocument();
    expect(screen.getByText("message")).toBeInTheDocument();
  });

  it("prepends new log_event messages to events from initial_log", async () => {
    const newEntry: LogEntry = { kind: "message", id: 3, timestamp: "2026-01-01T10:02:00.000Z", taskId: null, workerId: "worker-abc-123", summary: "received worker_hello" };
    renderDashboard();

    act(() => {
      capturedHandler!({ type: "initial_log", entries: [webhookEntry] });
    });
    expect(screen.getByText("issues/labeled #42")).toBeInTheDocument();

    act(() => {
      capturedHandler!({ type: "log_event", entry: newEntry });
    });

    expect(screen.getByText("received worker_hello")).toBeInTheDocument();
    expect(screen.getByText("issues/labeled #42")).toBeInTheDocument();
  });

  it("does not add events to log on snapshot messages", async () => {
    renderDashboard();
    act(() => {
      capturedHandler!({ type: "snapshot", tasks: [], workers: [] });
    });
    expect(screen.getByText("No events yet.")).toBeInTheDocument();
  });

  it("shows PR column header in tasks table", async () => {
    renderDashboard();
    act(() => {
      capturedHandler!({
        type: "snapshot",
        tasks: [{ taskId: "42", issueNumber: 42, title: "Fix bug", status: "assigned", assignedWorkerId: "w1" }],
        workers: [],
      });
    });
    expect(screen.getByText("PR")).toBeInTheDocument();
  });

  it("shows PR link when task has a prUrl", async () => {
    renderDashboard();
    act(() => {
      capturedHandler!({
        type: "snapshot",
        tasks: [{ taskId: "42", issueNumber: 42, title: "Fix bug", status: "assigned", prUrl: "https://github.com/test/repo/pull/7" }],
        workers: [],
      });
    });
    const link = screen.getByRole("link", { name: "PR" });
    expect(link).toHaveAttribute("href", "https://github.com/test/repo/pull/7");
  });

  it("shows dash when task has no prUrl", async () => {
    renderDashboard();
    act(() => {
      capturedHandler!({
        type: "snapshot",
        tasks: [{ taskId: "42", issueNumber: 42, title: "Fix bug", status: "pending" }],
        workers: [],
      });
    });
    // PR column should show "—" for tasks without a PR
    const cells = screen.getAllByText("—");
    expect(cells.length).toBeGreaterThan(0);
  });

  it("replaces existing events when a new initial_log arrives (reconnect)", async () => {
    const freshEntry: LogEntry = { kind: "webhook", id: 10, timestamp: "2026-01-02T00:00:00.000Z", taskId: null, workerId: null, summary: "new event after reconnect" };
    renderDashboard();

    act(() => {
      capturedHandler!({ type: "initial_log", entries: [webhookEntry] });
    });
    expect(screen.getByText("issues/labeled #42")).toBeInTheDocument();

    act(() => {
      capturedHandler!({ type: "initial_log", entries: [freshEntry] });
    });
    expect(screen.getByText("new event after reconnect")).toBeInTheDocument();
    expect(screen.queryByText("issues/labeled #42")).not.toBeInTheDocument();
  });

  it("does not fetch from /api/log on mount", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderDashboard();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
