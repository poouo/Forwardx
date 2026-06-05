export type AgentTrafficStat = {
  ruleId: number;
  bytesIn?: number;
  bytesOut?: number;
  connections?: number;
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
};

export type SelfTestMeta =
  | {
      kind: "tunnel";
      tunnelId: number;
      targetIp?: string;
      targetPort?: number;
    }
  | {
      kind: "tunnel-hop";
      tunnelId: number;
      targetIp?: string;
      targetPort?: number;
      hopLabel?: string;
      routeLabel?: string;
      batchId?: string;
    }
  | {
      kind: "forward-via-tunnel";
      tunnelId: number;
      targetIp?: string;
      targetPort?: number;
    }
  | {
      kind: "forward-via-tunnel-entry";
      tunnelId: number;
      entryIp?: string;
      entrySourcePort?: number;
      targetIp?: string;
      targetPort?: number;
    }
  | {
      kind: "forward-chain";
      groupId: number;
      entryIp?: string;
      entrySourcePort?: number;
      targetIp?: string;
      targetPort?: number;
    };

export function isAgentTrafficStat(value: unknown): value is AgentTrafficStat {
  const item = value as Partial<AgentTrafficStat>;
  return !!item && Number.isFinite(Number(item.ruleId));
}

export function isAgentTcpingResult(value: unknown): value is AgentTcpingResult {
  const item = value as Partial<AgentTcpingResult>;
  return !!item && Number.isFinite(Number(item.ruleId));
}

export function isAgentTunnelTcpingResult(value: unknown): value is AgentTunnelTcpingResult {
  const item = value as Partial<AgentTunnelTcpingResult>;
  return !!item && Number.isFinite(Number(item.tunnelId));
}

export function isSelfTestMeta(value: unknown): value is SelfTestMeta {
  const meta = value as Partial<SelfTestMeta>;
  if (!meta || typeof meta.kind !== "string") return false;
  if (meta.kind === "forward-chain") return Number.isFinite(Number((meta as any).groupId));
  return Number.isFinite(Number((meta as any).tunnelId));
}
