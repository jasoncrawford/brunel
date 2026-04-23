import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadIssuesToQueue, fetchIssueStates, fetchNativeBlockers } from "../src/foreman/clients/github.js";
import { Task } from "../src/foreman/models/task.js";
import { Worker } from "../src/foreman/models/worker.js";
import { fakeRepo, resetDb, createTestTaskManager } from "./helpers/task.js";
import { getConfig } from "../src/config.js";

const mockIssues = [
  { number: 1, title: "First issue", body: "body 1", labels: [{ name: "brunel:ready" }] },
  { number: 2, title: "Second issue", body: null, labels: [{ name: "brunel:ready" }] },
];

beforeEach(() => {
  Worker._reset();
  vi.stubGlobal("fetch", vi.fn());
  getConfig().githubRepo = "owner/repo";
  getConfig().githubToken = "token123";
  getConfig().taskLabel = "brunel:ready";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loadIssuesToQueue", () => {
  it("fetches open issues with the task label and populates taskManager", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockIssues,
    } as any);

    resetDb();
    const taskManager = await createTestTaskManager("owner/repo");
    vi.spyOn(taskManager, "fetchBlockers").mockResolvedValue([]);

    await loadIssuesToQueue(taskManager);

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("owner/repo/issues"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token123" }) }),
    );
    expect((await Task.getByRepoIssue(taskManager.repo.id,1))?.title).toBe("First issue");
    expect((await Task.getByRepoIssue(taskManager.repo.id,2))?.body).toBe(""); // null coerced to ""
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 403 } as any);
    resetDb();
    const taskManager = await createTestTaskManager("owner/repo");
    await expect(loadIssuesToQueue(taskManager)).rejects.toThrow("403");
  });

  it("preserves existing task assignment when syncing content during startup", async () => {
    // This tests the fix for issue #600: during startup, loadIssuesToQueue calls upsert
    // for all labeled issues (including already-assigned ones). The upsert must NOT reset
    // worker_id/assigned_at — otherwise the task gets reassigned to a different idle worker.
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => [{ number: 1, title: "Updated title", body: "Updated body", labels: [{ name: "brunel:ready" }] }],
    } as any);

    resetDb();
    const taskManager = await createTestTaskManager("owner/repo");
    vi.spyOn(taskManager, "fetchBlockers").mockResolvedValue([]);

    // Task #1 already exists and is assigned to a worker (simulates foreman restart)
    await Task.upsert("1", 1, "owner/repo", "Original title", "Original body", ["brunel:ready"]);
    const t = await Task.getByRepoIssue(taskManager.repo.id,1);
    const fakeWs = { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    await t!.assign(Worker.register("worker-abc", fakeWs, fakeRepo()));
    expect(t!.workerId).toBe("worker-abc");

    // loadIssuesToQueue runs during startup and calls upsert for the same issue
    await loadIssuesToQueue(taskManager);

    // Content should be updated, but assignment must be preserved
    const task = await Task.getByRepoIssue(taskManager.repo.id,1);
    expect(task?.title).toBe("Updated title");
    expect(task?.body).toBe("Updated body");
    expect(task?.workerId).toBe("worker-abc"); // MUST NOT be reset to null
  });
});

describe("fetchIssueStates", () => {
  it("returns open/closed state for each issue number", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ number: 1, state: "open" }) } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ number: 2, state: "closed" }) } as any);
    const states = await fetchIssueStates([1, 2], "owner/repo");
    expect(states.get(1)).toBe("open");
    expect(states.get(2)).toBe("closed");
  });

  it("uses the provided repo in the API URL", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ number: 1, state: "open" }) } as any);
    await fetchIssueStates([1], "other-owner/other-repo");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("other-owner/other-repo/issues/1"),
      expect.anything(),
    );
  });

  it("returns empty map for empty input without calling fetch", async () => {
    const states = await fetchIssueStates([], "owner/repo");
    expect(fetch).not.toHaveBeenCalled();
    expect(states.size).toBe(0);
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as any);
    await expect(fetchIssueStates([1], "owner/repo")).rejects.toThrow("500");
  });
});

describe("fetchNativeBlockers", () => {
  it("returns blocker issue numbers from GraphQL response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          repository: {
            issue: {
              blockedBy: { nodes: [{ number: 5 }, { number: 7 }] },
            },
          },
        },
      }),
    } as any);
    const blockers = await fetchNativeBlockers(42, "owner/repo");
    expect(blockers).toEqual([5, 7]);
  });

  it("uses the provided repo in the GraphQL variables", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { repository: { issue: { blockedBy: { nodes: [] } } } } }),
    } as any);
    await fetchNativeBlockers(42, "other-owner/other-repo");
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.variables.owner).toBe("other-owner");
    expect(body.variables.repo).toBe("other-repo");
  });

  it("returns empty array when issue has no blockers", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { repository: { issue: { blockedBy: { nodes: [] } } } },
      }),
    } as any);
    expect(await fetchNativeBlockers(42, "owner/repo")).toEqual([]);
  });

  it("returns empty array when GraphQL field is null (feature unavailable)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { repository: { issue: { blockedBy: null } } },
      }),
    } as any);
    expect(await fetchNativeBlockers(42, "owner/repo")).toEqual([]);
  });

  it("throws on non-ok HTTP response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 403 } as any);
    await expect(fetchNativeBlockers(42, "owner/repo")).rejects.toThrow("403");
  });
});

describe("loadIssuesToQueue with blockers", () => {
  it("populates taskManager blockers from fetchBlockers result", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { number: 1, title: "Do thing", body: "Depends on #99", labels: [{ name: "brunel:ready" }] },
        ],
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ number: 99, state: "open" }),
      } as any);

    resetDb();
    const taskManager = await createTestTaskManager("owner/repo");
    vi.spyOn(taskManager, "fetchBlockers").mockResolvedValueOnce([99]);

    await loadIssuesToQueue(taskManager);

    // Issue 1 is tracked and blocked by 99 which is open
    expect(taskManager.isBlockersLoaded(1)).toBe(true);
    expect(taskManager.isBlocked(1)).toBe(true);
  });

  it("does not mark closed blocker as blocking", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { number: 2, title: "Another", body: "Depends on #50", labels: [{ name: "brunel:ready" }] },
        ],
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ number: 50, state: "closed" }),
      } as any);

    resetDb();
    const taskManager = await createTestTaskManager("owner/repo");
    vi.spyOn(taskManager, "fetchBlockers").mockResolvedValueOnce([50]);

    await loadIssuesToQueue(taskManager);

    // Blocker 50 is closed, so isBlocked should be false
    expect(taskManager.isBlocked(2)).toBe(false);
  });
});
