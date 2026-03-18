import type { TaskQueue } from "./foreman.js";

// ── GitHub API helpers ────────────────────────────────────────────────────────
// Read env vars inside function bodies (not at module load) so that tests can
// set process.env values before calling the function.

function ghEnv() {
  return {
    repo:      process.env.GITHUB_REPO ?? "",
    token:     process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "",
    taskLabel: process.env.TASK_LABEL ?? "brunel:ready",
    doneLabel: process.env.DONE_LABEL ?? "brunel:done",
  };
}

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function loadIssuesToQueue(queue: TaskQueue): Promise<void> {
  const { repo, token, taskLabel } = ghEnv();
  const [owner, repoName] = repo.split("/");
  const url = `https://api.github.com/repos/${owner}/${repoName}/issues?labels=${encodeURIComponent(taskLabel)}&state=open&per_page=100`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const issues = await res.json() as Array<{ number: number; title: string; body: string | null; labels: Array<{ name: string }> }>;
  for (const issue of issues) {
    queue.addTask({
      taskId: String(issue.number),
      issueNumber: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      labels: issue.labels.map(l => l.name),
      repoUrl: `https://github.com/${owner}/${repoName}`,
    });
  }
}

export async function labelIssueDone(issueNumber: number): Promise<void> {
  const { repo, token, doneLabel } = ghEnv();
  const [owner, repoName] = repo.split("/");
  const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}/labels`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ labels: [doneLabel] }),
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
}

export async function fetchIssueStates(
  issueNumbers: number[],
): Promise<Map<number, "open" | "closed">> {
  if (issueNumbers.length === 0) return new Map();
  const { repo, token } = ghEnv();
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

export async function fetchNativeBlockers(issueNumber: number): Promise<number[]> {
  const { repo, token } = ghEnv();
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
  const res = await fetch("https://api.github.com/graphql", {
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
