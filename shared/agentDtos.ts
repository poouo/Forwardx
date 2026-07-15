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
  sourcePort?: number;
  targetIp?: string;
  targetPort?: number;
  method?: "tcping" | "ping" | string;
  probeKey?: string;
  topologyKey?: string;
  latencyMs?: number | null;
  isTimeout?: boolean;
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
  method?: "tcping" | "ping" | string;
};
export type AgentForwardGroupLatencyResult = {
  groupId: number;
  memberId?: number;
  probeType?: "chain" | "china" | string;
  latencyMs?: number | null;
  isTimeout?: boolean;
  hopIndex?: number;
  hopCount?: number;
  method?: "tcp" | "ping" | string;
  targetIp?: string;
  targetPort?: number;
  probeKey?: string;
  topologyKey?: string;
};

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
      latencyMode?: "sum" | "max" | "multi-source";
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
  return validAgentProbeResult(item, "ruleId");
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
    && validOptionalInteger(item.hopCount, 1);
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
