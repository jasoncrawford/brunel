import { s } from "./style.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PickConfig = {
  /** Index of the "current" item — shows ✓ marker when not focused. */
  currentIdx?: number;
  /** Allow Escape to cancel (erases menu, returns { type: "cancelled" }). */
  escapable?: boolean;
  /** Treat the last option as an inline text-entry row ("Other:"). */
  lastIsTextEntry?: boolean;
};

export type PickResult =
  | { type: "selected"; index: number }
  | { type: "other"; text: string }
  | { type: "cancelled" };

export type PickQuestionResult =
  | { type: "answer"; value: string }
  | { type: "other"; text: string }
  | { type: "discuss" };

// ── Picker class ──────────────────────────────────────────────────────────────

/**
 * Arrow-key picker menus. Stateless — each method runs an independent raw-mode
 * stdin loop. Instantiate once in startup (index.ts) and inject where needed.
 */
export class Picker {
  /** Formats a single picker row: adds marker and dims non-selected rows. */
  private static pickerLine(text: string, isSelected: boolean, marker?: string): string {
    const prefix = isSelected ? "▶ " : (marker ?? "  ");
    const full = prefix + text;
    return isSelected ? full : s.dim(full);
  }

  /**
   * Single-selection arrow-key picker. Assumes stdin is already in raw mode.
   *
   * Without config: returns the selected index (number).
   * With config: returns a PickResult (supports escape, text entry, current marker).
   */
  pick(options: string[]): Promise<number>;
  pick(options: string[], config: PickConfig): Promise<PickResult>;
  pick(options: string[], config?: PickConfig): Promise<number | PickResult> {
    const currentIdx = config?.currentIdx ?? -1;
    const escapable = config?.escapable ?? false;
    const lastIsTextEntry = config?.lastIsTextEntry ?? false;
    const hasConfig = config != null;

    return new Promise((resolve) => {
      let idx = hasConfig && currentIdx >= 0 ? currentIdx : 0;
      let done = false;
      const count = options.length;
      const otherIdx = lastIsTextEntry ? count - 1 : -1;
      let textMode = false;
      let textBuf = "";

      const renderLine = (i: number): string => {
        const marker = (i === currentIdx) ? "✓ " : undefined;
        const text = (i === otherIdx && textMode) ? `Other: ${textBuf}` : options[i];
        return Picker.pickerLine(text, i === idx, marker);
      };

      for (let i = 0; i < count; i++) {
        process.stdout.write(renderLine(i) + "\r\n");
      }

      function positionTextCursor() {
        // Move up from below last line to Other row, position after "▶ Other: " + textBuf
        process.stdout.write(`\x1b[${count - otherIdx}A\r\x1b[${10 + textBuf.length}C`);
      }

      function redraw() {
        process.stdout.write(`\x1b[${count}A\r`);
        for (let i = 0; i < count; i++) {
          process.stdout.write(renderLine(i) + "\x1b[K\r\n");
        }
        if (idx === otherIdx && textMode) positionTextCursor();
      }

      function navigateTo(newIdx: number) {
        if (idx === otherIdx && textMode) {
          process.stdout.write(`\x1b[${count - otherIdx}B`);
          textMode = false;
          textBuf = "";
        }
        idx = newIdx;
        if (idx === otherIdx) textMode = true;
        redraw();
      }

      function eraseMenu() {
        if (textMode) process.stdout.write(`\x1b[${count - otherIdx}B`);
        process.stdout.write(`\x1b[${count}A\r`);
        for (let i = 0; i < count; i++) process.stdout.write("\x1b[K\r\n");
        process.stdout.write(`\x1b[${count}A\r`);
      }

      function finish(result: number | PickResult) {
        done = true;
        process.stdin.removeListener("data", onData);
        resolve(result);
      }

      function onData(raw: string) {
        if (done) return;
        let data = raw;
        data = data.replace(/\x1b\[A/g, "\x10"); // up arrow
        data = data.replace(/\x1b\[B/g, "\x11"); // down arrow

        if (escapable && raw === "\x1b") {
          eraseMenu();
          finish({ type: "cancelled" });
          return;
        }

        data = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
        data = data.replace(/\x1b./gs, "");

        for (const ch of data) {
          if (textMode) {
            if (ch === "\r" || ch === "\n") {
              process.stdout.write("\r\n");
              finish({ type: "other", text: textBuf });
              return;
            } else if (ch === "\x10") { navigateTo((idx - 1 + count) % count); }
            else if (ch === "\x11")   { navigateTo((idx + 1) % count); }
            else if (ch === "\x7f" || ch === "\x08") {
              if (textBuf.length > 0) { textBuf = textBuf.slice(0, -1); process.stdout.write("\x08 \x08"); }
            } else if (ch === "\x03") { process.stdout.write("^C\r\n"); process.exit(0); }
            else if (ch.charCodeAt(0) >= 32) { textBuf += ch; process.stdout.write(ch); }
          } else {
            if (ch === "\x10") { navigateTo((idx - 1 + count) % count); }
            else if (ch === "\x11") { navigateTo((idx + 1) % count); }
            else if (ch === "\r" || ch === "\n") {
              if (idx === otherIdx) {
                process.stdout.write("\r\n");
                finish({ type: "other", text: textBuf });
              } else if (hasConfig) {
                finish({ type: "selected", index: idx });
              } else {
                finish(idx);
              }
              return;
            } else if (ch === "\x03") { process.stdout.write("^C\r\n"); process.exit(0); }
          }
        }
      }

      process.stdin.on("data", onData);
    });
  }

  /**
   * Multi-selection arrow-key picker. Returns an array of selected indices.
   * Up/down arrows move the cursor; Space toggles selection; Enter confirms.
   * Ctrl-C exits the process.
   */
  pickMultiple(options: string[], promptStr?: string): Promise<number[]> {
    return new Promise((resolve) => {
      let idx = 0;
      let done = false;
      const count = options.length;
      const selected = new Set<number>();

      if (promptStr) process.stdout.write(promptStr + "\n");
      for (let i = 0; i < count; i++) {
        const check = selected.has(i) ? "◉" : "○";
        process.stdout.write(Picker.pickerLine(`${check} ${options[i]}`, i === idx) + "\n");
      }

      function redraw() {
        process.stdout.write(`\x1b[${count}A\r`);
        for (let i = 0; i < count; i++) {
          const check = selected.has(i) ? "◉" : "○";
          process.stdout.write(Picker.pickerLine(`${check} ${options[i]}`, i === idx) + "\x1b[K\r\n");
        }
      }

      function onData(raw: string) {
        if (done) return;
        let data = raw;
        data = data.replace(/\x1b\[A/g, "\x10"); // up arrow
        data = data.replace(/\x1b\[B/g, "\x11"); // down arrow
        data = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
        data = data.replace(/\x1b./gs, "");
        for (const ch of data) {
          if (ch === "\x10") { idx = (idx - 1 + count) % count; redraw(); }
          else if (ch === "\x11") { idx = (idx + 1) % count; redraw(); }
          else if (ch === " ") {
            if (selected.has(idx)) selected.delete(idx);
            else selected.add(idx);
            redraw();
          } else if (ch === "\r" || ch === "\n") {
            done = true;
            process.stdin.removeListener("data", onData);
            resolve([...selected].sort((a, b) => a - b));
          } else if (ch === "\x03") {
            process.stdout.write("^C\r\n");
            process.exit(0);
          }
        }
      }

      process.stdin.on("data", onData);
    });
  }

  /**
   * Minimal single-line text prompt. Reads characters until Enter,
   * supporting backspace. No autocomplete or multiline support.
   */
  promptLine(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      let buf = "";
      process.stdout.write(prompt);

      function onData(raw: string) {
        const data = raw
          .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
          .replace(/\x1b./gs, "");
        for (const ch of data) {
          if (ch === "\r" || ch === "\n") {
            process.stdout.write("\r\n");
            process.stdin.removeListener("data", onData);
            resolve(buf);
            return;
          } else if (ch === "\x7f" || ch === "\x08") {
            if (buf.length > 0) {
              buf = buf.slice(0, -1);
              process.stdout.write("\x08 \x08");
            }
          } else if (ch === "\x03") {
            process.stdout.write("^C\r\n");
            process.exit(0);
          } else if (ch.charCodeAt(0) >= 32) {
            buf += ch;
            process.stdout.write(ch);
          }
        }
      }

      process.stdin.on("data", onData);
    });
  }

  /**
   * Single-selection picker for AskUserQuestion tool calls.
   * Options are rendered as numbered items with bold label and description.
   * Non-selected rows are dim; the selected row is normal weight.
   * "Other:" (free-text entry) and "Let's discuss" (deny) are always appended.
   * Digit keys 1–9 jump the cursor to that 1-based index.
   */
  pickQuestion(
    options: Array<{ label: string; description: string }>,
  ): Promise<PickQuestionResult> {
    return new Promise((resolve) => {
      const extras = [
        { label: "Other:",        description: "" },
        { label: "Let's discuss", description: "" },
      ];
      const all = [...options, ...extras];
      const count = all.length;
      const otherIdx   = count - 2;
      const discussIdx = count - 1;

      let idx = 0;
      let done = false;
      let textMode = false; // true when typing inline answer for Other:
      let textBuf = "";

      const renderLine = (i: number): string => {
        const num = i + 1;
        const numStr = num <= 9 ? `${num}` : " ";
        const opt = all[i];
        if (i === idx) {
          // Selected: bold label, normal weight description — no dim
          let text: string;
          if (i === otherIdx && textMode) {
            text = `${s.bold("Other:")} ${textBuf}`;
          } else if (opt.description) {
            text = `${s.bold(opt.label)}. ${opt.description}`;
          } else {
            text = s.bold(opt.label);
          }
          return Picker.pickerLine(`${numStr}. ${text}`, true);
        } else {
          // Non-selected: entire line dim, no bold (bold resets dim via \x1b[22m)
          const text = opt.description ? `${opt.label}. ${opt.description}` : opt.label;
          return Picker.pickerLine(`${numStr}. ${text}`, false);
        }
      };

      // After a full redraw (cursor below last line), position cursor at end of Other: text
      function positionTextCursor() {
        // Move up from below-last-line to Other: row, then right past the visible prefix
        // Visible prefix: "▶ "(2) + numStr(1) + ". "(2) + "Other: "(7) = 12 chars + textBuf
        process.stdout.write(`\x1b[${count - otherIdx}A\r\x1b[${12 + textBuf.length}C`);
      }

      for (let i = 0; i < count; i++) {
        process.stdout.write(renderLine(i) + "\r\n");
      }

      function redraw() {
        process.stdout.write(`\x1b[${count}A\r`);
        for (let i = 0; i < count; i++) {
          process.stdout.write(renderLine(i) + "\x1b[K\r\n");
        }
        // When Other: is selected, position terminal cursor at end of text entry area
        if (idx === otherIdx) positionTextCursor();
      }

      function navigateTo(newIdx: number) {
        if (idx === otherIdx && textMode) {
          // Move cursor from Other: line back to below last line before redrawing
          process.stdout.write(`\x1b[${count - otherIdx}B`);
          textMode = false;
          textBuf = "";
        }
        idx = newIdx;
        if (idx === otherIdx) textMode = true;
        redraw();
      }

      function onData(raw: string) {
        if (done) return;
        let data = raw;
        data = data.replace(/\x1b\[A/g, "\x10"); // up
        data = data.replace(/\x1b\[B/g, "\x11"); // down
        data = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
        data = data.replace(/\x1b./gs, "");
        for (const ch of data) {
          if (textMode) {
            // Inline text entry for Other: — write chars directly (cursor already positioned)
            if (ch === "\r" || ch === "\n") {
              done = true;
              process.stdin.removeListener("data", onData);
              resolve({ type: "other", text: textBuf });
              return;
            } else if (ch === "\x10") { navigateTo((idx - 1 + count) % count); }
            else if (ch === "\x11")   { navigateTo((idx + 1) % count); }
            else if (ch === "\x7f" || ch === "\x08") {
              if (textBuf.length > 0) {
                textBuf = textBuf.slice(0, -1);
                process.stdout.write("\x08 \x08");
              }
            } else if (ch === "\x03") {
              process.stdout.write("^C\r\n");
              process.exit(0);
            } else if (ch.charCodeAt(0) >= 32) {
              textBuf += ch;
              process.stdout.write(ch);
            }
          } else {
            if (ch === "\x10") { navigateTo((idx - 1 + count) % count); }
            else if (ch === "\x11") { navigateTo((idx + 1) % count); }
            else if (ch === "\r" || ch === "\n") {
              if (idx === discussIdx) {
                done = true;
                process.stdin.removeListener("data", onData);
                resolve({ type: "discuss" });
              } else if (idx === otherIdx) {
                // Already in textMode; Enter submits (textBuf is empty if they just navigated here)
                done = true;
                process.stdin.removeListener("data", onData);
                resolve({ type: "other", text: textBuf });
              } else {
                done = true;
                process.stdin.removeListener("data", onData);
                resolve({ type: "answer", value: options[idx].label });
              }
              return;
            } else if (ch === "\x03") {
              process.stdout.write("^C\r\n");
              process.exit(0);
            } else if (ch >= "1" && ch <= "9") {
              const n = parseInt(ch, 10) - 1;
              if (n < count) { navigateTo(n); }
            }
          }
        }
      }

      process.stdin.on("data", onData);
    });
  }
}
