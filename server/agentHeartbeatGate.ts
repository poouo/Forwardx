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
  metricsWatching?: boolean;
  trafficReportInterval?: number;
}) {
  const metricsOnly = input.metricsWatching === true && !input.requestLocalState;
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
    nextInterval: metricsOnly ? 3 : 5,
    requestLocalState: input.requestLocalState,
    compactReports: true,
    presenceSupported: true,
    metricsOnly,
    trafficReportInterval: input.trafficReportInterval,
  };
}

export const AGENT_PRESENCE_INTERVAL_SECONDS = 5;

export function buildPresenceAgentHeartbeatResponse(input: {
  panelMigration?: unknown;
}) {
  return {
    success: true,
    presence: true,
    presenceSupported: true,
    actions: [],
    selfTests: [],
    lookingGlassTests: [],
    iperf3Tasks: [],
    pluginTasks: [],
    agentUpgrade: null,
    panelMigration: input.panelMigration || null,
    requestLocalState: false,
    compactReports: true,
    nextPresenceInterval: AGENT_PRESENCE_INTERVAL_SECONDS,
  };
}

export function shouldDeferAgentWorkForLocalState(input: {
  supportsDesiredState: boolean;
  requestLocalState: boolean;
}) {
  return input.supportsDesiredState && input.requestLocalState;
}

export const AGENT_IDLE_HEARTBEAT_INTERVAL_SECONDS = 60;
export const AGENT_PRESENCE_PERSIST_INTERVAL_MS = 90 * 1000;
export const AGENT_TRAFFIC_REPORT_INTERACTIVE_SECONDS = 10;
export const AGENT_TRAFFIC_REPORT_STEADY_SECONDS = 30;
export const AGENT_STABLE_PLAN_AUDIT_INTERVAL_MS = 5 * 60 * 1000;

export function selectAgentTrafficReportInterval(input: {
  metricsWatching: boolean;
  strictAccounting: boolean;
}) {
  return input.metricsWatching || input.strictAccounting
    ? AGENT_TRAFFIC_REPORT_INTERACTIVE_SECONDS
    : AGENT_TRAFFIC_REPORT_STEADY_SECONDS;
}

export type AgentStableHeartbeatPlan = {
  plannedAt: number;
  configRevision: number;
  desiredStateHash: string;
  localStateSignature: string;
  stateSignatures: Record<string, string>;
  agentVersion: string;
  agentBootId: string;
  agentProcessStartedAt: number;
  defaultNetworkInterface: string;
  pluginInventorySignature: string;
  mimicEnvironmentSignature: string;
  idleNextInterval: number;
  panelUrl: string;
};

export type AgentStableHeartbeatMatch = {
  now?: number;
  forceReconcile?: boolean;
  hasBlockingWork?: boolean;
  recoveryTriggered?: boolean;
  addressChanged?: boolean;
  hasDnsChanges?: boolean;
  hasLocalStateUpload?: boolean;
  hasEndpointEvents?: boolean;
  localStateSignature: string;
  stateSignatures: Record<string, string>;
  agentVersion: string;
  agentBootId: string;
  agentProcessStartedAt: number;
  defaultNetworkInterface: string;
  pluginInventorySignature: string;
  mimicEnvironmentSignature: string;
  agentLastReceivedRevision: number;
  agentLastAppliedRevision: number;
  agentLastReceivedHash: string;
  agentLastAppliedHash: string;
};

function normalizedHash(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function signaturesMatch(expected: Record<string, string>, actual: Record<string, string>) {
  const names = Object.keys(expected);
  return names.length > 0 && names.every((name) => (
    normalizedHash(actual[name]) === normalizedHash(expected[name])
  ));
}

export class AgentStableHeartbeatPlanCache {
  private readonly plans = new Map<number, AgentStableHeartbeatPlan>();

  constructor(
    private readonly auditIntervalMs = AGENT_STABLE_PLAN_AUDIT_INTERVAL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  remember(hostIdValue: unknown, plan: AgentStableHeartbeatPlan) {
    const hostId = Number(hostIdValue);
    if (!Number.isInteger(hostId) || hostId <= 0) return false;
    if (!plan.localStateSignature || !plan.desiredStateHash || Object.keys(plan.stateSignatures).length === 0) return false;
    this.plans.set(hostId, {
      ...plan,
      desiredStateHash: normalizedHash(plan.desiredStateHash),
      localStateSignature: normalizedHash(plan.localStateSignature),
      stateSignatures: { ...plan.stateSignatures },
    });
    return true;
  }

  match(hostIdValue: unknown, input: AgentStableHeartbeatMatch) {
    const hostId = Number(hostIdValue);
    if (!Number.isInteger(hostId) || hostId <= 0) return null;
    const plan = this.plans.get(hostId);
    if (!plan) return null;
    const currentTime = input.now ?? this.now();
    if (currentTime - plan.plannedAt >= this.auditIntervalMs) return null;
    if (
      input.forceReconcile
      || input.hasBlockingWork
      || input.recoveryTriggered
      || input.addressChanged
      || input.hasDnsChanges
      || input.hasLocalStateUpload
      || input.hasEndpointEvents
    ) return null;
    if (
      normalizedHash(input.localStateSignature) !== plan.localStateSignature
      || !signaturesMatch(plan.stateSignatures, input.stateSignatures)
      || String(input.agentVersion || "") !== plan.agentVersion
      || String(input.agentBootId || "") !== plan.agentBootId
      || Number(input.agentProcessStartedAt || 0) !== plan.agentProcessStartedAt
      || String(input.defaultNetworkInterface || "") !== plan.defaultNetworkInterface
      || input.pluginInventorySignature !== plan.pluginInventorySignature
      || input.mimicEnvironmentSignature !== plan.mimicEnvironmentSignature
    ) return null;
    if (
      Number(input.agentLastReceivedRevision || 0) !== plan.configRevision
      || Number(input.agentLastAppliedRevision || 0) !== plan.configRevision
      || normalizedHash(input.agentLastReceivedHash) !== plan.desiredStateHash
      || normalizedHash(input.agentLastAppliedHash) !== plan.desiredStateHash
    ) return null;
    return { ...plan, stateSignatures: { ...plan.stateSignatures } };
  }

  invalidate(hostIdValue?: unknown) {
    if (hostIdValue === undefined) {
      this.plans.clear();
      return;
    }
    this.plans.delete(Number(hostIdValue));
  }

  clear() {
    this.plans.clear();
  }
}

export const agentStableHeartbeatPlanCache = new AgentStableHeartbeatPlanCache();

export function invalidateAgentStableHeartbeatPlan(hostId?: unknown) {
  agentStableHeartbeatPlanCache.invalidate(hostId);
}

export function shouldPersistAgentPresence(input: {
  wasOnline: boolean;
  lastHeartbeat: unknown;
  nowMs?: number;
}) {
  if (!input.wasOnline) return true;
  const lastHeartbeatMs = new Date(input.lastHeartbeat as any).getTime();
  if (!Number.isFinite(lastHeartbeatMs)) return true;
  return (input.nowMs ?? Date.now()) - lastHeartbeatMs >= AGENT_PRESENCE_PERSIST_INTERVAL_MS;
}

export function buildReportedRuntimeHeartbeatPatch(input: {
  hasLocalRuntimeState: boolean;
  mimicRuntimeStatus: string;
  mimicRuntimeMessage: string | null;
  checkedAt?: Date;
}) {
  if (!input.hasLocalRuntimeState) return {};
  return {
    mimicRuntimeStatus: input.mimicRuntimeStatus,
    mimicRuntimeMessage: input.mimicRuntimeMessage,
    mimicRuntimeCheckedAt: input.checkedAt || new Date(),
  };
}

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
