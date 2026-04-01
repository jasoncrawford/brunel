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

export { shortWorkerId } from "../shared/utils.js";

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
