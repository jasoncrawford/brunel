import * as Wire from "../../../shared/wire.js";
import type { WebhookEvent } from "../models/webhook-event.js";
import { fetchIssueStates } from "../github.js";
import type { TaskManager } from "../models/task-manager.js";
import { Task } from "../models/task.js";
import { Worker } from "../models/worker.js";
import { shortWorkerId } from "../../../shared/utils.js";
import { fmtError } from "../../utils.js";

// ── Pure helper functions ───────────────────────────────────────────────────

function strProp(obj: unknown, key: string): string | null {
  if (typeof obj !== "object" || obj === null) return null;
  const val = (obj as Record<string, unknown>)[key];
  return typeof val === "string" ? val : null;
}

function numProp(obj: unknown, key: string): number | null {
  if (typeof obj !== "object" || obj === null) return null;
  const val = (obj as Record<string, unknown>)[key];
  return typeof val === "number" ? val : null;
}

// ── Route result ──────────────────────────────────────────────────────────────

export interface RouteResult { taskId: string | null; workerId: string | null; }

// ── Routing deps ──────────────────────────────────────────────────────────────

export interface RoutingDeps {
  taskManager: TaskManager;
  repo: string;
  token: string;
  githubApiUrl?: string;
  taskLabel: string;
  sendMsg(workerId: string, msg: Wire.ForemanMessage, logTaskId?: string): void;
  flog(msg: string): void;
  assignIdleWorkers(): Promise<void>;
}

// ── Event forwarding ──────────────────────────────────────────────────────────

export function forwardEvent(task: Task, evt: WebhookEvent, ref: string, deps: Pick<RoutingDeps, "sendMsg" | "flog" | "taskManager">): void {
  const { sendMsg, flog, taskManager } = deps;
  if (task.workerId) {
    const worker = Worker.get(task.workerId);
    if (worker && worker.currentTaskId !== task.taskId) {
      flog(`[task ${ref}] ${evt.eventName} dropped — worker ${shortWorkerId(task.workerId)} is now on a different task`);
      return;
    }
    if (worker?.status === "disconnected") {
      taskManager.queueEvent(task.taskId, evt);
      flog(`[task ${ref}] ${evt.eventName} queued (worker ${shortWorkerId(task.workerId)} disconnected)`);
    } else if (worker) {
      const evtMsg: Wire.ForemanMessage = { type: "event_notification", taskId: task.taskId, event: evt.toWorkerPayload() };
      sendMsg(task.workerId, evtMsg);
      flog(`[worker ${shortWorkerId(task.workerId)}] → event_notification ${ref} ${evt.eventName}`);
    } else {
      flog(`[task ${ref}] ${evt.eventName} DROPPED — worker ${shortWorkerId(task.workerId)} not in registry (disconnected?)`);
    }
  } else if (task.status === "pending" || task.status === "blocked") {
    taskManager.queueEvent(task.taskId, evt);
    flog(`[task ${ref}] ${evt.eventName} queued (no worker assigned)`);
  }
}

// ── Dependency loading ────────────────────────────────────────────────────────

export function startDepsLoad(issueNumber: number, body: string, deps: RoutingDeps): void {
  const { taskManager, repo, token, githubApiUrl, flog, assignIdleWorkers } = deps;
  Task.fetchBlockers(issueNumber, body, { repo, token, apiUrl: githubApiUrl })
    .then(async (blockers) => {
      taskManager.setBlockers(issueNumber, blockers);
      if (blockers.length > 0) {
        const states = await fetchIssueStates(blockers, { repo, token });
        for (const [num, state] of states) {
          taskManager.setIssueOpenState(num, state === "open");
        }
      }
      taskManager.markBlockersLoaded(issueNumber);
      await assignIdleWorkers();
    })
    .catch((err) => flog(`ERROR fetching deps for #${issueNumber}: ${fmtError(err)}`));
}

// ── Per-event-type handlers ────────────────────────────────────────────────────

export async function routePrEvent(
  p: Record<string, unknown>,
  evt: WebhookEvent,
  deps: RoutingDeps,
): Promise<RouteResult> {
  function result(task: { taskId: string; workerId: string | null } | null | undefined): RouteResult {
    return { taskId: task?.taskId ?? null, workerId: task?.workerId ?? null };
  }

  const { taskManager, flog } = deps;
  const pr = p.pull_request as Record<string, unknown> | undefined;
  const prNumber = numProp(pr, "number");
  if (prNumber === null) return result(null);

  // Drop synchronize events — the worker pushed these commits itself.
  if (p.action === "synchronize") return result(await Task.getByPr(prNumber));

  // When a PR is opened, register it against a task if the body links an issue.
  if (p.action === "opened" && pr) {
    const linkedIssue = extractLinkedIssueNumber(String(pr.body ?? ""));
    if (linkedIssue !== null) {
      const linkedTask = await Task.getByIssue(linkedIssue);
      if (linkedTask) {
        const branch = strProp(pr.head, "ref");
        if (branch) taskManager.registerBranch(branch, linkedTask.taskId);
        await linkedTask.registerPr(prNumber, branch ?? null).catch((err: unknown) =>
          flog(`ERROR Failed to register PR for task #${linkedTask.taskId}: ${fmtError(err)}`)
        );
        flog(`[task #${linkedIssue}] PR #${prNumber} registered`);
      }
    }
  }

  // When a PR is closed without merging, clear it from the task.
  if (p.action === "closed" && pr && !pr.merged) {
    const task = await Task.getByPr(prNumber);
    if (task) {
      flog(`[task #${task.issueNumber}] PR #${prNumber} unregistered (closed without merging)`);
      await task.unregisterPr().catch((err: unknown) =>
        flog(`ERROR Failed to unregister PR #${prNumber}: ${fmtError(err)}`)
      );
      forwardEvent(task, evt, `PR #${prNumber}`, deps);
      return result(task);
    }
    return result(null);
  }

  // When a PR is closed with merging, record that it was merged.
  if (p.action === "closed" && pr && pr.merged) {
    const task = await Task.getByPr(prNumber);
    if (task) {
      flog(`[task #${task.issueNumber}] PR #${prNumber} merged`);
      await task.mergePr().catch((err: unknown) =>
        flog(`ERROR Failed to record PR #${prNumber} merge: ${fmtError(err)}`)
      );
      forwardEvent(task, evt, `PR #${prNumber}`, deps);
      return result(task);
    }
    return result(null);
  }

  const task = await Task.getByPr(prNumber);
  if (task) forwardEvent(task, evt, `PR #${prNumber}`, deps);
  return result(task);
}

export async function routePrReviewEvent(
  p: Record<string, unknown>,
  evt: WebhookEvent,
  deps: RoutingDeps,
): Promise<RouteResult> {
  function result(task: { taskId: string; workerId: string | null } | null | undefined): RouteResult {
    return { taskId: task?.taskId ?? null, workerId: task?.workerId ?? null };
  }

  const pr = p.pull_request as Record<string, unknown> | undefined;
  const prNumber = numProp(pr, "number");
  if (prNumber === null) return result(null);
  const task = await Task.getByPr(prNumber);
  if (task) forwardEvent(task, evt, `PR #${prNumber}`, deps);
  return result(task);
}

export async function routeCheckEvent(
  p: Record<string, unknown>,
  evt: WebhookEvent,
  name: string,
  deps: RoutingDeps,
): Promise<RouteResult> {
  function result(task: { taskId: string; workerId: string | null } | null | undefined): RouteResult {
    return { taskId: task?.taskId ?? null, workerId: task?.workerId ?? null };
  }

  const { taskManager } = deps;
  const inner = (name === "check_run" ? p.check_run : p.check_suite) as Record<string, unknown> | undefined;
  const prs = inner?.pull_requests as Array<{ number: number }> | undefined;

  if (prs && prs.length > 0) {
    const task = await Task.getByPr(prs[0].number);
    if (task) { forwardEvent(task, evt, `PR #${prs[0].number}`, deps); return result(task); }
  }

  const headBranch = name === "check_run"
    ? strProp(inner?.check_suite, "head_branch") ?? ""
    : strProp(inner, "head_branch") ?? "";
  if (headBranch) {
    const task = await taskManager.getTaskForBranch(headBranch);
    if (task) { forwardEvent(task, evt, `branch ${headBranch}`, deps); return result(task); }
  }
  return result(null);
}

export async function routeIssueEvent(
  p: Record<string, unknown>,
  evt: WebhookEvent,
  issue: Record<string, unknown>,
  issueNumber: number,
  deps: RoutingDeps,
): Promise<RouteResult> {
  function result(task: { taskId: string; workerId: string | null } | null | undefined): RouteResult {
    return { taskId: task?.taskId ?? null, workerId: task?.workerId ?? null };
  }

  const { taskManager, flog, repo, taskLabel, assignIdleWorkers } = deps;

  let task = await Task.getByIssue(issueNumber);

  // GitHub issue_comment events on PRs have the PR number in issue.number.
  if (!task) task = await Task.getByPr(issueNumber);

  // If the issue isn't queued yet, check if this webhook should enqueue it.
  if (!task) {
    const action = p.action as string | undefined;
    const labeledNow =
      action === "labeled" &&
      (p.label as Record<string, unknown> | undefined)?.name === taskLabel;
    const openedWithLabel =
      action === "opened" &&
      (issue.labels as Array<{ name: string }> | undefined)?.some((l) => l.name === taskLabel);

    if (labeledNow || openedWithLabel) {
      const issueState = String(issue.state ?? "open");
      if (issueState === "closed") {
        flog(`[task #${issueNumber}] issues/${action}: ignoring — issue is closed (title: ${JSON.stringify(String(issue.title ?? ""))})`);
        return result(null);
      }

      const repoUrl = strProp(p.repository, "html_url") ?? "";
      const labels =
        (issue.labels as Array<{ name: string }> | undefined)?.map((l) => l.name) ?? [];

      // Track as open and persist to DB.
      await taskManager.enqueueIssue(String(issueNumber), issueNumber, repo, String(issue.title ?? ""), String(issue.body ?? ""), labels)
        .catch((err: unknown) => flog(`ERROR Failed to persist task #${issueNumber}: ${fmtError(err)}`));

      startDepsLoad(issueNumber, String(issue.body ?? ""), deps);
      await assignIdleWorkers();
      flog(`[task #${issueNumber}] enqueued via issues/${action}`);
      return { taskId: String(issueNumber), workerId: null };
    }
  }

  // ── Dependency graph updates ─────────────────────────────────────────────

  const action = p.action as string | undefined;

  if (
    action === "unlabeled" &&
    (p.label as Record<string, unknown> | undefined)?.name === taskLabel
  ) {
    await taskManager.dequeueIssue(issueNumber)
      .catch((err: unknown) => flog(`ERROR Failed to dequeue task #${issueNumber}: ${fmtError(err)}`));
    flog(`[task #${issueNumber}] dequeued (label removed)`);
    await assignIdleWorkers();
    return result(task);
  }

  if (action === "closed") {
    await taskManager.closeIssue(issueNumber).catch((err: unknown) =>
      flog(`ERROR Failed to close issue #${issueNumber}: ${fmtError(err)}`)
    );
    await assignIdleWorkers();
    return result(task);
  }

  if (action === "reopened") {
    await taskManager.reopenIssue(issueNumber).catch((err: unknown) =>
      flog(`ERROR Failed to reopen issue #${issueNumber}: ${fmtError(err)}`)
    );
    await assignIdleWorkers();
    return result(task);
  }

  if (action === "edited") {
    const changes = p.changes as Record<string, unknown> | undefined;
    if (changes?.body) {
      const trackedTask = await Task.getByIssue(issueNumber);
      if (trackedTask) {
        const newBody = String(issue.body ?? "");
        taskManager.resetBlockers(issueNumber);
        startDepsLoad(issueNumber, newBody, deps);
      }
    }
  }

  if (!task) return result(null);
  forwardEvent(task, evt, `#${issueNumber}`, deps);
  return result(task);
}

// ── Core event routing ────────────────────────────────────────────────────────

export async function routeEvent(name: string, p: Record<string, unknown>, evt: WebhookEvent, deps: RoutingDeps): Promise<RouteResult> {
  if (name === "pull_request") {
    return routePrEvent(p, evt, deps);
  }

  if (name === "pull_request_review" || name === "pull_request_review_comment") {
    return routePrReviewEvent(p, evt, deps);
  }

  if (name === "check_run" || name === "check_suite") {
    return routeCheckEvent(p, evt, name, deps);
  }

  const issue = p.issue as Record<string, unknown> | undefined;
  const issueNumber = numProp(issue, "number");
  if (issueNumber === null) return { taskId: null, workerId: null };

  return routeIssueEvent(p, evt, issue!, issueNumber, deps);
}

export function extractLinkedIssueNumber(body: string): number | null {
  const match = /(?:closes|fixes|resolves)\s+#(\d+)/i.exec(body);
  return match ? parseInt(match[1], 10) : null;
}
