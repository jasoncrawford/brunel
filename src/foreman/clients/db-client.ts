import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../database.types.js";

export let db: SupabaseClient<Database>;

export function initDb(supabase: SupabaseClient<Database>): void {
  db = supabase;
}

/** DB row type for a table, with `id` made optional for in-memory (unsaved) instances. */
export type DbRow<T extends keyof Database["public"]["Tables"]> =
  Omit<Database["public"]["Tables"][T]["Row"], "id"> & { id?: number };
