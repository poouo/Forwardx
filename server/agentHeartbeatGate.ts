export class AgentHeartbeatGate {
  private readonly active = new Set<number>();
  private readonly completedAt = new Map<number, number>();
  private readonly waiting: number[] = [];
  private readonly waitingSince = new Map<number, number>();

  constructor(
    private readonly coalesceMs = 5000,
    private readonly now: () => number = Date.now,
    private readonly maxConcurrent = 8,
    private readonly waitingTimeoutMs = 30_000,
  ) {}

  private pruneWaiting(currentTime: number) {
    while (this.waiting.length > 0) {
      const hostId = this.waiting[0];
      const queuedAt = this.waitingSince.get(hostId);
      if (queuedAt !== undefined && currentTime - queuedAt <= this.waitingTimeoutMs) break;
      this.waiting.shift();
      this.waitingSince.delete(hostId);
    }
  }

  private enqueue(hostId: number, currentTime: number) {
    if (this.waitingSince.has(hostId)) {
      this.waitingSince.set(hostId, currentTime);
      return;
    }
    this.waiting.push(hostId);
    this.waitingSince.set(hostId, currentTime);
  }

  private removeWaiting(hostId: number) {
    if (!this.waitingSince.delete(hostId)) return;
    const index = this.waiting.indexOf(hostId);
    if (index >= 0) this.waiting.splice(index, 1);
  }

  tryAcquire(hostIdValue: unknown, options: { force?: boolean } = {}) {
    const hostId = Number(hostIdValue);
    if (!Number.isInteger(hostId) || hostId <= 0) return null;
    const currentTime = this.now();
    this.pruneWaiting(currentTime);
    const recentlyCompleted = currentTime - (this.completedAt.get(hostId) || 0) < this.coalesceMs;
    if (this.active.has(hostId) || (!options.force && recentlyCompleted)) return null;

    const atCapacity = this.active.size >= Math.max(1, this.maxConcurrent);
    if (atCapacity) {
      this.enqueue(hostId, currentTime);
      return null;
    }
    if (this.waiting.length > 0) {
      if (!this.waitingSince.has(hostId)) {
        this.enqueue(hostId, currentTime);
        return null;
      }
      if (this.waiting[0] !== hostId) {
        this.waitingSince.set(hostId, currentTime);
        return null;
      }
      this.waiting.shift();
      this.waitingSince.delete(hostId);
    }

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
      this.waiting.length = 0;
      this.waitingSince.clear();
      return;
    }
    const hostId = Number(hostIdValue);
    this.active.delete(hostId);
    this.completedAt.delete(hostId);
    this.removeWaiting(hostId);
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

export function shouldDeferAgentWorkForLocalState(input: {
  supportsDesiredState: boolean;
  requestLocalState: boolean;
}) {
  return input.supportsDesiredState && input.requestLocalState;
}

export const AGENT_IDLE_HEARTBEAT_INTERVAL_SECONDS = 60;

export function selectAgentHeartbeatInterval(input: {
  requestLocalState: boolean;
  hasInteractiveTasks: boolean;
  metricsWatching: boolean;
  serviceProbeIntervals?: unknown[];
}) {
  if (input.requestLocalState || input.hasInteractiveTasks) return 2;
  const serviceProbeInterval = (input.serviceProbeIntervals || []).reduce<number>((minimum, value) => {
    const seconds = Number(value || 30);
    const normalized = Number.isFinite(seconds) ? Math.max(5, Math.floor(seconds)) : 30;
    return Math.min(minimum, normalized);
  }, AGENT_IDLE_HEARTBEAT_INTERVAL_SECONDS);
  return Math.min(
    input.metricsWatching ? 3 : AGENT_IDLE_HEARTBEAT_INTERVAL_SECONDS,
    serviceProbeInterval,
  );
}

export const agentHeartbeatGate = new AgentHeartbeatGate();
