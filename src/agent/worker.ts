import { exec } from "node:child_process";
import { randomInt } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { WebSocket } from "ws";
import * as display from "./display.js";
import { StatusBar, statusBar } from "./status-bar.js";
import { setVerbose } from "./display.js";
import { buildInitialPrompt, buildEventPrompt } from "./worker-prompts.js";
import type { EffortValue } from "./settings.js";
import * as Wire from "../../shared/wire.js";
import { Workspace, confirmIfUnsafe } from "./workspace.js";
import { fmtError } from "../utils.js";
import type { CommandRegistry } from "./command-registry.js";
import { pick } from "./input.js";

const execAsync = promisify(exec);

// ── Agent ID generation ────────────────────────────────────────────────────────

const WORKER_NAMES = [
  "abner", "adelaide", "albert", "alden", "alfred", "amelia", "amity", "amos",
  "andrew", "arthur", "asa", "augustus", "aurelia", "beatrice", "benjamin",
  "boaz", "caleb", "calvin", "cassandra", "cassius", "cecilia", "charity",
  "charlotte", "chauncey", "clara", "clarence", "clement", "constance",
  "cornelius", "cressida", "daniel", "deliverance", "dinah", "ebenezer",
  "edmund", "edwin", "eleanor", "elihu", "endeavour", "ephraim", "ernest",
  "esther", "experience", "ezekiel", "faith", "felicity", "frances",
  "franklin", "frederick", "gideon", "grace", "harold", "harriet", "henry",
  "herbert", "hezekiah", "hiram", "honour", "hope", "horatio", "humility",
  "ichabod", "increase", "jedediah", "jeremiah", "jethro", "josephine",
  "justice", "lavinia", "lawrence", "lemuel", "levi", "lucius", "lydia",
  "mabel", "martha", "matilda", "mercy", "micah", "miles", "naomi", "obadiah",
  "oliver", "parthenia", "patience", "peregrine", "perseverance", "philip",
  "phineas", "priscilla", "prosper", "prudence", "resolve", "rosalind",
  "roscoe", "rufus", "rupert", "ruth", "silas", "simon", "susannah", "tabitha",
  "temperance", "thaddeus", "thankful", "theodore", "theophilus", "titus",
  "tobias", "verity", "victor", "violet", "warren", "zephaniah",
];

/** Generate a human-readable agent ID by prepending a random human name to a UUID.
 * E.g. "patience-a9bdda00-1234-5678-abcd-ef0123456789" */
export function generateAgentId(): string {
  const idx = randomInt(WORKER_NAMES.length);
  return `${WORKER_NAMES[idx]}-${crypto.randomUUID()}`;
}

// ── Event classification ───────────────────────────────────────────────────────

export function classifyEvent(event: Wire.WebhookEvent): "actionable" | "log_only" {
  const action = event.payload["action"] as string | undefined;

  switch (event.name) {
    case "check_run":
      return "log_only";

    case "check_suite": {
      if (action !== "completed") return "log_only";
      const conclusion = (event.payload.check_suite as Record<string, unknown> | undefined)?.conclusion;
      return conclusion === "skipped" ? "log_only" : "actionable";
    }

    case "pull_request":
      return (action === "closed" || action === "auto_merge_enabled") ? "actionable" : "log_only";

    case "pull_request_review":
    case "pull_request_review_comment":
      return "actionable";

    case "issue_comment": {
      const body = (event.payload.comment as Record<string, unknown> | undefined)?.body;
      if (typeof body === "string" && body.startsWith("<!-- railway-bot-comment")) return "log_only";
      return "actionable";
    }

    default:
      return "log_only";
  }
}

// ── Debounce duration ──────────────────────────────────────────────────────────

export function debounceMs(events: Wire.WebhookEvent[]): number {
  if (events.some(e => e.name === "pull_request" && e.payload["action"] === "closed")) {
    return 0;
  }
  if (events.some(e => {
    if (e.name !== "check_suite") return false;
    const conclusion = (e.payload.check_suite as Record<string, unknown> | undefined)?.conclusion as string | undefined;
    return conclusion === "failure" || conclusion === "action_required";
  })) {
    return 3000;
  }
  if (events.length > 0 && events.every(e => e.name === "check_suite")) {
    return 30000;
  }
  return 3000;
}

// ── WorkerSession ─────────────────────────────────────────────────────────────

export type WsFactory = (agentId: string, taskId?: string) => WebSocket;
export type RunQuery = (prompt: string, sessionId: string | undefined, abortController?: AbortController, model?: string, effort?: EffortValue) => Promise<string | undefined>;
export type WorkerDisplay = {
  print: (line: string | null) => void;
  printForemanMessage: (msg: Wire.ForemanMessage) => void;
};

export type WorkerSessionOptions = {
  afterTask?: () => Promise<void>;
  workspace?: Workspace;
  /** Interval in ms between worker-sent pings. Dead connections are detected after
   * one interval with no pong. Default is set in the config schema (pingIntervalMs). */
  pingIntervalMs?: number;
};

/** Configuration for starting the worker process. */
export type WorkerModeConfig = {
  foremanUrl: string;
  workspaceDir?: string;
  githubToken: string;
  githubRepo: string;
  repoUrl?: string;
  verbose: boolean;
  logFile: string;
  model?: string;
  effort?: EffortValue;
  pingIntervalMs: number;
};

// Sentinel: a prompt is ready for main() to execute
export const WS_PROMPT = "__ws_prompt__";
// Sentinel: a fatal foreman error was received; main() should drop back to interactive REPL
export const WS_FATAL = "__ws_fatal__";

/** A prompt queued by WorkerSession for main() to execute. */
export type QueuedPrompt = { prompt: string; fresh: boolean };

// Messages that must wait for hello_ack before being sent.
type BufferableMessage = Extract<Wire.WorkerMessage, { type: "task_complete" }>;

/**
 * WebSocket client and task lifecycle manager. WorkerSession owns the foreman
 * connection, handshake protocol, task state, event debouncing, and prompt
 * queuing. It does NOT execute queries — instead it queues prompts for main()
 * to run via the RunQuery function injected there.
 *
 * When a task is assigned or a debounced event fires, WorkerSession pushes a
 * QueuedPrompt and signals main()'s ask() loop via the WS_PROMPT sentinel.
 * main() drains the queue by calling takeNextPrompt() and running each prompt.
 */
export class WorkerSession {
  private currentTaskId: string | undefined;
  private currentIssue: Wire.TaskIssue | undefined;
  private pendingEvents: Wire.WebhookEvent[] = [];
  private pendingPrompts: QueuedPrompt[] = [];
  private ws: WebSocket | undefined;
  private resolveWsInput: ((v: string) => void) | null = null;
  private currentAc: AbortController | null = null;
  private _queryRunning = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private prIsClosed = false;
  private _resetPromise: Promise<void> | null = null;
  private stopped = false;
  // Handshake lifecycle: "registered" = hello_ack received (or initial state);
  // "hello_sent" = worker_hello was sent but hello_ack not yet received.
  // Initialized to "registered" so sessions that never emit "open" (e.g. tests)
  // behave as if already registered.
  private connectionState: "hello_sent" | "registered" = "registered";
  private bufferedMessages: BufferableMessage[] = [];

  constructor(
    private statusBar: StatusBar,
    private wsFactory: WsFactory,
    private display: WorkerDisplay,
    private options: WorkerSessionOptions = {},
  ) {}

  get agentId(): string { return this.statusBar.agentId; }

  /** Returns the formatted worker status bar text. Used by tests. */
  getStatusText(): string {
    return this.statusBar.getStatusText();
  }

  private async refreshBranch(): Promise<void> {
    let branch = "";
    try {
      const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD");
      branch = stdout.trim();
    } catch {
      branch = "";
    }
    this.statusBar.update({ branch });
  }

  start(): void {
    this.statusBar.startPersistent();
    this.statusBar.setOnToolResult((toolName) => {
      // Refresh the branch display after each Bash tool completes so the status
      // bar reflects branch changes (e.g. git checkout) without waiting for the
      // full query to finish.
      if (toolName === "Bash") void this.refreshBranch();
    });
    void this.refreshBranch();
    this.connect();
  }

  /**
   * Called by main() just before executing a prompt. Stores the AbortController
   * so interrupt() can abort it, marks the query as running (suppressing the
   * debounce timer from firing a redundant signal), and cancels any pending
   * debounce (those events will drain into the queue via notifyQueryEnd()).
   */
  notifyQueryStart(ac: AbortController): void {
    this.currentAc = ac;
    this._queryRunning = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Called by main() after a prompt finishes (or is interrupted). Clears the
   * AbortController, drains any pending events into the prompt queue (unless
   * the query was aborted, which signals the user interrupted), and refreshes
   * the branch display.
   */
  notifyQueryEnd(aborted = false): void {
    this.currentAc = null;
    this._queryRunning = false;
    if (!aborted && this.pendingEvents.length > 0 && this.currentTaskId && this.currentIssue) {
      const events = this.pendingEvents.splice(0);
      this.enqueuePrompt(this.buildAndLogEventPrompt(events), false);
    }
    void this.refreshBranch();
  }

  /** Returns true if there are queued prompts for main() to execute. */
  hasPendingPrompts(): boolean {
    return this.pendingPrompts.length > 0;
  }

  /** Dequeues and returns the next prompt, or undefined if empty. */
  takeNextPrompt(): QueuedPrompt | undefined {
    return this.pendingPrompts.shift();
  }

  /**
   * Complete the current task: call afterTask hook, send task_complete, reset state.
   * Returns 'task-complete' if a task was active, undefined if no task was assigned.
   */
  async completeCurrentTask(): Promise<"task-complete" | undefined> {
    if (!this.currentTaskId) return undefined;
    if (this.options.afterTask) {
      try { await this.options.afterTask(); } catch (err) {
        // Log but don't abort — the task IS complete even if workspace cleanup fails.
        // Returning early here would leave the task stuck on the foreman forever.
        this.display.print(display.c.amber(`afterTask failed: ${fmtError(err)}`));
      }
    }
    this.sendTaskMessage({
      type: "task_complete",
      workerId: this.statusBar.agentId,
      taskId: this.currentTaskId,
    });
    this.currentTaskId = undefined;
    this.currentIssue = undefined;
    this.statusBar.update({ taskNumber: undefined, prNumber: undefined, branch: "" });
    this.display.print(display.c.sageGreen("Task complete. Waiting for next task..."));
    return "task-complete";
  }

  /** Returns the workspace for use with registerWorkspaceCommands(). */
  get workspace(): Workspace | undefined {
    return this.options.workspace;
  }

  /**
   * Create a one-shot promise that resolves with WS_PROMPT when a queued prompt
   * is ready for main() to execute. If prompts are already queued, resolves
   * immediately. Each call replaces the previous unresolved promise.
   */
  createWsInputPromise(): Promise<string> {
    if (this.pendingPrompts.length > 0) {
      return Promise.resolve(WS_PROMPT);
    }
    return new Promise<string>((resolve) => {
      this.resolveWsInput = resolve;
    });
  }

  /**
   * Abort the currently running query, if any.
   * Returns true if a query was aborted, false if no query was running.
   * Called by the SIGINT handler so ^C interrupts the current query
   * rather than shutting down the worker.
   */
  interrupt(): boolean {
    if (this.currentAc) {
      this.currentAc.abort();
      return true;
    }
    return false;
  }

  /**
   * Send worker_goodbye to the foreman if the WebSocket is currently open.
   * Called before clean exits (SIGTERM, /quit) so the foreman can immediately
   * revert the task to pending without waiting for the reclaim timeout.
   */
  sendGoodbye(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "worker_goodbye",
        workerId: this.statusBar.agentId,
        taskId: this.currentTaskId,
      }));
    }
  }

  /**
   * Returns true if the input string is a sentinel emitted by WorkerSession
   * to signal that a queued prompt is ready. Used by main() to detect WS
   * notifications without needing to know the internal sentinel value.
   */
  static isWsSignal(input: string): boolean {
    return input === WS_PROMPT;
  }

  /**
   * Returns true if the input string is the fatal-error sentinel emitted by
   * WorkerSession when a fatal foreman_error is received. Used by main() to
   * drop back to interactive REPL mode without exiting the process.
   */
  static isFatalSignal(input: string): boolean {
    return input === WS_FATAL;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Push a prompt to the queue and signal main()'s ask() loop via WS_PROMPT.
   * fresh=true means main() should reset its sessionId (new task conversation).
   */
  private enqueuePrompt(prompt: string, fresh: boolean): void {
    this.pendingPrompts.push({ prompt, fresh });
    this.resolveWsInput?.(WS_PROMPT);
    this.resolveWsInput = null;
  }

  /**
   * Send a task-scoped message to the foreman. Always buffers first, then
   * immediately flushes if the handshake is complete. This way the buffer
   * is the single code path regardless of connection state.
   */
  private sendTaskMessage(msg: BufferableMessage): void {
    this.bufferedMessages.push(msg);
    this.flushBuffer();
  }

  /**
   * Send all buffered messages if registered and the socket is open.
   * No-ops if the handshake is still pending or the socket is not ready.
   */
  private flushBuffer(): void {
    if (this.connectionState !== "registered") return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const pending = this.bufferedMessages.splice(0);
    for (const m of pending) {
      this.ws.send(JSON.stringify(m));
    }
  }

  private connect(): void {
    // Clearing reconnectAt stops the countdown timer in the model.
    this.statusBar.update({ connectionStatus: "reconnecting", reconnectAt: undefined });
    const ws = this.wsFactory(this.statusBar.agentId, this.currentTaskId);
    this.ws = ws;

    const pingIntervalMs = this.options.pingIntervalMs ?? 25_000;
    let isAlive = false;
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    const clearPingTimer = () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    };

    ws.on("open", () => {
      this.connectionState = "hello_sent";
      this.statusBar.update({ connectionStatus: "handshaking" });

      // Heartbeat: detect silent connection drops (network loss, laptop sleep, etc.)
      // Each tick sends a ping. If no pong/ping arrives before the next tick, the
      // connection is terminated so the status bar updates and reconnect runs.
      // Receiving any frame (pong from our ping, or ping from the foreman's heartbeat)
      // resets the timer so the next check is a full interval away.
      isAlive = true;

      const startPingTimer = () => {
        clearPingTimer();
        pingTimer = setInterval(() => {
          if (!isAlive) {
            clearPingTimer();
            ws.terminate();
            return;
          }
          isAlive = false;
          ws.ping();
        }, pingIntervalMs);
      };

      const resetLiveness = () => {
        isAlive = true;
        startPingTimer();
      };

      ws.on("pong", resetLiveness);
      ws.on("ping", resetLiveness);
      startPingTimer();
    });

    ws.on("message", (data: Buffer | string) => {
      let msg: Wire.ForemanMessage;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      this.handleMessage(msg);
    });

    ws.on("close", (code: number, _reason: Buffer) => {
      clearPingTimer(); // always clean up the ping timer when this socket closes
      if (ws !== this.ws) return; // stale close from a previous connection
      if (this.stopped) return; // fatal error received; don't reconnect
      const delay = 2000 + Math.random() * 3000;
      // Setting reconnectAt starts a 1-second countdown timer in the model.
      this.statusBar.update({
        connectionStatus: "disconnected",
        disconnectCode: code,
        reconnectAt: Date.now() + delay,
      });
      setTimeout(() => this.connect(), delay);
    });

    ws.on("error", (err: Error) => {
      if (ws !== this.ws) return; // stale error from a previous connection
      this.display.print(display.c.amber(`WebSocket error: ${err.message}`));
      // Ensure close fires even for errors that don't automatically close the socket
      // (e.g. some TLS negotiation failures on older Node.js / ws versions).
      ws.terminate();
    });
  }

  private handleMessage(msg: Wire.ForemanMessage): void {
    this.display.printForemanMessage(msg);

    if (msg.type === "foreman_error") {
      if (msg.fatal) {
        this.stopped = true;
        this.currentAc?.abort(); // abort any running query immediately
        this.ws?.close();
        this.resolveWsInput?.(WS_FATAL);
        this.resolveWsInput = null;
      }
      return;
    }

    if (msg.type === "hello_ack") {
      if (msg.status === "cancelled") {
        // Task was reassigned while worker was disconnected — stop and reset.
        this.currentAc?.abort(); // abort any running query immediately
        this.connectionState = "registered";
        this.bufferedMessages = [];
        this.pendingPrompts = [];
        this.pendingEvents = [];
        this.currentTaskId = undefined;
        this.currentIssue = undefined;
        this.statusBar.update({
          connectionStatus: "connected",
          disconnectCode: undefined,
          taskNumber: undefined,
          prNumber: undefined,
          branch: "",
        });
        this.display.print(display.c.amber("Task cancelled (reassigned to another worker)."));
        const workspace = this.options.workspace;
        if (workspace?.isCreated) {
          // Track the reset promise so that task_assigned prompts are deferred until
          // the workspace is clean — preventing a new task from running in a dirty state.
          this._resetPromise = workspace.reset().then(() => {
            this.display.print(display.c.amber("Workspace reset."));
          }).catch((err: unknown) => {
            this.display.print(display.c.boldRed(`Workspace reset failed: ${err instanceof Error ? err.message : String(err)}`));
          }).finally(() => {
            this._resetPromise = null;
          });
        }
      } else {
        // "idle" or "busy": transition to registered and flush buffered messages.
        this.connectionState = "registered";
        this.statusBar.update({ connectionStatus: "connected", disconnectCode: undefined });
        this.flushBuffer();
      }
      return;
    }

    if (msg.type === "task_assigned") {
      this.currentTaskId = msg.taskId;
      this.currentIssue = msg.issue;
      this.prIsClosed = false;
      this.statusBar.update({ taskNumber: msg.issue.number, prNumber: undefined });
      void this.refreshBranch();
      const initialPrompt = buildInitialPrompt(msg.issue, !!this.options.workspace);
      this.display.print(display.c.sageGreen(initialPrompt));
      // If a workspace reset is in progress (from a cancelled hello_ack), defer the
      // prompt until the reset finishes — otherwise the task could run in a dirty workspace.
      const enqueue = () => this.enqueuePrompt(initialPrompt, true);
      if (this._resetPromise) {
        void this._resetPromise.then(enqueue, enqueue);
      } else {
        enqueue(); // fresh=true: new task, reset session
      }
    } else if (msg.type === "event_notification") {
      // Ignore stale events forwarded for tasks we're no longer working on.
      if (msg.taskId !== this.currentTaskId) {
        this.display.print(display.c.darkGray(`[worker] ignoring event_notification for task ${msg.taskId} (current: ${this.currentTaskId ?? "none"})`));
        return;
      }

      const { event } = msg;
      const action = event.payload["action"] as string | undefined;

      // Track PR number from any pull_request event for the status bar.
      if (event.name === "pull_request") {
        const pr = event.payload["pull_request"] as { number?: number; merged?: boolean } | undefined;
        if (action === "closed" && !pr?.merged) {
          // PR was closed without merging — clear the PR from the status bar.
          this.statusBar.update({ prNumber: undefined });
        } else if (pr?.number != null) {
          this.statusBar.update({ prNumber: pr.number });
        }
      }

      if (event.name === "pull_request" && action === "closed") {
        this.prIsClosed = true;
        // process normally (cleanup prompt still fires)
      } else if (event.name === "pull_request" && action === "reopened") {
        this.prIsClosed = false;
        // process normally
      } else if (this.prIsClosed && event.name === "check_suite") {
        // Post-merge check suite: already logged via printForemanMessage; silently drop.
        return;
      }

      const classification = classifyEvent(event);
      if (classification === "log_only") {
        // Already logged via printForemanMessage above; no further action.
        return;
      }

      // Actionable event: queue it for debounced dispatch.
      this.pendingEvents.push(event);

      if (!this._queryRunning && this.currentTaskId && this.currentIssue) {
        // No query running: set up/reset debounce timer to batch rapid events.
        // When the timer fires, events are enqueued and main()'s ask() is signalled.
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          if (!this._queryRunning && this.currentTaskId && this.currentIssue) {
            const events = this.pendingEvents.splice(0);
            if (events.length > 0) {
              this.enqueuePrompt(this.buildAndLogEventPrompt(events), false);
            }
          }
          // If _queryRunning became true while debounce was pending, events stay in
          // pendingEvents to be drained by notifyQueryEnd().
        }, debounceMs(this.pendingEvents));
      }
      // If _queryRunning: events stay in pendingEvents, drained in notifyQueryEnd().
    }
  }

  private buildAndLogEventPrompt(events: Wire.WebhookEvent[]): string {
    const prompt = buildEventPrompt(events);
    this.display.print(display.c.sageGreen(prompt));
    return prompt;
  }

}

// ── Worker command registration ────────────────────────────────────────────────

/**
 * Register the worker-namespace commands into the given registry (which should
 * already be scoped, e.g. registry.scoped("worker")). Commands degrade
 * gracefully when not connected to a foreman.
 */
export function registerWorkerCommands(session: WorkerSession | undefined, registry: CommandRegistry): void {
  registry.register("complete", {
    description: "Mark the current task as done",
    handler: async () => {
      if (!session) {
        display.print(display.c.boldRed("Not connected to a foreman."));
        return undefined;
      }
      return session.completeCurrentTask();
    },
  });
}

/**
 * Set up worker mode: create the workspace, configure the WorkerSession,
 * install signal handlers, and start the session. Returns the session and
 * a cleanup function — does NOT call main(). The caller (main itself) owns
 * the query loop and calls cleanup() after the loop exits.
 */
export async function startWorkerMode(config: WorkerModeConfig): Promise<{
  session: WorkerSession;
  cleanup: () => Promise<void>;
}> {
  setVerbose(config.verbose);

  const originalCwd = process.cwd();
  const workspaceDir = config.workspaceDir ?? path.join(os.homedir(), ".brunel", "workers");
  const repoUrl = config.repoUrl ?? `https://${config.githubToken}@github.com/${config.githubRepo}.git`;

  const confirm = async (msg: string): Promise<boolean> => {
    display.print(display.c.amber(`\n⚠ Potential data loss:\n${msg}`));
    const idx = await pick(["Yes, proceed", "No, cancel"]);
    return idx === 0;
  };

  const workspace = new Workspace(workspaceDir, statusBar.agentId, repoUrl, originalCwd, confirm);
  await workspace.create();
  process.chdir(workspace.dir);

  const afterTask = async () => {
    const ok = await confirmIfUnsafe(workspace, workspace.confirm);
    if (!ok) {
      display.print(display.c.amber("Workspace reset cancelled. Task not marked complete."));
      throw new Error("cancelled");
    }
    try {
      await workspace.reset();
    } catch (err) {
      display.print(display.c.boldRed(`Workspace reset failed: ${fmtError(err)}. Task not marked complete.`));
      throw err;
    }
  };

  let shuttingDown = false;

  const wsFactory: WsFactory = (agentId, taskId) => {
    const ws = new WebSocket(`${config.foremanUrl}/worker`);
    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "worker_hello",
        workerId: agentId,
        taskId,
        status: taskId ? "busy" : "idle",
      }));
    });
    return ws;
  };

  const workerDisplay: WorkerDisplay = {
    print: display.print,
    printForemanMessage: display.printForemanMessage,
  };

  statusBar.update({ model: config.model, effort: config.effort });

  const session = new WorkerSession(statusBar, wsFactory, workerDisplay, {
    afterTask,
    workspace,
    pingIntervalMs: config.pingIntervalMs,
  });

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const ok = await confirmIfUnsafe(workspace, workspace.confirm);
    if (ok) await workspace.destroy();
    process.exit(0);
  };

  // SIGINT: interrupt the running query if one is active; otherwise prompt and shut down.
  // This lets the user press ^C to interrupt a running tool without killing the worker.
  process.on("SIGINT", () => {
    if (!session.interrupt()) {
      void shutdown();
    }
  });

  // SIGTERM is a system/orchestrator signal: send goodbye then force-destroy without prompting.
  process.on("SIGTERM", () => {
    session.sendGoodbye();
    void workspace.destroy().then(() => process.exit(0));
  });

  session.start();

  const cleanup = async () => {
    session.sendGoodbye();
    shuttingDown = true;
    const ok = await confirmIfUnsafe(workspace, workspace.confirm);
    if (ok) await workspace.destroy();
    process.stdout.write("\x1b[?2004l\r\n");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  };

  return { session, cleanup };
}
