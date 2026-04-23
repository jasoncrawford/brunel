/**
 * Pure data-to-string formatting helpers shared between the foreman and the
 * agent/worker. No terminal, color, or screen-management concerns live here.
 */
import * as Wire from "./wire.js";

// ── String helpers ─────────────────────────────────────────────────────────

export function trunc(str: string, n = 80): string {
  str = str.replace(/\s+/g, " ").trim();
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

export function fmtCount(count: number, singular_noun: string, plural_noun?: string): string {
  const noun = (count === 1) ? singular_noun : (plural_noun ?? `${singular_noun}s`);
  return `${count} ${noun}`;
}

// ── Time / duration ────────────────────────────────────────────────────────

export function fmtTime(): string {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const sec = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${sec}`;
}

export function fmtDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m${s}s`;
}

export function fmtNum(n: number): string {
  if (n >= 1000) return `${parseFloat((n / 1000).toPrecision(3))}k`;
  return `${n}`;
}

export function fmtStats(
  secs: number,
  turns?: number,
  outputTokens?: number,
  inputTokens?: number,
  costUsd?: number,
): string {
  const parts: string[] = [fmtDuration(secs)];
  if (turns) parts.push(fmtCount(turns, "turn"));
  if (outputTokens) {
    const tok = inputTokens != null
      ? `tokens: ${fmtNum(inputTokens)} in / ${fmtNum(outputTokens)} out`
      : `tokens: ${fmtNum(outputTokens)} out`;
    parts.push(tok);
  }
  if (costUsd != null) {
    parts.push(`cost: $${costUsd.toFixed(2)}`);
  }
  return parts.join(", ");
}

// ── Path / args helpers ────────────────────────────────────────────────────

export function toRelativePath(filePath: string): string {
  const cwd = process.cwd();
  if (filePath === cwd) return ".";
  const prefix = cwd + "/";
  if (filePath.startsWith(prefix)) return filePath.slice(prefix.length);
  return filePath;
}

export function fmtArgs(input: Record<string, unknown>, maxVal = 50): string {
  return Object.entries(input ?? {})
    .map(([k, v]) => `${k}=${trunc(String(v), maxVal)}`)
    .join(", ");
}

// ── Webhook event formatting ───────────────────────────────────────────────

// Private helper types for fmtEventDetails
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

export function fmtEventDetails(event: Wire.WebhookEvent): string {
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

export function fmtEvent(event: Wire.WebhookEvent): string {
  const nameAction = `${event.name}${event.payload["action"] ? `/${event.payload["action"]}` : ""}`;
  const details = fmtEventDetails(event);
  return `${nameAction}${details ? ` — ${details}` : ""}`;
}
