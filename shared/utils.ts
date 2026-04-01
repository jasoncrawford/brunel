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
