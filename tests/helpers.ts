import type { CommandController } from "../src/agent/controllers/command-controller.js";
import type { WorkerDisplay } from "../src/agent/controllers/worker-controller.js";

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
 * Workspace commands use WorkspaceController (real descriptions, real handler logic).
 * Returns the populated CommandController for use in tests.
 * Call this in beforeEach for tests that query the command registry.
 */
export async function registerTestCommands(): Promise<CommandController> {
  const { CommandRegistry, CommandController } = await import("../src/agent/controllers/command-controller.js");
  const { WorkspaceController } = await import("../src/agent/controllers/workspace-controller.js");
  const registry = new CommandRegistry();
  const controller = new CommandController(registry);
  const noopDisplay = { print: () => {}, printForemanMessage: () => {} } as WorkerDisplay;
  new WorkspaceController(undefined, noopDisplay, { verbose: false }).registerCommands(registry.scoped("workspace"));
  const noop = async () => {};
  registry.register("clear",  { description: "Clear the conversation", handler: noop });
  registry.register("settings", { description: "View and edit all settings", handler: noop });
  const settingsRegistry = registry.scoped("settings");
  settingsRegistry.register("model",          { description: "Select the Claude model to use", handler: noop });
  settingsRegistry.register("effort",         { description: "Set the effort level for Claude's thinking", handler: noop });
  settingsRegistry.register("permissions",    { description: "Set the permission mode for tool use", handler: noop });
  settingsRegistry.register("verbose",        { description: "Set verbose output mode", handler: noop });
  settingsRegistry.register("think-out-loud", { description: "Set think-out-loud mode", handler: noop });
  registry.register("version", { description: "Print version information", handler: noop });
  registry.register("help", { description: "List available commands", handler: noop });
  registry.register("exit", { description: "Exit", aliases: ["quit"], handler: noop });
  const workerRegistry = registry.scoped("worker");
  workerRegistry.register("start",         { description: "Start accepting tasks from the foreman", handler: noop });
  workerRegistry.register("stop",          { description: "Disconnect from the foreman", handler: noop });
  workerRegistry.register("claim",         { description: "Claim a specific task by ID", handler: noop });
  workerRegistry.register("complete",      { description: "Mark the current task as done", aliases: ["done"], handler: async () => "task-complete" });
  workerRegistry.register("resume-events", { description: "Resume processing of GitHub events", handler: noop });
  return controller;
}
