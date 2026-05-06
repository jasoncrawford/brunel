import { describe, it, expect, vi } from "vitest";
import { resolveGithubTokenFromCli, resolveGithubToken } from "../src/agent/models/github-token.js";

// ── resolveGithubTokenFromCli ─────────────────────────────────────────────────

describe("resolveGithubTokenFromCli", () => {
  it("returns token when gh auth token succeeds", async () => {
    const exec = vi.fn().mockResolvedValue("ghp_mytoken123\n");
    const token = await resolveGithubTokenFromCli(exec);
    expect(exec).toHaveBeenCalledWith("gh", ["auth", "token"]);
    expect(token).toBe("ghp_mytoken123");
  });

  it("trims whitespace and newlines from token output", async () => {
    const exec = vi.fn().mockResolvedValue("  ghp_spaced  \n");
    const token = await resolveGithubTokenFromCli(exec);
    expect(token).toBe("ghp_spaced");
  });

  it("returns null when gh exits with a non-zero code", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("not logged in"));
    const token = await resolveGithubTokenFromCli(exec);
    expect(token).toBeNull();
  });

  it("returns null when gh is not installed (ENOENT)", async () => {
    const err = Object.assign(new Error("not found"), { code: "ENOENT" });
    const exec = vi.fn().mockRejectedValue(err);
    const token = await resolveGithubTokenFromCli(exec);
    expect(token).toBeNull();
  });

  it("returns null when token output is empty", async () => {
    const exec = vi.fn().mockResolvedValue("   ");
    const token = await resolveGithubTokenFromCli(exec);
    expect(token).toBeNull();
  });
});

// ── resolveGithubToken ────────────────────────────────────────────────────────

describe("resolveGithubToken", () => {
  it("returns cli token when available (highest priority)", async () => {
    const token = await resolveGithubToken({
      cliToken: "cli-token",
      configToken: "config-token",
    });
    expect(token).toBe("cli-token");
  });

  it("returns config token when cli token is null", async () => {
    const token = await resolveGithubToken({
      cliToken: null,
      configToken: "config-token",
    });
    expect(token).toBe("config-token");
  });

  it("calls promptFn when both cli and config tokens are absent", async () => {
    const promptFn = vi.fn().mockResolvedValue("prompted-token");
    const token = await resolveGithubToken({
      cliToken: null,
      configToken: undefined,
      promptFn,
    });
    expect(promptFn).toHaveBeenCalledOnce();
    expect(token).toBe("prompted-token");
  });

  it("returns null when cli and config are absent and no promptFn provided", async () => {
    const token = await resolveGithubToken({
      cliToken: null,
      configToken: undefined,
    });
    expect(token).toBeNull();
  });

  it("returns null when promptFn returns null", async () => {
    const promptFn = vi.fn().mockResolvedValue(null);
    const token = await resolveGithubToken({
      cliToken: null,
      configToken: undefined,
      promptFn,
    });
    expect(token).toBeNull();
  });

  it("does not call promptFn when cli token is available", async () => {
    const promptFn = vi.fn().mockResolvedValue("prompted-token");
    await resolveGithubToken({
      cliToken: "cli-token",
      configToken: undefined,
      promptFn,
    });
    expect(promptFn).not.toHaveBeenCalled();
  });

  it("does not call promptFn when config token is available", async () => {
    const promptFn = vi.fn().mockResolvedValue("prompted-token");
    await resolveGithubToken({
      cliToken: null,
      configToken: "config-token",
      promptFn,
    });
    expect(promptFn).not.toHaveBeenCalled();
  });
});
