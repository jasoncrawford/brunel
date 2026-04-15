import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setVerbose, verbose, fmtWorkerStatus, StatusBar } from "../src/agent/status-bar.js";

// Strip ANSI codes for assertion
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("verbose flag", () => {
  afterEach(() => {
    setVerbose(false);
  });

  it("defaults to false", () => {
    expect(verbose).toBe(false);
  });

  it("setVerbose(true) sets verbose to true", () => {
    setVerbose(true);
    expect(verbose).toBe(true);
  });

  it("setVerbose(false) resets verbose", () => {
    setVerbose(true);
    setVerbose(false);
    expect(verbose).toBe(false);
  });
});

describe("fmtWorkerStatus", () => {
  afterEach(() => {
    setVerbose(false);
  });

  it("shows worker id and no current task when idle", () => {
    const result = stripAnsi(fmtWorkerStatus({
      workerId: "7c254628-abcd-1234-efgh-000000000000",
      connectionStatus: "connected",
      width: 80,
    }));
    expect(result).toContain("worker 7c254628");
    expect(result).toContain("no current task");
    expect(result).toContain("Connected");
  });

  it("shows disconnectCode in verbose mode", () => {
    setVerbose(true);
    const result = stripAnsi(fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "disconnected",
      disconnectCode: 1006,
      retryInSeconds: 2,
      width: 80,
    }));
    expect(result).toContain("Disconnected (1006). Retrying in 2s");
  });

  it("omits disconnectCode in non-verbose mode", () => {
    setVerbose(false);
    const result = stripAnsi(fmtWorkerStatus({
      workerId: "abc12345-0000-0000-0000-000000000000",
      connectionStatus: "disconnected",
      disconnectCode: 1006,
      width: 80,
    }));
    expect(result).toContain("Disconnected");
    expect(result).not.toContain("1006");
  });

  it("shows task, PR, and branch when set", () => {
    const result = stripAnsi(fmtWorkerStatus({
      workerId: "7c254628-abcd-1234-efgh-000000000000",
      taskNumber: 374,
      prNumber: 406,
      branch: "db-single-source-of-truth",
      connectionStatus: "connected",
      width: 120,
    }));
    expect(result).toContain("task #374");
    expect(result).toContain("PR #406");
    expect(result).toContain("db-single-source-of-truth");
  });
});

describe("StatusBar class", () => {
  let bar: StatusBar;
  let stdoutWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    bar = new StatusBar();
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
    bar.stop();
    bar.stopPersistent();
  });

  describe("callbacks", () => {
    it("getInputPrint returns null by default", () => {
      expect(bar.getInputPrint()).toBeNull();
    });

    it("setInputPrint/getInputPrint round-trips", () => {
      const fn = vi.fn();
      bar.setInputPrint(fn);
      expect(bar.getInputPrint()).toBe(fn);
    });

    it("getInputStatus returns null by default", () => {
      expect(bar.getInputStatus()).toBeNull();
    });

    it("setInputStatus/getInputStatus round-trips", () => {
      const fn = vi.fn();
      bar.setInputStatus(fn);
      expect(bar.getInputStatus()).toBe(fn);
    });

    it("getInputClear returns null by default", () => {
      expect(bar.getInputClear()).toBeNull();
    });

    it("setInputClear/getInputClear round-trips", () => {
      const fn = vi.fn();
      bar.setInputClear(fn);
      expect(bar.getInputClear()).toBe(fn);
    });

    it("fireOnToolResult calls the registered callback", () => {
      const fn = vi.fn();
      bar.setOnToolResult(fn);
      bar.fireOnToolResult("Bash");
      expect(fn).toHaveBeenCalledWith("Bash");
    });

    it("fireOnToolResult does nothing when no callback registered", () => {
      expect(() => bar.fireOnToolResult("Bash")).not.toThrow();
    });
  });

  describe("persistent status bar", () => {
    it("startPersistent draws a status line", () => {
      bar.startPersistent(() => "worker abc • idle");
      const writes = stdoutWrite.mock.calls.map(a => String(a[0]));
      expect(writes.join("")).toContain("worker abc • idle");
    });

    it("persistentActive is true after startPersistent", () => {
      bar.startPersistent(() => "worker abc • idle");
      expect(bar.persistentActive).toBe(true);
    });

    it("persistentActive is false after stopPersistent", () => {
      bar.startPersistent(() => "worker abc • idle");
      bar.stopPersistent();
      expect(bar.persistentActive).toBe(false);
    });

    it("stopPersistent clears the status line", () => {
      bar.startPersistent(() => "worker abc • idle");
      stdoutWrite.mockClear();
      bar.stopPersistent();
      const writes = stdoutWrite.mock.calls.map(a => String(a[0]));
      expect(writes.some(w => w.includes("\x1b[K"))).toBe(true);
    });

    it("updatePersistent refreshes text", () => {
      let text = "initial";
      bar.startPersistent(() => text);
      stdoutWrite.mockClear();
      text = "updated";
      bar.updatePersistent();
      const writes = stdoutWrite.mock.calls.map(a => String(a[0]));
      expect(writes.join("")).toContain("updated");
    });

    it("active is false by default", () => {
      expect(bar.active).toBe(false);
    });

    it("stop sets active to false", () => {
      bar.stop();
      expect(bar.active).toBe(false);
    });
  });
});
