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
    return resolveEventTemplate(EVENT_FMT, "_multiple", { id: "", name: "_multiple", payload: { count: events.length } });
  }
  return resolveEventTemplate(EVENT_FMT, events[0].name, events[0]);
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
  _multiple: () =>
    "Multiple events have arrived since you last checked. Please review the current state of your PR and respond accordingly.",

  check_run: (p) =>
    (p.check_run?.conclusion === "failure" || p.check_run?.conclusion === "action_required")
      ? `CI check "${p.check_run?.name}" failed (${p.check_run?.conclusion}).\n\n${p.check_run?.output?.summary ?? ""}`.trim()
      : `CI check "${p.check_run?.name}" completed with conclusion: ${p.check_run?.conclusion}.`,

  check_suite: (p) =>
    (p.check_suite?.conclusion === "failure" || p.check_suite?.conclusion === "action_required")
      ? `CI suite failed (${p.check_suite?.conclusion}). Please review the failing checks on your PR and fix any issues.`
      : `CI suite completed with conclusion: ${p.check_suite?.conclusion}.`,

  pull_request_review: (p) =>
    `A review was submitted on PR #${p.pull_request?.number}: state=${p.review?.state}.\n\n${p.review?.body ?? ""}`.trim(),

  pull_request_review_comment: (p) =>
    `A review comment was added on PR #${p.pull_request?.number} at \`${p.comment?.path}\`:\n\n${p.comment?.body ?? ""}`.trim(),

  issue_comment: (p) =>
    `A comment was added on issue #${p.issue?.number}:\n\n${p.comment?.body ?? ""}`.trim(),

  _default: (_p, event) =>
    `GitHub event "${event.name}" received. Please review the current state of your work and respond accordingly.`,
};
