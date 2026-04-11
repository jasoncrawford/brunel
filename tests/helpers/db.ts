import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../shared/database.types.js";

/**
 * Creates a Supabase client pointed at the local test instance.
 * Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment.
 * Both are set by tests/globalSetup.ts before any test worker starts.
 *
 * Throws immediately with a helpful message if Supabase is not available
 * (globalSetup sets SUPABASE_UNAVAILABLE when the key cannot be resolved).
 */
export function createTestSupabase(): SupabaseClient<Database> {
  if (process.env.SUPABASE_UNAVAILABLE === "true") {
    throw new Error(
      "DB tests require a running Supabase instance.\n" +
        "Run `supabase start` (or set SUPABASE_SERVICE_ROLE_KEY) then re-run the tests.",
    );
  }
  const url = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createClient<Database>(url, key, {
    auth: { persistSession: false },
  });
}

/**
 * Deletes all rows from the DB tables used by tests.
 * Call this in `beforeEach` to give each test a clean slate.
 */
export async function truncateTables(supabase: SupabaseClient<Database>): Promise<void> {
  await Promise.all([
    supabase.from("webhook_events").delete().gt("id", 0),
    supabase.from("foreman_messages").delete().gt("id", 0),
    supabase.from("tasks").delete().neq("task_id", ""),
  ]);
}
