import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseBodyBlockers, isBlocked, setBlockers, fetchBlockers } from "../src/dependencies.js";
import type { DependencyGraph } from "../src/dependencies.js";

describe("parseBodyBlockers", () => {
  it("parses 'Depends on #N' from body", () => {
    expect(parseBodyBlockers("Depends on #42")).toEqual([42]);
  });

  it("parses 'Blocked by #N' from body", () => {
    expect(parseBodyBlockers("Blocked by #7")).toEqual([7]);
  });

  it("is case-insensitive", () => {
    expect(parseBodyBlockers("DEPENDS ON #10\nBLOCKED BY #20")).toEqual([10, 20]);
  });

  it("parses multiple blockers", () => {
    expect(parseBodyBlockers("Depends on #1\nDepends on #2\nBlocked by #3")).toEqual([1, 2, 3]);
  });

  it("returns empty array for body with no deps", () => {
    expect(parseBodyBlockers("Just a regular issue body")).toEqual([]);
  });

  it("returns empty array for empty body", () => {
    expect(parseBodyBlockers("")).toEqual([]);
  });

  it("ignores partial matches", () => {
    expect(parseBodyBlockers("closedepends on #5")).toEqual([]);
  });

  it("parses comma-separated list after depends on", () => {
    expect(parseBodyBlockers("Depends on #181, #182, #183, #184")).toEqual([181, 182, 183, 184]);
  });

  it("parses comma-separated list after blocked by", () => {
    expect(parseBodyBlockers("Blocked by #10, #11, #12")).toEqual([10, 11, 12]);
  });

  it("parses mixed single and comma-separated entries across lines", () => {
    expect(parseBodyBlockers("Depends on #1\nBlocked by #2, #3, #4")).toEqual([1, 2, 3, 4]);
  });

  it("parses markdown bold format '**Depends on:** #N'", () => {
    expect(parseBodyBlockers("**Depends on:** #257")).toEqual([257]);
  });

  it("parses colon separator 'Depends on: #N'", () => {
    expect(parseBodyBlockers("Depends on: #42")).toEqual([42]);
  });

  it("parses '**Blocked by:** #N'", () => {
    expect(parseBodyBlockers("**Blocked by:** #7")).toEqual([7]);
  });
});

describe("setBlockers", () => {
  it("sets blockers for an issue", () => {
    const graph: DependencyGraph = new Map();
    setBlockers(10, [1, 2], graph);
    expect(graph.get(10)).toEqual(new Set([1, 2]));
  });

  it("overwrites existing blockers", () => {
    const graph: DependencyGraph = new Map();
    setBlockers(10, [1, 2, 3], graph);
    setBlockers(10, [5], graph);
    expect(graph.get(10)).toEqual(new Set([5]));
  });

  it("clears blockers with empty array", () => {
    const graph: DependencyGraph = new Map();
    setBlockers(10, [1], graph);
    setBlockers(10, [], graph);
    expect(graph.get(10)).toEqual(new Set());
  });
});

describe("isBlocked", () => {
  it("returns false for issue with no entry in graph", () => {
    expect(isBlocked(42, new Map(), new Set())).toBe(false);
  });

  it("returns false when all blockers are closed", () => {
    const graph: DependencyGraph = new Map([[42, new Set([1, 2])]]);
    expect(isBlocked(42, graph, new Set())).toBe(false);
  });

  it("returns true when at least one blocker is open", () => {
    const graph: DependencyGraph = new Map([[42, new Set([1, 2])]]);
    const open = new Set([2]);
    expect(isBlocked(42, graph, open)).toBe(true);
  });

  it("returns false when blockers set is empty", () => {
    const graph: DependencyGraph = new Map([[42, new Set<number>()]]);
    expect(isBlocked(42, graph, new Set([99]))).toBe(false);
  });

  it("returns true only when a blocker matches openIssues exactly", () => {
    const graph: DependencyGraph = new Map([[42, new Set([10])]]);
    expect(isBlocked(42, graph, new Set([11]))).toBe(false);
    expect(isBlocked(42, graph, new Set([10]))).toBe(true);
  });
});

describe("fetchBlockers", () => {
  const OPTS = { repo: "owner/repo", token: "token123" };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns body-parsed blockers when native returns empty", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { repository: { issue: { blockedBy: { nodes: [] } } } } }),
    } as any);
    const blockers = await fetchBlockers(42, "Depends on #5\nBlocked by #6", OPTS);
    expect(blockers).toEqual(expect.arrayContaining([5, 6]));
    expect(blockers).toHaveLength(2);
  });

  it("merges and deduplicates body and native blockers", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { repository: { issue: { blockedBy: { nodes: [{ number: 5 }, { number: 9 }] } } } },
      }),
    } as any);
    const blockers = await fetchBlockers(42, "Depends on #5", OPTS);
    expect(new Set(blockers)).toEqual(new Set([5, 9]));
  });

  it("returns empty array when no deps in body or native", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { repository: { issue: { blockedBy: { nodes: [] } } } } }),
    } as any);
    expect(await fetchBlockers(42, "No dependencies here", OPTS)).toEqual([]);
  });
});
