#!/usr/bin/env bash
# Configures branch protection rules for the main branch.
# Run this after adding new CI jobs to ensure they are all required.
#
# Prerequisites: gh CLI authenticated with admin access to the repo.
# Usage: ./scripts/configure-branch-protection.sh

set -euo pipefail

REPO="${GITHUB_REPOSITORY:-jasoncrawford/brunel}"
BRANCH="main"

echo "Configuring branch protection for ${REPO}:${BRANCH}..."

gh api \
  --method PUT \
  "repos/${REPO}/branches/${BRANCH}/protection" \
  --field "required_status_checks[strict]=true" \
  --field "required_status_checks[checks][][context]=test" \
  --field "required_status_checks[checks][][context]=browser-test" \
  --field "required_status_checks[checks][][context]=smoke" \
  --field "required_status_checks[checks][][context]=Analyze" \
  --field "enforce_admins=true" \
  --field "required_pull_request_reviews[required_approving_review_count]=0" \
  --field "restrictions=null" \
  --field "allow_force_pushes=false" \
  --field "allow_deletions=false"

echo "Done. Required checks: test, browser-test, smoke, Analyze"
