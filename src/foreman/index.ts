// ── Foreman entry point — wires components and starts server ─────────────────

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../database.types.js";
import { Webhooks } from "@octokit/webhooks";
import { loadConfig } from "../config.js";
import { TaskManager } from "./models/task-manager.js";
import { Repo } from "./models/repo.js";
import { initDb } from "./clients/db-client.js";
import { Worker } from "./models/worker.js";
import { createHttpServer } from "./controllers/http-server.js";
import { ForemanWss } from "./controllers/wss.js";
import { createAdminWss } from "./controllers/admin-ws.js";
import { fmtError, log } from "../utils.js";

// Only start listening when run directly (not when imported by tests)
import { fileURLToPath } from "url";
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const config = await loadConfig(process.argv);

  const webhooks = config.webhookSecret
    ? new Webhooks({ secret: config.webhookSecret })
    : null;

  // Setup DB (share the same Supabase client)
  if (!config.supabaseUrl || !config.supabaseSecretKey) {
    log("ERROR Supabase is required. Set BRUNEL_SUPABASE_URL and BRUNEL_SUPABASE_SECRET_KEY.");
    process.exit(1);
  }
  const supabase = createClient<Database>(config.supabaseUrl, config.supabaseSecretKey);
  initDb(supabase);

  let foremanWss: ForemanWss;
  const server = createHttpServer({ webhooks, routeEvent: (id, name, payload) => foremanWss.routeEvent(id, name, payload) });

  // Admin WebSocket broadcaster — aggregates tasks from all per-repo TaskManagers
  const adminWss = createAdminWss(server, async () => ({
    tasks: await TaskManager.getAllTasksForBroadcast(),
    workers: Worker.all().map((w) => w.toWire()),
    repos: (await Repo.list()).map((r) => r.toWire()),
  }));

  foremanWss = new ForemanWss({ config, server, adminWss });

  if (webhooks) {
    webhooks.onAny(async ({ id, name, payload }) => {
      await foremanWss.routeEvent(id, name as string, payload);
    });
  }

  // Load all state before accepting WebSocket connections.

  // Step 1: Bootstrap per-repo TaskManagers from known repos, then load active tasks.
  log("[startup] step 1: loading active tasks from DB...");
  try {
    const repos = await Repo.listActive();
    for (const repo of repos) {
      await repo.taskManager.loadActiveTasksFromDb();
    }
  } catch (err) {
    log(`ERROR Failed to load tasks from DB: ${fmtError(err)}`);
    process.exit(1);
  }

  // Step 2: Fetch brunel:ready issues from GitHub for reconciliation.
  log("[startup] step 2: fetching brunel:ready issues from GitHub for reconciliation...");
  try {
    for (const tm of TaskManager.all()) {
      await tm.loadIssuesFromGithub();
    }
    await foremanWss.reconcile();
  } catch (err) {
    log(`ERROR Failed to load issues from GitHub: ${fmtError(err)}`);
    process.exit(1);
  }

  // Step 3: start listening — state is fully loaded
  const httpBase = config.foremanUrl.replace(/^ws:\/\//, "http://").replace(/^wss:\/\//, "https://").replace(/\/$/, "");
  const wsBase = config.foremanUrl.replace(/\/$/, "");
  server.listen(config.port, () => {
    log(`Listening on ${httpBase}/webhook`);
    log(`WebSocket workers: ${wsBase}/worker`);
    log(`Admin WebSocket: ${wsBase}/admin/ws`);
    log("Waiting for events...");
  });

  process.on("SIGTERM", () => {
    log("SIGTERM received, shutting down gracefully...");
    void foremanWss.shutdown().then(() => {
      setTimeout(() => {
        log("Shutdown complete.");
        process.exit(0);
      }, 2000);
    });
  });
}
