import { describe, it, expect, vi, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { GithubToken } from "../src/agent/models/github-token.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

// ── GithubToken.fromCli ───────────────────────────────────────────────────────

describe("GithubToken.fromCli", () => {
  it("returns token when gh auth token succeeds", async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], cb: (...a: unknown[]) => void) => {
      cb(null, { stdout: "ghp_mytoken123\n", stderr: "" });
    });
    expect(await GithubToken.fromCli()).toBe("ghp_mytoken123");
  });

  it("trims whitespace and newlines from token output", async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], cb: (...a: unknown[]) => void) => {
      cb(null, { stdout: "  ghp_spaced  \n", stderr: "" });
    });
    expect(await GithubToken.fromCli()).toBe("ghp_spaced");
  });

  it("returns null when gh exits with a non-zero code", async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], cb: (...a: unknown[]) => void) => {
      cb(new Error("not logged in"));
    });
    expect(await GithubToken.fromCli()).toBeNull();
  });

  it("returns null when gh is not installed (ENOENT)", async () => {
    const err = Object.assign(new Error("not found"), { code: "ENOENT" });
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], cb: (...a: unknown[]) => void) => {
      cb(err);
    });
    expect(await GithubToken.fromCli()).toBeNull();
  });

  it("returns null when token output is empty", async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], cb: (...a: unknown[]) => void) => {
      cb(null, { stdout: "   ", stderr: "" });
    });
    expect(await GithubToken.fromCli()).toBeNull();
  });
});

// ── GithubToken.resolve ───────────────────────────────────────────────────────

describe("GithubToken.resolve", () => {
  it("returns cli token when available (highest priority)", async () => {
    vi.spyOn(GithubToken, "fromCli").mockResolvedValue("cli-token");
    expect(await GithubToken.resolve("config-token")).toBe("cli-token");
  });

  it("returns config token when cli token is null", async () => {
    vi.spyOn(GithubToken, "fromCli").mockResolvedValue(null);
    expect(await GithubToken.resolve("config-token")).toBe("config-token");
  });

  it("returns null when cli and config are both absent", async () => {
    vi.spyOn(GithubToken, "fromCli").mockResolvedValue(null);
    expect(await GithubToken.resolve(undefined)).toBeNull();
  });
});
