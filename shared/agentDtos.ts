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
  latencyMs?: number | null;
  isTimeout?: boolean;
};

export type AgentTunnelTcpingResult = {
  tunnelId: number;
  latencyMs?: number | null;
  isTimeout?: boolean;
  hopIndex?: number;
  hopCount?: number;
  seriesKey?: string | null;
  seriesLabel?: string | null;
};

export type AgentHostProbeServiceResult = {
  serviceId: number;
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
  return !!item && Number.isFinite(Number(item.ruleId));
}

export function isAgentTunnelTcpingResult(value: unknown): value is AgentTunnelTcpingResult {
  const item = value as Partial<AgentTunnelTcpingResult>;
  return !!item && Number.isFinite(Number(item.tunnelId));
}

export function isAgentHostProbeServiceResult(value: unknown): value is AgentHostProbeServiceResult {
  const item = value as Partial<AgentHostProbeServiceResult>;
  return !!item && Number.isFinite(Number(item.serviceId));
}
export function isAgentForwardGroupLatencyResult(value: unknown): value is AgentForwardGroupLatencyResult {
  const item = value as Partial<AgentForwardGroupLatencyResult>;
  return !!item && Number.isFinite(Number(item.groupId));
}

export function isSelfTestMeta(value: unknown): value is SelfTestMeta {
  const meta = value as Partial<SelfTestMeta>;
  if (!meta || typeof meta.kind !== "string") return false;
  if (meta.kind === "forward-chain") return Number.isFinite(Number((meta as any).groupId));
  return Number.isFinite(Number((meta as any).tunnelId));
}
