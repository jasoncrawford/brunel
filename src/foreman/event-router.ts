import type { GitHubEvent, ForemanMessage, TaskIssue } from "../types.js";
import type { DependencyGraph } from "./dependencies.js";
import { setBlockers, fetchBlockers } from "./dependencies.js";
import { fetchIssueStates } from "./github.js";
import type { TaskModel, Task } from "./task-model.js";
import type { WorkerRegistry } from "./worker-registry.js";
import { shortWorkerId } from "../../shared/utils.js";
import { fmtError } from "../utils.js";

// ── Dependencies interface ──────────────────────────────────────────────────

export interface EventRouterDeps {
  taskModel: TaskModel;
  registry: WorkerRegistry;
  graph: DependencyGraph;
  repo: string;
  token: string;
  githubApiUrl?: string;
  taskLabel: string;
  sendMsg(workerId: string, msg: ForemanMessage, logTaskId?: string): void;
  flog(msg: string): void;
  assignIdleWorkers(): Promise<void>;
}

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

// ── Event forwarding ─────────────────────────────────────────────────────────

export function forwardEvent(deps: EventRouterDeps, task: Task, evt: GitHubEvent, ref: string): void {
  if (task.status === "assigned" && task.assignedWorkerId) {
    const worker = deps.registry.get(task.assignedWorkerId);
    if (worker?.status === "disconnected") {
      deps.taskModel.queueEvent(task.taskId, evt);
      deps.flog(`[task ${ref}] ${evt.name} queued (worker ${shortWorkerId(task.assignedWorkerId)} disconnected)`);
    } else if (worker) {
      const evtMsg: ForemanMessage = { type: "event_notification", taskId: task.taskId, event: evt };
      deps.sendMsg(task.assignedWorkerId, evtMsg);
      deps.flog(`[worker ${shortWorkerId(task.assignedWorkerId)}] → event_notification ${ref} ${evt.name}`);
    } else {
      deps.flog(`[task ${ref}] ${evt.name} DROPPED — worker ${shortWorkerId(task.assignedWorkerId)} not in registry (disconnected?)`);
    }
  } else if (task.status === "pending" || task.status === "blocked") {
    deps.taskModel.queueEvent(task.taskId, evt);
    deps.flog(`[task ${ref}] ${evt.name} queued (no worker assigned)`);
  }
}

// ── Dependency loading ─────────────────────────────────────────────────────

export function startDepsLoad(deps: EventRouterDeps, issueNumber: number, body: string): void {
  fetchBlockers(issueNumber, body, { repo: deps.repo, token: deps.token, apiUrl: deps.githubApiUrl })
    .then(async (blockers) => {
      setBlockers(issueNumber, blockers, deps.graph);
      if (blockers.length > 0) {
        const states = await fetchIssueStates(blockers, { repo: deps.repo, token: deps.token });
        for (const [num, state] of states) {
          deps.taskModel.setIssueOpenState(num, state === "open");
        }
      }
      deps.taskModel.markIssueDepsLoaded(issueNumber);
      await reconcile(deps);
    })
    .catch((err) => deps.flog(`ERROR fetching deps for #${issueNumber}: ${fmtError(err)}`));
}

// ── Reconciliation ──────────────────────────────────────────────────────────

export async function reconcile(deps: EventRouterDeps): Promise<void> {
  const labeledIssues = deps.taskModel.getLabeledIssues();

  // Step 1: materialise tasks for new labeledIssues entries.
  const registerPromises: Promise<void>[] = [];
  for (const [num, { issue }] of labeledIssues) {
    if (!(await deps.taskModel.getTaskForIssue(num))) {
      deps.flog(`[task #${num}] reconcile: creating task (title: ${JSON.stringify(issue.title)})`);
      registerPromises.push(
        deps.taskModel.register(String(num), num, deps.repo, issue.title, issue.body, issue.labels)
          .catch((err: unknown) => deps.flog(`ERROR Failed to persist task #${num}: ${fmtError(err)}`))
      );
    }
  }

  // Step 2: sync title/body/labels from labeledIssues to existing tasks.
  const refreshPromises: Promise<void>[] = [];
  for (const [num, { issue }] of labeledIssues) {
    const t = await deps.taskModel.getTaskForIssue(num);
    if (t) {
      refreshPromises.push(
        deps.taskModel.refreshContent(t.taskId, issue.title, issue.body, issue.labels)
          .catch((err: unknown) => deps.flog(`ERROR Failed to refresh content for task #${t.taskId}: ${fmtError(err)}`))
      );
    }
  }

  // Step 3: remove pending/blocked tasks whose issue no longer has the label
  const cancelPromises: Promise<void>[] = [];
  for (const t of await deps.taskModel.getPendingAndBlockedTasks()) {
    if (!labeledIssues.has(t.issueNumber)) {
      cancelPromises.push(
        deps.taskModel.cancel(t.taskId)
          .catch((err: unknown) => deps.flog(`ERROR Failed to delete task #${t.taskId} from DB: ${fmtError(err)}`))
      );
    }
  }

  // Step 4: await all DB writes before assigning
  await Promise.all([...registerPromises, ...refreshPromises, ...cancelPromises]);

  // Step 5: try assignment for all idle workers
  await deps.assignIdleWorkers();
}

// ── Core event routing ──────────────────────────────────────────────────────

export interface RouteResult { taskId: string | null; workerId: string | null; }

export async function doRouteEvent(deps: EventRouterDeps, name: string, p: Record<string, unknown>, evt: GitHubEvent): Promise<RouteResult> {
  function result(task: { taskId: string; assignedWorkerId?: string } | null | undefined): RouteResult {
    return { taskId: task?.taskId ?? null, workerId: task?.assignedWorkerId ?? null };
  }

  const { taskModel, flog, repo } = deps;

  // ── PR events: route by PR number ────────────────────────────────────────

  if (name === "pull_request") {
    const pr = p.pull_request as Record<string, unknown> | undefined;
    const prNumber = numProp(pr, "number");
    if (prNumber === null) return result(null);

    // Drop synchronize events — the worker pushed these commits itself.
    if (p.action === "synchronize") return result(await taskModel.getTaskForPr(prNumber));

    // When a PR is opened, register it against a task if the body links an issue.
    if (p.action === "opened" && pr) {
      const linkedIssue = extractLinkedIssueNumber(String(pr.body ?? ""));
      if (linkedIssue !== null) {
        const linkedTask = await taskModel.getTaskForIssue(linkedIssue);
        if (linkedTask) {
          const branch = strProp(pr.head, "ref");
          if (branch) taskModel.registerBranch(branch, linkedTask.taskId);
          await taskModel.registerPr(linkedTask.taskId, prNumber, branch ?? null).catch((err: unknown) =>
            flog(`ERROR Failed to register PR for task #${linkedTask.taskId}: ${fmtError(err)}`)
          );
          flog(`[task #${linkedIssue}] PR #${prNumber} registered`);
        }
      }
    }

    // When a PR is closed without merging, clear it from the task.
    if (p.action === "closed" && pr && !pr.merged) {
      const task = await taskModel.getTaskForPr(prNumber);
      if (task) {
        flog(`[task #${task.issueNumber}] PR #${prNumber} unregistered (closed without merging)`);
        await taskModel.unregisterPr(prNumber).catch((err: unknown) =>
          flog(`ERROR Failed to unregister PR #${prNumber}: ${fmtError(err)}`)
        );
        forwardEvent(deps, task, evt, `PR #${prNumber}`);
        return result(task);
      }
      return result(null);
    }

    // When a PR is closed with merging, record that it was merged.
    if (p.action === "closed" && pr && pr.merged) {
      const task = await taskModel.getTaskForPr(prNumber);
      if (task) {
        flog(`[task #${task.issueNumber}] PR #${prNumber} merged`);
        await taskModel.registerPrMerge(prNumber).catch((err: unknown) =>
          flog(`ERROR Failed to record PR #${prNumber} merge: ${fmtError(err)}`)
        );
        forwardEvent(deps, task, evt, `PR #${prNumber}`);
        return result(task);
      }
      return result(null);
    }

    const task = await taskModel.getTaskForPr(prNumber);
    if (task) forwardEvent(deps, task, evt, `PR #${prNumber}`);
    return result(task);
  }

  if (name === "pull_request_review" || name === "pull_request_review_comment") {
    const pr = p.pull_request as Record<string, unknown> | undefined;
    const prNumber = numProp(pr, "number");
    if (prNumber === null) return result(null);
    const task = await taskModel.getTaskForPr(prNumber);
    if (task) forwardEvent(deps, task, evt, `PR #${prNumber}`);
    return result(task);
  }

  if (name === "check_run" || name === "check_suite") {
    const inner = (name === "check_run" ? p.check_run : p.check_suite) as Record<string, unknown> | undefined;
    const prs = inner?.pull_requests as Array<{ number: number }> | undefined;

    if (prs && prs.length > 0) {
      const task = await taskModel.getTaskForPr(prs[0].number);
      if (task) { forwardEvent(deps, task, evt, `PR #${prs[0].number}`); return result(task); }
    }

    const headBranch = name === "check_run"
      ? strProp(inner?.check_suite, "head_branch") ?? ""
      : strProp(inner, "head_branch") ?? "";
    if (headBranch) {
      const task = await taskModel.getTaskForBranch(headBranch);
      if (task) { forwardEvent(deps, task, evt, `branch ${headBranch}`); return result(task); }
    }
    return result(null);
  }

  // ── Issue events: route by issue number ──────────────────────────────────

  const issue = p.issue as Record<string, unknown> | undefined;
  const issueNumber = numProp(issue, "number");
  if (issueNumber === null) return result(null);

  let task = await taskModel.getTaskForIssue(issueNumber);

  // GitHub issue_comment events on PRs have the PR number in issue.number.
  if (!task) task = await taskModel.getTaskForPr(issueNumber);

  // If the issue isn't queued yet, check if this webhook should enqueue it.
  if (!task && name === "issues" && issue) {
    const action = p.action as string | undefined;
    const labeledNow =
      action === "labeled" &&
      (p.label as Record<string, unknown> | undefined)?.name === deps.taskLabel;
    const openedWithLabel =
      action === "opened" &&
      (issue.labels as Array<{ name: string }> | undefined)?.some((l) => l.name === deps.taskLabel);

    if (labeledNow || openedWithLabel) {
      const issueState = String(issue.state ?? "open");
      if (issueState === "closed") {
        flog(`[task #${issueNumber}] issues/${action}: ignoring — issue is closed (title: ${JSON.stringify(String(issue.title ?? ""))})`);
        return result(null);
      }

      const repoUrl = strProp(p.repository, "html_url") ?? "";
      const labels =
        (issue.labels as Array<{ name: string }> | undefined)?.map((l) => l.name) ?? [];
      const issueData: TaskIssue = {
        number: issueNumber,
        title: String(issue.title ?? ""),
        body: String(issue.body ?? ""),
        labels,
        repoUrl,
      };
      taskModel.trackIssue(issueNumber, issueData);
      startDepsLoad(deps, issueNumber, issueData.body);
      await reconcile(deps);
      flog(`[task #${issueNumber}] enqueued via ${name}/${action}`);
      return { taskId: String(issueNumber), workerId: null };
    }
  }

  // ── Dependency graph updates ───────────────────────────────────────────────

  if (name === "issues" && issue) {
    const action = p.action as string | undefined;

    if (
      action === "unlabeled" &&
      (p.label as Record<string, unknown> | undefined)?.name === deps.taskLabel
    ) {
      taskModel.untrackIssue(issueNumber);
      flog(`[task #${issueNumber}] dequeued (label removed)`);
      await reconcile(deps);
      return result(task);
    }

    if (action === "closed") {
      await taskModel.closeIssue(issueNumber).catch((err: unknown) =>
        flog(`ERROR Failed to close issue #${issueNumber}: ${fmtError(err)}`)
      );
      await reconcile(deps);
      return result(task);
    }

    if (action === "reopened") {
      await taskModel.reopenIssue(issueNumber).catch((err: unknown) =>
        flog(`ERROR Failed to reopen issue #${issueNumber}: ${fmtError(err)}`)
      );
      await reconcile(deps);
      return result(task);
    }

    if (action === "edited") {
      const changes = p.changes as Record<string, unknown> | undefined;
      if (changes?.body && taskModel.isTracked(issueNumber)) {
        const newBody = String(issue.body ?? "");
        taskModel.resetIssueDeps(issueNumber, newBody);
        startDepsLoad(deps, issueNumber, newBody);
      }
    }
  }

  if (!task) return result(null);
  forwardEvent(deps, task, evt, `#${issueNumber}`);
  return result(task);
}
