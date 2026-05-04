/**
 * Tests for Repo.findOrCreate being called in routeEvent.
 *
 * When a webhook arrives with a repository.full_name, the foreman should
 * call Repo.findOrCreate() to register the repo in the database.
 * Routing always proceeds regardless of repo status — events must still
 * be forwarded to any worker that has a task from that repo.
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
    config: { taskLabel: "brunel:ready", githubToken: "token", workerSecret: undefined, pingIntervalMs: 1e9 },
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

// ── Repo.findOrCreate is called when full_name is present ─────────────────────

describe("routeEvent — repository.full_name present", () => {
  it("calls Repo.findOrCreate with the full_name", async () => {
    findOrCreate.mockResolvedValue(fakeRepo("new"));
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
  });

  it("routes the event even when repo status is 'new'", async () => {
    findOrCreate.mockResolvedValue(fakeRepo("new"));
    const taskManager = makeTaskManager();
    const { wss, routeIssueEvent } = makeWss(taskManager);
    routeIssueEvent.mockResolvedValue({ taskId: null, workerId: null });

    await wss.routeEvent("evt-1", "issues", {
      action: "labeled",
      label: { name: "brunel:ready" },
      issue: { number: 42, title: "Task", body: "", state: "open", labels: [] },
      repository: { full_name: "owner/repo" },
    });

    expect(routeIssueEvent).toHaveBeenCalledOnce();
  });

  it("routes the event when repo status is 'active'", async () => {
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

// ── No repository in payload: no findOrCreate call ───────────────────────────

describe("routeEvent — no repository.full_name in payload", () => {
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
