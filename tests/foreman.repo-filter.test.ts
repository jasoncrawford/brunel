/**
 * Tests for per-repo event filtering in routeEvent.
 *
 * When a webhook arrives with a repository.full_name, the foreman should:
 * 1. Find or create a Repo record for that full_name.
 * 2. Skip all task processing (and return early) if the repo is not 'active'.
 * 3. Proceed with normal routing if the repo is 'active'.
 * 4. Proceed with normal routing if the payload has no repository.full_name.
 */
import http from "http";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ForemanWss } from "../src/foreman/controllers/wss.js";
import { Repo } from "../src/foreman/models/repo.js";
import { Worker } from "../src/foreman/models/worker.js";
import { resetDb } from "./helpers/task.js";
import * as utils from "../src/utils.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function fakeRepo(status: "new" | "active"): Repo {
  return { id: 1, fullName: "owner/repo", status, createdAt: new Date().toISOString() } as unknown as Repo;
}

function makeTaskManager() {
  return {
    queueEvent: vi.fn(),
    dequeueIssue: vi.fn().mockResolvedValue(undefined),
    closeIssue: vi.fn().mockResolvedValue(undefined),
    reopenIssue: vi.fn().mockResolvedValue(undefined),
    assignIdleWorkers: vi.fn().mockResolvedValue([]),
    handleIssueLabeledEvent: vi.fn().mockResolvedValue(null),
    handleIssueBodyEditedEvent: vi.fn(),
    handlePrOpenedEvent: vi.fn().mockResolvedValue(null),
    handlePrClosedEvent: vi.fn().mockResolvedValue(null),
    getTaskForCheckEvent: vi.fn().mockResolvedValue(null),
    on: vi.fn(),
  };
}

function makeWss(taskManager: ReturnType<typeof makeTaskManager>) {
  const wss = new ForemanWss({
    config: { taskLabel: "brunel:ready", githubRepo: "owner/repo", githubToken: "token", workerSecret: undefined, pingIntervalMs: 1e9 },
    taskManager: taskManager as any,
    server: http.createServer(),
  });
  const routePrEvent = vi.spyOn(wss, "routePrEvent");
  const routeIssueEvent = vi.spyOn(wss, "routeIssueEvent");
  return { wss, routePrEvent, routeIssueEvent };
}

let logSpy: ReturnType<typeof vi.spyOn>;
let findOrCreate: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  Worker._reset();
  resetDb();
  logSpy = vi.spyOn(utils, "log").mockImplementation(() => {});
  findOrCreate = vi.spyOn(Repo, "findOrCreate");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Non-active repo: skip processing ─────────────────────────────────────────

describe("routeEvent — non-active repo", () => {
  it("skips issue routing when repo status is 'new'", async () => {
    findOrCreate.mockResolvedValue(fakeRepo("new"));
    const taskManager = makeTaskManager();
    const { wss, routeIssueEvent } = makeWss(taskManager);

    await wss.routeEvent("evt-1", "issues", {
      action: "labeled",
      label: { name: "brunel:ready" },
      issue: { number: 42, title: "Task", body: "", state: "open", labels: [] },
      repository: { full_name: "owner/repo" },
    });

    expect(findOrCreate).toHaveBeenCalledWith("owner/repo");
    expect(routeIssueEvent).not.toHaveBeenCalled();
    expect(taskManager.handleIssueLabeledEvent).not.toHaveBeenCalled();
  });

  it("skips PR routing when repo status is 'new'", async () => {
    findOrCreate.mockResolvedValue(fakeRepo("new"));
    const taskManager = makeTaskManager();
    const { wss, routePrEvent } = makeWss(taskManager);

    await wss.routeEvent("evt-1", "pull_request", {
      action: "opened",
      pull_request: { number: 10, body: "Closes #42", head: { ref: "branch" } },
      repository: { full_name: "owner/repo" },
    });

    expect(findOrCreate).toHaveBeenCalledWith("owner/repo");
    expect(routePrEvent).not.toHaveBeenCalled();
  });

  it("logs that the repo is not active", async () => {
    findOrCreate.mockResolvedValue(fakeRepo("new"));
    const taskManager = makeTaskManager();
    const { wss } = makeWss(taskManager);

    await wss.routeEvent("evt-1", "issues", {
      action: "labeled",
      label: { name: "brunel:ready" },
      issue: { number: 42, title: "Task", body: "", state: "open", labels: [] },
      repository: { full_name: "owner/repo" },
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("not active"));
  });
});

// ── Active repo: proceed normally ─────────────────────────────────────────────

describe("routeEvent — active repo", () => {
  it("routes issue events normally when repo status is 'active'", async () => {
    findOrCreate.mockResolvedValue(fakeRepo("active"));
    const taskManager = makeTaskManager();
    const { wss, routeIssueEvent } = makeWss(taskManager);
    routeIssueEvent.mockResolvedValue({ taskId: null, workerId: null });

    await wss.routeEvent("evt-1", "issues", {
      action: "labeled",
      label: { name: "brunel:ready" },
      issue: { number: 42, title: "Task", body: "", state: "open", labels: [] },
      repository: { full_name: "owner/repo" },
    });

    expect(findOrCreate).toHaveBeenCalledWith("owner/repo");
    expect(routeIssueEvent).toHaveBeenCalledOnce();
  });

  it("routes PR events normally when repo status is 'active'", async () => {
    findOrCreate.mockResolvedValue(fakeRepo("active"));
    const taskManager = makeTaskManager();
    const { wss, routePrEvent } = makeWss(taskManager);
    routePrEvent.mockResolvedValue({ taskId: null, workerId: null });

    await wss.routeEvent("evt-1", "pull_request", {
      action: "opened",
      pull_request: { number: 10, body: "Closes #42", head: { ref: "branch" } },
      repository: { full_name: "owner/repo" },
    });

    expect(findOrCreate).toHaveBeenCalledWith("owner/repo");
    expect(routePrEvent).toHaveBeenCalledOnce();
  });
});

// ── No repository in payload: proceed normally ────────────────────────────────

describe("routeEvent — no repository in payload", () => {
  it("does not call Repo.findOrCreate and still routes the event", async () => {
    const taskManager = makeTaskManager();
    const { wss, routePrEvent } = makeWss(taskManager);
    routePrEvent.mockResolvedValue({ taskId: null, workerId: null });

    await wss.routeEvent("evt-1", "pull_request", {
      action: "opened",
      pull_request: { number: 10, body: "Closes #42", head: { ref: "branch" } },
      // no repository field
    });

    expect(findOrCreate).not.toHaveBeenCalled();
    expect(routePrEvent).toHaveBeenCalledOnce();
  });

  it("does not call Repo.findOrCreate when repository has no full_name", async () => {
    const taskManager = makeTaskManager();
    const { wss, routeIssueEvent } = makeWss(taskManager);
    routeIssueEvent.mockResolvedValue({ taskId: null, workerId: null });

    await wss.routeEvent("evt-1", "issues", {
      action: "labeled",
      issue: { number: 42, title: "Task", body: "", state: "open", labels: [] },
      repository: { html_url: "https://github.com/owner/repo" }, // no full_name
    });

    expect(findOrCreate).not.toHaveBeenCalled();
    expect(routeIssueEvent).toHaveBeenCalledOnce();
  });
});

// ── Repo.findOrCreate error handling ─────────────────────────────────────────

describe("routeEvent — Repo.findOrCreate error", () => {
  it("skips processing and logs error when findOrCreate throws", async () => {
    findOrCreate.mockRejectedValue(new Error("DB connection failed"));
    const taskManager = makeTaskManager();
    const { wss, routeIssueEvent } = makeWss(taskManager);

    await wss.routeEvent("evt-1", "issues", {
      action: "labeled",
      issue: { number: 42, title: "Task", body: "", state: "open", labels: [] },
      repository: { full_name: "owner/repo" },
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("ERROR"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("owner/repo"));
    expect(routeIssueEvent).not.toHaveBeenCalled();
  });
});
