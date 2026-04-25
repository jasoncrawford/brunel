import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

// Import after mock is set up
import * as childProcess from "node:child_process";
import { AgentStatus } from "../src/agent/models/agent-status.js";

type ExecCallback = (err: Error | null, result: { stdout: string; stderr: string }) => void;

function setExecResult(stdout: string): void {
  vi.mocked(childProcess.exec).mockImplementation(
    (_cmd: unknown, callback: unknown) => {
      (callback as ExecCallback)(null, { stdout, stderr: "" });
      return {} as ReturnType<typeof childProcess.exec>;
    },
  );
}

function setExecError(err: Error): void {
  vi.mocked(childProcess.exec).mockImplementation(
    (_cmd: unknown, callback: unknown) => {
      (callback as ExecCallback)(err, { stdout: "", stderr: "" });
      return {} as ReturnType<typeof childProcess.exec>;
    },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentStatus.getRemoteRepo", () => {
  it("parses HTTPS URL with .git suffix", async () => {
    setExecResult("https://github.com/owner/repo.git\n");
    expect(await AgentStatus.getRemoteRepo()).toBe("owner/repo");
  });

  it("parses HTTPS URL without .git suffix", async () => {
    setExecResult("https://github.com/owner/repo\n");
    expect(await AgentStatus.getRemoteRepo()).toBe("owner/repo");
  });

  it("parses SSH URL", async () => {
    setExecResult("git@github.com:owner/repo.git\n");
    expect(await AgentStatus.getRemoteRepo()).toBe("owner/repo");
  });

  it("parses SSH URL without .git suffix", async () => {
    setExecResult("git@github.com:owner/repo\n");
    expect(await AgentStatus.getRemoteRepo()).toBe("owner/repo");
  });

  it("returns empty string when git command fails", async () => {
    setExecError(new Error("not a git repo"));
    expect(await AgentStatus.getRemoteRepo()).toBe("");
  });

  it("returns empty string for unrecognized URL format", async () => {
    setExecResult("not-a-url\n");
    expect(await AgentStatus.getRemoteRepo()).toBe("");
  });
});
