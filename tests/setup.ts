/**
 * Vitest per-worker setup file. Runs in each test worker before any tests.
 *
 * Always initialises the DB with the in-memory shim so that unit tests that
 * trigger model side effects (e.g. ForemanMessage.log / WebhookEvent.log)
 * have a real db reference rather than undefined. DB tests (db.*.test.ts,
 * pipeline.test.ts) override this at module level with initDb(createTestSupabase()).
 */

import { initDb } from "../src/foreman/clients/db-client.js";
import { createMemoryTaskDb } from "./helpers/memory-db.js";
import { StatusBar, initStatusBar } from "../src/agent/status-bar.js";

initDb(createMemoryTaskDb());
initStatusBar(new StatusBar({ agentId: "test-agent" }));
