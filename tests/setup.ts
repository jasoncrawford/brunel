/**
 * Vitest per-worker setup file. Runs in each test worker before any tests.
 *
 * Always initialises the DB with the in-memory shim so that unit tests that
 * trigger model side effects (e.g. ForemanMessage.log / WebhookEvent.log)
 * have a real db reference rather than undefined. DB tests (db.*.test.ts,
 * pipeline.test.ts) override this at module level with initDb(createTestSupabase()).
 *
 * Also initialises the config singleton (required by display.ts, status-bar.ts,
 * and other modules that call getConfig() at runtime). Tests that need to toggle
 * verbose can call setVerbose(true/false) directly — setVerbose mutates the
 * config singleton, so afterEach resets are still just setVerbose(false).
 */

import { initDb } from "../src/foreman/clients/db-client.js";
import { createMemoryTaskDb } from "./helpers/memory-db.js";
import { StatusBar, initStatusBar } from "../src/agent/status-bar.js";
import { loadDefaultConfig } from "../src/config.js";

await loadDefaultConfig();
initDb(createMemoryTaskDb());
initStatusBar(new StatusBar({ agentId: "test-agent" }));
