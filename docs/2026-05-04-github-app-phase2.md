# Phase 2: GitHub App — Open to All Users

**Milestone:** (to be created)

## Goal

Any developer can use brunel on their GitHub repos by installing the brunel GitHub App and running the CLI. No per-repo configuration, no webhook secrets to copy, no admin-scoped tokens.

This milestone merges the original Phase 2 ("other users' repos") and Phase 3 ("easy first-time setup") goals. The GitHub App makes zero-config setup achievable in one milestone rather than two.

**Target user flow:**

```
# One-time: install the brunel GitHub App on your repo(s) at github.com/apps/brunel

npm install -g brunel
export ANTHROPIC_API_KEY=sk-ant-...
cd my-repo
brunel
```

That's the complete setup. No webhook URL, no secrets, no config file.

**Done when** a developer who has never used brunel can go from zero to processing issues in under five minutes, using only the steps above.

---

## Key decisions

### GitHub App as the foundation

A GitHub App replaces the current `workerSecret` + `webhookSecret` + per-operator-token architecture. The App is registered once (by the brunel operator) and gives the foreman a credential that works for any repo where a user installs it.

The App declares exactly the permissions it needs (Issues, Pull Requests, Contents, Metadata — all read/write). Users see what they're granting before they install.

### App installation and activation

Activation is triggered differently depending on how the App was installed:

**Direct repo install** (user selects specific repos during App installation): the foreman receives an `installation` webhook listing exactly which repos were added and activates them immediately — seeding tasks from open `brunel:ready` issues. No worker needs to be running. This is a clear expression of intent to use brunel on those repos.

**Org-level install** ("All repositories" or selected org repos): the foreman records the installation in the `installations` table but does not activate any repos eagerly. An org "all repositories" install could cover hundreds of repos the user has no intention of running brunel on. Instead, activation is deferred: the first time a worker connects claiming a repo under that org, the foreman looks up the installation by `account_login`, links the repo (`repos.installation_id`), activates it, and seeds its tasks — no GitHub API call needed.

In both cases, the `Installation` record is created when the `installation` webhook arrives. The `Repo` row is linked to it (via `installation_id` FK) either immediately on the webhook (direct install) or on first worker connection (org install).

When the App is later uninstalled, the repo is deactivated. Existing task records are preserved; new tasks stop being created and workers stop being assigned.

The existing worker-driven activation prompt (`activate_repo` / `repo_activated`) is preserved for self-hosted setups (local dev, private foreman) where the App is not in use.

### Installation tokens for foreman API calls

The foreman uses the App's private key to mint short-lived installation access tokens (1 hour TTL) scoped to individual repos. These replace the operator's personal `githubToken` for all foreman-side GitHub API calls:

- Fetching open issues on activation
- Checking blocker issue states
- Verifying worker push access

The `githubToken` field in foreman config is replaced by `appPrivateKey` + `appId`. Workers are not involved — they use their own personal GitHub token for git operations and any API calls they make during task execution.

### Worker identity: GitHub token verification

Any worker can claim to work on any repo — the foreman needs to verify the worker actually has push access. The mechanism: the worker sends its GitHub token in `worker_hello`; the foreman calls `GET /repos/{owner}/{repo}/collaborators/{username}/permission` using the installation token and confirms the user has at least `push` access.

The `workerSecret` shared secret is removed. GitHub token verification is naturally repo-scoped and doesn't require a secret to be distributed to users.

### Worker GitHub token sourcing

Workers obtain their GitHub token silently in this order:

1. `gh auth token` — zero config if the GitHub CLI is installed and authenticated (covers most developers)
2. `GITHUB_TOKEN` or `GH_TOKEN` environment variable
3. Prompt the user, with a link to create a fine-grained PAT with the required scopes (`contents: read/write`, `pull_requests: read/write`, `issues: read/write`, `metadata: read`)

The token only needs standard repo-collaborator scopes — no `admin:repo_hook` or elevated permissions, since the App handles webhooks.

### Worker git authentication

Workers use their own personal GitHub token (already obtained for identity verification) for git operations and any GitHub API calls they make during task execution.

**Git authentication uses `http.extraHeader`, not a token-in-URL.** After cloning, the workspace sets:

```bash
git config --local http.https://github.com/.extraheader "Authorization: Bearer {token}"
```

The remote URL stays clean (`https://github.com/owner/repo.git`). This is how GitHub Actions handles `GITHUB_TOKEN` internally — the token doesn't appear in `git remote -v` or process listings. The existing clone-URL approach in `Workspace` is replaced with this pattern as part of this work.

### App not installed: clear error

When a worker connects claiming a repo where the App is not installed, the foreman sends a non-fatal `foreman_error` with a message and install URL. The worker displays it clearly:

```
Brunel is not installed on owner/my-repo.
Install it at: https://github.com/apps/brunel
Then run brunel again.
```

The worker exits worker mode and returns to the REPL.

### Self-hosted / local dev

Developers running their own foreman (local dev, private deployment) continue to use the existing flow: `workerSecret` for auth, manual webhook setup via smee, and the worker-driven activation prompt. Nothing in this milestone breaks the existing single-user self-hosted setup.

### Public foreman URL as default

`brunel.dev` is the production domain. It serves the foreman dashboard (same as today) and handles GitHub App webhooks at `https://brunel.dev/webhook`. The worker WebSocket connects to `wss://brunel.dev`.

The worker's `foremanUrl` config defaults to `wss://brunel.dev`. A developer with no config file connects to the public foreman automatically.

---

## DB changes

One new table and one new column:

```sql
CREATE TABLE installations (
  id            bigserial PRIMARY KEY,
  github_id     bigint NOT NULL UNIQUE,  -- GitHub's installation_id
  account_login text NOT NULL,           -- org or user login
  account_type  text NOT NULL CHECK (account_type IN ('User', 'Organization')),
  created_at    timestamptz DEFAULT now()
);

ALTER TABLE repos ADD COLUMN installation_id bigint REFERENCES installations(id);
```

`installations` tracks GitHub App installations as first-class records. A row is created when the `installation` webhook arrives and deleted on uninstall. `github_id` is the value passed to all GitHub API calls (token minting, etc.).

`repos.installation_id` is a nullable FK to `installations.id`. `NULL` means the App is not in use for that repo (self-hosted / legacy). For direct-repo installs the FK is set immediately when the webhook arrives; for org-level installs it is set on first worker connection.

---

## Wire protocol changes

### `worker_hello` (worker → foreman)

- Add `githubToken: string` — the worker's personal GitHub token for identity verification
- Remove `workerSecret?: string`

---

## Issue breakdown

> **Note:** This is a preliminary list of planned issues, not kept up to date. For current status, see the GitHub milestone.

Each issue must leave the app fully functional for existing users. New App-based pathways are additive alongside the existing `workerSecret` / personal-token pathways; neither is removed during this milestone (cleanup is a separate decision).

| # | Title | Depends on |
|---|-------|------------|
| — | Register brunel GitHub App (operator task) | — |
| TBD | Add `installations` table (`github_id`, `account_login`, `account_type`) and nullable `installation_id` FK on `repos` | — |
| TBD | Foreman: add App credentials to config (`appId`, `appPrivateKey`, `appWebhookSecret` — all optional); `GithubClient` gains installation-token minting; falls back to personal `githubToken` when App not configured | `installation_id` column |
| TBD | Foreman: handle `installation` / `installation_repositories` webhooks → create/delete `Installation` records; auto-activate direct-repo installs (link repos, seed tasks); for org installs store the installation only — repos linked on first worker connect; deactivate on uninstall; uses installation token for seeding | App credentials in config |
| TBD | Foreman: worker auth via GitHub token (additive) — `worker_hello` gains optional `githubToken`; when App is configured and repo has `installation_id`, verify push access via installation token; existing `workerSecret` path unchanged | App credentials in config |
| TBD | Worker: source GitHub token from `gh auth token` → env var → prompt; switch git auth from token-in-URL to `extraHeader` (additive — existing env var / config still works) | — |
| TBD | Worker: handle App-not-installed `foreman_error` — display message and install link; older workers treat it as a generic error (acceptable) | Worker auth |
| TBD | Worker: default `foremanUrl` to `wss://brunel.dev` (existing explicit config overrides it) | — |
| TBD | Versioning + npm publish (see #892) | All of the above |

Ready to start immediately: **`installation_id` column**, **`gh`-based token sourcing**, and **default foreman URL** (all independent of each other and of everything else).

---

## Out of scope

- Per-user dashboard views (users log in with GitHub and see only their own repos/tasks — separate milestone)
- Private repo support beyond what GitHub App permissions already provide

The dashboard at brunel.dev is intentionally public and read-only. Users who need privacy can self-host.
