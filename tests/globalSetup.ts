import { execSync } from "child_process";
import { TEST_SUPABASE_URL, TEST_SUPABASE_KEY } from "./helpers/db.js";
import { createClient } from "@supabase/supabase-js";

/**
 * Vitest global setup: runs once before the entire test suite.
 *
 * Applies any pending DB migrations via `supabase db push`, then verifies
 * the local Supabase instance is reachable and the schema is intact.
 *
 * Prerequisites: `supabase start` must be running before the suite starts.
 * In CI this is done by the workflow; locally, run `supabase start` first.
 */
export async function setup(): Promise<void> {
  // Apply pending migrations. `supabase start` already runs all migrations on
  // startup, but this catches any that were added after the last restart.
  try {
    execSync("supabase db push --local", { stdio: "pipe" });
  } catch {
    // Older CLI versions or unlinked projects will fail here — that's fine.
    // `supabase start` applies all migrations on startup, so the DB should
    // already be current. We verify the connection below.
  }

  // Verify the local Supabase instance is reachable and the tables exist.
  const supabase = createClient(TEST_SUPABASE_URL, TEST_SUPABASE_KEY, {
    auth: { persistSession: false },
  });
  const { error } = await supabase.from("tasks").select("task_id").limit(1);
  if (error) {
    throw new Error(
      `Cannot connect to local Supabase at ${TEST_SUPABASE_URL}.\n` +
        `Start it with: supabase start\n` +
        `Then re-run: npm test\n` +
        `Error: ${error.message}`,
    );
  }
}
