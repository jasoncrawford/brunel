---
name: semver
description: Use when a PR has been merged and you need to decide whether to recommend a version bump, and at what level (patch/minor/major)
---

# Semver Version Bump Guidance

## When to Recommend a Bump

| Change type | Bump |
|---|---|
| Bug fix, small improvement | `patch` |
| New user-facing feature | `minor` |
| Breaking change to public API, CLI, or protocol | `minor` (while in 0.x) / `major` (1.x+) |
| Internal refactor, doc-only, test-only | none |

## The 0.x Rule

While the package is at `0.x`, breaking changes can ship in a `minor` bump — the major version staying at 0 signals "not yet stable." Reserve `major` (1.0.0) for when you're ready to make a stability commitment to users.

## What Counts as Breaking (General)

- Removing or renaming anything a consumer depends on (commands, flags, exported APIs, config keys)
- Changing the shape of inputs or outputs in a non-backward-compatible way
- Dropping support for a previously supported runtime, platform, or protocol version

Additive changes (new optional fields, new commands, new exports) and internal implementation changes are **not** breaking.

## What to Tell the User

Do **not** include the version bump in the PR — it causes merge conflicts when multiple agents are working in parallel. Instead, after the PR merges, recommend:

> This change warrants a **patch/minor** bump. When you're ready to publish, run the appropriate version bump command for this project.

Keep it short — one sentence on why, what level, done. The project docs or CLAUDE.md should have the exact publish command.
