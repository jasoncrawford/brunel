---
name: no-cherry-pick
description: Use when about to run git cherry-pick, or when thinking that cherry-picking commits between branches is the right solution to a problem
---

# No Cherry-Pick

## Don't. Here's Why.

`git cherry-pick` creates duplicate commits with different SHAs, fractures history, and causes confusion about what's been merged. **It is an anti-pattern. Do not use it without explicit user permission.**

## The Most Common Temptation: Depending on an Unmerged PR

You need code that exists in another branch that hasn't merged yet. Do not cherry-pick those commits. Instead:

1. **Stop work** on the current task
2. **Identify the blocking PR** — note its number and what it provides
3. **Tell the user** clearly: "I can't proceed until PR #N is merged. It provides [X]. Please merge it and let me know."
4. **Wait** — do not duplicate the code, do not work around it, do not cherry-pick

This is correct even if the wait feels inefficient. Cherry-picking from an unmerged PR creates a hidden dependency, risks double-applying changes when the PR eventually merges, and bypasses review for that code.

## If Rebase Fails

If `git rebase origin/main` fails unexpectedly, cherry-pick is not a substitute. Stop, explain what failed, and ask the user to decide the path forward. See `rebase-false-dirty` if the tree appears clean but rebase reports local changes.
