# Cloud Deployment — Design Spec

**Date:** 2026-03-21
**Status:** Approved

---

## Summary

Move the brunel foreman from a local dev machine to a cloud-hosted server. This eliminates the need for smee.io webhook forwarding, makes the foreman always-on, and enables beta users to connect their own workers without any server setup. The same deployment adds persistent event logging via Supabase and a React-based admin GUI served from the foreman itself.

---

## Motivation

- **Always-on:** Foreman currently requires a running laptop and smee.io proxy. Issues are missed when the machine is off.
- **Beta users:** Sharing brunel with others requires them to run a foreman, which is a significant setup burden. A public hosted foreman means users just run `npm run worker`.
- **Observability:** No persistent record of webhooks, task history, or worker messages. Debugging requires reading console output live.

This is the first of three planned milestones:
1. **This milestone:** Cloud deployment + Supabase logging + admin GUI
2. **Future:** Multi-tenancy (per-user isolation, auth, public hosted server)
3. **Future:** Cloud-hosted workers

---

## Architecture

The foreman remains a single Node.js process. Three things are added:

```
GitHub ──webhook──▶ ┌─────────────────────────────────────┐
                    │  Foreman (Node.js on Railway)       │
                    │                                     │
                    │  In-memory: TaskQueue, WorkerReg.   │
                    │  Supabase:  event log               │
                    │                                     │
                    │  /webhook    HTTP                   │
                    │  /worker     WebSocket (workers)    │
                    │  /admin/ws   WebSocket (GUI)        │
                    │  /*          React SPA (static)     │
                    └─────────────────────────────────────┘
                         │ wss://           │ https://
                    Workers (local)    Browser (admin GUI)
```

**What stays the same:** `TaskQueue`, `WorkerRegistry`, the `/worker` WebSocket protocol, all webhook routing logic, GitHub-based crash recovery on restart.

**What's new:**
- **Supabase logging** — every incoming webhook and every foreman↔worker message written append-only to two tables
- **Admin WebSocket (`/admin/ws`)** — broadcasts live state snapshots and log events to browser clients
- **React SPA** — built with Vite, served as static files from the foreman's HTTP server
- **Deployment** — Railway with a real public URL, managed TLS, git-push deploys

---

## Hosting & Deployment

**Platform: Railway**

Railway provides git-push deploys, managed TLS, persistent env vars, and keeps a Node.js WebSocket server running without cold starts. It is the most managed PaaS option suitable for persistent WebSocket connections.

| Today | Cloud |
|-------|-------|
| `npm start` on local machine | Railway runs `npm start` on git push to `main` |
| smee.io forwards webhooks to localhost | GitHub webhook URL → `https://your-app.railway.app/webhook` |
| Workers: `BRUNEL_FOREMAN_URL=ws://localhost:3000` | Workers: `BRUNEL_FOREMAN_URL=wss://your-app.railway.app` |
| `WEBHOOK_SECRET` optional | `WEBHOOK_SECRET` required (public endpoint) |

**Build step:** `npm run build` runs `vite build` (new, for the React frontend). Start command stays `npm start`.

**Deployment flow:**
1. Connect Railway project to the GitHub repo
2. Set env vars in Railway (see Configuration section)
3. Update GitHub repo webhook URL to the Railway URL
4. Workers update `BRUNEL_FOREMAN_URL` in their `.env`

---

## Database Schema

Two append-only logging tables in Supabase. No updates, no deletes.

```sql
create table webhook_events (
  id            bigint generated always as identity primary key,
  received_at   timestamptz not null default now(),
  delivery_id   text,
  event_name    text not null,
  action        text,
  repo          text,           -- repository.full_name
  sender        text,           -- sender.login
  issue_number  int,
  pr_number     int,
  branch        text,           -- head branch for push/check events
  task_id       text,
  payload       jsonb not null
);

create index on webhook_events (task_id);
create index on webhook_events (received_at desc);

create table foreman_messages (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  direction   text not null,  -- "sent" | "received"  (foreman's perspective)
  worker_id   text,
  task_id     text,
  msg_type    text not null,
  payload     jsonb not null
);

create index on foreman_messages (task_id);
create index on foreman_messages (worker_id);
create index on foreman_messages (created_at desc);
```

Logging is **fire-and-forget** — DB writes are not awaited and failures are logged but never thrown. DB unavailability must not block webhook processing or worker communication.

Supabase is optional at runtime: if `BRUNEL_SUPABASE_URL` is absent, logging is silently skipped. This keeps local dev and test simple — no Supabase required unless desired.

---

## Web GUI

**Tech:** React + Vite, served as static files from the foreman's HTTP server. No separate deployment.

**Build & serve:** `npm run build` outputs to `dist/`. The foreman serves `dist/` for any route not matched by `/webhook`, `/worker`, or `/admin/ws`. In dev, Vite's dev server proxies `/admin/ws` (WebSocket) to the foreman; `/webhook` is not proxied (no need to forward GitHub webhooks through the frontend dev server).

**Frontend project structure:** `frontend/` is a standalone Vite+React project with its own `package.json`. The root `package.json` `build` script runs `cd frontend && npm install && npm run build` to produce `dist/`. This avoids npm workspaces complexity for a single frontend package.

**Realtime:** A single `/admin/ws` WebSocket path that the GUI subscribes to. The foreman broadcasts two message types with the following wire format:

```ts
// Foreman → GUI
type AdminMessage =
  | { type: "snapshot"; tasks: TaskSnapshot[]; workers: WorkerSnapshot[] }
  | { type: "log_event"; entry: LogEntry }

interface TaskSnapshot {
  taskId: string; issueNumber: number; title: string;
  status: "pending" | "assigned" | "complete"; assignedWorkerId?: string;
}
interface WorkerSnapshot {
  workerId: string; status: "idle" | "busy"; currentTaskId?: string;
}
interface LogEntry {
  kind: "webhook" | "message";
  id: number; timestamp: string; taskId?: string; workerId?: string;
  summary: string;  // e.g. "issues/labeled #42" or "sent task_assigned"
}
```

`snapshot` is sent on connect and whenever task queue or worker registry changes. `log_event` is sent each time a row is written to Supabase (or would have been, if Supabase is absent).

**Pages:**

| Page | URL | Data sources |
|------|-----|--------------|
| Dashboard | `/` | In-memory state (via `/admin/ws` snapshots) + recent event log feed |
| Event log | `/log` | Supabase query on load + live stream via `/admin/ws` |
| Task detail | `/tasks/:id` | Supabase query (task events) + live updates via `/admin/ws` |
| Worker detail | `/workers/:id` | Supabase query (worker messages) + live updates via `/admin/ws` |

The dashboard includes a live event feed (recent webhooks and messages) in addition to the task queue and worker pool views.

**Auth:** None. The admin GUI is read-only and brunel manages public GitHub repos — no sensitive data is exposed.

---

## Security

- **Webhook secret:** `BRUNEL_WEBHOOK_SECRET` required in production. Set in Railway env vars and in the GitHub repo's webhook settings. (Already supported; now enforced.)
- **Worker secret:** `BRUNEL_WORKER_SECRET` is optional. If set, the foreman rejects `worker_hello` messages that don't include it. If unset, any worker can connect (preserving current open behavior). Workers set `BRUNEL_WORKER_SECRET` in their `.env`.
- **Admin GUI:** No auth. Read-only.
- **Multi-tenant auth:** Out of scope — revisited in the multi-tenancy milestone.

---

## Configuration

New fields added to `BrunelConfig` in `src/config.ts`, following the same layered pattern as existing fields (file config → `BRUNEL_*` env → fallback env → CLI flag → default):

| Config field | `BRUNEL_*` env var | CLI flag | Default |
|---|---|---|---|
| `supabaseUrl` | `BRUNEL_SUPABASE_URL` | `--supabase-url` | (optional) |
| `supabaseServiceRoleKey` | `BRUNEL_SUPABASE_SERVICE_ROLE_KEY` | `--supabase-service-role-key` | (optional) |
| `workerSecret` | `BRUNEL_WORKER_SECRET` | `--worker-secret` | (optional) |

`supabaseServiceRoleKey` and `workerSecret` should emit a `console.warn` if found in a config file (same treatment as `webhookSecret` and `githubToken` in the unified config spec — any credential that grants access should warn).

Both `supabaseUrl` and `supabaseServiceRoleKey` must be present for logging to be enabled; either alone is treated as absent.

---

## Environments

Three isolated environments. All flat — no inheritance.

| Environment | DB | Config location |
|---|---|---|
| **test** | Local Supabase CLI, `test` schema | `.env.test` (checked in) |
| **dev** | Local Supabase CLI, `public` schema | `.env` (checked in) |
| **production** | Cloud Supabase project | Railway env vars (never in files) |

**Local Supabase CLI** (`supabase start`) provides a full Postgres + Supabase stack at `http://localhost:54321`. Dev and test point at the same local instance with different schemas for isolation.

Supabase is optional in dev/test — omit `BRUNEL_SUPABASE_URL` from `.env` and `.env.test` to run without DB logging. Tests that exercise logging inject a stub Supabase client; existing tests are unaffected.

**Environment files:**
- `.env` — extended with optional `BRUNEL_SUPABASE_URL` / `BRUNEL_SUPABASE_SERVICE_ROLE_KEY` (local CLI values)
- `.env.test` — same local Supabase URL if testing DB paths, otherwise omitted
- `.env.local` — gitignored (personal overrides)
- No `.env.production` file ever

**Migration files** live in `supabase/migrations/`. Applied to production via Supabase GitHub integration (same pattern as site-status). "Deploy to production" must be enabled in Supabase GitHub integration settings.

---

## Code Structure

### New files

- **`src/db.ts`** — Supabase client initialisation + fire-and-forget helpers: `logWebhookEvent()`, `logForemanMessage()`. Accepts an injectable client for testing. No-ops if Supabase is not configured.
- **`src/admin-ws.ts`** — `/admin/ws` WebSocket server. Maintains a set of connected GUI clients. Exposes `broadcastState(snapshot)` and `broadcastLogEvent(entry)` for the foreman to call.
- **`frontend/`** — Vite + React project with its own `package.json`. Builds to `dist/`. Contains the four pages described above.
- **`supabase/migrations/`** — SQL migration files for the two logging tables.

### Modified files

- **`src/foreman.ts`** — call `logWebhookEvent()` on each webhook; call `logForemanMessage()` on each WS send/receive; instantiate and wire up `AdminWss`; serve `dist/` as static files for unmatched routes; read new config fields (`supabaseUrl`, `supabaseServiceRoleKey`, `workerSecret`).
- **`src/config.ts`** — add `supabaseUrl`, `supabaseServiceRoleKey`, `workerSecret` to `BrunelConfig` and `BrunelConfigSchema`.
- **`package.json`** — add `build` script (`vite build`); add `frontend` workspace or pre-build step.
- **`.env` / `.env.test`** — add optional Supabase vars.

### Unchanged

`src/repl.ts`, `src/worker.ts`, `src/types.ts`, `src/display.ts`, `src/dependencies.ts`, `src/github.ts` — the worker protocol and all existing logic are untouched.

---

## Out of Scope

- Multi-tenancy (per-user isolation, auth, user accounts)
- Cloud-hosted workers
- Automatic PR merging
- GUI write operations (triggering tasks, managing workers)
- Supabase Realtime subscriptions (polling or WebSocket broadcast from foreman is sufficient for now)
