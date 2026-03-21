import type { GitHubEvent, TaskIssue } from "./types.js";

export function formatCommentLocation(
  path: unknown,
  line?: unknown,
  startLine?: unknown
): string {
  const pathStr = `\`${path}\``;
  if (line == null) return pathStr;
  if (startLine != null && startLine !== line) return `${pathStr} lines ${startLine}-${line}`;
  return `${pathStr} line ${line}`;
}

export function buildInitialPrompt(issue: TaskIssue): string {
  return `Please work on GitHub issue #${issue.number}: "${issue.title}" in ${issue.repoUrl}.

Issue description:
${issue.body || "(no description)"}

Labels: ${issue.labels.join(", ") || "(none)"}

You should ask for any clarifications you need about requirements or product spec, but you should decide on the technical implementation on your own. If the technical design is complex enough to need review, use a subagent instead of asking the user.

Remember key practices:

1. Use proper branch discipline. Pull main to get the latest, then create a new branch.
2. Use the EnterWorktree tool to create an isolated worktree for this task. Make no changes in the main workspace, only in the worktree.
3. As much as possible, use test-driven development.
4. Create a PR when done, and include the text "Closes #${issue.number}".

Do not work on any other issues: leave task assignment to the foreman. Do not merge any PRs or set them to auto-merge: leave merging to the user after UAT.`;
}

export function buildEventPrompt(events: GitHubEvent[]): string {
  const coalesced = coalesceEvents(events);
  const sorted = sortEvents(coalesced);

  const parts = sorted
    .map(e => resolveEventTemplate(EVENT_FMT, e.name, e))
    .filter(Boolean);

  if (parts.length === 0) return "";

  const body = parts.join("\n\n---\n\n");

  if (coalesced.length > 1) {
    return `Multiple events have happened:\n\n${body}`;
  }

  return body;
}

export function coalesceEvents(events: GitHubEvent[]): GitHubEvent[] {
  const result: GitHubEvent[] = [];

  // Separate check_suite events
  const checkSuites = events.filter(e => e.name === "check_suite");
  const nonCheckSuites = events.filter(e => e.name !== "check_suite");

  // Coalesce check_suite events into _check_suites
  if (checkSuites.length > 0) {
    const failed: string[] = [];
    const succeeded: string[] = [];
    for (const e of checkSuites) {
      const cs = e.payload.check_suite as Record<string, unknown> | undefined;
      const csName =
        (cs?.name as string | undefined) ??
        ((cs?.app as Record<string, unknown> | undefined)?.name as string | undefined) ??
        "unknown";
      const conclusion = cs?.conclusion as string | undefined;
      if (conclusion === "failure" || conclusion === "action_required") {
        failed.push(csName);
      } else {
        succeeded.push(csName);
      }
    }
    result.push({
      id: checkSuites[0].id,
      name: "_check_suites",
      payload: {
        status: failed.length > 0 ? "failed" : "succeeded",
        failed,
        succeeded,
      },
    });
  }

  // Separate pull_request_review and pull_request_review_comment
  const reviews = nonCheckSuites.filter(e => e.name === "pull_request_review");
  const reviewComments = nonCheckSuites.filter(e => e.name === "pull_request_review_comment");
  const rest = nonCheckSuites.filter(
    e => e.name !== "pull_request_review" && e.name !== "pull_request_review_comment"
  );

  // Coalesce review + review comments into _code_review
  if (reviews.length > 0 || reviewComments.length > 0) {
    const primary = reviews[0] ?? reviewComments[0];
    const comments = reviewComments.map(e => {
      const comment = e.payload.comment as Record<string, unknown> | undefined;
      return {
        path: comment?.path,
        body: comment?.body,
        line: comment?.line,
        startLine: comment?.start_line,
      };
    });
    result.push({
      id: primary.id,
      name: "_code_review",
      payload: {
        pull_request: primary.payload.pull_request ?? reviewComments[0]?.payload.pull_request,
        review: reviews[0]?.payload.review ?? { state: "", body: "" },
        comments,
      },
    });
  }

  result.push(...rest);

  return result;
}

const SORT_PRIORITY: Record<string, number> = {
  issue_comment: 1,
  _code_review: 2,
  pull_request_review: 2,
  pull_request_review_comment: 2,
  _check_suites: 3,
  check_suite: 3,
  pull_request: 5,
};

function sortEvents(events: GitHubEvent[]): GitHubEvent[] {
  return [...events].sort((a, b) => {
    const pa = SORT_PRIORITY[a.name] ?? 4;
    const pb = SORT_PRIORITY[b.name] ?? 4;
    return pa - pb;
  });
}

export function fmtEventList(events: GitHubEvent[]): string {
  return events.map(e => {
    const action = e.payload["action"] as string | undefined;
    return action ? `${e.name}/${action}` : e.name;
  }).join(", ");
}

// ── Event formatter table ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EventTemplateFmt = (payload: any, event: GitHubEvent) => string;
export type EventTemplateFmtTable = Record<string, EventTemplateFmt>;

export function resolveEventTemplate(table: EventTemplateFmtTable, key: string, event: GitHubEvent): string {
  const fmt = table[key] ?? table._default;
  if (!fmt) return "";
  return fmt(event.payload, event);
}

export const EVENT_FMT: EventTemplateFmtTable = {
  _check_suites: (p) => {
    const failed = p.failed as string[];
    if (p.status === "failed") {
      return `Checks have failed: ${failed.join(", ")}. Please review the failing checks on your PR and fix any issues.`;
    }
    const succeeded = p.succeeded as string[];
    return `Checks succeeded: ${succeeded.join(", ")}. Check whether all tests have passed. If not, take no action now; wait for the remaining ones. If all tests passed, check if the branch is up to date, and if not, rebase it. Then check if the PR can be merged. If anything is blocking merge, resolve it, but do not merge yourself.`;
  },

  _code_review: (p) => {
    const pr = p.pull_request as Record<string, unknown> | undefined;
    const review = p.review as Record<string, unknown> | undefined;
    const comments = p.comments as Array<{ path: unknown; body: unknown; line?: unknown; startLine?: unknown }> | undefined;
    const lines: string[] = [
      `A review was submitted on PR #${pr?.number}: state=${review?.state}.`,
    ];
    if (review?.body) {
      lines.push(`\n${review.body}`);
    }
    if (comments && comments.length > 0) {
      lines.push("\nInline comments:");
      for (const c of comments) {
        lines.push(`\n- ${formatCommentLocation(c.path, c.line, c.startLine)}: ${c.body}`);
      }
    }
    lines.push("\n\nPlease respond in whatever way you think is most appropriate, replying and/or making code changes.");
    return lines.join("").trim();
  },

  check_suite: (p) =>
    (p.check_suite?.conclusion === "failure" || p.check_suite?.conclusion === "action_required")
      ? `CI suite failed (${p.check_suite?.conclusion}). Please review the failing checks on your PR and fix any issues.`
      : `CI suite completed with conclusion: ${p.check_suite?.conclusion}. Check whether all tests have passed. If not, take no action now; wait for the remaining ones. If all tests passed, check if the branch is up to date, and if not, rebase it. Then check if the PR can be merged. If anything is blocking merge, resolve it, but do not merge yourself.`,

  pull_request: (p) => {
    const pr = p.pull_request as Record<string, unknown> | undefined;
    const prNumber = pr?.number;
    if (p.action === "closed") {
      return `PR #${prNumber} was ${pr?.merged ? 'merged' : 'closed without merging'}. Before we end this session:

* Are there any followup issues we should file?
* Are there any updates to skills that we should make, or new skills to record?
* Are there any updates to be made to project documentation?
* Clean up your worktree by calling ExitWorktree with action: "remove".

Please do the above if necessary. Then summarize what you did, and anything else the user should know.`;
    }
    return "";
  },

  pull_request_review: (p) =>
    `A review was submitted on PR #${p.pull_request?.number}: state=${p.review?.state}.\n\n${p.review?.body ?? ""}\n\nPlease respond in whatever way you think is most appropriate, replying and/or making code changes.`.trim(),

  pull_request_review_comment: (p) =>
    `A review comment was added on PR #${p.pull_request?.number} at \`${p.comment?.path}\`:\n\n${p.comment?.body ?? ""}\n\nPlease respond in whatever way you think is most appropriate, replying and/or making code changes.`.trim(),

  issue_comment: (p) =>
    `A comment was added on issue #${p.issue?.number}:\n\n${p.comment?.body ?? ""}`.trim(),
};
