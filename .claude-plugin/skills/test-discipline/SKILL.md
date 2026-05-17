---
name: test-discipline
description: Use when implementing any bug fix, feature, or code change — ensures new tests are written for new behavior, and no existing tests are skipped or failing
---

# Test Discipline

## Write Tests for New Behavior

For every bug fix or feature, write at least one test that:
- Would **FAIL** before your change
- Would **PASS** after your change

"Existing tests still pass" only proves no regressions — it does **not** verify the fix or feature works.

If you believe no new test is needed, you must identify the specific existing test(s) that cover the new behavior and explain why they're sufficient. Vague claims like "existing tests cover this" are not acceptable.

## No Skipped or Failing Tests

All tests must pass. Zero skipped. If a test is failing or skipped, investigate and fix it — don't work around it or leave it for later.

Check for:
- Tests marked `.skip`, `test.skip`, `xit`, `xdescribe`, `@pytest.mark.skip`, etc.
- Tests that were skipped due to earlier failures (serial test suites)
- Flaky tests that "usually pass" — these are bugs

## Match Test Level to Where the Bug Lives

A test at the wrong level of abstraction adds zero value, even if it passes and fails correctly.

**Ask: where does the failure actually occur?**

| Bug type | Right test level | Wrong test level |
|----------|-----------------|-----------------|
| Wrong logic inside a function | Unit test on that function | Integration test that incidentally exercises it |
| Two components not wired together correctly | Integration test using both real components | Unit test on the glue code between them |
| Wrong URL, path, or config passed across a boundary | Integration test verifying the connection works end-to-end | Unit test asserting the string value |
| Display or terminal behavior (text output, ordering) | Capture stdout and assert on what the user actually sees | Check that an internal callback fired or a module variable was set |

**For display/TUI tests, "what the user sees" means semantic text content — not terminal control sequences.** Escape codes (`\x1b[K`, cursor movements) are themselves internal mechanisms of the display layer, not user-visible outcomes.

| ❌ Still a mechanism test | ✅ Behavioral |
|---|---|
| `expect(events).toEqual(["clearBar", "option", "drawBar"])` | Status bar text ("Connected") appears after option text in stdout |
| Check for `\x1b[K` before option text | Status bar text appears after option text (clearBar ran, we don't care how) |
| `expect(display.persistentActive).toBe(true)` | `expect(stdout).toContain("Connected")` |
| Mock display, assert callback order | Real Display, assert on rendered content |

**Diagnostic question — apply before finalizing any test:** *"Would this test fail if the bug existed but was fixed through a completely different mechanism?"* If no, you are testing the fix's implementation, not the behavior the fix restores. Rewrite the test to assert on the user-visible outcome directly.

**Integration bugs need integration tests.** If the bug is "A couldn't talk to B because of a wrong path/protocol/format," a unit test that checks the path string is just testing string concatenation — it doesn't prove A and B can actually connect. Use real instances of both.

**Red flag:** If your test doesn't exercise any production code path that was broken before the fix, it's testing the wrong thing. Ask: "Would this test have caught the bug if I hadn't already fixed it?"

## Testing Models: Real DB vs. Mocks

Match the approach to what's actually being tested:

**Use a real DB** when the test is verifying DB behavior — constraints, timestamps, queries, state transitions that depend on what's persisted. Mocks here give false confidence.

**Mock the model layer** when the test is verifying logic *above* the DB — routing, protocol, event handling, business rules. Use `vi.spyOn` on static finders and a `fromTest()` factory to construct instances without hitting the DB:

```typescript
const task = Task.fromTest({ task_id: "t1", issue_number: 42, title: "Fix bug" });
vi.spyOn(Task, "getByIssue").mockResolvedValue(task);
vi.spyOn(task, "assign").mockImplementation(async (workerId) => {
  task.workerId = workerId; // mirror what the real method does in memory
});
```

**Anti-pattern: parallel in-memory implementations** — A `createMemoryStore()` that duplicates the real store's behavior just to avoid spinning up a DB. This drifts from the real implementation and gives false confidence. Use `fromTest()` + `vi.spyOn` instead.

## Not Acceptable

- Writing no new test for a bug fix ("the bug was obvious, no test needed")
- Writing no new test for a feature ("it's small")
- "It was already skipped before I started"
- "It's unrelated to my change"
- "It's flaky but usually passes"
- Writing a unit test for an integration bug ("at least there's coverage")

If you didn't break it, you still found it. Fix it or flag it.
