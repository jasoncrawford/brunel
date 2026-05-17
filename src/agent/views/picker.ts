import { s } from "./style.js";

// ── Errors ────────────────────────────────────────────────────────────────────

/** Thrown when the user cancels a picker with Ctrl+C. */
export class PickerCancelledError extends Error {
  constructor() {
    super("Picker cancelled by user");
    this.name = "PickerCancelledError";
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type PickConfig = {
  /** Index of the "current" item — shows ✓ marker when not focused. */
  currentIdx?: number;
  /** Allow Escape to cancel (erases menu, returns { type: "cancelled" }). */
  escapable?: boolean;
  /** Treat the last option as an inline text-entry row ("Other:"). */
  lastIsTextEntry?: boolean;
  /** Treat the option at this index as an inline text-entry row. Takes precedence over lastIsTextEntry. */
  textEntryIndex?: number;
  /** Prefix shown in the text-entry row while typing. Defaults to "Other: ". */
  textEntryPrefix?: string;
};

export type PickResult =
  | { type: "selected"; index: number }
  | { type: "other"; text: string }
  | { type: "cancelled" };

export type SettingsMenuEntry = {
  label: string;
  display: string;
  cycleValues?: string[];
};

export type SettingsMenuResult = { type: "cancelled" };

export type PickQuestionResult =
  | { type: "answer"; value: string }
  | { type: "other"; text: string }
  | { type: "discuss" };

/** Minimal display interface needed to clear/restore the status bar around picker menus. */
export type PickerDisplay = { startPicker(): void; stopPicker(): void };

// ── Picker class ──────────────────────────────────────────────────────────────

/**
 * Arrow-key picker menus. Stateless — each method runs an independent raw-mode
 * stdin loop. Instantiate once in startup (index.ts) and inject where needed.
 *
 * When a display is provided, each pick method clears the status bar before
 * rendering its menu and restores it after the user makes a selection. This
 * prevents the picker options from overwriting the status bar rows.
 *
 * The optional onStart callback is called at the very start of each pick method,
 * before clearBar(). The composition root wires this to input.cancel() so that
 * any active ask() prompt is torn down before the picker renders — otherwise
 * display.clearBar() silently no-ops while ask() owns the screen, causing picker
 * options to overwrite the status bar lines (issue #832).
 */
export class Picker {
  constructor(private display?: PickerDisplay, private onStart?: () => void) {}

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
    const { display } = this;

    this.onStart?.();
    display?.startPicker();

    return new Promise((resolve, reject) => {
      let idx = hasConfig && currentIdx >= 0 ? currentIdx : 0;
      let done = false;
      const count = options.length;
      const otherIdx = config?.textEntryIndex ?? (lastIsTextEntry ? count - 1 : -1);
      const textEntryPrefix = config?.textEntryPrefix ?? "Other: ";
      let textMode = false;
      let textBuf = "";

      const renderLine = (i: number): string => {
        const marker = (i === currentIdx) ? "✓ " : undefined;
        const text = (i === otherIdx && textMode) ? `${textEntryPrefix}${textBuf}` : options[i];
        return Picker.pickerLine(text, i === idx, marker);
      };

      for (let i = 0; i < count; i++) {
        process.stdout.write(renderLine(i) + "\r\n");
      }

      function positionTextCursor() {
        // Move up from below last line to text-entry row; position after "▶ " (3 cols) + prefix + textBuf
        process.stdout.write(`\x1b[${count - otherIdx}A\r\x1b[${3 + textEntryPrefix.length + textBuf.length}C`);
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
        display?.stopPicker();
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
            } else if (ch === "\x03") {
              eraseMenu();
              if (hasConfig) { finish({ type: "cancelled" }); } else { finish(-1); }
              return;
            } else if (ch.charCodeAt(0) >= 32) { textBuf += ch; process.stdout.write(ch); }
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
            } else if (ch === "\x03") {
              eraseMenu();
              if (hasConfig) { finish({ type: "cancelled" }); } else { finish(-1); }
              return;
            }
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
    const { display } = this;
    this.onStart?.();
    display?.startPicker();

    return new Promise((resolve, reject) => {
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
            display?.stopPicker();
            resolve([...selected].sort((a, b) => a - b));
          } else if (ch === "\x03") {
            done = true;
            process.stdin.removeListener("data", onData);
            display?.stopPicker();
            reject(new PickerCancelledError());
            return;
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
    const { display } = this;
    this.onStart?.();
    display?.startPicker();

    return new Promise((resolve, reject) => {
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

      function finish(result: PickQuestionResult) {
        done = true;
        process.stdin.removeListener("data", onData);
        display?.stopPicker();
        resolve(result);
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
              finish({ type: "other", text: textBuf });
              return;
            } else if (ch === "\x10") { navigateTo((idx - 1 + count) % count); }
            else if (ch === "\x11")   { navigateTo((idx + 1) % count); }
            else if (ch === "\x7f" || ch === "\x08") {
              if (textBuf.length > 0) {
                textBuf = textBuf.slice(0, -1);
                process.stdout.write("\x08 \x08");
              }
            } else if (ch === "\x03") {
              done = true;
              process.stdin.removeListener("data", onData);
              display?.stopPicker();
              reject(new PickerCancelledError());
              return;
            } else if (ch.charCodeAt(0) >= 32) {
              textBuf += ch;
              process.stdout.write(ch);
            }
          } else {
            if (ch === "\x10") { navigateTo((idx - 1 + count) % count); }
            else if (ch === "\x11") { navigateTo((idx + 1) % count); }
            else if (ch === "\r" || ch === "\n") {
              if (idx === discussIdx) {
                finish({ type: "discuss" });
              } else if (idx === otherIdx) {
                // Already in textMode; Enter submits (textBuf is empty if they just navigated here)
                finish({ type: "other", text: textBuf });
              } else {
                finish({ type: "answer", value: options[idx].label });
              }
              return;
            } else if (ch === "\x03") {
              done = true;
              process.stdin.removeListener("data", onData);
              display?.stopPicker();
              reject(new PickerCancelledError());
              return;
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

  /**
   * Settings overview picker: shows all settings with current values.
   * Up/down arrows navigate; Tab/Right cycles through valid values forward;
   * Shift-Tab/Left cycles backward (calling onCycle immediately).
   *
   * Opens with a heading row selected. Arrowing into a setting expands it
   * inline showing all cycle values. Enter leaves the menu in place showing
   * the final un-highlighted state. Escape/Ctrl-C erases the menu.
   */
  pickSettingsMenu(
    entries: SettingsMenuEntry[],
    onCycle: (entryIndex: number, newValue: string) => void,
  ): Promise<SettingsMenuResult> {
    this.onStart?.();
    this.display?.startPicker();

    return new Promise((resolve) => {
      let idx = -1; // -1 = heading row, 0..count-1 = settings entry
      let done = false;
      const count = entries.length;
      const totalRows = 1 + count; // heading row + settings rows

      const displays = entries.map(e => e.display);
      const tabPositions = entries.map((e) => {
        if (!e.cycleValues || e.cycleValues.length === 0) return 0;
        const pos = e.cycleValues.indexOf(e.display);
        return pos >= 0 ? pos : 0;
      });

      const labelWidth = Math.max(...entries.map(e => e.label.length));
      const HEADING = "Arrows to choose settings, Enter when done";

      const renderLine = (row: number, finished: boolean): string => {
        if (row === 0) {
          if (finished) return `  ${HEADING}`;
          const selected = idx === -1;
          return selected ? `▶ ${HEADING}` : s.dim(`  ${HEADING}`);
        }
        const i = row - 1;
        const entry = entries[i];
        const label = entry.label.padEnd(labelWidth);
        if (finished) return `  ${label}  ${displays[i]}`;
        const selected = idx === i;
        if (selected && entry.cycleValues && entry.cycleValues.length > 0) {
          const currentPos = tabPositions[i];
          const valuesStr = entry.cycleValues.map((v, vi) =>
            vi === currentPos ? s.bold(v) : s.dim(v)
          ).join("  ");
          return `▶ ${label}  ${valuesStr}`;
        }
        const full = `  ${label}  ${displays[i]}`;
        return selected ? `▶ ${label}  ${displays[i]}` : s.dim(full);
      };

      for (let row = 0; row < totalRows; row++) {
        process.stdout.write(renderLine(row, false) + "\r\n");
      }

      function redraw(finished = false) {
        process.stdout.write(`\x1b[${totalRows}A\r`);
        for (let row = 0; row < totalRows; row++) {
          process.stdout.write(renderLine(row, finished) + "\x1b[K\r\n");
        }
      }

      function eraseMenu() {
        process.stdout.write(`\x1b[${totalRows}A\r`);
        for (let row = 0; row < totalRows; row++) process.stdout.write("\x1b[K\r\n");
        process.stdout.write(`\x1b[${totalRows}A\r`);
      }

      function cycle(direction: 1 | -1) {
        if (idx < 0) return;
        const entry = entries[idx];
        if (!entry?.cycleValues?.length) return;
        tabPositions[idx] = (tabPositions[idx] + direction + entry.cycleValues.length) % entry.cycleValues.length;
        const newValue = entry.cycleValues[tabPositions[idx]];
        displays[idx] = newValue;
        onCycle(idx, newValue);
        redraw();
      }

      const { display } = this;
      function finish(erase: boolean) {
        done = true;
        process.stdin.removeListener("data", onData);
        if (erase) { eraseMenu(); } else { redraw(true); }
        display?.stopPicker();
        resolve({ type: "cancelled" });
      }

      function onData(raw: string) {
        if (done) return;
        let data = raw;
        data = data.replace(/\x1b\[A/g, "\x10"); // up arrow
        data = data.replace(/\x1b\[B/g, "\x11"); // down arrow
        data = data.replace(/\x1b\[C/g, "\x12"); // right arrow → cycle forward
        data = data.replace(/\x1b\[D/g, "\x13"); // left arrow → cycle backward
        data = data.replace(/\x1b\[Z/g, "\x14"); // shift-tab → cycle backward
        data = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
        data = data.replace(/\x1b./gs, "");

        for (const ch of data) {
          if (ch === "\x10") {
            idx = idx === -1 ? count - 1 : idx - 1;
            redraw();
          } else if (ch === "\x11") {
            idx = idx === count - 1 ? -1 : idx + 1;
            redraw();
          } else if (ch === "\x09" || ch === "\x12") { cycle(1); }  // Tab / Right
          else if (ch === "\x13" || ch === "\x14") { cycle(-1); }   // Left / Shift-Tab
          else if (ch === "\r" || ch === "\n") { finish(false); return; }
          else if (ch === "\x1b" || ch === "\x03") { finish(true); return; }
        }
      }

      process.stdin.on("data", onData);
    });
  }
}
