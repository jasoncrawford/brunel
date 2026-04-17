import type { CommandController } from "../src/agent/controllers/command-controller.js";

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
 * Returns the populated CommandController for use in tests.
 * Call this in beforeEach for tests that query the command registry.
 */
export async function registerTestCommands(): Promise<CommandController> {
  const { CommandController } = await import("../src/agent/controllers/command-controller.js");
  const { registerWorkspaceCommands } = await import("../src/agent/controllers/workspace-controller.js");
  const registry = new CommandController();
  const noopDisplay = { print: () => {}, printForemanMessage: () => {} };
  registerWorkspaceCommands(undefined, registry.scoped("workspace"), noopDisplay);
  const noop = async () => {};
  registry.register("exit",   { description: "Exit", handler: noop });
  registry.register("clear",  { description: "Clear the conversation", handler: noop });
  registry.register("model",  { description: "Select the Claude model to use", handler: noop });
  registry.register("effort", { description: "Set the effort level for Claude's thinking", handler: noop });
  registry.scoped("worker").register("complete", {
    description: "Mark the current task as done",
    handler: async () => "task-complete",
  });
  return registry;
}
