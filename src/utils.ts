export const PURITAN_NAMES = [
  "caleb",
  "charity",
  "clement",
  "constance",
  "ebenezer",
  "elihu",
  "endeavour",
  "experience",
  "ezekiel",
  "faith",
  "grace",
  "hezekiah",
  "hope",
  "humility",
  "increase",
  "jedediah",
  "jeremiah",
  "justice",
  "mercy",
  "nehemiah",
  "obadiah",
  "patience",
  "preserved",
  "prudence",
  "resolved",
  "silence",
  "submit",
  "temperance",
  "thankful",
  "verity",
  "waitstill",
  "zephaniah",
];

/** Generate a human-readable worker ID by prepending a random Puritan name to a UUID.
 * E.g. "patience-a9bdda00-1234-5678-abcd-ef0123456789" */
export function generateWorkerId(): string {
  const name = PURITAN_NAMES[Math.floor(Math.random() * PURITAN_NAMES.length)];
  return `${name}-${crypto.randomUUID()}`;
}

/** Return a short display version of a worker ID.
 * - Named workers (e.g. `justice-e706451f-c3bc-...`) → `justice-e706451f`
 * - Legacy bare UUIDs (e.g. `7c254628-bc1d-...`) → `7c254628` */
export function shortWorkerId(id: string): string {
  const dashIdx = id.indexOf("-");
  if (dashIdx === -1) return id.slice(0, 8);
  const prefix = id.slice(0, dashIdx);
  // A UUID segment is exactly 8 hex chars; a Puritan name is alphabetic
  if (/^[0-9a-f]{8}$/.test(prefix)) return id.slice(0, 8);
  const rest = id.slice(dashIdx + 1);
  return `${prefix}-${rest.slice(0, 8)}`;
}

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
