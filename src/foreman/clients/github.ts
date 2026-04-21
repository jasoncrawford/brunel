import type { TaskManager } from "../models/task-manager.js";
import { Task } from "../models/task.js";
import { fmtError } from "../../utils.js";
import { getConfig } from "../../config.js";

// ── GitHub API helpers ────────────────────────────────────────────────────────

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// ── Exported functions ────────────────────────────────────────────────────────

export async function loadIssuesToQueue(
  taskModel: TaskManager,
): Promise<void> {
  const { githubToken: token, taskLabel, githubApiUrl: apiUrl = "https://api.github.com" } = getConfig();
  const repo = taskModel.repo.fullName;
  const [owner, repoName] = repo.split("/");
  const url = `${apiUrl}/repos/${owner}/${repoName}/issues?labels=${encodeURIComponent(taskLabel)}&state=open&per_page=100`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const issues = await res.json() as Array<{
    number: number; title: string; body: string | null; labels: Array<{ name: string }>;
  }>;

  const allBlockerNumbers = new Set<number>();
  const loadedIssueNumbers: number[] = [];

  for (const issue of issues) {
    const body = issue.body ?? "";
    const labels = issue.labels.map((l) => l.name);
    const repoUrl = `https://github.com/${owner}/${repoName}`;

    // Log if this task is already assigned so it's visible in startup logs that we're preserving it.
    const existingTask = await Task.getByRepoIssue(taskModel.repo.id, issue.number).catch(() => null);
    if (existingTask?.workerId) {
      console.log(`[startup] task #${issue.number} already assigned to worker ${existingTask.workerId} — preserving assignment`);
    }

    // Track as open and upsert into DB (handles both creation and content sync).
    // NOTE: upsert only updates content fields (title, body, labels); status fields are preserved.
    await taskModel.enqueueIssue(String(issue.number), issue.number, repo, issue.title, body, labels)
      .catch((err: unknown) => console.error(`[startup] ERROR upserting task #${issue.number}: ${fmtError(err)}`));

    const blockers = await Task.fetchBlockers(issue.number, body);
    taskModel.setBlockers(issue.number, blockers);
    for (const b of blockers) allBlockerNumbers.add(b);
    loadedIssueNumbers.push(issue.number);
  }

  if (allBlockerNumbers.size > 0) {
    const states = await fetchIssueStates(Array.from(allBlockerNumbers));
    for (const [num, state] of states) {
      taskModel.setIssueOpenState(num, state === "open");
    }
  }

  // Mark all loaded issues as having their deps resolved.
  for (const num of loadedIssueNumbers) {
    taskModel.markBlockersLoaded(num);
  }

  // Cleanup: delete pending tasks for issues that no longer have the task label.
  const labeledNums = new Set(loadedIssueNumbers);
  const allTasks = await Task.list({ cancelable: true });
  for (const t of allTasks) {
    if (!labeledNums.has(t.issueNumber)) {
      await t.deleteIfUnassigned().catch((err: unknown) =>
        console.error(`[startup] ERROR deleting stale task #${t.taskId}: ${fmtError(err)}`)
      );
    }
  }
}


export async function fetchIssueStates(
  issueNumbers: number[],
): Promise<Map<number, "open" | "closed">> {
  if (issueNumbers.length === 0) return new Map();
  const { githubRepo: repo, githubToken: token } = getConfig();
  const [owner, repoName] = repo.split("/");
  const result = new Map<number, "open" | "closed">();
  await Promise.all(
    issueNumbers.map(async (n) => {
      const url = `https://api.github.com/repos/${owner}/${repoName}/issues/${n}`;
      const res = await fetch(url, { headers: ghHeaders(token) });
      if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
      const issue = await res.json() as { number: number; state: string };
      result.set(issue.number, issue.state === "open" ? "open" : "closed");
    }),
  );
  return result;
}

export async function fetchNativeBlockers(
  issueNumber: number,
): Promise<number[]> {
  const { githubRepo: repo, githubToken: token, githubApiUrl: apiUrl = "https://api.github.com" } = getConfig();
  const [owner, repoName] = repo.split("/");
  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          blockedBy(first: 50) {
            nodes { number }
          }
        }
      }
    }
  `;
  const res = await fetch(`${apiUrl}/graphql`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { owner, repo: repoName, number: issueNumber } }),
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const body = await res.json() as {
    data?: { repository?: { issue?: { blockedBy?: { nodes: Array<{ number: number }> } | null } | null } | null };
  };
  return body.data?.repository?.issue?.blockedBy?.nodes?.map((n) => n.number) ?? [];
}
