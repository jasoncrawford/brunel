/** Serialize an unknown thrown value to a human-readable string.
 * Handles native Error, Supabase PostgrestError (plain object with `message`), strings, and fallback JSON. */
export function fmtError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err === null) return "null";
  if (err === undefined) return "undefined";
  if (typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return JSON.stringify(err);
}
