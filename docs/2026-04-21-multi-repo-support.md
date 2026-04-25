# Multi-repo support

**Milestone:** [Multi-repo support](https://github.com/jasoncrawford/brunel/milestone/6)

## Goal

Any GitHub repo can use Brunel by pointing a webhook at the public foreman and running a worker. Phase 1 covers multiple repos owned by the same user. The north star is: `npm install -g brunel && brunel` — the worker auto-detects your repo, connects to the public foreman, and starts processing issues.

Done when a worker can connect, activate a new repo, and process issues from any GitHub repo without `repo` being a config value.

## Key decisions

### Repos table

A `repos` table gives repos a stable identity independent of their name. Repo names can change; a string copy on related tables would become stale. All other tables reference `repos.id` (FK), not the name string.

Schema: `id`, `full_name` (owner/name), `status` (`'new' | 'active'`), `created_at`.

`status` is an enum (not a boolean) for future extensibility.

### repo_id on related tables

- **`tasks`**: add `repo_id` FK, drop the existing `repo text` column. Also fix `UNIQUE(issue_number)` → `UNIQUE(issue_number, repo_id)` — issue numbers are repo-scoped; two repos can both have issue #42.
- **`webhook_events`**: add `repo_id` FK, replace existing `repo text` column. Same rename-safety argument.
- **`foreman_messages`**: add `repo_id` FK. Not every message has a task (`worker_hello`, `hello_ack`, `worker_idle`, etc.), so joining through `task_id` is insufficient; a direct FK is needed to scope all messages to a repo.

### Repo-scoped Task lookups

All Task lookups by issue number or PR number must become repo-scoped. Static methods like `Task.getByIssueNumber(n)` and `Task.getByPr(n)` are ambiguous in a multi-repo world. Preferred approach: make these methods on `Repo` (e.g. `repo.getTaskByIssueNumber(n)`, `repo.getTaskByPr(n)`) so the scoping is enforced by the type system and impossible to forget.

### Repo find-or-create

The foreman calls `Repo.findOrCreate(fullName)` whenever a repo is first seen — on webhook arrival or on worker `hello`. This is automatic and silent; the repo is created with `status = 'new'`.

### Active flag / status

A `'new'` repo is known to the foreman but not yet in play:
- Webhook events for `'new'` repos are no-op'd (no tasks created or updated)
- Workers for `'new'` repos are not assigned tasks

Only `'active'` repos have tasks processed and workers assigned.

### Activation is worker-driven (not dashboard-driven)

All interaction happens through the agent, not the dashboard. Flow:

1. Worker connects, sends `worker_hello` with `repo` field
2. Foreman finds-or-creates `Repo`, includes `repoStatus: 'new' | 'active'` in `hello_ack`
3. If `'new'`: worker prompts user ("Repo `owner/name` is new — activate it? [y/n]")
4. On confirm: worker sends `activate_repo` message; foreman sets `status = 'active'` and fetches all open `brunel:ready` issues from GitHub to seed initial tasks
5. Worker then proceeds normally

### Repo on Worker model

`Worker` (in-memory foreman model) gets a `repo: Repo` field — a model object, not a string, consistent with the project convention of passing model objects rather than IDs. Set from the `worker_hello` message.

### Per-repo TaskManager

TaskManager holds in-memory state that is fundamentally per-repo: `_openIssues` (issue numbers), `_blockers` (issue number → blocker issue numbers), `_blockersLoaded` (issue numbers), `branchToTaskId` (branch name → task ID). All of these are keyed by bare numbers or branch names — if two repos share an issue number or branch name, the data collides and corrupts.

The fix: **one TaskManager instance per repo**, with a static registry.

- `TaskManager` has a static `Map<repoId, TaskManager>` internally
- `TaskManager.forRepo(repo: Repo): TaskManager` — static method, finds or creates the instance for a repo
- Each instance holds `repo: Repo` and all the per-repo in-memory state
- `Repo` gets a convenience getter `get taskManager(): TaskManager` that calls `TaskManager.forRepo(this)`
- `Repo` itself stays a plain ActiveRecord with no singleton/long-lived behavior — the lifecycle responsibility lives on TaskManager's static registry
- The assignment lock becomes per-repo (each repo is a silo)
- `EventQueue` is keyed by `taskId` (globally unique) — can live on the per-repo instance without issue

The current singleton TaskManager created in `src/foreman/index.ts` goes away. Callers use `repo.taskManager` or `TaskManager.forRepo(repo)`.

**Future consideration:** ActiveRecord identity-map interning (ensuring only one `Repo` instance per ID at a time) is a potential future improvement but out of scope for this milestone.

### Task assignment scoping

`repo.taskManager.tryAssignWork(worker)` assigns from the repo's pending tasks. Skips repos whose status is not `'active'`.

### Repo removed from config

`githubRepo` is currently a required config option. The end state: workers detect repo from `git remote get-url origin`; the foreman derives repo from webhook payloads and worker hellos. `githubRepo` becomes optional/removed.

## Out of scope (Phase 1)

- Other users' repos (Phase 2)
- Easy first-time setup / `brunel init` (Phase 3)
- GitHub App (per-repo webhooks configured manually for now)
- User accounts or credentials on the foreman
- Private repo support (public repos only for now)

## Phase 3+: Public server security

When opening the foreman as a public server (any user can connect their repo), two attack surfaces need hardening:

### Webhook authentication

The current single `webhookSecret` doesn't scale — anyone with the secret can forge events for any repo. Options:

- **Per-repo webhook secrets** — generate a unique secret per repo on activation, store in DB, verify incoming webhooks against the secret for that repo. Users paste their secret into GitHub's webhook settings. Strong, no shared-secret problem, but adds a setup step.
- **GitHub IP allowlisting** — GitHub publishes its webhook source CIDR ranges at `https://api.github.com/meta` (`hooks` key). No setup step for users, but weaker (IP spoofing isn't cryptographically impossible; the list needs periodic refresh).
- **GitHub App** — single App-level webhook secret you control; the installation model handles per-repo authorization automatically. The cleanest long-term answer for a true public service.

No direction chosen yet. Per-repo secrets + GitHub App migration later is a reasonable phased path.

### Worker authentication

The current `workerSecret` is a single shared secret — anyone with it can connect a worker to any repo. For a public server, replace with **GitHub token verification**: the worker sends its GitHub token in `worker_hello`; the foreman calls the GitHub API to confirm that token has push access to the claimed repo. No shared secret needed; authorization is naturally scoped per-repo.

## Issue breakdown

| # | Title | Depends on |
|---|-------|------------|
| [#783](https://github.com/jasoncrawford/brunel/issues/783) | Add `repos` table and `Repo` active-record model | — |
| [#784](https://github.com/jasoncrawford/brunel/issues/784) | Fix `UNIQUE(issue_number)` → `UNIQUE(issue_number, repo_id)` | #783 |
| [#785](https://github.com/jasoncrawford/brunel/issues/785) | Add `repo` to `worker_hello`; store `Repo` on `Worker` model; add `repo_id` to `foreman_messages` | #783 |
| [#786](https://github.com/jasoncrawford/brunel/issues/786) | Find-or-create repo on webhook; skip non-active repos; add `repo_id` to `webhook_events` | #783 |
| [#787](https://github.com/jasoncrawford/brunel/issues/787) | Repo activation flow via worker | #783, #785 |
| [#788](https://github.com/jasoncrawford/brunel/issues/788) | Repo-scoped task assignment in `TaskManager` | #783, #784, #785, #787 |
| [#789](https://github.com/jasoncrawford/brunel/issues/789) | Dashboard repo support | #783, #785 |
| [#790](https://github.com/jasoncrawford/brunel/issues/790) | Remove `repo` from config | #785, #786, #787, #788 |

Ready to start immediately: **#783** (everything else flows from it).
