# Design: `pull_request/auto_merge_enabled` Branch Review Prompt

**Date:** 2026-03-21
**Issue:** #214
**Status:** Approved

## Summary

When GitHub sends a `pull_request/auto_merge_enabled` webhook event, the worker should receive an actionable prompt telling it to check test status, rebase if needed, and verify merge readiness — matching the behavior already triggered by a successful CI suite completion.

## Background

When a CI suite completes, the foreman forwards a `check_suite` event to the worker. The worker classifies it as `"actionable"` and builds a prompt using the `BRANCH_REVIEW_PROMPT` text. No equivalent handling exists for `auto_merge_enabled`.

The foreman already forwards non-`opened`, non-`synchronize` `pull_request` events to the assigned worker — so routing requires no changes. Only classification and template handling are missing.

## Changes

### `src/worker.ts` — `classifyEvent()`

Add `auto_merge_enabled` as an actionable pull_request action:

```ts
case "pull_request":
  return (action === "closed" || action === "auto_merge_enabled")
    ? "actionable"
    : "log_only";
```

### `src/templates.ts`

Extract the shared branch-review instruction into a named constant to avoid repetition between `check_suite` and `pull_request/auto_merge_enabled`:

```ts
const BRANCH_REVIEW_PROMPT =
  "Check whether all tests have passed. If not, take no action now; wait for the remaining ones. " +
  "If all tests passed, check if the branch is up to date, and if not, rebase it. " +
  "Then check if the PR can be merged. If anything is blocking merge, resolve it, but do not merge yourself.";
```

Update both the `check_suite` template and the `_check_suites` coalesced handler (used when multiple check-suite events are batched) to use the constant — no behaviour change, but both occurrences must be updated for the refactor to be complete.

Add `auto_merge_enabled` case to the `pull_request` template:

```ts
if (p.action === "auto_merge_enabled") {
  return `Auto-merge was enabled on PR #${prNumber}. ${BRANCH_REVIEW_PROMPT}`;
}
```

## Tests

New unit tests in existing test files:

- **`classifyEvent()`** (`tests/worker.classify-event.test.ts` or equivalent):
  `pull_request/auto_merge_enabled` → `"actionable"`

- **Template** (`tests/templates.test.ts` or equivalent):
  `pull_request` payload with `action: "auto_merge_enabled"` → prompt starts with `"Auto-merge was enabled on PR #N."` and includes branch-review text

No foreman tests needed — routing is already covered.

## Out of Scope

- No foreman changes (routing already works)
- No new message types or protocol changes
- No handling of other `auto_merge_*` actions (`auto_merge_disabled`)
