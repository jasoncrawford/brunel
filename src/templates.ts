import type { GitHubEvent, TaskIssue } from "./types.js";

export function buildInitialPrompt(issue: TaskIssue): string {
  return `Please work on GitHub issue #${issue.number}: "${issue.title}" in ${issue.repoUrl}.

Issue description:
${issue.body || "(no description)"}

Labels: ${issue.labels.join(", ") || "(none)"}

You should ask for any clarifications you need about requirements or product spec, but you should decide on the technical implementation on your own.

Remember key practices:

1. Use proper branch discipline: pull main first, then create a branch and a worktree.
2. As much as possible, use test-driven development.
3. Create a PR when done, and include the text "Closes #${issue.number}".

Do not work on any other issues: leave task assignment to the foreman. Do not merge any PRs or set them to auto-merge: leave merging to the user after UAT.`;
}

export function buildEventPrompt(events: GitHubEvent[]): string {
  if (events.length !== 1) {
    return resolveEventTemplate(EVENT_FMT, "_multiple", { id: "", name: "_multiple", payload: { events } });
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
  _multiple: (p) =>
    `Multiple events have arrived since you last checked: ${(p.events as GitHubEvent[]).map((e) => e.name).join(', ')}. Please review the current state of your PR and respond accordingly.`,

  check_run: (p) =>
    (p.check_run?.conclusion === "failure" || p.check_run?.conclusion === "action_required")
      ? `CI check "${p.check_run?.name}" failed (${p.check_run?.conclusion}).\n\n${p.check_run?.output?.summary ?? ""}`.trim()
      : `CI check "${p.check_run?.name}" completed with conclusion: ${p.check_run?.conclusion}. Check to see if the PR can be merged. If anything is blocking merge, resolve it, but do not merge yourself.`,

  check_suite: (p) =>
    (p.check_suite?.conclusion === "failure" || p.check_suite?.conclusion === "action_required")
      ? `CI suite failed (${p.check_suite?.conclusion}). Please review the failing checks on your PR and fix any issues.`
      : `CI suite completed with conclusion: ${p.check_suite?.conclusion}. Check to see if the PR can be merged. If anything is blocking merge, resolve it, but do not merge yourself.`,

  pull_request_review: (p) =>
    `A review was submitted on PR #${p.pull_request?.number}: state=${p.review?.state}.\n\n${p.review?.body ?? ""}\n\nPlease respond in whatever way you think is most appropriate, replying and/or making code changes.`.trim(),

  pull_request_review_comment: (p) =>
    `A review comment was added on PR #${p.pull_request?.number} at \`${p.comment?.path}\`:\n\n${p.comment?.body ?? ""}\n\nPlease respond in whatever way you think is most appropriate, replying and/or making code changes.`.trim(),

  issue_comment: (p) =>
    `A comment was added on issue #${p.issue?.number}:\n\n${p.comment?.body ?? ""}`.trim(),

  _default: (_p, event) =>
    `GitHub event "${event.name}" received. Please review the current state of your work and respond accordingly.`,
};
