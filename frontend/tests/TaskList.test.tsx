import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import TaskList from "../src/pages/TaskList.tsx";
import type { AdminMessage, TaskRow } from "../src/types.ts";

let capturedHandler: ((msg: AdminMessage) => void) | null = null;

vi.mock("../src/hooks/useAdminWs.ts", () => ({
  useAdminWs: (handler: (msg: AdminMessage) => void) => {
    capturedHandler = handler;
  },
}));

const assignedTask: TaskRow = {
  taskId: "42",
  issueNumber: 42,
  repo: "owner/repo",
  title: "Fix the bug",
  status: "assigned",
  workerId: "worker-abc-123",
  prNumber: null,
  branch: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  assignedAt: "2026-01-01T01:00:00.000Z",
  completedAt: null,
};

function renderTaskList() {
  return render(
    <MemoryRouter>
      <TaskList />
    </MemoryRouter>
  );
}

describe("TaskList", () => {
  beforeEach(() => {
    capturedHandler = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches tasks from /api/tasks on mount", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([]) }));
    renderTaskList();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tasks"));
  });

  it("shows tasks loaded from the API", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([assignedTask]) }));
    renderTaskList();
    await waitFor(() => expect(screen.getByText("Fix the bug")).toBeInTheDocument());
    // The status cell shows "assigned" (the filter buttons also say "assigned", so use getAllByText)
    expect(screen.getAllByText("assigned").length).toBeGreaterThanOrEqual(1);
  });

  it("updates task status to complete when snapshot arrives via WebSocket", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([assignedTask]) }));
    renderTaskList();
    await waitFor(() => expect(screen.getByText("Fix the bug")).toBeInTheDocument());

    act(() => {
      capturedHandler!({
        type: "snapshot",
        tasks: [{ taskId: "42", issueNumber: 42, title: "Fix the bug", status: "complete" }],
        workers: [],
      });
    });

    // Status cell should now show "complete"; the filter button "assigned" may still exist
    // but the task row status cell should NOT show "assigned"
    const rows = screen.getAllByRole("row");
    // rows[0] = header, rows[1] = task row
    expect(rows[1].textContent).toContain("complete");
    expect(rows[1].textContent).not.toContain("assigned");
  });

  it("does not change status when snapshot has no matching task", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve([assignedTask]) }));
    renderTaskList();
    await waitFor(() => expect(screen.getByText("Fix the bug")).toBeInTheDocument());

    act(() => {
      capturedHandler!({
        type: "snapshot",
        tasks: [{ taskId: "99", issueNumber: 99, title: "Other task", status: "complete" }],
        workers: [],
      });
    });

    const rows = screen.getAllByRole("row");
    expect(rows[1].textContent).toContain("assigned");
  });
});
