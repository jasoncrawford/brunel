import { getConfig } from "../../config.js";

// ── GitHub API helpers ────────────────────────────────────────────────────────

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GithubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
}

// ── GitHub client ─────────────────────────────────────────────────────────────

export const github = {
  async fetchIssues(repo: string): Promise<GithubIssue[]> {
    const { githubToken: token, taskLabel, githubApiUrl: apiUrl = "https://api.github.com" } = getConfig();
    const [owner, repoName] = repo.split("/");
    const url = `${apiUrl}/repos/${owner}/${repoName}/issues?labels=${encodeURIComponent(taskLabel)}&state=open&per_page=100`;
    const res = await fetch(url, { headers: ghHeaders(token) });
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    return res.json() as Promise<GithubIssue[]>;
  },

  async fetchIssueStates(
    issueNumbers: number[],
    repo: string,
  ): Promise<Map<number, "open" | "closed">> {
    if (issueNumbers.length === 0) return new Map();
    const { githubToken: token, githubApiUrl: apiUrl = "https://api.github.com" } = getConfig();
    const [owner, repoName] = repo.split("/");
    const result = new Map<number, "open" | "closed">();
    await Promise.all(
      issueNumbers.map(async (n) => {
        const url = `${apiUrl}/repos/${owner}/${repoName}/issues/${n}`;
        const res = await fetch(url, { headers: ghHeaders(token) });
        if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
        const issue = await res.json() as { number: number; state: string };
        result.set(issue.number, issue.state === "open" ? "open" : "closed");
      }),
    );
    return result;
  },

  async fetchNativeBlockers(
    issueNumber: number,
    repo: string,
  ): Promise<number[]> {
    const { githubToken: token, githubApiUrl: apiUrl = "https://api.github.com" } = getConfig();
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
  },
};
