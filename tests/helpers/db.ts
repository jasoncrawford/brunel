import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

// Default credentials for `supabase start` — these are the same across all
// default Supabase local-dev installations and are safe to commit.
// See: https://supabase.com/docs/guides/getting-started/local-development#api-keys
const LOCAL_URL = "http://127.0.0.1:54321";
const LOCAL_SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0." +
  "EGIM96RAZx35lJzdJsyH-qQwv8Hj04zWl196z2-SBc0";

export const TEST_SUPABASE_URL =
  process.env.SUPABASE_URL || LOCAL_URL;
export const TEST_SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || LOCAL_SERVICE_ROLE_KEY;

/**
 * Creates a Supabase client pointed at the local test instance.
 * Uses service_role key so RLS is bypassed and all operations succeed.
 */
export function createTestSupabase(): SupabaseClient {
  return createClient(TEST_SUPABASE_URL, TEST_SUPABASE_KEY, {
    auth: { persistSession: false },
  });
}

/**
 * Deletes all rows from the four DB tables used by tests.
 * Call this in `beforeEach` to give each test a clean slate.
 */
export async function truncateTables(supabase: SupabaseClient): Promise<void> {
  await Promise.all([
    supabase.from("webhook_events").delete().gt("id", 0),
    supabase.from("foreman_messages").delete().gt("id", 0),
    supabase.from("tasks").delete().neq("task_id", ""),
    supabase.from("task_assignments").delete().neq("task_id", ""),
  ]);
}
