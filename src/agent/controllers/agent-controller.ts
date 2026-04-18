import fs from "fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, PermissionMode, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { c } from "../views/display.js";
import type { Display } from "../views/display.js";
import { pick, pickMultiple, pickQuestion } from "../views/input.js";
import type { PickQuestionResult } from "../views/input.js";
import { Settings } from "../models/settings.js";
import type { ModelInfo, FetchModelsFn, EffortValue } from "../models/settings.js";
import { QueryStats } from "../models/query-stats.js";

// ── Log file ──────────────────────────────────────────────────────────────────

const LOG_FILE = "repl.log";

export function logFull(label: string, data: unknown) {
  const entry =
    `\n${"=".repeat(70)}\n` +
    `${new Date().toISOString()}  ${label}\n` +
    `${"-".repeat(70)}\n` +
    JSON.stringify(data, null, 2) +
    "\n";
  fs.appendFileSync(LOG_FILE, entry);
}

// ── Types ─────────────────────────────────────────────────────────────────────

type QuestionOption = { label: string; description: string };
type Question = { question: string; header: string; options: QuestionOption[]; multiSelect: boolean };

export type AgentPermConfig = {
  permissionMode: PermissionMode;
  allowDangerouslySkipPermissions: boolean;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns a function that fetches available Claude models from the SDK.
 * Used by the /model command to populate the model picker.
 */
export function createFetchModelsFn(permConfig: AgentPermConfig): FetchModelsFn {
  return async () => {
    const q = query({ prompt: "", options: { cwd: process.cwd(), systemPrompt: { type: "preset", preset: "claude_code" }, permissionMode: permConfig.permissionMode } });
    type QueryWithModels = { supportedModels?: () => Promise<ModelInfo[]> };
    const qm = q as unknown as QueryWithModels;
    if (typeof qm.supportedModels === "function") return qm.supportedModels();
    return [];
  };
}

// ── AgentController ───────────────────────────────────────────────────────────

/**
 * Handles the agent query action: runs a single prompt through the Claude SDK,
 * manages the status bar lifecycle, handles tool permissions and AskUserQuestion
 * callbacks, captures the session ID, and returns it for the next turn.
 *
 * index.ts owns setup, command registration, and the routing loop.
 * AgentController owns the single action of executing one query turn.
 */
export class AgentController {
  constructor(
    private display: Display,
    private permConfig: AgentPermConfig,
    private settings: Settings,
  ) {}

  /**
   * Run a single prompt through the Claude SDK. Manages the status bar,
   * streams output, handles tool permissions, and returns the session ID
   * so the next turn can resume the same conversation.
   */
  async runQuery(
    prompt: string,
    sessionId: string | undefined,
    abortController?: AbortController,
    model?: string,
    effort?: EffortValue,
  ): Promise<string | undefined> {
    logFull("QUERY", { prompt, sessionId });
    const { display, permConfig } = this;
    const statusBar = display.statusBar;
    // Save and clear the input print callback while the query runs. In worker
    // mode, ask() registers drawFresh() as the callback so the prompt redraws
    // after background WebSocket messages — but during a query run the callback
    // fires on every display.print() call, adding an extra \r\n after each piece
    // of output and causing double-spacing. After the query finishes we restore
    // and invoke the callback so the prompt redraws once (fixes issue #108).
    const savedInputCallback = statusBar.inputPrint;
    const savedStatusCallback = statusBar.inputStatus;
    const savedClearCallback = statusBar.inputClear;
    statusBar.inputPrint = null;
    statusBar.inputStatus = null;
    statusBar.inputClear = null;
    if (savedInputCallback) {
      // ask() was active when this query started (e.g., debounce-triggered while the
      // worker prompt was showing). Clear from cursor to end of screen so the prompt
      // area is wiped and _clearStatus/_drawStatus can track the cursor correctly.
      process.stdout.write("\r\n\x1b[J");
    }

    const stats = new QueryStats();
    const getStatusText = () => c.darkGray(stats.getStatusText());
    statusBar.start(getStatusText);

    const canUseTool: CanUseTool = async (toolName, input) => {
      if (toolName === "AskUserQuestion") {
        return this.handleAskUserQuestion(input, getStatusText);
      }
      if (permConfig.allowDangerouslySkipPermissions) return { behavior: "allow", updatedInput: input };
      return this.handleToolPermission(toolName, input, getStatusText);
    };

    // Use caller-provided AbortController (worker mode) or create our own (REPL mode).
    const ac = abortController ?? new AbortController();

    const iterable = query({
      prompt,
      options: {
        cwd: process.cwd(),
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project"],
        permissionMode: permConfig.permissionMode,
        includePartialMessages: true,
        canUseTool,
        abortController: ac,
        ...(permConfig.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
        ...(sessionId ? { resume: sessionId } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      },
    });

    // Cache the available models list from the SDK (fire-and-forget).
    type QueryWithModels = { supportedModels?: () => Promise<ModelInfo[]> };
    const qm = iterable as unknown as QueryWithModels;
    if (typeof qm.supportedModels === "function") {
      qm.supportedModels().then(models => { Settings.setCachedModels(models); }).catch(() => {});
    }

    // Register a temporary raw-stdin listener to catch ^C and abort the query.
    const onInterrupt = (chunk: string) => {
      if (chunk.includes("\x03")) {
        (iterable as unknown as { close?: () => void }).close?.();
        ac.abort();
      }
    };
    process.stdin.on("data", onInterrupt);

    let capturedSessionId = sessionId;
    let resultReceived = false;

    try {
      for await (const message of iterable) {
        if (!(message.type === "stream_event" && (message.event as { type?: string }).type === "content_block_delta")) {
          logFull("MESSAGE", message);
        }

        if (message.type === "system" && message.subtype === "init" && !capturedSessionId) {
          capturedSessionId = message.session_id;
        }

        if (message.type === "stream_event") {
          if (message.parent_tool_use_id == null) {
            stats.update(message.event as Parameters<typeof stats.update>[0]);
          }
          continue;
        }

        if (message.type === "result") {
          resultReceived = true;
          statusBar.stop();
        }

        display.printMessage(message);
      }
    } catch (err) {
      if (!(err instanceof Error && /aborted by user/i.test(err.message))) throw err;
    } finally {
      process.stdin.removeListener("data", onInterrupt);
    }

    statusBar.stop();

    if (!resultReceived) {
      display.print(c.darkGray("\nInterrupted. What should the agent do instead?"));
    }

    statusBar.inputPrint = savedInputCallback;
    statusBar.inputStatus = savedStatusCallback;
    statusBar.inputClear = savedClearCallback;
    savedInputCallback?.();

    return capturedSessionId;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async handleAskUserQuestion(
    input: Record<string, unknown>,
    getStatusText: () => string,
  ): Promise<PermissionResult> {
    const { display } = this;
    display.statusBar.stop();
    const questions = (input.questions as Question[]) ?? [];
    const answers: Record<string, string> = {};

    for (const q of questions) {
      display.print(c.yellow(`\n? ${q.question}`));
      if (q.multiSelect) {
        const lines = q.options.map((o: QuestionOption) => o.description ? `${o.label} — ${o.description}` : o.label);
        const idxs = await pickMultiple(lines);
        answers[q.question] = idxs.map((i: number) => q.options[i].label).join(", ");
      } else {
        const result: PickQuestionResult = await pickQuestion(q.options);
        if (result.type === "discuss") {
          display.statusBar.start(getStatusText);
          return { behavior: "deny", message: "The user would like to discuss more before answering. Prompt them to begin the discussion." };
        }
        answers[q.question] = result.type === "answer" ? result.value : result.text;
      }
    }

    display.statusBar.start(getStatusText);
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }

  private async handleToolPermission(
    toolName: string,
    input: Record<string, unknown>,
    getStatusText: () => string,
  ): Promise<PermissionResult> {
    const { display } = this;
    display.statusBar.stop();
    display.print(c.amber(`\n⚠ ${toolName}(${display.fmtArgs(input)})`));
    const idx = await pick(["Allow", "Deny"]);
    display.statusBar.start(getStatusText);
    if (idx === 0) return { behavior: "allow", updatedInput: input };
    return { behavior: "deny", message: "User denied tool request" };
  }
}
