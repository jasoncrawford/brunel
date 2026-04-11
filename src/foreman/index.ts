// ── Foreman entry point — wires components and starts server ─────────────────

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../database.types.js";
import { Webhooks } from "@octokit/webhooks";
import { loadConfig } from "../config.js";
import { createDbLogger } from "./db.js";
import type { DbLogger } from "./db.js";
import { TaskManager } from "./models/task-manager.js";
import { initDb } from "./db-client.js";
import { Worker } from "./models/worker-registry.js";
import { createHttpServer } from "./controllers/http-server.js";
import { createForemanWss } from "./controllers/wss.js";
import type { ForemanWss } from "./controllers/wss.js";
import { createAdminWss } from "./admin-ws.js";
import { isMutedEvent, summaryEvent } from "./controllers/event-router.js";
import { fmtError } from "../utils.js";

function flog(msg: string) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

function printEvent(id: string, name: string, payload: unknown) {
  if (isMutedEvent(name)) return;
  flog(summaryEvent(id, name, payload));
}

// Only start listening when run directly (not when imported by tests)
import { fileURLToPath } from "url";
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const config = await loadConfig(process.argv);

  const webhooks = config.webhookSecret
    ? new Webhooks({ secret: config.webhookSecret })
    : null;

  // Setup DB logger, task module and task manager (share the same Supabase client)
  if (!config.supabaseUrl || !config.supabaseSecretKey) {
    flog("ERROR Supabase is required. Set BRUNEL_SUPABASE_URL and BRUNEL_SUPABASE_SECRET_KEY.");
    process.exit(1);
  }
  const supabase = createClient<Database>(config.supabaseUrl, config.supabaseSecretKey);
  const dbLogger: DbLogger = createDbLogger(supabase);
  const taskManager = new TaskManager();
  initDb(supabase);

  let foremanWss: ForemanWss;
  const server = createHttpServer(webhooks, (id, name, payload) => foremanWss.routeEvent(id, name, payload), dbLogger, taskManager);

  // Admin WebSocket broadcaster
  const adminWss = createAdminWss(server, async () => ({
    tasks: await taskManager.getTaskSnapshots(),
    workers: Worker.all().map((w) => w.toSnapshot()),
  }));

  foremanWss = createForemanWss(taskManager, server, config, {
    dbLogger,
    adminWss,
  });

  if (webhooks) {
    webhooks.onAny(async ({ id, name, payload }) => {
      printEvent(id, name as string, payload);
      await foremanWss.routeEvent(id, name as string, payload);
    });
  }

  // Load all state before accepting WebSocket connections.

  // Step 1: Load active tasks from DB (primary source of truth).
  flog("[startup] step 1: loading active tasks from DB...");
  try {
    await taskManager.loadActiveTasksFromDb(flog);
  } catch (err) {
    flog(`ERROR Failed to load tasks from DB: ${fmtError(err)}`);
    process.exit(1);
  }

  // Step 2: Fetch brunel:ready issues from GitHub for reconciliation.
  flog("[startup] step 2: fetching brunel:ready issues from GitHub for reconciliation...");
  try {
    await taskManager.loadIssuesFromGithub(config, flog);
    await foremanWss.reconcile();
  } catch (err) {
    flog(`ERROR Failed to load issues from GitHub: ${fmtError(err)}`);
    process.exit(1);
  }

  // Step 3: start listening — state is fully loaded
  const httpBase = config.foremanUrl.replace(/^ws:\/\//, "http://").replace(/^wss:\/\//, "https://").replace(/\/$/, "");
  const wsBase = config.foremanUrl.replace(/\/$/, "");
  server.listen(config.port, () => {
    flog(`Listening on ${httpBase}/webhook`);
    flog(`WebSocket workers: ${wsBase}/worker`);
    flog(`Admin WebSocket: ${wsBase}/admin/ws`);
    flog("Waiting for events...");
  });

  process.on("SIGTERM", () => {
    flog("SIGTERM received, shutting down gracefully...");
    void foremanWss.shutdown().then(() => {
      setTimeout(() => {
        flog("Shutdown complete.");
        process.exit(0);
      }, 2000);
    });
  });
}
