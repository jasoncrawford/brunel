import { describe, it, expect } from "vitest";
import { formatHelp, type CommandEntry } from "../src/agent/controllers/command-controller.js";

function makeEntry(name: string, description: string, extra: Partial<CommandEntry> = {}): CommandEntry {
  return { name, description, handler: async () => {}, ...extra };
}

const ENTRIES: CommandEntry[] = [
  makeEntry("clear",            "Clear the conversation"),
  makeEntry("exit",             "Exit (alias: quit)", { aliases: ["quit"] }),
  makeEntry("quit",             "Exit (alias for exit)", { aliasFor: "exit" }),
  makeEntry("help",             "List available commands"),
  makeEntry("worker:complete",  "Mark the current task as done", { aliases: ["worker:done"] }),
  makeEntry("worker:done",      "Mark done (alias for worker:complete)", { aliasFor: "worker:complete" }),
  makeEntry("worker:start",     "Connect to the foreman"),
  makeEntry("workspace:create", "Create an isolated git checkout"),
  makeEntry("workspace:reset",  "Reset to clean main branch"),
];

// ── formatHelp — no namespace (show all) ──────────────────────────────────────

describe("formatHelp — no namespace", () => {
  it("starts with a blank line", () => {
    const text = formatHelp(ENTRIES);
    expect(text.startsWith("\n")).toBe(true);
  });

  it("includes root-level canonical commands", () => {
    const text = formatHelp(ENTRIES);
    expect(text).toContain("/clear");
    expect(text).toContain("/exit");
    expect(text).toContain("/help");
  });

  it("includes namespace commands in the same output", () => {
    const text = formatHelp(ENTRIES);
    expect(text).toContain("/worker:complete");
    expect(text).toContain("/workspace:create");
  });

  it("shows each namespace as its own labeled section", () => {
    const text = formatHelp(ENTRIES);
    expect(text).toContain("worker:");
    expect(text).toContain("workspace:");
  });

  it("root commands appear before namespace sections", () => {
    const text = formatHelp(ENTRIES);
    const clearPos    = text.indexOf("/clear");
    const workerPos   = text.indexOf("worker:");
    expect(clearPos).toBeLessThan(workerPos);
  });

  it("excludes alias entries from the listing", () => {
    const text = formatHelp(ENTRIES);
    const lines = text.split("\n");
    // /quit is an alias for exit — should not appear as a top-level command
    expect(lines.some(l => l.match(/^\s+\/quit\s/))).toBe(false);
    // /worker:done is an alias — should not appear as a section entry
    expect(lines.some(l => l.match(/^\s+\/worker:done\s/))).toBe(false);
  });

  it("preserves registration order for root commands (no alphabetizing)", () => {
    // Registration order: clear, exit, help — so clear before exit before help
    const text = formatHelp(ENTRIES);
    const clearPos = text.indexOf("/clear");
    const exitPos  = text.indexOf("/exit");
    const helpPos  = text.indexOf("/help");
    expect(clearPos).toBeLessThan(exitPos);
    expect(exitPos).toBeLessThan(helpPos);
  });

  it("preserves registration order within namespaces", () => {
    // worker:complete registered before worker:start
    const text = formatHelp(ENTRIES);
    const completePos = text.indexOf("/worker:complete");
    const startPos    = text.indexOf("/worker:start");
    expect(completePos).toBeLessThan(startPos);
  });

  it("includes command descriptions", () => {
    const text = formatHelp(ENTRIES);
    expect(text).toContain("Clear the conversation");
    expect(text).toContain("Mark the current task as done");
  });

  it("includes footer with README link", () => {
    const text = formatHelp(ENTRIES);
    expect(text).toContain("README:");
    expect(text).toContain("https://github.com/jasoncrawford/brunel#readme");
  });

  it("includes dashboard URL when provided", () => {
    const text = formatHelp(ENTRIES, { dashboardUrl: "https://brunel.dev" });
    expect(text).toContain("Foreman dashboard: https://brunel.dev");
  });

  it("omits dashboard line when dashboardUrl not provided", () => {
    const text = formatHelp(ENTRIES);
    expect(text).not.toContain("Foreman dashboard:");
  });
});

// ── formatHelp — with namespace ───────────────────────────────────────────────

describe("formatHelp — with namespace", () => {
  it("starts with a blank line", () => {
    const text = formatHelp(ENTRIES, { namespace: "workspace" });
    expect(text.startsWith("\n")).toBe(true);
  });

  it("shows only commands in the given namespace", () => {
    const text = formatHelp(ENTRIES, { namespace: "workspace" });
    expect(text).toContain("/workspace:create");
    expect(text).toContain("/workspace:reset");
    expect(text).not.toContain("/worker:");
    expect(text).not.toContain("/clear");
  });

  it("excludes alias entries from namespace listing", () => {
    const text = formatHelp(ENTRIES, { namespace: "worker" });
    expect(text).toContain("/worker:complete");
    const lines = text.split("\n");
    expect(lines.some(l => l.match(/^\s+\/worker:done\s/))).toBe(false);
  });

  it("includes descriptions for namespace commands", () => {
    const text = formatHelp(ENTRIES, { namespace: "workspace" });
    expect(text).toContain("Create an isolated git checkout");
  });

  it("returns a 'no commands' message for unknown namespace", () => {
    const text = formatHelp(ENTRIES, { namespace: "nonexistent" });
    expect(text).toContain("nonexistent");
    expect(text).toMatch(/no commands/i);
  });

  it("includes footer with README link", () => {
    const text = formatHelp(ENTRIES, { namespace: "workspace" });
    expect(text).toContain("README:");
    expect(text).toContain("https://github.com/jasoncrawford/brunel#readme");
  });

  it("includes dashboard URL when provided", () => {
    const text = formatHelp(ENTRIES, { namespace: "workspace", dashboardUrl: "https://brunel.dev" });
    expect(text).toContain("Foreman dashboard: https://brunel.dev");
  });
});

// ── formatHelp — edge cases ───────────────────────────────────────────────────

describe("formatHelp — edge cases", () => {
  it("handles empty entry list", () => {
    const text = formatHelp([]);
    expect(typeof text).toBe("string");
  });

  it("handles only namespace commands (no root commands)", () => {
    const entries = [
      makeEntry("worker:start", "Connect"),
      makeEntry("worker:stop",  "Disconnect"),
    ];
    const text = formatHelp(entries);
    expect(text).toContain("worker:");
    expect(text).toContain("/worker:start");
  });
});
