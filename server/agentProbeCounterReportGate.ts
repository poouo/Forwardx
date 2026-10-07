import type { ProbeCounterSnapshot } from "./repositories/probeCounterRepository";
import { pruneMapEntries, setBoundedMapValue } from "./boundedCache";

type State = { count: number; signature: string; savedAt: number; seenAt: number };

/** Independent from the health gate: a new epoch must get a baseline even
 * when health is unchanged. Tunnel-rule target probes arrive every cycle,
 * but stable cumulative snapshots need only one database write per five
 * minutes. Cumulative totals preserve the suppressed attempts. */
export class AgentProbeCounterReportGate {
  private readonly states = new Map<string, State>();
  private lastPruneAt = 0;
  constructor(private readonly capacity = 32768, private readonly ttlMs = 30 * 60_000) {}

  plan(rows: ProbeCounterSnapshot[], force = false, now = Date.now()) {
    if (now - this.lastPruneAt >= 60_000) {
      pruneMapEntries(this.states, (state) => now - state.seenAt > this.ttlMs);
      this.lastPruneAt = now;
    }
    const updates = new Map<string, State>();
    const selected = rows.filter((row) => {
      const key = `${row.hostId}:${row.kind}:${row.refId}:${row.probeKey}:${row.epoch}`;
      const previous = this.states.get(key);
      if (previous) previous.seenAt = now;
      const signature = `${row.batchCount}/${row.batchSuccesses}`;
      if (previous && (row.totalCount <= previous.count
        || (!force && signature === previous.signature && now - previous.savedAt < 5 * 60_000))) return false;
      updates.set(key, { count: row.totalCount, signature, savedAt: now, seenAt: now });
      return true;
    });
    return { rows: selected, commit: () => {
      for (const [key, state] of updates) {
        const previous = this.states.get(key);
        if (!previous || state.count > previous.count) setBoundedMapValue(this.states, key, state, this.capacity);
      }
    } };
  }
}

export const agentProbeCounterReportGate = new AgentProbeCounterReportGate();
