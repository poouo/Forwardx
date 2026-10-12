import { executeRaw, queryRaw, insertAndGetId } from "../dbRuntime";
import { quoteIdentifier as q } from "../dbCompat";
import { deleteExpiredHistoryRows } from "./historyRetention";
import { seamlessBackgroundPaused } from "../seamlessMigrationState";
import { LATENCY_HISTORY_HOURS } from "../../shared/latencyHistory";
import {
  HostAvailabilityRecorder, AVAILABILITY_OBSERVATION_GAP_SECONDS,
  availabilityDays, addAvailabilityInterval, finishAvailabilityDays, type AvailabilityInterval,
} from "../hostAvailability";

export const hostAvailabilityRecorder = new HostAvailabilityRecorder({
  async insert(row) {
    await insertAndGetId("host_availability_intervals", { ...row, online: row.online ? 1 : 0, offlineIncident: row.offlineIncident ? 1 : 0 });
  },
  async extend(key, endAt) {
    await executeRaw(`UPDATE ${q("host_availability_intervals")} SET ${q("endAt")} = ? WHERE ${q("observationKey")} = ?`, [endAt, key]);
  },
});

// Diagnostics must not change heartbeat, notifications, or forwarding success.
let lastErrorAt = 0;
export async function recordHostAvailability(hostId: number, online: boolean, at = Date.now()) {
  if (seamlessBackgroundPaused()) return;
  try { await hostAvailabilityRecorder.observe(hostId, online, at); }
  catch (error) {
    if (Date.now() - lastErrorAt > 60_000) {
      lastErrorAt = Date.now();
      console.warn(`[HostAvailability] Recording failed host=${hostId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export async function checkpointHostAvailability() {
  const at = Date.now();
  // Minimal status columns, not complete host configuration or metric history.
  const rows = await queryRaw<any>(`SELECT ${q("id")}, ${q("isOnline")}, ${q("lastHeartbeat")} FROM ${q("hosts")}`);
  const { HOST_ONLINE_TTL_MS } = await import("../hostHeartbeatPolicy");
  const { isPresenceCapableHostConfirmedOffline } = await import("../agentFastLiveness");
  hostAvailabilityRecorder.retain(new Set(rows.map((row) => Number(row.id))));
  for (const row of rows) {
    const online = !!Number(row.isOnline) && Number(row.lastHeartbeat) * 1000 >= at - HOST_ONLINE_TTL_MS
      && !isPresenceCapableHostConfirmedOffline(row.id);
    await recordHostAvailability(Number(row.id), online, at);
  }
}

export async function getHostAvailability(hostId: number, input: { since: Date; until: Date; dayBoundaries?: Date[] }, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const since = Math.max(Math.floor(input.since.getTime() / 1000), now - LATENCY_HISTORY_HOURS * 3600);
  const until = Math.min(Math.floor(input.until.getTime() / 1000), now);
  const boundaries = input.dayBoundaries?.map((day) => Math.floor(day.getTime() / 1000)) || [since, Math.max(since, until)];
  const days = availabilityDays(boundaries, now);
  const intervals: AvailabilityInterval[] = [];
  const includeDetails = !input.dayBoundaries && until - since <= 26 * 3600;
  let cursorStart = 0, cursorId = 0;
  // Bounded indexed pages: even pathological flapping does not create an
  // unbounded raw result or one large synchronous SQLite read.
  while (until >= since) {
    const rows = await queryRaw<any>(`SELECT * FROM ${q("host_availability_intervals")}
      WHERE ${q("hostId")} = ? AND ${q("endAt")} >= ? AND ${q("startAt")} <= ?
        AND (${q("startAt")} > ? OR (${q("startAt")} = ? AND ${q("id")} > ?))
      ORDER BY ${q("startAt")}, ${q("id")} LIMIT 2000`, [hostId, since, until, cursorStart, cursorStart, cursorId]);
    const current = hostAvailabilityRecorder.snapshot(hostId);
    for (const raw of rows) {
      const row: AvailabilityInterval = { observationKey: String(raw.observationKey), hostId,
        online: !!Number(raw.online), offlineIncident: !!Number(raw.offlineIncident), startAt: Number(raw.startAt), endAt: Number(raw.endAt) };
      // Show the live tail, but never project across a stalled monitor/migration.
      if (!seamlessBackgroundPaused() && current?.observationKey === row.observationKey
        && now >= current.endAt && now - current.endAt <= AVAILABILITY_OBSERVATION_GAP_SECONDS) row.endAt = now;
      addAvailabilityInterval(days, row);
      if (includeDetails && row.endAt > since && row.startAt < until) intervals.push(row);
    }
    if (rows.length < 2000) break;
    const last = rows[rows.length - 1];
    cursorStart = Number(last.startAt); cursorId = Number(last.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { days: finishAvailabilityDays(days), intervals: intervals.sort((a, b) => a.startAt - b.startAt), monitoredAt: now };
}

export async function cleanOldHostAvailability() {
  return deleteExpiredHistoryRows("host_availability_intervals", "endAt", Math.floor(Date.now() / 1000) - LATENCY_HISTORY_HOURS * 3600);
}
