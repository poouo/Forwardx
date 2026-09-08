export type AgentTrafficStat = {
  ruleId: number;
  bytesIn?: number;
  bytesOut?: number;
  connections?: number;
};

export type AgentHostTrafficStat = {
  bytesIn?: number;
  bytesOut?: number;
};
export type AgentTcpingResult = {
  ruleId: number;
  tunnelId?: number;
  sourcePort?: number;
  targetIp?: string;
  targetPort?: number;
  method?: "tcping" | "ping" | string;
  probeKey?: string;
  topologyKey?: string;
  latencyMs?: number | null;
  isTimeout?: boolean;
  /** Number of packets/connection attempts represented by this sample. */
  probeCount?: number;
  /** Number of attempts that completed successfully. */
  probeSuccesses?: number;
  healthStatus?: "unknown" | "healthy" | "unhealthy";
  healthPending?: boolean;
};

export type AgentTunnelTcpingResult = {
  tunnelId: number;
  targetIp?: string;
  targetPort?: number;
  method?: "tcp" | "tcping" | string;
  probeKey?: string;
  topologyKey?: string;
  latencyMs?: number | null;
  isTimeout?: boolean;
  probeCount?: number;
  probeSuccesses?: number;
  hopIndex?: number;
  hopCount?: number;
  seriesKey?: string | null;
  seriesLabel?: string | null;
};

export type AgentHostProbeServiceResult = {
  serviceId: number;
  targetIp?: string;
  targetPort?: number;
  probeKey?: string;
  topologyKey?: string;
  latencyMs?: number | null;
  isTimeout?: boolean;
  probeCount?: number;
  probeSuccesses?: number;
  method?: "tcping" | "ping" | string;
};
export type AgentForwardGroupLatencyResult = {
  groupId: number;
  memberId?: number;
  probeType?: "chain" | "china" | string;
  latencyMs?: number | null;
  isTimeout?: boolean;
  probeCount?: number;
  probeSuccesses?: number;
  hopIndex?: number;
  hopCount?: number;
  method?: "tcp" | "ping" | string;
  targetIp?: string;
  targetPort?: number;
  probeKey?: string;
  topologyKey?: string;
  healthStatus?: "unknown" | "healthy" | "unhealthy";
  healthPending?: boolean;
};

export type AgentProbeCounts = {
  probeCount: number;
  probeSuccesses: number;
};

export type AgentProbeCountNormalizationOptions = {
  /**
   * Database rows created before packet counters existed contain the column
   * default (0) even for a successful sample. Keep that compatibility
   * behavior at read sites, but allow the wire ingress path to preserve an
   * explicitly reported zero-success result.
   */
  legacyZeroAsSuccess?: boolean;
};

/**
 * Normalize optional packet counters at the trust boundary.  Counters were
 * added after the original Agent protocol, therefore omitted values retain
 * the old one-sample semantics (a timeout has zero successes, otherwise one).
 */
export function normalizeAgentProbeCounts(value: {
  probeCount?: unknown;
  probeSuccesses?: unknown;
  isTimeout?: unknown;
} | null | undefined, options: AgentProbeCountNormalizationOptions = {}): AgentProbeCounts {
  const rawCount = Number(value?.probeCount);
  const probeCount = Number.isInteger(rawCount) && rawCount >= 1 && rawCount <= 1024 ? rawCount : 1;
  const rawSuccesses = Number(value?.probeSuccesses);
  const hasSuccesses = value?.probeSuccesses !== undefined && value?.probeSuccesses !== null
    && Number.isInteger(rawSuccesses);
  let probeSuccesses = hasSuccesses ? rawSuccesses : (value?.isTimeout === true ? 0 : probeCount);
  if (probeSuccesses < 0) probeSuccesses = 0;
  if (probeSuccesses > probeCount) probeSuccesses = probeCount;
  // A legacy successful row may have acquired the new DB default (0).
  // Treat it as one successful sample at database/read boundaries. The wire
  // ingress passes legacyZeroAsSuccess=false so an explicit 0 is retained.
  const legacyZeroAsSuccess = options.legacyZeroAsSuccess !== false;
  if (probeSuccesses === 0 && value?.isTimeout !== true && (!hasSuccesses || legacyZeroAsSuccess)) {
    probeSuccesses = probeCount;
  }
  return { probeCount, probeSuccesses };
}

export type SelfTestMeta =
  | {
      kind: "tunnel";
      tunnelId: number;
      targetIp?: string;
      targetPort?: number;
      wireGuardPeerId?: string;
    }
  | {
      kind: "tunnel-hop";
      tunnelId: number;
      targetIp?: string;
      targetPort?: number;
      hopLabel?: string;
      routeLabel?: string;
      batchId?: string;
      groupKey?: string;
      groupLabel?: string;
      latencyMode?: "sum" | "max" | "multi-source";
      wireGuardPeerId?: string;
    }
  | {
      kind: "forward-via-tunnel";
      tunnelId: number;
      targetIp?: string;
      targetPort?: number;
      method?: "tcp" | "ping";
      tunnelLatencyBaselineId?: number;
    }
  | {
      kind: "forward-via-tunnel-entry";
      tunnelId: number;
      entryIp?: string;
      entrySourcePort?: number;
      targetIp?: string;
      targetPort?: number;
      method?: "tcp" | "ping";
    }
  | {
      kind: "forward-chain";
      groupId: number;
      entryIp?: string;
      entrySourcePort?: number;
      targetIp?: string;
      targetPort?: number;
      method?: "tcp" | "ping";
      hopLabel?: string;
      routeLabel?: string;
      batchId?: string;
      groupKey?: string;
      groupLabel?: string;
      latencyMode?: "sum" | "max" | "multi-source" | "remaining-path" | "multi-source-remaining-path";
      runtimeDependent?: boolean;
    };

export function isAgentTrafficStat(value: unknown): value is AgentTrafficStat {
  const item = value as Partial<AgentTrafficStat>;
  return !!item && Number.isFinite(Number(item.ruleId));
}

export function isAgentHostTrafficStat(value: unknown): value is AgentHostTrafficStat {
  const item = value as Partial<AgentHostTrafficStat>;
  if (!item || typeof item !== "object") return false;
  const bytesIn = item.bytesIn === undefined || Number.isFinite(Number(item.bytesIn));
  const bytesOut = item.bytesOut === undefined || Number.isFinite(Number(item.bytesOut));
  return bytesIn && bytesOut && (item.bytesIn !== undefined || item.bytesOut !== undefined);
}
export function isAgentTcpingResult(value: unknown): value is AgentTcpingResult {
  const item = value as Partial<AgentTcpingResult>;
  return validAgentProbeResult(item, "ruleId")
    && validOptionalInteger(item.tunnelId, 0)
    && validOptionalHealthDecision(item);
}

export function isAgentTunnelTcpingResult(value: unknown): value is AgentTunnelTcpingResult {
  const item = value as Partial<AgentTunnelTcpingResult>;
  return validAgentProbeResult(item, "tunnelId")
    && validOptionalInteger(item.hopIndex, 0)
    && validOptionalInteger(item.hopCount, 1)
    && (item.seriesKey === undefined || item.seriesKey === null || validShortString(item.seriesKey, 64));
}

export function isAgentHostProbeServiceResult(value: unknown): value is AgentHostProbeServiceResult {
  const item = value as Partial<AgentHostProbeServiceResult>;
  return validAgentProbeResult(item, "serviceId");
}
export function isAgentForwardGroupLatencyResult(value: unknown): value is AgentForwardGroupLatencyResult {
  const item = value as Partial<AgentForwardGroupLatencyResult>;
  return validAgentProbeResult(item, "groupId")
    && validOptionalInteger(item.memberId, 1)
    && validOptionalInteger(item.hopIndex, 0)
    && validOptionalInteger(item.hopCount, 1)
    && validOptionalHealthDecision(item);
}

function validOptionalHealthDecision(item: { healthStatus?: unknown; healthPending?: unknown }) {
  return (item.healthStatus === undefined || item.healthStatus === "unknown" || item.healthStatus === "healthy" || item.healthStatus === "unhealthy")
    && (item.healthPending === undefined || typeof item.healthPending === "boolean");
}

function validShortString(value: unknown, maxLength: number) {
  return typeof value === "string" && value.length <= maxLength;
}

function validOptionalInteger(value: unknown, minimum: number) {
  return value === undefined || value === null || (Number.isInteger(Number(value)) && Number(value) >= minimum);
}

function validAgentProbeResult(item: any, idKey: string) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const id = Number(item[idKey]);
  if (!Number.isInteger(id) || id <= 0) return false;
  if (item.latencyMs !== undefined && item.latencyMs !== null && !Number.isFinite(Number(item.latencyMs))) return false;
  if (item.isTimeout !== undefined && typeof item.isTimeout !== "boolean") return false;
  // Keep these counters bounded: they are telemetry metadata, not a free-form
  // payload.  Older Agents omit them and are handled as one probe server-side.
  if (item.probeCount !== undefined && (!Number.isInteger(Number(item.probeCount)) || Number(item.probeCount) < 1 || Number(item.probeCount) > 1024)) return false;
  if (item.probeSuccesses !== undefined && (!Number.isInteger(Number(item.probeSuccesses)) || Number(item.probeSuccesses) < 0 || Number(item.probeSuccesses) > 1024)) return false;
  if (item.probeCount !== undefined && item.probeSuccesses !== undefined && Number(item.probeSuccesses) > Number(item.probeCount)) return false;
  if (item.targetPort !== undefined && (!Number.isInteger(Number(item.targetPort)) || Number(item.targetPort) < 0 || Number(item.targetPort) > 65535)) return false;
  if (item.sourcePort !== undefined && (!Number.isInteger(Number(item.sourcePort)) || Number(item.sourcePort) < 0 || Number(item.sourcePort) > 65535)) return false;
  if (item.targetIp !== undefined && !validShortString(item.targetIp, 512)) return false;
  if (item.method !== undefined && !validShortString(item.method, 32)) return false;
  if (item.probeKey !== undefined && !validShortString(item.probeKey, 1024)) return false;
  if (item.topologyKey !== undefined && !validShortString(item.topologyKey, 2048)) return false;
  return true;
}

export function isSelfTestMeta(value: unknown): value is SelfTestMeta {
  const meta = value as Partial<SelfTestMeta>;
  if (!meta || typeof meta.kind !== "string") return false;
  if (meta.kind === "forward-chain") return Number.isFinite(Number((meta as any).groupId));
  return Number.isFinite(Number((meta as any).tunnelId));
}
