export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Polls until predicate returns true, yielding to the event loop between checks. */
export async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) {
    await new Promise(r => setImmediate(r));
  }
}
