import { randomUUID } from "node:crypto";
import { withKeyedTaskLock } from "./keyedTaskLock";
import type { AvailabilityDay, AvailabilityInterval } from "../shared/hostAvailability";
export type { AvailabilityDay, AvailabilityInterval } from "../shared/hostAvailability";

// A stalled/restarted panel cannot establish host availability during the gap.
export const AVAILABILITY_OBSERVATION_GAP_SECONDS = 90;
export type AvailabilityStore = {
  insert: (row: AvailabilityInterval) => Promise<void>;
  extend: (key: string, endAt: number) => Promise<void>;
};

/** Only transitions create rows; the 30-second sweep extends the current row. */
export class HostAvailabilityRecorder {
  private current = new Map<number, AvailabilityInterval>();
  private prefix = randomUUID();
  constructor(private store: AvailabilityStore) {}

  async observe(hostId: number, online: boolean, at = Date.now()) {
    if (!Number.isInteger(hostId) || hostId <= 0 || !Number.isFinite(at)) return;
    const seconds = Math.floor(at / 1000);
    return withKeyedTaskLock(`host-availability:${this.prefix}:${hostId}`, async () => {
      const previous = this.current.get(hostId);
      if (previous && seconds < previous.endAt) return; // stale sweep/event
      const continuous = previous && seconds - previous.endAt <= AVAILABILITY_OBSERVATION_GAP_SECONDS;
      if (continuous && previous.online === online) {
        if (seconds === previous.endAt) return;
        await this.store.extend(previous.observationKey, seconds);
        this.current.set(hostId, { ...previous, endAt: seconds });
        return;
      }
      // Complete the previous interval at the actual transition, not at its
      // last checkpoint. Never bridge an unobserved panel outage.
      if (continuous && seconds > previous.endAt) {
        await this.store.extend(previous.observationKey, seconds);
        this.current.set(hostId, { ...previous, endAt: seconds });
      }
      const next = {
        observationKey: randomUUID(), hostId, online, startAt: seconds, endAt: seconds,
        offlineIncident: !!continuous && previous.online && !online,
      };
      await this.store.insert(next);
      this.current.set(hostId, next);
    });
  }

  snapshot(hostId: number) { return this.current.get(hostId); }
  retain(hostIds: Set<number>) {
    for (const id of this.current.keys()) if (!hostIds.has(id)) this.current.delete(id);
  }
  forget(hostId: number) { this.current.delete(hostId); }
}

export function availabilityDays(boundaries: number[], now: number) {
  return boundaries.slice(0, -1).map((startAt, index): AvailabilityDay => ({
    startAt, endAt: Math.max(startAt, Math.min(boundaries[index + 1], now)),
    onlineSeconds: 0, offlineSeconds: 0, unknownSeconds: 0, observedSeconds: 0,
    offlineCount: 0, uptimePercent: null, coveragePercent: null,
  }));
}

export function addAvailabilityInterval(days: AvailabilityDay[], row: AvailabilityInterval) {
  for (const day of days) {
    const seconds = Math.max(0, Math.min(day.endAt, row.endAt) - Math.max(day.startAt, row.startAt));
    if (row.online) day.onlineSeconds += seconds;
    else day.offlineSeconds += seconds;
    if (row.offlineIncident && row.startAt >= day.startAt && row.startAt < day.endAt) day.offlineCount++;
  }
}

export function finishAvailabilityDays(days: AvailabilityDay[]) {
  return days.map((day) => {
    const elapsed = day.endAt - day.startAt;
    const observedSeconds = day.onlineSeconds + day.offlineSeconds;
    return { ...day, observedSeconds, unknownSeconds: Math.max(0, elapsed - observedSeconds),
      uptimePercent: observedSeconds > 0 ? day.onlineSeconds / observedSeconds * 100 : null,
      coveragePercent: elapsed > 0 ? Math.min(100, observedSeconds / elapsed * 100) : null };
  });
}
