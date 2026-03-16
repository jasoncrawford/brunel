import type { GitHubEvent, TaskIssue } from "./types.js";

export function buildInitialPrompt(issue: TaskIssue): string {
  return `You have been assigned GitHub issue #${issue.number}: "${issue.title}" in ${issue.repoUrl}.

Issue description:
${issue.body || "(no description)"}

Labels: ${issue.labels.join(", ") || "(none)"}

Please implement this issue. Start by understanding the requirements, then create a feature branch, implement the changes with tests, and open a pull request. Follow the project conventions in CLAUDE.md.`;
}

export function buildEventPrompt(events: GitHubEvent[]): string {
  if (events.length !== 1) {
    return "Multiple events have arrived since you last checked. Please review the current state of your PR and respond accordingly.";
  }
  return resolveEventTemplate(EVENT_FMT, events[0].name, events[0]);
}

// ── Event formatter table ─────────────────────────────────────────────────────

export type EventTemplateFmt = (event: GitHubEvent) => string;
export type EventTemplateFmtTable = Record<string, EventTemplateFmt>;

export function resolveEventTemplate(table: EventTemplateFmtTable, key: string, event: GitHubEvent): string {
  const fmt = table[key] ?? table._default;
  if (!fmt) return `GitHub event "${key}" received. Please review the current state of your work and respond accordingly.`;
  return fmt(event);
}

export const EVENT_FMT: EventTemplateFmtTable = {
  check_run: (event) => {
    const p = event.payload as Record<string, unknown>;
    const run = p.check_run as Record<string, unknown>;
    const conclusion = run?.conclusion ?? "unknown";
    const output = run?.output as Record<string, unknown> | undefined;
    if (conclusion === "failure" || conclusion === "action_required") {
      return `CI check "${run?.name}" failed (${conclusion}).\n\n${output?.summary ?? ""}`.trim();
    }
    return `CI check "${run?.name}" completed with conclusion: ${conclusion}.`;
  },

  check_suite: (event) => {
    const p = event.payload as Record<string, unknown>;
    const suite = p.check_suite as Record<string, unknown>;
    const conclusion = suite?.conclusion ?? "unknown";
    if (conclusion === "failure" || conclusion === "action_required") {
      return `CI suite failed (${conclusion}). Please review the failing checks on your PR and fix any issues.`;
    }
    return `CI suite completed with conclusion: ${conclusion}.`;
  },

  pull_request_review: (event) => {
    const p = event.payload as Record<string, unknown>;
    const review = p.review as Record<string, unknown>;
    const pr = p.pull_request as Record<string, unknown>;
    return `A review was submitted on PR #${pr?.number}: state=${review?.state}.\n\n${review?.body ?? ""}`.trim();
  },

  pull_request_review_comment: (event) => {
    const p = event.payload as Record<string, unknown>;
    const comment = p.comment as Record<string, unknown>;
    const pr = p.pull_request as Record<string, unknown>;
    return `A review comment was added on PR #${pr?.number} at \`${comment?.path}\`:\n\n${comment?.body ?? ""}`.trim();
  },

  issue_comment: (event) => {
    const p = event.payload as Record<string, unknown>;
    const comment = p.comment as Record<string, unknown>;
    const issue = p.issue as Record<string, unknown>;
    return `A comment was added on issue #${issue?.number}:\n\n${comment?.body ?? ""}`.trim();
  },

  _default: (event) => `GitHub event "${event.name}" received. Please review the current state of your work and respond accordingly.`,
};
