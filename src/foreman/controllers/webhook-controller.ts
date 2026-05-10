import { WebhookEvent } from "../models/webhook-event.js";
import { Repo } from "../models/repo.js";
import { Task } from "../models/task.js";
import { Worker } from "../models/worker.js";
import { InstallationsController } from "./installations-controller.js";
import { WorkerMessenger } from "./worker-messenger.js";
import { fmtError, log } from "../../utils.js";
import { shortWorkerId } from "../../../shared/utils.js";
import type { BrunelConfig } from "../../config.js";

type R = Record<string, unknown>;

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

/**
 * The task and human-readable ref returned by per-event-type routing functions.
 * `forward` controls whether the event should be forwarded to the worker
 * (defaults to true when task is non-null). Set to false to log the task_id
 * without notifying the worker (e.g. pull_request/synchronize).
 */
export interface RouteResult { task: Task | null; ref: string; forward?: boolean; }

type WebhookControllerOptions = {
  config: Pick<BrunelConfig, "taskLabel">;
  messenger: WorkerMessenger;
  assignWork: () => Promise<void>;
};

export class WebhookController {
  private readonly config: Pick<BrunelConfig, "taskLabel">;
  private readonly messenger: WorkerMessenger;
  private readonly assignWork: () => Promise<void>;
  private readonly installationsController = new InstallationsController();

  constructor({ config, messenger, assignWork }: WebhookControllerOptions) {
    this.config = config;
    this.messenger = messenger;
    this.assignWork = assignWork;
  }

  async handleEvent(id: string, name: string, payload: unknown): Promise<void> {
    const p = payload as R;
    const evt = WebhookEvent.fromIncoming(id, name, p);
    if (!evt.isMuted()) log(evt.summary());

    // Find or create a Repo record for every webhook that carries a repository.
    // Routing always proceeds regardless of repo status — events must still be
    // forwarded to any worker that has a task assigned from this repo.
    const repoFullName = strProp(p.repository, "full_name");
    let repoId: number | null = null;
    if (repoFullName) {
      repoId = (await Repo.findOrCreate(repoFullName)).id;
    }

    // Step 1: determine task (side effects, DB lookups) — no forwarding yet.
    // Convention: foo_bar event → routeFooBarEvent method.
    let task: Task | null = null;
    let ref = "";
    let forward = true;

    const handlerName = "route" + name.split("_").map((s: string) => s.charAt(0).toUpperCase() + s.slice(1)).join("") + "Event";
    const handler = (this as Record<string, unknown>)[handlerName];
    if (typeof handler === "function") {
      const result = await (handler as (p: R, evt: WebhookEvent) => Promise<RouteResult | void>).call(this, p, evt);
      if (result) ({ task, ref, forward = true } = result);
    }

    const taskId = task?.taskId ?? null;
    const workerId = task?.workerId ?? null;
    const action = typeof p.action === "string" ? p.action : null;
    const webhookIssueNumber = typeof (p.issue as R | undefined)?.number === "number" ? (p.issue as R).number as number : null;
    const webhookPrNumber = typeof (p.pull_request as R | undefined)?.number === "number" ? (p.pull_request as R).number as number : null;

    // Step 2: log to DB and obtain the durable sequence id.
    const seqId = await WebhookEvent.log({
      deliveryId: id,
      eventName: name,
      action,
      repoId,
      sender: typeof (p.sender as R | undefined)?.login === "string" ? (p.sender as R).login as string : null,
      issueNumber: webhookIssueNumber,
      prNumber: webhookPrNumber,
      branch: null,
      taskId,
      workerId,
      payload: p,
    });

    // Step 3: forward to the worker with the sequence id (unless explicitly suppressed).
    if (task && forward) this.forwardEvent(task, evt, ref, seqId ?? undefined);

    this.messenger.broadcastLogEvent({
      kind: "webhook",
      timestamp: new Date().toISOString(),
      taskId,
      workerId,
      repo: repoFullName ?? undefined,
      summary: evt.format(),
    });
  }

  forwardEvent(task: Task, evt: WebhookEvent, ref: string, seqId?: number): void {
    if (task.workerId) {
      const worker = Worker.fromRegistry(task.workerId);
      if (worker && worker.currentTask?.taskId !== task.taskId) {
        log(`[task ${ref}] ${evt.eventName} dropped — worker ${shortWorkerId(task.workerId)} is now on a different task`);
        return;
      }
      if (worker && worker.status !== "disconnected") {
        const sent = this.messenger.send(
          worker,
          { type: "event_notification", taskId: task.taskId, event: evt.toWorkerPayload(), ...(seqId !== undefined && { seqId }) },
        );
        if (sent) {
          log(`[worker ${shortWorkerId(task.workerId)}] → event_notification ${ref} ${evt.eventName}`);
        }
        // send failure: event is already in DB; worker will replay from lastSeenEventSeqId on reconnect
      }
      // worker disconnected or not in registry: event is in DB; worker replays on reconnect
    }
  }

  // ── Installation events ────────────────────────────────────────────────────

  async routeInstallationEvent(p: R, _evt: WebhookEvent): Promise<void> {
    const action = strProp(p, "action");
    try {
      if (action === "created") await this.installationsController.handleInstallationCreated(p);
      else if (action === "deleted") await this.installationsController.handleInstallationDeleted(p);
    } catch (err) {
      log(`ERROR handling installation/${action}: ${fmtError(err)}`);
    }
  }

  async routeInstallationRepositoriesEvent(p: R, _evt: WebhookEvent): Promise<void> {
    const action = strProp(p, "action");
    try {
      if (action === "added") await this.installationsController.handleReposAdded(p);
      else if (action === "removed") await this.installationsController.handleReposRemoved(p);
    } catch (err) {
      log(`ERROR handling installation_repositories/${action}: ${fmtError(err)}`);
    }
  }

  // ── Pull request events ────────────────────────────────────────────────────

  async routePullRequestEvent(p: R, _evt: WebhookEvent): Promise<RouteResult> {
    const pr = p.pull_request as R | undefined;
    const prNumber = numProp(pr, "number");
    if (prNumber === null) return { task: null, ref: "" };

    const repo = await this._resolveRepo(p);
    const manager = repo.taskManager;
    const ref = `PR #${prNumber}`;

    if (p.action === "synchronize") return { task: await repo.getTaskByPr(prNumber), ref, forward: false };

    if (p.action === "opened" && pr) {
      return { task: await manager.handlePrOpenedEvent(prNumber, String(pr.body ?? ""), strProp(pr.head, "ref")), ref };
    }

    if (p.action === "closed" && pr) {
      return { task: await manager.handlePrClosedEvent(prNumber, !!pr.merged), ref };
    }

    if (p.action === "edited" && pr) {
      const changes = p.changes as R | undefined;
      let task: Task | null = null;
      if (changes?.body) {
        task = await manager.handlePrEditedEvent(prNumber, String(pr.body ?? ""), strProp(pr.head, "ref"));
      }
      if (!task) task = await repo.getTaskByPr(prNumber);
      return { task, ref };
    }

    return { task: await repo.getTaskByPr(prNumber), ref };
  }

  async routePullRequestReviewEvent(p: R, _evt: WebhookEvent): Promise<RouteResult> {
    const pr = p.pull_request as R | undefined;
    const prNumber = numProp(pr, "number");
    if (prNumber === null) return { task: null, ref: "" };
    const repo = await this._resolveRepo(p);
    return { task: await repo.getTaskByPr(prNumber), ref: `PR #${prNumber}` };
  }

  async routePullRequestReviewCommentEvent(p: R, evt: WebhookEvent): Promise<RouteResult> {
    return this.routePullRequestReviewEvent(p, evt);
  }

  // ── Check events ───────────────────────────────────────────────────────────

  async routeCheckRunEvent(p: R, _evt: WebhookEvent): Promise<RouteResult> {
    const inner = p.check_run as R | undefined;
    const prs = inner?.pull_requests as Array<{ number: number }> | undefined;
    const headBranch = strProp(inner?.check_suite, "head_branch") ?? "";
    const repo = await this._resolveRepo(p);
    const found = await repo.taskManager.getTaskForCheckEvent(
      prs?.map((pr) => pr.number) ?? [],
      headBranch,
    );
    if (found) return { task: found.task, ref: found.ref };
    return { task: null, ref: "" };
  }

  async routeCheckSuiteEvent(p: R, _evt: WebhookEvent): Promise<RouteResult> {
    const inner = p.check_suite as R | undefined;
    const prs = inner?.pull_requests as Array<{ number: number }> | undefined;
    const headBranch = strProp(inner, "head_branch") ?? "";
    const repo = await this._resolveRepo(p);
    const found = await repo.taskManager.getTaskForCheckEvent(
      prs?.map((pr) => pr.number) ?? [],
      headBranch,
    );
    if (found) return { task: found.task, ref: found.ref };
    return { task: null, ref: "" };
  }

  // ── Issue events ───────────────────────────────────────────────────────────

  async routeIssuesEvent(p: R, evt: WebhookEvent): Promise<RouteResult> {
    const issue = p.issue as R | undefined;
    const issueNumber = numProp(issue, "number");
    if (issueNumber === null) return { task: null, ref: "" };
    return { task: await this.applyIssueEffects(p, issue!, issueNumber), ref: `#${issueNumber}` };
  }

  async routeIssueCommentEvent(p: R, evt: WebhookEvent): Promise<RouteResult> {
    return this.routeIssuesEvent(p, evt);
  }

  /**
   * Phase 1: apply foreman-side effects for an issue event.
   * Returns the task to forward to the worker, or null to skip notification.
   * Returning null is an explicit signal: newly-enqueued tasks have no worker yet,
   * unlabeled doesn't need worker notification, and errors skip forwarding to avoid
   * notifying the worker of state the foreman failed to record.
   */
  private async applyIssueEffects(p: R, issue: R, issueNumber: number): Promise<Task | null> {
    const repo = await this._resolveRepo(p);
    const manager = repo.taskManager;

    let task = await repo.getTaskByIssue(issueNumber);
    // GitHub issue_comment events on PRs have the PR number in issue.number.
    if (!task) task = await repo.getTaskByPr(issueNumber);

    const action = p.action as string | undefined;

    if (!task) {
      // Check if this webhook should enqueue a new task.
      const labeledNow =
        action === "labeled" &&
        (p.label as R | undefined)?.name === this.config.taskLabel;
      const openedWithLabel =
        action === "opened" &&
        (issue.labels as Array<{ name: string }> | undefined)?.some((l) => l.name === this.config.taskLabel);

      if (labeledNow || openedWithLabel) {
        const labels = (issue.labels as Array<{ name: string }> | undefined)?.map((l) => l.name) ?? [];
        const enqueued = await manager.handleIssueLabeledEvent(
          issueNumber,
          String(issue.title ?? ""),
          String(issue.body ?? ""),
          labels,
          String(issue.state ?? "open"),
        ).catch((err: unknown) => {
          log(`ERROR Failed to persist task #${issueNumber}: ${fmtError(err)}`);
          return null;
        });
        if (!enqueued) return null;
        log(`[task #${issueNumber}] enqueued via issues/${action}`);
        return enqueued; // worker ignores labeled events; returned so task_id is logged in webhook_events
      }
      // No task found and not an enqueue event — still fall through so closed/reopened
      // can update blocker state (issue may be a dependency, not a task itself).
    }

    if (
      action === "unlabeled" &&
      (p.label as R | undefined)?.name === this.config.taskLabel
    ) {
      try {
        await manager.dequeueIssue(issueNumber);
        log(`[task #${issueNumber}] dequeued (label removed)`);
      } catch (err) {
        log(`ERROR Failed to dequeue task #${issueNumber}: ${fmtError(err)}`);
        return null; // error: skip notification
      }
      await this.assignWork();
      return null; // worker doesn't need to know the label was removed
    }

    if (action === "closed") {
      try {
        await manager.closeIssue(issueNumber);
      } catch (err) {
        log(`ERROR Failed to close issue #${issueNumber}: ${fmtError(err)}`);
        return null; // error: skip notification to avoid inconsistency
      }
      await this.assignWork();
    }

    if (action === "reopened") {
      try {
        await manager.reopenIssue(issueNumber);
      } catch (err) {
        log(`ERROR Failed to reopen issue #${issueNumber}: ${fmtError(err)}`);
        return null; // error: skip notification to avoid inconsistency
      }
      await this.assignWork();
    }

    if (action === "edited") {
      const changes = p.changes as R | undefined;
      if (task && (changes?.body || changes?.title)) {
        const newTitle = String(issue.title ?? task.title);
        const newBody = String(issue.body ?? task.body);
        const labels = (issue.labels as Array<{ name: string }> | undefined)?.map((l) => l.name) ?? task.labels;
        try {
          await task.updateContent(newTitle, newBody, labels);
        } catch (err) {
          log(`ERROR Failed to update content for task #${issueNumber}: ${fmtError(err)}`);
          return null;
        }
      }
      if (changes?.body && task) {
        manager.handleIssueBodyEditedEvent(
          issueNumber,
          String(issue.body ?? task.body),
        );
      }
    }

    return task; // null if no task (e.g., dependency issue — nothing to forward)
  }

  /** Resolve the Repo from a webhook payload's repository.full_name, creating it if needed. */
  private async _resolveRepo(p: R): Promise<Repo> {
    const repoFullName = strProp(p.repository, "full_name");
    if (!repoFullName) throw new Error("Webhook payload missing repository.full_name");
    return Repo.findOrCreate(repoFullName);
  }
}
