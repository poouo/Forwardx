export class AgentHeartbeatGate {
  private readonly active = new Set<number>();
  private readonly completedAt = new Map<number, number>();

  constructor(
    private readonly coalesceMs = 1000,
    private readonly now: () => number = Date.now,
  ) {}

  tryAcquire(hostIdValue: unknown, options: { force?: boolean } = {}) {
    const hostId = Number(hostIdValue);
    if (!Number.isInteger(hostId) || hostId <= 0) return null;
    const currentTime = this.now();
    const recentlyCompleted = currentTime - (this.completedAt.get(hostId) || 0) < this.coalesceMs;
    if (this.active.has(hostId) || (!options.force && recentlyCompleted)) return null;

    this.active.add(hostId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.delete(hostId);
      this.completedAt.set(hostId, this.now());
    };
  }

  clear(hostIdValue?: unknown) {
    if (hostIdValue === undefined) {
      this.active.clear();
      this.completedAt.clear();
      return;
    }
    const hostId = Number(hostIdValue);
    this.active.delete(hostId);
    this.completedAt.delete(hostId);
  }
}

export const agentHeartbeatGate = new AgentHeartbeatGate();
