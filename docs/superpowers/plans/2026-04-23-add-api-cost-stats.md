# Add API Cost into Loop Stats — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Display API cost alongside token counts in query stats summaries when available.

**Architecture:** Extract `total_cost_usd` from SDK result messages and pass it to the stats formatting functions. Update `fmtStats()` in `shared/formatters.ts` to format cost as "$X.XX". The cost will appear in the final summary (result message), and QueryStats can optionally store it for display.

**Tech Stack:** TypeScript, Vitest, Anthropic SDK v0.2.114

---

## Task 1: Update fmtStats to include cost parameter

**Files:**
- Modify: `shared/formatters.ts:41-56`
- Modify: `tests/repl.formats.test.ts` (add tests)

- [ ] **Step 1: Write failing test for fmtStats with cost**

In `tests/repl.formats.test.ts`, add a new test suite:

```typescript
describe("fmtStats - cost formatting", () => {
  it("includes cost when provided", () => {
    const result = fmtStats(60, 2, 100, 50, 0.25);
    expect(result).toContain("cost: $0.25");
  });

  it("omits cost when cost is undefined", () => {
    const result = fmtStats(60, 2, 100, 50);
    expect(result).not.toContain("cost");
  });

  it("formats cost with two decimal places", () => {
    const result = fmtStats(60, 2, 100, 50, 0.1234);
    expect(result).toContain("cost: $0.12");
  });

  it("formats cost correctly at zero", () => {
    const result = fmtStats(60, 2, 100, 50, 0);
    expect(result).toContain("cost: $0.00");
  });

  it("places cost at the end of the string", () => {
    const result = fmtStats(60, 2, 100, 50, 0.50);
    expect(result).toMatch(/cost: \$0\.50$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/repl.formats.test.ts
```

Expected output: 5 new tests FAIL with "fmtStats is being called with 5 arguments, not 4"

- [ ] **Step 3: Update fmtStats function signature and implementation**

In `shared/formatters.ts`, update the function:

```typescript
export function fmtStats(
  secs: number,
  turns?: number,
  outputTokens?: number,
  inputTokens?: number,
  costUsd?: number,
): string {
  const parts: string[] = [fmtDuration(secs)];
  if (turns) parts.push(fmtCount(turns, "turn"));
  if (outputTokens) {
    const tok = inputTokens != null
      ? `tokens: ${fmtNum(inputTokens)} in / ${fmtNum(outputTokens)} out`
      : `tokens: ${fmtNum(outputTokens)} out`;
    parts.push(tok);
  }
  if (costUsd != null) {
    parts.push(`cost: $${costUsd.toFixed(2)}`);
  }
  return parts.join(", ");
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- tests/repl.formats.test.ts
```

Expected output: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add shared/formatters.ts tests/repl.formats.test.ts
git commit -m "feat: add cost parameter to fmtStats function"
```

---

## Task 2: Update QueryStats to track cost

**Files:**
- Modify: `src/agent/models/query-stats.ts:62-123`
- Modify: `tests/repl.query-stats.test.ts`

- [ ] **Step 1: Write failing tests for QueryStats cost tracking**

In `tests/repl.query-stats.test.ts`, add:

```typescript
describe("QueryStats - cost tracking", () => {
  it("starts with zero cost", () => {
    const stats = new QueryStats();
    expect(stats.costUsd).toBeUndefined();
  });

  it("stores cost when setCost is called", () => {
    const stats = new QueryStats();
    stats.setCost(0.42);
    expect(stats.costUsd).toBe(0.42);
  });

  it("includes cost in getStatusText when set", () => {
    const stats = new QueryStats();
    stats.setCost(0.50);
    expect(stripAnsi(stats.getStatusText())).toContain("cost: $0.50");
  });

  it("omits cost from getStatusText when not set", () => {
    const stats = new QueryStats();
    expect(stripAnsi(stats.getStatusText())).not.toContain("cost");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/repl.query-stats.test.ts
```

Expected output: Tests fail with "stats.costUsd is not defined" and "stats.setCost is not a function"

- [ ] **Step 3: Add cost tracking to QueryStats**

In `src/agent/models/query-stats.ts`, add a private field after line 83:

```typescript
export class QueryStats extends EventEmitter {
  private _turns = 0;
  private _inputTokens = 0;
  private _completedOutputTokens = 0;
  private _currentOutputTokens = 0;
  private _costUsd: number | undefined;
  private readonly _startTime: number;
  private readonly _workingVerb: string;

  constructor(startTime = Date.now()) {
    super();
    this._startTime = startTime;
    this._workingVerb = pickWorkingVerb();
  }

  get turns(): number { return this._turns; }
  get inputTokens(): number { return this._inputTokens; }
  get outputTokens(): number { return this._completedOutputTokens + this._currentOutputTokens; }
  get costUsd(): number | undefined { return this._costUsd; }
  get elapsedSecs(): number { return Math.floor((Date.now() - this._startTime) / 1000); }

  /**
   * Process a single top-level stream event. Emits "change" for stat-bearing
   * events (message_start, message_delta, message_stop); silently ignores others.
   */
  update(event: QueryStreamEvent): void {
    if (event.type === "message_start") {
      this._turns++;
      this._inputTokens += event.message?.usage?.input_tokens ?? 0;
    } else if (event.type === "message_delta") {
      this._currentOutputTokens = event.usage?.output_tokens ?? this._currentOutputTokens;
    } else if (event.type === "message_stop") {
      this._completedOutputTokens += this._currentOutputTokens;
      this._currentOutputTokens = 0;
    } else {
      return;
    }
    this.emit("change");
  }

  setCost(cost: number): void {
    this._costUsd = cost;
    this.emit("change");
  }

  /** Formatted status bar text for use with display.startStatus(). Styling is the caller's responsibility. */
  getStatusText(): string {
    const secs = this.elapsedSecs;
    const outTokens = this.outputTokens;
    return `${this._workingVerb}… ${fmtStats(secs, this._turns || undefined, outTokens || undefined, this._inputTokens || undefined, this._costUsd)}`;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- tests/repl.query-stats.test.ts
```

Expected output: All tests PASS

- [ ] **Step 5: Run all tests to verify no regressions**

```bash
npm test
```

Expected output: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/agent/models/query-stats.ts tests/repl.query-stats.test.ts
git commit -m "feat: add cost tracking to QueryStats"
```

---

## Task 3: Update Renderer to pass cost to fmtStats for result messages

**Files:**
- Modify: `src/agent/views/renderer.ts:387-390`
- Modify: `tests/repl.formats.test.ts` (add test for result message formatting)

- [ ] **Step 1: Write failing test for result message with cost**

In `tests/repl.formats.test.ts`, add to MESSAGE_FMT test section:

```typescript
describe("MESSAGE_FMT - result messages", () => {
  it("result message includes cost when available", () => {
    const msg = {
      type: "result",
      duration_ms: 5000,
      num_turns: 2,
      usage: { input_tokens: 100, output_tokens: 250 },
      total_cost_usd: 0.15,
    };
    const result = stripAnsi(testDisplay.renderer.formatMessageEvent("result", msg));
    expect(result).toContain("cost: $0.15");
  });

  it("result message omits cost when not available", () => {
    const msg = {
      type: "result",
      duration_ms: 5000,
      num_turns: 2,
      usage: { input_tokens: 100, output_tokens: 250 },
    };
    const result = stripAnsi(testDisplay.renderer.formatMessageEvent("result", msg));
    expect(result).not.toContain("cost");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/repl.formats.test.ts
```

Expected output: Tests fail because formatMessageEvent doesn't pass total_cost_usd to fmtStats

- [ ] **Step 3: Update Renderer MESSAGE_FMT result entry**

In `src/agent/views/renderer.ts`, update the MESSAGE_FMT result entry around line 389:

```typescript
    result:           (m) => c.darkGray(`\n${fmtStats(Math.round(m.duration_ms / 1000), m.num_turns, m.usage.output_tokens, m.usage.input_tokens, m.total_cost_usd)}`),
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- tests/repl.formats.test.ts
```

Expected output: All tests PASS

- [ ] **Step 5: Run all tests to verify no regressions**

```bash
npm test
```

Expected output: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/agent/views/renderer.ts tests/repl.formats.test.ts
git commit -m "feat: include cost in result message formatting"
```

---

## Task 4: Update message fixture to include cost

**Files:**
- Modify: `tests/fixtures/messages.ts:190-196`

- [ ] **Step 1: Update MSG_RESULT fixture**

In `tests/fixtures/messages.ts`, update the MSG_RESULT export:

```typescript
export const MSG_RESULT = {
  type: "result",
  subtype: "success",
  duration_ms: 2064,
  num_turns: 1,
  usage: { input_tokens: 3, output_tokens: 77 },
  total_cost_usd: 0.12,
};
```

- [ ] **Step 2: Verify tests still pass**

```bash
npm test
```

Expected output: All tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/messages.ts
git commit -m "test: add total_cost_usd to MSG_RESULT fixture"
```

---

## Task 5: Integration test for full flow

**Files:**
- Modify: `tests/repl.query-stats.test.ts` (add integration test)

- [ ] **Step 1: Add integration test**

In `tests/repl.query-stats.test.ts`, add to the end:

```typescript
describe("QueryStats - integration with cost", () => {
  it("correctly formats stats with tokens and cost", () => {
    vi.useFakeTimers();
    const start = Date.now();
    const stats = new QueryStats(start);
    
    // Simulate a query
    stats.update({ type: "message_start", message: { usage: { input_tokens: 100 } } });
    stats.update({ type: "message_delta", usage: { output_tokens: 250 } });
    stats.update({ type: "message_stop" });
    vi.advanceTimersByTime(5000);
    stats.setCost(0.42);
    
    const text = stripAnsi(stats.getStatusText());
    expect(text).toContain("5s");
    expect(text).toContain("1 turn");
    expect(text).toContain("tokens: 100 in / 250 out");
    expect(text).toContain("cost: $0.42");
  });
});
```

- [ ] **Step 2: Run tests to verify**

```bash
npm test -- tests/repl.query-stats.test.ts
```

Expected output: Test PASSES

- [ ] **Step 3: Run all tests**

```bash
npm test
```

Expected output: All tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/repl.query-stats.test.ts
git commit -m "test: add integration test for stats with cost"
```
