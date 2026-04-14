import { randomInt } from "node:crypto";

/** Write a timestamped log line to stdout. */
export function log(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
}

export const WORKER_NAMES = [
  "abner",
  "adelaide",
  "albert",
  "alden",
  "alfred",
  "amelia",
  "amity",
  "amos",
  "andrew",
  "arthur",
  "asa",
  "augustus",
  "aurelia",
  "beatrice",
  "benjamin",
  "boaz",
  "caleb",
  "calvin",
  "cassandra",
  "cassius",
  "cecilia",
  "charity",
  "charlotte",
  "chauncey",
  "clara",
  "clarence",
  "clement",
  "constance",
  "cornelius",
  "cressida",
  "daniel",
  "deliverance",
  "dinah",
  "ebenezer",
  "edmund",
  "edwin",
  "eleanor",
  "elihu",
  "endeavour",
  "ephraim",
  "ernest",
  "esther",
  "experience",
  "ezekiel",
  "faith",
  "felicity",
  "frances",
  "franklin",
  "frederick",
  "gideon",
  "grace",
  "harold",
  "harriet",
  "henry",
  "herbert",
  "hezekiah",
  "hiram",
  "honour",
  "hope",
  "horatio",
  "humility",
  "ichabod",
  "increase",
  "jedediah",
  "jeremiah",
  "jethro",
  "josephine",
  "justice",
  "lavinia",
  "lawrence",
  "lemuel",
  "levi",
  "lucius",
  "lydia",
  "mabel",
  "martha",
  "matilda",
  "mercy",
  "micah",
  "miles",
  "naomi",
  "obadiah",
  "oliver",
  "parthenia",
  "patience",
  "peregrine",
  "perseverance",
  "philip",
  "phineas",
  "priscilla",
  "prosper",
  "prudence",
  "resolve",
  "rosalind",
  "roscoe",
  "rufus",
  "rupert",
  "ruth",
  "silas",
  "simon",
  "susannah",
  "tabitha",
  "temperance",
  "thaddeus",
  "thankful",
  "theodore",
  "theophilus",
  "titus",
  "tobias",
  "verity",
  "victor",
  "violet",
  "warren",
  "zephaniah",
];

/** Generate a human-readable agent ID by prepending a random human name to a UUID.
 * E.g. "patience-a9bdda00-1234-5678-abcd-ef0123456789" */
export function generateAgentId(): string {
  const idx = randomInt(WORKER_NAMES.length);
  return `${WORKER_NAMES[idx]}-${crypto.randomUUID()}`;
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
