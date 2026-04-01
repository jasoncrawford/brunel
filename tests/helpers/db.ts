import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Creates a Supabase client pointed at the local test instance.
 * Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment.
 * Both are set by tests/globalSetup.ts before any test worker starts.
 */
export function createTestSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

/**
 * Deletes all rows from the DB tables used by tests.
 * Call this in `beforeEach` to give each test a clean slate.
 */
export async function truncateTables(supabase: SupabaseClient): Promise<void> {
  await Promise.all([
    supabase.from("webhook_events").delete().gt("id", 0),
    supabase.from("foreman_messages").delete().gt("id", 0),
    supabase.from("tasks").delete().neq("task_id", ""),
  ]);
}
