import { describe, it, expect, beforeEach } from "vitest";
import { formatHelp, type CommandEntry } from "../src/agent/controllers/command-controller.js";
import { registerTestCommands } from "./helpers.js";

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

// ── formatHelp — layout ───────────────────────────────────────────────────────

describe("formatHelp — layout", () => {
  it("starts with a blank line", () => {
    const text = formatHelp(ENTRIES);
    expect(text.startsWith("\n")).toBe(true);
  });

  it("has a 'commands:' header above root commands", () => {
    const text = formatHelp(ENTRIES);
    expect(text).toContain("commands:");
    // header appears before the root command lines
    const headerPos  = text.indexOf("commands:");
    const clearPos   = text.indexOf("/clear");
    expect(headerPos).toBeLessThan(clearPos);
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
    const clearPos  = text.indexOf("/clear");
    const workerPos = text.indexOf("worker:");
    expect(clearPos).toBeLessThan(workerPos);
  });

  it("excludes alias entries from the listing", () => {
    const text = formatHelp(ENTRIES);
    const lines = text.split("\n");
    expect(lines.some(l => l.match(/^\s+\/quit\s/))).toBe(false);
    expect(lines.some(l => l.match(/^\s+\/worker:done\s/))).toBe(false);
  });

  it("preserves registration order for root commands", () => {
    const text = formatHelp(ENTRIES);
    const clearPos = text.indexOf("/clear");
    const exitPos  = text.indexOf("/exit");
    const helpPos  = text.indexOf("/help");
    expect(clearPos).toBeLessThan(exitPos);
    expect(exitPos).toBeLessThan(helpPos);
  });

  it("preserves registration order within namespaces", () => {
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

// ── Root command registration order ──────────────────────────────────────────

describe("root command registration order", () => {
  let helpText: string;

  beforeEach(async () => {
    const controller = await registerTestCommands();
    helpText = formatHelp(controller.registry.listAll());
  });

  it("/version appears before /help in the root commands section", () => {
    const versionPos = helpText.indexOf("/version");
    const helpPos    = helpText.indexOf("/help");
    expect(versionPos).toBeGreaterThan(0);
    expect(helpPos).toBeGreaterThan(versionPos);
  });

  it("/exit appears after /help in the root commands section", () => {
    const helpPos = helpText.indexOf("/help");
    const exitPos = helpText.indexOf("/exit");
    expect(helpPos).toBeGreaterThan(0);
    expect(exitPos).toBeGreaterThan(helpPos);
  });
});

// ── Worker command registration order ─────────────────────────────────────────

describe("worker command registration order", () => {
  let helpText: string;

  beforeEach(async () => {
    const controller = await registerTestCommands();
    helpText = formatHelp(controller.registry.listAll());
  });

  it("worker:start appears before worker:stop", () => {
    expect(helpText.indexOf("/worker:start")).toBeLessThan(helpText.indexOf("/worker:stop"));
  });

  it("worker:stop appears before worker:claim", () => {
    expect(helpText.indexOf("/worker:stop")).toBeLessThan(helpText.indexOf("/worker:claim"));
  });

  it("worker:claim appears before worker:complete", () => {
    expect(helpText.indexOf("/worker:claim")).toBeLessThan(helpText.indexOf("/worker:complete"));
  });

  it("worker:complete appears before worker:resume-events", () => {
    expect(helpText.indexOf("/worker:complete")).toBeLessThan(helpText.indexOf("/worker:resume-events"));
  });
});
