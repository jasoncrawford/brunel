import { describe, it, expect, vi, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { GithubToken } from "../src/agent/models/github-token.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

afterEach(() => {
  vi.resetAllMocks();
});

describe("GithubToken.resolve", () => {
  it("returns configToken without calling gh CLI (highest priority)", async () => {
    const token = await new GithubToken("config-token").resolve();
    expect(token).toBe("config-token");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("falls back to gh CLI when configToken is absent", async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], cb: (...a: unknown[]) => void) => {
      cb(null, { stdout: "ghp_cli_token\n", stderr: "" });
    });
    expect(await new GithubToken().resolve()).toBe("ghp_cli_token");
  });

  it("trims whitespace from CLI token output", async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], cb: (...a: unknown[]) => void) => {
      cb(null, { stdout: "  ghp_spaced  \n", stderr: "" });
    });
    expect(await new GithubToken().resolve()).toBe("ghp_spaced");
  });

  it("returns null when configToken absent and gh CLI fails", async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], cb: (...a: unknown[]) => void) => {
      cb(new Error("not logged in"));
    });
    expect(await new GithubToken().resolve()).toBeNull();
  });

  it("returns null when configToken absent and gh is not installed (ENOENT)", async () => {
    const err = Object.assign(new Error("not found"), { code: "ENOENT" });
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], cb: (...a: unknown[]) => void) => {
      cb(err);
    });
    expect(await new GithubToken().resolve()).toBeNull();
  });

  it("returns null when configToken absent and CLI output is empty", async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], cb: (...a: unknown[]) => void) => {
      cb(null, { stdout: "   ", stderr: "" });
    });
    expect(await new GithubToken().resolve()).toBeNull();
  });

  it("returns null when no configToken and no gh CLI", async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], cb: (...a: unknown[]) => void) => {
      cb(new Error("gh not found"));
    });
    expect(await new GithubToken(undefined).resolve()).toBeNull();
  });
});
