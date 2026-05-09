import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import RepoDetail from "../src/pages/RepoDetail.tsx";
import type { LogEntry, AdminMessage, Repo, Task, Worker } from "../src/types.ts";

let capturedHandler: ((msg: AdminMessage) => void) | null = null;

vi.mock("../src/hooks/useAdminWs.ts", () => ({
  useAdminWs: (handler: (msg: AdminMessage) => void) => {
    capturedHandler = handler;
  },
}));

function renderRepoDetail(fullName = "user/my-repo") {
  return render(
    <MemoryRouter initialEntries={[`/repos/${fullName}`]}>
      <Routes>
        <Route path="/repos/:owner/:repo" element={<RepoDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

const mockRepo: Repo = { repoId: 5, fullName: "user/my-repo", status: "active" };

const mockTask: Task = {
  taskId: "99",
  issueNumber: 42,
  title: "Fix auth bug",
  status: "assigned",
  repo: "user/my-repo",
  assignedWorkerId: "worker-abc-123",
};

const mockWorker: Worker = {
  workerId: "worker-abc-123",
  status: "assigned",
  repo: "user/my-repo",
  currentTaskId: "99",
};

const entry1: LogEntry = {
  kind: "webhook",
  id: 1,
  timestamp: "2026-01-01T10:00:00.000Z",
  taskId: "99",
  workerId: null,
  summary: "issue labeled",
  repo: "user/my-repo",
};

const otherRepoEntry: LogEntry = {
  kind: "webhook",
  id: 2,
  timestamp: "2026-01-01T10:01:00.000Z",
  taskId: null,
  workerId: null,
  summary: "worker_hello from other repo",
  repo: "other/repo",
};

describe("RepoDetail", () => {
  beforeEach(() => {
    capturedHandler = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sets document.title to repo fullName when data loads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({ json: () => Promise.resolve(mockRepo) })
        .mockResolvedValueOnce({ json: () => Promise.resolve([]) })
    );
    renderRepoDetail();
    await waitFor(() => expect(document.title).toBe("user/my-repo \u2013 Brunel"));
  });

  it("fetches repo and log on mount", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({ json: () => Promise.resolve(mockRepo) })
        .mockResolvedValueOnce({ json: () => Promise.resolve([]) })
    );
    renderRepoDetail();
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/repos/user/my-repo");
      expect(fetch).toHaveBeenCalledWith("/api/repos/user/my-repo/log");
    });
  });

  it("renders tasks and workers from snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({ json: () => Promise.resolve(mockRepo) })
        .mockResolvedValueOnce({ json: () => Promise.resolve([]) })
    );
    renderRepoDetail();

    act(() => {
      capturedHandler!({
        type: "snapshot",
        repos: [mockRepo],
        tasks: [mockTask],
        workers: [mockWorker],
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Fix auth bug")).toBeInTheDocument();
      expect(screen.getByText(/0 ready.*1 assigned|1 assigned/)).toBeInTheDocument();
    });
  });

  it("prepends matching log_event from same repo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({ json: () => Promise.resolve(mockRepo) })
        .mockResolvedValueOnce({ json: () => Promise.resolve([entry1]) })
    );
    renderRepoDetail();
    await waitFor(() => expect(screen.getByText("issue labeled")).toBeInTheDocument());

    const newEntry: LogEntry = {
      kind: "message",
      id: 3,
      timestamp: "2026-01-01T10:02:00.000Z",
      taskId: "99",
      workerId: "worker-abc-123",
      summary: "task assigned",
      repo: "user/my-repo",
    };

    act(() => {
      capturedHandler!({ type: "log_event", entry: newEntry });
    });

    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(3); // header + 2 data rows
    expect(rows[1].textContent).toContain("task assigned"); // prepended
    expect(rows[2].textContent).toContain("issue labeled");
  });

  it("ignores log_event from a different repo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({ json: () => Promise.resolve(mockRepo) })
        .mockResolvedValueOnce({ json: () => Promise.resolve([entry1]) })
    );
    renderRepoDetail();
    await waitFor(() => expect(screen.getByText("issue labeled")).toBeInTheDocument());

    act(() => {
      capturedHandler!({ type: "log_event", entry: otherRepoEntry });
    });

    expect(screen.getAllByRole("row")).toHaveLength(2); // header + 1 only
    expect(screen.queryByText("worker_hello from other repo")).not.toBeInTheDocument();
  });
});
