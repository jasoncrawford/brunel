import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadIssuesToQueue, labelIssueDone, fetchIssueStates, fetchNativeBlockers } from "../src/github.js";
import { TaskQueue } from "../src/foreman.js";

const mockIssues = [
  { number: 1, title: "First issue", body: "body 1", labels: [{ name: "brunel:ready" }] },
  { number: 2, title: "Second issue", body: null, labels: [{ name: "brunel:ready" }] },
];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  process.env.GITHUB_REPO = "owner/repo";
  process.env.GITHUB_TOKEN = "token123";
  process.env.TASK_LABEL = "brunel:ready";
  process.env.DONE_LABEL = "brunel:done";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GITHUB_REPO;
  delete process.env.GITHUB_TOKEN;
});

describe("loadIssuesToQueue", () => {
  it("fetches open issues with the task label and adds them to queue", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockIssues,
    } as any);

    const q = new TaskQueue();
    await loadIssuesToQueue(q);

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("owner/repo/issues"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token123" }) }),
    );
    expect(q.get("1")?.title).toBe("First issue");
    expect(q.get("2")?.body).toBe(""); // null coerced to ""
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 403 } as any);
    await expect(loadIssuesToQueue(new TaskQueue())).rejects.toThrow("403");
  });
});

describe("labelIssueDone", () => {
  it("POSTs the done label to the issue", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as any);
    await labelIssueDone(42);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("owner/repo/issues/42/labels"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ labels: ["brunel:done"] }),
      }),
    );
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 422 } as any);
    await expect(labelIssueDone(42)).rejects.toThrow("422");
  });
});

describe("fetchIssueStates", () => {
  it("returns open/closed state for each issue number", async () => {
    // The implementation fetches one issue at a time via Promise.all,
    // so mock each individual call separately.
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ number: 1, state: "open" }) } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ number: 2, state: "closed" }) } as any);
    const states = await fetchIssueStates([1, 2]);
    expect(states.get(1)).toBe("open");
    expect(states.get(2)).toBe("closed");
  });

  it("returns empty map for empty input without calling fetch", async () => {
    const states = await fetchIssueStates([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(states.size).toBe(0);
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as any);
    await expect(fetchIssueStates([1])).rejects.toThrow("500");
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
              blockedBy: {
                nodes: [{ number: 5 }, { number: 7 }],
              },
            },
          },
        },
      }),
    } as any);
    const blockers = await fetchNativeBlockers(42);
    expect(blockers).toEqual([5, 7]);
  });

  it("returns empty array when issue has no blockers", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { repository: { issue: { blockedBy: { nodes: [] } } } },
      }),
    } as any);
    expect(await fetchNativeBlockers(42)).toEqual([]);
  });

  it("returns empty array when GraphQL field is null (feature unavailable)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { repository: { issue: { blockedBy: null } } },
      }),
    } as any);
    expect(await fetchNativeBlockers(42)).toEqual([]);
  });

  it("throws on non-ok HTTP response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 403 } as any);
    await expect(fetchNativeBlockers(42)).rejects.toThrow("403");
  });
});
