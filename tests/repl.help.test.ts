import { describe, it, expect } from "vitest";
import { formatHelp, type CommandEntry } from "../src/agent/controllers/command-controller.js";

function makeEntry(name: string, description: string, extra: Partial<CommandEntry> = {}): CommandEntry {
  return { name, description, handler: async () => {}, ...extra };
}

// ── formatHelp — no namespace ─────────────────────────────────────────────────

describe("formatHelp — no namespace", () => {
  const entries: CommandEntry[] = [
    makeEntry("clear",              "Clear the conversation"),
    makeEntry("exit",               "Exit (alias: quit)", { aliases: ["quit"] }),
    makeEntry("quit",               "Exit (alias for exit)",  { aliasFor: "exit" }),
    makeEntry("help",               "Show available commands"),
    makeEntry("worker:complete",    "Mark the current task as done", { aliases: ["worker:done"] }),
    makeEntry("worker:done",        "Mark the current task as done (alias for worker:complete)", { aliasFor: "worker:complete" }),
    makeEntry("worker:start",       "Connect to the foreman"),
    makeEntry("workspace:create",   "Create an isolated git checkout"),
    makeEntry("workspace:reset",    "Reset to clean main branch"),
  ];

  it("includes root-level canonical commands", () => {
    const text = formatHelp(entries);
    expect(text).toContain("/clear");
    expect(text).toContain("/exit");
    expect(text).toContain("/help");
  });

  it("excludes alias entries from the listing", () => {
    const text = formatHelp(entries);
    // /quit is an alias for exit — should not appear as a top-level command
    const lines = text.split("\n");
    expect(lines.some(l => l.match(/^\s+\/quit\s/))).toBe(false);
    // /worker:done is an alias — should not appear as a top-level entry
    expect(lines.some(l => l.match(/^\s+\/worker:done\s/))).toBe(false);
  });

  it("lists namespaces in a Namespaces section", () => {
    const text = formatHelp(entries);
    expect(text).toContain("worker");
    expect(text).toContain("workspace");
    expect(text).toContain("Namespaces:");
  });

  it("shows namespace command counts", () => {
    const text = formatHelp(entries);
    // worker has 2 canonical commands (complete, start); workspace has 2
    expect(text).toMatch(/worker\s+.*2 command/);
    expect(text).toMatch(/workspace\s+.*2 command/);
  });

  it("includes hint to use /help <namespace>", () => {
    const text = formatHelp(entries);
    expect(text).toContain("/help <namespace>");
  });

  it("root commands are sorted alphabetically", () => {
    const text = formatHelp(entries);
    const clearPos   = text.indexOf("/clear");
    const exitPos    = text.indexOf("/exit");
    const helpPos    = text.indexOf("/help");
    expect(clearPos).toBeLessThan(exitPos);
    expect(exitPos).toBeLessThan(helpPos);
  });

  it("includes command descriptions", () => {
    const text = formatHelp(entries);
    expect(text).toContain("Clear the conversation");
  });
});

// ── formatHelp — with namespace ───────────────────────────────────────────────

describe("formatHelp — with namespace", () => {
  const entries: CommandEntry[] = [
    makeEntry("clear",            "Clear the conversation"),
    makeEntry("workspace:create", "Create an isolated git checkout"),
    makeEntry("workspace:reset",  "Reset to clean main branch"),
    makeEntry("workspace:remove", "Remove the checkout"),
    makeEntry("worker:start",     "Connect to the foreman"),
    makeEntry("worker:complete",  "Mark the current task as done", { aliases: ["worker:done"] }),
    makeEntry("worker:done",      "Mark done (alias for worker:complete)", { aliasFor: "worker:complete" }),
  ];

  it("shows only commands in the given namespace", () => {
    const text = formatHelp(entries, "workspace");
    expect(text).toContain("/workspace:create");
    expect(text).toContain("/workspace:reset");
    expect(text).toContain("/workspace:remove");
    expect(text).not.toContain("/worker:");
    expect(text).not.toContain("/clear");
  });

  it("excludes alias entries from namespace listing", () => {
    const text = formatHelp(entries, "worker");
    expect(text).toContain("/worker:complete");
    const lines = text.split("\n");
    expect(lines.some(l => l.match(/^\s+\/worker:done\s/))).toBe(false);
  });

  it("includes descriptions for namespace commands", () => {
    const text = formatHelp(entries, "workspace");
    expect(text).toContain("Create an isolated git checkout");
  });

  it("shows a header naming the namespace", () => {
    const text = formatHelp(entries, "workspace");
    expect(text).toMatch(/workspace/i);
  });

  it("returns a 'no commands' message for unknown namespace", () => {
    const text = formatHelp(entries, "nonexistent");
    expect(text).toContain("nonexistent");
    expect(text).toMatch(/no commands/i);
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
    expect(text).toContain("worker");
    expect(text).not.toContain("Commands:\n"); // no root section
  });

  it("singular 'command' for namespace with exactly one command", () => {
    const entries = [makeEntry("worker:start", "Connect")];
    const text = formatHelp(entries);
    expect(text).toMatch(/1 command[^s]/);
  });
});
