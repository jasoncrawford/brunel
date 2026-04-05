import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkerRegistry } from "../src/foreman/worker-registry.js";
import type { ForemanMessage } from "../src/types.js";

function fakeWs() {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
}

describe("WorkerRegistry", () => {
  let reg: WorkerRegistry;
  beforeEach(() => { reg = new WorkerRegistry(); });

  it("registers a worker and retrieves it", () => {
    reg.register("w1", fakeWs(), "idle");
    expect(reg.get("w1")).toMatchObject({ workerId: "w1", status: "idle" });
  });

  it("getIdleWorker returns an idle worker", () => {
    reg.register("w1", fakeWs(), "idle");
    expect(reg.getIdleWorker()?.workerId).toBe("w1");
  });

  it("getIdleWorker returns null when all busy", () => {
    reg.register("w1", fakeWs(), "busy");
    expect(reg.getIdleWorker()).toBeNull();
  });

  it("assignTask marks worker busy with taskId", () => {
    reg.register("w1", fakeWs(), "idle");
    reg.assignTask("w1", "42");
    const w = reg.get("w1")!;
    expect(w.status).toBe("busy");
    expect(w.currentTaskId).toBe("42");
  });

  it("releaseWorker marks worker idle and clears taskId", () => {
    reg.register("w1", fakeWs(), "busy");
    reg.assignTask("w1", "42");
    reg.releaseWorker("w1");
    const w = reg.get("w1")!;
    expect(w.status).toBe("idle");
    expect(w.currentTaskId).toBeUndefined();
  });

  it("remove deletes the worker", () => {
    reg.register("w1", fakeWs(), "idle");
    reg.remove("w1");
    expect(reg.get("w1")).toBeUndefined();
  });

  it("getWorkerForTask returns worker assigned to that task", () => {
    reg.register("w1", fakeWs(), "idle");
    reg.assignTask("w1", "42");
    expect(reg.getWorkerForTask("42")?.workerId).toBe("w1");
  });

  it("send serializes message and calls ws.send", () => {
    const ws = fakeWs();
    reg.register("w1", ws, "idle");
    const msg: ForemanMessage = { type: "task_assigned", taskId: "1", issue: { number: 1, title: "T", body: "", labels: [], repoUrl: "https://github.com/o/r" } };
    reg.send("w1", msg);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(msg));
  });

  describe("markDisconnected", () => {
    it("sets status to disconnected and records disconnectedAt", () => {
      reg.register("w1", fakeWs(), "busy");
      reg.assignTask("w1", "42");
      reg.markDisconnected("w1");
      const w = reg.get("w1")!;
      expect(w.status).toBe("disconnected");
      expect(w.currentTaskId).toBe("42");
      expect(w.disconnectedAt).toBeInstanceOf(Date);
    });

    it("is a no-op for unknown worker", () => {
      expect(() => reg.markDisconnected("unknown")).not.toThrow();
    });

    it("getIdleWorker does not return a disconnected worker", () => {
      reg.register("w1", fakeWs(), "idle");
      reg.markDisconnected("w1");
      expect(reg.getIdleWorker()).toBeNull();
    });

    it("send does not call ws.send on a disconnected worker", () => {
      const ws = fakeWs();
      ws.readyState = 3; // CLOSED
      reg.register("w1", ws, "busy");
      reg.markDisconnected("w1");
      reg.send("w1", { type: "task_assigned", taskId: "1", issue: { number: 1, title: "T", body: "", labels: [], repoUrl: "https://github.com/o/r" } });
      expect(ws.send).not.toHaveBeenCalled();
    });

    it("getWorkerSnapshots includes disconnected workers", () => {
      reg.register("w1", fakeWs(), "busy");
      reg.assignTask("w1", "42");
      reg.markDisconnected("w1");
      const snapshots = reg.getWorkerSnapshots();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].status).toBe("disconnected");
      expect(snapshots[0].currentTaskId).toBe("42");
    });
  });
});

describe("reclaim timer", () => {
  let reg: WorkerRegistry;
  beforeEach(() => { reg = new WorkerRegistry(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("startReclaimTimer fires callback after timeout", () => {
    const callback = vi.fn();
    reg.register("w1", fakeWs(), "busy");
    reg.assignTask("w1", "42");
    reg.markDisconnected("w1");
    reg.startReclaimTimer("w1", 1000, callback);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledOnce();
  });

  it("cancelReclaimTimer prevents callback from firing", () => {
    const callback = vi.fn();
    reg.register("w1", fakeWs(), "busy");
    reg.assignTask("w1", "42");
    reg.markDisconnected("w1");
    reg.startReclaimTimer("w1", 1000, callback);
    reg.cancelReclaimTimer("w1");
    vi.advanceTimersByTime(2000);
    expect(callback).not.toHaveBeenCalled();
  });

  it("startReclaimTimer replaces an existing timer (reset on re-disconnect)", () => {
    const first = vi.fn();
    const second = vi.fn();
    reg.register("w1", fakeWs(), "busy");
    reg.assignTask("w1", "42");
    reg.markDisconnected("w1");
    reg.startReclaimTimer("w1", 1000, first);
    vi.advanceTimersByTime(500);
    // Start fresh timer (simulates reconnect + re-disconnect)
    reg.startReclaimTimer("w1", 1000, second);
    vi.advanceTimersByTime(500); // original would have fired here
    expect(first).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500); // second timer fires
    expect(second).toHaveBeenCalledOnce();
  });

  it("cancelReclaimTimer is a no-op for unknown worker", () => {
    expect(() => reg.cancelReclaimTimer("unknown")).not.toThrow();
  });

  it("cancelReclaimTimer is a no-op when no timer is running", () => {
    reg.register("w1", fakeWs(), "idle");
    expect(() => reg.cancelReclaimTimer("w1")).not.toThrow();
  });
});

describe("WorkerRegistry changed events", () => {
  let reg: WorkerRegistry;
  beforeEach(() => { reg = new WorkerRegistry(); });

  it("register emits changed", () => {
    const changed = vi.fn();
    reg.on("changed", changed);
    reg.register("w1", fakeWs(), "idle");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("remove emits changed", () => {
    reg.register("w1", fakeWs(), "idle");
    const changed = vi.fn();
    reg.on("changed", changed);
    reg.remove("w1");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("markDisconnected emits changed", () => {
    reg.register("w1", fakeWs(), "busy");
    const changed = vi.fn();
    reg.on("changed", changed);
    reg.markDisconnected("w1");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("assignTask emits changed", () => {
    reg.register("w1", fakeWs(), "idle");
    const changed = vi.fn();
    reg.on("changed", changed);
    reg.assignTask("w1", "42");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("releaseWorker emits changed", () => {
    reg.register("w1", fakeWs(), "busy");
    reg.assignTask("w1", "42");
    const changed = vi.fn();
    reg.on("changed", changed);
    reg.releaseWorker("w1");
    expect(changed).toHaveBeenCalledOnce();
  });
});
