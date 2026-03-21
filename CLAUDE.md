# brunel

A GitHub-driven autonomous agent. Labels a GitHub issue `brunel:ready` → the foreman picks it up, assigns it to a worker → the worker runs a Claude Agent SDK loop and labels it `brunel:done` when finished.

## Architecture

- **`src/foreman.ts`** — HTTP server + WebSocket server. Polls GitHub for `brunel:ready` issues, queues them, and assigns them to idle workers over WebSocket.
- **`src/repl.ts`** — Interactive REPL (default) or worker process (`--worker-mode`). Workers connect to the foreman, receive tasks, run Claude Agent SDK sessions, and report completion.
- **`src/config.ts`** — Unified config loader. Merges CLI flags, `BRUNEL_*` env vars, `brunel.config.ts` file, legacy env vars, and built-in defaults via zod schema.
- **`src/display.ts`** — Shared display/rendering engine used by both foreman and worker.
- **`src/types.ts`** — Shared types: `WorkerMessage`, `ForemanMessage`, `TaskIssue`, `GitHubEvent`.

## Dev workflow

Three terminals:

```
# terminal 1 — proxy GitHub webhooks to localhost
npx smee-client --url https://smee.io/YOUR_CHANNEL --target http://localhost:3000/webhook

# terminal 2 — run the foreman
npm start

# terminal 3 — run a worker
npm run worker
```

Config (in `.env` or `brunel.config.ts`; CLI flags also accepted). Precedence: CLI flags > `BRUNEL_*` env vars > config file > legacy env vars > defaults.

Required:
- `BRUNEL_GITHUB_REPO` / `GITHUB_REPO` — e.g. `owner/repo`
- `BRUNEL_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN` — personal access token with `repo` scope (`GH_TOKEN` is forwarded automatically in the devcontainer)
- `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` — for Claude Agent SDK (the OAuth token is used automatically if you're running inside Claude Code)

Optional (all have defaults):
- `BRUNEL_TASK_LABEL` / `TASK_LABEL` — label that triggers work (default: `brunel:ready`)
- `BRUNEL_DONE_LABEL` / `DONE_LABEL` — label applied on completion (default: `brunel:done`)
- `BRUNEL_PORT` / `PORT` — foreman HTTP/WebSocket port (default: `3000`)
- `BRUNEL_WEBHOOK_SECRET` / `WEBHOOK_SECRET` — GitHub webhook secret for signature verification (optional)
- `BRUNEL_FOREMAN_URL` — WebSocket URL workers connect to (default: `ws://localhost:3000`); **no legacy fallback for this one**
- `BRUNEL_VERBOSE` — enable verbose Claude output (default: `false`)
- `BRUNEL_PERMISSION_MODE` — Claude permission mode: `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk` (default: `default`)

## Git workflow

- Always create a feature branch and PR for changes — never commit directly to `main`.
- Do NOT auto-merge PRs — leave merging to the user after UAT.

## Useful scripts

- `npm test` — unit tests (vitest)
- `npm run smoke` — end-to-end smoke test: spawns real foreman + worker and asserts they connect
- `npm run lint` — ESLint (`no-floating-promises` as error, `no-explicit-any` as warn)
- `npx tsc --noEmit` — type check

All four run in CI on every PR.

## Key conventions

- TypeScript with ESM (`"type": "module"`). New dependencies must be ESM-compatible.
- No compilation step — `tsx` runs TypeScript directly.
- Webhook secret is optional for local dev; set `BRUNEL_WEBHOOK_SECRET` in `.env` to enable signature verification.
