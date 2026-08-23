import { normalizeForwardRuleProtocol } from "@shared/forwardTypes";
import {
  isRuleLatencyReportMethodCompatible,
  ruleLatencyProbeMethodForRule,
} from "@shared/latencyProbe";

export const TUNNEL_RULE_LATENCY_FRESH_MS = 5 * 60 * 1000;
const TUNNEL_RULE_LATENCY_CLOCK_SKEW_MS = 60 * 1000;
const TUNNEL_RULE_LATENCY_UPDATE_GRACE_MS = 1000;

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
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const latency = Number(value);
  return Number.isFinite(latency) && latency >= 0 ? latency : null;
}

function epochMs(value: unknown) {
  if (value === null || value === undefined || value === "") return 0;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : 0;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  const text = String(value).trim();
  if (!text) return 0;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * A rule self-test may finish before the distributed tunnel probe report does.
 * Reusing a recent successful sample is safe only while the tunnel still
 * reports success and no tunnel configuration/test update occurred after that
 * sample. Failed, stale, or pre-update samples must continue to fail closed.
 */
export function canReuseRecentTunnelLatencySample(input: {
  sample: any;
  tunnel: any;
  nowMs?: number;
  maxAgeMs?: number;
}) {
  const sample = input.sample;
  if (!sample || sample.isTimeout === true || validLatency(sample.latencyMs) === null) return false;
  const recordedAtMs = epochMs(sample.recordedAt);
  if (!recordedAtMs) return false;
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const maxAgeMs = Number.isFinite(input.maxAgeMs)
    ? Math.max(0, Number(input.maxAgeMs))
    : TUNNEL_RULE_LATENCY_FRESH_MS;
  if (recordedAtMs > nowMs + TUNNEL_RULE_LATENCY_CLOCK_SKEW_MS) return false;
  if (nowMs - recordedAtMs > maxAgeMs) return false;
  if (String(input.tunnel?.lastTestStatus || "").trim().toLowerCase() !== "success") return false;

  // Tunnel updates are stored at one-second precision on all supported DBs.
  // Allow a small write-ordering grace, but reject a sample from before a
  // configuration change or a later failed/manual test.
  const updatedAtMs = epochMs(input.tunnel?.updatedAt);
  const lastTestAtMs = epochMs(input.tunnel?.lastTestAt);
  const invalidatedAtMs = Math.max(updatedAtMs, lastTestAtMs);
  if (invalidatedAtMs > 0 && recordedAtMs + TUNNEL_RULE_LATENCY_UPDATE_GRACE_MS < invalidatedAtMs) return false;
  return true;
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

export function tunnelRuleLatencySampleSucceeded(
  targetSucceeded: boolean,
  combinedLatency: { latencyMs: number | null; isTimeout: boolean } | null | undefined,
) {
  return !!targetSucceeded
    && !!combinedLatency
    && !combinedLatency.isTimeout
    && validLatency(combinedLatency.latencyMs) !== null;
}
