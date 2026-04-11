import type { CommandRegistry } from "../src/agent/commands.js";

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Polls until predicate returns true, yielding to the event loop between checks. */
export async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) {
    await new Promise(r => setImmediate(r));
  }
}

/**
 * Register all standard built-in commands with minimal stubs.
 * Workspace commands use the real registerWorkspaceCommands (real descriptions, real handler logic).
 * Returns the populated CommandRegistry for use in tests.
 * Call this in beforeEach for tests that query the command registry.
 */
export async function registerTestCommands(): Promise<CommandRegistry> {
  const { CommandRegistry } = await import("../src/agent/commands.js");
  const { registerWorkspaceCommands } = await import("../src/agent/workspace.js");
  const registry = new CommandRegistry();
  registerWorkspaceCommands({
    workspace: { current: undefined },
    config: undefined,
    originalCwd: process.cwd(),
    confirm: async () => true,
  }, registry);
  const noop = async () => {};
  registry.register("exit",   { description: "Exit", handler: noop });
  registry.register("clear",  { description: "Clear the conversation", handler: noop });
  registry.register("model",  { description: "Select the Claude model to use", handler: noop });
  registry.register("effort", { description: "Set the effort level for Claude's thinking", handler: noop });
  registry.register("worker:complete", {
    description: "Mark the current task as done",
    availability: "worker",
    handler: async () => "task-complete",
  });
  return registry;
}
