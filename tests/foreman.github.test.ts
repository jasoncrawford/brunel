import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GithubClient } from "../src/foreman/clients/github.js";
import { Worker } from "../src/foreman/models/worker.js";
import { getConfig } from "../src/config.js";

beforeEach(() => {
  Worker._reset();
  vi.stubGlobal("fetch", vi.fn());
  getConfig().githubToken = "token123";
  getConfig().taskLabel = "brunel:ready";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchIssues", () => {
  it("fetches open issues with the task label and returns them", async () => {
    const mockIssues = [
      { number: 1, title: "First issue", body: "body 1", labels: [{ name: "brunel:ready" }] },
      { number: 2, title: "Second issue", body: null, labels: [{ name: "brunel:ready" }] },
    ];
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => mockIssues } as any);

    const client = new GithubClient("owner/repo");
    const issues = await client.fetchIssues();

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("owner/repo/issues"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token123" }) }),
    );
    expect(issues).toHaveLength(2);
    expect(issues[0].title).toBe("First issue");
    expect(issues[1].body).toBeNull();
  });

  it("includes the task label in the query string", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => [] } as any);
    await new GithubClient("owner/repo").fetchIssues();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("labels=brunel%3Aready"),
      expect.anything(),
    );
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 403 } as any);
    await expect(new GithubClient("owner/repo").fetchIssues()).rejects.toThrow("403");
  });
});

describe("fetchIssueStates", () => {
  it("returns open/closed state for each issue number", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ number: 1, state: "open" }) } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ number: 2, state: "closed" }) } as any);
    const states = await new GithubClient("owner/repo").fetchIssueStates([1, 2]);
    expect(states.get(1)).toBe("open");
    expect(states.get(2)).toBe("closed");
  });

  it("uses the repo from the constructor in the API URL", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ number: 1, state: "open" }) } as any);
    await new GithubClient("other-owner/other-repo").fetchIssueStates([1]);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("other-owner/other-repo/issues/1"),
      expect.anything(),
    );
  });

  it("returns empty map for empty input without calling fetch", async () => {
    const states = await new GithubClient("owner/repo").fetchIssueStates([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(states.size).toBe(0);
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as any);
    await expect(new GithubClient("owner/repo").fetchIssueStates([1])).rejects.toThrow("500");
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
    const blockers = await new GithubClient("owner/repo").fetchNativeBlockers(42);
    expect(blockers).toEqual([5, 7]);
  });

  it("uses the repo from the constructor in the GraphQL variables", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { repository: { issue: { blockedBy: { nodes: [] } } } } }),
    } as any);
    await new GithubClient("other-owner/other-repo").fetchNativeBlockers(42);
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
    expect(await new GithubClient("owner/repo").fetchNativeBlockers(42)).toEqual([]);
  });

  it("returns empty array when GraphQL field is null (feature unavailable)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { repository: { issue: { blockedBy: null } } },
      }),
    } as any);
    expect(await new GithubClient("owner/repo").fetchNativeBlockers(42)).toEqual([]);
  });

  it("throws on non-ok HTTP response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 403 } as any);
    await expect(new GithubClient("owner/repo").fetchNativeBlockers(42)).rejects.toThrow("403");
  });
});
