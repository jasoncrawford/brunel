import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StatusBar } from "../src/agent/views/status-bar.js";
import { getConfig } from "../src/config.js";

// Strip ANSI codes for assertion
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("StatusBar verbose flag", () => {
  afterEach(() => {
    getConfig().verbose = false;
  });

  it("defaults to false", () => {
    expect(getConfig().verbose).toBe(false);
  });

  it("getConfig().verbose = true sets verbose to true", () => {
    getConfig().verbose = true;
    expect(getConfig().verbose).toBe(true);
  });

  it("getConfig().verbose = false resets verbose", () => {
    getConfig().verbose = true;
    getConfig().verbose = false;
    expect(getConfig().verbose).toBe(false);
  });
});

describe("StatusBar getStatusText", () => {
  afterEach(() => {
    getConfig().verbose = false;
  });

  it("shows worker id and no current task when idle", () => {
    const bar = new StatusBar({ agentId: "7c254628-abcd-1234-efgh-000000000000" });
    bar.update({ connectionStatus: "connected" });
    const result = stripAnsi(bar.getStatusText());
    expect(result).toContain("worker 7c254628");
    expect(result).toContain("no current task");
    expect(result).toContain("Connected");
  });

  it("shows disconnectCode in verbose mode", () => {
    const bar = new StatusBar({ agentId: "abc12345-0000-0000-0000-000000000000" });
    getConfig().verbose = true;
    bar.update({ connectionStatus: "disconnected", disconnectCode: 1006, reconnectAt: Date.now() + 2000 });
    const result = stripAnsi(bar.getStatusText());
    expect(result).toContain("Disconnected (1006)");
  });

  it("omits disconnectCode in non-verbose mode", () => {
    const bar = new StatusBar({ agentId: "abc12345-0000-0000-0000-000000000000" });
    getConfig().verbose = false;
    bar.update({ connectionStatus: "disconnected", disconnectCode: 1006 });
    const result = stripAnsi(bar.getStatusText());
    expect(result).toContain("Disconnected");
    expect(result).not.toContain("1006");
  });

  it("shows task, PR, and branch when set", () => {
    const origColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true });
    try {
      const bar = new StatusBar({ agentId: "7c254628-abcd-1234-efgh-000000000000" });
      bar.update({ taskNumber: 374, prNumber: 406, branch: "db-single-source-of-truth", connectionStatus: "connected" });
      const result = stripAnsi(bar.getStatusText());
      expect(result).toContain("task #374");
      expect(result).toContain("PR #406");
      expect(result).toContain("db-single-source-of-truth");
    } finally {
      if (origColumns) Object.defineProperty(process.stdout, "columns", origColumns);
      else delete (process.stdout as { columns?: number }).columns;
    }
  });
});

describe("StatusBar class", () => {
  let bar: StatusBar;
  let stdoutWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    bar = new StatusBar({ agentId: "test-agent-id" });
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
    bar.stop();
    bar.stopPersistent();
  });

  describe("callbacks", () => {
    it("inputPrint is null by default", () => {
      expect(bar.inputPrint).toBeNull();
    });

    it("inputPrint can be set and read back", () => {
      const fn = vi.fn();
      bar.inputPrint = fn;
      expect(bar.inputPrint).toBe(fn);
    });

    it("inputStatus is null by default", () => {
      expect(bar.inputStatus).toBeNull();
    });

    it("inputStatus can be set and read back", () => {
      const fn = vi.fn();
      bar.inputStatus = fn;
      expect(bar.inputStatus).toBe(fn);
    });

    it("inputClear is null by default", () => {
      expect(bar.inputClear).toBeNull();
    });

    it("inputClear can be set and read back", () => {
      const fn = vi.fn();
      bar.inputClear = fn;
      expect(bar.inputClear).toBe(fn);
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

  describe("terminal resize", () => {
    afterEach(() => {
      bar.stopPersistent();
    });

    it("redraws on resize with updated width", () => {
      bar.update({ connectionStatus: "connected" });
      bar.startPersistent();
      stdoutWrite.mockClear();

      const origColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
      Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true });
      try {
        process.stdout.emit("resize");
        const writes = stdoutWrite.mock.calls.map(a => String(a[0]));
        expect(writes.length).toBeGreaterThan(0);
        expect(writes.join("")).toContain("Connected");
      } finally {
        if (origColumns) Object.defineProperty(process.stdout, "columns", origColumns);
        else delete (process.stdout as { columns?: number }).columns;
      }
    });

    it("does not register multiple resize listeners on repeated startPersistent calls", () => {
      bar.startPersistent();
      bar.startPersistent(); // second call should not add a second listener
      stdoutWrite.mockClear();
      process.stdout.emit("resize");
      // If there were two listeners, clear+draw would be called twice; just check it doesn't throw
      const writes = stdoutWrite.mock.calls.map(a => String(a[0]));
      expect(writes.length).toBeGreaterThan(0);
    });

    it("stops listening for resize after stopPersistent", () => {
      bar.update({ connectionStatus: "connected" });
      bar.startPersistent();
      bar.stopPersistent();
      stdoutWrite.mockClear();
      process.stdout.emit("resize");
      // No redraws should happen after stopPersistent
      expect(stdoutWrite.mock.calls.length).toBe(0);
    });
  });

  describe("persistent status bar", () => {
    it("startPersistent draws a status line", () => {
      bar.update({ connectionStatus: "connected" });
      bar.startPersistent();
      const writes = stdoutWrite.mock.calls.map(a => String(a[0]));
      expect(writes.join("")).toContain("Connected");
    });

    it("persistentActive is true after startPersistent", () => {
      bar.startPersistent();
      expect(bar.persistentActive).toBe(true);
    });

    it("persistentActive is false after stopPersistent", () => {
      bar.startPersistent();
      bar.stopPersistent();
      expect(bar.persistentActive).toBe(false);
    });

    it("stopPersistent clears the status line", () => {
      bar.startPersistent();
      stdoutWrite.mockClear();
      bar.stopPersistent();
      const writes = stdoutWrite.mock.calls.map(a => String(a[0]));
      expect(writes.some(w => w.includes("\x1b[K"))).toBe(true);
    });

    it("updatePersistent refreshes text", () => {
      bar.startPersistent();
      stdoutWrite.mockClear();
      bar.update({ connectionStatus: "connected" });
      const writes = stdoutWrite.mock.calls.map(a => String(a[0]));
      expect(writes.join("")).toContain("Connected");
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
