---
name: bug-investigation
description: Use when investigating a reported bug or about to implement a bug fix — verify the cause before making changes
---

# Bug Investigation

## Reproduce Before You Fix

The sequence is: **hypothesis → verify → fix**. Never skip the verify step.

Reading code and thinking "ah, this looks like it could cause the problem" is a hypothesis. It is not a verified cause. Before changing any code, you must observe the failure.

The verification bar: write a test, script, or REPL invocation that exercises the code path and **watch it fail in the way the bug describes**. That observation is your proof of cause. Once you have it, the fix follows naturally — and your repro becomes a regression test.

## When You Can't Reproduce

Some bugs require prod data, specific timing, or environment conditions that are hard to replicate locally. If you genuinely cannot reproduce the bug:

**Do not guess at a fix.** A speculative code change has no verified effect and risks introducing regressions.

Instead, add **targeted diagnostics**:
- Add logging, assertions, or error messages at the specific points your hypotheses implicate
- Make sure each diagnostic is designed to confirm or refute a specific hypothesis — "log everything" is not a strategy
- Report what you added and what to look for: "I couldn't repro this. I added logging at X and Y. If hypothesis A is right, you'll see [specific output]. If hypothesis B is right, you'll see [other output]."

Wait for the next real occurrence to gather evidence, then return to fix with actual data.

## Not Acceptable

- Changing code because it "looks suspicious" without observing the failure
- Claiming "I believe this is the root cause" without evidence
- Trying a fix speculatively when you haven't reproduced the bug ("let's see if this helps")
- Adding a change that might address multiple possible causes, hedging because you don't know which applies
