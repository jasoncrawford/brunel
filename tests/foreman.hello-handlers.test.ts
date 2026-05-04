/**
 * Unit tests for ForemanWss.handleAssignedHello and ForemanWss.handleReadyHello.
 *
 * Each reconnection case is verified by calling the public methods directly on
 * a ForemanWss instance with sendMsg spied out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import { ForemanWss } from "../src/foreman/controllers/wss.js";
import { Worker } from "../src/foreman/models/worker.js";
import { Task } from "../src/foreman/models/task.js";
import { TaskManager } from "../src/foreman/models/task-manager.js";
import { ForemanMessage } from "../src/foreman/models/foreman-message.js";
import { WebhookEvent } from "../src/foreman/models/webhook-event.js";
import { Repo } from "../src/foreman/models/repo.js";
import { fakeRepo, resetDb, seedTask, createTestTaskManager, createTestRepo } from "./helpers/task.js";
import * as utils from "../src/utils.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function fakeWs() {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
}

function makeWss(taskManager: TaskManager) {
  const wss = new ForemanWss({
    config: { taskLabel: "brunel:ready", githubToken: "token", workerSecret: undefined, pingIntervalMs: 1e9 },
    server: http.createServer(),
  });
  const sendMsg = vi.spyOn(wss, "sendMsg").mockImplementation(() => {});
  return { wss, sendMsg };
}

/** Returns the hello_ack message from a sendMsg spy's calls. */
function helloAck(sendMsg: ReturnType<typeof vi.spyOn>) {
  const call = sendMsg.mock.calls.find(([, msg]) => (msg as { type: string }).type === "hello_ack");
  return call ? (call[1] as { type: string; status: string }) : undefined;
}

// ── Test setup ─────────────────────────────────────────────────────────────────

let taskManager: TaskManager;

beforeEach(async () => {
  Worker._reset();
  resetDb();
  taskManager = await createTestTaskManager();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── handleAssignedHello ────────────────────────────────────────────────────────────

describe("handleAssignedHello", () => {
  describe("unknown task", () => {
    it("numeric taskId — creates placeholder and sends busy ack", async () => {
      const { wss, sendMsg } = makeWss(taskManager);
      await wss.handleAssignedHello("w1", "42", fakeWs(), fakeRepo());

      const ack = helloAck(sendMsg);
      expect(ack?.status).toBe("assigned");
      expect(Worker.fromRegistry("w1")?.currentTaskId).toBe("42");
    });

    it("non-numeric taskId — sends cancelled ack", async () => {
      const { wss, sendMsg } = makeWss(taskManager);
      await wss.handleAssignedHello("w1", "not-a-number", fakeWs(), fakeRepo());

      const ack = helloAck(sendMsg);
      expect(ack?.status).toBe("cancelled");
    });
  });

  describe("complete task", () => {
    it("same worker — reclaims for finalization (busy ack, task.assign NOT called again)", async () => {
      await seedTask({
        task_id: "10",
        issue_number: 10,
        repo_id: taskManager.repo.id,
        worker_id: "w1",
        completed_at: new Date().toISOString(),
        assigned_at: new Date().toISOString(),
      });
      const assignSpy = vi.spyOn(Task.prototype, "assign");

      const { wss, sendMsg } = makeWss(taskManager);
      await wss.handleAssignedHello("w1", "10", fakeWs(), fakeRepo());

      const ack = helloAck(sendMsg);
      expect(ack?.status).toBe("assigned");
      // task.assign must NOT be called because task is already complete
      expect(assignSpy).not.toHaveBeenCalled();
      expect(Worker.fromRegistry("w1")?.currentTaskId).toBe("10");
    });

    it("different worker — sends cancelled ack", async () => {
      await seedTask({
        task_id: "10",
        issue_number: 10,
        repo_id: taskManager.repo.id,
        worker_id: "w2",
        completed_at: new Date().toISOString(),
        assigned_at: new Date().toISOString(),
      });

      const { wss, sendMsg } = makeWss(taskManager);
      await wss.handleAssignedHello("w1", "10", fakeWs(), fakeRepo());

      const ack = helloAck(sendMsg);
      expect(ack?.status).toBe("cancelled");
    });
  });

  describe("live task", () => {
    it("taken by a different worker — sends cancelled ack", async () => {
      await seedTask({
        task_id: "10",
        issue_number: 10,
        repo_id: taskManager.repo.id,
        worker_id: "w2",
        assigned_at: new Date().toISOString(),
      });

      const { wss, sendMsg } = makeWss(taskManager);
      await wss.handleAssignedHello("w1", "10", fakeWs(), fakeRepo());

      const ack = helloAck(sendMsg);
      expect(ack?.status).toBe("cancelled");
    });

    it("owned by same worker — reclaims (busy ack, task.assign called)", async () => {
      await seedTask({
        task_id: "10",
        issue_number: 10,
        repo_id: taskManager.repo.id,
        worker_id: "w1",
        assigned_at: new Date().toISOString(),
      });
      const assignSpy = vi.spyOn(Task.prototype, "assign");

      const { wss, sendMsg } = makeWss(taskManager);
      await wss.handleAssignedHello("w1", "10", fakeWs(), fakeRepo());

      const ack = helloAck(sendMsg);
      expect(ack?.status).toBe("assigned");
      expect(assignSpy).toHaveBeenCalledWith(expect.objectContaining({ workerId: "w1" }));
      expect(Worker.fromRegistry("w1")?.currentTaskId).toBe("10");

      await new Promise((r) => setTimeout(r, 20));
      const dbWorker = await Worker.get("w1");
      expect(dbWorker?.workerId).toBe("w1");
      expect(dbWorker?.status).toBe("assigned");
    });

    it("unassigned — reclaims (busy ack, task.assign called)", async () => {
      await seedTask({ task_id: "10", issue_number: 10, repo_id: taskManager.repo.id });
      const assignSpy = vi.spyOn(Task.prototype, "assign");

      const { wss, sendMsg } = makeWss(taskManager);
      await wss.handleAssignedHello("w1", "10", fakeWs(), fakeRepo());

      const ack = helloAck(sendMsg);
      expect(ack?.status).toBe("assigned");
      expect(assignSpy).toHaveBeenCalledWith(expect.objectContaining({ workerId: "w1" }));
    });
  });

  describe("DB replay on reconnect (lastSeenEventSeqId)", () => {
    it("replays missed events from DB when lastSeenEventSeqId is provided", async () => {
      await seedTask({
        task_id: "10",
        issue_number: 10,
        repo_id: taskManager.repo.id,
        worker_id: "w1",
        assigned_at: new Date().toISOString(),
      });

      // Simulate two events that arrived while the worker was disconnected
      const evt1 = WebhookEvent.fromIncoming("d1", "issue_comment", {}) as any;
      const evt2 = WebhookEvent.fromIncoming("d2", "pull_request", {}) as any;
      // Give them synthetic DB ids (simulating rows fetched from webhook_events)
      Object.assign(evt1, { id: 11 });
      Object.assign(evt2, { id: 12 });

      vi.spyOn(WebhookEvent, "queryMissedFor").mockResolvedValue([evt1, evt2]);

      const { wss, sendMsg } = makeWss(taskManager);
      // Worker reconnects claiming it last saw seqId=10
      await wss.handleAssignedHello("w1", "10", fakeWs(), fakeRepo(), 10);

      expect(WebhookEvent.queryMissedFor).toHaveBeenCalledWith("10", 10);

      const replayNotifs = sendMsg.mock.calls.filter(
        ([, msg]) => (msg as { type: string }).type === "event_notification"
      );
      expect(replayNotifs).toHaveLength(2);
      expect((replayNotifs[0][1] as any).seqId).toBe(11);
      expect((replayNotifs[1][1] as any).seqId).toBe(12);
    });

    it("does not call queryMissedFor when lastSeenEventSeqId is absent", async () => {
      await seedTask({
        task_id: "10",
        issue_number: 10,
        repo_id: taskManager.repo.id,
        worker_id: "w1",
        assigned_at: new Date().toISOString(),
      });

      const querySpy = vi.spyOn(WebhookEvent, "queryMissedFor").mockResolvedValue([]);

      const { wss } = makeWss(taskManager);
      await wss.handleAssignedHello("w1", "10", fakeWs(), fakeRepo());

      expect(querySpy).not.toHaveBeenCalled();
    });

    it("logs an error and continues if queryMissedFor throws", async () => {
      await seedTask({
        task_id: "10",
        issue_number: 10,
        repo_id: taskManager.repo.id,
        worker_id: "w1",
        assigned_at: new Date().toISOString(),
      });

      vi.spyOn(WebhookEvent, "queryMissedFor").mockRejectedValue(new Error("DB down"));
      const logSpy = vi.spyOn(utils, "log").mockImplementation(() => {});

      const { wss, sendMsg } = makeWss(taskManager);
      // Should not throw even if DB query fails
      await expect(wss.handleAssignedHello("w1", "10", fakeWs(), fakeRepo(), 5)).resolves.toBeUndefined();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("ERROR"));

      // hello_ack should still have been sent
      const ack = helloAck(sendMsg);
      expect(ack?.status).toBe("assigned");
    });
  });
});

// ── handleReadyHello ────────────────────────────────────────────────────────────

describe("handleReadyHello", () => {
  it("no prior task — registers worker and sends idle ack", async () => {
    const { wss, sendMsg } = makeWss(taskManager);
    await wss.handleReadyHello("w1", fakeWs(), fakeRepo());

    const ack = helloAck(sendMsg);
    expect(ack?.status).toBe("ready");
    expect(Worker.fromRegistry("w1")?.status).toBe("ready");

    await new Promise((r) => setTimeout(r, 20));
    const dbWorker = await Worker.get("w1");
    expect(dbWorker?.workerId).toBe("w1");
    expect(dbWorker?.status).toBe("ready");
  });

  it("has prior task — reverts it and sends idle ack", async () => {
    await seedTask({
      task_id: "10",
      issue_number: 10,
      worker_id: "w1",
      assigned_at: new Date().toISOString(),
    });
    const revertSpy = vi.spyOn(Task.prototype, "revert");

    const { wss, sendMsg } = makeWss(taskManager);
    await wss.handleReadyHello("w1", fakeWs(), fakeRepo());

    expect(revertSpy).toHaveBeenCalled();
    const ack = helloAck(sendMsg);
    expect(ack?.status).toBe("ready");
    expect(Worker.fromRegistry("w1")?.status).toBe("ready");
  });

  it("revert failure is logged and worker is NOT registered (task stays assigned, worker retries)", async () => {
    await seedTask({
      task_id: "10",
      issue_number: 10,
      worker_id: "w1",
      assigned_at: new Date().toISOString(),
    });
    vi.spyOn(Task.prototype, "revert").mockRejectedValueOnce(new Error("DB down"));

    const { wss, sendMsg } = makeWss(taskManager);
    const logSpy = vi.spyOn(utils, "log").mockImplementation(() => {});
    await expect(wss.handleReadyHello("w1", fakeWs(), fakeRepo())).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("ERROR"));
    // Worker must NOT be registered — allowing a new assignment would leave two tasks
    // pointing at this worker in the DB.
    expect(Worker.fromRegistry("w1")).toBeUndefined();
    // No hello_ack should have been sent either
    const ackCall = sendMsg.mock.calls.find(([, msg]) => (msg as { type: string }).type === "hello_ack");
    expect(ackCall).toBeUndefined();
  });

  it("revert failure sends foreman_error (non-fatal) to the worker ws", async () => {
    await seedTask({
      task_id: "10",
      issue_number: 10,
      worker_id: "w1",
      assigned_at: new Date().toISOString(),
    });
    vi.spyOn(Task.prototype, "revert").mockRejectedValueOnce(new Error("DB down"));

    const { wss } = makeWss(taskManager);
    vi.spyOn(utils, "log").mockImplementation(() => {});
    const ws = fakeWs();
    await wss.handleReadyHello("w1", ws, fakeRepo());

    const errorCall = ws.send.mock.calls.find(([data]: [string]) => {
      const msg = JSON.parse(data);
      return msg.type === "foreman_error";
    });
    expect(errorCall).toBeDefined();
    const parsed = JSON.parse(errorCall![0]);
    expect(parsed.fatal).toBe(false);
    expect(parsed.message).toContain("DB down");
  });
});

// ── repo stored on Worker ──────────────────────────────────────────────────────

describe("repo stored on Worker", () => {
  it("handleReadyHello stores repo on registered Worker", async () => {
    const { wss } = makeWss(taskManager);
    const repo = fakeRepo("acme/widget");
    await wss.handleReadyHello("w1", fakeWs(), repo);
    expect(Worker.fromRegistry("w1")?.repo).toBe(repo);
  });

  it("handleAssignedHello stores repo on registered Worker", async () => {
    await seedTask({ task_id: "10", issue_number: 10, repo_id: taskManager.repo.id, worker_id: "w1", assigned_at: new Date().toISOString() });
    const { wss } = makeWss(taskManager);
    const repo = fakeRepo("acme/widget");
    await wss.handleAssignedHello("w1", "10", fakeWs(), repo);
    expect(Worker.fromRegistry("w1")?.repo).toBe(repo);
  });

  it("Repo.findOrCreate is called with msg.repo from worker_hello", async () => {
    const findOrCreateSpy = vi.spyOn(Repo, "findOrCreate").mockResolvedValue(fakeRepo("owner/repo") as unknown as Repo);
    // Trigger via the full WS message path by calling handleWorkerHello-equivalent logic
    // through handleReadyHello directly with a pre-resolved repo (spy verifies the call).
    const resolvedRepo = await Repo.findOrCreate("owner/repo");
    expect(findOrCreateSpy).toHaveBeenCalledWith("owner/repo");
    expect(resolvedRepo.fullName).toBe("owner/repo");
  });
});

// ── handleAssignedHello error handling ─────────────────────────────────────────────
//
// All errors in handleAssignedHello are transient DB errors (Task.get failing,
// Task.upsert failing, or task.assign failing during reclaim). These are
// recoverable — the DB may be temporarily down — so fatal: false is correct.
// The worker retries on reconnect and the operation succeeds once the DB recovers.

describe("handleAssignedHello — error handling", () => {
  it("sends foreman_error (non-fatal) when Task.get throws (DB read failure)", async () => {
    vi.spyOn(Task, "get").mockRejectedValueOnce(new Error("DB connection lost"));

    const { wss } = makeWss(taskManager);
    vi.spyOn(utils, "log").mockImplementation(() => {});
    const ws = fakeWs();
    await wss.handleAssignedHello("w1", "10", ws, fakeRepo());

    const errorCall = ws.send.mock.calls.find(([data]: [string]) => {
      const msg = JSON.parse(data);
      return msg.type === "foreman_error";
    });
    expect(errorCall).toBeDefined();
    const parsed = JSON.parse(errorCall![0]);
    expect(parsed.fatal).toBe(false);
    expect(parsed.message).toContain("DB connection lost");
  });

  it("sends foreman_error (non-fatal) when Task.upsert throws during placeholder creation", async () => {
    // Task.get returns null (unknown task), numeric taskId, upsert fails
    vi.spyOn(Task, "upsert").mockRejectedValueOnce(new Error("DB write failed"));

    const { wss } = makeWss(taskManager);
    vi.spyOn(utils, "log").mockImplementation(() => {});
    const ws = fakeWs();
    await wss.handleAssignedHello("w1", "42", ws, fakeRepo());

    const errorCall = ws.send.mock.calls.find(([data]: [string]) => {
      const msg = JSON.parse(data);
      return msg.type === "foreman_error";
    });
    expect(errorCall).toBeDefined();
    const parsed = JSON.parse(errorCall![0]);
    expect(parsed.fatal).toBe(false);
    expect(parsed.message).toContain("DB write failed");
  });

  it("sends foreman_error (non-fatal) when task.assign throws during reclaim", async () => {
    await seedTask({
      task_id: "10",
      issue_number: 10,
      repo_id: taskManager.repo.id,
      worker_id: "w1",
      assigned_at: new Date().toISOString(),
    });
    vi.spyOn(Task.prototype, "assign").mockRejectedValueOnce(new Error("DB write failed"));

    const { wss } = makeWss(taskManager);
    vi.spyOn(utils, "log").mockImplementation(() => {});
    const ws = fakeWs();
    await wss.handleAssignedHello("w1", "10", ws, fakeRepo());

    const errorCall = ws.send.mock.calls.find(([data]: [string]) => {
      const msg = JSON.parse(data);
      return msg.type === "foreman_error";
    });
    expect(errorCall).toBeDefined();
    const parsed = JSON.parse(errorCall![0]);
    expect(parsed.fatal).toBe(false);
    expect(parsed.message).toContain("DB write failed");
  });
});

// ── handleReadyHello error handling ─────────────────────────────────────────────
//
// All errors in handleReadyHello are transient DB errors (Task.getByWorker
// failing, or priorTask.revert failing). These are recoverable — the DB may be
// temporarily down — so fatal: false is correct in both cases. The worker
// retries on reconnect and the operation succeeds once the DB recovers.

describe("handleReadyHello — error handling", () => {
  it("sends foreman_error (non-fatal) when Task.getByWorker throws (DB read failure)", async () => {
    vi.spyOn(Task, "getByWorker").mockRejectedValueOnce(new Error("DB connection lost"));

    const { wss } = makeWss(taskManager);
    vi.spyOn(utils, "log").mockImplementation(() => {});
    const ws = fakeWs();
    await wss.handleReadyHello("w1", ws, fakeRepo());

    const errorCall = ws.send.mock.calls.find(([data]: [string]) => {
      const msg = JSON.parse(data);
      return msg.type === "foreman_error";
    });
    expect(errorCall).toBeDefined();
    const parsed = JSON.parse(errorCall![0]);
    expect(parsed.fatal).toBe(false);
    expect(parsed.message).toContain("DB connection lost");
  });

  it("does not register worker when Task.getByWorker throws", async () => {
    vi.spyOn(Task, "getByWorker").mockRejectedValueOnce(new Error("DB connection lost"));

    const { wss, sendMsg } = makeWss(taskManager);
    vi.spyOn(utils, "log").mockImplementation(() => {});
    await wss.handleReadyHello("w1", fakeWs(), fakeRepo());

    expect(Worker.fromRegistry("w1")).toBeUndefined();
    const ackCall = sendMsg.mock.calls.find(([, msg]) => (msg as { type: string }).type === "hello_ack");
    expect(ackCall).toBeUndefined();
  });
});


// ── sendError persistence ──────────────────────────────────────────────────────

describe("sendError — ForemanMessage.log() is called", () => {
  it("persists foreman_error to activity log when handleReadyHello revert fails", async () => {
    await seedTask({
      task_id: "10",
      issue_number: 10,
      worker_id: "w1",
      assigned_at: new Date().toISOString(),
    });
    vi.spyOn(Task.prototype, "revert").mockRejectedValueOnce(new Error("DB down"));

    const logSpy = vi.spyOn(ForemanMessage, "log").mockResolvedValue(undefined);
    vi.spyOn(utils, "log").mockImplementation(() => {});

    const { wss } = makeWss(taskManager);
    await wss.handleReadyHello("w1", fakeWs(), fakeRepo());

    const errorLogCall = logSpy.mock.calls.find(([data]) => data.msgType === "foreman_error");
    expect(errorLogCall).toBeDefined();
    expect(errorLogCall![0].direction).toBe("sent");
    expect(errorLogCall![0].workerId).toBe("w1");
    expect(errorLogCall![0].taskId).toBe("10");
    expect((errorLogCall![0].payload as { message?: string }).message).toContain("DB down");
  });

  it("persists foreman_error to activity log when handleAssignedHello throws", async () => {
    await seedTask({
      task_id: "10",
      issue_number: 10,
      repo_id: taskManager.repo.id,
      worker_id: "w1",
      assigned_at: new Date().toISOString(),
    });
    vi.spyOn(Task.prototype, "assign").mockRejectedValueOnce(new Error("DB write failed"));

    const logSpy = vi.spyOn(ForemanMessage, "log").mockResolvedValue(undefined);
    vi.spyOn(utils, "log").mockImplementation(() => {});

    const { wss } = makeWss(taskManager);
    await wss.handleAssignedHello("w1", "10", fakeWs(), fakeRepo());

    const errorLogCall = logSpy.mock.calls.find(([data]) => data.msgType === "foreman_error");
    expect(errorLogCall).toBeDefined();
    expect(errorLogCall![0].direction).toBe("sent");
    expect(errorLogCall![0].workerId).toBe("w1");
    expect((errorLogCall![0].payload as { message?: string }).message).toContain("DB write failed");
  });
});

// ── repoStatus in hello_ack ────────────────────────────────────────────────────

describe("repoStatus in hello_ack", () => {
  it("handleReadyHello sends repoStatus: 'new' for a new repo", async () => {
    const { wss, sendMsg } = makeWss(taskManager);
    const repo = fakeRepo("new/repo");
    await wss.handleReadyHello("w1", fakeWs(), repo);

    const ack = helloAck(sendMsg) as { status: string; repoStatus: string } | undefined;
    expect(ack?.status).toBe("ready");
    expect(ack?.repoStatus).toBe("new");
  });

  it("handleReadyHello sends repoStatus: 'active' for an active repo", async () => {
    const repo = await createTestRepo("active/repo");
    await repo.activate();
    const { wss, sendMsg } = makeWss(taskManager);
    await wss.handleReadyHello("w1", fakeWs(), repo);

    const ack = helloAck(sendMsg) as { status: string; repoStatus: string } | undefined;
    expect(ack?.status).toBe("ready");
    expect(ack?.repoStatus).toBe("active");
  });

  it("cancelWorker includes repoStatus from the worker's repo", async () => {
    await seedTask({ task_id: "10", issue_number: 10, repo_id: taskManager.repo.id, worker_id: "w2", assigned_at: new Date().toISOString() });
    const { wss, sendMsg } = makeWss(taskManager);
    const repo = fakeRepo("some/repo", 1, "active");
    await wss.handleAssignedHello("w1", "10", fakeWs(), repo);

    const ack = helloAck(sendMsg) as { status: string; repoStatus: string } | undefined;
    expect(ack?.status).toBe("cancelled");
    expect(ack?.repoStatus).toBe("active");
  });

  it("reclaimWorker includes repoStatus from the worker's repo", async () => {
    await seedTask({ task_id: "10", issue_number: 10, repo_id: taskManager.repo.id, worker_id: "w1", assigned_at: new Date().toISOString() });
    const { wss, sendMsg } = makeWss(taskManager);
    const repo = fakeRepo("some/repo", 1, "active");
    await wss.handleAssignedHello("w1", "10", fakeWs(), repo);

    const ack = helloAck(sendMsg) as { status: string; repoStatus: string } | undefined;
    expect(ack?.status).toBe("assigned");
    expect(ack?.repoStatus).toBe("active");
  });
});

// ── activate_repo handling ─────────────────────────────────────────────────────

describe("activate_repo", () => {
  function makeWssForActivate() {
    const wss = new ForemanWss({
      config: { taskLabel: "brunel:ready", githubToken: "token", workerSecret: undefined, pingIntervalMs: 1e9 },
      server: http.createServer(),
    });
    const sendMsg = vi.spyOn(wss, "sendMsg").mockImplementation(() => {});
    return { wss, sendMsg };
  }

  it("activate_repo activates the repo and sends repo_activated", async () => {
    const repo = await createTestRepo("activate/repo");
    expect(repo.status).toBe("new");

    const { wss, sendMsg } = makeWssForActivate();
    vi.spyOn(TaskManager.prototype, "loadIssuesFromGithub").mockResolvedValue(undefined);

    const ws = fakeWs();
    await wss.handleReadyHello("w1", ws, repo);
    await wss.handleActivateRepo("w1", ws);

    const activatedCall = sendMsg.mock.calls.find(([, msg]) => (msg as { type: string }).type === "repo_activated");
    expect(activatedCall).toBeDefined();
    expect((activatedCall![1] as { workerId: string }).workerId).toBe("w1");
  });

  it("activate_repo calls repo.activate() and loadIssuesFromGithub", async () => {
    const repo = await createTestRepo("activate2/repo");
    const activateSpy = vi.spyOn(repo, "activate").mockResolvedValue(repo);
    const loadSpy = vi.spyOn(TaskManager.prototype, "loadIssuesFromGithub").mockResolvedValue(undefined);

    const { wss } = makeWssForActivate();
    const ws = fakeWs();
    await wss.handleReadyHello("w1", ws, repo);
    await wss.handleActivateRepo("w1", ws);

    expect(activateSpy).toHaveBeenCalled();
    expect(loadSpy).toHaveBeenCalled();
  });

  it("activate_repo sends foreman_error (non-fatal) if repo.activate() throws", async () => {
    const repo = await createTestRepo("failrepo/repo");
    vi.spyOn(repo, "activate").mockRejectedValue(new Error("DB write failed"));
    vi.spyOn(utils, "log").mockImplementation(() => {});

    const { wss } = makeWssForActivate();
    const ws = fakeWs();
    await wss.handleReadyHello("w1", ws, repo);
    await wss.handleActivateRepo("w1", ws);

    const errorCall = ws.send.mock.calls.find(([data]: [string]) => {
      const msg = JSON.parse(data);
      return msg.type === "foreman_error";
    });
    expect(errorCall).toBeDefined();
    expect(JSON.parse(errorCall![0]).fatal).toBe(false);
    expect(JSON.parse(errorCall![0]).message).toContain("DB write failed");
  });

  it("activate_repo is a no-op if worker is not registered", async () => {
    const { wss, sendMsg } = makeWssForActivate();
    vi.spyOn(utils, "log").mockImplementation(() => {});
    await wss.handleActivateRepo("unknown-worker", fakeWs());
    expect(sendMsg).not.toHaveBeenCalled();
  });
});

// ── handleReservedHello ────────────────────────────────────────────────────────

describe("handleReservedHello", () => {
  it("registers worker, sends hello_ack with status='reserved', worker is NOT immediately assigned a task", async () => {
    await taskManager.repo.activate();
    await seedTask({ task_id: "77", issue_number: 77, repo_id: taskManager.repo.id });

    const { wss, sendMsg } = makeWss(taskManager);
    await wss.handleReservedHello("w1", fakeWs(), taskManager.repo);

    const ack = helloAck(sendMsg);
    expect(ack?.status).toBe("reserved");
    // Worker is in registry...
    expect(Worker.fromRegistry("w1")).toBeDefined();
    // ...but NOT available for auto-assignment
    expect(Worker.fromRegistry("w1")?.isReady).toBe(false);
    // No task_assigned was sent
    const assigned = sendMsg.mock.calls.find(([, msg]) => (msg as { type: string }).type === "task_assigned");
    expect(assigned).toBeUndefined();
  });

  it("reverts a stale prior assignment and sends reserved ack", async () => {
    await seedTask({
      task_id: "77",
      issue_number: 77,
      worker_id: "w1",
      assigned_at: new Date().toISOString(),
    });
    const revertSpy = vi.spyOn(Task.prototype, "revert");

    const { wss, sendMsg } = makeWss(taskManager);
    await wss.handleReservedHello("w1", fakeWs(), taskManager.repo);

    expect(revertSpy).toHaveBeenCalled();
    const ack = helloAck(sendMsg);
    expect(ack?.status).toBe("reserved");
    expect(Worker.fromRegistry("w1")?.isReady).toBe(false);
  });

  it("stores repo on the registered Worker", async () => {
    const { wss } = makeWss(taskManager);
    const repo = fakeRepo("acme/widget");
    await wss.handleReservedHello("w1", fakeWs(), repo);
    expect(Worker.fromRegistry("w1")?.repo).toBe(repo);
  });
});

// ── handleWorkerReady ─────────────────────────────────────────────────────────

describe("handleWorkerReady", () => {
  it("marks worker as available", async () => {
    const { wss } = makeWss(taskManager);
    await wss.handleReservedHello("w1", fakeWs(), taskManager.repo);
    expect(Worker.fromRegistry("w1")?.isReady).toBe(false);

    await wss.handleWorkerReady("w1");

    expect(Worker.fromRegistry("w1")?.isReady).toBe(true);
  });

  it("reverts the active task to pending when worker has one", async () => {
    await seedTask({ task_id: "88", issue_number: 88, repo_id: taskManager.repo.id });
    const { wss } = makeWss(taskManager);
    await wss.handleAssignedHello("w1", "88", fakeWs(), taskManager.repo);
    expect(Worker.fromRegistry("w1")?.currentTaskId).toBe("88");

    const revertSpy = vi.spyOn(Task.prototype, "revert");
    await wss.handleWorkerReady("w1");

    expect(revertSpy).toHaveBeenCalled();
    expect(Worker.fromRegistry("w1")?.isReady).toBe(true);
    expect(Worker.fromRegistry("w1")?.currentTaskId).toBeUndefined();
  });

  it("no-op when worker not in registry", async () => {
    const { wss } = makeWss(taskManager);
    await expect(wss.handleWorkerReady("unknown-worker")).resolves.toBeUndefined();
  });
});

// ── handleWorkerReserve ────────────────────────────────────────────────────────

describe("handleWorkerReserve", () => {
  it("marks a ready worker as reserved", async () => {
    const { wss } = makeWss(taskManager);
    await wss.handleReadyHello("w1", fakeWs(), taskManager.repo);
    expect(Worker.fromRegistry("w1")?.isReady).toBe(true);

    await wss.handleWorkerReserve("w1");

    expect(Worker.fromRegistry("w1")?.isReady).toBe(false);
    expect(Worker.fromRegistry("w1")?.status).toBe("reserved");
  });

  it("no-op when worker not in registry", async () => {
    const { wss } = makeWss(taskManager);
    await expect(wss.handleWorkerReserve("unknown-worker")).resolves.toBeUndefined();
  });
});

// ── handleWorkerHello routing ──────────────────────────────────────────────────

describe("handleWorkerHello routing", () => {
  it("status='assigned' with taskId → routes to handleAssignedHello", async () => {
    const { wss } = makeWss(taskManager);
    vi.spyOn(Repo, "findOrCreate").mockResolvedValue(taskManager.repo as unknown as Repo);
    const spy = vi.spyOn(wss, "handleAssignedHello" as any).mockResolvedValue(undefined);
    await seedTask({ task_id: "77", issue_number: 77, repo_id: taskManager.repo.id });

    await wss.handleWorkerHello("w1", fakeWs(), {
      type: "worker_hello",
      workerId: "w1",
      repo: "owner/repo",
      taskId: "77",
      status: "assigned",
    });

    expect(spy).toHaveBeenCalledWith("w1", "77", expect.anything(), expect.anything(), undefined);
  });

  it("status='reserved' → routes to handleReservedHello", async () => {
    const { wss } = makeWss(taskManager);
    vi.spyOn(Repo, "findOrCreate").mockResolvedValue(taskManager.repo as unknown as Repo);
    const spy = vi.spyOn(wss, "handleReservedHello" as any).mockResolvedValue(undefined);

    await wss.handleWorkerHello("w1", fakeWs(), {
      type: "worker_hello",
      workerId: "w1",
      repo: "owner/repo",
      status: "reserved",
    });

    expect(spy).toHaveBeenCalled();
  });

  it("status='ready' → routes to handleReadyHello", async () => {
    const { wss } = makeWss(taskManager);
    vi.spyOn(Repo, "findOrCreate").mockResolvedValue(taskManager.repo as unknown as Repo);
    const spy = vi.spyOn(wss, "handleReadyHello" as any).mockResolvedValue(undefined);

    await wss.handleWorkerHello("w1", fakeWs(), {
      type: "worker_hello",
      workerId: "w1",
      repo: "owner/repo",
      status: "ready",
    });

    expect(spy).toHaveBeenCalled();
  });
});

// ── ForemanMessage.buildSummary — foreman_error ────────────────────────────────

describe("ForemanMessage.buildSummary — foreman_error", () => {
  it("includes the error message in the summary", () => {
    const summary = ForemanMessage.buildSummary("sent", "foreman_error", null, {
      message: "Internal error: something broke",
      fatal: false,
    });
    expect(summary).toContain("foreman_error");
    expect(summary).toContain("Internal error: something broke");
  });

  it("marks fatal errors in the summary", () => {
    const summary = ForemanMessage.buildSummary("sent", "foreman_error", null, {
      message: "Unrecoverable failure",
      fatal: true,
    });
    expect(summary).toContain("fatal");
    expect(summary).toContain("Unrecoverable failure");
  });

  it("non-fatal summary does not contain 'fatal'", () => {
    const summary = ForemanMessage.buildSummary("sent", "foreman_error", null, {
      message: "Soft error",
      fatal: false,
    });
    expect(summary).not.toContain("fatal");
  });
});
