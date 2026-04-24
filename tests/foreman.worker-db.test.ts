/**
 * Tests for Worker DB persistence behavior.
 * Verifies fire-and-forget writes to the workers table and the getDbRow() API.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Worker } from "../src/foreman/models/worker.js";
import { db } from "../src/foreman/clients/db-client.js";
import { fakeRepo, resetDb } from "./helpers/task.js";

function fakeWs() {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
}

beforeEach(() => {
  Worker._reset();
  resetDb();
});

describe("Worker DB persistence", () => {
  it("register writes worker to DB with status idle", async () => {
    const repo = fakeRepo("owner/repo", 1, "new");
    Worker.register("w1", fakeWs(), repo);
    await new Promise((r) => setTimeout(r, 20));
    const { data } = await (db.from as any)("workers")
      .select("*").eq("worker_id", "w1").maybeSingle();
    expect(data).toMatchObject({ worker_id: "w1", status: "idle", repo_full_name: "owner/repo", num_connections: 1 });
  });

  it("reconnect increments num_connections", async () => {
    const repo = fakeRepo("owner/repo", 1, "new");
    Worker.register("w1", fakeWs(), repo);
    await new Promise((r) => setTimeout(r, 20));
    // Simulate server restart: clear runtime registry but keep DB
    Worker._reset();
    Worker.register("w1", fakeWs(), repo);
    await new Promise((r) => setTimeout(r, 20));
    const { data } = await (db.from as any)("workers")
      .select("*").eq("worker_id", "w1").maybeSingle();
    expect(data?.num_connections).toBe(2);
  });

  it("assign updates status to busy and sets current_task_id", async () => {
    const repo = fakeRepo("owner/repo", 1, "new");
    const w = Worker.register("w1", fakeWs(), repo);
    const task = { taskId: "42" } as any;
    w.assign(task);
    await new Promise((r) => setTimeout(r, 20));
    const { data } = await (db.from as any)("workers")
      .select("*").eq("worker_id", "w1").maybeSingle();
    expect(data?.status).toBe("busy");
    expect(data?.current_task_id).toBe("42");
  });

  it("release updates status to idle and clears current_task_id", async () => {
    const repo = fakeRepo("owner/repo", 1, "new");
    const w = Worker.register("w1", fakeWs(), repo);
    const task = { taskId: "42" } as any;
    w.assign(task);
    w.release();
    await new Promise((r) => setTimeout(r, 20));
    const { data } = await (db.from as any)("workers")
      .select("*").eq("worker_id", "w1").maybeSingle();
    expect(data?.status).toBe("idle");
    expect(data?.current_task_id).toBeNull();
  });

  it("markDisconnected sets status disconnected and disconnected_at", async () => {
    const repo = fakeRepo("owner/repo", 1, "new");
    const w = Worker.register("w1", fakeWs(), repo);
    w.markDisconnected();
    await new Promise((r) => setTimeout(r, 20));
    const { data } = await (db.from as any)("workers")
      .select("*").eq("worker_id", "w1").maybeSingle();
    expect(data?.status).toBe("disconnected");
    expect(data?.disconnected_at).toBeTruthy();
  });

  it("remove sets goodbye_at and status disconnected", async () => {
    const repo = fakeRepo("owner/repo", 1, "new");
    const w = Worker.register("w1", fakeWs(), repo);
    w.remove();
    await new Promise((r) => setTimeout(r, 20));
    const { data } = await (db.from as any)("workers")
      .select("*").eq("worker_id", "w1").maybeSingle();
    expect(data?.status).toBe("disconnected");
    expect(data?.goodbye_at).toBeTruthy();
  });

  it("getDbRow returns DB row including repo_full_name", async () => {
    const repo = fakeRepo("owner/repo", 1, "new");
    Worker.register("w1", fakeWs(), repo);
    await new Promise((r) => setTimeout(r, 20));
    const row = await Worker.getDbRow("w1");
    expect(row).toMatchObject({ worker_id: "w1", repo_full_name: "owner/repo" });
  });

  it("getDbRow returns null for unknown worker", async () => {
    const row = await Worker.getDbRow("no-such-worker");
    expect(row).toBeNull();
  });

  it("allForDashboard includes in-memory connected workers", async () => {
    const repo = fakeRepo("owner/repo", 1, "new");
    Worker.register("w1", fakeWs(), repo);
    const result = await Worker.allForDashboard();
    expect(result.map((w) => w.workerId)).toContain("w1");
  });

  it("allForDashboard includes disconnected workers with assigned tasks from DB", async () => {
    const repo = fakeRepo("owner/repo", 1, "new");
    const w = Worker.register("w1", fakeWs(), repo);
    const task = { taskId: "42" } as any;
    w.assign(task);
    w.markDisconnected();
    Worker._reset(); // clear in-memory (simulate reconnect context)
    await new Promise((r) => setTimeout(r, 20));
    const result = await Worker.allForDashboard();
    expect(result.map((w) => w.workerId)).toContain("w1");
    expect(result.find((w) => w.workerId === "w1")?.currentTaskId).toBe("42");
  });

  it("allForDashboard does not include disconnected workers without tasks", async () => {
    const repo = fakeRepo("owner/repo", 1, "new");
    const w = Worker.register("w1", fakeWs(), repo);
    w.remove(); // clean disconnect, no task
    Worker._reset();
    await new Promise((r) => setTimeout(r, 20));
    const result = await Worker.allForDashboard();
    expect(result.map((w) => w.workerId)).not.toContain("w1");
  });
});
