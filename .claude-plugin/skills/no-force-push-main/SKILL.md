---
name: no-force-push-main
description: Use when about to run git push --force or --force-with-lease targeting main or any shared protected branch
---

# No Force-Push to Main

## Don't. Here's Why.

`git push --force` (or `--force-with-lease`) to `main` rewrites shared history. It destroys other people's (and other agents') references to commits, causes divergence requiring manual recovery, and is the #1 cause of lost work in collaborative repos. **Never force-push to main.**

## Feature Branches Are Different

On **feature branches**, `--force-with-lease` is correct after a rebase. Rebasing rewrites commit SHAs, so a plain `git push` will be rejected. Use `--force-with-lease` (not `--force`) — it fails safely if someone else pushed to your branch since your last fetch:

```bash
# After rebasing a feature branch:
git push --force-with-lease   # ✓ safe on feature branches after rebase
git push --force              # ✗ never — bypasses the safety check
                              # ✗ never to main — under any circumstances
```
