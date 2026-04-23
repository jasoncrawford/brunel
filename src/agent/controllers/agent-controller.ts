import fs from "fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { c } from "../views/style.js";
import type { Display } from "../views/display.js";
import { Picker } from "../views/picker.js";
import type { PickQuestionResult } from "../views/picker.js";
import { Settings } from "../models/settings.js";
import type { ModelInfo, FetchModelsFn } from "../models/settings.js";
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/** The SDK query object exposes supportedModels() as an undocumented extension. */
type QueryWithModels = { supportedModels?: () => Promise<ModelInfo[]> };

/**
 * Returns a function that fetches available Claude models from the SDK.
 * Used by the /model command to populate the model picker.
 */
export function createFetchModelsFn(settings: Settings): FetchModelsFn {
  return async () => {
    const q = query({ prompt: "", options: { cwd: process.cwd(), systemPrompt: { type: "preset", preset: "claude_code" }, permissionMode: settings.permissionMode } });
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
    private picker: Picker,
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
  ): Promise<{ sessionId: string | undefined; stats: QueryStats }> {
    logFull("QUERY", { prompt, sessionId });
    const { display } = this;
    // Save and clear the input callbacks while the query runs. In worker
    // mode, ask() registers drawFresh() as the callback so the prompt redraws
    // after background WebSocket messages — but during a query run the callback
    // fires on every display.print() call, adding an extra \r\n after each piece
    // of output and causing double-spacing. After the query finishes we restore
    // and invoke the callback so the prompt redraws once (fixes issue #108).
    const savedInputCallback = display.inputPrint;
    const savedStatusCallback = display.inputStatus;
    const savedClearCallback = display.inputClear;
    display.inputPrint = null;
    display.inputStatus = null;
    display.inputClear = null;
    if (savedInputCallback) {
      // ask() was active when this query started (e.g., debounce-triggered while the
      // worker prompt was showing). Clear from cursor to end of screen so the prompt
      // area is wiped and _clearStatus/_drawStatus can track the cursor correctly.
      process.stdout.write("\r\n\x1b[J");
    }

    const stats = new QueryStats();
    const getStatusText = () => c.darkGray(stats.getStatusText());
    display.startBar(getStatusText);

    const allowDangerouslySkipPerms = this.settings.permissionMode === "bypassPermissions";

    const canUseTool: CanUseTool = async (toolName, input) => {
      if (toolName === "AskUserQuestion") {
        return this.handleAskUserQuestion(input, getStatusText);
      }
      if (allowDangerouslySkipPerms) return { behavior: "allow", updatedInput: input };
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
        permissionMode: this.settings.permissionMode,
        includePartialMessages: true,
        canUseTool,
        abortController: ac,
        ...(allowDangerouslySkipPerms ? { allowDangerouslySkipPermissions: true } : {}),
        ...(sessionId ? { resume: sessionId } : {}),
        ...(this.settings.model ? { model: this.settings.model } : {}),
        ...(this.settings.effort ? { effort: this.settings.effort } : {}),
      },
    });

    // Cache the available models list from the SDK (fire-and-forget).
    const qm = iterable as unknown as QueryWithModels;
    if (typeof qm.supportedModels === "function") {
      qm.supportedModels().then(models => { this.settings.setCachedModels(models); }).catch(() => {});
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
          display.stopBar();
          stats.update(message as Parameters<typeof stats.update>[0]);
        }

        display.printMessage(message);
      }
    } catch (err) {
      if (!(err instanceof Error && /aborted by user/i.test(err.message))) throw err;
    } finally {
      process.stdin.removeListener("data", onInterrupt);
    }

    display.stopBar();

    if (!resultReceived) {
      display.print(c.darkGray("\nInterrupted. What should the agent do instead?"));
    }

    display.inputPrint = savedInputCallback;
    display.inputStatus = savedStatusCallback;
    display.inputClear = savedClearCallback;
    savedInputCallback?.();

    return { sessionId: capturedSessionId, stats };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async handleAskUserQuestion(
    input: Record<string, unknown>,
    getStatusText: () => string,
  ): Promise<PermissionResult> {
    const { display } = this;
    display.stopBar();
    const questions = (input.questions as Question[]) ?? [];
    const answers: Record<string, string> = {};

    for (const q of questions) {
      display.print(c.yellow(`\n? ${q.question}`));
      if (q.multiSelect) {
        const lines = q.options.map((o: QuestionOption) => o.description ? `${o.label} — ${o.description}` : o.label);
        const idxs = await this.picker.pickMultiple(lines);
        answers[q.question] = idxs.map((i: number) => q.options[i].label).join(", ");
      } else {
        const result: PickQuestionResult = await this.picker.pickQuestion(q.options);
        if (result.type === "discuss") {
          display.startBar(getStatusText);
          return { behavior: "deny", message: "The user would like to discuss more before answering. Prompt them to begin the discussion." };
        }
        answers[q.question] = result.type === "answer" ? result.value : result.text;
      }
    }

    display.startBar(getStatusText);
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }

  private async handleToolPermission(
    toolName: string,
    input: Record<string, unknown>,
    getStatusText: () => string,
  ): Promise<PermissionResult> {
    const { display } = this;
    display.stopBar();
    display.print(c.amber(`\n⚠ ${toolName}(${display.fmtArgs(input)})`));
    const idx = await this.picker.pick(["Allow", "Deny"]);
    display.startBar(getStatusText);
    if (idx === 0) return { behavior: "allow", updatedInput: input };
    return { behavior: "deny", message: "User denied tool request" };
  }
}
