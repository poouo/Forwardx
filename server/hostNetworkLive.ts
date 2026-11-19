import { HOST_NETWORK_SAMPLE_MAX_AGE_MS, hostNetworkSpeed } from "../shared/hostNetworkSpeed";

type Sample = { recordedAt: number; uptime: number; networkIn: number; networkOut: number };
type Entry = { latest: Sample; previous?: Sample; bootId: string };

/** Network measurements must not wait for the serialized runtime reconciler.
 * Only authenticated Agent routes may write here; readers still enforce ACLs. */
export class HostNetworkLive {
  private readonly hosts = new Map<number, Entry>();
  constructor(private readonly now = Date.now, private readonly maxHosts = 4096) {}

  record(hostId: number, raw: any, bootId = "") {
    if (!Number.isSafeInteger(hostId) || hostId <= 0 || !raw) return false;
    const values = [raw.networkIn, raw.networkOut, raw.uptime];
    if (values.some(value => value == null || value === "" || !Number.isFinite(Number(value)) || Number(value) < 0)) return false;
    const sample: Sample = { networkIn: Number(values[0]), networkOut: Number(values[1]), uptime: Number(values[2]), recordedAt: this.now() };
    const entry = this.hosts.get(hostId);
    const reboot = !!entry && !!bootId && !!entry.bootId && bootId !== entry.bootId;
    // Concurrent full heartbeats can arrive after a newer presence sample.
    if (entry && !reboot && sample.uptime < entry.latest.uptime) return false;
    const previous = entry && !reboot
      ? sample.uptime === entry.latest.uptime ? entry.previous : entry.latest
      : undefined;
    this.hosts.delete(hostId);
    this.hosts.set(hostId, { latest: sample, previous, bootId: bootId || entry?.bootId || "" });
    while (this.hosts.size > this.maxHosts) this.hosts.delete(this.hosts.keys().next().value!);
    return true;
  }

  snapshots(hostId: number) {
    const entry = this.hosts.get(hostId);
    if (!entry) return null;
    if (this.now() - entry.latest.recordedAt > HOST_NETWORK_SAMPLE_MAX_AGE_MS) {
      this.hosts.delete(hostId);
      return null;
    }
    return [entry.latest, entry.previous].filter((sample): sample is Sample => !!sample)
      .map((sample, index) => ({ ...sample, hostId, id: 0, rn: index + 1, recordedAt: new Date(sample.recordedAt) }));
  }

  merge<T extends { hostId?: unknown; recordedAt?: unknown }>(row: T): T {
    const samples = this.snapshots(Number(row.hostId));
    if (!samples) return row;
    const [latest, previous] = samples;
    const storedAt = new Date(row.recordedAt as any).getTime();
    if (Number.isFinite(storedAt) && storedAt > latest.recordedAt.getTime()) return row;
    const speed = hostNetworkSpeed(latest, previous, { now: this.now() });
    return { ...row, networkIn: latest.networkIn, networkOut: latest.networkOut, uptime: latest.uptime,
      networkRecordedAt: latest.recordedAt, networkSpeedIn: speed.in, networkSpeedOut: speed.out };
  }
}

export const hostNetworkLive = new HostNetworkLive();
