import "dotenv/config";
import crypto from "crypto";
import { WebSocket } from "ws";
import * as display from "./display.js";
import { buildInitialPrompt, buildEventPrompt } from "./templates.js";
import { ask, listWorkerCommandNames, dispatchInput } from "./input.js";
import type { ForemanMessage, GitHubEvent, TaskIssue } from "./types.js";

// ── WorkerSession ─────────────────────────────────────────────────────────────

export type WsFactory = (workerId: string, taskId?: string) => WebSocket;
export type RunQuery = (prompt: string, sessionId: string | undefined) => Promise<string | undefined>;
export type WorkerDisplay = {
  print: (line: string | null) => void;
  printForemanMessage: (msg: ForemanMessage) => void;
};

// Sentinels used to signal WebSocket events through ask()'s abort param
const WS_TASK_ASSIGNED = "__task_assigned__";
const WS_EVENT = "__event__";

export class WorkerSession {
  private currentTaskId: string | undefined;
  private currentIssue: TaskIssue | undefined;
  private currentSessionId: string | undefined;
  private pendingEvents: GitHubEvent[] = [];
  private ws: WebSocket | undefined;
  private resolveWsInput: ((v: string) => void) | null = null;
  private isRunningQuery = false;

  constructor(
    private workerId: string,
    private wsFactory: WsFactory,
    private runQuery: RunQuery,
    private display: WorkerDisplay,
  ) {}

  start(): void {
    this.connect();
  }

  /**
   * Create a new one-shot promise that resolves when the WebSocket delivers
   * a task or event signal. Each call abandons the previous promise.
   */
  createWsInputPromise(): Promise<string> {
    return new Promise<string>((resolve) => {
      this.resolveWsInput = resolve;
    });
  }

  /**
   * Process a line of stdin input: slash commands and user queries.
   */
  async handleUserInput(input: string): Promise<"exit" | undefined> {
    if (!input || input === "__abort__") return;
    if (input === WS_TASK_ASSIGNED || input === WS_EVENT) return;

    const action = await dispatchInput(input);
    if (action.type === "skip") return;
    if (action.type === "exit") return "exit";
    if (action.type === "unknown_command") {
      this.display.print(display.c.boldRed(`Unknown command: /${action.command}`));
      return;
    }
    if (action.type === "task_complete") {
      await this.handleSlashCommand("/task-complete");
      return;
    }
    if (action.type === "clear") {
      await this.handleSlashCommand("/clear");
      return;
    }
    if (action.type === "query") {
      await this.runQueryLoop(action.prompt);
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private connect(): void {
    const ws = this.wsFactory(this.workerId, this.currentTaskId);
    this.ws = ws;

    ws.on("open", () => {
      this.display.print(display.c.sageGreen("  Connected to foreman."));
    });

    ws.on("message", (data: Buffer | string) => {
      let msg: ForemanMessage;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      this.handleMessage(msg);
    });

    ws.on("close", () => {
      this.display.print(display.c.amber("  Disconnected from foreman. Reconnecting..."));
      setTimeout(() => this.connect(), 3000);
    });

    ws.on("error", () => { /* close will fire */ });
  }

  private handleMessage(msg: ForemanMessage): void {
    this.display.printForemanMessage(msg);

    if (msg.type === "task_assigned") {
      this.currentTaskId = msg.taskId;
      this.currentIssue = msg.issue;
      this.currentSessionId = undefined;
      this.resolveWsInput?.(WS_TASK_ASSIGNED);
      this.resolveWsInput = null;
      void this.runQueryLoop(buildInitialPrompt(msg.issue));
    } else if (msg.type === "event_notification") {
      this.pendingEvents.push(msg.event);
      this.resolveWsInput?.(WS_EVENT);
      this.resolveWsInput = null;
      if (!this.isRunningQuery && this.currentTaskId && this.currentIssue) {
        const events = this.pendingEvents.splice(0);
        void this.runQueryLoop(buildEventPrompt(events));
      }
    }
  }

  private async runQueryLoop(initialPrompt: string): Promise<void> {
    this.isRunningQuery = true;
    try {
      this.currentSessionId = await this.runQuery(initialPrompt, this.currentSessionId) ?? this.currentSessionId;
    } finally {
      this.isRunningQuery = false;
    }

    while (this.pendingEvents.length > 0 && this.currentTaskId && this.currentIssue) {
      const events = this.pendingEvents.splice(0);
      const prompt = buildEventPrompt(events);
      this.isRunningQuery = true;
      try {
        this.currentSessionId = await this.runQuery(prompt, this.currentSessionId) ?? this.currentSessionId;
      } finally {
        this.isRunningQuery = false;
      }
    }
  }

  private async handleSlashCommand(input: string): Promise<void> {
    const command = input.slice(1).split(/\s+/)[0];

    if (command === "task-complete") {
      if (this.currentTaskId && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: "task_complete",
          workerId: this.workerId,
          taskId: this.currentTaskId,
        }));
        this.currentTaskId = undefined;
        this.currentIssue = undefined;
        this.currentSessionId = undefined;
        this.display.print(display.c.sageGreen("  Task complete. Waiting for next task..."));
      }
      return;
    }

    if (command === "clear") {
      this.currentSessionId = undefined;
      this.display.print("Session cleared.");
      return;
    }
  }
}

// ── workerMain ────────────────────────────────────────────────────────────────

export async function workerMain(runQueryFn: RunQuery): Promise<void> {
  const FOREMAN_URL = process.env.FOREMAN_URL ?? "ws://localhost:3000";
  const workerId = crypto.randomUUID();

  const wsFactory: WsFactory = (wid, taskId) => {
    const ws = new WebSocket(`${FOREMAN_URL}/worker`);
    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "worker_hello",
        workerId: wid,
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

  const session = new WorkerSession(workerId, wsFactory, runQueryFn, workerDisplay);

  process.stdout.write("\x1b[?2004h"); // enable bracketed paste mode
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  display.print(display.c.sageGreen(display.hr("═")));
  display.print(display.c.skyBlue(display.s.bold("  Brunel Worker")));
  display.print(display.c.lavender(`  Worker ID: ${workerId} | Foreman: ${FOREMAN_URL}`));
  display.print(display.c.sageGreen(display.hr("═")));

  session.start();

  while (true) {
    const wsAbort = session.createWsInputPromise();
    const input = await ask("\n[worker] > ", listWorkerCommandNames, wsAbort);

    try {
      const result = await session.handleUserInput(input);
      if (result === "exit") break;
    } catch (err) {
      display.print(display.c.boldRed(`\nERROR: ${err}`));
    }
  }

  process.stdout.write("\x1b[?2004l\r\n");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
}
