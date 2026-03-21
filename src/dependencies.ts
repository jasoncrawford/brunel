import { fetchNativeBlockers } from "./github.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Maps an issue number to the set of issue numbers that block it. */
export type DependencyGraph = Map<number, Set<number>>;

// ── Pure graph utilities ──────────────────────────────────────────────────────

/**
 * Parse "Depends on #N" / "Blocked by #N" lines from an issue body.
 * Returns a deduplicated list of blocker issue numbers.
 */
export function parseBodyBlockers(body: string): number[] {
  // Match a keyword clause followed by one or more comma-separated #N references.
  const clausePattern = /(?:^|\s)(?:depends\s+on|blocked\s+by)\s+(#\d+(?:\s*,\s*#\d+)*)/gi;
  const numbers = new Set<number>();
  let m: RegExpExecArray | null;
  while ((m = clausePattern.exec(body)) !== null) {
    const refPattern = /#(\d+)/g;
    let r: RegExpExecArray | null;
    while ((r = refPattern.exec(m[1])) !== null) {
      numbers.add(parseInt(r[1], 10));
    }
  }
  return Array.from(numbers);
}

/**
 * Overwrite the blocker set for `issueNumber` in `graph`.
 * Passing an empty array clears the entry.
 */
export function setBlockers(issueNumber: number, blockers: number[], graph: DependencyGraph): void {
  graph.set(issueNumber, new Set(blockers));
}

/**
 * Returns true if any blocker for `issueNumber` is present in `openIssues`.
 */
export function isBlocked(
  issueNumber: number,
  graph: DependencyGraph,
  openIssues: Set<number>,
): boolean {
  const blockers = graph.get(issueNumber);
  if (!blockers || blockers.size === 0) return false;
  for (const b of blockers) {
    if (openIssues.has(b)) return true;
  }
  return false;
}

/**
 * Fetch all blockers for an issue from both body text and GitHub native relationships.
 * Results are merged and deduplicated.
 */
export async function fetchBlockers(
  issueNumber: number,
  body: string,
  opts: { repo: string; token: string },
): Promise<number[]> {
  const [bodyBlockers, nativeBlockers] = await Promise.all([
    Promise.resolve(parseBodyBlockers(body)),
    fetchNativeBlockers(issueNumber, opts),
  ]);
  return Array.from(new Set([...bodyBlockers, ...nativeBlockers]));
}
