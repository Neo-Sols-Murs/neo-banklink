/**
 * Add `days` to an ISO date string (YYYY-MM-DD) and return a new ISO date string.
 */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
