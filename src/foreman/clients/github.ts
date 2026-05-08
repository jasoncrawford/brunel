import { createSign } from "node:crypto";
import { getConfig } from "../../config.js";

// ── GitHub API helpers ────────────────────────────────────────────────────────

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function mintAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: appId,
    iat: now - 60,
    exp: now + 540,
  })).toString("base64url");
  const data = `${header}.${payload}`;
  const sign = createSign("RSA-SHA256");
  sign.update(data);
  return `${data}.${sign.sign(privateKey, "base64url")}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GithubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
}

// ── GitHub client ─────────────────────────────────────────────────────────────

export class GithubClient {
  private readonly owner: string;
  private readonly repoName: string;
  private readonly installationGithubId?: number;

  constructor(repo: string, installationGithubId?: number) {
    const [owner, repoName] = repo.split("/");
    this.owner = owner;
    this.repoName = repoName;
    this.installationGithubId = installationGithubId;
  }

  /** Mints a short-lived installation access token using the App private key. */
  async mintInstallationToken(): Promise<string> {
    const { appId, appPrivateKey, githubApiUrl: apiUrl = "https://api.github.com" } = getConfig();
    if (!appId || !appPrivateKey) {
      throw new Error("GitHub App credentials not configured (appId and appPrivateKey required)");
    }
    if (this.installationGithubId === undefined) {
      throw new Error("No installation ID set on this GithubClient");
    }
    const jwt = mintAppJwt(appId, appPrivateKey);
    const res = await fetch(`${apiUrl}/app/installations/${this.installationGithubId}/access_tokens`, {
      method: "POST",
      headers: ghHeaders(jwt),
    });
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    const body = await res.json() as { token: string };
    return body.token;
  }

  private async resolveToken(): Promise<string> {
    if (this.installationGithubId !== undefined) {
      return this.mintInstallationToken();
    }
    const token = getConfig().githubToken;
    if (!token) throw new Error("GitHub token not configured");
    return token;
  }

  async fetchIssues(): Promise<GithubIssue[]> {
    const token = await this.resolveToken();
    const { taskLabel, githubApiUrl: apiUrl = "https://api.github.com" } = getConfig();
    const url = `${apiUrl}/repos/${this.owner}/${this.repoName}/issues?labels=${encodeURIComponent(taskLabel)}&state=open&per_page=100`;
    const res = await fetch(url, { headers: ghHeaders(token) });
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    return res.json() as Promise<GithubIssue[]>;
  }

  async fetchIssueStates(issueNumbers: number[]): Promise<Map<number, "open" | "closed">> {
    if (issueNumbers.length === 0) return new Map();
    const token = await this.resolveToken();
    const { githubApiUrl: apiUrl = "https://api.github.com" } = getConfig();
    const result = new Map<number, "open" | "closed">();
    await Promise.all(
      issueNumbers.map(async (n) => {
        const url = `${apiUrl}/repos/${this.owner}/${this.repoName}/issues/${n}`;
        const res = await fetch(url, { headers: ghHeaders(token) });
        if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
        const issue = await res.json() as { number: number; state: string };
        result.set(issue.number, issue.state === "open" ? "open" : "closed");
      }),
    );
    return result;
  }

  /** Fetches the login of the user owning the given personal access token. */
  async fetchUserLogin(personalToken: string): Promise<string> {
    const { githubApiUrl: apiUrl = "https://api.github.com" } = getConfig();
    const res = await fetch(`${apiUrl}/user`, { headers: ghHeaders(personalToken) });
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    const body = await res.json() as { login: string };
    return body.login;
  }

  /**
   * Checks whether the given user has push (or admin) access to this repo.
   * Uses an installation token minted for this client's installationGithubId.
   */
  async verifyPushAccess(username: string): Promise<boolean> {
    const token = await this.mintInstallationToken();
    const { githubApiUrl: apiUrl = "https://api.github.com" } = getConfig();
    const res = await fetch(
      `${apiUrl}/repos/${this.owner}/${this.repoName}/collaborators/${username}/permission`,
      { headers: ghHeaders(token) },
    );
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    const body = await res.json() as { permission: string };
    return body.permission === "push" || body.permission === "admin";
  }

  async fetchNativeBlockers(issueNumber: number): Promise<number[]> {
    const token = await this.resolveToken();
    const { githubApiUrl: apiUrl = "https://api.github.com" } = getConfig();
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
      body: JSON.stringify({ query, variables: { owner: this.owner, repo: this.repoName, number: issueNumber } }),
    });
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    const body = await res.json() as {
      data?: { repository?: { issue?: { blockedBy?: { nodes: Array<{ number: number }> } | null } | null } | null };
    };
    return body.data?.repository?.issue?.blockedBy?.nodes?.map((n) => n.number) ?? [];
  }
}
