// ── Foreman entry point — wires components and starts server ─────────────────

import "dotenv/config";
import { Webhooks } from "@octokit/webhooks";
import type { LabeledIssueState, TaskStatus } from "../types.js";
import type { DependencyGraph } from "./dependencies.js";
import { loadConfig } from "../config.js";
import { createDbLogger, createNullDbLogger } from "./db.js";
import type { DbLogger } from "./db.js";
import { TaskModel } from "./task-model.js";
import { WorkerRegistry } from "./worker-registry.js";
import { createHttpServer } from "./http-server.js";
import { createForemanWss } from "./wss.js";
import type { ForemanWss } from "./wss.js";
import { createAdminWss } from "./admin-ws.js";
import { loadIssuesToQueue } from "./github.js";
import { isMutedEvent, summaryEvent } from "./event-router.js";
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

  const registry = new WorkerRegistry();
  const graph: DependencyGraph = new Map();
  const openIssues = new Set<number>();
  const labeledIssues = new Map<number, LabeledIssueState>();
  const webhooks = config.webhookSecret
    ? new Webhooks({ secret: config.webhookSecret })
    : null;

  // Setup DB logger and task model (share the same Supabase client if configured)
  let dbLogger: DbLogger;
  let supabase: import("@supabase/supabase-js").SupabaseClient | undefined;
  if (config.supabaseUrl && config.supabaseSecretKey) {
    const { createClient } = await import("@supabase/supabase-js");
    supabase = createClient(config.supabaseUrl, config.supabaseSecretKey);
    dbLogger = createDbLogger(supabase);
    flog("Supabase logging enabled");
  } else {
    dbLogger = createNullDbLogger();
  }

  const taskModel = TaskModel.create(supabase, labeledIssues, openIssues);

  let foremanWss: ForemanWss;
  const server = createHttpServer(webhooks, (id, name, payload) => foremanWss.routeEvent(id, name, payload), dbLogger, taskModel);

  // Admin WebSocket broadcaster
  const adminWss = createAdminWss(server, () => ({
    tasks: taskModel.getTaskSnapshots(graph),
    workers: registry.getWorkerSnapshots(),
  }));

  foremanWss = createForemanWss(
    taskModel, registry, server,
    {
      graph,
      taskLabel: config.taskLabel,
      repo: config.githubRepo,
      token: config.githubToken,
      githubApiUrl: config.githubApiUrl,
      dbLogger,
      adminWss,
      workerSecret: config.workerSecret,
      reclaimTimeoutMs: config.workerReclaimTimeoutMs,
      pingIntervalMs: config.pingIntervalMs,
    },
  );

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
    const activeTasks = await taskModel.listTasks();
    for (const row of activeTasks) {
      if (row.status === "complete") continue;
      taskModel.loadTask({
        taskId: row.taskId,
        issueNumber: row.issueNumber,
        title: row.title,
        body: row.body,
        labels: row.labels,
        repoUrl: `https://github.com/${row.repo}`,
        status: row.status as TaskStatus,
        workerId: row.workerId,
        prNumber: row.prNumber,
        branch: row.branch,
        depsLoaded: true,
      });
      flog(`[startup] restored task #${row.taskId} (${row.status})`);
    }
  } catch (err) {
    flog(`ERROR Failed to load tasks from DB: ${fmtError(err)}`);
    process.exit(1);
  }

  // Step 2: Fetch brunel:ready issues from GitHub for reconciliation.
  flog("[startup] step 2: fetching brunel:ready issues from GitHub for reconciliation...");
  try {
    await loadIssuesToQueue(labeledIssues, graph, openIssues, {
      repo: config.githubRepo,
      token: config.githubToken,
      taskLabel: config.taskLabel,
      apiUrl: config.githubApiUrl,
    });

    const startupPromises: Promise<void>[] = [];
    for (const t of taskModel.getPendingAndBlockedTasks()) {
      const shouldBeBlocked = taskModel.isBlocked(t.issueNumber, graph);
      if (t.status === "blocked" && !shouldBeBlocked) {
        startupPromises.push(
          taskModel.unblock(t.taskId).catch((err) =>
            flog(`ERROR Failed to mark task #${t.taskId} pending on startup: ${fmtError(err)}`)
          )
        );
      } else if (t.status === "pending" && shouldBeBlocked) {
        startupPromises.push(
          taskModel.block(t.taskId).catch((err) =>
            flog(`ERROR Failed to mark task #${t.taskId} blocked on startup: ${fmtError(err)}`)
          )
        );
      }
    }
    await Promise.all(startupPromises);
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

// ── Re-exports for backward compatibility ────────────────────────────────────
// These allow existing test files and consumers to import from this module.

export { WorkerRegistry } from "./worker-registry.js";
export { createForemanWss } from "./wss.js";
export type { ForemanWss } from "./wss.js";
export { createHttpServer } from "./http-server.js";
export { summaryEvent, isMutedEvent } from "./event-router.js";
export { TaskModel } from "./task-model.js";
export type { Task } from "./task-queue.js";
