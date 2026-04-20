import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Task } from "../src/foreman/models/task.js";
import { TaskManager } from "../src/foreman/models/task-manager.js";
import { resetDb } from "./helpers/task.js";
import { getConfig } from "../src/config.js";

describe("Task.parseBodyBlockers", () => {
  it("parses 'Depends on #N' from body", () => {
    expect(Task.parseBodyBlockers("Depends on #42")).toEqual([42]);
  });

  it("parses 'Blocked by #N' from body", () => {
    expect(Task.parseBodyBlockers("Blocked by #7")).toEqual([7]);
  });

  it("is case-insensitive", () => {
    expect(Task.parseBodyBlockers("DEPENDS ON #10\nBLOCKED BY #20")).toEqual([10, 20]);
  });

  it("parses multiple blockers", () => {
    expect(Task.parseBodyBlockers("Depends on #1\nDepends on #2\nBlocked by #3")).toEqual([1, 2, 3]);
  });

  it("returns empty array for body with no deps", () => {
    expect(Task.parseBodyBlockers("Just a regular issue body")).toEqual([]);
  });

  it("returns empty array for empty body", () => {
    expect(Task.parseBodyBlockers("")).toEqual([]);
  });

  it("ignores partial matches", () => {
    expect(Task.parseBodyBlockers("closedepends on #5")).toEqual([]);
  });

  it("parses comma-separated list after depends on", () => {
    expect(Task.parseBodyBlockers("Depends on #181, #182, #183, #184")).toEqual([181, 182, 183, 184]);
  });

  it("parses comma-separated list after blocked by", () => {
    expect(Task.parseBodyBlockers("Blocked by #10, #11, #12")).toEqual([10, 11, 12]);
  });

  it("parses mixed single and comma-separated entries across lines", () => {
    expect(Task.parseBodyBlockers("Depends on #1\nBlocked by #2, #3, #4")).toEqual([1, 2, 3, 4]);
  });

  it("parses markdown bold format '**Depends on:** #N'", () => {
    expect(Task.parseBodyBlockers("**Depends on:** #257")).toEqual([257]);
  });

  it("parses colon separator 'Depends on: #N'", () => {
    expect(Task.parseBodyBlockers("Depends on: #42")).toEqual([42]);
  });

  it("parses '**Blocked by:** #N'", () => {
    expect(Task.parseBodyBlockers("**Blocked by:** #7")).toEqual([7]);
  });
});

describe("TaskManager — setBlockers / isBlocked", () => {
  let tm: TaskManager;

  beforeEach(() => {
    tm = new TaskManager();
    resetDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sets blockers for an issue — open blocker makes isBlocked true", () => {
    tm.setBlockers(10, [1, 2]);
    tm.setIssueOpenState(1, true);
    expect(tm.isBlocked(10)).toBe(true);
  });

  it("overwrites existing blockers", () => {
    tm.setBlockers(10, [1, 2, 3]);
    tm.setIssueOpenState(1, true);
    tm.setBlockers(10, [5]); // replaces [1,2,3]
    expect(tm.isBlocked(10)).toBe(false); // issue 5 is not open
    tm.setIssueOpenState(5, true);
    expect(tm.isBlocked(10)).toBe(true);
  });

  it("clears blockers with empty array — isBlocked becomes false", () => {
    tm.setBlockers(10, [1]);
    tm.setIssueOpenState(1, true);
    expect(tm.isBlocked(10)).toBe(true);
    tm.setBlockers(10, []);
    expect(tm.isBlocked(10)).toBe(false);
  });

  it("returns false for issue with no blockers set", () => {
    expect(tm.isBlocked(42)).toBe(false);
  });

  it("returns false when all blockers are closed", () => {
    tm.setBlockers(42, [1, 2]);
    tm.setIssueOpenState(1, false);
    tm.setIssueOpenState(2, false);
    expect(tm.isBlocked(42)).toBe(false);
  });

  it("returns true when at least one blocker is open", () => {
    tm.setBlockers(42, [1, 2]);
    tm.setIssueOpenState(1, false);
    tm.setIssueOpenState(2, true);
    expect(tm.isBlocked(42)).toBe(true);
  });

  it("returns false when blockers set is empty", () => {
    tm.setBlockers(42, []);
    tm.setIssueOpenState(99, true);
    expect(tm.isBlocked(42)).toBe(false);
  });

  it("returns true only when a blocker matches openIssues exactly", () => {
    tm.setBlockers(42, [10]);
    tm.setIssueOpenState(11, true);
    expect(tm.isBlocked(42)).toBe(false);
    tm.setIssueOpenState(10, true);
    expect(tm.isBlocked(42)).toBe(true);
  });
});

describe("Task.fetchBlockers", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    getConfig().githubRepo = "owner/repo";
    getConfig().githubToken = "token123";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns body-parsed blockers when native returns empty", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { repository: { issue: { blockedBy: { nodes: [] } } } } }),
    } as any);
    const blockers = await Task.fetchBlockers(42, "Depends on #5\nBlocked by #6");
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
    const blockers = await Task.fetchBlockers(42, "Depends on #5");
    expect(new Set(blockers)).toEqual(new Set([5, 9]));
  });

  it("returns empty array when no deps in body or native", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { repository: { issue: { blockedBy: { nodes: [] } } } } }),
    } as any);
    expect(await Task.fetchBlockers(42, "No dependencies here")).toEqual([]);
  });
});
