// ── Event formatting helpers (foreman-side copy of display.ts formatting) ────
// These live here so the foreman module has zero imports from display.ts,
// which is a TUI module that belongs to the agent/worker side.

interface CheckRun { name: string; conclusion: string | null; status: string }
interface CheckSuite { conclusion: string | null; status: string }
interface Comment { body: string }
interface Review { state: string; body: string }
interface PullRequest { number: number; title: string }
interface WorkflowRun { name: string; conclusion: string | null; status: string }

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string { return typeof v === "string" ? v : ""; }
function num(v: unknown): number { return typeof v === "number" ? v : 0; }

function trunc(s: string, n = 80) {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function fmtEventDetails(event: { name: string; payload: Record<string, unknown> }): string {
  const p = event.payload;
  switch (event.name) {
    case "check_run": {
      const run = asObj(p.check_run) as CheckRun | null;
      if (!run) return "";
      const status = str(run.conclusion || run.status);
      return `"${str(run.name)}" ${status}`.trim();
    }
    case "check_suite": {
      const suite = asObj(p.check_suite) as CheckSuite | null;
      if (!suite) return "";
      return str(suite.conclusion || suite.status).trim();
    }
    case "issue_comment":
    case "pull_request_review_comment": {
      const comment = asObj(p.comment) as Comment | null;
      return comment?.body ? `"${trunc(str(comment.body), 60)}"` : "";
    }
    case "pull_request_review": {
      const review = asObj(p.review) as Review | null;
      if (!review) return "";
      const parts: string[] = [str(review.state)];
      if (review.body) parts.push(`"${trunc(str(review.body), 40)}"`);
      return parts.filter(Boolean).join(" ");
    }
    case "pull_request": {
      const pr = asObj(p.pull_request) as PullRequest | null;
      if (!pr) return "";
      return `#${num(pr.number)} "${trunc(str(pr.title), 50)}"`;
    }
    case "push": {
      const commits = Array.isArray(p.commits) ? p.commits : [];
      return `${commits.length} commit${commits.length === 1 ? "" : "s"} to ${str(p.ref) || "?"}`;
    }
    case "workflow_run": {
      const run = asObj(p.workflow_run) as WorkflowRun | null;
      if (!run) return "";
      const status = str(run.conclusion || run.status);
      return `"${str(run.name)}" ${status}`.trim();
    }
    case "delete": {
      const refType = str(p.ref_type);
      const ref = str(p.ref);
      return `${refType} ${ref}`.trim();
    }
    case "issues": {
      const label = asObj(p.label) as { name?: string } | null;
      return label?.name ? `label: ${label.name}` : "";
    }
    default:
      return "";
  }
}

export function fmtEvent(event: { name: string; payload: Record<string, unknown> }): string {
  const nameAction = `${event.name}${event.payload["action"] ? `/${event.payload["action"]}` : ""}`;
  const details = fmtEventDetails(event);
  return `${nameAction}${details ? ` — ${details}` : ""}`;
}

