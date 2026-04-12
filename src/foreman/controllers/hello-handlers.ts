import type { WebSocket as WsSocket } from "ws";
import * as Wire from "../../wire.js";
import { fmtError } from "../../utils.js";
import type { TaskManager } from "../models/task-manager.js";
import { Task } from "../models/task.js";
import { Worker } from "../models/worker-registry.js";

export interface BusyHelloDeps {
  ws: WsSocket;
  taskManager: TaskManager;
  sendMsg: (workerId: string, msg: Wire.ForemanMessage, logTaskId?: string) => void;
  log: (workerId: string, line: string) => void;
  flog: (msg: string) => void;
}

export interface IdleHelloDeps {
  ws: WsSocket;
  sendMsg: (workerId: string, msg: Wire.ForemanMessage, logTaskId?: string) => void;
  log: (workerId: string, line: string) => void;
  flog: (msg: string) => void;
}

function flushQueuedEvents(
  workerId: string,
  taskId: string,
  issueRef: string | number,
  deps: Pick<BusyHelloDeps, "taskManager" | "sendMsg" | "log">,
): void {
  const { taskManager, sendMsg, log } = deps;
  for (const evt of taskManager.drainEvents(taskId)) {
    sendMsg(workerId, { type: "event_notification", taskId, event: evt.toWorkerPayload() });
    log(workerId, `→ event_notification #${issueRef} ${evt.eventName} (queued)`);
  }
}

function cancelWorker(
  workerId: string,
  taskId: string | undefined,
  deps: Pick<BusyHelloDeps, "ws" | "sendMsg">,
): void {
  Worker.register(workerId, deps.ws);
  deps.sendMsg(workerId, { type: "hello_ack", workerId, status: "cancelled" }, taskId);
}

async function reclaimWorker(
  workerId: string,
  task: Task,
  deps: BusyHelloDeps,
): Promise<void> {
  const { ws, sendMsg } = deps;
  const w = Worker.register(workerId, ws);
  w.assign(task.taskId);
  // Only call assign if task is not already complete (to preserve task status)
  if (task.status !== "complete") {
    await task.assign(workerId);
  }
  // For complete tasks, the task stays complete while worker finishes cleanup/finalization work
  sendMsg(workerId, { type: "hello_ack", workerId, status: "busy" }, task.taskId);
  flushQueuedEvents(workerId, task.taskId, task.issueNumber, deps);
}

/**
 * Handles the "busy" branch of a worker_hello — the worker is reconnecting
 * and claims to be mid-task. Decides among five cases:
 *
 * 1. Unknown task (numeric taskId) → create placeholder, reclaim
 * 2. Unknown task (non-numeric taskId) → cancel
 * 3. Complete task, same worker → reclaim for finalization
 * 4. Complete task, different worker → cancel
 * 5. Live task, different worker → cancel
 * 6. Otherwise (live task, same or no worker) → reclaim
 */
export async function handleBusyHello(
  workerId: string,
  claimedTaskId: string,
  deps: BusyHelloDeps,
): Promise<void> {
  const { log } = deps;
  const existing = await Task.get(claimedTaskId);

  if (!existing) {
    log(workerId, `hello busy task=#${claimedTaskId} — unknown task, respecting busy status`);
    const issueNumber = parseInt(claimedTaskId, 10);
    let placeholderTask: Task | null = null;
    if (!isNaN(issueNumber)) {
      placeholderTask = await Task.upsert(claimedTaskId, issueNumber, "", "", "", []);
    }
    if (placeholderTask) {
      await reclaimWorker(workerId, placeholderTask, deps);
    } else {
      cancelWorker(workerId, claimedTaskId, deps);
    }
  } else if (existing.status === "complete") {
    if (existing.workerId && existing.workerId !== workerId) {
      log(workerId, `hello busy task=#${claimedTaskId} — task complete but owned by another worker, cancelling`);
      cancelWorker(workerId, claimedTaskId, deps);
    } else {
      log(workerId, `hello busy task=#${claimedTaskId} — task already complete, reclaiming for finalization`);
      await reclaimWorker(workerId, existing, deps);
    }
  } else if (existing.workerId && existing.workerId !== workerId) {
    log(workerId, `hello busy task=#${claimedTaskId} — task taken by another worker`);
    cancelWorker(workerId, claimedTaskId, deps);
  } else {
    log(workerId, `hello busy task=#${claimedTaskId} — reclaimed`);
    await reclaimWorker(workerId, existing, deps);
  }
}

/**
 * Handles the "idle" branch of a worker_hello — the worker is connecting
 * fresh (or restarting without a task). Reverts any stale prior assignment,
 * registers the worker, and sends an idle hello_ack.
 */
export async function handleIdleHello(
  workerId: string,
  deps: IdleHelloDeps,
): Promise<void> {
  const { ws, sendMsg, log, flog } = deps;
  const priorTask = await Task.getByWorker(workerId);
  if (priorTask) {
    await priorTask.revert().catch((err: unknown) =>
      flog(`ERROR Failed to revert task #${priorTask.taskId} to pending: ${fmtError(err)}`)
    );
    log(workerId, `hello idle (had task #${priorTask.taskId}) — reverting task to pending`);
  } else {
    log(workerId, "hello idle");
  }
  Worker.register(workerId, ws);
  sendMsg(workerId, { type: "hello_ack", workerId, status: "idle" });
}
