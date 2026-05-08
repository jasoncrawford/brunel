import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { GithubClient } from "../src/foreman/clients/github.js";
import { Worker } from "../src/foreman/models/worker.js";
import { getConfig } from "../src/config.js";

beforeEach(() => {
  Worker._reset();
  vi.stubGlobal("fetch", vi.fn());
  getConfig().githubToken = "token123";
  getConfig().taskLabel = "brunel:ready";
  getConfig().appId = undefined as unknown as string;
  getConfig().appPrivateKey = undefined as unknown as string;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchIssues", () => {
  it("fetches open issues with the task label and returns them", async () => {
    const mockIssues = [
      { number: 1, title: "First issue", body: "body 1", labels: [{ name: "brunel:ready" }] },
      { number: 2, title: "Second issue", body: null, labels: [{ name: "brunel:ready" }] },
    ];
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => mockIssues } as any);

    const client = new GithubClient("owner/repo");
    const issues = await client.fetchIssues();

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("owner/repo/issues"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token123" }) }),
    );
    expect(issues).toHaveLength(2);
    expect(issues[0].title).toBe("First issue");
    expect(issues[1].body).toBeNull();
  });

  it("includes the task label in the query string", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => [] } as any);
    await new GithubClient("owner/repo").fetchIssues();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("labels=brunel%3Aready"),
      expect.anything(),
    );
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 403 } as any);
    await expect(new GithubClient("owner/repo").fetchIssues()).rejects.toThrow("403");
  });
});

describe("fetchIssueStates", () => {
  it("returns open/closed state for each issue number", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ number: 1, state: "open" }) } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ number: 2, state: "closed" }) } as any);
    const states = await new GithubClient("owner/repo").fetchIssueStates([1, 2]);
    expect(states.get(1)).toBe("open");
    expect(states.get(2)).toBe("closed");
  });

  it("uses the repo from the constructor in the API URL", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ number: 1, state: "open" }) } as any);
    await new GithubClient("other-owner/other-repo").fetchIssueStates([1]);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("other-owner/other-repo/issues/1"),
      expect.anything(),
    );
  });

  it("returns empty map for empty input without calling fetch", async () => {
    const states = await new GithubClient("owner/repo").fetchIssueStates([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(states.size).toBe(0);
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as any);
    await expect(new GithubClient("owner/repo").fetchIssueStates([1])).rejects.toThrow("500");
  });
});

describe("fetchNativeBlockers", () => {
  it("returns blocker issue numbers from GraphQL response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          repository: {
            issue: {
              blockedBy: { nodes: [{ number: 5 }, { number: 7 }] },
            },
          },
        },
      }),
    } as any);
    const blockers = await new GithubClient("owner/repo").fetchNativeBlockers(42);
    expect(blockers).toEqual([5, 7]);
  });

  it("uses the repo from the constructor in the GraphQL variables", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { repository: { issue: { blockedBy: { nodes: [] } } } } }),
    } as any);
    await new GithubClient("other-owner/other-repo").fetchNativeBlockers(42);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.variables.owner).toBe("other-owner");
    expect(body.variables.repo).toBe("other-repo");
  });

  it("returns empty array when issue has no blockers", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { repository: { issue: { blockedBy: { nodes: [] } } } },
      }),
    } as any);
    expect(await new GithubClient("owner/repo").fetchNativeBlockers(42)).toEqual([]);
  });

  it("returns empty array when GraphQL field is null (feature unavailable)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { repository: { issue: { blockedBy: null } } },
      }),
    } as any);
    expect(await new GithubClient("owner/repo").fetchNativeBlockers(42)).toEqual([]);
  });

  it("throws on non-ok HTTP response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 403 } as any);
    await expect(new GithubClient("owner/repo").fetchNativeBlockers(42)).rejects.toThrow("403");
  });
});

// ── Installation ID on constructor ────────────────────────────────────────────

function makeTestKeyPair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const [, payloadB64] = jwt.split(".");
  return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
}

describe("GithubClient with installationGithubId", () => {
  it("fetchIssues auto-mints an installation token and uses it", async () => {
    const { privateKey } = makeTestKeyPair();
    getConfig().appId = "123";
    getConfig().appPrivateKey = privateKey;
    // First fetch: mintInstallationToken POST; second fetch: actual issues GET
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "ghs_inst" }) } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as any);

    await new GithubClient("owner/repo", 456).fetchIssues();

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/app/installations/456/access_tokens"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("owner/repo/issues"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer ghs_inst" }) }),
    );
  });

  it("fetchIssueStates auto-mints an installation token and uses it", async () => {
    const { privateKey } = makeTestKeyPair();
    getConfig().appId = "123";
    getConfig().appPrivateKey = privateKey;
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "ghs_inst" }) } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ number: 1, state: "open" }) } as any);

    await new GithubClient("owner/repo", 456).fetchIssueStates([1]);

    expect(fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer ghs_inst" }) }),
    );
  });

  it("fetchNativeBlockers auto-mints an installation token and uses it", async () => {
    const { privateKey } = makeTestKeyPair();
    getConfig().appId = "123";
    getConfig().appPrivateKey = privateKey;
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "ghs_inst" }) } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { repository: { issue: { blockedBy: { nodes: [] } } } } }),
      } as any);

    await new GithubClient("owner/repo", 456).fetchNativeBlockers(42);

    const graphqlCall = vi.mocked(fetch).mock.calls[1];
    expect((graphqlCall[1] as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe("Bearer ghs_inst");
  });
});

// ── mintInstallationToken ─────────────────────────────────────────────────────

describe("mintInstallationToken", () => {
  it("calls POST /app/installations/{id}/access_tokens and returns the token", async () => {
    const { privateKey } = makeTestKeyPair();
    getConfig().appId = "123";
    getConfig().appPrivateKey = privateKey;
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ token: "ghs_install_token" }) } as any);

    const token = await new GithubClient("owner/repo", 456).mintInstallationToken();

    expect(token).toBe("ghs_install_token");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/app/installations/456/access_tokens"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends a JWT Authorization header signed with the app private key", async () => {
    const { privateKey } = makeTestKeyPair();
    getConfig().appId = "123";
    getConfig().appPrivateKey = privateKey;
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ token: "t" }) } as any);

    await new GithubClient("owner/repo", 456).mintInstallationToken();

    const authHeader = (vi.mocked(fetch).mock.calls[0][1] as RequestInit & { headers: Record<string, string> }).headers.Authorization;
    expect(authHeader).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("JWT iss claim matches the configured appId", async () => {
    const { privateKey } = makeTestKeyPair();
    getConfig().appId = "app-99";
    getConfig().appPrivateKey = privateKey;
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ token: "t" }) } as any);

    await new GithubClient("owner/repo", 1).mintInstallationToken();

    const authHeader = (vi.mocked(fetch).mock.calls[0][1] as RequestInit & { headers: Record<string, string> }).headers.Authorization;
    const payload = decodeJwtPayload(authHeader.replace("Bearer ", ""));
    expect(payload.iss).toBe("app-99");
  });

  it("JWT iat is ~60 seconds before now and exp is ~540 seconds after iat", async () => {
    const { privateKey } = makeTestKeyPair();
    getConfig().appId = "1";
    getConfig().appPrivateKey = privateKey;
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ token: "t" }) } as any);

    const before = Math.floor(Date.now() / 1000);
    await new GithubClient("owner/repo", 1).mintInstallationToken();
    const after = Math.floor(Date.now() / 1000);

    const authHeader = (vi.mocked(fetch).mock.calls[0][1] as RequestInit & { headers: Record<string, string> }).headers.Authorization;
    const payload = decodeJwtPayload(authHeader.replace("Bearer ", ""));
    const iat = payload.iat as number;
    const exp = payload.exp as number;
    expect(iat).toBeGreaterThanOrEqual(before - 61);
    expect(iat).toBeLessThanOrEqual(after - 59);
    expect(exp - iat).toBe(600);
  });

  it("throws on non-ok response", async () => {
    const { privateKey } = makeTestKeyPair();
    getConfig().appId = "1";
    getConfig().appPrivateKey = privateKey;
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 401 } as any);

    await expect(new GithubClient("owner/repo", 1).mintInstallationToken()).rejects.toThrow("401");
  });

  it("throws when appId is not configured", async () => {
    getConfig().appPrivateKey = "some-key";
    await expect(new GithubClient("owner/repo", 1).mintInstallationToken()).rejects.toThrow();
  });

  it("throws when appPrivateKey is not configured", async () => {
    getConfig().appId = "1";
    await expect(new GithubClient("owner/repo", 1).mintInstallationToken()).rejects.toThrow();
  });

  it("throws when no installationGithubId set on the client", async () => {
    const { privateKey } = makeTestKeyPair();
    getConfig().appId = "1";
    getConfig().appPrivateKey = privateKey;
    await expect(new GithubClient("owner/repo").mintInstallationToken()).rejects.toThrow();
  });
});

// ── fetchUserLogin ────────────────────────────────────────────────────────────

describe("fetchUserLogin", () => {
  it("returns the GitHub login for the authenticated user", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ login: "octocat" }) } as any);
    const login = await new GithubClient("owner/repo").fetchUserLogin("personal-token");
    expect(login).toBe("octocat");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/user"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer personal-token" }) }),
    );
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 401 } as any);
    await expect(new GithubClient("owner/repo").fetchUserLogin("bad-token")).rejects.toThrow("401");
  });
});

// ── verifyPushAccess ──────────────────────────────────────────────────────────

describe("verifyPushAccess", () => {
  it("returns true when user has admin permission", async () => {
    const { privateKey } = makeTestKeyPair();
    getConfig().appId = "123";
    getConfig().appPrivateKey = privateKey;
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "inst_token" }) } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ permission: "admin" }) } as any);
    expect(await new GithubClient("owner/repo", 456).verifyPushAccess("testuser")).toBe(true);
  });

  it("returns true when user has push permission", async () => {
    const { privateKey } = makeTestKeyPair();
    getConfig().appId = "123";
    getConfig().appPrivateKey = privateKey;
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "inst_token" }) } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ permission: "push" }) } as any);
    expect(await new GithubClient("owner/repo", 456).verifyPushAccess("testuser")).toBe(true);
  });

  it("returns false when user has pull permission", async () => {
    const { privateKey } = makeTestKeyPair();
    getConfig().appId = "123";
    getConfig().appPrivateKey = privateKey;
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "inst_token" }) } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ permission: "pull" }) } as any);
    expect(await new GithubClient("owner/repo", 456).verifyPushAccess("testuser")).toBe(false);
  });

  it("returns false when user has read permission", async () => {
    const { privateKey } = makeTestKeyPair();
    getConfig().appId = "123";
    getConfig().appPrivateKey = privateKey;
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "inst_token" }) } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ permission: "read" }) } as any);
    expect(await new GithubClient("owner/repo", 456).verifyPushAccess("testuser")).toBe(false);
  });

  it("uses installation token for the permission check", async () => {
    const { privateKey } = makeTestKeyPair();
    getConfig().appId = "123";
    getConfig().appPrivateKey = privateKey;
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "ghs_inst_token" }) } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ permission: "push" }) } as any);
    await new GithubClient("owner/repo", 456).verifyPushAccess("someuser");
    const permCall = vi.mocked(fetch).mock.calls[1];
    expect(permCall[0]).toContain("/collaborators/someuser/permission");
    expect((permCall[1] as RequestInit & { headers: Record<string, string> }).headers.Authorization)
      .toBe("Bearer ghs_inst_token");
  });

  it("throws on non-ok permission check response", async () => {
    const { privateKey } = makeTestKeyPair();
    getConfig().appId = "123";
    getConfig().appPrivateKey = privateKey;
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "inst_token" }) } as any)
      .mockResolvedValueOnce({ ok: false, status: 403 } as any);
    await expect(new GithubClient("owner/repo", 456).verifyPushAccess("testuser")).rejects.toThrow("403");
  });
});
