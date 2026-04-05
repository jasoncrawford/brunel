import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadIssuesToQueue, fetchIssueStates, fetchNativeBlockers } from "../src/foreman/github.js";
import { TaskModel } from "../src/foreman/task-model.js";
import { fetchBlockers } from "../src/foreman/dependencies.js";
import type { DependencyGraph } from "../src/foreman/dependencies.js";

vi.mock("../src/foreman/dependencies.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/foreman/dependencies.js")>();
  return { ...actual, fetchBlockers: vi.fn().mockResolvedValue([]) };
});

const mockIssues = [
  { number: 1, title: "First issue", body: "body 1", labels: [{ name: "brunel:ready" }] },
  { number: 2, title: "Second issue", body: null, labels: [{ name: "brunel:ready" }] },
];

const OPTS = { repo: "owner/repo", token: "token123" };
const CONFIG_OPTS = { githubRepo: "owner/repo", githubToken: "token123", taskLabel: "brunel:ready" };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadIssuesToQueue", () => {
  it("fetches open issues with the task label and populates taskModel", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockIssues,
    } as any);

    const taskModel = new TaskModel();
    await loadIssuesToQueue(taskModel, new Map(), CONFIG_OPTS);

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("owner/repo/issues"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token123" }) }),
    );
    expect(taskModel.getLabeledIssues().get(1)?.issue.title).toBe("First issue");
    expect(taskModel.getLabeledIssues().get(2)?.issue.body).toBe(""); // null coerced to ""
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 403 } as any);
    await expect(loadIssuesToQueue(new TaskModel(), new Map(), CONFIG_OPTS)).rejects.toThrow("403");
  });
});

describe("fetchIssueStates", () => {
  it("returns open/closed state for each issue number", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ number: 1, state: "open" }) } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ number: 2, state: "closed" }) } as any);
    const states = await fetchIssueStates([1, 2], OPTS);
    expect(states.get(1)).toBe("open");
    expect(states.get(2)).toBe("closed");
  });

  it("returns empty map for empty input without calling fetch", async () => {
    const states = await fetchIssueStates([], OPTS);
    expect(fetch).not.toHaveBeenCalled();
    expect(states.size).toBe(0);
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as any);
    await expect(fetchIssueStates([1], OPTS)).rejects.toThrow("500");
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
    const blockers = await fetchNativeBlockers(42, OPTS);
    expect(blockers).toEqual([5, 7]);
  });

  it("returns empty array when issue has no blockers", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { repository: { issue: { blockedBy: { nodes: [] } } } },
      }),
    } as any);
    expect(await fetchNativeBlockers(42, OPTS)).toEqual([]);
  });

  it("returns empty array when GraphQL field is null (feature unavailable)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { repository: { issue: { blockedBy: null } } },
      }),
    } as any);
    expect(await fetchNativeBlockers(42, OPTS)).toEqual([]);
  });

  it("throws on non-ok HTTP response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 403 } as any);
    await expect(fetchNativeBlockers(42, OPTS)).rejects.toThrow("403");
  });
});

describe("loadIssuesToQueue with dependency graph", () => {
  it("populates graph and taskModel from blockers returned by fetchBlockers", async () => {
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

    vi.mocked(fetchBlockers).mockResolvedValueOnce([99]);

    const graph: DependencyGraph = new Map();
    const taskModel = new TaskModel();
    await loadIssuesToQueue(taskModel, graph, CONFIG_OPTS);

    expect(graph.get(1)).toEqual(new Set([99]));
    // Issue 1 is tracked (open), and blocker 99 is open
    expect(taskModel.getLabeledIssues().has(1)).toBe(true);
  });

  it("does not mark closed blocker as open", async () => {
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

    vi.mocked(fetchBlockers).mockResolvedValueOnce([50]);

    const graph: DependencyGraph = new Map();
    const taskModel = new TaskModel();
    await loadIssuesToQueue(taskModel, graph, CONFIG_OPTS);

    // Blocker 50 is closed, so isBlocked should be false
    expect(taskModel.isBlocked(2, graph)).toBe(false);
  });
});
