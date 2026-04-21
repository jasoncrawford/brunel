import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

// Import after mock is set up
import * as childProcess from "node:child_process";
import { WorkerSession } from "../src/agent/controllers/worker-controller.js";

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

describe("WorkerSession.getRemoteRepo", () => {
  it("parses HTTPS URL with .git suffix", async () => {
    setExecResult("https://github.com/owner/repo.git\n");
    expect(await WorkerSession.getRemoteRepo()).toBe("owner/repo");
  });

  it("parses HTTPS URL without .git suffix", async () => {
    setExecResult("https://github.com/owner/repo\n");
    expect(await WorkerSession.getRemoteRepo()).toBe("owner/repo");
  });

  it("parses SSH URL", async () => {
    setExecResult("git@github.com:owner/repo.git\n");
    expect(await WorkerSession.getRemoteRepo()).toBe("owner/repo");
  });

  it("parses SSH URL without .git suffix", async () => {
    setExecResult("git@github.com:owner/repo\n");
    expect(await WorkerSession.getRemoteRepo()).toBe("owner/repo");
  });

  it("returns empty string when git command fails", async () => {
    setExecError(new Error("not a git repo"));
    expect(await WorkerSession.getRemoteRepo()).toBe("");
  });

  it("returns empty string for unrecognized URL format", async () => {
    setExecResult("not-a-url\n");
    expect(await WorkerSession.getRemoteRepo()).toBe("");
  });
});
