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

function truncTitle(title: unknown, max = 50): string {
  const s = String(title ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function extractLinkedIssueNumber(body: string): number | null {
  const match = /(?:closes|fixes|resolves)\s+#(\d+)/i.exec(body);
  return match ? parseInt(match[1], 10) : null;
}

// ── Event summary formatting ───────────────────────────────────────────────

export function summaryEvent(id: string, name: string, payload: unknown): string {
  const p = payload as Record<string, unknown>;
  const action = typeof p.action === "string" ? `/${p.action}` : "";
  const repo = (p.repository as Record<string, unknown> | undefined)?.full_name;
  const sender = (p.sender as Record<string, unknown> | undefined)?.login;

  let detail = "";
  const issue = p.issue as Record<string, unknown> | undefined;
  const pr = p.pull_request as Record<string, unknown> | undefined;

  if (issue) {
    detail = ` #${issue.number} "${truncTitle(issue.title)}"`;
  } else if (pr) {
    detail = ` #${pr.number} "${truncTitle(pr.title)}"`;
  } else if (name === "push") {
    const ref = String(p.ref ?? "");
    const count = (p.commits as unknown[] | undefined)?.length ?? 0;
    detail = ` ${ref} (${count} commit${count === 1 ? "" : "s"})`;
  } else if (name === "delete") {
    const ref = String(p.ref ?? "");
    if (ref) detail = ` ${ref}`;
  } else if (name === "check_run" || name === "check_suite" || name === "workflow_run" || name === "workflow_job") {
    const inner = p[name] as Record<string, unknown> | undefined;
    const prs = inner?.pull_requests as Array<{ number: number }> | undefined;
    if (prs && prs.length > 0) {
      detail = ` PR #${prs[0].number}`;
    } else {
      const headBranch = name === "check_run"
        ? String((inner?.check_suite as Record<string, unknown> | undefined)?.head_branch ?? "")
        : String(inner?.head_branch ?? "");
      if (headBranch) detail = ` ${headBranch}`;
    }
  }

  const parts: string[] = [`${name}${action}${detail}`];
  if (sender) parts.push(`by ${sender}`);
  if (repo) parts.push(`(${repo})`);

  return `[event] ${parts.join(" ")}`;
}

export function isMutedEvent(name: string): boolean {
  return name === "workflow_job" || name === "workflow_run";
}

// ── Route result ──────────────────────────────────────────────────────────────

export interface RouteResult { taskId: string | null; workerId: string | null; }

// ── EventRouter class ─────────────────────────────────────────────────────────

export class EventRouter {
  private taskManager: TaskManager;
  private repo: string;
  private token: string;
  private githubApiUrl: string | undefined;
  private taskLabel: string;
  private sendMsg: (workerId: string, msg: Wire.ForemanMessage, logTaskId?: string) => void;
  private flog: (msg: string) => void;
  private assignIdleWorkers: () => Promise<void>;

  constructor(deps: {
    taskManager: TaskManager;
    repo: string;
    token: string;
    githubApiUrl?: string;
    taskLabel: string;
    sendMsg(workerId: string, msg: Wire.ForemanMessage, logTaskId?: string): void;
    flog(msg: string): void;
    assignIdleWorkers(): Promise<void>;
  }) {
    this.taskManager = deps.taskManager;
    this.repo = deps.repo;
    this.token = deps.token;
    this.githubApiUrl = deps.githubApiUrl;
    this.taskLabel = deps.taskLabel;
    this.sendMsg = deps.sendMsg;
    this.flog = deps.flog;
    this.assignIdleWorkers = deps.assignIdleWorkers;
  }

  // ── Event forwarding ──────────────────────────────────────────────────────

  private forwardEvent(task: Task, evt: WebhookEvent, ref: string): void {
    if (task.workerId) {
      const worker = Worker.get(task.workerId);
      if (worker && worker.currentTaskId !== task.taskId) {
        this.flog(`[task ${ref}] ${evt.eventName} dropped — worker ${shortWorkerId(task.workerId)} is now on a different task`);
        return;
      }
      if (worker?.status === "disconnected") {
        this.taskManager.queueEvent(task.taskId, evt);
        this.flog(`[task ${ref}] ${evt.eventName} queued (worker ${shortWorkerId(task.workerId)} disconnected)`);
      } else if (worker) {
        const evtMsg: Wire.ForemanMessage = { type: "event_notification", taskId: task.taskId, event: evt.toWorkerPayload() };
        this.sendMsg(task.workerId, evtMsg);
        this.flog(`[worker ${shortWorkerId(task.workerId)}] → event_notification ${ref} ${evt.eventName}`);
      } else {
        this.flog(`[task ${ref}] ${evt.eventName} DROPPED — worker ${shortWorkerId(task.workerId)} not in registry (disconnected?)`);
      }
    } else if (task.status === "pending" || task.status === "blocked") {
      this.taskManager.queueEvent(task.taskId, evt);
      this.flog(`[task ${ref}] ${evt.eventName} queued (no worker assigned)`);
    }
  }

  // ── Dependency loading ────────────────────────────────────────────────────

  private startDepsLoad(issueNumber: number, body: string): void {
    Task.fetchBlockers(issueNumber, body, { repo: this.repo, token: this.token, apiUrl: this.githubApiUrl })
      .then(async (blockers) => {
        this.taskManager.setBlockers(issueNumber, blockers);
        if (blockers.length > 0) {
          const states = await fetchIssueStates(blockers, { repo: this.repo, token: this.token });
          for (const [num, state] of states) {
            this.taskManager.setIssueOpenState(num, state === "open");
          }
        }
        this.taskManager.markBlockersLoaded(issueNumber);
        await this.assignIdleWorkers();
      })
      .catch((err) => this.flog(`ERROR fetching deps for #${issueNumber}: ${fmtError(err)}`));
  }

  // ── Per-event-type handlers ────────────────────────────────────────────────

  private async routePrEvent(
    p: Record<string, unknown>,
    evt: WebhookEvent,
  ): Promise<RouteResult> {
    function result(task: { taskId: string; workerId: string | null } | null | undefined): RouteResult {
      return { taskId: task?.taskId ?? null, workerId: task?.workerId ?? null };
    }

    const { taskManager, flog } = this;
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
        this.forwardEvent(task, evt, `PR #${prNumber}`);
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
        this.forwardEvent(task, evt, `PR #${prNumber}`);
        return result(task);
      }
      return result(null);
    }

    const task = await Task.getByPr(prNumber);
    if (task) this.forwardEvent(task, evt, `PR #${prNumber}`);
    return result(task);
  }

  private async routePrReviewEvent(
    p: Record<string, unknown>,
    evt: WebhookEvent,
  ): Promise<RouteResult> {
    function result(task: { taskId: string; workerId: string | null } | null | undefined): RouteResult {
      return { taskId: task?.taskId ?? null, workerId: task?.workerId ?? null };
    }

    const pr = p.pull_request as Record<string, unknown> | undefined;
    const prNumber = numProp(pr, "number");
    if (prNumber === null) return result(null);
    const task = await Task.getByPr(prNumber);
    if (task) this.forwardEvent(task, evt, `PR #${prNumber}`);
    return result(task);
  }

  private async routeCheckEvent(
    p: Record<string, unknown>,
    evt: WebhookEvent,
    name: string,
  ): Promise<RouteResult> {
    function result(task: { taskId: string; workerId: string | null } | null | undefined): RouteResult {
      return { taskId: task?.taskId ?? null, workerId: task?.workerId ?? null };
    }

    const { taskManager } = this;
    const inner = (name === "check_run" ? p.check_run : p.check_suite) as Record<string, unknown> | undefined;
    const prs = inner?.pull_requests as Array<{ number: number }> | undefined;

    if (prs && prs.length > 0) {
      const task = await Task.getByPr(prs[0].number);
      if (task) { this.forwardEvent(task, evt, `PR #${prs[0].number}`); return result(task); }
    }

    const headBranch = name === "check_run"
      ? strProp(inner?.check_suite, "head_branch") ?? ""
      : strProp(inner, "head_branch") ?? "";
    if (headBranch) {
      const task = await taskManager.getTaskForBranch(headBranch);
      if (task) { this.forwardEvent(task, evt, `branch ${headBranch}`); return result(task); }
    }
    return result(null);
  }

  private async routeIssueEvent(
    p: Record<string, unknown>,
    evt: WebhookEvent,
    issue: Record<string, unknown>,
    issueNumber: number,
  ): Promise<RouteResult> {
    function result(task: { taskId: string; workerId: string | null } | null | undefined): RouteResult {
      return { taskId: task?.taskId ?? null, workerId: task?.workerId ?? null };
    }

    const { taskManager, flog, repo } = this;

    let task = await Task.getByIssue(issueNumber);

    // GitHub issue_comment events on PRs have the PR number in issue.number.
    if (!task) task = await Task.getByPr(issueNumber);

    // If the issue isn't queued yet, check if this webhook should enqueue it.
    if (!task) {
      const action = p.action as string | undefined;
      const labeledNow =
        action === "labeled" &&
        (p.label as Record<string, unknown> | undefined)?.name === this.taskLabel;
      const openedWithLabel =
        action === "opened" &&
        (issue.labels as Array<{ name: string }> | undefined)?.some((l) => l.name === this.taskLabel);

      if (labeledNow || openedWithLabel) {
        const issueState = String(issue.state ?? "open");
        if (issueState === "closed") {
          flog(`[task #${issueNumber}] issues/${action}: ignoring — issue is closed (title: ${JSON.stringify(String(issue.title ?? ""))})`);
          return result(null);
        }

        const repoUrl = strProp(p.repository, "html_url") ?? "";
        const labels =
          (issue.labels as Array<{ name: string }> | undefined)?.map((l) => l.name) ?? [];
        const issueData: Wire.TaskIssue = {
          number: issueNumber,
          title: String(issue.title ?? ""),
          body: String(issue.body ?? ""),
          labels,
          repoUrl,
        };

        // Track as open and persist to DB.
        await taskManager.enqueueIssue(String(issueNumber), issueNumber, repo, issueData.title, issueData.body, issueData.labels)
          .catch((err: unknown) => flog(`ERROR Failed to persist task #${issueNumber}: ${fmtError(err)}`));

        this.startDepsLoad(issueNumber, issueData.body);
        await this.assignIdleWorkers();
        flog(`[task #${issueNumber}] enqueued via issues/${action}`);
        return { taskId: String(issueNumber), workerId: null };
      }
    }

    // ── Dependency graph updates ───────────────────────────────────────────

    const action = p.action as string | undefined;

    if (
      action === "unlabeled" &&
      (p.label as Record<string, unknown> | undefined)?.name === this.taskLabel
    ) {
      await taskManager.dequeueIssue(issueNumber)
        .catch((err: unknown) => flog(`ERROR Failed to dequeue task #${issueNumber}: ${fmtError(err)}`));
      flog(`[task #${issueNumber}] dequeued (label removed)`);
      await this.assignIdleWorkers();
      return result(task);
    }

    if (action === "closed") {
      await taskManager.closeIssue(issueNumber).catch((err: unknown) =>
        flog(`ERROR Failed to close issue #${issueNumber}: ${fmtError(err)}`)
      );
      await this.assignIdleWorkers();
      return result(task);
    }

    if (action === "reopened") {
      await taskManager.reopenIssue(issueNumber).catch((err: unknown) =>
        flog(`ERROR Failed to reopen issue #${issueNumber}: ${fmtError(err)}`)
      );
      await this.assignIdleWorkers();
      return result(task);
    }

    if (action === "edited") {
      const changes = p.changes as Record<string, unknown> | undefined;
      if (changes?.body) {
        const trackedTask = await Task.getByIssue(issueNumber);
        if (trackedTask) {
          const newBody = String(issue.body ?? "");
          taskManager.resetBlockers(issueNumber);
          this.startDepsLoad(issueNumber, newBody);
        }
      }
    }

    if (!task) return result(null);
    this.forwardEvent(task, evt, `#${issueNumber}`);
    return result(task);
  }

  // ── Core event routing ────────────────────────────────────────────────────

  async routeEvent(name: string, p: Record<string, unknown>, evt: WebhookEvent): Promise<RouteResult> {
    if (name === "pull_request") {
      return this.routePrEvent(p, evt);
    }

    if (name === "pull_request_review" || name === "pull_request_review_comment") {
      return this.routePrReviewEvent(p, evt);
    }

    if (name === "check_run" || name === "check_suite") {
      return this.routeCheckEvent(p, evt, name);
    }

    const issue = p.issue as Record<string, unknown> | undefined;
    const issueNumber = numProp(issue, "number");
    if (issueNumber === null) return { taskId: null, workerId: null };

    return this.routeIssueEvent(p, evt, issue!, issueNumber);
  }
}
