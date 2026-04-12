/**
 * Vitest per-worker setup file. Runs in each test worker before any tests.
 *
 * When Supabase is not running (SUPABASE_UNAVAILABLE=true), initialise the DB
 * with the in-memory shim so that unit tests that call model methods as side
 * effects (e.g. ForemanMessage.log / WebhookEvent.log) don't crash on a null
 * db reference. DB tests (db.*.test.ts, pipeline.test.ts) override this at
 * module level with initDb(createTestSupabase()).
 */

import { initDb } from "../src/foreman/db-client.js";
import { createMemoryTaskDb } from "./helpers/memory-db.js";

if (process.env.SUPABASE_UNAVAILABLE === "true") {
  initDb(createMemoryTaskDb());
}
