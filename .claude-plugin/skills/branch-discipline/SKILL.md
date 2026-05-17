---
name: branch-discipline
description: Use when editing files in projects that have CI or PRs set up, or otherwise use branches, or whenever multiple agents might work in parallel
---

# Branch Discipline

## When This Skill Applies

This skill applies when a project has:
- GitHub CI configured (Actions workflows, branch protection rules), **or**
- Pull requests as the standard integration path, **or**
- Multiple agents working in parallel on independent tasks

**It may not apply** in the earliest experimental or prototype stages of a project, or in small repos that have no automated tests and consist mainly of config rather than code — situations where the overhead of branches and PRs adds friction without providing meaningful safety. When in doubt, ask the user.

## Overview

All changes go through branches and pull requests. Nothing is ever committed directly to main. The only way code reaches main is through a PR that passes CI. No exceptions — not for "quick fixes," not for "just one line," not for config changes.

## The Rule

```
main is read-only. Always.
```

## Worktrees

Whether you need a worktree depends on your environment:

- **Isolated checkout** (e.g., a worker agent with its own cloned workspace): just create a branch — you're already isolated.
- **Shared checkout** (a repo directory used by multiple agents or by a human alongside you): use a worktree to avoid cross-contamination. See the `superpowers:using-git-worktrees` skill.

## Workflow

1. **Pull latest main** before making any changes
2. **Create a branch** (and a worktree if needed — see above)
3. **Do all work** on the branch — commits, edits, iterations
4. **Push the branch and open a PR** — but do not auto-merge
5. **CI runs** automatically on the PR
6. **User reviews** → merges when satisfied → branch is deleted
7. **CI fails** → fix on the same branch, push again, CI re-runs

**Never enable auto-merge.** Always leave the PR open for the user to review and merge.

**Create the PR proactively.** Don't wait to be asked — when the branch is ready, push it and open the PR as part of completing the work.

If this PR resolves a GitHub issue, include a closing keyword in the PR body: `Closes #42` / `Fixes #42` / `Resolves #42`. A plain link (`see #42`) does NOT auto-close the issue on merge.

## Anti-Patterns

**Never cherry-pick** — see `no-cherry-pick` skill. If you think you need it, you have a workflow problem. Ask the user.

**Never force-push to main** — see `no-force-push-main` skill. On feature branches, `--force-with-lease` after a rebase is correct. On main, never.

**Bad git state?** Ask the user before taking any destructive action. Explain what went wrong and propose a safe fix.

## Branch Naming

Keep it short and descriptive. Use the work being done, not metadata:

- `add-hyperlink-support`
- `fix-cursor-position`
- `ci-setup`
- `issue-42-sync-retry`

## When CI Fails

Fix on the same branch. Do not:
- Merge with failing CI
- Bypass branch protection
- Push the fix directly to main "to unblock things"

The branch stays open until CI is green. This is the point — the gate works because it's non-negotiable.

## When PR Review Requests Changes

Push fixes to the same branch — the PR updates automatically. See `receiving-code-review` skill. Do not open a new PR.

## Multiple Workstreams

Each piece of work gets its own branch, based on current main. Don't stack branches. If main moves forward, rebase before merging.

## What Belongs on a Branch

Everything — features, fixes, refactors, config, docs, dependency upgrades, "one-line fixes." No change is too small to skip the branch workflow.

## One Concern Per Branch

**Each branch must contain only work related to a single concern.** Never commit work for concern X onto a branch that belongs to concern Y.

This applies especially to spec and plan documents: a spec or plan for feature X must go on its own dedicated branch (e.g., `docs/feature-x`), not on an existing feature branch for unrelated work. Mixing concerns:
- Makes PR review confusing ("why is this plan doc here?")
- Can require destructive cleanup (force-push) to separate them
- Creates misleading history

Before committing any spec, plan, or document: check your current branch. If it belongs to different work, create a new dedicated branch first.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "It's just a one-line fix" | One-line fixes can break things. Branch takes 30 seconds. |
| "CI is slow, I'll push to main and fix later" | "Fix later" means "forget and ship broken." |
| "I'm the only one working on this" | Once CI exists, you're not — AI agents may be working in parallel, and future-you is a collaborator too. |
| "I need this on main right now" | Push the branch, CI runs in minutes. If it's truly urgent, the test suite is your friend, not your obstacle. |
| "Branch protection is slowing me down" | The "slowness" is CI doing its job. Push, open a PR, let the user review. |
| Deleting a branch without pulling main first | `git branch -d` can't verify the branch is merged until local main is up to date. Always `git pull --rebase origin main` before cleanup — otherwise you'll need `git branch -D` (force delete). |

## Checklist

- [ ] Currently on a branch, not main
- [ ] `git pull --rebase origin main` run before branching
- [ ] Branch is based on latest main
- [ ] Tests written for any new behavior or bug fixes (see `no-skipped-tests`)
- [ ] All tests pass with zero skipped
- [ ] Checked whether CLAUDE.md, README, or other project docs need updating to reflect this change; included any updates in this PR
- [ ] PR created — auto-merge NOT enabled; left for user to review and merge
- [ ] PR body includes `Closes #N` / `Fixes #N` / `Resolves #N` if this resolves a GitHub issue (a plain link does not auto-close)
- [ ] CI passing before merge (enforced by branch protection)
- [ ] Branch deleted after merge
