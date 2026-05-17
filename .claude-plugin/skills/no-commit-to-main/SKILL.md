---
name: no-commit-to-main
description: Use when about to run git commit while on the main or master branch
---

# No Commits to Main

## Don't. Here's Why.

Committing directly to `main` bypasses code review, CI, and the PR workflow. It can block other agents working in parallel, creates noise in the main branch history, and is hard to cleanly revert. **Never commit to main** — not for docs, not for one-liners, not for anything.

## Do This Instead

```bash
# Before committing, check your branch:
git branch --show-current   # if this prints "main", stop

# Create a branch first, then commit:
git checkout -b short-description
git commit -m "..."
git push -u origin short-description
gh pr create --title "..." --body "..."
```

## If You Already Committed to Main

The commit hasn't been pushed yet — recover cleanly:

```bash
# 1. Create a branch from the accidental commit
git checkout -b short-description

# 2. Reset main back to origin
git checkout main
git reset --hard origin/main

# 3. Push the branch and open a PR
git checkout short-description
git push -u origin short-description
gh pr create --title "..." --body "..."
```
