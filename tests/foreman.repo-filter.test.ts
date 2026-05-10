/**
 * Tests for Repo.findOrCreate being called in handleEvent.
 *
 * When a webhook arrives with a repository.full_name, the foreman should
 * call Repo.findOrCreate() to register the repo in the database.
 * Routing always proceeds regardless of repo status — events must still
 * be forwarded to any worker that has a task from that repo.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebhookController } from "../src/foreman/controllers/webhook-controller.js";
import { WorkerMessenger } from "../src/foreman/controllers/worker-messenger.js";
import { Repo } from "../src/foreman/models/repo.js";
import { Worker } from "../src/foreman/models/worker.js";
import { resetDb } from "./helpers/task.js";
import * as utils from "../src/utils.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function fakeRepo(status: "new" | "active"): Repo {
  return { id: 1, fullName: "owner/repo", status, createdAt: new Date().toISOString(), taskManager: { assignIdleWorkers: vi.fn().mockResolvedValue([]), on: vi.fn() } } as unknown as Repo;
}

function makeWss() {
  const messenger = new WorkerMessenger({});
  const wss = new WebhookController({
    config: { taskLabel: "brunel:ready" },
    messenger,
    assignWork: async () => {},
  });
  const routePullRequestEvent = vi.spyOn(wss, "routePullRequestEvent");
  const routeIssuesEvent = vi.spyOn(wss, "routeIssuesEvent");
  return { wss, routePullRequestEvent, routeIssuesEvent };
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
    const { wss, routeIssuesEvent } = makeWss();
    routeIssuesEvent.mockResolvedValue({ task: null, ref: "" });

    await wss.handleEvent("evt-1", "issues", {
      action: "labeled",
      label: { name: "brunel:ready" },
      issue: { number: 42, title: "Task", body: "", state: "open", labels: [] },
      repository: { full_name: "owner/repo" },
    });

    expect(findOrCreate).toHaveBeenCalledWith("owner/repo");
  });

  it("routes the event even when repo status is 'new'", async () => {
    findOrCreate.mockResolvedValue(fakeRepo("new"));
    const { wss, routeIssuesEvent } = makeWss();
    routeIssuesEvent.mockResolvedValue({ task: null, ref: "" });

    await wss.handleEvent("evt-1", "issues", {
      action: "labeled",
      label: { name: "brunel:ready" },
      issue: { number: 42, title: "Task", body: "", state: "open", labels: [] },
      repository: { full_name: "owner/repo" },
    });

    expect(routeIssuesEvent).toHaveBeenCalledOnce();
  });

  it("routes the event when repo status is 'active'", async () => {
    findOrCreate.mockResolvedValue(fakeRepo("active"));
    const { wss, routePullRequestEvent } = makeWss();
    routePullRequestEvent.mockResolvedValue({ task: null, ref: "" });

    await wss.handleEvent("evt-1", "pull_request", {
      action: "opened",
      pull_request: { number: 10, body: "Closes #42", head: { ref: "branch" } },
      repository: { full_name: "owner/repo" },
    });

    expect(findOrCreate).toHaveBeenCalledWith("owner/repo");
    expect(routePullRequestEvent).toHaveBeenCalledOnce();
  });
});

// ── No repository in payload: no findOrCreate call ───────────────────────────

describe("routeEvent — no repository.full_name in payload", () => {
  it("does not call Repo.findOrCreate and still routes the event", async () => {
    const { wss, routePullRequestEvent } = makeWss();
    routePullRequestEvent.mockResolvedValue({ task: null, ref: "" });

    await wss.handleEvent("evt-1", "pull_request", {
      action: "opened",
      pull_request: { number: 10, body: "Closes #42", head: { ref: "branch" } },
      // no repository field
    });

    expect(findOrCreate).not.toHaveBeenCalled();
    expect(routePullRequestEvent).toHaveBeenCalledOnce();
  });

  it("does not call Repo.findOrCreate when repository has no full_name", async () => {
    const { wss, routeIssuesEvent } = makeWss();
    routeIssuesEvent.mockResolvedValue({ task: null, ref: "" });

    await wss.handleEvent("evt-1", "issues", {
      action: "labeled",
      issue: { number: 42, title: "Task", body: "", state: "open", labels: [] },
      repository: { html_url: "https://github.com/owner/repo" }, // no full_name
    });

    expect(findOrCreate).not.toHaveBeenCalled();
    expect(routeIssuesEvent).toHaveBeenCalledOnce();
  });
});
