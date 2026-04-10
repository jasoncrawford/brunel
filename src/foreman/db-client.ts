import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../database.types.js";

export let db: SupabaseClient<Database>;

export function initDb(supabase: SupabaseClient<Database>): void {
  db = supabase;
}
