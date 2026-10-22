/** Synthetic local fixtures; seconds are local calendar boundaries supplied by caller. */
export function devAvailabilityPeriods(start: number, end: number, variant: number) {
  const span = end - start;
  if (span <= 0) return [];
  const noon = span < 18 * 3600 ? start + Math.floor(span / 2) : start + 12 * 3600;
  const duration = [120, 900, 3600, 2400, 300, 7200][variant % 6];
  const outageEnd = Math.min(end, noon + duration);
  // Some days have a deliberate coverage gap as well as an outage.
  const gapStart = variant % 6 === 3 ? start + Math.floor(span / 5) : start;
  const gapEnd = variant % 6 === 3 ? Math.min(noon, gapStart + 1800) : start;
  return [
    { startAt: start, endAt: gapStart, online: 1, offlineIncident: 0 },
    { startAt: gapEnd, endAt: noon, online: 1, offlineIncident: 0 },
    { startAt: noon, endAt: outageEnd, online: 0, offlineIncident: 1 },
    { startAt: outageEnd, endAt: end, online: 1, offlineIncident: 0 },
  ].filter(row => row.endAt > row.startAt);
}

export function devProbeTrendSample(slot: number, variant: number) {
  const phase = slot % 96;
  const offline = phase >= 48 && phase < 50 + variant % 4;
  const partial = phase >= 32 && phase < 36 || phase >= 70 && phase < 74;
  return { latencyMs: offline ? null : Math.round(18 + variant * 7 + Math.sin(slot / 3) * 5 + (partial ? 65 : 0)),
    isTimeout: offline, probeCount: 100, probeSuccesses: offline ? 0 : partial ? 97 : 100 };
}

export function uncoveredPeriods(start: number, end: number, occupied: { startAt: number; endAt: number }[]) {
  const result: { startAt: number; endAt: number }[] = [];
  let cursor = start;
  for (const row of occupied) {
    if (row.endAt <= cursor) continue;
    if (row.startAt >= end) break;
    if (row.startAt > cursor) result.push({ startAt: cursor, endAt: Math.min(end, row.startAt) });
    cursor = Math.max(cursor, row.endAt);
    if (cursor >= end) break;
  }
  if (cursor < end) result.push({ startAt: cursor, endAt: end });
  return result;
}
