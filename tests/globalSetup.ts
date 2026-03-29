import { execSync } from "child_process";
import { createClient } from "@supabase/supabase-js";

/**
 * Vitest global setup: runs once before the entire test suite.
 *
 * Resolves the Supabase service-role key (in order of preference):
 *   1. SUPABASE_SERVICE_ROLE_KEY env var (set externally or by CI)
 *   2. Extracted from `supabase status` — works for both Supabase CLI v2
 *      (sb_secret_* keys) and older versions (JWT service_role keys)
 *
 * After resolving the key, sets process.env.SUPABASE_SERVICE_ROLE_KEY so
 * that it is inherited by Vitest worker threads before they start.
 *
 * Prerequisites: `supabase start` must be running before the suite starts.
 * In CI this is done by the workflow; locally, run `supabase start` first.
 */
export async function setup(): Promise<void> {
  const url = process.env.SUPABASE_URL || "http://127.0.0.1:54321";

  // Resolve the service-role key if not already in the environment.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const status = execSync("supabase status 2>&1", { encoding: "utf8" });

      // Supabase CLI v2+: sb_secret_* key format
      const newKey = status.match(/sb_secret_[A-Za-z0-9_-]+/)?.[0];
      if (newKey) {
        process.env.SUPABASE_SERVICE_ROLE_KEY = newKey;
      } else {
        // Older CLI: JWT service_role key on a line like "service_role key: eyJ..."
        const line = status.split("\n").find((l) => l.includes("service_role key"));
        const oldKey = line?.trim().split(/\s+/).pop();
        if (oldKey) process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
      }
    } catch {
      // supabase CLI not installed or not in PATH — rely on the env var check below.
    }
  }

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set and could not be read from `supabase status`.\n" +
        "Make sure `supabase start` is running and the supabase CLI is installed.\n" +
        "Alternatively, set SUPABASE_SERVICE_ROLE_KEY manually before running npm test.",
    );
  }

  // Verify the local Supabase instance is reachable and the schema is intact.
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const { error } = await supabase.from("tasks").select("task_id").limit(1);
  if (error) {
    throw new Error(
      `Cannot connect to local Supabase at ${url}.\n` +
        `Start it with: supabase start\n` +
        `Then re-run: npm test\n` +
        `Error: ${error.message}`,
    );
  }
}
