export class AgentHeartbeatGate {
  private readonly active = new Set<number>();
  private readonly completedAt = new Map<number, number>();

  constructor(
    private readonly coalesceMs = 5000,
    private readonly now: () => number = Date.now,
    private readonly maxConcurrent = 8,
  ) {}

  tryAcquire(hostIdValue: unknown, options: { force?: boolean } = {}) {
    const hostId = Number(hostIdValue);
    if (!Number.isInteger(hostId) || hostId <= 0) return null;
    const currentTime = this.now();
    const recentlyCompleted = currentTime - (this.completedAt.get(hostId) || 0) < this.coalesceMs;
    if (
      this.active.has(hostId)
      || (!options.force && recentlyCompleted)
      || this.active.size >= Math.max(1, this.maxConcurrent)
    ) return null;

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

export function buildBusyAgentHeartbeatResponse(input: {
  panelUrl: string;
  requestLocalState: boolean;
}) {
  return {
    success: true,
    actions: [],
    selfTests: [],
    lookingGlassTests: [],
    iperf3Tasks: [],
    pluginTasks: [],
    agentUpgrade: null,
    panelUrl: input.panelUrl,
    forceTcping: false,
    nextInterval: 5,
    requestLocalState: input.requestLocalState,
    compactReports: true,
  };
}

export const agentHeartbeatGate = new AgentHeartbeatGate();
