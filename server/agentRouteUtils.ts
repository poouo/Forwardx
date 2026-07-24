import crypto from "crypto";
import { isSelfTestMeta, type SelfTestMeta } from "../shared/agentDtos";
import { linkProbeMethodForRule, normalizeLinkProbeMethod } from "../shared/latencyProbe";

export const AGENT_PLUGIN_TASK_VERSION = "2.2.151";
export const AGENT_PANEL_MIGRATION_VERSION = "2.2.153";

export function normalizeVersion(version: string | null | undefined) {
  return String(version || "").trim().replace(/^v/i, "");
}

export function compareVersions(a: string | null | undefined, b: string | null | undefined) {
  const pa = normalizeVersion(a).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = normalizeVersion(b).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function isAgentVersionAtLeast(version: string | null | undefined, target: string | null | undefined) {
  if (!version || !target) return false;
  return compareVersions(version, target) >= 0;
}

export function isAgentUpgradeTargetSatisfied(
  version: string | null | undefined,
  target: string | null | undefined,
  currentSupportedVersion?: string | null,
) {
  if (!version || !target) return false;
  const normalizedVersion = normalizeVersion(version);
  const normalizedTarget = normalizeVersion(target);
  if (!normalizedVersion || !normalizedTarget) return false;
  if (currentSupportedVersion && compareVersions(normalizedTarget, currentSupportedVersion) < 0) {
    return normalizedVersion === normalizedTarget;
  }
  return compareVersions(normalizedVersion, normalizedTarget) >= 0;
}

export function isAgentVersionBehind(version: string | null | undefined, target: string | null | undefined) {
  if (!version || !target) return false;
  return compareVersions(version, target) < 0;
}

export function hasAgentVersionChanged(
  previousVersion: string | null | undefined,
  reportedVersion: string | null | undefined,
) {
  const reported = normalizeVersion(reportedVersion);
  if (!reported) return false;
  return reported !== normalizeVersion(previousVersion);
}

export function tunnelSecretSeed(tunnel: any) {
  if (tunnel?.secret) return String(tunnel.secret);
  return crypto
    .createHash("sha256")
    .update(`forwardx-tunnel:${tunnel?.id}:${tunnel?.entryHostId}:${tunnel?.exitHostId}`)
    .digest("hex");
}

export function parseSelfTestMeta(message: unknown): SelfTestMeta | null {
  if (typeof message !== "string" || !message.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(message);
    return isSelfTestMeta(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function agentInteger(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function buildTunnelAgentSelfTestPayload(test: { id?: unknown }, meta: SelfTestMeta | null) {
  if (meta?.kind !== "tunnel" && meta?.kind !== "tunnel-hop") return null;
  return {
    testId: agentInteger(test?.id),
    kind: meta.kind,
    tunnelId: agentInteger(meta.tunnelId),
    ruleId: 0,
    forwardType: "gost-tunnel",
    protocol: "tcp",
    sourcePort: 0,
    targetIp: meta.targetIp,
    targetPort: agentInteger(meta.targetPort),
    wireGuardPeerId: meta.wireGuardPeerId,
  };
}

export function buildForwardChainAgentSelfTestPayload(
  test: { id?: unknown; ruleId?: unknown },
  meta: SelfTestMeta | null,
) {
  if (meta?.kind !== "forward-chain") return null;
  const method = normalizeLinkProbeMethod(meta.method);
  return {
    testId: agentInteger(test?.id),
    kind: meta.runtimeDependent === false ? "forward-chain-target" : "forward-chain",
    groupId: agentInteger(meta.groupId),
    ruleId: agentInteger(test?.ruleId),
    forwardType: "forward-chain",
    protocol: method,
    method,
    sourcePort: agentInteger(meta.entrySourcePort),
    targetIp: meta.targetIp || meta.entryIp,
    targetPort: agentInteger(meta.targetPort || meta.entrySourcePort),
  };
}

export function buildMetaAgentSelfTestPayload(
  test: { id?: unknown; ruleId?: unknown },
  meta: SelfTestMeta | null,
) {
  const tunnelPayload = buildTunnelAgentSelfTestPayload(test, meta);
  if (tunnelPayload) return tunnelPayload;

  if (meta?.kind === "forward-via-tunnel" || meta?.kind === "forward-via-tunnel-entry") {
    const entryProbe = meta.kind === "forward-via-tunnel-entry";
    const method = normalizeLinkProbeMethod(meta.method);
    return {
      testId: agentInteger(test?.id),
      kind: meta.kind,
      tunnelId: agentInteger(meta.tunnelId),
      ruleId: agentInteger(test?.ruleId),
      forwardType: "gost-tunnel",
      protocol: method,
      method,
      sourcePort: entryProbe ? agentInteger(meta.entrySourcePort) : 0,
      targetIp: entryProbe ? meta.entryIp : meta.targetIp,
      targetPort: entryProbe ? agentInteger(meta.entrySourcePort) : agentInteger(meta.targetPort),
    };
  }

  return buildForwardChainAgentSelfTestPayload(test, meta);
}

export function buildRuleAgentSelfTestPayload(
  test: { id?: unknown; ruleId?: unknown },
  rule: any,
  targetIp = rule?.targetIp,
) {
  const method = linkProbeMethodForRule(rule);
  return {
    testId: agentInteger(test?.id),
    ruleId: agentInteger(rule?.id ?? test?.ruleId),
    forwardType: String(rule?.forwardType || ""),
    protocol: method,
    method,
    sourcePort: agentInteger(rule?.sourcePort),
    targetIp: String(targetIp || ""),
    targetPort: agentInteger(rule?.targetPort),
  };
}
