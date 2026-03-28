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

  it("fetches from /api/log on mount", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([]) }));
    renderDashboard();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/log"));
  });

  it("shows empty state when no events", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([]) }));
    renderDashboard();
    await waitFor(() => expect(screen.getByText("No events yet.")).toBeInTheDocument());
  });

  it("renders historical events loaded from the API", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([webhookEntry, messageEntry]) }));
    renderDashboard();
    await waitFor(() => expect(screen.getByText("issues/labeled #42")).toBeInTheDocument());
    expect(screen.getByText("sent task_assigned")).toBeInTheDocument();
  });

  it("shows both webhook and message kinds from API", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([webhookEntry, messageEntry]) }));
    renderDashboard();
    await waitFor(() => expect(screen.getByText("webhook")).toBeInTheDocument());
    expect(screen.getByText("message")).toBeInTheDocument();
  });

  it("prepends new log_event messages from WebSocket to historical events", async () => {
    const newEntry: LogEntry = { kind: "message", id: 3, timestamp: "2026-01-01T10:02:00.000Z", taskId: null, workerId: "worker-abc-123", summary: "received worker_hello" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([webhookEntry]) }));
    renderDashboard();
    await waitFor(() => expect(screen.getByText("issues/labeled #42")).toBeInTheDocument());

    act(() => {
      capturedHandler!({ type: "log_event", entry: newEntry });
    });

    expect(screen.getByText("received worker_hello")).toBeInTheDocument();
    expect(screen.getByText("issues/labeled #42")).toBeInTheDocument();
  });

  it("does not add events to log on snapshot messages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([]) }));
    renderDashboard();
    await waitFor(() => expect(screen.getByText("No events yet.")).toBeInTheDocument());

    act(() => {
      capturedHandler!({ type: "snapshot", tasks: [], workers: [] });
    });

    expect(screen.getByText("No events yet.")).toBeInTheDocument();
  });
});
