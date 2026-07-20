import { normalizeForwardRuleProtocol } from "@shared/forwardTypes";
import {
  isRuleLatencyReportMethodCompatible,
  ruleLatencyProbeMethodForRule,
} from "@shared/latencyProbe";

export const TUNNEL_RULE_LATENCY_FRESH_MS = 5 * 60 * 1000;

type TunnelRuleLatencyReport = {
  targetPort?: unknown;
  method?: unknown;
  topologyKey?: unknown;
};

function normalizedTarget(value: unknown) {
  return String(value || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
}

function validId(value: unknown) {
  const id = Number(value || 0);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function validPort(value: unknown) {
  const port = Number(value || 0);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

function validLatency(value: unknown) {
  const latency = Number(value);
  return Number.isFinite(latency) && latency >= 0 ? latency : null;
}

export function tunnelRuleLatencyTopologyKey(rule: any, tunnel: any, targetIp: unknown = rule?.targetIp) {
  return [
    "rule-latency-v1",
    validId(rule?.id),
    validId(tunnel?.id),
    validId(tunnel?.exitHostId),
    normalizedTarget(targetIp),
    validPort(rule?.targetPort),
    normalizeForwardRuleProtocol(rule?.protocol),
  ].join(":");
}

export function buildTunnelRuleLatencyProbe(input: {
  hostId: unknown;
  rule: any;
  tunnel: any;
  targetIp?: unknown;
}) {
  const hostId = validId(input.hostId);
  const ruleId = validId(input.rule?.id);
  const tunnelId = validId(input.tunnel?.id);
  const exitHostId = validId(input.tunnel?.exitHostId);
  const targetIp = String(input.targetIp ?? input.rule?.targetIp ?? "").trim();
  const targetPort = validPort(input.rule?.targetPort);
  if (!hostId || !ruleId || !tunnelId || hostId !== exitHostId || !targetIp || !targetPort) return null;
  const topologyKey = tunnelRuleLatencyTopologyKey(input.rule, input.tunnel, targetIp);
  return {
    ruleId,
    tunnelId,
    targetIp,
    targetPort,
    method: ruleLatencyProbeMethodForRule(input.rule),
    probeKey: topologyKey,
    topologyKey,
  };
}

export function validateTunnelRuleLatencyReport(input: {
  hostId: unknown;
  rule: any;
  tunnel: any;
  report: TunnelRuleLatencyReport;
}) {
  const hostId = validId(input.hostId);
  if (!hostId || hostId !== validId(input.tunnel?.exitHostId)) return false;
  if (validId(input.rule?.tunnelId) !== validId(input.tunnel?.id)) return false;
  if (input.tunnel?.isEnabled === false || input.rule?.isEnabled === false || input.rule?.pendingDelete) return false;
  const reportTargetPort = Number(input.report?.targetPort || 0);
  if (reportTargetPort > 0 && reportTargetPort !== validPort(input.rule?.targetPort)) return false;
  if (!isRuleLatencyReportMethodCompatible(input.rule?.protocol, input.report?.method)) return false;
  const topologyKey = String(input.report?.topologyKey || "").trim();
  if (topologyKey && topologyKey !== tunnelRuleLatencyTopologyKey(input.rule, input.tunnel)) return false;
  return true;
}

export function combineTunnelRuleLatencySample(input: {
  targetLatencyMs: unknown;
  targetIsTimeout: boolean;
  tunnelLatencyMs?: unknown;
  tunnelIsTimeout?: boolean;
  tunnelRecordedAt?: Date | string | number | null;
  nowMs?: number;
}) {
  const targetLatencyMs = validLatency(input.targetLatencyMs);
  if (input.targetIsTimeout || targetLatencyMs === null) {
    return { latencyMs: null, isTimeout: true } as const;
  }

  const rawRecordedAt = input.tunnelRecordedAt;
  const numericRecordedAt = typeof rawRecordedAt === "number" ? rawRecordedAt : Number.NaN;
  const recordedAtMs = rawRecordedAt == null
    ? 0
    : Number.isFinite(numericRecordedAt)
      ? numericRecordedAt < 1_000_000_000_000 ? numericRecordedAt * 1000 : numericRecordedAt
      : new Date(rawRecordedAt).getTime();
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  if (!Number.isFinite(recordedAtMs) || recordedAtMs <= 0 || nowMs - recordedAtMs > TUNNEL_RULE_LATENCY_FRESH_MS) {
    return null;
  }
  if (input.tunnelIsTimeout) return { latencyMs: null, isTimeout: true } as const;
  const tunnelLatencyMs = validLatency(input.tunnelLatencyMs);
  if (tunnelLatencyMs === null) return null;
  return {
    latencyMs: Math.round((targetLatencyMs + tunnelLatencyMs) * 10) / 10,
    isTimeout: false,
  } as const;
}
