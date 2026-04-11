import { describe, it, expect, vi, beforeEach } from "vitest";
import { Worker } from "../src/foreman/models/worker-registry.js";
import type { ForWorkerMsg } from "../src/types.js";

function fakeWs() {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
}

beforeEach(() => { Worker._reset(); });

describe("Worker", () => {
  it("registers a worker and retrieves it", () => {
    Worker.register("w1", fakeWs());
    expect(Worker.get("w1")).toMatchObject({ workerId: "w1", status: "idle" });
  });

  it("getIdle returns an idle worker", () => {
    Worker.register("w1", fakeWs());
    expect(Worker.getIdle().map(w => w.workerId)).toContain("w1");
  });

  it("getIdle returns empty array when all busy", () => {
    const w = Worker.register("w1", fakeWs());
    w.assign("42");
    expect(Worker.getIdle()).toHaveLength(0);
  });

  it("assign marks worker busy with taskId", () => {
    const w = Worker.register("w1", fakeWs());
    w.assign("42");
    expect(w.status).toBe("busy");
    expect(w.currentTaskId).toBe("42");
  });

  it("release marks worker idle and clears taskId", () => {
    const w = Worker.register("w1", fakeWs());
    w.assign("42");
    w.release();
    expect(w.status).toBe("idle");
    expect(w.currentTaskId).toBeUndefined();
  });

  it("remove deletes the worker from the registry", () => {
    const w = Worker.register("w1", fakeWs());
    w.remove();
    expect(Worker.get("w1")).toBeUndefined();
  });

  it("getByTask returns worker assigned to that task", () => {
    const w = Worker.register("w1", fakeWs());
    w.assign("42");
    expect(Worker.getByTask("42")?.workerId).toBe("w1");
  });

  it("all returns all registered workers", () => {
    Worker.register("w1", fakeWs());
    Worker.register("w2", fakeWs());
    expect(Worker.all().map(w => w.workerId)).toEqual(expect.arrayContaining(["w1", "w2"]));
    expect(Worker.all()).toHaveLength(2);
  });

  it("send serializes message and calls ws.send", () => {
    const ws = fakeWs();
    const w = Worker.register("w1", ws);
    const msg: ForWorkerMsg = { type: "task_assigned", taskId: "1", issue: { number: 1, title: "T", body: "", labels: [], repoUrl: "https://github.com/o/r" } };
    w.send(msg);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(msg));
  });

  it("send returns true when OPEN", () => {
    const ws = fakeWs();
    const w = Worker.register("w1", ws);
    const result = w.send({ type: "task_assigned", taskId: "1", issue: { number: 1, title: "T", body: "", labels: [], repoUrl: "https://github.com/o/r" } });
    expect(result).toBe(true);
  });

  it("toSnapshot returns WorkerSnapshot", () => {
    const w = Worker.register("w1", fakeWs());
    w.assign("42");
    expect(w.toSnapshot()).toEqual({ workerId: "w1", status: "busy", currentTaskId: "42" });
  });

  describe("markDisconnected", () => {
    it("sets status to disconnected and records disconnectedAt", () => {
      const w = Worker.register("w1", fakeWs());
      w.assign("42");
      w.markDisconnected();
      expect(w.status).toBe("disconnected");
      expect(w.currentTaskId).toBe("42");
      expect(w.disconnectedAt).toBeInstanceOf(Date);
    });

    it("getIdle does not return a disconnected worker", () => {
      const w = Worker.register("w1", fakeWs());
      w.markDisconnected();
      expect(Worker.getIdle()).toHaveLength(0);
    });

    it("send does not call ws.send on a closed socket", () => {
      const ws = fakeWs();
      ws.readyState = 3; // CLOSED
      const w = Worker.register("w1", ws);
      w.markDisconnected();
      w.send({ type: "task_assigned", taskId: "1", issue: { number: 1, title: "T", body: "", labels: [], repoUrl: "https://github.com/o/r" } });
      expect(ws.send).not.toHaveBeenCalled();
    });

    it("send returns false when socket is closed", () => {
      const ws = fakeWs();
      ws.readyState = 3;
      const w = Worker.register("w1", ws);
      const result = w.send({ type: "task_assigned", taskId: "1", issue: { number: 1, title: "T", body: "", labels: [], repoUrl: "https://github.com/o/r" } });
      expect(result).toBe(false);
    });

    it("all includes disconnected workers", () => {
      const w = Worker.register("w1", fakeWs());
      w.assign("42");
      w.markDisconnected();
      const snapshots = Worker.all().map(x => x.toSnapshot());
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].status).toBe("disconnected");
      expect(snapshots[0].currentTaskId).toBe("42");
    });
  });

  it("isCurrentSocket returns true for the registered socket", () => {
    const ws = fakeWs();
    const w = Worker.register("w1", ws);
    expect(w.isCurrentSocket(ws)).toBe(true);
  });

  it("isCurrentSocket returns false for a different socket", () => {
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    const w = Worker.register("w1", ws1);
    expect(w.isCurrentSocket(ws2)).toBe(false);
  });

  it("re-registering with a new socket replaces the entry", () => {
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    Worker.register("w1", ws1);
    const w = Worker.register("w1", ws2);
    expect(Worker.get("w1")).toBe(w);
    expect(w.isCurrentSocket(ws2)).toBe(true);
  });
});


describe("Worker changed events", () => {
  beforeEach(() => { Worker._reset(); });

  it("register emits changed", () => {
    const changed = vi.fn();
    Worker.events.on("changed", changed);
    Worker.register("w1", fakeWs());
    expect(changed).toHaveBeenCalledOnce();
    Worker.events.off("changed", changed);
  });

  it("remove emits changed", () => {
    const w = Worker.register("w1", fakeWs());
    const changed = vi.fn();
    Worker.events.on("changed", changed);
    w.remove();
    expect(changed).toHaveBeenCalledOnce();
    Worker.events.off("changed", changed);
  });

  it("markDisconnected emits changed", () => {
    const w = Worker.register("w1", fakeWs());
    const changed = vi.fn();
    Worker.events.on("changed", changed);
    w.markDisconnected();
    expect(changed).toHaveBeenCalledOnce();
    Worker.events.off("changed", changed);
  });

  it("assign emits changed", () => {
    const w = Worker.register("w1", fakeWs());
    const changed = vi.fn();
    Worker.events.on("changed", changed);
    w.assign("42");
    expect(changed).toHaveBeenCalledOnce();
    Worker.events.off("changed", changed);
  });

  it("release emits changed", () => {
    const w = Worker.register("w1", fakeWs());
    w.assign("42");
    const changed = vi.fn();
    Worker.events.on("changed", changed);
    w.release();
    expect(changed).toHaveBeenCalledOnce();
    Worker.events.off("changed", changed);
  });
});
