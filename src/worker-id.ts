import crypto from "crypto";

export function getWorkerId(): string {
  return crypto.randomUUID();
}
