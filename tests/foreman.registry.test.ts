import { describe, it, expect, vi, beforeEach } from "vitest";
import { Worker } from "../src/foreman/models/worker.js";
import { Task } from "../src/foreman/models/task.js";
import * as Wire from "../shared/wire.js";
import { fakeRepo } from "./helpers/task.js";

function fakeWs() {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
}

function fakeTask(taskId: string) {
  return Task.fromTest({ task_id: taskId, issue_number: parseInt(taskId, 10) || 0 });
}

beforeEach(() => { Worker._reset(); });

describe("Worker", () => {
  it("registers a worker and retrieves it", () => {
    Worker.register("w1", fakeWs(), fakeRepo());
    expect(Worker.fromRegistry("w1")).toMatchObject({ workerId: "w1", status: "ready" });
  });

  it("getIdle returns an idle worker", () => {
    Worker.register("w1", fakeWs(), fakeRepo());
    expect(Worker.getIdle().map(w => w.workerId)).toContain("w1");
  });

  it("getIdle returns empty array when all busy", () => {
    const w = Worker.register("w1", fakeWs(), fakeRepo());
    w.assign(fakeTask("42"));
    expect(Worker.getIdle()).toHaveLength(0);
  });

  it("assign marks worker busy with taskId", () => {
    const w = Worker.register("w1", fakeWs(), fakeRepo());
    w.assign(fakeTask("42"));
    expect(w.status).toBe("assigned");
    expect(w.currentTaskId).toBe("42");
  });

  it("release marks worker idle and clears taskId", () => {
    const w = Worker.register("w1", fakeWs(), fakeRepo());
    w.assign(fakeTask("42"));
    w.release();
    expect(w.status).toBe("ready");
    expect(w.currentTaskId).toBeUndefined();
  });

  it("remove deletes the worker from the registry", () => {
    const w = Worker.register("w1", fakeWs(), fakeRepo());
    w.remove();
    expect(Worker.fromRegistry("w1")).toBeUndefined();
  });

  it("getByTask returns worker assigned to that task", () => {
    const w = Worker.register("w1", fakeWs(), fakeRepo());
    w.assign(fakeTask("42"));
    expect(Worker.getByTask("42")?.workerId).toBe("w1");
  });

  it("all returns all registered workers", () => {
    Worker.register("w1", fakeWs(), fakeRepo());
    Worker.register("w2", fakeWs(), fakeRepo());
    expect(Worker.all().map(w => w.workerId)).toEqual(expect.arrayContaining(["w1", "w2"]));
    expect(Worker.all()).toHaveLength(2);
  });

  it("send serializes message and calls ws.send", () => {
    const ws = fakeWs();
    const w = Worker.register("w1", ws, fakeRepo());
    const msg: Wire.ForemanMessage = { type: "task_assigned", taskId: "1", issue: { number: 1, title: "T", body: "", labels: [], repoUrl: "https://github.com/o/r" } };
    w.send(msg);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(msg), expect.any(Function));
  });

  it("send returns true when OPEN", () => {
    const ws = fakeWs();
    const w = Worker.register("w1", ws, fakeRepo());
    const result = w.send({ type: "task_assigned", taskId: "1", issue: { number: 1, title: "T", body: "", labels: [], repoUrl: "https://github.com/o/r" } });
    expect(result).toBe(true);
  });

  it("toWire returns WorkerSnapshot", () => {
    const w = Worker.register("w1", fakeWs(), fakeRepo());
    w.assign(fakeTask("42"));
    expect(w.toWire()).toMatchObject({ workerId: "w1", status: "assigned", currentTaskId: "42", repo: "owner/repo" });
  });

  describe("markDisconnected", () => {
    it("sets status to disconnected and records disconnectedAt", () => {
      const w = Worker.register("w1", fakeWs(), fakeRepo());
      w.assign(fakeTask("42"));
      w.markDisconnected();
      expect(w.status).toBe("disconnected");
      expect(w.currentTaskId).toBe("42");
      expect(w.disconnectedAt).toBeInstanceOf(Date);
    });

    it("getIdle does not return a disconnected worker", () => {
      const w = Worker.register("w1", fakeWs(), fakeRepo());
      w.markDisconnected();
      expect(Worker.getIdle()).toHaveLength(0);
    });

    it("send does not call ws.send on a closed socket", () => {
      const ws = fakeWs();
      ws.readyState = 3; // CLOSED
      const w = Worker.register("w1", ws, fakeRepo());
      w.markDisconnected();
      w.send({ type: "task_assigned", taskId: "1", issue: { number: 1, title: "T", body: "", labels: [], repoUrl: "https://github.com/o/r" } });
      expect(ws.send).not.toHaveBeenCalled();
    });

    it("send returns false when socket is closed", () => {
      const ws = fakeWs();
      ws.readyState = 3;
      const w = Worker.register("w1", ws, fakeRepo());
      const result = w.send({ type: "task_assigned", taskId: "1", issue: { number: 1, title: "T", body: "", labels: [], repoUrl: "https://github.com/o/r" } });
      expect(result).toBe(false);
    });

    it("all includes disconnected workers", () => {
      const w = Worker.register("w1", fakeWs(), fakeRepo());
      w.assign(fakeTask("42"));
      w.markDisconnected();
      const snapshots = Worker.all().map(x => x.toWire());
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].status).toBe("disconnected");
      expect(snapshots[0].currentTaskId).toBe("42");
    });
  });

  it("isCurrentSocket returns true for the registered socket", () => {
    const ws = fakeWs();
    const w = Worker.register("w1", ws, fakeRepo());
    expect(w.isCurrentSocket(ws)).toBe(true);
  });

  it("isCurrentSocket returns false for a different socket", () => {
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    const w = Worker.register("w1", ws1, fakeRepo());
    expect(w.isCurrentSocket(ws2)).toBe(false);
  });

  it("re-registering with a new socket replaces the entry", () => {
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    Worker.register("w1", ws1, fakeRepo());
    const w = Worker.register("w1", ws2, fakeRepo());
    expect(Worker.fromRegistry("w1")).toBe(w);
    expect(w.isCurrentSocket(ws2)).toBe(true);
  });
});


describe("Worker changed events", () => {
  beforeEach(() => { Worker._reset(); });

  it("register emits changed", () => {
    const changed = vi.fn();
    Worker.events.on("changed", changed);
    Worker.register("w1", fakeWs(), fakeRepo());
    expect(changed).toHaveBeenCalledOnce();
    Worker.events.off("changed", changed);
  });

  it("remove emits changed", () => {
    const w = Worker.register("w1", fakeWs(), fakeRepo());
    const changed = vi.fn();
    Worker.events.on("changed", changed);
    w.remove();
    expect(changed).toHaveBeenCalledOnce();
    Worker.events.off("changed", changed);
  });

  it("markDisconnected emits changed", () => {
    const w = Worker.register("w1", fakeWs(), fakeRepo());
    const changed = vi.fn();
    Worker.events.on("changed", changed);
    w.markDisconnected();
    expect(changed).toHaveBeenCalledOnce();
    Worker.events.off("changed", changed);
  });

  it("assign emits changed", () => {
    const w = Worker.register("w1", fakeWs(), fakeRepo());
    const changed = vi.fn();
    Worker.events.on("changed", changed);
    w.assign(fakeTask("42"));
    expect(changed).toHaveBeenCalledOnce();
    Worker.events.off("changed", changed);
  });

  it("release emits changed", () => {
    const w = Worker.register("w1", fakeWs(), fakeRepo());
    w.assign(fakeTask("42"));
    const changed = vi.fn();
    Worker.events.on("changed", changed);
    w.release();
    expect(changed).toHaveBeenCalledOnce();
    Worker.events.off("changed", changed);
  });
});
