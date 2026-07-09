import { Router, Request, Response } from "express";
import * as db from "./db";
import { AGENT_VERSION } from "./_core/systemRouter";
import { clearHostTcpingRequest, hasHostTcpingRequest, isHostMetricsWatching } from "./agentEvents";
import { isAgentUpgradeTargetSatisfied, isAgentVersionAtLeast, parseSelfTestMeta, tunnelSecretSeed } from "./agentRouteUtils";
import { resolveAgentAdvertisedPanelUrl } from "./agentPanelUrl";
import * as hopRepo from "./repositories/tunnelRepository";
import crypto from "crypto";
import {
  getForwardProtocolSettings,
  isRuleProtocolEnabled,
  isTunnelProtocolEnabled,
} from "./forwardProtocolSettings";
import { clearTunnelRuntimeStatusForHost, getTunnelRuntimeGeneration, isTunnelRuntimeHostReady } from "./tunnelRuntimeStatus";
import { appendPanelLog } from "./_core/panelLogger";
import { isIP } from "net";
import { resolve4, resolve6 } from "dns/promises";
import { takeLookingGlassAgentTasks } from "./lookingGlassAgentTasks";
import { takeIperf3AgentTasks } from "./iperf3AgentTasks";
import { getAgentHostFromRequest, getResolvedAgentToken } from "./agentAuth";
import { normalizeAgentAddress, normalizeAgentText, normalizeNetworkInterface } from "./agentInputValidation";
import {
  buildCountingChainCmds,
  buildCountingCleanupCmds,
  buildIptablesForwardCleanupCmds,
  buildIptablesForwardCmds,
  buildManagedPortCleanupCmds,
  buildNftCleanupCmds,
  buildNftForwardCmds,
  killByPatternCmd,
  removeManagedServiceCmd,
  restartManagedServiceIfConfigChangedCmd,
  shQuote,
  startManagedServiceCmd,
  stopManagedServiceCmd,
  writeManagedServiceCmd,
} from "./agentActionCommands";
import { handleHostAddressChanged, hostIngressAddress, refreshAgentsAffectedByHostAddress } from "./hostAddressRuntime";
import { getTunnelAutoHopAggregate } from "./tunnelAutoLatencyState";
import { isHostStatusOnline, notifyHostOnlineIfNeeded } from "./hostStatusNotifier";
import { linkProbeMethodForRule, normalizeLinkProbeMethod } from "@shared/latencyProbe";
import { buildPluginHostAssetSyncActions } from "./repositories/pluginRepository";
import {
  forwardRuleProtocols,
  isForwardRuleProtocolTcpEnabled,
  isForwardRuleProtocolUdpEnabled,
  normalizeForwardRuleProtocol,
} from "@shared/forwardTypes";

// DNS 解析缓存：ruleId → 主目标上次解析到的 IPv4 地址。
// 备用出站策略里的域名由 Agent 的 TCP 拨号和健康检查动态解析。
const AGENT_DNS_RESOLVE_TTL_MS = 5 * 60 * 1000;
const resolvedIpCache = new Map<number, { raw: string; ip: string }>();
const resolvedIpCheckedAt = new Map<number, number>();
const tunnelRouteLogCache = new Map<string, string>();
const nginxRuntimeLogCache = new Map<number, string>();
const dnsRuntimeGenerationByKey = new Map<string, number>();
const agentActionBatchCache = new Map<number, { signature: string; issuedAt: number; seenAt: number }>();
const agentDesiredStateSendCache = new Map<number, { signature: string; sentAt: number }>();
const agentRuntimeSyncActionCache = new Map<number, { signature: string; sentAt: number }>();
const agentPluginSyncActionCache = new Map<string, { signature: string; sentAt: number }>();
// 孤儿端口迟滞：hostId -> (port -> 连续判定为孤儿的心跳次数)。
// 一个上报端口若其 ruleId 属于面板已知的本机启用规则，则该端口极可能只是运行态推导
// 的瞬时缺口（如隧道出口端口某轮未算出），必须连续多轮都判孤儿才真正下发拆除，
// 否则会与 apply 形成 apply→remove→apply 抖动死循环。
const agentOrphanPortStreakCache = new Map<number, Map<number, number>>();
const AGENT_ORPHAN_REMOVE_MIN_STREAK = 3;
const RUNTIME_BIN = "/usr/local/bin/forwardx-runtime";
const RUNTIME_SERVICE_NAME = "forwardx-runtime";
const TUNNEL_RUNTIME_SERVICE_NAME = "forwardx-tunnel-runtime";
const RUNTIME_CONFIG_PATH = "/etc/forwardx/runtime/gost.json";
const TUNNEL_RUNTIME_CONFIG_PATH = "/etc/forwardx/runtime/tunnel-gost.json";
const RUNTIME_CONFIG_DIR = "/etc/forwardx/runtime";
const NGINX_BIN = "/usr/local/bin/forwardx-nginx";
const NGINX_SERVICE_NAME = "forwardx-nginx";
const NGINX_CONFIG_DIR = "/etc/forwardx/nginx";
const NGINX_CONFIG_PATH = "/etc/forwardx/nginx/nginx.conf";
const NGINX_STAGED_CONFIG_PATH = "/etc/forwardx/nginx/nginx.conf.next";
const NGINX_CERT_DIR = "/etc/forwardx/nginx/certs";
const REALM_CONFIG_DIR = "/etc/forwardx/realm";
const LEGACY_GOST_SERVICE_NAME = "forwardx-gost";
const LEGACY_TUNNEL_SERVICE_NAME = "forwardx-tunnels";
const MIMIC_CONFIG_DIR = "/etc/mimic";
const AGENT_FIREWALL_COUNTER_REFRESH_VERSION = "2.2.108";
const AGENT_PROTOCOL_GUARD_BACKEND_VERSION = "2.2.127";
const AGENT_DESIRED_STATE_VERSION = "2.2.134";
const AGENT_ACTION_BATCH_REUSE_MS = 45 * 1000;
const AGENT_DESIRED_STATE_ACTIVE_RESEND_MS = 60 * 1000;
const AGENT_RUNTIME_SYNC_REPAIR_RESEND_MS = 60 * 1000;
const AGENT_PLUGIN_SYNC_RESEND_MS = 5 * 60 * 1000;
const SHARED_RUNTIME_FORWARD_TYPES = new Set([
  "gost",
  "gost-tunnel",
  "gost-tunnel-exit",
  "gost-tunnel-hop",
  "nginx",
  "nginx-tunnel",
  "nginx-tunnel-exit",
]);
const SHARED_NGINX_FORWARD_TYPES = new Set(["nginx", "nginx-tunnel", "nginx-tunnel-exit"]);
const VERBOSE_AGENT_ACTIONS = /^(1|true|yes|on)$/i.test(String(process.env.FORWARDX_VERBOSE_AGENT_ACTIONS || ""));
const BYTES_PER_MEGABIT = 1_000_000 / 8;
const AGENT_STATE_SECTION_NAMES = [
  "runningRules",
  "tunnelProbes",
  "forwardGroupProbes",
  "hostProbeServices",
  "guardRules",
  "dnsWatch",
] as const;

type AgentDnsWatch = {
  host: string;
  scope: string;
  refId?: number;
};
type AgentStateSectionName = typeof AGENT_STATE_SECTION_NAMES[number];
type AgentStateSignatures = Partial<Record<AgentStateSectionName, string>>;
type AgentLocalRuntimeRuleState = {
  port: number;
  ruleId: number;
  tunnelId?: number;
  forwardType: string;
  targetIp?: string;
  targetPort?: number;
  protocol?: string;
  ready?: boolean;
};
type AgentLocalRuntimeTunnelState = {
  port: number;
  tunnelId: number;
  forwardType: string;
  ready?: boolean;
};
type AgentLocalRuntimeServiceState = {
  name: string;
  active: boolean;
  hasWork: boolean;
};
type AgentLocalRuntimeState = {
  rules: AgentLocalRuntimeRuleState[];
  tunnels: AgentLocalRuntimeTunnelState[];
  services: AgentLocalRuntimeServiceState[];
};
const agentLocalRuntimeStateCache = new Map<number, { signature: string; state: AgentLocalRuntimeState; updatedAt: number }>();

function stableActionSignature(actions: any[]) {
  return JSON.stringify(actions.map((action: any) => ({
    op: action?.op || "",
    statusType: action?.statusType || "",
    ruleId: Number(action?.ruleId || 0),
    tunnelId: Number(action?.tunnelId || 0),
    forwardType: action?.forwardType || "",
    sourcePort: Number(action?.sourcePort || 0),
    targetIp: String(action?.targetIp || ""),
    targetPort: Number(action?.targetPort || 0),
    protocol: action?.protocol || "",
    commands: action?.commands || [],
    preCommands: action?.preCommands || [],
    postCommands: action?.postCommands || [],
    serviceName: action?.serviceName || action?.svcName || "",
    serviceNameExtra: action?.serviceNameExtra || "",
    unit: action?.unit || "",
    unitExtra: action?.unitExtra || "",
    fxp: action?.fxp || null,
    failover: action?.failover || null,
  })));
}

function canonicalizeStateSection(value: any): any {
  if (Array.isArray(value)) {
    return value
      .map((item) => canonicalizeStateSection(item))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc: Record<string, any>, key) => {
        const item = value[key];
        if (typeof item !== "undefined") acc[key] = canonicalizeStateSection(item);
        return acc;
      }, {});
  }
  return value;
}

function stableStateSignature(value: any) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalizeStateSection(value)))
    .digest("hex");
}

function normalizeAgentStateSignatures(input: any): AgentStateSignatures {
  if (!input || typeof input !== "object") return {};
  const output: AgentStateSignatures = {};
  for (const name of AGENT_STATE_SECTION_NAMES) {
    const value = String(input[name] || "").trim();
    if (/^[a-f0-9]{64}$/i.test(value)) output[name] = value.toLowerCase();
  }
  return output;
}

function normalizeRuntimeStateSignature(input: any) {
  const value = String(input || "").trim();
  return /^[a-f0-9]{1,128}$/i.test(value) ? value.toLowerCase() : "";
}

function normalizeAgentLocalRuntimeState(input: any): AgentLocalRuntimeState | null {
  if (!input || typeof input !== "object") return null;
  const rules = Array.isArray(input.rules)
    ? input.rules
      .map((item: any) => ({
        port: Number(item?.port || 0),
        ruleId: Number(item?.ruleId || 0),
        tunnelId: Number(item?.tunnelId || 0) || undefined,
        forwardType: String(item?.forwardType || "").trim(),
        targetIp: String(item?.targetIp || "").trim() || undefined,
        targetPort: Number(item?.targetPort || 0) || undefined,
        protocol: String(item?.protocol || "").trim() || undefined,
        ready: item?.ready !== false,
      }))
      .filter((item: AgentLocalRuntimeRuleState) => item.port > 0)
    : [];
  const tunnels = Array.isArray(input.tunnels)
    ? input.tunnels
      .map((item: any) => ({
        port: Number(item?.port || 0),
        tunnelId: Number(item?.tunnelId || 0),
        forwardType: String(item?.forwardType || "").trim(),
        ready: item?.ready !== false,
      }))
      .filter((item: AgentLocalRuntimeTunnelState) => item.port > 0 && item.tunnelId > 0)
    : [];
  const services = Array.isArray(input.services)
    ? input.services
      .map((item: any) => ({
        name: String(item?.name || "").trim(),
        active: item?.active === true,
        hasWork: item?.hasWork === true,
      }))
      .filter((item: AgentLocalRuntimeServiceState) => !!item.name)
    : [];
  return { rules, tunnels, services };
}

function resolveAgentLocalRuntimeState(hostId: number, signature: string, reported: AgentLocalRuntimeState | null) {
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return { state: null as AgentLocalRuntimeState | null, requestLocalState: false };
  if (reported) {
    const nextSignature = signature || stableStateSignature(reported);
    agentLocalRuntimeStateCache.set(id, { signature: nextSignature, state: reported, updatedAt: Date.now() });
    return { state: reported, requestLocalState: false };
  }
  if (!signature) return { state: null as AgentLocalRuntimeState | null, requestLocalState: false };
  const cached = agentLocalRuntimeStateCache.get(id);
  if (cached && cached.signature === signature) {
    return { state: cached.state, requestLocalState: false };
  }
  return { state: null as AgentLocalRuntimeState | null, requestLocalState: true };
}

function buildAgentStateResponseSections(sections: Record<AgentStateSectionName, any[]>, clientSignatures: AgentStateSignatures) {
  const signatures: Record<AgentStateSectionName, string> = {} as Record<AgentStateSectionName, string>;
  const payload: Partial<Record<AgentStateSectionName, any[]>> = {};
  for (const name of AGENT_STATE_SECTION_NAMES) {
    const signature = stableStateSignature(sections[name] || []);
    signatures[name] = signature;
    if (clientSignatures[name] !== signature) {
      payload[name] = sections[name] || [];
    }
  }
  return { payload, signatures };
}

export function invalidateAgentDesiredStateCache(hostId: number) {
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return;
  agentActionBatchCache.delete(id);
  agentDesiredStateSendCache.delete(id);
  agentLocalRuntimeStateCache.delete(id);
  agentRuntimeSyncActionCache.delete(id);
  for (const key of Array.from(agentPluginSyncActionCache.keys())) {
    if (key.startsWith(`${id}:`)) agentPluginSyncActionCache.delete(key);
  }
  agentOrphanPortStreakCache.delete(id);
}

/**
 * 取得某主机的"孤儿端口迟滞计数"Map（port -> 连续判定为孤儿的心跳次数），不存在则创建。
 * 迟滞语义：一个上报端口的 ruleId 若属于面板已知的本机启用规则（稳定身份），
 * 即便本轮运行态推导没把它算进 expectedRulePorts，也很可能只是瞬时缺口，
 * 必须连续 AGENT_ORPHAN_REMOVE_MIN_STREAK 轮都判孤儿才真正拆除；一旦重新匹配上规则即清零。
 */
function getOrphanPortStreaks(hostId: number): Map<number, number> {
  const id = Number(hostId);
  let streaks = agentOrphanPortStreakCache.get(id);
  if (!streaks) {
    streaks = new Map<number, number>();
    agentOrphanPortStreakCache.set(id, streaks);
  }
  return streaks;
}

function resolveActionBatchIssuedAt(hostId: number, actions: any[], fallbackIssuedAt: number) {
  if (actions.length === 0) {
    agentActionBatchCache.delete(hostId);
    return fallbackIssuedAt;
  }
  const now = Date.now();
  const signature = stableActionSignature(actions);
  const cached = agentActionBatchCache.get(hostId);
  if (cached && cached.signature === signature && now - cached.seenAt < AGENT_ACTION_BATCH_REUSE_MS) {
    cached.seenAt = now;
    return cached.issuedAt;
  }
  agentActionBatchCache.set(hostId, { signature, issuedAt: fallbackIssuedAt, seenAt: now });
  return fallbackIssuedAt;
}

function shouldSendDesiredState(hostId: number, actions: any[], activeWorkActions: any[], now: number) {
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return actions.length > 0;
  if (actions.length === 0) {
    agentDesiredStateSendCache.delete(id);
    return false;
  }
  const signature = stableActionSignature(actions);
  const cached = agentDesiredStateSendCache.get(id);
  const hasActiveWork = activeWorkActions.length > 0;
  const changed = !cached || cached.signature !== signature;
  const activeResync = hasActiveWork && !!cached && now - cached.sentAt >= AGENT_DESIRED_STATE_ACTIVE_RESEND_MS;
  const shouldSend = changed || activeResync;
  if (shouldSend) {
    agentDesiredStateSendCache.set(id, { signature, sentAt: now });
  }
  return shouldSend;
}

function shouldSendRuntimeSyncAction(hostId: number, action: any, force: boolean, now: number, resendAfterMs = 0) {
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return true;
  const signature = stableActionSignature([action]);
  const cached = agentRuntimeSyncActionCache.get(id);
  const changed = !cached || cached.signature !== signature;
  const shouldResend = !!cached && resendAfterMs > 0 && now - cached.sentAt >= resendAfterMs;
  if (force || changed || shouldResend) {
    agentRuntimeSyncActionCache.set(id, { signature, sentAt: now });
    return true;
  }
  return false;
}

function shouldSendPluginSyncAction(hostId: number, action: any, now: number) {
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return true;
  const cacheKey = `${id}:${String(action?.forwardType || "plugin-sync")}`;
  const signature = stableActionSignature([action]);
  const cached = agentPluginSyncActionCache.get(cacheKey);
  if (!cached || cached.signature !== signature || now - cached.sentAt >= AGENT_PLUGIN_SYNC_RESEND_MS) {
    agentPluginSyncActionCache.set(cacheKey, { signature, sentAt: now });
    return true;
  }
  return false;
}

function actionPortKey(action: any) {
  const port = Number(action?.sourcePort || 0);
  if (port <= 0) return "";
  const statusType = String(action?.statusType || "").trim();
  const ruleId = Number(action?.ruleId || 0);
  const tunnelId = Number(action?.tunnelId || 0);
  if (ruleId > 0 || statusType === "rule") {
    return `rule-port:${port}`;
  }
  if (tunnelId > 0 || statusType === "tunnel") {
    return `tunnel:${tunnelId}:${port}`;
  }
  return "";
}

function dropStalePortRemoveActions(actions: any[], protectedRulePorts = new Set<string>()) {
  const applyPorts = new Set(
    actions
      .filter((action: any) => action?.op === "apply")
      .map(actionPortKey)
      .filter(Boolean),
  );
  return actions.filter((action: any) => {
    if (action?.op !== "remove") return true;
    const key = actionPortKey(action);
    return !(key && (applyPorts.has(key) || protectedRulePorts.has(key)));
  });
}

function actionMayAffectSharedRuntime(action: any) {
  if (!action || action.statusType === "runtime") return false;
  const op = String(action.op || "").trim();
  if (op !== "apply" && op !== "remove") return false;
  if (action.fxp) return false;
  return SHARED_RUNTIME_FORWARD_TYPES.has(String(action.forwardType || "").trim());
}

function cleanEndpointHost(value: unknown) {
  return String(value || "").trim().replace(/^\[([^\]]+)\]$/, "$1");
}

function isIpv6Literal(value: unknown) {
  return isIP(cleanEndpointHost(value)) === 6;
}

function isForwardXTunnelMode(tunnel: any) {
  return String(tunnel?.mode || "").toLowerCase() === "forwardx";
}

function isNginxTunnelMode(tunnel: any) {
  const mode = String(tunnel?.mode || "").toLowerCase();
  return mode === "nginx_stream" || mode === "nginx_tls";
}

function isGostTunnelMode(tunnel: any) {
  return !!tunnel && !isForwardXTunnelMode(tunnel) && !isNginxTunnelMode(tunnel);
}

function endpointHostPort(host: unknown, port: unknown) {
  const clean = cleanEndpointHost(host);
  return isIpv6Literal(clean) ? `[${clean}]:${Number(port) || 0}` : `${clean}:${Number(port) || 0}`;
}

function socatDialEndpoint(protocol: "TCP" | "UDP", host: unknown, port: unknown) {
  const clean = cleanEndpointHost(host);
  const dialProtocol = isIpv6Literal(clean) ? `${protocol}6` : protocol;
  return `${dialProtocol}:${endpointHostPort(clean, port)}`;
}

function realmTomlString(value: unknown) {
  return JSON.stringify(String(value ?? ""));
}

function realmConfigPathForPort(port: unknown) {
  return `${REALM_CONFIG_DIR}/forwardx-realm-${Number(port) || 0}.toml`;
}

function realmGuardConfigPathForPort(port: unknown) {
  return `${REALM_CONFIG_DIR}/forwardx-realm-guard-${Number(port) || 0}.toml`;
}

function mimicFilterEndpoint(host: unknown, port: unknown) {
  const clean = cleanEndpointHost(host);
  const p = Number(port) || 0;
  if (!clean || p <= 0 || p > 65535) return "";
  if (clean === "0.0.0.0" || clean === "::" || clean === "[::]") {
    return isIpv6Literal(clean) ? "[::]:" + p : "0.0.0.0:" + p;
  }
  return endpointHostPort(clean, p);
}

function udpOverTcpEnabled(rule: any, tunnel: any) {
  return !!rule
    && !!tunnel
    && isForwardXTunnelMode(tunnel)
    && !!(rule as any).udpOverTcp
    && isForwardRuleProtocolUdpEnabled(rule?.protocol);
}

function normalizeRateLimitMbps(value: unknown) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.max(0, Math.floor(num));
}

function userTunnelRateLimitMbps(user: any) {
  return Math.max(
    normalizeRateLimitMbps(user?.gostRateLimitIn),
    normalizeRateLimitMbps(user?.gostRateLimitOut),
  );
}

function tunnelRateLimitMbps(tunnel: any) {
  return normalizeRateLimitMbps(tunnel?.rateLimitMbps);
}

function effectiveTunnelRateLimitMbps(user: any, tunnel?: any | null) {
  const limits = [userTunnelRateLimitMbps(user), tunnelRateLimitMbps(tunnel)].filter((limit) => limit > 0);
  return limits.length > 0 ? Math.min(...limits) : 0;
}

function mbpsToBytesPerSecond(mbps: unknown) {
  return Math.max(0, Math.floor(normalizeRateLimitMbps(mbps) * BYTES_PER_MEGABIT));
}

function isHostnameAddress(value: string) {
  const text = String(value || "").trim();
  return !!text && !isIP(text) && /^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$/.test(text);
}

function agentReportedAddress(body: any, existingHost: any) {
  const hasIp = Object.prototype.hasOwnProperty.call(body || {}, "ip");
  const hasIpv4 = Object.prototype.hasOwnProperty.call(body || {}, "ipv4");
  const hasIpv6 = Object.prototype.hasOwnProperty.call(body || {}, "ipv6");
  const safeIpv4 = normalizeAgentAddress(body?.ipv4);
  const safeIpv6 = normalizeAgentAddress(body?.ipv6);
  const safeIp = normalizeAgentAddress(body?.ip);
  const nextIpv4 = hasIpv4 ? (safeIpv4 || null) : (existingHost?.ipv4 || null);
  const nextIpv6 = hasIpv6 ? (safeIpv6 || null) : (existingHost?.ipv6 || null);
  const primaryIp = safeIpv4 || safeIp || safeIpv6 || (!hasIp ? String(existingHost?.ip || "") : "");
  return {
    ip: primaryIp || "unknown",
    ipv4: nextIpv4,
    ipv6: nextIpv6,
  };
}

function addDnsWatch(watches: Map<string, AgentDnsWatch>, host: string, scope: string, refId?: number) {
  const value = String(host || "").trim();
  if (!isHostnameAddress(value)) return;
  const key = `${scope}:${refId || 0}:${value.toLowerCase()}`;
  watches.set(key, { host: value, scope, ...(refId ? { refId } : {}) });
}

function parseFailoverTargets(raw: unknown) {
  if (!raw || typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((target) => ({ targetIp: String(target?.targetIp || "").trim(), targetPort: Number(target?.targetPort) }))
      .filter((target) => target.targetIp && target.targetPort >= 1 && target.targetPort <= 65535)
      .slice(0, 10);
  } catch {
    return [];
  }
}

async function resolveTargetIp(raw: string): Promise<string> {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return trimmed;
  if (isIP(trimmed)) return trimmed;
  try {
    const ips = await resolve4(trimmed);
    if (ips.length > 0) return ips[0];
  } catch { /* fall through */ }
  try {
    const ips = await resolve6(trimmed);
    if (ips.length > 0) return ips[0];
  } catch { /* fall through */ }
  return trimmed; // 解析失败返回原值
}

async function resolveTargetIpCached(ruleId: number, raw: string, force = false): Promise<string> {
  const trimmed = String(raw || "").trim();
  if (!trimmed || isIP(trimmed)) return trimmed;
  const now = Date.now();
  const cachedIp = resolvedIpCache.get(ruleId);
  const checkedAt = resolvedIpCheckedAt.get(ruleId) || 0;
  if (!force && cachedIp && cachedIp.raw === trimmed && now - checkedAt < AGENT_DNS_RESOLVE_TTL_MS) return cachedIp.ip;
  const resolved = await resolveTargetIp(trimmed);
  resolvedIpCache.set(ruleId, { raw: trimmed, ip: resolved });
  resolvedIpCheckedAt.set(ruleId, now);
  return resolved;
}

function ensureRuntimeBinaryCmd() {
  const runtime = shQuote(RUNTIME_BIN);
  return `if [ -e ${runtime} ]; then chmod 0755 ${runtime} 2>/dev/null || true; else for bin in /usr/local/bin/gost $(command -v gost 2>/dev/null || true); do [ -n "$bin" ] || continue; [ -x "$bin" ] || continue; install -m 0755 "$bin" ${runtime} && break; done; fi; [ -x ${runtime} ]`;
}

function ensureNginxBinaryCmd() {
  const nginx = shQuote(NGINX_BIN);
  return `if [ -e ${nginx} ]; then chmod 0755 ${nginx} 2>/dev/null || true; else for bin in /usr/sbin/nginx /usr/local/nginx/sbin/nginx $(command -v nginx 2>/dev/null || true); do [ -n "$bin" ] || continue; [ -x "$bin" ] || continue; install -m 0755 "$bin" ${nginx} && break; done; fi; [ -x ${nginx} ]`;
}

export function registerAgentHeartbeatRoute(agentRouter: Router) {
agentRouter.post("/api/agent/heartbeat", async (req: Request, res: Response) => {
  let logHostId = 0;
  let logHostName = "";
  try {
    const token = getResolvedAgentToken(req);
    const host = await getAgentHostFromRequest(req);
    if (!host) {
      const migratedTo = await db.getSetting("migratedToPanelUrl");
      if (migratedTo) {
        res.status(410).json({
          success: false,
          agentUpgrade: { targetVersion: "9999.0.0", panelUrl: migratedTo },
          error: "Panel migrated",
        });
        return;
      }
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    logHostId = Number((host as any).id || 0);
    logHostName = String((host as any).name || "").trim();

    const compactMetrics = Array.isArray(req.body?.m) ? req.body.m : [];
    const busyHeartbeat = req.body?.busy === true || String(req.body?.busy || "").toLowerCase() === "true";
    const heartbeatMetric = (key: string, index: number) => req.body?.[key] ?? compactMetrics[index];
    const cpuUsage = heartbeatMetric("cpuUsage", 0);
    const memoryUsage = heartbeatMetric("memoryUsage", 1);
    const memoryUsed = heartbeatMetric("memoryUsed", 2);
    const memoryTotal = heartbeatMetric("memoryTotal", 3);
    const swapUsage = heartbeatMetric("swapUsage", 4);
    const swapUsed = heartbeatMetric("swapUsed", 5);
    const swapTotal = heartbeatMetric("swapTotal", 6);
    const networkIn = heartbeatMetric("networkIn", 7);
    const networkOut = heartbeatMetric("networkOut", 8);
    const diskUsage = heartbeatMetric("diskUsage", 9);
    const diskUsed = heartbeatMetric("diskUsed", 10);
    const diskTotal = heartbeatMetric("diskTotal", 11);
    const uptime = heartbeatMetric("uptime", 12);
    const { cpuInfo, agentVersion } = req.body;
    const nextCpuInfo = normalizeAgentText(cpuInfo, 256);
    const nextAgentVersion = normalizeAgentText(agentVersion, 64);
    const previousHost = { ...(host as any) };
    const wasOnline = isHostStatusOnline(host);
    const reportedAddress = agentReportedAddress(req.body, host);
    const dnsChangedReports = Array.isArray(req.body?.dnsChanged) ? req.body.dnsChanged : [];
    const agentStateSignatures = normalizeAgentStateSignatures(req.body?.stateSignatures);
    const localRuntimeStateSignature = normalizeRuntimeStateSignature(req.body?.localStateSignature);
    const localRuntimeState = resolveAgentLocalRuntimeState(
      Number(host.id),
      localRuntimeStateSignature,
      normalizeAgentLocalRuntimeState(req.body?.localState),
    );
    const dnsChangedIpByHost = new Map<string, string>();
    const dnsChangedScopes = new Set<string>();
    for (const report of dnsChangedReports) {
      const name = String(report?.host || "").trim().toLowerCase();
      const scope = String(report?.scope || "").trim();
      const refId = Number(report?.refId || 0);
      const nextIps = Array.isArray(report?.new) ? report.new : [];
      const nextIp = nextIps.map((value: unknown) => String(value || "").trim()).find((value: string) => !!value && isIP(value));
      if (name && nextIp) dnsChangedIpByHost.set(name, nextIp);
      if (scope) dnsChangedScopes.add(`${scope}:${Number.isFinite(refId) && refId > 0 ? refId : 0}`);
    }
    const addressChanged = [
      ["ip", reportedAddress.ip],
      ["ipv4", reportedAddress.ipv4],
      ["ipv6", reportedAddress.ipv6],
    ].some(([key, value]) => String(value || "") !== String((host as any)[key as string] || ""));
    const upgradedFirewallCounterAgent = !!nextAgentVersion
      && isAgentVersionAtLeast(nextAgentVersion, AGENT_FIREWALL_COUNTER_REFRESH_VERSION)
      && !isAgentVersionAtLeast(previousHost.agentVersion, AGENT_FIREWALL_COUNTER_REFRESH_VERSION);
    const upgradedProtocolGuardBackendAgent = !!nextAgentVersion
      && isAgentVersionAtLeast(nextAgentVersion, AGENT_PROTOCOL_GUARD_BACKEND_VERSION)
      && !isAgentVersionAtLeast(previousHost.agentVersion, AGENT_PROTOCOL_GUARD_BACKEND_VERSION);
    const effectiveAgentVersion = nextAgentVersion || String((host as any).agentVersion || "");
    const supportsDesiredState = isAgentVersionAtLeast(effectiveAgentVersion, AGENT_DESIRED_STATE_VERSION);

    await db.updateHostHeartbeat(host.id, {
      ip: reportedAddress.ip,
      ipv4: reportedAddress.ipv4,
      ipv6: reportedAddress.ipv6,
      agentVersion: nextAgentVersion || (host as any).agentVersion || null,
      cpuInfo: nextCpuInfo || (host as any).cpuInfo || null,
      memoryTotal: memoryTotal || (host as any).memoryTotal || null,
      ...(addressChanged ? {
        geoCountryCode: null,
        geoCountryName: null,
        geoRegion: null,
        geoEmoji: null,
        geoLatitudeMicro: null,
        geoLongitudeMicro: null,
        geoUpdatedAt: null,
      } : {}),
    } as any);
    Object.assign(host as any, reportedAddress);
    if (!wasOnline) {
      void notifyHostOnlineIfNeeded(host).catch((error) => {
        console.warn(`[HostStatus] Online notify failed host=${host.id}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    if (addressChanged) {
      await handleHostAddressChanged(host.id, host, previousHost, "agent-address-changed");
    }
    if (upgradedFirewallCounterAgent) {
      await db.resetAgentRuntimeStateForHost(host.id);
      clearTunnelRuntimeStatusForHost(host.id);
      await refreshAgentsAffectedByHostAddress(host.id, "agent-firewall-counter-upgrade");
      appendPanelLog("info", `[AgentUpgrade] host=${host.id} agent=${nextAgentVersion} runtime state marked for firewall counter refresh`);
    }
    if (upgradedProtocolGuardBackendAgent) {
      await db.resetAgentRuntimeStateForHost(host.id);
      clearTunnelRuntimeStatusForHost(host.id);
      await refreshAgentsAffectedByHostAddress(host.id, "agent-protocol-guard-backend-upgrade");
      appendPanelLog("info", `[AgentUpgrade] host=${host.id} agent=${nextAgentVersion} runtime state marked for protocol guard backend refresh`);
    }
    if (dnsChangedReports.length > 0) {
      appendPanelLog("info", `[AgentDNS] host=${host.id} reported DNS change for ${dnsChangedReports.length} watched name(s); rule-specific refresh only`);
    }

    await db.insertHostMetric({
      hostId: host.id,
      cpuUsage: cpuUsage ?? null,
      memoryUsage: memoryUsage ?? null,
      memoryUsed: memoryUsed ?? null,
      swapUsage: swapUsage ?? null,
      swapUsed: swapUsed ?? null,
      swapTotal: swapTotal ?? null,
      networkIn: networkIn ?? null,
      networkOut: networkOut ?? null,
      diskUsage: diskUsage ?? null,
      diskUsed: diskUsed ?? null,
      diskTotal: diskTotal ?? null,
      uptime: uptime ?? null,
    });

    if (busyHeartbeat) {
      const panelUrl = await resolveAgentAdvertisedPanelUrl();
      res.json({
        success: true,
        actions: [],
        selfTests: [],
        runningRules: [],
        tunnelProbes: [],
        forwardGroupProbes: [],
        hostProbeServices: [],
        guardRules: [],
        dnsWatch: [],
        lookingGlassTests: [],
        iperf3Tasks: [],
        agentUpgrade: null,
        panelUrl,
        forceTcping: false,
        nextInterval: 5,
        requestLocalState: localRuntimeState.requestLocalState,
        compactReports: true,
      });
      return;
    }

    // 获取该主机的转发规则
    const rules = await db.getForwardRulesForAgent(host.id);
    const hostTunnels = await db.getTunnelsByHost(host.id);
    const forwardProtocolSettings = await getForwardProtocolSettings();
    const actions: any[] = [];
    const dnsWatches = new Map<string, AgentDnsWatch>();
    const responseIssuedAt = Date.now();

    // 获取主机配置的网卡名称（用于 realm --interface）
    const hostInterface = normalizeNetworkInterface((host as any).networkInterface);
    const mimicFiltersByInterface = new Map<string, Set<string>>();
    const addMimicFilter = (filter: string, iface = hostInterface) => {
      const networkInterface = normalizeNetworkInterface(iface);
      const text = String(filter || "").trim();
      if (!networkInterface || !text) return;
      if (!mimicFiltersByInterface.has(networkInterface)) mimicFiltersByInterface.set(networkInterface, new Set());
      mimicFiltersByInterface.get(networkInterface)!.add(text);
    };
    const dnsChangedKey = (scope: string, refId: unknown) => `${scope}:${Number(refId) || 0}`;
    const dnsChangedFor = (scope: string, refId: unknown) => dnsChangedScopes.has(dnsChangedKey(scope, refId));
    const dnsRuntimeGeneration = (scope: string, refId: unknown) => {
      const key = dnsChangedKey(scope, refId);
      if (!dnsChangedScopes.has(key)) return 0;
      const next = (dnsRuntimeGenerationByKey.get(key) || 0) + 1;
      dnsRuntimeGenerationByKey.set(key, next);
      return next;
    };
    const buildMimicRuntimeSyncCmds = () => {
      if (!hostInterface) return [];
      const cmds: string[] = [];
      const activeIfaces = Array.from(mimicFiltersByInterface.keys()).sort();
      const knownIfaces = new Set([hostInterface, ...activeIfaces]);
      for (const networkInterface of Array.from(knownIfaces).sort()) {
        const filters = Array.from(mimicFiltersByInterface.get(networkInterface) || []).sort();
        const configPath = `${MIMIC_CONFIG_DIR}/${networkInterface}.conf`;
        const serviceName = `mimic@${networkInterface}`;
        if (filters.length === 0) {
          cmds.push(stopManagedServiceCmd(serviceName));
          cmds.push(`rm -f ${shQuote(configPath)} ${shQuote(configPath)}.sha256 2>/dev/null || true`);
          continue;
        }
        const config = [
          "log.verbosity = info",
          "xdp_mode = skb",
          ...filters.map((filter) => `filter = ${filter}`),
          "",
        ].join("\n");
        const encodedConfig = Buffer.from(config, "utf8").toString("base64");
        cmds.push(
          `if ! command -v mimic >/dev/null 2>&1; then echo "[mimic] mimic is not installed; install mimic and mimic-dkms to use UDP camouflage"; exit 1; fi`,
          `mkdir -p ${shQuote(MIMIC_CONFIG_DIR)}`,
          `printf '%s' '${encodedConfig}' | base64 -d > ${shQuote(configPath)}`,
          `modprobe mimic 2>/dev/null || true`,
          restartManagedServiceIfConfigChangedCmd(serviceName, configPath),
        );
      }
      return cmds;
    };

    /** 包装一条只追加一次的 iptables 规则：先 -C 检查是否存在，不存在才 -A */
    /**
     * 为转发规则创建一对 mangle 计数链以跨转发方式采集准确流量。
     * - FWX_IN_<port>：匹配 dport=<port> 的入站包（客户端→Agent）
     * - FWX_OUT_<port>：匹配 sport=<port> 的出站包（Agent→客户端响应）
     * 不设 RETURN，所以只作计数不影响路由。三种转发方式都会经过 mangle 表，覆盖 100% 路径。
     */
    const gostServiceName = RUNTIME_SERVICE_NAME;
    const gostServiceUnit = [
      "[Unit]",
      "Description=ForwardX unified runtime forwarder",
      "After=network.target",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${RUNTIME_BIN} -C ${RUNTIME_CONFIG_PATH}`,
      "Restart=always",
      "RestartSec=5",
      "LimitNOFILE=65535",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ].join("\n");
    const agentHostRules = rules as any[];
    // DNS 预解析：将域名转换为 IP，缓存中比较检测变更
    const dnsChangedRuleIds = new Set<number>();
    const dnsPreviousIpByRuleId = new Map<number, string>();
    for (const rule of agentHostRules as any[]) {
      if (!rule.targetIp) continue;
      addDnsWatch(dnsWatches, rule.targetIp, "forward-rule-target", Number(rule.id));
      const rawTargetIp = String(rule.targetIp || "").trim();
      const forcedResolved = dnsChangedIpByHost.get(rawTargetIp.toLowerCase());
      const resolved = forcedResolved || await resolveTargetIpCached(Number(rule.id), rawTargetIp);
      if (forcedResolved) resolvedIpCheckedAt.set(Number(rule.id), Date.now());
      const cachedIp = resolvedIpCache.get(rule.id);
      if (dnsChangedFor("forward-rule-target", Number(rule.id)) && cachedIp && cachedIp.raw === rawTargetIp && cachedIp.ip !== resolved) {
        // IP 变更：标记为需要重新下发
        dnsChangedRuleIds.add(rule.id);
        dnsPreviousIpByRuleId.set(rule.id, cachedIp.ip);
      }
      resolvedIpCache.set(rule.id, { raw: rawTargetIp, ip: resolved });
      // 保存原始值（域名），将 rule.targetIp 替换为解析后的 IP
      (rule as any)._originalTargetIp = rule.targetIp;
      rule.targetIp = resolved;
    }

    // DNS 变更的规则：生成清理旧 IP 规则的动作
    const buildForwardTargetCleanup = (rule: any, targetIp: string, targetPort: number): string[] => {
      const port = rule.sourcePort;
      const cleanupRule = { ...rule, targetIp, targetPort };
      const cmds: string[] = [];
      if (rule.forwardType === "iptables") {
        cmds.push(...buildIptablesForwardCleanupCmds(cleanupRule));
      } else if (rule.forwardType === "nftables") {
        cmds.push(...buildNftCleanupCmds(cleanupRule));
      } else {
        cmds.push(...buildManagedPortCleanupCmds(Number(port), targetIp, targetPort, rule.protocol));
      }
      if (rule.forwardType === "iptables") cmds.push(...buildCountingCleanupCmds(port, targetIp, targetPort, rule.protocol));
      return cmds;
    };
    const buildDnsChangeCleanup = (rule: any, oldIp: string): string[] => (
      buildForwardTargetCleanup(rule, oldIp, Number(rule.targetPort) || 0)
    );
    const failoverProxyHandlesTargetDns = (rule: any) => (
      !!rule?.failoverEnabled
      && rule.forwardType === "gost"
      && normalizeForwardRuleProtocol(rule.protocol) === "tcp"
      && parseFailoverTargets(rule.failoverTargets).length > 0
    );
    const chainMemberAddress = (member: any, hostLike: any) => {
      const configured = String(member?.connectHost || "").trim();
      if (configured) {
        addDnsWatch(dnsWatches, configured, "forward-chain-member", Number(member?.id || 0));
        return configured;
      }
      const value = hostIngressAddress(hostLike);
      addDnsWatch(dnsWatches, value, "host-entry", Number(hostLike?.id || member?.hostId || 0));
      return value;
    };
    const forwardChainHostById = new Map<number, any>();
    const forwardChainGroupById = new Map<number, any>();
    const getForwardChainHost = async (hostId: number) => {
      const id = Number(hostId);
      if (!Number.isFinite(id) || id <= 0) return null;
      if (forwardChainHostById.has(id)) return forwardChainHostById.get(id);
      const nextHost = await db.getHostById(id);
      forwardChainHostById.set(id, nextHost || null);
      return nextHost || null;
    };
    const getForwardChainGroup = async (groupId: number) => {
      const id = Number(groupId);
      if (!Number.isFinite(id) || id <= 0) return null;
      if (forwardChainGroupById.has(id)) return forwardChainGroupById.get(id);
      const group = await db.getForwardGroupById(id);
      forwardChainGroupById.set(id, group || null);
      return group || null;
    };
    const resolveForwardChainTarget = async (rule: any) => {
      const groupId = Number(rule?.forwardGroupId || 0);
      const memberId = Number(rule?.forwardGroupMemberId || 0);
      if (!groupId || !memberId) return null;
      const group = await getForwardChainGroup(groupId);
      if (String((group as any)?.groupMode || "") !== "chain") return null;
      const members = [...(((group as any).members || []) as any[])]
        .filter((member: any) => !!member.isEnabled)
        .sort((a: any, b: any) => Number(a.priority) - Number(b.priority));
      const memberIdx = members.findIndex((member: any) => Number(member.id) === memberId);
      if (memberIdx < 0) return null;
      const currentMember = members[memberIdx] as any;
      if (memberIdx === 0 && Number(rule.hostId || 0) !== Number(currentMember.hostId || 0)) {
        const entryGroupId = Number((group as any)?.entryGroupId || 0);
        if (!entryGroupId) return null;
        const entryGroup = await getForwardChainGroup(entryGroupId);
        const isEntryGroupHost = !!entryGroup
          && !!(entryGroup as any).isEnabled
          && String((entryGroup as any).groupMode || "") === "entry"
          && (((entryGroup as any).members || []) as any[]).some((member: any) => (
            member
            && member.isEnabled !== false
            && member.memberType === "host"
            && Number(member.hostId || 0) === Number(rule.hostId || 0)
          ));
        if (!isEntryGroupHost) return null;
        const firstHost = await getForwardChainHost(Number(currentMember.hostId));
        const targetIp = chainMemberAddress(currentMember, firstHost);
        const targetPort = Number(rule.sourcePort) || 0;
        if (!targetIp || targetPort <= 0) return null;
        const forcedResolved = dnsChangedIpByHost.get(String(targetIp).toLowerCase());
        const resolvedTargetIp = forcedResolved || await resolveTargetIpCached(Number(rule.id), targetIp);
        if (forcedResolved) resolvedIpCheckedAt.set(Number(rule.id), Date.now());
        resolvedIpCache.set(Number(rule.id), { raw: targetIp, ip: resolvedTargetIp });
        return { targetIp: resolvedTargetIp, targetPort, originalTargetIp: targetIp };
      }
      if (memberIdx >= members.length - 1) return null;
      if (Number(rule.hostId || 0) !== Number(currentMember.hostId || 0)) return null;
      const nextMember = members[memberIdx + 1] as any;
      if (nextMember.memberType !== "host") return null;
      const nextHost = await getForwardChainHost(Number(nextMember.hostId));
      const targetIp = chainMemberAddress(nextMember, nextHost);
      const targetPort = Number(rule.sourcePort) || 0;
      if (!targetIp || targetPort <= 0) return null;
      const forcedResolved = dnsChangedIpByHost.get(String(targetIp).toLowerCase());
      const resolvedTargetIp = forcedResolved || await resolveTargetIpCached(Number(rule.id), targetIp);
      if (forcedResolved) resolvedIpCheckedAt.set(Number(rule.id), Date.now());
      resolvedIpCache.set(Number(rule.id), { raw: targetIp, ip: resolvedTargetIp });
      return { targetIp: resolvedTargetIp, targetPort, originalTargetIp: targetIp };
    };

    // 对 DNS 变更且正在运行的规则，先生成清理动作，再通过 isRunning=false 触发重新下发
    for (const rule of agentHostRules as any[]) {
      if (!dnsChangedRuleIds.has(rule.id)) continue;
      if (!rule.isEnabled || !rule.isRunning) continue;
      if (failoverProxyHandlesTargetDns(rule)) {
        console.log(`[DNS] rule=${rule.id} target changed; failover proxy will resolve ${rule._originalTargetIp || rule.targetIp} without service reload`);
        continue;
      }
      const oldIp = dnsPreviousIpByRuleId.get(rule.id) || rule._originalTargetIp || rule.targetIp;
      const ruleResolvedIp = rule.targetIp; // 已经是新解析的 IP
      const cleanupCmds = buildDnsChangeCleanup(rule, oldIp);
      if (cleanupCmds.length > 0) {
        actions.push({
          ruleId: rule.id,
          op: "remove",
          forwardType: rule.forwardType,
          sourcePort: rule.sourcePort,
          targetIp: ruleResolvedIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
          networkInterface: hostInterface,
          commands: cleanupCmds,
        } as any);
      }
      // 重置 isRunning 让主循环生成 apply 动作
      rule.isRunning = false;
      console.log(`[DNS] rule=${rule.id} target changed: ${oldIp} → ${ruleResolvedIp}, re-applying`);
    }

    const chainTargetsByRuleId = new Map<number, { targetIp: string; targetPort: number; originalTargetIp?: string }>();
    for (const rule of agentHostRules as any[]) {
      const chainTarget = await resolveForwardChainTarget(rule);
      if (!chainTarget) continue;
      const oldTargetIp = String(rule.targetIp || "").trim();
      const oldTargetPort = Number(rule.targetPort) || 0;
      chainTargetsByRuleId.set(Number(rule.id), chainTarget);
      if (oldTargetIp === chainTarget.targetIp && oldTargetPort === chainTarget.targetPort) continue;
      if (rule.isEnabled && rule.isRunning) {
        actions.push({
          ruleId: rule.id,
          op: "remove",
          forwardType: rule.forwardType,
          sourcePort: rule.sourcePort,
          targetIp: oldTargetIp,
          targetPort: oldTargetPort,
          protocol: rule.protocol,
          networkInterface: hostInterface,
          commands: buildForwardTargetCleanup(rule, oldTargetIp, oldTargetPort),
        } as any);
        rule.isRunning = false;
      }
      rule.targetIp = chainTarget.targetIp;
      rule.targetPort = chainTarget.targetPort;
      (rule as any)._originalTargetIp = chainTarget.originalTargetIp || chainTarget.targetIp;
      await db.updateForwardRule(Number(rule.id), {
        targetIp: chainTarget.originalTargetIp || chainTarget.targetIp,
        targetPort: chainTarget.targetPort,
        isRunning: false,
      } as any);
      appendPanelLog("info", `[ForwardChain] rule=${rule.id} target=${chainTarget.targetIp}:${chainTarget.targetPort}${chainTarget.originalTargetIp && chainTarget.originalTargetIp !== chainTarget.targetIp ? ` resolvedFrom=${chainTarget.originalTargetIp}` : ""} source=chain-config`);
    }
    for (const rule of rules as any[]) {
      const chainTarget = chainTargetsByRuleId.get(Number(rule.id));
      if (!chainTarget) continue;
      rule.targetIp = chainTarget.targetIp;
      rule.targetPort = chainTarget.targetPort;
      (rule as any)._originalTargetIp = chainTarget.originalTargetIp || chainTarget.targetIp;
      if ((agentHostRules as any[]).some((item: any) => Number(item.id) === Number(rule.id) && !item.isRunning)) {
        rule.isRunning = false;
      }
    }

    const agentAllRules = await db.getForwardRulesForAgent(undefined);
    const hydrateRuntimeTarget = async (rule: any) => {
      if (!rule || !rule.targetIp) return;
      if (!(rule as any)._originalTargetIp) {
        (rule as any)._originalTargetIp = rule.targetIp;
      }
      const rawTargetIp = String((rule as any)._originalTargetIp || rule.targetIp || "").trim();
      if (!rawTargetIp) return;
      const forcedResolved = dnsChangedIpByHost.get(rawTargetIp.toLowerCase());
      const resolved = forcedResolved || await resolveTargetIpCached(Number(rule.id), rawTargetIp);
      if (forcedResolved) resolvedIpCheckedAt.set(Number(rule.id), Date.now());
      rule.targetIp = resolved;
    };
    await Promise.all((agentAllRules as any[]).map((rule: any) => hydrateRuntimeTarget(rule)));
    const tunnelById = new Map((hostTunnels as any[]).map((t: any) => [t.id, t]));
    const tunnelHopsByTunnelId = new Map<number, any[]>();
    const tunnelExitNodesByTunnelId = new Map<number, any[]>();
    await Promise.all((hostTunnels as any[]).map(async (tunnel: any) => {
      const hops = await hopRepo.getTunnelHops(Number(tunnel.id));
      if (Array.isArray(hops) && hops.length >= 2) {
        tunnelHopsByTunnelId.set(Number(tunnel.id), hops);
      }
      const exits = await hopRepo.getTunnelExitNodes(Number(tunnel.id));
      if (Array.isArray(exits) && exits.length > 0) {
        tunnelExitNodesByTunnelId.set(Number(tunnel.id), exits);
      }
    }));
    const tunnelDnsRefreshByTunnelId = new Map<number, number>();
    const markTunnelDnsRefresh = (tunnelId: unknown, generation: number) => {
      const id = Number(tunnelId) || 0;
      if (id <= 0 || generation <= 0) return;
      tunnelDnsRefreshByTunnelId.set(id, Math.max(tunnelDnsRefreshByTunnelId.get(id) || 0, generation));
    };
    for (const tunnel of hostTunnels as any[]) {
      markTunnelDnsRefresh(Number(tunnel?.id || 0), dnsRuntimeGeneration("tunnel-connect", Number(tunnel?.id || 0)));
      for (const hop of tunnelHopsByTunnelId.get(Number(tunnel?.id || 0)) || []) {
        markTunnelDnsRefresh(Number(tunnel?.id || 0), dnsRuntimeGeneration("tunnel-hop-connect", Number((hop as any)?.id || 0)));
      }
      for (const node of tunnelExitNodesByTunnelId.get(Number(tunnel?.id || 0)) || []) {
        markTunnelDnsRefresh(Number(tunnel?.id || 0), dnsRuntimeGeneration("tunnel-exit-connect", Number((node as any)?.id || 0)));
      }
    }
    const tunnelDnsGeneration = (tunnel: any) => tunnelDnsRefreshByTunnelId.get(Number(tunnel?.id || 0)) || 0;
    const anyTunnelDnsRefresh = (tunnels: any[]) => tunnels.some((tunnel) => tunnelDnsGeneration(tunnel) > 0);
    const dnsRuntimeRefreshToken = dnsChangedReports.length > 0
      ? `${responseIssuedAt}:${Array.from(dnsChangedScopes).sort().join(",") || Array.from(dnsChangedIpByHost.keys()).sort().join(",")}`
      : "";
    const dnsRuntimeRefreshCmd = (label: string) => (
      dnsRuntimeRefreshToken ? `echo ${shQuote(`[dns] ${label} refresh ${dnsRuntimeRefreshToken}`)}` : ""
    );
    const tunnelRuntimeGenerationCmd = () => {
      const tokens = (hostTunnels as any[])
        .map((tunnel: any) => {
          const tunnelId = Number(tunnel?.id || 0);
          const generation = getTunnelRuntimeGeneration(tunnelId);
          return tunnelId > 0 && generation > 0 ? `${tunnelId}:${generation}` : "";
        })
        .filter(Boolean)
        .sort()
        .join(",");
      return tokens ? `echo ${shQuote(`[runtime] tunnel generation ${tokens}`)}` : "";
    };
    const tunnelEntryHostIdsByTunnelId = new Map<number, number[]>();
    await Promise.all((hostTunnels as any[]).map(async (tunnel: any) => {
      const entryHostIds = new Set<number>();
      const primaryEntryHostId = Number(tunnel?.entryHostId || 0);
      if (Number.isFinite(primaryEntryHostId) && primaryEntryHostId > 0) entryHostIds.add(primaryEntryHostId);
      const entryGroupId = Number(tunnel?.entryGroupId || 0);
      if (entryGroupId > 0) {
        const entryGroup = await db.getForwardGroupById(entryGroupId) as any;
        if (entryGroup && entryGroup.isEnabled && String(entryGroup.groupMode || "") === "entry") {
          for (const member of entryGroup.members || []) {
            if (!member || member.isEnabled === false || member.memberType !== "host") continue;
            const memberHostId = Number(member.hostId || 0);
            if (Number.isFinite(memberHostId) && memberHostId > 0) entryHostIds.add(memberHostId);
          }
        }
      }
      tunnelEntryHostIdsByTunnelId.set(Number(tunnel.id), Array.from(entryHostIds));
    }));
    const tunnelEntryHostIds = (tunnel: any) => {
      const tunnelId = Number(tunnel?.id || 0);
      const cached = tunnelEntryHostIdsByTunnelId.get(tunnelId);
      if (cached && cached.length > 0) return cached;
      const entryHostId = Number(tunnel?.entryHostId || 0);
      return Number.isFinite(entryHostId) && entryHostId > 0 ? [entryHostId] : [];
    };
    const isCurrentHostTunnelEntry = (tunnel: any) => tunnelEntryHostIds(tunnel).includes(Number(host.id));
    const allTunnelRuleIds = agentAllRules
      .filter((rule: any) => rule && rule.forwardType === "gost" && Number(rule.tunnelId || 0) > 0)
      .map((rule: any) => Number(rule.id))
      .filter((id: number) => Number.isFinite(id) && id > 0);
    const allTunnelRuleExitRows = await db.getForwardRuleTunnelExitsByRuleIds(allTunnelRuleIds);
    const tunnelExitRowsByRuleId = new Map<number, any[]>();
    for (const row of allTunnelRuleExitRows as any[]) {
      const ruleId = Number(row.ruleId);
      const rows = tunnelExitRowsByRuleId.get(ruleId) || [];
      rows.push(row);
      tunnelExitRowsByRuleId.set(ruleId, rows);
    }
    const tunnelNeedsMimic = (tunnel: any) => {
      if (!tunnel || !isForwardXTunnel(tunnel) || !tunnel.isEnabled || !isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)) return false;
      return (agentAllRules as any[]).some((rule: any) => {
        if (!rule || rule.pendingDelete || !rule.isEnabled || rule.forwardType !== "gost") return false;
        if (Number(rule.tunnelId || 0) !== Number(tunnel.id || 0)) return false;
        return udpOverTcpEnabled(rule, tunnel) && isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel);
      });
    };
    const tunnelExitRowsMatchNodes = (rows: any[], nodes: any[]) => {
      const enabledNodes = nodes
        .filter((node: any) => node && node.isEnabled !== false)
        .map((node: any) => ({
          id: Number(node.id),
          seq: Number(node.seq),
          hostId: Number(node.hostId),
        }))
        .filter((node: any) => node.id > 0 && node.hostId > 0);
      if (rows.length !== enabledNodes.length) return false;
      const rowByNodeId = new Map(rows.map((row: any) => [Number(row.exitNodeId), row]));
      return enabledNodes.every((node: any) => {
        const row = rowByNodeId.get(node.id);
        return !!row
          && Number(row.exitSeq) === node.seq
          && Number(row.exitHostId) === node.hostId
          && Number(row.tunnelExitPort) > 0;
      });
    };
    for (const rule of agentAllRules as any[]) {
      if (!rule || rule.forwardType !== "gost" || !rule.tunnelId || rule.pendingDelete) continue;
      const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
      if (!tunnel || String(tunnel?.mode || "").toLowerCase() === "forwardx" || !(tunnel as any).loadBalanceEnabled) continue;
      const extraNodes = tunnelExitNodesByTunnelId.get(Number(tunnel.id)) || [];
      const rows = tunnelExitRowsByRuleId.get(Number(rule.id)) || [];
      if (!tunnelExitRowsMatchNodes(rows, extraNodes)) {
        const nextRows = await db.reconcileForwardRuleTunnelExits(rule, tunnel);
        tunnelExitRowsByRuleId.set(Number(rule.id), nextRows as any[]);
      }
    }
    // realm/socat/gost 进程命令使用原始 targetIp（域名形式），以便工具自身解析 DNS，
    // iptables/nftables/计数链使用已解析的 IP（rule.targetIp 已被替换为解析后的值）。
    const processTarget = (rule: any) => (rule as any)._originalTargetIp || rule.targetIp;
    const proxyDebugBool = (value: unknown) => value ? "true" : "false";
    const buildProxyRuleDebugCmd = (label: string, rule: any, extra: Record<string, unknown> = {}) => {
      const fields: Record<string, unknown> = {
        rule: Number(rule?.id || 0),
        host: Number(host.id),
        tunnel: Number(rule?.tunnelId || 0),
        source: Number(rule?.sourcePort || 0),
        ruleTargetRaw: String((rule as any)?._originalTargetIp || rule?.targetIp || ""),
        ruleTargetRuntime: String(rule?.targetIp || ""),
        runtimeTarget: `${processTarget(rule)}:${Number(rule?.targetPort || 0)}`,
        protocol: String(rule?.protocol || ""),
        proxyVersion: proxyProtocolVersion(rule),
        entryReceive: proxyDebugBool(proxyProtocolEnabled(rule, "entryReceive")),
        entrySend: proxyDebugBool(proxyProtocolEnabled(rule, "entrySend")),
        exitReceive: proxyDebugBool(proxyProtocolEnabled(rule, "exitReceive")),
        exitSend: proxyDebugBool(proxyProtocolEnabled(rule, "exitSend")),
        ...extra,
      };
      const text = Object.entries(fields)
        .map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, " ")}`)
        .join(" ");
      return `echo ${shQuote(`proxy-rule-debug ${label} ${text}`)}`;
    };
    const gostRules = agentHostRules
      .filter((r: any) => {
        if (r.pendingDelete || !r.isEnabled || r.forwardType !== "gost") return false;
        const tunnel = (r as any).tunnelId ? tunnelById.get((r as any).tunnelId) as any : null;
        if (tunnel && isNginxTunnelMode(tunnel)) return false;
        return isRuleProtocolEnabled(forwardProtocolSettings, r, tunnel);
      });
    const gostRuleUserIds = Array.from(new Set(agentHostRules.map((r: any) => Number(r.userId)).filter((id: number) => Number.isFinite(id) && id > 0))) as number[];
    const gostUsers = await Promise.all(gostRuleUserIds.map((id) => db.getUserById(id)));
    const gostUserById = new Map(gostUsers.filter(Boolean).map((u: any) => [u.id, u]));
    const gostRateLimiters: any[] = [];
    const gostRateLimiterNames = new Set<string>();
    const ensureGostLimiter = (name: string, mbps: number) => {
      const bytesPerSecond = mbpsToBytesPerSecond(mbps);
      if (bytesPerSecond <= 0 || gostRateLimiterNames.has(name)) return;
      gostRateLimiterNames.add(name);
      gostRateLimiters.push({
        name,
        limits: [`$ ${bytesPerSecond}B ${bytesPerSecond}B`],
      });
    };
    const applyGostLimiter = (service: any, userId: number, tunnel?: any | null) => {
      const user = gostUserById.get(userId) as any;
      const mbps = effectiveTunnelRateLimitMbps(user, tunnel);
      if (mbps > 0) {
        const tunnelId = Number(tunnel?.id || 0);
        const name = tunnelId > 0 ? `fwx-user-${userId}-tunnel-${tunnelId}-${mbps}` : `fwx-user-${userId}-${mbps}`;
        ensureGostLimiter(name, mbps);
        service.limiter = name;
      }
      return service;
    };
    const userRateLimits = (userId: number, tunnel?: any | null) => {
      const user = gostUserById.get(userId) as any;
      const bytesPerSecond = mbpsToBytesPerSecond(effectiveTunnelRateLimitMbps(user, tunnel));
      return {
        limitIn: bytesPerSecond,
        limitOut: bytesPerSecond,
      };
    };
    const userAccessLimits = (userId: number) => {
      const user = gostUserById.get(userId) as any;
      return {
        maxConnections: Math.max(0, Number(user?.maxConnections) || 0),
        maxIPs: Math.max(0, Number(user?.maxIPs) || 0),
      };
    };
    type AccessLimitBinary = "iptables" | "ip6tables";
    const accessLimitBinaries: AccessLimitBinary[] = ["iptables", "ip6tables"];
    const accessLimitCommand = (binary: AccessLimitBinary, command: string) => (
      binary === "ip6tables"
        ? `if command -v ip6tables >/dev/null 2>&1; then ${command}; fi; true`
        : `${command}; true`
    );
    const accessLimitDeleteJump = (binary: AccessLimitBinary, chainName: string, port: number, scopeChain: string) => (
      accessLimitCommand(binary, `while ${binary} -C ${chainName} -p tcp --dport ${port} -j ${scopeChain} 2>/dev/null; do if ${binary} -D ${chainName} -p tcp --dport ${port} -j ${scopeChain} 2>/dev/null; then :; else break; fi; done`)
    );
    const accessLimitEnsureJump = (binary: AccessLimitBinary, chainName: string, port: number, scopeChain: string) => (
      accessLimitCommand(binary, `if ${binary} -C ${chainName} -p tcp --dport ${port} -j ${scopeChain} 2>/dev/null; then :; else ${binary} -I ${chainName} -p tcp --dport ${port} -j ${scopeChain}; fi`)
    );
    const accessLimitOptional = (binary: AccessLimitBinary, command: string) => accessLimitCommand(binary, `${command} 2>/dev/null`);
    const accessScopeName = (scope: string) => `FWX_LIMIT_${scope.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40)}`;
    const buildAccessLimitCleanupCmds = (port: number, scope: string): string[] => {
      const chain = accessScopeName(scope);
      const cmds: string[] = [];
      for (const binary of accessLimitBinaries) {
        cmds.push(
          accessLimitDeleteJump(binary, "INPUT", port, chain),
          accessLimitDeleteJump(binary, "FORWARD", port, chain),
        );
      }
      return cmds;
    };
    const buildAccessLimitCmds = (port: number, scope: string, limits: { maxConnections?: number; maxIPs?: number }): string[] => {
      const maxConnections = Math.max(0, Number(limits.maxConnections || 0));
      const maxIPs = Math.max(0, Number(limits.maxIPs || 0));
      if (maxConnections <= 0 && maxIPs <= 0) return buildAccessLimitCleanupCmds(port, scope);
      const chain = accessScopeName(scope);
      const cmds = buildAccessLimitCleanupCmds(port, scope);
      for (const binary of accessLimitBinaries) {
        const mask = binary === "ip6tables" ? 128 : 32;
        cmds.push(
          accessLimitOptional(binary, `${binary} -N ${chain}`),
          accessLimitOptional(binary, `${binary} -F ${chain}`),
        );
        if (maxConnections > 0) {
          cmds.push(accessLimitCommand(binary, `${binary} -A ${chain} -p tcp -m connlimit --connlimit-above ${maxConnections} --connlimit-mask 0 -j REJECT --reject-with tcp-reset`));
        }
        if (maxIPs > 0) {
          cmds.push(accessLimitCommand(binary, `${binary} -A ${chain} -p tcp -m connlimit --connlimit-above ${maxIPs} --connlimit-mask ${mask} -j REJECT --reject-with tcp-reset`));
        }
        cmds.push(
          accessLimitCommand(binary, `${binary} -A ${chain} -j RETURN`),
          accessLimitEnsureJump(binary, "INPUT", port, chain),
          accessLimitEnsureJump(binary, "FORWARD", port, chain),
        );
      }
      return cmds;
    };
    const accessScopeForRule = (rule: any) => (
      rule.tunnelId
        ? `u${Number(rule.userId) || 0}_t${Number(rule.tunnelId) || 0}`
        : `u${Number(rule.userId) || 0}_h${host.id}`
    );
    const buildRuleAccessLimitCmds = (rule: any): string[] => (
      rule.tunnelId
        ? buildAccessLimitCmds(rule.sourcePort, accessScopeForRule(rule), userAccessLimits(Number(rule.userId)))
        : buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule))
    );
    const failoverProxyPort = (rule: any) => 41000 + (Number(rule?.id) % 20000);
    const actionFailover = (rule: any, options?: { listenPort?: number; bindAddress?: string }) => {
      if (!rule || !rule.failoverEnabled) return undefined;
      if (rule.forwardType !== "gost") return undefined;
      if (!rule.tunnelId) {
        const owner = gostUserById.get(Number(rule.userId)) as any;
        if (owner?.role !== "admin") return undefined;
      }
      if (rule.protocol !== "tcp") return undefined;
      const backupTargets = parseFailoverTargets(rule.failoverTargets);
      if (backupTargets.length === 0) return undefined;
      return {
        enabled: true,
        listenPort: Number(options?.listenPort || rule.sourcePort || 0),
        bindAddress: options?.bindAddress || "127.0.0.1",
        protocol: rule.protocol || "tcp",
        strategy: ["round_robin", "random", "ip_hash", "fallback"].includes(String(rule.failoverStrategy || ""))
          ? String(rule.failoverStrategy)
          : "fallback",
        targets: [
          { targetIp: processTarget(rule), targetPort: Number(rule.targetPort) },
          ...backupTargets,
        ],
        failoverSeconds: Number(rule.failoverSeconds || 60),
        recoverSeconds: Number(rule.recoverSeconds || 120),
        autoFailback: rule.autoFailback !== false,
      };
    };
    const failoverTargetAddr = (rule: any) => {
      const failover = actionFailover(rule, { listenPort: failoverProxyPort(rule), bindAddress: "127.0.0.1" });
      return failover ? endpointHostPort("127.0.0.1", failover.listenPort) : endpointHostPort(processTarget(rule), rule.targetPort);
    };
    const failoverTargetEndpoint = (rule: any) => {
      const failover = actionFailover(rule, { listenPort: failoverProxyPort(rule), bindAddress: "127.0.0.1" });
      return failover
        ? { targetIp: "127.0.0.1", targetPort: Number(failover.listenPort) }
        : { targetIp: processTarget(rule), targetPort: Number(rule.targetPort) };
    };
    const failoverForCurrentHost = (rule: any, tunnel?: any | null, options?: { listenPort?: number }) => {
      if (!rule?.failoverEnabled) return undefined;
      const listenPort = Number(options?.listenPort || failoverProxyPort(rule));
      if (!tunnel) return actionFailover(rule, { listenPort, bindAddress: "127.0.0.1" });
      if (isForwardXTunnel(tunnel) && isCurrentHostTunnelEntry(tunnel)) {
        return actionFailover(rule, { listenPort, bindAddress: "127.0.0.1" });
      }
      if (isGostTunnelMode(tunnel) && Number(tunnel.exitHostId) === Number(host.id)) {
        return actionFailover(rule, { listenPort, bindAddress: "127.0.0.1" });
      }
      return undefined;
    };
    const tunnelProtocolType = (mode: string) => {
      if (mode === "wss" || mode === "mwss") return "ws";
      if (mode === "tcp" || mode === "mtcp") return "tcp";
      return "tls";
    };
    const tunnelProtocolMetadata = (mode: string) => (
      mode === "mtls" || mode === "mwss" || mode === "mtcp"
        ? { mux: "true" }
        : undefined
    );
    const tunnelDialerMetadata = (mode: string) => tunnelProtocolMetadata(mode);
    const proxyProtocolEnabled = (rule: any, direction: "receive" | "send" | "entryReceive" | "entrySend" | "exitReceive" | "exitSend") => {
      if (!isForwardRuleProtocolTcpEnabled(rule?.protocol)) return false;
      if (direction === "receive" || direction === "entryReceive") return !!(rule as any).proxyProtocolReceive;
      if (direction === "send" || direction === "entrySend") return !!(rule as any).proxyProtocolSend;
      if (direction === "exitReceive") return !!(rule as any).proxyProtocolExitReceive;
      return !!(rule as any).proxyProtocolExitSend;
    };
    const proxyProtocolVersion = (rule: any) => Number((rule as any)?.proxyProtocolVersion) === 2 ? 2 : 1;
    const maybeProxyProtocolMetadata = (rule: any, direction: "receive" | "send" | "entryReceive" | "entrySend" | "exitReceive" | "exitSend") => (
      proxyProtocolEnabled(rule, direction) ? { proxyProtocol: proxyProtocolVersion(rule) } : undefined
    );
    const mergeMetadata = (...items: Array<Record<string, unknown> | undefined>) => {
      const merged = Object.assign({}, ...items.filter(Boolean));
      return Object.keys(merged).length > 0 ? merged : undefined;
    };
    const isForwardXTunnel = isForwardXTunnelMode;
    const tunnelForwardProtos = (protocol: string) => forwardRuleProtocols(protocol);
    const hostPublicAddress = (hostLike: any) => {
      const value = hostIngressAddress(hostLike);
      addDnsWatch(dnsWatches, value, "host-entry", Number(hostLike?.id || 0));
      return value;
    };
    const tunnelExitHostAddress = async (tunnel: any) => {
      const connectHost = String(tunnel?.connectHost || "").trim();
      if (connectHost) {
        addDnsWatch(dnsWatches, connectHost, "tunnel-connect", Number(tunnel?.id || 0));
        return connectHost;
      }
      const exit = await db.getHostById(tunnel.exitHostId);
      if (!exit) return "";
      return hostPublicAddress(exit);
    };
    const tunnelExitEndpointById = new Map<number, { host: string; port: number }>();
    const hostIngressAddressById = new Map<number, string>();
    const getHostIngressAddress = async (hostId: number) => {
      const id = Number(hostId);
      if (!Number.isFinite(id) || id <= 0) return "";
      const cached = hostIngressAddressById.get(id);
      if (cached !== undefined) return cached;
      const hopHost = await db.getHostById(id) as any;
      const addr = hopHost ? hostPublicAddress(hopHost) : "";
      hostIngressAddressById.set(id, addr);
      return addr;
    };
    const getHopDialAddress = async (hop: any) => {
      const configured = String((hop as any)?.connectHost || "").trim();
      if (configured) {
        addDnsWatch(dnsWatches, configured, "tunnel-hop-connect", Number((hop as any)?.id || 0));
        return configured;
      }
      return getHostIngressAddress(Number((hop as any)?.hostId));
    };
    const getExtraExitDialAddress = async (exitNode: any) => {
      const configured = String((exitNode as any)?.connectHost || "").trim();
      if (configured) {
        addDnsWatch(dnsWatches, configured, "tunnel-exit-connect", Number((exitNode as any)?.id || 0));
        return configured;
      }
      return getHostIngressAddress(Number((exitNode as any)?.hostId));
    };
    const tunnelRuleExitMappings = (rule: any) => {
      const rows = tunnelExitRowsByRuleId.get(Number(rule?.id || 0)) || [];
      return rows
        .map((row: any) => ({
          exitNodeId: Number(row.exitNodeId),
          exitSeq: Number(row.exitSeq),
          exitHostId: Number(row.exitHostId),
          tunnelExitPort: Number(row.tunnelExitPort),
        }))
        .filter((row) => row.exitHostId > 0)
        .sort((a, b) => a.exitSeq - b.exitSeq);
    };
    const primaryManagedTunnelRuleIdByTunnelId = new Map<number, number>();
    for (const rule of agentAllRules as any[]) {
      const tunnelId = Number((rule as any)?.tunnelId || 0);
      if (!rule || rule.pendingDelete || !rule.isEnabled || rule.forwardType !== "gost" || tunnelId <= 0) continue;
      const tunnel = tunnelById.get(tunnelId) as any;
      if (!tunnel || (!isGostTunnelMode(tunnel) && !isNginxTunnelMode(tunnel)) || !tunnel.isEnabled) continue;
      if (!isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)) continue;
      if (!isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel)) continue;
      const ruleId = Number((rule as any).id || 0);
      const current = primaryManagedTunnelRuleIdByTunnelId.get(tunnelId) || 0;
      if (ruleId > 0 && (!current || ruleId < current)) {
        primaryManagedTunnelRuleIdByTunnelId.set(tunnelId, ruleId);
      }
    }
    const useConfiguredTunnelListenPortsForRule = (rule: any, tunnel: any) => (
      !!rule
      && !!tunnel
      && Number(primaryManagedTunnelRuleIdByTunnelId.get(Number((tunnel as any).id || 0)) || 0) === Number((rule as any).id || 0)
    );
    const tunnelExtraExitNodes = (tunnel: any) => (
      (tunnel as any)?.loadBalanceEnabled
        ? (tunnelExitNodesByTunnelId.get(Number(tunnel?.id || 0)) || [])
        : []
    )
      .filter((node: any) => node && (node as any).isEnabled !== false && Number((node as any).hostId) > 0 && Number((node as any).listenPort) > 0)
      .sort((a: any, b: any) => Number((a as any).seq || 0) - Number((b as any).seq || 0));
    const tunnelExitEndpointsForRule = (rule: any, tunnel: any) => {
      if (!tunnel || (!isGostTunnelMode(tunnel) && !isNginxTunnelMode(tunnel))) return [];
      const useConfiguredPorts = useConfiguredTunnelListenPortsForRule(rule, tunnel);
      const endpoints: Array<{ exitNodeId: number; exitSeq: number; exitHostId: number; listenPort: number; rulePort: number; primary: boolean; node?: any }> = [];
      const primaryListenPort = useConfiguredPorts ? Number((tunnel as any).listenPort || 0) : Number((rule as any).tunnelExitPort || 0);
      const primaryRulePort = Number((rule as any).tunnelExitPort || 0);
      if (Number((tunnel as any).exitHostId) > 0 && primaryListenPort > 0) {
        endpoints.push({
          exitNodeId: 0,
          exitSeq: 0,
          exitHostId: Number((tunnel as any).exitHostId),
          listenPort: primaryListenPort,
          rulePort: primaryRulePort,
          primary: true,
        });
      }
      const mappingByNodeId = new Map(tunnelRuleExitMappings(rule).map((row) => [Number(row.exitNodeId), row]));
      for (const node of tunnelExtraExitNodes(tunnel)) {
        const nodeId = Number((node as any).id || 0);
        const mapping = mappingByNodeId.get(nodeId);
        const listenPort = useConfiguredPorts ? Number((node as any).listenPort || 0) : Number(mapping?.tunnelExitPort || 0);
        const exitHostId = Number((node as any).hostId || mapping?.exitHostId || 0);
        if (nodeId <= 0 || exitHostId <= 0 || listenPort <= 0) continue;
        endpoints.push({
          exitNodeId: nodeId,
          exitSeq: Number((node as any).seq || mapping?.exitSeq || 0),
          exitHostId,
          listenPort,
          rulePort: Number(mapping?.tunnelExitPort || 0),
          primary: false,
          node,
        });
      }
      return endpoints;
    };
    const isCurrentHostTunnelExitForRule = (rule: any, tunnel: any) => {
      if (!tunnel || (!isGostTunnelMode(tunnel) && !isNginxTunnelMode(tunnel))) return false;
      return tunnelExitEndpointsForRule(rule, tunnel).some((endpoint) => endpoint.exitHostId === Number(host.id));
    };
    const currentHostTunnelExitPortsForRule = (rule: any, tunnel: any) => {
      const ports = tunnelExitEndpointsForRule(rule, tunnel)
        .filter((endpoint) => endpoint.exitHostId === Number(host.id) && endpoint.listenPort > 0)
        .map((endpoint) => endpoint.listenPort);
      return Array.from(new Set(ports));
    };
    const hopKey = (secret: string, idx: number) =>
      crypto.createHash("sha256").update(`${secret}|hop|${idx}`).digest("hex");
    const hopSeq = (hop: any, fallback: number) => {
      const seq = Number((hop as any)?.seq);
      return Number.isFinite(seq) ? seq : fallback;
    };
    const fxpHopKey = (tunnel: any, hop: any, fallback: number) =>
      hopKey(tunnelSecretSeed(tunnel), hopSeq(hop, fallback));
    const forwardXExtraExitRoutes = async (tunnel: any) => {
      const routes: Array<{ host: string; port: number; key: string }> = [];
      if (!(tunnel as any).loadBalanceEnabled) return routes;
      const extraNodes = tunnelExitNodesByTunnelId.get(Number(tunnel.id)) || [];
      for (const exitNode of extraNodes as any[]) {
        if ((exitNode as any).isEnabled === false) continue;
        const port = Number((exitNode as any).listenPort || 0);
        if (port <= 0) continue;
        const exitHost = await getExtraExitDialAddress(exitNode);
        if (!exitHost) continue;
        routes.push({ host: exitHost, port, key: tunnelSecretSeed(tunnel) });
      }
      return routes;
    };
    const buildForwardXHopSpec = async (
      tunnel: any,
      hops: any[],
      hopIdx: number,
      op: "apply" | "remove",
    ) => {
      const hop = hops[hopIdx] as any;
      const listenPort = Number(hop?.listenPort) || 0;
      const isLast = hopIdx === hops.length - 1;
      const fxpSpec: any = {
        role: isLast ? "exit" : "relay",
        tunnelId: tunnel.id,
        ruleId: 0,
        listenPort,
        protocol: "both",
        key: fxpHopKey(tunnel, hop, hopIdx),
        dnsGeneration: tunnelDnsGeneration(tunnel),
      };
      if (!isLast) {
        const nextHop = hops[hopIdx + 1] as any;
        const nextIp = await getHopDialAddress(nextHop);
        fxpSpec.relayExitHost = String(nextIp).trim();
        fxpSpec.relayExitPort = Number(nextHop?.listenPort) || 0;
        fxpSpec.relayKey = fxpHopKey(tunnel, nextHop, hopIdx + 1);
        if (tunnelNeedsMimic(tunnel)) {
          const endpoint = mimicFilterEndpoint(fxpSpec.relayExitHost, fxpSpec.relayExitPort);
          if (endpoint) addMimicFilter(`remote=${endpoint}`);
        }
        const nextIsFinalExit = hopIdx + 1 === hops.length - 1;
        if (nextIsFinalExit && (tunnel as any).loadBalanceEnabled) {
          const extraRoutes = await forwardXExtraExitRoutes(tunnel);
          if (extraRoutes.length > 0) {
            fxpSpec.exits = [
              { host: fxpSpec.relayExitHost, port: fxpSpec.relayExitPort, key: fxpSpec.relayKey },
              ...extraRoutes.map((route) => ({ host: route.host, port: route.port, key: route.key })),
            ];
          }
        }
        if (op === "apply" && (!fxpSpec.relayExitHost || fxpSpec.relayExitPort <= 0 || !fxpSpec.relayKey)) {
          appendPanelLog("error", `[TunnelRoute] invalid ForwardX relay next hop tunnel=${tunnel.id} hop=${hopIdx} nextHost=${fxpSpec.relayExitHost || "-"} nextPort=${fxpSpec.relayExitPort || "-"}`);
          return null;
        }
      }
      if (op === "apply" && listenPort <= 0) {
        appendPanelLog("error", `[TunnelRoute] invalid ForwardX hop listen port tunnel=${tunnel.id} hop=${hopIdx} listen=${listenPort || "-"}`);
        return null;
      }
      return fxpSpec;
    };
    const forwardXEntryRoute = async (tunnel: any) => {
      const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
      if (Array.isArray(hops) && hops.length >= 2) {
        const nextHop = hops[1] as any;
        return {
          host: String(await getHopDialAddress(nextHop)).trim(),
          port: Number(nextHop?.listenPort) || 0,
          key: fxpHopKey(tunnel, nextHop, 1),
        };
      }
      const endpoint = tunnelExitEndpointById.get(tunnel.id);
      return {
        host: String(endpoint?.host || await tunnelExitHostAddress(tunnel)).trim(),
        port: Number(endpoint?.port || tunnel.listenPort) || 0,
        key: tunnelSecretSeed(tunnel),
      };
    };
    const forwardXEntryRoutes = async (rule: any, tunnel: any) => {
      const primary = await forwardXEntryRoute(tunnel);
      const routes: Array<{ host: string; port: number; key: string }> = [];
      if (primary.host && primary.port > 0 && primary.key) routes.push(primary);
      const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
      if (!Array.isArray(hops) || hops.length < 3) {
        routes.push(...await forwardXExtraExitRoutes(tunnel));
      }
      return routes;
    };
    const addMimicRemoteFilterForRoutes = (routes: Array<{ host: string; port: number }>) => {
      for (const route of routes) {
        const endpoint = mimicFilterEndpoint(route.host, route.port);
        if (endpoint) addMimicFilter(`remote=${endpoint}`);
      }
    };
    const addMimicLocalFilterForPort = (port: unknown) => {
      const p = Number(port) || 0;
      if (p <= 0 || p > 65535) return;
      addMimicFilter(`local=0.0.0.0:${p}`);
      addMimicFilter(`local=[::]:${p}`);
    };
    const collectMimicFiltersForRule = async (rule: any, tunnel: any) => {
      if (!udpOverTcpEnabled(rule, tunnel) || !isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel)) return;
      const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
      const hostId = Number(host.id);
      if (isCurrentHostTunnelEntry(tunnel)) {
        addMimicRemoteFilterForRoutes(await forwardXEntryRoutes(rule, tunnel));
      }
      if (Array.isArray(hops) && hops.length >= 2) {
        const hostIdx = hops.findIndex((hop: any) => Number(hop.hostId) === hostId);
        if (hostIdx >= 0) {
          const currentHop = hops[hostIdx] as any;
          if (hostIdx > 0) {
            addMimicLocalFilterForPort(Number(currentHop?.listenPort || 0));
          }
          if (hostIdx < hops.length - 1) {
            const nextHop = hops[hostIdx + 1] as any;
            const nextHost = String(await getHopDialAddress(nextHop)).trim();
            const endpoint = mimicFilterEndpoint(nextHost, Number(nextHop?.listenPort || 0));
            if (endpoint) addMimicFilter(`remote=${endpoint}`);
          }
        }
        return;
      }
      const primaryExitHostId = Number(tunnel.exitHostId || 0);
      if (primaryExitHostId === hostId) {
        addMimicLocalFilterForPort(Number(tunnel.listenPort) || 0);
      }
      const extraExitNode = (tunnelExitNodesByTunnelId.get(Number(tunnel.id)) || [])
        .find((node: any) => node?.isEnabled !== false && Number(node.hostId) === hostId);
      if (extraExitNode) {
        addMimicLocalFilterForPort(Number((extraExitNode as any).listenPort || 0));
      }
    };
    for (const tunnel of hostTunnels as any[]) {
      if (isCurrentHostTunnelEntry(tunnel) && tunnel.isEnabled && isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)) {
        const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
        const nextHop = Array.isArray(hops) && hops.length >= 2 ? (hops[1] as any) : null;
        tunnelExitEndpointById.set(tunnel.id, {
          host: nextHop ? await getHopDialAddress(nextHop) : await tunnelExitHostAddress(tunnel),
          port: nextHop ? Number(nextHop.listenPort) : Number(tunnel.listenPort),
        });
      }
    }
    const tunnelProbes = (await Promise.all((hostTunnels as any[])
      .filter((tunnel: any) => tunnel.isEnabled && isTunnelProtocolEnabled(forwardProtocolSettings, tunnel))
      .map(async (tunnel: any) => {
        const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
        if (Array.isArray(hops) && hops.length >= 3) {
          const hostIdx = hops.findIndex((hop: any) => Number(hop.hostId) === Number(host.id));
          if (hostIdx < 0 || hostIdx >= hops.length - 1) return null;
          if (hostIdx === 0) {
            const aggregate = getTunnelAutoHopAggregate(Number(tunnel.id), hops.length - 1);
            if (aggregate) {
              await db.insertTunnelLatencyStat({
                tunnelId: Number(tunnel.id),
                latencyMs: aggregate.success ? aggregate.latencyMs : null,
                isTimeout: !aggregate.success,
              }, { preserveMessage: true });
              if (aggregate.success && !(tunnel as any).isRunning) {
                await db.updateTunnelRunningStatus(Number(tunnel.id), true);
              }
            }
          }
          const nextHop = hops[hostIdx + 1] as any;
          const targetIp = await getHopDialAddress(nextHop);
          const targetPort = Number(nextHop.listenPort) || 0;
          return targetIp && targetPort > 0 ? {
            tunnelId: tunnel.id,
            targetIp,
            targetPort,
            protocol: "tcp",
            hopIndex: hostIdx,
            hopCount: hops.length - 1,
          } : null;
        }
        if (!isCurrentHostTunnelEntry(tunnel)) return null;
        const primaryEndpoint = tunnelExitEndpointById.get(tunnel.id);
        const baseProbe = {
          tunnelId: tunnel.id,
          targetIp: primaryEndpoint?.host || "",
          targetPort: Number(primaryEndpoint?.port) || 0,
          protocol: "tcp",
        };
        if (!(tunnel as any).loadBalanceEnabled) return baseProbe;
        const probes: any[] = [];
        if (baseProbe.targetIp && baseProbe.targetPort > 0) {
          probes.push({
            ...baseProbe,
            seriesKey: "primary",
            seriesLabel: "主出口",
          });
        }
        const extraRoutes = await forwardXExtraExitRoutes(tunnel);
        extraRoutes.forEach((route, index) => {
          if (!route.host || Number(route.port) <= 0) return;
          probes.push({
            tunnelId: tunnel.id,
            targetIp: route.host,
            targetPort: Number(route.port) || 0,
            protocol: "tcp",
            seriesKey: `exit-${index + 2}`,
            seriesLabel: `出口 ${index + 2}`,
          });
        });
        return probes;
      }))).flat().filter((probe: any) => probe && probe.targetIp && probe.targetPort > 0);
    const emptyProtocolPolicy = { blockHttp: false, blockSocks: false, blockTls: false };
    const protocolPolicyFromHost = (hostLike: any) => ({
      blockHttp: !!(hostLike as any)?.blockHttp,
      blockSocks: !!(hostLike as any)?.blockSocks,
      blockTls: !!(hostLike as any)?.blockTls,
    });
    const hasProtocolPolicy = (policy: any) => {
      return policy.blockHttp || policy.blockSocks || policy.blockTls;
    };
    const hostProtocolPolicyById = new Map<number, typeof emptyProtocolPolicy>([
      [Number(host.id), protocolPolicyFromHost(host)],
    ]);
    const getHostProtocolPolicy = async (hostId: number) => {
      const id = Number(hostId);
      if (!Number.isFinite(id) || id <= 0) return emptyProtocolPolicy;
      const cached = hostProtocolPolicyById.get(id);
      if (cached) return cached;
      const entryHost = await db.getHostById(id);
      const policy = entryHost ? protocolPolicyFromHost(entryHost) : emptyProtocolPolicy;
      hostProtocolPolicyById.set(id, policy);
      return policy;
    };
    const ruleProtocolPolicy = (rule: any) => getHostProtocolPolicy(Number((rule as any)?.hostId || 0));
    const tunnelProtocolPolicy = (tunnel: any) => getHostProtocolPolicy(isCurrentHostTunnelEntry(tunnel) ? Number(host.id) : Number((tunnel as any)?.entryHostId || 0));
    const processBackendForwardTypes = new Set(["gost", "realm", "socat", "nginx"]);
    const shouldUseProcessBackendGuard = (rule: any) => processBackendForwardTypes.has(String(rule?.forwardType || ""));
    const shouldUseRuleGuard = async (rule: any) => {
      if (rule.forwardType === "gost" && Number((rule as any).tunnelId || 0) > 0) return false;
      if (!shouldUseProcessBackendGuard(rule)) return false;
      if (!isAgentVersionAtLeast(String((host as any).agentVersion || ""), AGENT_PROTOCOL_GUARD_BACKEND_VERSION)) return false;
      if (!isForwardRuleProtocolTcpEnabled(rule.protocol)) return false;
      return hasProtocolPolicy(await ruleProtocolPolicy(rule));
    };
    const shouldUseProtocolGuard = (rule: any, policy: any) => isForwardRuleProtocolTcpEnabled(rule?.protocol) && hasProtocolPolicy(policy);
    const guardListenPort = (rule: any) => 39000 + (Number(rule.id) % 20000);
    const guardBackendPort = (rule: any) => 43000 + (Number(rule.id) % 20000);
    const guardTargetForRule = (rule: any, useRuleGuard: boolean) => (
      useRuleGuard && shouldUseProcessBackendGuard(rule)
        ? { targetIp: "127.0.0.1", targetPort: guardBackendPort(rule), backendPort: guardBackendPort(rule), backendForwardType: String(rule.forwardType || "") }
        : { ...failoverTargetEndpoint(rule), backendPort: 0, backendForwardType: "" }
    );
    const cleanupGuardBackendCmds = (rule: any, keepNames: string[] = []) => {
      const sourcePort = Number(rule?.sourcePort || 0);
      if (!sourcePort) return [];
      const keep = new Set(keepNames.map((name) => String(name || "").trim()).filter(Boolean));
      const realmGuardService = `forwardx-realm-guard-${sourcePort}`;
      const services = [
        realmGuardService,
        `forwardx-socat-guard-${sourcePort}`,
        `forwardx-socat-guard-tcp-${sourcePort}`,
        `forwardx-socat-guard-udp-${sourcePort}`,
      ];
      const cmds = services.filter((name) => !keep.has(name)).map((name) => removeManagedServiceCmd(name));
      if (!keep.has(realmGuardService)) {
        cmds.push(`rm -f ${shQuote(realmGuardConfigPathForPort(sourcePort))} ${shQuote(`${realmGuardConfigPathForPort(sourcePort)}.sha256`)} 2>/dev/null || true`);
      }
      return cmds;
    };
    const tunnelExitRules = agentAllRules
      .filter((r: any) => {
        if (r.pendingDelete || !r.isEnabled || r.forwardType !== "gost" || !r.tunnelId) return false;
        const tunnel = tunnelById.get(r.tunnelId) as any;
        return !!tunnel
          && tunnel.isEnabled
          && isGostTunnelMode(tunnel)
          && isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)
          && isRuleProtocolEnabled(forwardProtocolSettings, r, tunnel)
          && isCurrentHostTunnelExitForRule(r, tunnel);
      });
    const nginxTunnelExitRules = agentAllRules
      .filter((r: any) => {
        if (r.pendingDelete || !r.isEnabled || r.forwardType !== "gost" || !r.tunnelId) return false;
        const tunnel = tunnelById.get(r.tunnelId) as any;
        return !!tunnel
          && tunnel.isEnabled
          && isNginxTunnelMode(tunnel)
          && isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)
          && isRuleProtocolEnabled(forwardProtocolSettings, r, tunnel)
          && isCurrentHostTunnelExitForRule(r, tunnel);
      });
    const gostTunnelNode = (
      name: string,
      addr: string,
      dialerType: string,
      tunnel: any,
      connectorType: "relay" | "forward" = "relay",
      metadata?: Record<string, unknown>,
    ) => ({
      name,
      addr,
      ...(metadata ? { metadata } : {}),
      connector: connectorType === "forward"
        ? { type: "forward" }
        : { type: "relay", metadata: { nodelay: true } },
      dialer: {
        type: dialerType,
        ...(tunnelDialerMetadata(tunnel.mode) ? { metadata: tunnelDialerMetadata(tunnel.mode) } : {}),
      },
    });
    const buildLoadBalancedExitNodes = async (rule: any, tunnel: any, primaryHostOverride?: string) => {
      const nodes: any[] = [];
      for (const endpoint of tunnelExitEndpointsForRule(rule, tunnel)) {
        const exitHost = endpoint.primary
          ? (String(primaryHostOverride || "").trim() || tunnelExitEndpointById.get(tunnel.id)?.host || await tunnelExitHostAddress(tunnel))
          : await getExtraExitDialAddress(endpoint.node);
        if (!exitHost || endpoint.listenPort <= 0) continue;
        const exitKey = endpoint.primary ? 0 : (endpoint.exitSeq || endpoint.exitNodeId);
        const entrySendProxyMetadata = maybeProxyProtocolMetadata(rule, "entrySend");
        nodes.push(gostTunnelNode(
          `exit-${rule.id}-${exitKey}`,
          endpointHostPort(exitHost, endpoint.listenPort),
          tunnelProtocolType(tunnel.mode),
          tunnel,
          "forward",
          entrySendProxyMetadata,
        ));
      }
      return nodes;
    };
    const gostLoadBalanceHopMetadata = { strategy: "round", maxFails: 1, failTimeout: "15s" };
    const gostRelayHandler = (metadata?: Record<string, unknown>) => ({
      type: "relay",
      metadata: { nodelay: true, ...(metadata || {}) },
    });
    const gostForwardHandler = (metadata?: Record<string, unknown>) => ({
      type: "forward",
      ...(metadata ? { metadata } : {}),
    });
    const gostServiceConfig = (await Promise.all(gostRules
      .map(async (r: any) => {
        const useRuleGuard = await shouldUseRuleGuard(r);
        const tunnel = (r as any).tunnelId ? tunnelById.get((r as any).tunnelId) as any : null;
        if (tunnel && !isGostTunnelMode(tunnel)) return [];
        const protos = tunnel ? tunnelForwardProtos(r.protocol) : forwardRuleProtocols(r.protocol);
        return Promise.all(protos.map(async (proto) => {
          const tunnelHops = tunnel ? tunnelHopsByTunnelId.get(Number(tunnel.id)) : null;
          const firstHop = Array.isArray(tunnelHops) && tunnelHops.length >= 2 ? (tunnelHops[0] as any) : null;
          const isMultiHopTunnel = Array.isArray(tunnelHops) && tunnelHops.length >= 3;
          const useMultiHopEntry =
            isMultiHopTunnel
            && !!firstHop
            && Number(firstHop.hostId) === Number(host.id);
          const tunnelExitHost = tunnel ? tunnelExitEndpointById.get(tunnel.id)?.host : "";
          const handlerProxyMetadata = proto === "tcp" && !tunnel ? maybeProxyProtocolMetadata(r, "send") : undefined;
          const serviceListenPort = useRuleGuard && !tunnel ? guardBackendPort(r) : Number(r.sourcePort);
          const service: any = {
            name: `fwx-${r.id}-${proto}`,
            addr: useRuleGuard && !tunnel ? `127.0.0.1:${serviceListenPort}` : `:${serviceListenPort}`,
            handler: tunnel
              ? { type: proto, chain: `chain-tunnel-${r.id}` }
              : { type: proto, ...(handlerProxyMetadata ? { metadata: handlerProxyMetadata } : {}) },
            listener: { type: proto },
          };
          if (proto === "tcp" && proxyProtocolEnabled(r, "receive")) {
            service.metadata = maybeProxyProtocolMetadata(r, "receive");
          } else if (proto === "tcp" && useRuleGuard && proxyProtocolEnabled(r, "send")) {
            service.metadata = { proxyProtocol: proxyProtocolVersion(r) };
          }
          if (!tunnel) {
            service.forwarder = {
              nodes: [{
                name: `target-${r.id}`,
                addr: failoverTargetAddr(r),
                connector: { type: proto },
                dialer: { type: proto },
              }],
            };
          } else if (useMultiHopEntry) {
            service.forwarder = {
              nodes: [{
                name: `target-${r.id}`,
                addr: failoverTargetAddr(r),
                connector: { type: proto },
                dialer: { type: proto },
              }],
            };
          } else if (!tunnelExitHost || tunnelExitEndpointsForRule(r, tunnel).length === 0) {
            return null;
          }
          return applyGostLimiter(service, Number(r.userId), tunnel);
        }));
      })))
      .flat()
      .filter(Boolean);
    const tunnelGostChains = (await Promise.all(gostRules
      .filter((r: any) => r.isEnabled && r.forwardType === "gost" && r.tunnelId)
      .map(async (r: any) => {
        const tunnel = tunnelById.get((r as any).tunnelId) as any;
        if (!isGostTunnelMode(tunnel)) return null;
        const tunnelExitHost = tunnel ? tunnelExitEndpointById.get(tunnel.id)?.host : "";
        if (!tunnel || !tunnelExitHost || tunnelExitEndpointsForRule(r, tunnel).length === 0) return null;
        const tunnelHops = tunnelHopsByTunnelId.get(Number(tunnel.id));
        const firstHop = Array.isArray(tunnelHops) && tunnelHops.length >= 2 ? (tunnelHops[0] as any) : null;
        const isMultiHopTunnel = Array.isArray(tunnelHops) && tunnelHops.length >= 3;
        const useMultiHopEntry =
          isMultiHopTunnel
          && !!firstHop
          && Number(firstHop.hostId) === Number(host.id);
        // Multi-hop rules on the entry host must build an explicit B->...->exit chain.
        // Dialing the local first-hop listener only proves the generic probe path and bypasses
        // the selected tunnel exit listener.
        if (isMultiHopTunnel && !useMultiHopEntry) {
          console.warn(`[TunnelRoute] skip direct fallback for multi-hop tunnel=${tunnel.id} rule=${r.id}; entry host mismatch host=${host.id} firstHop=${Number(firstHop?.hostId) || 0}`);
          return null;
        }
        if (isMultiHopTunnel && useMultiHopEntry) {
          const chainHops: any[] = [];
          const entrySendProxyMetadata = maybeProxyProtocolMetadata(r, "entrySend");
          const routeParts: string[] = [`entry#${Number(firstHop.hostId)}:${Number((r as any).sourcePort)}`];
          for (let i = 1; i < tunnelHops.length - 1; i++) {
            const hop = tunnelHops[i] as any;
            const hopDialHost = await getHopDialAddress(hop);
            if (!hopDialHost || !Number(hop.listenPort)) return null;
            const hopAddr = endpointHostPort(hopDialHost, hop.listenPort);
            routeParts.push(`hop#${Number(hop.hostId)}@${hopAddr}`);
            const relayHopProxyMetadata = maybeProxyProtocolMetadata(r, "entrySend");
            chainHops.push({
              name: `hop-tunnel-${r.id}-${Number(hop.seq)}`,
              ...(relayHopProxyMetadata ? { metadata: relayHopProxyMetadata } : {}),
              nodes: [gostTunnelNode(
                `mhop-${r.id}-${Number(hop.seq)}`,
                hopAddr,
                tunnelProtocolType(tunnel.mode),
                tunnel,
              )],
            });
          }
          const exitHop = tunnelHops[tunnelHops.length - 1] as any;
          const exitHost = await getHopDialAddress(exitHop);
          const exitNodes = await buildLoadBalancedExitNodes(r, tunnel, exitHost);
          if (!exitHost || exitNodes.length === 0) return null;
          chainHops.push({
            name: `hop-tunnel-${r.id}-exit`,
            ...(entrySendProxyMetadata ? { metadata: entrySendProxyMetadata } : {}),
            ...(exitNodes.length > 1 ? { selector: gostLoadBalanceHopMetadata } : {}),
            nodes: exitNodes,
          });
          if (chainHops.length === 0) return null;
          routeParts.push(`exit#${Number(exitHop.hostId)}@${exitNodes.map((node: any) => node.addr).join(",")}`);
          const route = routeParts.join(" -> ");
          const routeKey = `${tunnel.id}:${r.id}:${host.id}`;
          if (tunnelRouteLogCache.get(routeKey) !== route) {
            tunnelRouteLogCache.set(routeKey, route);
            appendPanelLog("info", `[TunnelRoute] gost multi-hop tunnel=${tunnel.id} rule=${r.id} host=${host.id} proxyEntrySend=${proxyProtocolEnabled(r, "entrySend")} route=${route}`);
          }
          return { name: `chain-tunnel-${r.id}`, hops: chainHops };
        }
        const firstExitEndpoint = tunnelExitEndpointsForRule(r, tunnel)[0];
        const chainTargetAddr = useMultiHopEntry
          ? endpointHostPort("127.0.0.1", firstHop.listenPort)
          : endpointHostPort(tunnelExitHost, firstExitEndpoint?.listenPort || 0);
        const chainNodeName = useMultiHopEntry ? `mhop-entry-${r.id}` : `exit-${r.id}`;
        const exitNodes = !useMultiHopEntry ? await buildLoadBalancedExitNodes(r, tunnel) : [];
        return {
          name: `chain-tunnel-${r.id}`,
          hops: [{
            name: `hop-tunnel-${r.id}`,
            ...(maybeProxyProtocolMetadata(r, "entrySend") ? { metadata: maybeProxyProtocolMetadata(r, "entrySend") } : {}),
            ...(exitNodes.length > 1 ? { selector: gostLoadBalanceHopMetadata } : {}),
            nodes: useMultiHopEntry ? [gostTunnelNode(
              chainNodeName,
              chainTargetAddr,
              "tcp",
              tunnel,
            )] : exitNodes,
          }],
        };
      }))).filter(Boolean);
    const gostChains = [...tunnelGostChains];
    const buildGostReloadCmds = () => {
      const encodedConfig = Buffer.from(JSON.stringify({ services: gostServiceConfig, chains: gostChains, limiters: gostRateLimiters }, null, 2), "utf8").toString("base64");
      const proxyDebugCmds = VERBOSE_AGENT_ACTIONS ? gostRules
        .filter((rule: any) => rule && Number(rule.tunnelId || 0) > 0 && (
          proxyProtocolEnabled(rule, "entryReceive") ||
          proxyProtocolEnabled(rule, "entrySend") ||
          proxyProtocolEnabled(rule, "exitReceive") ||
          proxyProtocolEnabled(rule, "exitSend")
        ))
        .map((rule: any) => buildProxyRuleDebugCmd("entry", rule, {
          chain: `chain-tunnel-${Number(rule.id || 0)}`,
        })) : [];
      const cmds = [
        `mkdir -p ${shQuote(RUNTIME_CONFIG_DIR)}`,
        `printf '%s' '${encodedConfig}' | base64 -d > ${shQuote(RUNTIME_CONFIG_PATH)}`,
        ...proxyDebugCmds,
        writeManagedServiceCmd(gostServiceName, gostServiceUnit),
        stopManagedServiceCmd(LEGACY_GOST_SERVICE_NAME),
      ];
      if (gostServiceConfig.length > 0) {
        cmds.unshift(ensureRuntimeBinaryCmd());
        if (anyTunnelDnsRefresh(hostTunnels as any[])) {
          cmds.push(dnsRuntimeRefreshCmd("gost"), `rm -f ${shQuote(`${RUNTIME_CONFIG_PATH}.sha256`)} 2>/dev/null || true`);
        }
        cmds.push(restartManagedServiceIfConfigChangedCmd(gostServiceName, RUNTIME_CONFIG_PATH));
      } else {
        cmds.push(stopManagedServiceCmd(gostServiceName));
      }
      return cmds;
    };
    const buildTunnelReloadCmds = async () => {
      const businessTunnelListenKeys = new Set<string>();
      for (const rule of tunnelExitRules as any[]) {
        const tunnel = tunnelById.get(Number((rule as any).tunnelId)) as any;
        if (!tunnel || isForwardXTunnel(tunnel)) continue;
        for (const endpoint of tunnelExitEndpointsForRule(rule, tunnel)) {
          if (endpoint.exitHostId > 0 && endpoint.listenPort > 0) {
            businessTunnelListenKeys.add(`${endpoint.exitHostId}:${endpoint.listenPort}`);
          }
        }
      }
      const tunnelBusinessPortInUse = (hostId: number, listenPort: number) => businessTunnelListenKeys.has(`${Number(hostId)}:${Number(listenPort)}`);
      const gostTunnelProbeService = (tunnel: any, name: string, listenPort: number) => ({
        name,
        addr: `:${listenPort}`,
        handler: { type: "tcp" },
        listener: {
          type: tunnelProtocolType(tunnel.mode),
          ...(tunnelProtocolMetadata(tunnel.mode) ? { metadata: tunnelProtocolMetadata(tunnel.mode) } : {}),
        },
        forwarder: {
          nodes: [{
            name: `probe-${name}`,
            addr: "127.0.0.1:9",
            connector: { type: "tcp" },
            dialer: { type: "tcp" },
          }],
        },
      });
      const tunnelProbeServices = (hostTunnels as any[]).flatMap((tunnel: any) => {
      if (!tunnel || !tunnel.isEnabled || !isGostTunnelMode(tunnel) || !isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)) return [];
        const services: any[] = [];
        if (Number(tunnel.exitHostId) === Number(host.id)) {
          const listenPort = Number(tunnel.listenPort) || 0;
          if (listenPort > 0 && !tunnelBusinessPortInUse(Number(host.id), listenPort)) services.push(gostTunnelProbeService(tunnel, `fwx-tunnel-probe-${tunnel.id}`, listenPort));
        }
        const extraNodes = tunnelExitNodesByTunnelId.get(Number(tunnel.id)) || [];
        for (const exitNode of extraNodes as any[]) {
          if (!exitNode || exitNode.isEnabled === false || Number(exitNode.hostId) !== Number(host.id)) continue;
          const listenPort = Number(exitNode.listenPort) || 0;
          if (listenPort <= 0 || tunnelBusinessPortInUse(Number(host.id), listenPort)) continue;
          const exitKey = Number(exitNode.id) || Number(exitNode.seq) || listenPort;
          services.push(gostTunnelProbeService(tunnel, `fwx-tunnel-probe-${tunnel.id}-exit-${exitKey}`, listenPort));
        }
        return services;
      });
    const ruleServices = (await Promise.all(tunnelExitRules.map(async (rule: any) => {
        const tunnel = tunnelById.get(rule.tunnelId) as any;
        if (!tunnel || !isGostTunnelMode(tunnel)) return [];
        const exitPorts = currentHostTunnelExitPortsForRule(rule, tunnel);
        if (exitPorts.length === 0) return [];
        const policy = await tunnelProtocolPolicy(tunnel);
        const targetAddr = shouldUseProtocolGuard(rule, policy) ? `127.0.0.1:${guardListenPort(rule)}` : failoverTargetAddr(rule);
        return exitPorts.map((exitPort) => {
          const exitSendProxyMetadata = maybeProxyProtocolMetadata(rule, "exitSend");
          return {
            name: `fwx-tunnel-exit-${tunnel.id}-${rule.id}-${exitPort}`,
            addr: `:${exitPort}`,
            handler: gostForwardHandler(exitSendProxyMetadata),
            listener: {
              type: tunnelProtocolType(tunnel.mode),
              ...(tunnelProtocolMetadata(tunnel.mode) ? { metadata: tunnelProtocolMetadata(tunnel.mode) } : {}),
            },
            ...(proxyProtocolEnabled(rule, "exitReceive") ? { metadata: maybeProxyProtocolMetadata(rule, "exitReceive") } : {}),
            forwarder: {
              nodes: [{
                name: `target-${rule.id}`,
                addr: targetAddr,
                connector: { type: "tcp" },
                dialer: { type: "tcp" },
              }],
            },
          };
        });
      }))).flat();
      const multiHopRelayServices = await Promise.all((hostTunnels as any[]).map(async (tunnel: any) => {
        if (!tunnel || !tunnel.isEnabled || !isGostTunnelMode(tunnel) || !isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)) return null;
        const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
        if (!hops || hops.length < 2) return null;
        const hostIdx = hops.findIndex((hop: any) => Number(hop.hostId) === Number(host.id));
        if (hostIdx < 0 || hostIdx >= hops.length - 1) return null; // not in chain or exit hop
        const currentHop = hops[hostIdx] as any;
        const relayRulesForCurrentHop = (agentAllRules as any[]).filter((rule: any) => {
          if (!rule || rule.pendingDelete || !rule.isEnabled || rule.forwardType !== "gost") return false;
          if (Number(rule.tunnelId || 0) !== Number(tunnel.id)) return false;
          if (!isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel)) return false;
          return proxyProtocolEnabled(rule, "entrySend");
        });
        const relayReceiveProxyMetadata = relayRulesForCurrentHop.length > 0
          ? { proxyProtocol: relayRulesForCurrentHop.some((rule: any) => proxyProtocolVersion(rule) === 2) ? 2 : 1 }
          : undefined;
        const listenerMetadata = mergeMetadata(
          Number(currentHop.seq) === 0 ? undefined : tunnelProtocolMetadata(tunnel.mode),
        );
        return {
          name: `fwx-mhop-${tunnel.id}-${Number(currentHop.seq)}`,
          addr: `:${Number(currentHop.listenPort)}`,
          handler: gostRelayHandler(),
          listener: {
            // Entry hop receives local plain TCP traffic; relays receive tunneled traffic.
            type: Number(currentHop.seq) === 0 ? "tcp" : tunnelProtocolType(tunnel.mode),
            ...(listenerMetadata ? { metadata: listenerMetadata } : {}),
          },
          ...(relayReceiveProxyMetadata ? { metadata: relayReceiveProxyMetadata } : {}),
        };
      }));
      const services = [...tunnelProbeServices, ...ruleServices, ...multiHopRelayServices.filter(Boolean)];
      const countingCmds = tunnelExitRules.flatMap((rule: any) => {
        const tunnel = tunnelById.get(rule.tunnelId) as any;
        if (!tunnel || !isGostTunnelMode(tunnel)) return [];
        return currentHostTunnelExitPortsForRule(rule, tunnel)
          .flatMap((exitPort) => buildCountingChainCmds(Number(exitPort), rule.targetIp, rule.targetPort, rule.protocol));
      });
      const proxyDebugCmds = VERBOSE_AGENT_ACTIONS ? tunnelExitRules.flatMap((rule: any) => {
        const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
        if (!tunnel || isForwardXTunnel(tunnel)) return [];
        if (
          !proxyProtocolEnabled(rule, "entryReceive") &&
          !proxyProtocolEnabled(rule, "entrySend") &&
          !proxyProtocolEnabled(rule, "exitReceive") &&
          !proxyProtocolEnabled(rule, "exitSend")
        ) return [];
        return currentHostTunnelExitPortsForRule(rule, tunnel).map((exitPort) => buildProxyRuleDebugCmd("exit", rule, {
          exitPort: Number(exitPort),
          listener: tunnelProtocolType(tunnel.mode),
        }));
      }) : [];
      const encodedConfig = Buffer.from(JSON.stringify({ services }, null, 2), "utf8").toString("base64");
      const cmds = [
        `mkdir -p ${shQuote(RUNTIME_CONFIG_DIR)}`,
        `printf '%s' '${encodedConfig}' | base64 -d > ${shQuote(TUNNEL_RUNTIME_CONFIG_PATH)}`,
        ...proxyDebugCmds,
        writeManagedServiceCmd(TUNNEL_RUNTIME_SERVICE_NAME, [
          "[Unit]",
          "Description=ForwardX managed tunnel runtime",
          "After=network.target",
          "",
          "[Service]",
          "Type=simple",
          `ExecStart=${RUNTIME_BIN} -C ${TUNNEL_RUNTIME_CONFIG_PATH}`,
          "Restart=always",
          "RestartSec=5",
          "LimitNOFILE=65535",
          "",
          "[Install]",
          "WantedBy=multi-user.target",
          "",
        ].join("\n")),
        stopManagedServiceCmd(LEGACY_TUNNEL_SERVICE_NAME),
      ];
      if (services.length > 0) {
        cmds.unshift(ensureRuntimeBinaryCmd());
        if (anyTunnelDnsRefresh(hostTunnels as any[])) {
          cmds.push(dnsRuntimeRefreshCmd("gost-tunnel"), `rm -f ${shQuote(`${TUNNEL_RUNTIME_CONFIG_PATH}.sha256`)} 2>/dev/null || true`);
        }
        cmds.push(restartManagedServiceIfConfigChangedCmd(TUNNEL_RUNTIME_SERVICE_NAME, TUNNEL_RUNTIME_CONFIG_PATH));
      } else {
        cmds.push(stopManagedServiceCmd(TUNNEL_RUNTIME_SERVICE_NAME));
      }
      cmds.push(...countingCmds);
      return cmds;
    };

    // 收集所有正在运行的规则的 port→ruleId 映射，用于 agent 重建映射文件
    const nginxConfigQuote = (value: unknown) => String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    const nginxEndpoint = (hostValue: unknown, portValue: unknown) => {
      const clean = cleanEndpointHost(hostValue);
      const port = Number(portValue) || 0;
      if (!clean || port <= 0 || port > 65535) return "";
      return isIpv6Literal(clean) ? `[${clean}]:${port}` : `${clean}:${port}`;
    };
    const nginxListenLine = (port: number, proto: "tcp" | "udp") => {
      const parts = [`listen [::]:${port}`];
      if (proto === "udp") parts.push("udp", "reuseport");
      parts.push("ipv6only=off");
      return `${parts.join(" ")};`;
    };
    const nginxProtocolsForRule = (rule: any): Array<"tcp" | "udp"> => {
      return forwardRuleProtocols(rule?.protocol);
    };
    const nginxUpstreamBlock = (
      name: string,
      endpoints: Array<{ addr: string; primary?: boolean }>,
      strategyRaw?: unknown,
    ) => {
      const cleanEndpoints = endpoints.filter((endpoint) => endpoint.addr);
      if (cleanEndpoints.length === 0) return "";
      const strategy = cleanEndpoints.length > 1 ? String(strategyRaw || "round_robin") : "round_robin";
      const lines = [`  upstream ${name} {`];
      if (strategy === "random") lines.push("    random;");
      else if (strategy === "least_conn") lines.push("    least_conn;");
      else if (strategy === "ip_hash") lines.push("    hash $remote_addr consistent;");
      cleanEndpoints.forEach((endpoint, index) => {
        const backup = strategy === "fallback" && index > 0 ? " backup" : "";
        lines.push(`    server ${endpoint.addr} max_fails=2 fail_timeout=10s${backup};`);
      });
      lines.push("  }");
      return lines.join("\n");
    };
    const nginxServerBlock = (options: {
      name: string;
      listenPort: number;
      proto: "tcp" | "udp";
      upstream: string;
      sslServer?: {
        certPath: string;
        keyPath: string;
      } | null;
      sslClient?: {
        serverName?: string | null;
      } | null;
    }) => {
      const lines = [
        "  server {",
        `    # ${nginxConfigQuote(options.name)}`,
        options.sslServer && options.proto === "tcp"
          ? `    listen [::]:${options.listenPort} ssl ipv6only=off;`
          : `    ${nginxListenLine(options.listenPort, options.proto)}`,
        "    proxy_connect_timeout 10s;",
        options.proto === "udp" ? "    proxy_timeout 2m;" : "    proxy_timeout 10m;",
      ];
      if (options.sslServer && options.proto === "tcp") {
        lines.push(
          `    ssl_certificate ${options.sslServer.certPath};`,
          `    ssl_certificate_key ${options.sslServer.keyPath};`,
          "    ssl_protocols TLSv1.2 TLSv1.3;",
        );
      }
      if (options.sslClient && options.proto === "tcp") {
        lines.push(
          "    proxy_ssl on;",
          "    proxy_ssl_verify off;",
        );
        const serverName = String(options.sslClient.serverName || "").trim();
        if (serverName) {
          lines.push(
            "    proxy_ssl_server_name on;",
            `    proxy_ssl_name ${nginxConfigQuote(serverName)};`,
          );
        }
      }
      lines.push(`    proxy_pass ${options.upstream};`, "  }");
      return lines.join("\n");
    };
    const buildNginxPortCleanupCmds = (rule: any) => [
      `rm -f /var/lib/forwardx-agent/traffic_${Number(rule.sourcePort) || 0}.prev /var/lib/forwardx-agent/port_${Number(rule.sourcePort) || 0}.rule /var/lib/forwardx-agent/port_${Number(rule.sourcePort) || 0}.fwtype /var/lib/forwardx-agent/port_${Number(rule.sourcePort) || 0}.tunnel /var/lib/forwardx-agent/target_${Number(rule.sourcePort) || 0}.info 2>/dev/null || true`,
      ...buildCountingCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
      ...buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule)),
    ];
    const nginxRuntimeActiveCmd = () => (
      `if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl is-active --quiet ${shQuote(NGINX_SERVICE_NAME)}.service; ` +
      `elif command -v rc-service >/dev/null 2>&1; then rc-service ${shQuote(NGINX_SERVICE_NAME)} status >/dev/null 2>&1; ` +
      `elif [ -x /etc/init.d/${NGINX_SERVICE_NAME} ]; then /etc/init.d/${NGINX_SERVICE_NAME} status >/dev/null 2>&1; ` +
      `else pgrep -f '${NGINX_BIN}.*${NGINX_CONFIG_PATH}' >/dev/null 2>&1; fi`
    );
    const nginxConfigHashCmd = (configPath = NGINX_CONFIG_PATH) => {
      const config = shQuote(configPath);
      return `if command -v sha256sum >/dev/null 2>&1; then sha256sum ${config} 2>/dev/null | awk '{print "sha256:"$1}'; elif command -v cksum >/dev/null 2>&1; then cksum ${config} 2>/dev/null | awk '{print "cksum:"$1":"$2}'; else echo "mtime:$(wc -c < ${config} 2>/dev/null):$(date -r ${config} +%s 2>/dev/null)"; fi`;
    };
    const nginxRuntimeVerifyCmd = () => {
      const config = shQuote(NGINX_CONFIG_PATH);
      return `[ -s ${config} ] && (${nginxRuntimeActiveCmd()}) && new_hash=$(${nginxConfigHashCmd()}); old_hash=$(cat ${config}.sha256 2>/dev/null || true); [ -n "$new_hash" ] && [ "$new_hash" = "$old_hash" ]`;
    };
    const deployNginxConfigCmd = (encodedConfig: string) => {
      const staged = shQuote(NGINX_STAGED_CONFIG_PATH);
      const live = shQuote(NGINX_CONFIG_PATH);
      return [
        `printf '%s' '${encodedConfig}' | base64 -d > ${staged}`,
        `${shQuote(NGINX_BIN)} -p ${shQuote(NGINX_CONFIG_DIR)} -c ${staged} -t`,
        `if cmp -s ${staged} ${live} 2>/dev/null; then rm -f ${staged}; else mv -f ${staged} ${live}; fi`,
      ].join(" && ");
    };
    const reloadNginxIfConfigChangedCmd = () => {
      const config = shQuote(NGINX_CONFIG_PATH);
      const active = nginxRuntimeActiveCmd();
      const start = startManagedServiceCmd(NGINX_SERVICE_NAME);
      const configHash = nginxConfigHashCmd();
      const reload = `${shQuote(NGINX_BIN)} -p ${shQuote(NGINX_CONFIG_DIR)} -c ${config} -s reload || { [ -s /run/forwardx-nginx.pid ] && kill -HUP "$(cat /run/forwardx-nginx.pid)" 2>/dev/null; }`;
      return `new_hash=$(${configHash}); old_hash=$(cat ${config}.sha256 2>/dev/null || true); if [ -z "$new_hash" ]; then echo "[service] ${NGINX_SERVICE_NAME} config hash failed"; exit 1; fi; if [ "$new_hash" != "$old_hash" ] || ! { ${active}; }; then if { ${active}; }; then ${reload} || { echo "[service] ${NGINX_SERVICE_NAME} reload failed"; exit 1; }; else ${start}; fi; printf '%s' "$new_hash" > ${config}.sha256; else echo "[service] ${NGINX_SERVICE_NAME} config unchanged"; fi`;
    };
    const buildNginxRuntimeSyncCmds = async () => {
      const startedAt = Date.now();
      const upstreams: string[] = [];
      const servers: string[] = [];
      const certCmds: string[] = [];
      const certFingerprints: string[] = [];
      const certKeys = new Set<string>();
      const countingCmds: string[] = [];
      const routeSummaries: string[] = [];
      const warnNginxRoute = (message: string) => {
        const key = `nginx:${Number(host.id)}:${message}`;
        if (tunnelRouteLogCache.get(key) === message) return;
        tunnelRouteLogCache.set(key, message);
        appendPanelLog("warn", message);
      };
      const logNginxRoute = (message: string) => {
        const key = `nginx:${Number(host.id)}:${message}`;
        if (tunnelRouteLogCache.get(key) === message) return;
        tunnelRouteLogCache.set(key, message);
        appendPanelLog("info", message);
      };
      const nginxTunnelCert = (tunnel: any) => {
        const id = Number(tunnel?.id || 0);
        const certPem = String(tunnel?.certPem || "").trim();
        const keyPem = String(tunnel?.certKeyPem || "").trim();
        if (!id || !certPem || !keyPem) return null;
        const normalizedCertPem = certPem.endsWith("\n") ? certPem : `${certPem}\n`;
        const normalizedKeyPem = keyPem.endsWith("\n") ? keyPem : `${keyPem}\n`;
        const fingerprint = crypto.createHash("sha256").update(`${normalizedCertPem}\n${normalizedKeyPem}`).digest("hex");
        const fileKey = fingerprint.slice(0, 16);
        return {
          certPath: `${NGINX_CERT_DIR}/tunnel-${id}-${fileKey}.crt`,
          keyPath: `${NGINX_CERT_DIR}/tunnel-${id}-${fileKey}.key`,
          certPem: normalizedCertPem,
          keyPem: normalizedKeyPem,
          fingerprint,
          serverName: String(tunnel?.certDomain || "").trim() || null,
        };
      };
      const ensureNginxTunnelCert = (tunnel: any) => {
        const cert = nginxTunnelCert(tunnel);
        if (!cert) return null;
        const key = `${cert.certPath}:${cert.keyPath}`;
        if (!certKeys.has(key)) {
          certKeys.add(key);
          certFingerprints.push(`# cert tunnel-${Number(tunnel?.id || 0)} ${cert.fingerprint}`);
          certCmds.push(
            `printf '%s' '${Buffer.from(cert.certPem, "utf8").toString("base64")}' | base64 -d > ${shQuote(cert.certPath)}`,
            `printf '%s' '${Buffer.from(cert.keyPem, "utf8").toString("base64")}' | base64 -d > ${shQuote(cert.keyPath)}`,
            `chmod 0644 ${shQuote(cert.certPath)} 2>/dev/null || true`,
            `chmod 0600 ${shQuote(cert.keyPath)} 2>/dev/null || true`,
          );
        }
        return cert;
      };
      const addUpstreamServer = (name: string, endpoints: Array<{ addr: string; primary?: boolean }>, strategy?: unknown) => {
        const block = nginxUpstreamBlock(name, endpoints, strategy);
        if (!block) return false;
        upstreams.push(block);
        return true;
      };
      const addServer = (options: Parameters<typeof nginxServerBlock>[0]) => {
        if (!options.listenPort || !options.upstream) return;
        servers.push(nginxServerBlock(options));
      };

      for (const rule of agentHostRules as any[]) {
        if (!rule || rule.pendingDelete || !rule.isEnabled || rule.forwardType !== "nginx") continue;
        if (!isRuleProtocolEnabled(forwardProtocolSettings, rule, null)) continue;
        const useRuleGuard = await shouldUseRuleGuard(rule);
        const listenPort = useRuleGuard ? guardBackendPort(rule) : Number(rule.sourcePort);
        for (const proto of nginxProtocolsForRule(rule)) {
          const upstream = `fwx_rule_${Number(rule.id)}_${proto}`;
          if (!addUpstreamServer(upstream, [{ addr: nginxEndpoint(processTarget(rule), rule.targetPort), primary: true }])) continue;
          routeSummaries.push(`rule=${rule.id} port=${Number(rule.sourcePort)} listen=${listenPort} proto=${proto} target=${processTarget(rule)}:${Number(rule.targetPort) || 0}`);
          addServer({
            name: `rule ${Number(rule.id)} ${proto}`,
            listenPort,
            proto,
            upstream,
          });
        }
        countingCmds.push(...buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol));
        countingCmds.push(...buildRuleAccessLimitCmds(rule));
      }

      for (const rule of agentHostRules as any[]) {
        if (!rule || rule.pendingDelete || !rule.isEnabled || rule.forwardType !== "gost" || !rule.tunnelId) continue;
        const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
        if (!tunnel || !tunnel.isEnabled || !isNginxTunnelMode(tunnel) || !isCurrentHostTunnelEntry(tunnel)) continue;
        if (!isTunnelProtocolEnabled(forwardProtocolSettings, tunnel) || !isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel)) continue;
        const cert = ensureNginxTunnelCert(tunnel);
        const endpoints: Array<{ addr: string; primary?: boolean }> = [];
        for (const endpoint of tunnelExitEndpointsForRule(rule, tunnel)) {
          const exitHost = endpoint.primary
            ? (tunnelExitEndpointById.get(tunnel.id)?.host || await tunnelExitHostAddress(tunnel))
            : await getExtraExitDialAddress(endpoint.node);
          const addr = nginxEndpoint(exitHost, endpoint.listenPort);
          if (addr) {
            endpoints.push({ addr, primary: endpoint.primary });
            continue;
          }
          warnNginxRoute(`[NginxRuntime] missing endpoint host=${host.id} name=${String(host.name || "-")} tunnel=${tunnel.id} rule=${rule.id} exitHost=${endpoint.exitHostId} listenPort=${endpoint.listenPort || "-"} primary=${endpoint.primary}`);
        }
        if (endpoints.length === 0) {
          warnNginxRoute(`[NginxRuntime] skipped tunnel entry host=${host.id} name=${String(host.name || "-")} tunnel=${tunnel.id} rule=${rule.id} reason=no-endpoints`);
          continue;
        }
        routeSummaries.push(`entry rule=${rule.id} tunnel=${tunnel.id} port=${Number(rule.sourcePort)} endpoints=${endpoints.map((item) => item.addr).join(",")}`);
        for (const proto of nginxProtocolsForRule(rule)) {
          const upstream = `fwx_tentry_${Number(rule.id)}_${proto}`;
          if (!addUpstreamServer(upstream, endpoints, (tunnel as any).loadBalanceStrategy)) continue;
          addServer({
            name: `tunnel entry ${Number(tunnel.id)} rule ${Number(rule.id)} ${proto}`,
            listenPort: Number(rule.sourcePort),
            proto,
            upstream,
            sslClient: proto === "tcp" && cert ? { serverName: cert.serverName } : null,
          });
        }
        countingCmds.push(...buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol));
        countingCmds.push(...buildRuleAccessLimitCmds(rule));
      }

      const nginxBusinessListenKeys = new Set<string>();
      for (const rule of nginxTunnelExitRules as any[]) {
        const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
        if (!tunnel || !isNginxTunnelMode(tunnel)) continue;
        const cert = ensureNginxTunnelCert(tunnel);
        for (const exitPort of currentHostTunnelExitPortsForRule(rule, tunnel)) {
          nginxBusinessListenKeys.add(`${Number(host.id)}:${Number(exitPort)}`);
          routeSummaries.push(`exit rule=${rule.id} tunnel=${tunnel.id} host=${Number(host.id)} listen=${Number(exitPort)} target=${processTarget(rule)}:${Number(rule.targetPort) || 0}`);
          for (const proto of nginxProtocolsForRule(rule)) {
            const upstream = `fwx_texit_${Number(tunnel.id)}_${Number(rule.id)}_${Number(exitPort)}_${proto}`;
            if (!addUpstreamServer(upstream, [{ addr: nginxEndpoint(processTarget(rule), rule.targetPort), primary: true }])) continue;
            addServer({
              name: `tunnel exit ${Number(tunnel.id)} rule ${Number(rule.id)} port ${Number(exitPort)} ${proto}`,
              listenPort: Number(exitPort),
              proto,
              upstream,
              sslServer: proto === "tcp" && cert ? { certPath: cert.certPath, keyPath: cert.keyPath } : null,
            });
          }
          countingCmds.push(...buildCountingChainCmds(Number(exitPort), rule.targetIp, rule.targetPort, rule.protocol));
        }
      }

      for (const tunnel of hostTunnels as any[]) {
        if (!tunnel || !tunnel.isEnabled || !isNginxTunnelMode(tunnel) || !isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)) continue;
        const cert = ensureNginxTunnelCert(tunnel);
        const probePorts: number[] = [];
        if (Number(tunnel.exitHostId) === Number(host.id)) probePorts.push(Number(tunnel.listenPort) || 0);
        for (const exitNode of tunnelExtraExitNodes(tunnel)) {
          if (Number((exitNode as any).hostId || 0) === Number(host.id)) probePorts.push(Number((exitNode as any).listenPort || 0));
        }
        for (const listenPort of Array.from(new Set(probePorts.filter((port) => port > 0)))) {
          if (nginxBusinessListenKeys.has(`${Number(host.id)}:${listenPort}`)) continue;
          const upstream = `fwx_tprobe_${Number(tunnel.id)}_${listenPort}`;
          if (!addUpstreamServer(upstream, [{ addr: "127.0.0.1:9", primary: true }])) continue;
          addServer({
            name: `tunnel probe ${Number(tunnel.id)} port ${listenPort}`,
            listenPort,
            proto: "tcp",
            upstream,
            sslServer: cert ? { certPath: cert.certPath, keyPath: cert.keyPath } : null,
          });
        }
      }

      const hasServers = servers.length > 0;
      const configSignature = crypto.createHash("sha256")
        .update(JSON.stringify({ hostId: Number(host.id), upstreams, servers, certFingerprints, counting: countingCmds.length }))
        .digest("hex");
      const previousSignature = nginxRuntimeLogCache.get(Number(host.id));
      if (previousSignature !== configSignature) {
        nginxRuntimeLogCache.set(Number(host.id), configSignature);
        logNginxRoute(`[NginxRuntime] host=${host.id} name=${String(host.name || "-")} servers=${servers.length} upstreams=${upstreams.length} certs=${certKeys.size} counting=${countingCmds.length} routes=${routeSummaries.length} elapsedMs=${Date.now() - startedAt}`);
        for (const summary of routeSummaries.slice(0, 20)) {
          logNginxRoute(`[NginxRuntime] host=${host.id} ${summary}`);
        }
        if (routeSummaries.length > 20) {
          logNginxRoute(`[NginxRuntime] host=${host.id} routeDetailsOmitted=${routeSummaries.length - 20}`);
        }
      }
      const config = [
        `include ${NGINX_CONFIG_DIR}/modules.conf;`,
        "worker_processes auto;",
        "error_log /var/log/forwardx-agent/forwardx-nginx-error.log warn;",
        "pid /run/forwardx-nginx.pid;",
        ...certFingerprints.sort(),
        "",
        "events {",
        "  worker_connections 65535;",
        "}",
        "",
        ...(hasServers ? [
          "stream {",
          "  tcp_nodelay on;",
          "  resolver 1.1.1.1 8.8.8.8 valid=60s ipv6=on;",
          "",
          ...upstreams.flatMap((block) => [block, ""]),
          ...servers.flatMap((block) => [block, ""]),
          "}",
          "",
        ] : []),
      ].join("\n");
      const encodedConfig = Buffer.from(config, "utf8").toString("base64");
      const cmds = [
        `mkdir -p ${shQuote(NGINX_CONFIG_DIR)} ${shQuote(NGINX_CERT_DIR)} /var/log/forwardx-agent`,
        ...certCmds,
        `modules_conf=${shQuote(`${NGINX_CONFIG_DIR}/modules.conf`)}; : > "$modules_conf"; for mod in /usr/lib/nginx/modules/ngx_stream_module.so /usr/lib64/nginx/modules/ngx_stream_module.so /usr/share/nginx/modules/ngx_stream_module.so modules/ngx_stream_module.so; do if [ -s "$mod" ]; then printf 'load_module %s;\\n' "$mod" > "$modules_conf"; break; fi; done`,
      ];
      if (hasServers) {
        const nginxApplyCmd = [
          deployNginxConfigCmd(encodedConfig),
          writeManagedServiceCmd(NGINX_SERVICE_NAME, [
            "[Unit]",
            "Description=ForwardX managed Nginx stream runtime",
            "After=network.target",
            "",
            "[Service]",
            "Type=simple",
            `ExecStart=${NGINX_BIN} -p ${NGINX_CONFIG_DIR} -c ${NGINX_CONFIG_PATH} -g "daemon off;"`,
            `ExecReload=${NGINX_BIN} -p ${NGINX_CONFIG_DIR} -c ${NGINX_CONFIG_PATH} -s reload`,
            "Restart=always",
            "RestartSec=5",
            "LimitNOFILE=65535",
            "",
            "[Install]",
            "WantedBy=multi-user.target",
            "",
          ].join("\n")),
          ...(anyTunnelDnsRefresh(hostTunnels as any[]) ? [dnsRuntimeRefreshCmd("nginx"), `rm -f ${shQuote(`${NGINX_CONFIG_PATH}.sha256`)} 2>/dev/null || true`] : []),
          reloadNginxIfConfigChangedCmd(),
        ].filter(Boolean).map((cmd) => `(${cmd})`).join(" && ");
        cmds.unshift(ensureNginxBinaryCmd());
        cmds.push(nginxApplyCmd);
      } else {
        cmds.push(
          `rm -f ${shQuote(NGINX_STAGED_CONFIG_PATH)} 2>/dev/null || true`,
          stopManagedServiceCmd(NGINX_SERVICE_NAME),
          `rm -f ${shQuote(`${NGINX_CONFIG_PATH}.sha256`)} 2>/dev/null || true`,
        );
      }
      cmds.push(...countingCmds);
      return cmds;
    };
    let nginxRuntimeSyncCmdsPromise: Promise<string[]> | null = null;
    const getNginxRuntimeSyncCmds = () => {
      if (!nginxRuntimeSyncCmdsPromise) {
        nginxRuntimeSyncCmdsPromise = buildNginxRuntimeSyncCmds();
      }
      return nginxRuntimeSyncCmdsPromise;
    };

    const buildGostRuntimeSyncCmds = async () => [
      tunnelRuntimeGenerationCmd(),
      ...buildGostReloadCmds(),
      ...await buildTunnelReloadCmds(),
      ...await getNginxRuntimeSyncCmds(),
      ...buildMimicRuntimeSyncCmds(),
    ].filter(Boolean);

    const ruleTrafficPort = (rule: any) => {
      const tunnel = rule.tunnelId ? tunnelById.get(rule.tunnelId) as any : null;
      if (tunnel && (isGostTunnelMode(tunnel) || isNginxTunnelMode(tunnel))) {
        return currentHostTunnelExitPortsForRule(rule, tunnel)[0] || 0;
      }
      return Number(rule.sourcePort) || 0;
    };
    const runningRules: { ruleId: number; tunnelId?: number; sourcePort: number; targetIp: string; targetPort: number; protocol: string; forwardType: string; failover?: any }[] = [];
    const runningRuleSeen = new Set<string>();
    const guardRules: any[] = [];
    const addRunningRule = (rule: { ruleId: number; tunnelId?: number; sourcePort: number; targetIp: string; targetPort: number; protocol: string; forwardType: string; failover?: any }) => {
      if (!rule.ruleId || !rule.sourcePort) return;
      const key = `${Number(rule.ruleId)}:${Number(rule.sourcePort)}`;
      if (runningRuleSeen.has(key)) return;
      runningRuleSeen.add(key);
      runningRules.push(rule);
    };

    const isKernelForwardRule = (rule: any) => {
      const forwardType = String(rule?.forwardType || "").trim();
      return forwardType === "iptables" || forwardType === "nftables";
    };
    const buildDisabledRuleRemovalAction = async (rule: any) => {
      const tunnel = (rule as any).tunnelId ? tunnelById.get((rule as any).tunnelId) as any : null;
      if (rule.forwardType === "iptables") {
        const cmds: string[] = [
          ...buildIptablesForwardCleanupCmds(rule),
          ...buildCountingCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
          ...buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule)),
        ];
        return {
          ruleId: rule.id,
          op: "remove",
          forwardType: rule.forwardType,
          sourcePort: rule.sourcePort,
          targetIp: rule.targetIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
          commands: cmds,
        };
      }
      if (rule.forwardType === "nftables") {
        const cmds = [
          ...buildNftCleanupCmds(rule, { removeStateFiles: false, cleanupConntrack: true }),
          ...buildManagedPortCleanupCmds(Number(rule.sourcePort), rule.targetIp, rule.targetPort, rule.protocol),
        ];
        cmds.push(...buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule)));
        return {
          ruleId: rule.id,
          op: "remove",
          forwardType: rule.forwardType,
          sourcePort: rule.sourcePort,
          targetIp: rule.targetIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
          commands: cmds,
        };
      }
      if (rule.forwardType === "realm") {
        const svcName = `forwardx-realm-${rule.sourcePort}`;
        const realmConfigPath = realmConfigPathForPort(rule.sourcePort);
        return {
          ruleId: rule.id,
          op: "remove",
          forwardType: rule.forwardType,
          sourcePort: rule.sourcePort,
          targetIp: rule.targetIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
          svcName,
          commands: [
            removeManagedServiceCmd(svcName),
            killByPatternCmd(`[r]ealm .*${realmConfigPath}`),
            `rm -f ${shQuote(realmConfigPath)} ${shQuote(`${realmConfigPath}.sha256`)} 2>/dev/null || true`,
            ...cleanupGuardBackendCmds(rule),
            `rm -f /var/lib/forwardx-agent/traffic_${rule.sourcePort}.prev 2>/dev/null || true`,
            `rm -f /var/lib/forwardx-agent/port_${rule.sourcePort}.rule /var/lib/forwardx-agent/port_${rule.sourcePort}.tunnel 2>/dev/null || true`,
            ...buildCountingCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
            ...buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule)),
          ],
        };
      }
      if (rule.forwardType === "socat") {
        const removeCmds: string[] = [];
        if (normalizeForwardRuleProtocol(rule.protocol) === "both") {
          const svcTcp = `forwardx-socat-tcp-${rule.sourcePort}`;
          const svcUdp = `forwardx-socat-udp-${rule.sourcePort}`;
          removeCmds.push(removeManagedServiceCmd(svcTcp));
          removeCmds.push(removeManagedServiceCmd(svcUdp));
        } else {
          const svcName = `forwardx-socat-${rule.sourcePort}`;
          removeCmds.push(removeManagedServiceCmd(svcName));
        }
        removeCmds.push(killByPatternCmd(`[s]ocat.*LISTEN:${rule.sourcePort}`));
        removeCmds.push(...cleanupGuardBackendCmds(rule));
        removeCmds.push(`rm -f /var/lib/forwardx-agent/traffic_${rule.sourcePort}.prev 2>/dev/null || true`);
        removeCmds.push(`rm -f /var/lib/forwardx-agent/port_${rule.sourcePort}.rule /var/lib/forwardx-agent/port_${rule.sourcePort}.tunnel 2>/dev/null || true`);
        removeCmds.push(...buildCountingCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol));
        removeCmds.push(...buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule)));
        return {
          ruleId: rule.id,
          op: "remove",
          forwardType: rule.forwardType,
          sourcePort: rule.sourcePort,
          targetIp: rule.targetIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
          commands: removeCmds,
        };
      }
      if (rule.forwardType === "nginx") {
        return {
          ruleId: rule.id,
          op: "remove",
          forwardType: rule.forwardType,
          sourcePort: rule.sourcePort,
          targetIp: rule.targetIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
          commands: [
            ...buildNginxPortCleanupCmds(rule),
            ...cleanupGuardBackendCmds(rule),
          ],
        };
      }
      if (rule.forwardType === "gost") {
        if (tunnel && isNginxTunnelMode(tunnel)) {
          return {
            ruleId: rule.id,
            tunnelId: tunnel.id,
            statusType: "rule",
            op: "remove",
            forwardType: "nginx-tunnel",
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            commands: [
              ...buildNginxPortCleanupCmds(rule),
              ...cleanupGuardBackendCmds(rule),
            ],
          };
        }
        const fxpRemoveKey = tunnel && isForwardXTunnel(tunnel)
          ? (await forwardXEntryRoute(tunnel)).key
          : "";
        return {
          tunnelId: tunnel ? tunnel.id : 0,
          statusType: tunnel ? "rule" : undefined,
          ruleId: rule.id,
          op: "remove",
          forwardType: rule.forwardType,
          sourcePort: rule.sourcePort,
          targetIp: rule.targetIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
          commands: [
            ...buildManagedPortCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
            ...cleanupGuardBackendCmds(rule),
          ],
          fxp: tunnel && isForwardXTunnel(tunnel) ? {
            role: "entry",
            tunnelId: tunnel.id,
            ruleId: rule.id,
            listenPort: rule.sourcePort,
            protocol: rule.protocol,
            key: fxpRemoveKey || tunnelSecretSeed(tunnel),
          } : undefined,
        };
      }
      return null;
    };

    const reportedRuntimeState = localRuntimeState.state;
    const hasReportedRuntimeState = !!reportedRuntimeState;
    const localRulesByPort = new Map<number, AgentLocalRuntimeRuleState>();
    const localTunnelsByPort = new Map<number, AgentLocalRuntimeTunnelState>();
    const protectedRuleRemoveActionKeys = new Set<string>();
    for (const item of reportedRuntimeState?.rules || []) {
      if (Number(item.port) > 0) localRulesByPort.set(Number(item.port), item);
    }
    for (const item of reportedRuntimeState?.tunnels || []) {
      if (Number(item.port) > 0) localTunnelsByPort.set(Number(item.port), item);
    }
    const managedRuntimeServiceNames = new Set([RUNTIME_SERVICE_NAME, TUNNEL_RUNTIME_SERVICE_NAME, NGINX_SERVICE_NAME]);
    const runtimeServiceUnhealthy = hasReportedRuntimeState && (reportedRuntimeState?.services || [])
      .some((service: AgentLocalRuntimeServiceState) => (
        managedRuntimeServiceNames.has(String(service.name || "").trim())
        && service.hasWork
        && !service.active
      ));
    const expectedRulePorts = new Set<number>();
    const expectedTunnelPorts = new Set<number>();
    const forwardTypeCompatible = (local: unknown, expected: unknown) => {
      const localValue = String(local || "").trim();
      const expectedValue = String(expected || "").trim();
      if (!localValue || !expectedValue) return true;
      if (localValue === expectedValue) return true;
      return localValue === "gost" && (expectedValue === "forwardx" || expectedValue === "nginx-tunnel");
    };
    const localTextCompatible = (local: unknown, expected: unknown) => {
      const localValue = cleanEndpointHost(local).toLowerCase();
      const expectedValue = cleanEndpointHost(expected).toLowerCase();
      if (!localValue || !expectedValue) return true;
      return localValue === expectedValue;
    };
    const localNumberCompatible = (local: unknown, expected: unknown) => {
      const localValue = Number(local || 0);
      const expectedValue = Number(expected || 0);
      if (localValue <= 0 || expectedValue <= 0) return true;
      return localValue === expectedValue;
    };
    const localProtocolCompatible = (local: unknown, expected: unknown) => {
      const localValue = String(local || "").trim();
      const expectedValue = String(expected || "").trim();
      if (!localValue || !expectedValue) return true;
      return normalizeForwardRuleProtocol(localValue) === normalizeForwardRuleProtocol(expectedValue);
    };
    const localRuleMatches = (rule: any, expectedForwardType: string, port: number) => {
      if (!hasReportedRuntimeState || port <= 0) return true;
      const local = localRulesByPort.get(port);
      return !!local
        && local.ready !== false
        && Number(local.ruleId || 0) === Number(rule.id)
        && (Number(local.tunnelId || 0) <= 0 || Number(local.tunnelId || 0) === Number(rule?.tunnelId || 0))
        && forwardTypeCompatible(local.forwardType, expectedForwardType)
        && localTextCompatible(local.targetIp, processTarget(rule))
        && localNumberCompatible(local.targetPort, rule.targetPort)
        && localProtocolCompatible(local.protocol, rule.protocol);
    };
    const protectActiveRulePort = (rule: any, port = Number(rule?.sourcePort || 0)) => {
      const ruleId = Number(rule?.id || 0);
      if (ruleId <= 0 || port <= 0 || rule?.pendingDelete) return;
      protectedRuleRemoveActionKeys.add(actionPortKey({
        statusType: "rule",
        ruleId,
        sourcePort: port,
      }));
    };
    const localTunnelMatches = (tunnelId: number, expectedForwardType: string, port: number) => {
      if (!hasReportedRuntimeState || port <= 0) return true;
      const local = localTunnelsByPort.get(port);
      return !!local
        && local.ready !== false
        && Number(local.tunnelId || 0) === Number(tunnelId)
        && forwardTypeCompatible(local.forwardType, expectedForwardType);
    };
    const buildGenericLocalRuleRemovalAction = (local: AgentLocalRuntimeRuleState) => {
      const port = Number(local.port || 0);
      const forwardType = String(local.forwardType || "").trim() || "unknown";
      const protocol = local.protocol || "both";
      const cleanupCmds = SHARED_NGINX_FORWARD_TYPES.has(forwardType)
        ? buildNginxPortCleanupCmds({
          sourcePort: port,
          targetIp: local.targetIp || "",
          targetPort: Number(local.targetPort || 0),
          protocol,
        })
        : [
          ...buildManagedPortCleanupCmds(port, local.targetIp, local.targetPort, protocol),
          `for pid in $(pgrep -f '[f]orwardx-fxp.*fxp-.*-${port}\\\\.json' 2>/dev/null || true); do if [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ]; then continue; fi; kill "$pid" 2>/dev/null || true; done`,
          `rm -f /run/forwardx-agent/fxp-*-${port}.json /var/lib/forwardx-agent/tunnel_${port}.id /var/lib/forwardx-agent/tunnel_${port}.fwtype 2>/dev/null || true`,
        ];
      return {
        ruleId: Number(local.ruleId || 0),
        tunnelId: Number(local.tunnelId || 0),
        statusType: "rule",
        op: "remove",
        forwardType,
        sourcePort: port,
        targetIp: local.targetIp || "",
        targetPort: Number(local.targetPort || 0),
        protocol,
        commands: cleanupCmds,
      };
    };
    const buildGenericLocalTunnelRemovalAction = (local: AgentLocalRuntimeTunnelState) => {
      const port = Number(local.port || 0);
      const forwardType = String(local.forwardType || "").trim() || "gost-tunnel";
      const cleanupCmds = SHARED_NGINX_FORWARD_TYPES.has(forwardType)
        ? [
          ...buildNginxPortCleanupCmds({
            sourcePort: port,
            targetIp: "",
            targetPort: port,
            protocol: "tcp",
          }),
          `rm -f /var/lib/forwardx-agent/tunnel_${port}.id /var/lib/forwardx-agent/tunnel_${port}.fwtype 2>/dev/null || true`,
        ]
        : [
          ...buildManagedPortCleanupCmds(port),
          `for pid in $(pgrep -f '[f]orwardx-fxp.*fxp-.*-${port}\\\\.json' 2>/dev/null || true); do if [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ]; then continue; fi; kill "$pid" 2>/dev/null || true; done`,
          `rm -f /run/forwardx-agent/fxp-*-${port}.json /var/lib/forwardx-agent/tunnel_${port}.id /var/lib/forwardx-agent/tunnel_${port}.fwtype 2>/dev/null || true`,
        ];
      return {
        tunnelId: Number(local.tunnelId || 0),
        statusType: "tunnel",
        ruleId: 0,
        op: "remove",
        forwardType,
        sourcePort: port,
        targetIp: "",
        targetPort: port,
        protocol: "tcp",
        commands: cleanupCmds,
      };
    };
    const localRuleNeedsRemoval = (rule: any) => {
      if (!hasReportedRuntimeState) return true;
      const port = Number(rule?.sourcePort || 0);
      if (port <= 0) return true;
      const local = localRulesByPort.get(port);
      if (!local) return true;
      if (isKernelForwardRule(rule)) return true;
      return Number(local.ruleId || 0) === Number(rule?.id || 0);
    };
    const shouldForceStoppedKernelRuleCleanup = (rule: any) => supportsDesiredState && isKernelForwardRule(rule) && localRuleNeedsRemoval(rule);

    const settleStoppedRule = async (rule: any) => {
      const id = Number(rule?.id || 0);
      if (id <= 0) return;
      if ((rule as any).pendingDelete) {
        await db.finalizeForwardRuleDelete(id);
      } else {
        await db.updateRuleRunningStatus(id, false);
      }
      rule.isRunning = false;
    };

    const pendingTunnelExitRuleIds = new Set(
      tunnelExitRules
        .filter((rule: any) => !rule.isRunning)
        .map((rule: any) => Number(rule.tunnelId))
    );
    for (const tunnel of hostTunnels as any[]) {
      const isCurrentHostPrimaryExit = Number(tunnel.exitHostId) === Number(host.id);
      const currentHostExtraExitNode = (tunnelExitNodesByTunnelId.get(Number(tunnel.id)) || [])
        .find((node: any) => node?.isEnabled !== false && Number(node.hostId) === Number(host.id));
      const isCurrentHostExtraExit = !!currentHostExtraExitNode;
      const existingHops = tunnelHopsByTunnelId.get(Number(tunnel.id));
      const fxpTunnel = isForwardXTunnel(tunnel);
      const isCurrentHostGostExtraExit = !fxpTunnel && isCurrentHostExtraExit;
      if (!isCurrentHostPrimaryExit && !(fxpTunnel && isCurrentHostExtraExit) && !isCurrentHostGostExtraExit) continue;
      if (Array.isArray(existingHops) && existingHops.length >= (fxpTunnel ? 2 : 3) && !isCurrentHostExtraExit) continue;
      const fxpListenPort = isCurrentHostPrimaryExit
        ? Number(tunnel.listenPort)
        : Number((currentHostExtraExitNode as any)?.listenPort || 0);
      const runtimeReady = (fxpTunnel || isCurrentHostGostExtraExit)
        ? isTunnelRuntimeHostReady(Number(tunnel.id), Number(host.id))
        : false;
      const shouldRefreshExit = fxpTunnel
        ? !runtimeReady
        : (!tunnel.isRunning || pendingTunnelExitRuleIds.has(Number(tunnel.id)) || (isCurrentHostGostExtraExit && !runtimeReady));
      const tunnelProtocolEnabled = isTunnelProtocolEnabled(forwardProtocolSettings, tunnel);
      if (fxpTunnel && tunnelProtocolEnabled && tunnelNeedsMimic(tunnel)) {
        addMimicLocalFilterForPort(fxpListenPort);
      }
      const tunnelSourcePort = fxpTunnel ? fxpListenPort : (isCurrentHostPrimaryExit ? Number(tunnel.listenPort) : Number((currentHostExtraExitNode as any)?.listenPort || 0));
      const tunnelForwardType = fxpTunnel ? "forwardx-tunnel" : "gost-tunnel";
      if (tunnel.isEnabled && tunnelProtocolEnabled && tunnelSourcePort > 0) {
        expectedTunnelPorts.add(tunnelSourcePort);
      }
      const shouldRepairLocalExit = tunnel.isEnabled
        && tunnelProtocolEnabled
        && tunnelSourcePort > 0
        && !localTunnelMatches(Number(tunnel.id), tunnelForwardType, tunnelSourcePort);
      if (tunnel.isEnabled && tunnelProtocolEnabled && (shouldRefreshExit || shouldRepairLocalExit)) {
        actions.push({
          tunnelId: tunnel.id,
          statusType: "tunnel",
          ruleId: 0,
          op: "apply",
          forwardType: tunnelForwardType,
          sourcePort: tunnelSourcePort,
          targetIp: host.ip,
          targetPort: tunnelSourcePort,
          protocol: "tcp",
          commands: [],
            fxp: fxpTunnel && fxpListenPort > 0 ? {
              role: "exit",
              tunnelId: tunnel.id,
              ruleId: 0,
              listenPort: fxpListenPort,
              protocol: "both",
              key: tunnelSecretSeed(tunnel),
              dnsGeneration: tunnelDnsGeneration(tunnel),
            } : undefined,
        });
      } else if ((!tunnel.isEnabled || !tunnelProtocolEnabled) && (fxpTunnel ? runtimeReady : tunnel.isRunning)) {
        actions.push({
          tunnelId: tunnel.id,
          statusType: "tunnel",
          ruleId: 0,
          op: "remove",
          forwardType: tunnelForwardType,
          sourcePort: tunnelSourcePort,
          targetIp: host.ip,
          targetPort: tunnelSourcePort,
          protocol: "tcp",
          commands: [],
            fxp: fxpTunnel && fxpListenPort > 0 ? {
              role: "exit",
              tunnelId: tunnel.id,
              ruleId: 0,
              listenPort: fxpListenPort,
              protocol: "both",
              key: tunnelSecretSeed(tunnel),
              dnsGeneration: tunnelDnsGeneration(tunnel),
            } : undefined,
        });
      }
    }

    // Find multi-hop tunnels involving this host
    if (hostTunnels && hostTunnels.length > 0) {
      for (const tunnel of hostTunnels as any[]) {
        const hops = await hopRepo.getTunnelHops(Number(tunnel.id));
        if (!hops || hops.length < 2) continue; // Not a multi-hop tunnel

        const hostIdx = hops.findIndex((h: any) => Number(h.hostId) === host.id);
        if (hostIdx < 0) continue; // This host is not a hop in this tunnel

        const isFXP = isForwardXTunnel(tunnel);
        const multiHopRuntimeReady = isTunnelRuntimeHostReady(Number(tunnel.id), Number(host.id));
        const listenPortValue = Number((hops[hostIdx] as any)?.listenPort || 0);
        const tunnelForwardType = isFXP ? "forwardx-tunnel" : "gost-tunnel";
        if (tunnel.isEnabled && listenPortValue > 0) {
          expectedTunnelPorts.add(listenPortValue);
        }
        const shouldRepairLocalHop = tunnel.isEnabled
          && listenPortValue > 0
          && !localTunnelMatches(Number(tunnel.id), tunnelForwardType, listenPortValue);
        const shouldApply = tunnel.isEnabled && (!multiHopRuntimeReady || shouldRepairLocalHop);
        const shouldRemove = isFXP ? !tunnel.isEnabled : !tunnel.isEnabled && (tunnel.isRunning || multiHopRuntimeReady);

        if (!shouldApply && !shouldRemove) continue;

        const op = shouldApply ? "apply" : "remove";
        const { listenPort } = hops[hostIdx] as any;
        const isFirst = hostIdx === 0;

        if (isFXP) {
          if (!isFirst && tunnelNeedsMimic(tunnel)) {
            addMimicLocalFilterForPort(listenPort);
          }
          // ForwardX multi-hop
          if (isFirst) {
            actions.push({
              tunnelId: tunnel.id,
              statusType: "tunnel",
              ruleId: 0,
              op,
              forwardType: "forwardx-tunnel",
              sourcePort: Number(listenPort),
              targetIp: host.ip,
              targetPort: Number(listenPort),
              protocol: "tcp",
              commands: [],
            } as any);
            continue;
          }
          const fxpSpec = await buildForwardXHopSpec(tunnel, hops, hostIdx, op);
          if (!fxpSpec) continue;
          // Exit (isLast): just listens, target from helloFrame via rules

          actions.push({
            tunnelId: tunnel.id,
            statusType: "tunnel",
            ruleId: 0,
            op,
            forwardType: "forwardx-tunnel",
            sourcePort: Number(listenPort),
            targetIp: host.ip,
            targetPort: Number(listenPort),
            protocol: "tcp",
            commands: [],
            fxp: fxpSpec,
          } as any);
        } else {
          // GOST multi-hop config is refreshed by the shared runtime sync action.
          if (shouldApply) {
            actions.push({
              tunnelId: tunnel.id,
              statusType: "tunnel",
              ruleId: 0,
              op: "apply",
              forwardType: "gost-tunnel",
              sourcePort: Number(listenPort),
              targetIp: host.ip,
              targetPort: Number(listenPort),
              protocol: "tcp",
              commands: [],
            } as any);
          } else {
            actions.push({
              tunnelId: tunnel.id,
              statusType: "tunnel",
              ruleId: 0,
              op: "remove",
              forwardType: "gost-tunnel",
              sourcePort: Number(listenPort),
              targetIp: host.ip,
              targetPort: Number(listenPort),
              protocol: "tcp",
              commands: [],
            } as any);
          }
        }
      }
    }

    for (const rule of rules) {
      if ((rule as any)._skipRuntimeApply) continue;
      const ruleTunnel = (rule as any).tunnelId ? tunnelById.get((rule as any).tunnelId) as any : null;
      const ruleProtocolEnabled = isRuleProtocolEnabled(forwardProtocolSettings, rule, ruleTunnel);
      const useRuleGuard = await shouldUseRuleGuard(rule);
      const ruleGuardPolicy = useRuleGuard ? await ruleProtocolPolicy(rule) : emptyProtocolPolicy;
      if (rule.isEnabled && ruleProtocolEnabled && rule.forwardType === "gost" && ruleTunnel && isForwardXTunnel(ruleTunnel)) {
        await collectMimicFiltersForRule(rule, ruleTunnel);
      }
      if (!ruleProtocolEnabled) {
        const forceKernelCleanup = shouldForceStoppedKernelRuleCleanup(rule);
        if (rule.isRunning || forceKernelCleanup) {
          if (!localRuleNeedsRemoval(rule) && !forceKernelCleanup) {
            await settleStoppedRule(rule);
            continue;
          }
          const removeAction = await buildDisabledRuleRemovalAction(rule);
          if (removeAction) actions.push(removeAction);
        }
        continue;
      }
      // 收集所有已运行的规则映射（无论是否有 action 下发）
      if (rule.isEnabled && rule.isRunning) {
        const trafficPort = ruleTrafficPort(rule);
        if (!trafficPort) continue;
        if (useRuleGuard) {
          const guardTarget = guardTargetForRule(rule, useRuleGuard);
          guardRules.push({
            ruleId: rule.id,
            tunnelId: 0,
            listenPort: Number(rule.sourcePort),
            targetIp: guardTarget.targetIp,
            targetPort: guardTarget.targetPort,
            backendPort: guardTarget.backendPort,
            backendForwardType: guardTarget.backendForwardType,
            protocol: normalizeForwardRuleProtocol(rule.protocol),
            policy: ruleGuardPolicy,
            proxyProtocolReceive: proxyProtocolEnabled(rule, "receive"),
            proxyProtocolSend: guardTarget.backendPort > 0
              ? (proxyProtocolEnabled(rule, "send") || proxyProtocolEnabled(rule, "receive"))
              : proxyProtocolEnabled(rule, "send"),
            proxyProtocolVersion: proxyProtocolVersion(rule),
          });
        }
        const runningForwardType = rule.forwardType === "gost" && ruleTunnel && isForwardXTunnel(ruleTunnel)
          ? "forwardx"
          : useRuleGuard
          ? "guard"
          : rule.forwardType;
        addRunningRule({
          ruleId: rule.id,
          tunnelId: ruleTunnel ? Number(ruleTunnel.id) : 0,
          sourcePort: trafficPort,
          targetIp: rule.targetIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
          forwardType: runningForwardType,
          failover: failoverForCurrentHost(rule, ruleTunnel, { listenPort: failoverProxyPort(rule) }),
        });
      }

      const ruleTunnelHops = ruleTunnel ? tunnelHopsByTunnelId.get(Number(ruleTunnel.id)) : null;
      const isCurrentTunnelEntryRule = !!ruleTunnel && isCurrentHostTunnelEntry(ruleTunnel);
      const isGostMultiHopRule = !!ruleTunnel
        && isGostTunnelMode(ruleTunnel)
        && Array.isArray(ruleTunnelHops)
        && ruleTunnelHops.length >= 3
        && ruleTunnelHops.some((hop: any) => Number(hop.hostId) === Number(host.id));
      const shouldRefreshTunnelEntryRule = isCurrentTunnelEntryRule
        && (isForwardXTunnel(ruleTunnel) || isGostMultiHopRule)
        && !isTunnelRuntimeHostReady(Number(ruleTunnel.id), Number(host.id));
      const isForwardXMultiHopRule = !!ruleTunnel
        && isForwardXTunnel(ruleTunnel)
        && Array.isArray(ruleTunnelHops)
        && ruleTunnelHops.length >= 3
        && ruleTunnelHops.some((hop: any) => Number(hop.hostId) === Number(host.id));
      const shouldRefreshForwardXMultiHopRule = isForwardXMultiHopRule
        && !isTunnelRuntimeHostReady(Number(ruleTunnel.id), Number(host.id));
      const isForwardXEntryRule = !!ruleTunnel
        && isForwardXTunnel(ruleTunnel)
        && isCurrentTunnelEntryRule;
      const shouldRefreshForwardXEntryRule = isForwardXEntryRule && shouldRefreshTunnelEntryRule;
      const shouldRefreshGuardBackend = useRuleGuard
        && shouldUseProcessBackendGuard(rule)
        && !rule.isRunning;
      const expectedRulePort = Number(rule.sourcePort) || 0;
      const expectedRuleForwardType = useRuleGuard
        ? "guard"
        : rule.forwardType === "gost" && ruleTunnel && isForwardXTunnel(ruleTunnel)
        ? "forwardx"
        : rule.forwardType === "gost" && ruleTunnel && isNginxTunnelMode(ruleTunnel)
        ? "nginx-tunnel"
        : rule.forwardType;
      if (rule.isEnabled && expectedRulePort > 0) {
        expectedRulePorts.add(expectedRulePort);
        protectActiveRulePort(rule, expectedRulePort);
      }
      const shouldRepairLocalRule = rule.isEnabled
        && expectedRulePort > 0
        && !localRuleMatches(rule, expectedRuleForwardType, expectedRulePort);
      if (rule.isEnabled && (!rule.isRunning || shouldRepairLocalRule || shouldRefreshTunnelEntryRule || shouldRefreshForwardXMultiHopRule || shouldRefreshGuardBackend)) {
        const cmds: string[] = [];
        if (useRuleGuard) {
          const guardTarget = guardTargetForRule(rule, useRuleGuard);
          const guardFailover = failoverForCurrentHost(rule, ruleTunnel, { listenPort: failoverProxyPort(rule) });
          guardRules.push({
            ruleId: rule.id,
            tunnelId: 0,
            listenPort: Number(rule.sourcePort),
            targetIp: guardTarget.targetIp,
            targetPort: guardTarget.targetPort,
            backendPort: guardTarget.backendPort,
            backendForwardType: guardTarget.backendForwardType,
            protocol: normalizeForwardRuleProtocol(rule.protocol),
            policy: ruleGuardPolicy,
            proxyProtocolReceive: proxyProtocolEnabled(rule, "receive"),
            proxyProtocolSend: guardTarget.backendPort > 0
              ? (proxyProtocolEnabled(rule, "send") || proxyProtocolEnabled(rule, "receive"))
              : proxyProtocolEnabled(rule, "send"),
            proxyProtocolVersion: proxyProtocolVersion(rule),
          });
          const guardBaseCleanupCmds = [
            ...buildManagedPortCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
            ...buildIptablesForwardCleanupCmds(rule),
            ...buildNftCleanupCmds(rule),
          ];
          const guardCountingCmds = [
            ...buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
            ...buildRuleAccessLimitCmds(rule),
          ];
          const guardAction: any = {
            ruleId: rule.id,
            op: "apply",
            forwardType: "guard",
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: normalizeForwardRuleProtocol(rule.protocol),
            networkInterface: hostInterface,
          };
          if (guardTarget.backendPort > 0 && rule.forwardType === "realm") {
            const svcName = `forwardx-realm-guard-${rule.sourcePort}`;
            const realmConfigPath = realmGuardConfigPathForPort(rule.sourcePort);
            const realmRemote = endpointHostPort(processTarget(rule), rule.targetPort);
            const realmConfig = [
              "[log]",
              'level = "warn"',
              "",
              "[network]",
              `use_udp = ${isForwardRuleProtocolUdpEnabled(rule.protocol) ? "true" : "false"}`,
              `zero_copy = ${(rule as any).zeroCopy && isForwardRuleProtocolTcpEnabled(rule.protocol) ? "true" : "false"}`,
              `fast_open = ${(rule as any).tcpFastOpen && isForwardRuleProtocolTcpEnabled(rule.protocol) ? "true" : "false"}`,
              "tcp_timeout = 300",
              "udp_timeout = 30",
              "ipv6_only = false",
              `send_proxy = ${proxyProtocolEnabled(rule, "send") ? "true" : "false"}`,
              `send_proxy_version = ${proxyProtocolVersion(rule)}`,
              `accept_proxy = ${(proxyProtocolEnabled(rule, "send") || proxyProtocolEnabled(rule, "receive")) ? "true" : "false"}`,
              "accept_proxy_timeout = 5",
              "",
              "[[endpoints]]",
              `listen = ${realmTomlString(`127.0.0.1:${guardTarget.backendPort}`)}`,
              `remote = ${realmTomlString(realmRemote)}`,
              "",
            ].join("\n");
            const realmConfigB64 = Buffer.from(realmConfig, "utf8").toString("base64");
            const ifaceFlag = hostInterface ? ` --interface ${hostInterface}` : "";
            const realmCmd = `/usr/local/bin/realm -c ${realmConfigPath}${ifaceFlag}`;
            guardAction.svcName = svcName;
            guardAction.unit = [
              "[Unit]",
              `Description=ForwardX guarded realm backend ${rule.sourcePort}->${rule.targetIp}:${rule.targetPort}`,
              "After=network.target",
              "",
              "[Service]",
              "Type=simple",
              `ExecStart=${realmCmd}`,
              "Restart=always",
              "RestartSec=5",
              "LimitNOFILE=65535",
              "",
              "[Install]",
              "WantedBy=multi-user.target",
              "",
            ].join("\n");
            guardAction.preCommands = [
              ...guardBaseCleanupCmds,
              ...cleanupGuardBackendCmds(rule, [svcName]),
              `mkdir -p ${shQuote(REALM_CONFIG_DIR)}`,
              `printf '%s' '${realmConfigB64}' | base64 -d > ${shQuote(realmConfigPath)}`,
            ];
            guardAction.commands = guardCountingCmds;
          } else if (guardTarget.backendPort > 0 && rule.forwardType === "socat") {
            let socatPreCmds: string[] = [];
            if (normalizeForwardRuleProtocol(rule.protocol) === "both") {
              const svcNameTcp = `forwardx-socat-guard-tcp-${rule.sourcePort}`;
              const svcNameUdp = `forwardx-socat-guard-udp-${rule.sourcePort}`;
              socatPreCmds = [
                ...guardBaseCleanupCmds,
                ...cleanupGuardBackendCmds(rule, [svcNameTcp, svcNameUdp]),
                `command -v socat >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq socat || yum install -y -q socat || dnf install -y -q socat || zypper -n install socat || apk add --no-cache socat || pacman -Sy --noconfirm socat; } 2>/dev/null`,
              ];
              guardAction.svcName = svcNameTcp;
              guardAction.svcNameExtra = svcNameUdp;
              guardAction.unit = [
                "[Unit]",
                `Description=ForwardX guarded socat TCP backend ${rule.sourcePort}->${rule.targetIp}:${rule.targetPort}`,
                "After=network.target",
                "",
                "[Service]",
                "Type=simple",
                `ExecStart=/usr/bin/socat TCP4-LISTEN:${guardTarget.backendPort},fork,reuseaddr,bind=127.0.0.1 ${socatDialEndpoint("TCP", processTarget(rule), rule.targetPort)}`,
                "Restart=always",
                "RestartSec=5",
                "LimitNOFILE=65535",
                "",
                "[Install]",
                "WantedBy=multi-user.target",
                "",
              ].join("\n");
              guardAction.unitExtra = [
                "[Unit]",
                `Description=ForwardX guarded socat UDP backend ${rule.sourcePort}->${rule.targetIp}:${rule.targetPort}`,
                "After=network.target",
                "",
                "[Service]",
                "Type=simple",
                `ExecStart=/usr/bin/socat UDP4-LISTEN:${guardTarget.backendPort},fork,reuseaddr,bind=127.0.0.1 ${socatDialEndpoint("UDP", processTarget(rule), rule.targetPort)}`,
                "Restart=always",
                "RestartSec=5",
                "LimitNOFILE=65535",
                "",
                "[Install]",
                "WantedBy=multi-user.target",
                "",
              ].join("\n");
            } else {
              const protoUpper = normalizeForwardRuleProtocol(rule.protocol) === "udp" ? "UDP" : "TCP";
              const listenProto = protoUpper === "UDP" ? "UDP4" : "TCP4";
              guardAction.svcName = `forwardx-socat-guard-${rule.sourcePort}`;
              socatPreCmds = [
                ...guardBaseCleanupCmds,
                ...cleanupGuardBackendCmds(rule, [guardAction.svcName]),
                `command -v socat >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq socat || yum install -y -q socat || dnf install -y -q socat || zypper -n install socat || apk add --no-cache socat || pacman -Sy --noconfirm socat; } 2>/dev/null`,
              ];
              guardAction.unit = [
                "[Unit]",
                `Description=ForwardX guarded socat ${rule.protocol} backend ${rule.sourcePort}->${rule.targetIp}:${rule.targetPort}`,
                "After=network.target",
                "",
                "[Service]",
                "Type=simple",
                `ExecStart=/usr/bin/socat ${listenProto}-LISTEN:${guardTarget.backendPort},fork,reuseaddr,bind=127.0.0.1 ${socatDialEndpoint(protoUpper, processTarget(rule), rule.targetPort)}`,
                "Restart=always",
                "RestartSec=5",
                "LimitNOFILE=65535",
                "",
                "[Install]",
                "WantedBy=multi-user.target",
                "",
              ].join("\n");
            }
            guardAction.preCommands = socatPreCmds;
            guardAction.commands = guardCountingCmds;
          } else {
            guardAction.commands = [
              ...guardBaseCleanupCmds,
              ...cleanupGuardBackendCmds(rule),
              ...(rule.forwardType === "nginx" ? [nginxRuntimeVerifyCmd()] : []),
              ...guardCountingCmds,
            ];
          }
          actions.push(guardAction);
          addRunningRule({
            ruleId: rule.id,
            sourcePort: Number(rule.sourcePort),
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: normalizeForwardRuleProtocol(rule.protocol),
            forwardType: "guard",
            failover: guardFailover,
          });
        } else if (rule.forwardType === "iptables") {
          cmds.push(...buildIptablesForwardCmds(rule));
          for (const c of buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol)) cmds.push(c);
          for (const c of buildRuleAccessLimitCmds(rule)) cmds.push(c);
          actions.push({
            ruleId: rule.id,
            op: "apply",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            networkInterface: hostInterface,
            commands: cmds,
          });
        } else if (rule.forwardType === "nftables") {
          cmds.push(...buildNftForwardCmds(rule));
          for (const c of buildRuleAccessLimitCmds(rule)) cmds.push(c);
          actions.push({
            ruleId: rule.id,
            op: "apply",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            networkInterface: hostInterface,
            commands: cmds,
          });
        } else if (rule.forwardType === "realm") {
          const svcName = `forwardx-realm-${rule.sourcePort}`;
          const realmConfigPath = realmConfigPathForPort(rule.sourcePort);
          const realmRemote = endpointHostPort(processTarget(rule), rule.targetPort);
          const realmConfig = [
            "[log]",
            'level = "warn"',
            "",
            "[network]",
            `use_udp = ${isForwardRuleProtocolUdpEnabled(rule.protocol) ? "true" : "false"}`,
            `zero_copy = ${(rule as any).zeroCopy && isForwardRuleProtocolTcpEnabled(rule.protocol) ? "true" : "false"}`,
            `fast_open = ${(rule as any).tcpFastOpen && isForwardRuleProtocolTcpEnabled(rule.protocol) ? "true" : "false"}`,
            "tcp_timeout = 300",
            "udp_timeout = 30",
            "ipv6_only = false",
            `send_proxy = ${proxyProtocolEnabled(rule, "send") ? "true" : "false"}`,
            `send_proxy_version = ${proxyProtocolVersion(rule)}`,
            `accept_proxy = ${proxyProtocolEnabled(rule, "receive") ? "true" : "false"}`,
            "accept_proxy_timeout = 5",
            "",
            "[[endpoints]]",
            `listen = ${realmTomlString(`[::0]:${Number(rule.sourcePort) || 0}`)}`,
            `remote = ${realmTomlString(realmRemote)}`,
            "",
          ].join("\n");
          const realmConfigB64 = Buffer.from(realmConfig, "utf8").toString("base64");
          const ifaceFlag = hostInterface ? ` --interface ${hostInterface}` : "";
          const realmCmd = `/usr/local/bin/realm -c ${realmConfigPath}${ifaceFlag}`;
          const unit = [
            "[Unit]",
            `Description=ForwardX realm forwarder ${rule.sourcePort}->${rule.targetIp}:${rule.targetPort}`,
            "After=network.target",
            "",
            "[Service]",
            "Type=simple",
            `ExecStart=${realmCmd}`,
            "Restart=always",
            "RestartSec=5",
            "LimitNOFILE=65535",
            "",
            "[Install]",
            "WantedBy=multi-user.target",
            "",
          ].join("\n");
          actions.push({
            ruleId: rule.id,
            op: "apply",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            networkInterface: hostInterface,
            svcName,
            unit,
            preCommands: [
              ...cleanupGuardBackendCmds(rule),
              `mkdir -p ${shQuote(REALM_CONFIG_DIR)}`,
              `printf '%s' '${realmConfigB64}' | base64 -d > ${shQuote(realmConfigPath)}`,
            ],
            commands: [
              // 同时为该端口挂入 mangle 计数链，保证 realm 转发也能被准确统计
              ...buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
              ...buildRuleAccessLimitCmds(rule),
            ],
            failover: actionFailover(rule, { listenPort: failoverProxyPort(rule), bindAddress: "127.0.0.1" }),
          });
        } else if (rule.forwardType === "socat") {
          // socat 转发：用户态进程，通过 systemd 管理
          const svcName = `forwardx-socat-${rule.sourcePort}`;
          const socatPreCmds: string[] = [
            ...cleanupGuardBackendCmds(rule),
            `command -v socat >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq socat || yum install -y -q socat || dnf install -y -q socat || zypper -n install socat || apk add --no-cache socat || pacman -Sy --noconfirm socat; } 2>/dev/null`,
          ];
          const socatPostCmds: string[] = [];

          // 根据协议生成 socat 命令
          // TCP: socat TCP-LISTEN:sourcePort,fork,reuseaddr TCP:targetIp:targetPort
          // UDP: socat UDP-LISTEN:sourcePort,fork,reuseaddr UDP:targetIp:targetPort
          // both: 需要两个 socat 进程
          if (normalizeForwardRuleProtocol(rule.protocol) === "both") {
            // 两个服务：一个 TCP 一个 UDP
            const svcNameTcp = `forwardx-socat-tcp-${rule.sourcePort}`;
            const svcNameUdp = `forwardx-socat-udp-${rule.sourcePort}`;
            const unitTcp = [
              "[Unit]",
              `Description=ForwardX socat TCP forwarder ${rule.sourcePort}->${rule.targetIp}:${rule.targetPort}`,
              "After=network.target",
              "",
              "[Service]",
              "Type=simple",
              `ExecStart=/usr/bin/socat TCP6-LISTEN:${rule.sourcePort},fork,reuseaddr,ipv6only=0 ${socatDialEndpoint("TCP", processTarget(rule), rule.targetPort)}`,
              "Restart=always",
              "RestartSec=5",
              "LimitNOFILE=65535",
              "",
              "[Install]",
              "WantedBy=multi-user.target",
              "",
            ].join("\n");
            const unitUdp = [
              "[Unit]",
              `Description=ForwardX socat UDP forwarder ${rule.sourcePort}->${rule.targetIp}:${rule.targetPort}`,
              "After=network.target",
              "",
              "[Service]",
              "Type=simple",
              `ExecStart=/usr/bin/socat UDP6-LISTEN:${rule.sourcePort},fork,reuseaddr,ipv6only=0 ${socatDialEndpoint("UDP", processTarget(rule), rule.targetPort)}`,
              "Restart=always",
              "RestartSec=5",
              "LimitNOFILE=65535",
              "",
              "[Install]",
              "WantedBy=multi-user.target",
              "",
            ].join("\n");
            // socat both 模式下为该端口挂入 mangle 计数链
            for (const c of buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol)) socatPostCmds.push(c);
            for (const c of buildRuleAccessLimitCmds(rule)) socatPostCmds.push(c);
            actions.push({
              ruleId: rule.id,
              op: "apply",
              forwardType: rule.forwardType,
              sourcePort: rule.sourcePort,
              targetIp: rule.targetIp,
              targetPort: rule.targetPort,
              protocol: rule.protocol,
              networkInterface: hostInterface,
              preCommands: socatPreCmds,
              svcName: svcNameTcp,
              svcNameExtra: svcNameUdp,
              unit: unitTcp,
              unitExtra: unitUdp,
              postCommands: socatPostCmds,
              failover: actionFailover(rule, { listenPort: failoverProxyPort(rule), bindAddress: "127.0.0.1" }),
            });
          } else {
            const protoUpper = normalizeForwardRuleProtocol(rule.protocol) === "udp" ? "UDP" : "TCP";
            const listenProto = protoUpper === "UDP" ? "UDP6" : "TCP6";
            const socatCmd = `/usr/bin/socat ${listenProto}-LISTEN:${rule.sourcePort},fork,reuseaddr,ipv6only=0 ${socatDialEndpoint(protoUpper, processTarget(rule), rule.targetPort)}`;
            const unit = [
              "[Unit]",
              `Description=ForwardX socat ${rule.protocol} forwarder ${rule.sourcePort}->${rule.targetIp}:${rule.targetPort}`,
              "After=network.target",
              "",
              "[Service]",
              "Type=simple",
              `ExecStart=${socatCmd}`,
              "Restart=always",
              "RestartSec=5",
              "LimitNOFILE=65535",
              "",
              "[Install]",
              "WantedBy=multi-user.target",
              "",
            ].join("\n");
            // socat 单协议模式下为该端口挂入 mangle 计数链
            for (const c of buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol)) socatPostCmds.push(c);
            for (const c of buildRuleAccessLimitCmds(rule)) socatPostCmds.push(c);
            actions.push({
              ruleId: rule.id,
              op: "apply",
              forwardType: rule.forwardType,
              sourcePort: rule.sourcePort,
              targetIp: rule.targetIp,
              targetPort: rule.targetPort,
              protocol: rule.protocol,
              networkInterface: hostInterface,
              preCommands: socatPreCmds,
              svcName,
              unit,
              postCommands: socatPostCmds,
              failover: actionFailover(rule, { listenPort: failoverProxyPort(rule), bindAddress: "127.0.0.1" }),
            });
          }
        } else if (rule.forwardType === "nginx") {
          actions.push({
            ruleId: rule.id,
            op: "apply",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            networkInterface: hostInterface,
            commands: [
              ...cleanupGuardBackendCmds(rule),
              nginxRuntimeVerifyCmd(),
            ],
          });
        } else if (rule.forwardType === "gost") {
          const tunnel = (rule as any).tunnelId ? tunnelById.get((rule as any).tunnelId) as any : null;
          if (tunnel && isNginxTunnelMode(tunnel)) {
            actions.push({
              tunnelId: tunnel.id,
              statusType: "rule",
              ruleId: rule.id,
              op: "apply",
              forwardType: "nginx-tunnel",
              sourcePort: rule.sourcePort,
              targetIp: rule.targetIp,
              targetPort: rule.targetPort,
              protocol: rule.protocol,
              networkInterface: hostInterface,
              commands: [nginxRuntimeVerifyCmd()],
            });
            continue;
          }
          if (tunnel && isForwardXTunnel(tunnel)) {
            const entryRoutes = await forwardXEntryRoutes(rule, tunnel);
            const entryRoute = entryRoutes[0] || { host: "", port: 0, key: "" };
            if (!entryRoute.host || entryRoute.port <= 0 || !entryRoute.key) {
              appendPanelLog("error", `[TunnelRoute] invalid ForwardX entry route tunnel=${tunnel.id} rule=${rule.id} nextHost=${entryRoute.host || "-"} nextPort=${entryRoute.port || "-"}`);
              continue;
            }
            const rateLimits = userRateLimits(Number(rule.userId), tunnel);
            const accessLimits = userAccessLimits(Number(rule.userId));
            const mainBackup = failoverForCurrentHost(rule, tunnel, { listenPort: failoverProxyPort(rule) });
            const useUdpOverTcp = udpOverTcpEnabled(rule, tunnel);
            if (useUdpOverTcp) addMimicRemoteFilterForRoutes(entryRoutes);
            actions.push({
              tunnelId: tunnel.id,
              statusType: "rule",
              ruleId: rule.id,
              op: "apply",
              forwardType: "forwardx",
              sourcePort: rule.sourcePort,
              targetIp: rule.targetIp,
              targetPort: rule.targetPort,
              protocol: rule.protocol,
              networkInterface: hostInterface,
              commands: (!rule.isRunning || shouldRefreshForwardXEntryRule || shouldRepairLocalRule) ? [
                ...buildManagedPortCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
                ...buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
              ] : [],
              fxp: {
                role: "entry",
                tunnelId: tunnel.id,
                ruleId: rule.id,
                listenPort: rule.sourcePort,
                protocol: rule.protocol,
                exitHost: entryRoute.host,
                exitPort: entryRoute.port,
                exits: entryRoutes.map((route) => ({
                  host: route.host,
                  port: route.port,
                  key: route.key,
                })),
                targetIp: mainBackup ? "127.0.0.1" : processTarget(rule),
                targetPort: mainBackup ? failoverProxyPort(rule) : rule.targetPort,
                key: entryRoute.key,
                ...rateLimits,
                ...accessLimits,
                accessScope: accessScopeForRule(rule),
                ...await tunnelProtocolPolicy(tunnel),
                proxyProtocolReceive: proxyProtocolEnabled(rule, "entryReceive"),
                proxyProtocolSend: proxyProtocolEnabled(rule, "entrySend"),
                proxyProtocolExitReceive: proxyProtocolEnabled(rule, "exitReceive"),
                proxyProtocolExitSend: proxyProtocolEnabled(rule, "exitSend"),
                proxyProtocolVersion: proxyProtocolVersion(rule),
                tcpFastOpen: !!(rule as any).tcpFastOpen,
                dnsGeneration: tunnelDnsGeneration(tunnel),
              },
              failover: mainBackup,
            });
            continue;
          }
          actions.push({
            tunnelId: tunnel ? tunnel.id : 0,
            statusType: tunnel ? "rule" : undefined,
            ruleId: rule.id,
            op: "apply",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            networkInterface: hostInterface,
            commands: [
              ...cleanupGuardBackendCmds(rule),
              ...buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
              ...buildRuleAccessLimitCmds(rule),
            ],
            failover: tunnel ? undefined : actionFailover(rule, { listenPort: failoverProxyPort(rule), bindAddress: "127.0.0.1" }),
          });
        }
      } else if (!rule.isEnabled && (rule.isRunning || shouldForceStoppedKernelRuleCleanup(rule))) {
        const forceKernelCleanup = shouldForceStoppedKernelRuleCleanup(rule);
        if (!localRuleNeedsRemoval(rule) && !forceKernelCleanup) {
          await settleStoppedRule(rule);
          continue;
        }
        const cmds: string[] = [];
        if (rule.forwardType === "iptables") {
          cmds.push(
            ...buildIptablesForwardCleanupCmds(rule),
            ...buildCountingCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
            ...buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule)),
          );
          actions.push({
            ruleId: rule.id,
            op: "remove",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            commands: cmds,
          });
        } else if (rule.forwardType === "nftables") {
          const removeAction = await buildDisabledRuleRemovalAction(rule);
          if (removeAction) actions.push(removeAction);
        } else if (rule.forwardType === "realm") {
          const svcName = `forwardx-realm-${rule.sourcePort}`;
          const realmConfigPath = realmConfigPathForPort(rule.sourcePort);
          actions.push({
            ruleId: rule.id,
            op: "remove",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            svcName,
            commands: [
              removeManagedServiceCmd(svcName),
              killByPatternCmd(`[r]ealm .*${realmConfigPath}`),
              ...cleanupGuardBackendCmds(rule),
              `rm -f ${shQuote(realmConfigPath)} ${shQuote(`${realmConfigPath}.sha256`)} 2>/dev/null || true`,
              // 清理 conntrack 流量状态文件
              `rm -f /var/lib/forwardx-agent/traffic_${rule.sourcePort}.prev 2>/dev/null || true`,
              `rm -f /var/lib/forwardx-agent/port_${rule.sourcePort}.rule /var/lib/forwardx-agent/port_${rule.sourcePort}.tunnel 2>/dev/null || true`,
              ...buildCountingCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
              ...buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule)),
            ],
          });
        } else if (rule.forwardType === "socat") {
          const removeCmds: string[] = [];
          if (normalizeForwardRuleProtocol(rule.protocol) === "both") {
            const svcTcp = `forwardx-socat-tcp-${rule.sourcePort}`;
            const svcUdp = `forwardx-socat-udp-${rule.sourcePort}`;
            removeCmds.push(removeManagedServiceCmd(svcTcp));
            removeCmds.push(removeManagedServiceCmd(svcUdp));
          } else {
            const svcName = `forwardx-socat-${rule.sourcePort}`;
            removeCmds.push(removeManagedServiceCmd(svcName));
          }
          removeCmds.push(killByPatternCmd(`[s]ocat.*LISTEN:${rule.sourcePort}`));
          removeCmds.push(...cleanupGuardBackendCmds(rule));
          // 清理 conntrack 流量状态文件
          removeCmds.push(`rm -f /var/lib/forwardx-agent/traffic_${rule.sourcePort}.prev 2>/dev/null || true`);
          removeCmds.push(`rm -f /var/lib/forwardx-agent/port_${rule.sourcePort}.rule /var/lib/forwardx-agent/port_${rule.sourcePort}.tunnel 2>/dev/null || true`);
          removeCmds.push(...buildCountingCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol));
          for (const c of buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule))) removeCmds.push(c);
          actions.push({
            ruleId: rule.id,
            op: "remove",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            commands: removeCmds,
          });
        } else if (rule.forwardType === "nginx") {
          actions.push({
            ruleId: rule.id,
            op: "remove",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            commands: [
              ...buildNginxPortCleanupCmds(rule),
            ],
          });
        } else if (rule.forwardType === "gost") {
          const tunnel = (rule as any).tunnelId ? tunnelById.get((rule as any).tunnelId) as any : null;
          if (tunnel && isNginxTunnelMode(tunnel)) {
            actions.push({
              tunnelId: tunnel.id,
              statusType: "rule",
              ruleId: rule.id,
              op: "remove",
              forwardType: "nginx-tunnel",
              sourcePort: rule.sourcePort,
              targetIp: rule.targetIp,
              targetPort: rule.targetPort,
              protocol: rule.protocol,
              commands: [
                ...buildNginxPortCleanupCmds(rule),
                ...cleanupGuardBackendCmds(rule),
              ],
            });
            continue;
          }
          const fxpRemoveKey = tunnel && isForwardXTunnel(tunnel)
            ? (await forwardXEntryRoute(tunnel)).key
            : "";
          const removeCmds: string[] = [
            ...buildManagedPortCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
            ...cleanupGuardBackendCmds(rule),
          ];
          actions.push({
            tunnelId: tunnel ? tunnel.id : 0,
            statusType: tunnel ? "rule" : undefined,
            ruleId: rule.id,
            op: "remove",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            commands: removeCmds,
            fxp: tunnel && isForwardXTunnel(tunnel) ? {
              role: "entry",
              tunnelId: tunnel.id,
              ruleId: rule.id,
              listenPort: rule.sourcePort,
              protocol: rule.protocol,
              key: fxpRemoveKey || tunnelSecretSeed(tunnel),
            } : undefined,
          });
        }
      }
    }

    // 取走该主机的 pending 转发自测任务并标为 running
    for (const rule of tunnelExitRules) {
      const tunnel = tunnelById.get((rule as any).tunnelId) as any;
      const policy = tunnel ? await tunnelProtocolPolicy(tunnel) : emptyProtocolPolicy;
      if (tunnel && !isForwardXTunnel(tunnel) && shouldUseProtocolGuard(rule, policy)) {
        const target = failoverTargetEndpoint(rule);
        guardRules.push({
          ruleId: rule.id,
          tunnelId: tunnel.id,
          listenPort: guardListenPort(rule),
          targetIp: target.targetIp,
          targetPort: target.targetPort,
          protocol: normalizeForwardRuleProtocol(rule.protocol),
          policy,
          proxyProtocolReceive: proxyProtocolEnabled(rule, "exitReceive"),
          proxyProtocolSend: proxyProtocolEnabled(rule, "exitSend"),
          proxyProtocolVersion: proxyProtocolVersion(rule),
        });
      }
    }
    for (const rule of nginxTunnelExitRules) {
      const tunnel = tunnelById.get((rule as any).tunnelId) as any;
      if (!tunnel) continue;
      const policy = await tunnelProtocolPolicy(tunnel);
      if (shouldUseProtocolGuard(rule, policy)) {
        const target = failoverTargetEndpoint(rule);
        guardRules.push({
          ruleId: rule.id,
          tunnelId: tunnel.id,
          listenPort: guardListenPort(rule),
          targetIp: target.targetIp,
          targetPort: target.targetPort,
          protocol: normalizeForwardRuleProtocol(rule.protocol),
          policy,
          proxyProtocolReceive: false,
          proxyProtocolSend: false,
          proxyProtocolVersion: proxyProtocolVersion(rule),
        });
      }
    }

    for (const rule of tunnelExitRules) {
      if (!rule.isEnabled) continue;
      const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
      for (const trafficPort of currentHostTunnelExitPortsForRule(rule, tunnel)) {
        if (!trafficPort) continue;
        protectActiveRulePort(rule, trafficPort);
        addRunningRule({
          ruleId: rule.id,
          tunnelId: tunnel ? Number(tunnel.id) : 0,
          sourcePort: trafficPort,
          targetIp: rule.targetIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
          forwardType: tunnel && isForwardXTunnel(tunnel) ? "forwardx-tunnel-exit" : "gost-tunnel-exit",
          failover: failoverForCurrentHost(rule, tunnel, { listenPort: failoverProxyPort(rule) }),
        });
      }
    }
    for (const rule of nginxTunnelExitRules) {
      if (!rule.isEnabled) continue;
      const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
      for (const trafficPort of currentHostTunnelExitPortsForRule(rule, tunnel)) {
        if (!trafficPort) continue;
        protectActiveRulePort(rule, trafficPort);
        addRunningRule({
          ruleId: rule.id,
          tunnelId: tunnel ? Number(tunnel.id) : 0,
          sourcePort: trafficPort,
          targetIp: rule.targetIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
          forwardType: "nginx-tunnel-exit",
          failover: failoverForCurrentHost(rule, tunnel, { listenPort: failoverProxyPort(rule) }),
        });
      }
    }

    const gostMultiHopRelayRules = await Promise.all(agentAllRules
      .filter((rule: any) => {
        if (!rule || rule.pendingDelete || !rule.isEnabled || !rule.isRunning) return false;
        if (rule.forwardType !== "gost" || !rule.tunnelId) return false;
        const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
        if (!tunnel || isForwardXTunnel(tunnel) || !tunnel.isEnabled) return false;
        if (!isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)) return false;
        if (!isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel)) return false;
        const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
        return Array.isArray(hops) && hops.length >= 3;
      })
      .map(async (rule: any) => {
        const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
        const hops = tunnelHopsByTunnelId.get(Number(tunnel.id)) || [];
        const hostIdx = hops.findIndex((hop: any) => Number(hop.hostId) === Number(host.id));
        if (hostIdx <= 0 || hostIdx >= hops.length - 1) return null;
        const currentHop = hops[hostIdx] as any;
        const nextHop = hops[hostIdx + 1] as any;
        const nextHost = await getHopDialAddress(nextHop);
        const sourcePort = Number(currentHop.listenPort) || 0;
        const targetPort = Number(nextHop.listenPort) || 0;
        if (!sourcePort || !targetPort || !nextHost) return null;
        return {
          ruleId: Number(rule.id),
          tunnelId: Number(tunnel.id),
          sourcePort,
          targetIp: nextHost,
          targetPort,
          protocol: "tcp",
          forwardType: "gost-tunnel-hop",
        };
      }));
    for (const runningRule of gostMultiHopRelayRules) {
      if (runningRule) addRunningRule(runningRule);
    }

    for (const runningRule of runningRules) {
      const port = Number(runningRule.sourcePort || 0);
      if (port > 0) expectedRulePorts.add(port);
    }
    if (hasReportedRuntimeState) {
      const ruleActionPorts = new Set<number>();
      const tunnelActionPorts = new Set<number>();
      for (const action of actions) {
        const port = Number(action?.sourcePort || 0);
        if (port <= 0) continue;
        const statusType = String(action?.statusType || "");
        const ruleId = Number(action?.ruleId || 0);
        const tunnelId = Number(action?.tunnelId || 0);
        if (ruleId > 0 || statusType === "rule") {
          ruleActionPorts.add(port);
        } else if (tunnelId > 0 || statusType === "tunnel") {
          tunnelActionPorts.add(port);
        }
      }
      // 稳定身份护栏：一个上报端口的 ruleId 若属于面板已知、启用、未删除的规则
      // （无论本机自有还是跨主机隧道 entry/exit/hop 规则），说明该端口很可能是合法的，
      // 只是本轮运行态推导（如出口端口计算）出现了瞬时缺口。对这类端口施加迟滞：
      // 必须连续多轮心跳都判为孤儿才真正拆除，杜绝与 apply 形成抖动死循环。
      const knownEnabledRuleIds = new Set<number>();
      for (const rule of agentAllRules as any[]) {
        if (!rule || rule.pendingDelete || !rule.isEnabled) continue;
        const ruleId = Number(rule.id || 0);
        if (ruleId > 0) knownEnabledRuleIds.add(ruleId);
      }
      const orphanStreaks = getOrphanPortStreaks(Number(host.id));
      const seenOrphanPorts = new Set<number>();
      for (const localRule of localRulesByPort.values()) {
        const port = Number(localRule.port || 0);
        if (port <= 0 || expectedRulePorts.has(port) || ruleActionPorts.has(port)) continue;
        const reportedRuleId = Number(localRule.ruleId || 0);
        const guarded = reportedRuleId > 0 && knownEnabledRuleIds.has(reportedRuleId);
        if (guarded) {
          seenOrphanPorts.add(port);
          const streak = (orphanStreaks.get(port) || 0) + 1;
          orphanStreaks.set(port, streak);
          if (streak < AGENT_ORPHAN_REMOVE_MIN_STREAK) {
            appendPanelLog("info", `[AgentReconcile] host=${host.id} port=${port} rule=${reportedRuleId} suspected-orphan streak=${streak}/${AGENT_ORPHAN_REMOVE_MIN_STREAK}; defer removal (identity known, likely transient runtime gap)`);
            continue;
          }
          appendPanelLog("warn", `[AgentReconcile] host=${host.id} port=${port} rule=${reportedRuleId} orphan confirmed after ${streak} heartbeats; removing`);
        }
        actions.push(buildGenericLocalRuleRemovalAction(localRule));
        ruleActionPorts.add(port);
        orphanStreaks.delete(port);
      }
      // 端口一旦重新匹配上规则（不再进入上面的孤儿分支），清零其迟滞计数。
      for (const port of Array.from(orphanStreaks.keys())) {
        if (!seenOrphanPorts.has(port)) orphanStreaks.delete(port);
      }
      if (orphanStreaks.size === 0) agentOrphanPortStreakCache.delete(Number(host.id));
      for (const localTunnel of localTunnelsByPort.values()) {
        const port = Number(localTunnel.port || 0);
        if (port <= 0 || expectedTunnelPorts.has(port) || tunnelActionPorts.has(port)) continue;
        actions.push(buildGenericLocalTunnelRemovalAction(localTunnel));
        tunnelActionPorts.add(port);
      }
    }

    const forwardGroupProbeMap = new Map<string, any>();
    const chainGroupsForHost = (await db.getForwardGroups() as any[])
      .filter((group: any) => group && group.isEnabled && String(group.groupMode || "failover") === "chain");
    for (const group of chainGroupsForHost as any[]) {
      const probes = await db.getForwardGroupChainProbes(Number(group.id));
      for (const probe of probes) {
        if (Number(probe.fromHostId) !== Number(host.id)) continue;
        const key = `${probe.groupId}:${probe.hopIndex}:${probe.targetIp}:${probe.targetPort}:${probe.method}`;
        forwardGroupProbeMap.set(key, {
          groupId: probe.groupId,
          targetIp: probe.targetIp,
          targetPort: probe.targetPort,
          method: probe.method,
          hopIndex: probe.hopIndex,
          hopCount: probe.hopCount,
        });
      }
    }
    const chinaHealthProbes = await db.getForwardGroupChinaHealthProbesForHost(Number(host.id));
    for (const probe of chinaHealthProbes as any[]) {
      const key = `china:${probe.groupId}:${probe.memberId}:${probe.targetIp}:${probe.targetPort}`;
      forwardGroupProbeMap.set(key, {
        groupId: probe.groupId,
        memberId: probe.memberId,
        probeType: "china",
        targetIp: probe.targetIp,
        targetPort: probe.targetPort,
        method: "tcp",
        hopIndex: 0,
        hopCount: 1,
      });
    }
    const forwardGroupProbes = Array.from(forwardGroupProbeMap.values());
    const hostProbeServices = await db.getHostProbeTasksForHost(host.id);

    const pendingTests = await db.getPendingForwardTestsByHost(host.id);
    const selfTests: any[] = [];
    for (const t of pendingTests) {
      const claimed = await db.markForwardTestRunning(t.id);
      if (!claimed) continue;
      const meta = parseSelfTestMeta((t as any).message);
      if (meta?.kind === "tunnel") {
        selfTests.push({
          testId: t.id,
          kind: "tunnel",
          tunnelId: meta.tunnelId,
          ruleId: 0,
          forwardType: "gost-tunnel",
          protocol: "tcp",
          sourcePort: 0,
          targetIp: meta.targetIp,
          targetPort: meta.targetPort,
        });
        continue;
      }
      if (meta?.kind === "tunnel-hop") {
        selfTests.push({
          testId: t.id,
          kind: "tunnel-hop",
          tunnelId: meta.tunnelId,
          ruleId: 0,
          forwardType: "gost-tunnel",
          protocol: "tcp",
          sourcePort: 0,
          targetIp: meta.targetIp,
          targetPort: meta.targetPort,
        });
        continue;
      }
      if (meta?.kind === "forward-via-tunnel") {
        const method = normalizeLinkProbeMethod(meta.method);
        selfTests.push({
          testId: t.id,
          kind: "forward-via-tunnel",
          tunnelId: meta.tunnelId,
          ruleId: t.ruleId,
          forwardType: "gost-tunnel",
          protocol: method,
          method,
          sourcePort: 0,
          targetIp: meta.targetIp,
          targetPort: meta.targetPort,
        });
        continue;
      }
      if (meta?.kind === "forward-via-tunnel-entry") {
        const method = normalizeLinkProbeMethod(meta.method);
        selfTests.push({
          testId: t.id,
          kind: "forward-via-tunnel-entry",
          tunnelId: meta.tunnelId,
          ruleId: t.ruleId,
          forwardType: "gost-tunnel",
          protocol: method,
          method,
          sourcePort: meta.entrySourcePort || 0,
          targetIp: meta.entryIp,
          targetPort: meta.entrySourcePort,
        });
        continue;
      }
      if (meta?.kind === "forward-chain") {
        const method = normalizeLinkProbeMethod(meta.method);
        selfTests.push({
          testId: t.id,
          kind: "forward-chain",
          groupId: meta.groupId,
          ruleId: t.ruleId,
          forwardType: "forward-chain",
          protocol: method,
          method,
          sourcePort: meta.entrySourcePort || 0,
          targetIp: meta.targetIp || meta.entryIp,
          targetPort: meta.targetPort || meta.entrySourcePort,
        });
        continue;
      }
      const rule = await db.getForwardRuleById(t.ruleId);
      if (!rule) continue;
      const method = linkProbeMethodForRule(rule);
      selfTests.push({
        testId: t.id,
        ruleId: rule.id,
        forwardType: rule.forwardType,
        protocol: method,
        method,
        sourcePort: rule.sourcePort,
        targetIp: rule.targetIp,
        targetPort: rule.targetPort,
      });
    }

    const requestedTargetVersion = (host as any).agentUpgradeTargetVersion || AGENT_VERSION;
    const agentUpgradeCompleted = (host as any).agentUpgradeRequested
      && agentVersion
      && isAgentUpgradeTargetSatisfied(agentVersion, requestedTargetVersion, AGENT_VERSION);
    if (agentUpgradeCompleted) {
      await db.clearHostAgentUpgradeRequest(host.id);
    }
    const panelUrl = await resolveAgentAdvertisedPanelUrl();
    const agentUpgrade = (host as any).agentUpgradeRequested && !agentUpgradeCompleted ? {
      targetVersion: requestedTargetVersion,
      panelUrl,
      releaseVersion: (host as any).agentUpgradeReleaseVersion || null,
    } : null;

    const pluginSyncTasks = await buildPluginHostAssetSyncActions(Number(host.id));
    for (const pluginSyncTask of pluginSyncTasks) {
      const pluginSyncAction = {
        statusType: "runtime",
        ruleId: 0,
        tunnelId: 0,
        op: "apply",
        forwardType: pluginSyncTask.forwardType,
        sourcePort: 0,
        targetIp: "",
        targetPort: 0,
        protocol: "tcp",
        knownRunning: false,
        commands: pluginSyncTask.commands,
      } as any;
      if (shouldSendPluginSyncAction(Number(host.id), pluginSyncAction, responseIssuedAt)) {
        actions.push(pluginSyncAction);
      }
    }

    const runtimeConfigChanged = actions.some(actionMayAffectSharedRuntime) || dnsChangedReports.length > 0;
    const mimicRuntimeSyncWanted = mimicFiltersByInterface.size > 0;
    const runtimeSyncWanted = runtimeConfigChanged || runtimeServiceUnhealthy || mimicRuntimeSyncWanted;
    const runtimeSyncBootstrap = !runtimeSyncWanted && (!supportsDesiredState || !hasReportedRuntimeState || localRuntimeState.requestLocalState);
    if (runtimeSyncWanted || runtimeSyncBootstrap) {
      const runtimeSyncAction = {
        statusType: "runtime",
        ruleId: 0,
        tunnelId: 0,
        op: "apply",
        forwardType: "gost-runtime-sync",
        sourcePort: 0,
        targetIp: "",
        targetPort: 0,
        protocol: "tcp",
        knownRunning: false,
        commands: await buildGostRuntimeSyncCmds(),
      } as any;
      const runtimeRepairResendMs = runtimeServiceUnhealthy ? AGENT_RUNTIME_SYNC_REPAIR_RESEND_MS : 0;
      if (shouldSendRuntimeSyncAction(Number(host.id), runtimeSyncAction, runtimeConfigChanged, responseIssuedAt, runtimeRepairResendMs)) {
        actions.push(runtimeSyncAction);
      }
    }

    const effectiveActions = dropStalePortRemoveActions(actions, protectedRuleRemoveActionKeys);
    const actionBatchIssuedAt = resolveActionBatchIssuedAt(Number(host.id), effectiveActions, responseIssuedAt);
    const ruleByIdForDesired = new Map((rules as any[]).map((rule: any) => [Number(rule.id), rule]));
    const desiredKnownRunning = (action: any) => {
      if (action?.op === "remove") return true;
      if (action?.statusType === "runtime") return false;
      const ruleId = Number(action?.ruleId || 0);
      if (ruleId > 0) {
        const rule = ruleByIdForDesired.get(ruleId) as any;
        const sourcePort = Number(action?.sourcePort || 0);
        if (rule && hasReportedRuntimeState && sourcePort > 0) {
          return localRuleMatches(rule, String(action?.forwardType || rule.forwardType || ""), sourcePort);
        }
        return !!rule?.isRunning;
      }
      const tunnelId = Number(action?.tunnelId || 0);
      if (tunnelId > 0) {
        const sourcePort = Number(action?.sourcePort || 0);
        if (hasReportedRuntimeState && sourcePort > 0) {
          return localTunnelMatches(tunnelId, String(action?.forwardType || ""), sourcePort);
        }
        const tunnel = tunnelById.get(tunnelId) as any;
        return !!tunnel?.isRunning || isTunnelRuntimeHostReady(tunnelId, Number(host.id));
      }
      return false;
    };
    const normalizedActions = effectiveActions.map((action: any) => ({
      ...action,
      issuedAt: Number(action.issuedAt) || actionBatchIssuedAt,
      knownRunning: typeof action.knownRunning === "boolean" ? action.knownRunning : desiredKnownRunning(action),
      statusType: action.statusType || (Number(action.ruleId) > 0 ? "rule" : (Number(action.tunnelId) > 0 ? "tunnel" : undefined)),
    }));
    const deferActionsForLocalState = supportsDesiredState && localRuntimeState.requestLocalState;
    if (!deferActionsForLocalState) {
      const runningRuleKeys = new Set(runningRules.map((rule: any) => `${Number(rule.ruleId)}:${Number(rule.sourcePort)}`));
      for (const action of normalizedActions) {
        if (action.op !== "apply" || !Number(action.ruleId) || !Number(action.sourcePort)) continue;
        const key = `${Number(action.ruleId)}:${Number(action.sourcePort)}`;
        if (runningRuleKeys.has(key)) continue;
        addRunningRule({
          ruleId: Number(action.ruleId),
          tunnelId: Number(action.tunnelId || 0) || undefined,
          sourcePort: Number(action.sourcePort),
          targetIp: String(action.targetIp || ""),
          targetPort: Number(action.targetPort || 0),
          protocol: action.protocol || "tcp",
          forwardType: action.forwardType || "unknown",
          failover: action.failover,
        });
        runningRuleKeys.add(key);
      }
    }
    const actionRank = (action: any) => (
      action.op === "remove" ? 0 : action.statusType === "runtime" ? 1 : 2
    );
    const orderedActions = normalizedActions.slice().sort((a: any, b: any) => actionRank(a) - actionRank(b));
    const activeWorkActions = supportsDesiredState
      ? (deferActionsForLocalState ? [] : orderedActions.filter((action: any) => action.op === "remove" || !action.knownRunning))
      : orderedActions;
    const hasTunnelApplyActions = activeWorkActions.some((action: any) => (
      action.op === "apply"
      && !Number(action.ruleId || 0)
      && (action.statusType === "tunnel" || Number(action.tunnelId) > 0)
    ));
    const hasPendingMultiHopRuntime = (hostTunnels as any[]).some((tunnel: any) => {
      const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
      return !!tunnel?.isEnabled
        && isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)
        && Array.isArray(hops)
        && hops.length >= 3
        && hops.some((hop: any) => Number(hop.hostId) === Number(host.id))
        && !isTunnelRuntimeHostReady(Number(tunnel.id), Number(host.id));
    });
    const tcpingRequested = hasHostTcpingRequest(host.id);
    const forceTcping = tcpingRequested && !hasTunnelApplyActions;
    if (forceTcping) clearHostTcpingRequest(host.id);

    const lookingGlassTests = takeLookingGlassAgentTasks(host.id);
    const iperf3Tasks = takeIperf3AgentTasks(host.id);
    const hasInteractiveTasks = lookingGlassTests.length > 0
      || iperf3Tasks.length > 0
      || forceTcping
      || (hasPendingMultiHopRuntime && !hasTunnelApplyActions);
    const serviceProbeInterval = hostProbeServices.reduce((min: number, service: any) => {
      const seconds = Number(service?.intervalSeconds || 30);
      return Math.min(min, Number.isFinite(seconds) ? Math.max(5, Math.floor(seconds)) : 30);
    }, 30);
    const nextInterval = localRuntimeState.requestLocalState
      ? 2
      : (hasInteractiveTasks ? 2 : Math.min(isHostMetricsWatching(host.id) ? 3 : 30, serviceProbeInterval));
    const sendDesiredState = supportsDesiredState
      && !deferActionsForLocalState
      && shouldSendDesiredState(Number(host.id), orderedActions, activeWorkActions, responseIssuedAt);
    const desiredState = sendDesiredState ? {
      version: 1,
      issuedAt: actionBatchIssuedAt,
      actions: orderedActions,
    } : undefined;
    const stateSections = buildAgentStateResponseSections({
      runningRules,
      tunnelProbes,
      forwardGroupProbes,
      hostProbeServices,
      guardRules,
      dnsWatch: Array.from(dnsWatches.values()),
    }, agentStateSignatures);
    res.json({
      success: true,
      actions: supportsDesiredState ? [] : orderedActions,
      desiredState,
      selfTests,
      ...stateSections.payload,
      stateSignatures: stateSections.signatures,
      lookingGlassTests,
      iperf3Tasks,
      agentUpgrade,
      panelUrl,
      forceTcping,
      nextInterval,
      requestLocalState: localRuntimeState.requestLocalState,
      compactReports: true,
    });
  } catch (error) {
    console.error(`[Agent Heartbeat] Error host=${logHostId || "-"} name=${logHostName || "-"}:`, error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent 规则状态回调

}
