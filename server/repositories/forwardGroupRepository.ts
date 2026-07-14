import { isIP } from "node:net";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  forwardGroupEvents,
  forwardGroupMembers,
  forwardGroups,
  forwardRules,
  tunnels,
  userForwardGroupPermissions,
  type InsertForwardGroup,
  type InsertForwardGroupMember,
} from "../../drizzle/schema";
import { pushAgentRefresh, requestHostTcping } from "../agentEvents";
import { appendPanelLog } from "../_core/panelLogger";
import { getDdnsSettings, updateDdnsRecord, updateDdnsRecordValues } from "../ddns";
import { executeRaw, getDb, insertAndGetId, nowDate, queryRaw } from "../dbRuntime";
import { boolValue, countAll, inList, quoteIdentifier } from "../dbCompat";
import {
  createForwardRule,
  getForwardGroupChildRules,
  getForwardGroupChildRulesForMember,
  getForwardGroupTemplateRules,
  getForwardRuleById,
  markForwardRulePendingDelete,
  updateForwardRule,
} from "./forwardRuleRepository";
import { getHostById, getHosts } from "./hostRepository";
import {
  disableForwardRulesByTunnel,
  findAvailableTunnelExitPort,
  getTunnelById,
  getTunnelExitNodes,
  getTunnelHops,
  getTunnels,
  isPortUsedOnHost,
  reconcileForwardRuleTunnelExits,
  resetForwardRulesByTunnel,
  restoreForwardRulesByTunnel,
  updateTunnel,
} from "./tunnelRepository";
import { setUserForwardAccess } from "./userRepository";
import { findTrafficBillingResourceForRule, settleTrafficBillingRuleOnDelete, trafficBillingResourceCandidatesForRule } from "./trafficBillingRepository";
import { combinePortPolicies, isPortAllowedByPolicy, portPolicyErrorMessage, portPolicyFrom, type PortPolicy } from "../portPolicy";
import { clearTunnelRuntimeStatus } from "../tunnelRuntimeStatus";
import { linkProbeMethodForProtocol, type LinkProbeMethod } from "@shared/latencyProbe";
import { notifyForwardGroupSwitch } from "../forwardGroupSwitchNotifier";
import { withKeyedTaskLock } from "../keyedTaskLock";
import { reserveAvailableHostPort, type HostPortReservation } from "../portReservations";
import { repairPortForwardRuleHostReferences } from "../portForwardRuleHosts";

export type ForwardGroupMemberInput = {
  memberType: "host" | "tunnel";
  hostId?: number | null;
  tunnelId?: number | null;
  connectHost?: string | null;
  priority?: number;
  isEnabled?: boolean;
};

type ForwardGroupRuleConfig = {
  sourcePort: number;
  protocol?: "tcp" | "udp" | "both" | string | null;
  excludeTemplateRuleId?: number | null;
};

type SyncForwardGroupRulesOptions = {
  validatePorts?: boolean;
  createMissing?: boolean;
  preserveRuntime?: boolean;
};

function nullableNumber(value: unknown) {
  const num = Number(value || 0);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function nullableString(value: unknown) {
  const text = String(value || "").trim();
  return text || null;
}

function dbBool(value: unknown) {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

const mainBackupGostTunnelModes = new Set(["tls", "wss", "tcp", "mtls", "mwss", "mtcp"]);

function isMainBackupGostTunnelMode(mode: unknown) {
  return mainBackupGostTunnelModes.has(String(mode || "").toLowerCase());
}

function canPreserveChildRuleRuntime(existing: any, payload: any, options: SyncForwardGroupRulesOptions) {
  if (!options.preserveRuntime || !existing?.isEnabled || existing?.pendingDelete) return false;
  const numberKeys = [
    "hostId",
    "sourcePort",
    "targetPort",
    "tunnelId",
    "tunnelExitPort",
    "forwardGroupId",
    "forwardGroupRuleId",
    "forwardGroupMemberId",
    "proxyProtocolVersion",
    "failoverSeconds",
    "recoverSeconds",
  ];
  const stringKeys = ["forwardType", "protocol", "gostMode", "targetIp", "failoverStrategy", "failoverTargets"];
  const boolKeys = [
    "proxyProtocolReceive",
    "proxyProtocolSend",
    "proxyProtocolExitReceive",
    "proxyProtocolExitSend",
    "tcpFastOpen",
    "zeroCopy",
    "udpOverTcp",
    "failoverEnabled",
    "autoFailback",
    "isEnabled",
    "disabledByGroup",
  ];
  return numberKeys.every((key) => nullableNumber(existing?.[key]) === nullableNumber(payload?.[key]))
    && stringKeys.every((key) => nullableString(existing?.[key]) === nullableString(payload?.[key]))
    && boolKeys.every((key) => dbBool(existing?.[key]) === dbBool(payload?.[key]));
}

type ForwardGroupMode = "port" | "failover" | "chain" | "entry" | "exit";
type ForwardGroupRecordType = "A" | "AAAA" | "CNAME";
type ForwardGroupFailoverOptions = {
  forcePriority?: boolean;
  forceSync?: boolean;
  manual?: boolean;
  suppressSwitchNotify?: boolean;
};

const DEFAULT_CHINA_HEALTH_TARGET = "www.189.cn:80";
const lastDdnsEventByKey = new Map<string, string>();

export function normalizeChinaHealthTarget(raw: unknown) {
  const source = String(raw || "").trim() || DEFAULT_CHINA_HEALTH_TARGET;
  const withoutScheme = source.replace(/^tcp:\/\//i, "").replace(/：/g, ":").trim();
  let host = withoutScheme;
  let port = 80;

  const bracketMatch = withoutScheme.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketMatch) {
    host = bracketMatch[1];
    port = bracketMatch[2] ? Number(bracketMatch[2]) : 80;
  } else {
    const lastColon = withoutScheme.lastIndexOf(":");
    if (lastColon > 0) {
      const maybeHost = withoutScheme.slice(0, lastColon).trim();
      const maybePortText = withoutScheme.slice(lastColon + 1);
      const maybePort = Number(maybePortText);
      const singleColonHostPort = withoutScheme.indexOf(":") === lastColon;
      const nakedIpv6HostPort = !singleColonHostPort && isIP(maybeHost) === 6;
      if ((singleColonHostPort || nakedIpv6HostPort) && /^\d+$/.test(maybePortText) && Number.isInteger(maybePort) && maybePort >= 1 && maybePort <= 65535) {
        host = maybeHost;
        port = maybePort;
      }
    }
  }

  host = normalizeIpCandidate(host).trim();
  if (host.includes(":") && isIP(host) !== 6) {
    throw new Error("China health IPv6 target format is invalid");
  }
  if (!host || host.length > 253 || /[\s'"<>/]/.test(host)) {
    throw new Error("China health target format is invalid");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("China health target port must be 1-65535");
  }
  const textHost = isIP(host) === 6 ? `[${host}]` : host;
  return { host, port, text: `${textHost}:${port}` };
}
function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n > 10_000_000_000 ? n : n * 1000);
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function entryAddressForHost(host: any) {
  return String(host?.entryIp || host?.ipv4 || host?.ipv6 || host?.ip || "").trim();
}

function manualEntryAddressForHost(host: any) {
  return String(host?.entryIp || "").trim();
}

function normalizeIpCandidate(value: unknown) {
  const text = String(value || "").trim();
  if (text.startsWith("[") && text.endsWith("]")) return text.slice(1, -1).trim();
  return text;
}

function normalizeHostAddressKey(value: unknown) {
  return normalizeIpCandidate(value).toLowerCase();
}

function hostAddressCandidates(host: any) {
  return [host?.entryIp, host?.ipv4, host?.ipv6, host?.ip, host?.tunnelEntryIp]
    .map((value) => normalizeHostAddressKey(value))
    .filter(Boolean);
}

function hostDisplayLabel(host: any, fallback = "") {
  const id = Number(host?.id || 0);
  return String(host?.name || fallback || (id > 0 ? `主机${id}` : "")).trim();
}

async function findHostByAddress(address: unknown) {
  const key = normalizeHostAddressKey(address);
  if (!key) return null;
  const hosts = await getHosts().catch(() => [] as any[]);
  return (hosts as any[]).find((host) => hostAddressCandidates(host).includes(key)) || null;
}

async function forwardChainTargetLabel(template: any) {
  const targetIp = String(template?.targetIp || "").trim();
  const targetPort = Number(template?.targetPort || 0);
  const targetHost = await findHostByAddress(targetIp);
  const hostLabel = hostDisplayLabel(targetHost);
  const ruleLabel = String(template?.name || "").trim();
  return hostLabel || ruleLabel || (targetIp && targetPort > 0 ? `目标 ${targetIp}:${targetPort}` : "目标");
}

function ipv4AddressForHost(host: any) {
  const manual = normalizeIpCandidate(manualEntryAddressForHost(host));
  if (isIP(manual) === 4) return manual;
  const reportedIpv4 = normalizeIpCandidate(host?.ipv4);
  if (isIP(reportedIpv4) === 4) return reportedIpv4;
  const primary = normalizeIpCandidate(host?.ip);
  return isIP(primary) === 4 ? primary : "";
}

function ipv6AddressForHost(host: any) {
  const manual = normalizeIpCandidate(manualEntryAddressForHost(host));
  if (isIP(manual) === 6) return manual;
  const reportedIpv6 = normalizeIpCandidate(host?.ipv6);
  if (isIP(reportedIpv6) === 6) return reportedIpv6;
  const primary = normalizeIpCandidate(host?.ip);
  return isIP(primary) === 6 ? primary : "";
}

function ddnsDomainForHost(host: any) {
  return host?.ddnsEnabled ? String(host?.ddnsDomain || "").trim() : "";
}

function cnameTargetForHost(host: any) {
  const manual = manualEntryAddressForHost(host);
  if (manual && isIP(normalizeIpCandidate(manual)) === 0) return manual;
  return ddnsDomainForHost(host);
}

function normalizeForwardGroupRecordType(recordType: unknown): ForwardGroupRecordType {
  const text = String(recordType || "A").trim().toUpperCase();
  if (text === "AAAA" || text === "CNAME") return text;
  return "A";
}

function recordTypeRequirementLabel(recordType: ForwardGroupRecordType) {
  if (recordType === "AAAA") return "IPv6";
  if (recordType === "CNAME") return "入口域名或 DDNS 域名";
  return "IPv4";
}

function ddnsValueForHostByRecordType(host: any, recordType: ForwardGroupRecordType) {
  if (recordType === "AAAA") return ipv6AddressForHost(host);
  if (recordType === "CNAME") return cnameTargetForHost(host);
  return ipv4AddressForHost(host);
}

function privateAddressForHost(host: any) {
  return String(host?.tunnelEntryIp || "").trim();
}

function ipv6AddressForConnectHost(host: any) {
  return String(host?.ipv6 || "").trim();
}

function isSafeHostAddress(value: string) {
  const text = value.trim();
  return !!text && text.length <= 253 && !/[\s'"<>]/.test(text);
}

function groupModeOf(group: any): ForwardGroupMode {
  const mode = String(group?.groupMode || "failover");
  return mode === "port" || mode === "chain" || mode === "entry" || mode === "exit" ? mode : "failover";
}

function isCollectionGroupMode(mode: ForwardGroupMode) {
  return mode === "entry" || mode === "exit";
}

function supportsChinaHealthMode(mode: ForwardGroupMode) {
  return mode === "failover" || mode === "entry";
}

function validateForwardGroupModeMembers(groupMode: ForwardGroupMode, groupType: string, members: ForwardGroupMemberInput[], options: { externalEntry?: boolean } = {}) {
  if (groupMode === "port") {
    if (members.length !== 1) throw new Error("端口转发需要配置 1 台所属主机");
    if (String(groupType || "host") !== "host") throw new Error("端口转发仅支持主机成员");
    if (members.some((member) => member.memberType !== "host")) throw new Error("端口转发仅支持主机成员");
  }
  if (groupMode === "chain") {
    const minMembers = options.externalEntry ? 1 : 2;
    if (members.length < minMembers || members.length > 5) {
      throw new Error(options.externalEntry ? "Port forwarding chain requires 1-5 hosts" : "Port forwarding chain requires 2-5 hosts");
    }
    if (groupType !== "host") throw new Error("Port forwarding chain only supports host members");
    if (members.some((member) => member.memberType !== "host")) throw new Error("Port forwarding chain only supports host members");
    return;
  }
  if (isCollectionGroupMode(groupMode)) {
    if (members.length < 1 || members.length > 5) throw new Error(groupMode === "entry" ? "入口组需要配置 1-5 台主机" : "出口组需要配置 1-5 台主机");
    if (groupType !== "host") throw new Error(groupMode === "entry" ? "入口组仅支持主机成员" : "出口组仅支持主机成员");
    if (members.some((member) => member.memberType !== "host")) throw new Error(groupMode === "entry" ? "入口组仅支持主机成员" : "出口组仅支持主机成员");
  }
}

function normalizeStoredChainConnectHost(rawConnectHost: string | null | undefined, host: any) {
  const raw = String(rawConnectHost || "").trim();
  const publicAddr = entryAddressForHost(host);
  const privateAddr = privateAddressForHost(host);
  const ipv6Addr = ipv6AddressForConnectHost(host);
  if (!raw) return null;
  if (!isSafeHostAddress(raw)) throw new Error("Chain host connect address is invalid");
  if (privateAddr && raw === privateAddr) return privateAddr;
  if (ipv6Addr && raw === ipv6Addr) return ipv6Addr;
  if (publicAddr && raw === publicAddr) return null;
  if (!privateAddr && !ipv6Addr) return null;
  throw new Error("Chain host connect address must use entry address, configured private IP or IPv6");
}

function resolveChainConnectHost(member: any, host: any) {
  const stored = String(member?.connectHost || "").trim();
  const publicAddr = entryAddressForHost(host);
  const privateAddr = privateAddressForHost(host);
  const ipv6Addr = ipv6AddressForConnectHost(host);
  if (stored && privateAddr && stored === privateAddr) return privateAddr;
  if (stored && ipv6Addr && stored === ipv6Addr) return ipv6Addr;
  return publicAddr || stored;
}

async function normalizeForwardGroupMemberInput(
  groupMode: ForwardGroupMode,
  member: ForwardGroupMemberInput,
  index: number,
  options: { externalEntry?: boolean } = {},
): Promise<ForwardGroupMemberInput> {
  if (groupMode === "port") return { ...member, memberType: "host", tunnelId: null, connectHost: null, isEnabled: true };
  if (groupMode === "exit" && member.memberType === "host" && member.hostId) {
    const host = await getHostById(Number(member.hostId));
    if (!host) throw new Error("Host does not exist");
    const requested = String(member.connectHost || "").trim();
    const privateAddr = privateAddressForHost(host);
    const ipv6Addr = ipv6AddressForConnectHost(host);
    return {
      ...member,
      connectHost: requested && privateAddr && requested === privateAddr
        ? privateAddr
        : requested && ipv6Addr && requested === ipv6Addr
          ? ipv6Addr
          : null,
    };
  }
  if (groupMode !== "chain") return { ...member, connectHost: null };
  if (member.memberType !== "host" || !member.hostId) return { ...member, connectHost: null };
  const host = await getHostById(Number(member.hostId));
  if (!host) throw new Error("Host does not exist");
  const hasExternalEntry = !!options.externalEntry;
  return {
    ...member,
    connectHost: index === 0 && !hasExternalEntry ? null : normalizeStoredChainConnectHost(member.connectHost ?? null, host),
  };
}

function sortedMembers(group: any, enabledOnly = false) {
  const members = [...((group as any).members || [])].sort((a, b) => Number(a.priority) - Number(b.priority));
  return enabledOnly ? members.filter((member: any) => !!member.isEnabled) : members;
}

async function chainEntryMembers(group: any) {
  const entryGroupId = Number((group as any)?.entryGroupId || 0);
  if (!entryGroupId) return [] as any[];
  const entryGroup = await getForwardGroupById(entryGroupId) as any;
  if (!entryGroup || groupModeOf(entryGroup) !== "entry" || !entryGroup.isEnabled) return [] as any[];
  return sortedMembers(entryGroup, true).filter((member: any) => member.memberType === "host");
}

async function syncChainsUsingEntryGroup(entryGroupId: number, options: SyncForwardGroupRulesOptions = {}) {
  const id = Number(entryGroupId);
  if (!Number.isFinite(id) || id <= 0) return;
  const db = await getDb();
  if (!db) return;
  const rows = await db.select({ id: forwardGroups.id }).from(forwardGroups).where(and(
    eq(forwardGroups.groupMode, "chain"),
    eq(forwardGroups.entryGroupId, id),
  ));
  for (const row of rows as any[]) {
    const chainGroupId = Number(row.id);
    await syncForwardGroupRules(chainGroupId, options);
    await refreshForwardChainRuntime(chainGroupId, "entry-group-updated");
  }
}

async function groupHostIds(groupId: unknown) {
  const id = Number(groupId || 0);
  if (!Number.isFinite(id) || id <= 0) return [] as number[];
  const group = await getForwardGroupById(id) as any;
  if (!group) return [] as number[];
  return sortedMembers(group)
    .filter((member: any) => member?.memberType === "host")
    .map((member: any) => Number(member.hostId || 0))
    .filter((hostId: number) => Number.isFinite(hostId) && hostId > 0);
}

async function refreshControlledTunnelRuntime(
  tunnel: any,
  reason: string,
  options: { resetRules?: boolean; extraHostIds?: number[] } = {},
) {
  const tunnelId = Number(tunnel?.id || 0);
  if (!Number.isFinite(tunnelId) || tunnelId <= 0) return;
  clearTunnelRuntimeStatus(tunnelId);
  await updateTunnel(tunnelId, { isRunning: false } as any);
  if (options.resetRules) await resetForwardRulesByTunnel(tunnelId);

  const hostIds = new Set<number>(options.extraHostIds || []);
  for (const value of [tunnel?.entryHostId, tunnel?.exitHostId]) {
    const hostId = Number(value || 0);
    if (Number.isFinite(hostId) && hostId > 0) hostIds.add(hostId);
  }
  for (const hostId of await groupHostIds(tunnel?.entryGroupId)) hostIds.add(hostId);
  for (const hostId of await groupHostIds(tunnel?.exitGroupId)) hostIds.add(hostId);

  const hops = await getTunnelHops(tunnelId).catch(() => []);
  for (const hop of hops as any[]) {
    const hostId = Number(hop?.hostId || 0);
    if (Number.isFinite(hostId) && hostId > 0) hostIds.add(hostId);
  }
  const extraExits = await getTunnelExitNodes(tunnelId).catch(() => []);
  for (const node of extraExits as any[]) {
    const hostId = Number(node?.hostId || 0);
    if (Number.isFinite(hostId) && hostId > 0) hostIds.add(hostId);
  }
  for (const hostId of hostIds) pushAgentRefresh(hostId, `${reason}-tunnel-${tunnelId}`);
}

async function refreshTunnelsUsingEntryGroup(entryGroupId: number, reason = "entry-group-updated") {
  const id = Number(entryGroupId);
  if (!Number.isFinite(id) || id <= 0) return;
  const allTunnels = await getTunnels() as any[];
  const affectedTunnels = allTunnels.filter((tunnel: any) => Number(tunnel?.entryGroupId || 0) === id);
  if (affectedTunnels.length === 0) return;

  const entryHostIds = await groupHostIds(id);

  for (const tunnel of affectedTunnels) {
    await refreshControlledTunnelRuntime(tunnel, reason, { resetRules: true, extraHostIds: entryHostIds });
  }
}

function describeDdnsTarget(group: any, value: string, provider?: string) {
  const providerLabel = provider ? `provider=${provider}` : "provider=disabled";
  return `${providerLabel} domain=${String(group.domain || "-")} type=${String(group.recordType || "A")} value=${value}`;
}

async function forwardGroupMemberLabel(member: any | null | undefined, fallbackId?: number | null) {
  if (!member) return fallbackId ? `成员 #${fallbackId}` : "";
  if (member.memberType === "host") {
    const host = await getHostById(Number(member.hostId)).catch(() => null);
    return hostDisplayLabel(host, `主机 #${member.hostId || member.id || fallbackId || "-"}`);
  }
  if (member.memberType === "tunnel") {
    const tunnel = await getTunnelById(Number(member.tunnelId)).catch(() => null);
    return String((tunnel as any)?.name || `隧道 #${member.tunnelId || member.id || fallbackId || "-"}`).trim();
  }
  return fallbackId ? `成员 #${fallbackId}` : `成员 #${member.id || "-"}`;
}

function normalizeHealthReason(message: unknown) {
  const text = String(message || "").trim();
  if (!text) return "入口不可用";
  if (text.includes("国内健康")) return "国内健康度检测失败";
  if (/timeout/i.test(text)) return "入口延迟探测超时";
  if (/not running/i.test(text)) return "入口规则未运行";
  if (/disabled/i.test(text)) return "入口规则已停用";
  if (/No forwarding rule/i.test(text)) return "入口暂未生成转发规则";
  if (/waiting/i.test(text)) return "等待健康度检测数据";
  return text;
}

function switchNotifySuppressed(options: ForwardGroupFailoverOptions) {
  return !!options.manual || !!options.forcePriority || !!options.forceSync || !!options.suppressSwitchNotify;
}

function groupSwitchNotifyEnabled(group: any) {
  return !!group?.telegramSwitchNotifyEnabled;
}

export async function getForwardGroups(userId?: number) {
  const db = await getDb();
  if (!db) return [];
  const groupRows = userId
    ? await db.select().from(forwardGroups).where(eq(forwardGroups.userId, userId)).orderBy(asc(forwardGroups.sortOrder), desc(forwardGroups.createdAt), desc(forwardGroups.id))
    : await db.select().from(forwardGroups).orderBy(asc(forwardGroups.sortOrder), desc(forwardGroups.createdAt), desc(forwardGroups.id));
  if (groupRows.length === 0) return [];
  const ids = groupRows.map((g: any) => Number(g.id));
  const members = await db
    .select()
    .from(forwardGroupMembers)
    .where(inArray(forwardGroupMembers.groupId, ids))
    .orderBy(asc(forwardGroupMembers.priority));
  const templateRules = await db
    .select({
      id: forwardRules.id,
      forwardGroupId: forwardRules.forwardGroupId,
    })
    .from(forwardRules)
    .where(and(
      inArray(forwardRules.forwardGroupId, ids),
      eq(forwardRules.isForwardGroupTemplate, true),
      eq(forwardRules.pendingDelete, false),
    ));
  const templateCountByGroup = new Map<number, number>();
  for (const rule of templateRules as any[]) {
    const groupId = Number(rule.forwardGroupId || 0);
    templateCountByGroup.set(groupId, (templateCountByGroup.get(groupId) || 0) + 1);
  }
  const latencyRows = await queryRaw<any>(
    `SELECT s.${quoteIdentifier("groupId")}, s.${quoteIdentifier("latencyMs")}, s.${quoteIdentifier("isTimeout")}, s.${quoteIdentifier("recordedAt")}
     FROM ${quoteIdentifier("forward_group_latency_stats")} s
     INNER JOIN (
       SELECT ${quoteIdentifier("groupId")}, MAX(${quoteIdentifier("recordedAt")}) AS ${quoteIdentifier("recordedAt")}
       FROM ${quoteIdentifier("forward_group_latency_stats")}
       WHERE ${quoteIdentifier("groupId")} IN ${inList(ids).sql}
       GROUP BY ${quoteIdentifier("groupId")}
     ) latest ON latest.${quoteIdentifier("groupId")} = s.${quoteIdentifier("groupId")} AND latest.${quoteIdentifier("recordedAt")} = s.${quoteIdentifier("recordedAt")}`,
    ids,
  ).catch(() => []);
  const latestLatencyByGroup = new Map<number, any>();
  for (const row of latencyRows as any[]) {
    latestLatencyByGroup.set(Number(row.groupId), row);
  }
  const hydratedMembers = await Promise.all((members as any[]).map(async (member: any) => ({
    ...member,
    entryAddress: await memberEntryAddress(member).catch(() => ""),
    ddnsValue: await memberDdnsValue(member, normalizeForwardGroupRecordType(groupRows.find((group: any) => Number(group.id) === Number(member.groupId))?.recordType)).catch(() => ""),
  })));
  return groupRows.map((group: any) => {
    const groupId = Number(group.id);
    const latestLatency = latestLatencyByGroup.get(groupId);
    return {
      ...group,
      groupMode: groupModeOf(group),
      templateRuleCount: templateCountByGroup.get(groupId) || 0,
      latestLatencyMs: latestLatency?.latencyMs !== null && latestLatency?.latencyMs !== undefined
        ? Number(latestLatency.latencyMs)
        : null,
      latestLatencyIsTimeout: Number(latestLatency?.isTimeout || 0) === 1 || latestLatency?.isTimeout === true,
      latestLatencyAt: latestLatency?.recordedAt ?? null,
      members: hydratedMembers.filter((m: any) => Number(m.groupId) === groupId),
    };
  });
}

export async function getForwardGroupById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const group = (await db.select().from(forwardGroups).where(eq(forwardGroups.id, id)).limit(1))[0];
  if (!group) return undefined;
  const members = await db
    .select()
    .from(forwardGroupMembers)
    .where(eq(forwardGroupMembers.groupId, id))
    .orderBy(asc(forwardGroupMembers.priority));
  const hydratedMembers = await Promise.all((members as any[]).map(async (member: any) => ({
    ...member,
    entryAddress: await memberEntryAddress(member).catch(() => ""),
    ddnsValue: await memberDdnsValue(member, normalizeForwardGroupRecordType(group.recordType)).catch(() => ""),
  })));
  return { ...group, groupMode: groupModeOf(group), members: hydratedMembers };
}

export async function getForwardGroupEvents(groupId: number, limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(forwardGroupEvents)
    .where(eq(forwardGroupEvents.groupId, groupId))
    .orderBy(desc(forwardGroupEvents.createdAt))
    .limit(limit);
}

export async function cleanOldForwardGroupEvents(retainHours = 72) {
  const cutoff = Math.floor((Date.now() - retainHours * 3600 * 1000) / 1000);
  await executeRaw(
    `DELETE FROM ${quoteIdentifier("forward_group_events")} WHERE ${quoteIdentifier("createdAt")} < ?`,
    [cutoff],
  );
}

async function withForwardChainTargetLabel(test: any, template: any) {
  if (!test?.message || !template) return test;
  const targetIp = String(template?.targetIp || "").trim();
  const targetPort = Number(template?.targetPort || 0);
  if (!targetIp || targetPort <= 0) return test;
  const targetLabel = await forwardChainTargetLabel(template);
  const oldTarget = `目标 ${targetIp}:${targetPort}`;
  if (!targetLabel || targetLabel === oldTarget || !String(test.message).includes(oldTarget)) return test;
  try {
    const parsed = JSON.parse(String(test.message));
    if (Array.isArray(parsed?.details)) {
      parsed.details = parsed.details.map((detail: any) => ({
        ...detail,
        routeLabel: typeof detail?.routeLabel === "string" ? detail.routeLabel.replace(oldTarget, targetLabel) : detail?.routeLabel,
        hopLabel: typeof detail?.hopLabel === "string" ? detail.hopLabel.replace(oldTarget, targetLabel) : detail?.hopLabel,
      }));
      if (typeof parsed.message === "string") parsed.message = parsed.message.replaceAll(oldTarget, targetLabel);
      return { ...test, message: JSON.stringify(parsed) };
    }
  } catch {
    // Older records may be plain text; fall back to a direct replacement.
  }
  return { ...test, message: String(test.message).replaceAll(oldTarget, targetLabel) };
}

export async function getLatestForwardGroupTest(groupId: number) {
  const templates = await getForwardGroupTemplateRules(groupId);
  const templateIds = (templates as any[]).map((rule: any) => Number(rule.id)).filter((id: number) => id > 0);
  const table = quoteIdentifier("forward_tests");
  const ruleCol = quoteIdentifier("ruleId");
  const updatedCol = quoteIdentifier("updatedAt");
  const createdCol = quoteIdentifier("createdAt");
  const messageCol = quoteIdentifier("message");
  const groupNeedle = `"groupId":${Number(groupId)}`;
  const ruleFilter = templateIds.length > 0
    ? `${ruleCol} IN ${inList(templateIds).sql} OR `
    : "";
  const filterSql = `(${ruleFilter}${messageCol} LIKE ?)`;
  const filterArgs: any[] = [...templateIds, `%${groupNeedle}%`];
  const pendingRows = await queryRaw<any>(
    `SELECT * FROM ${table} WHERE ${filterSql} AND ${quoteIdentifier("status")} IN ('pending', 'running') ORDER BY ${updatedCol} DESC, ${createdCol} DESC LIMIT 1`,
    filterArgs,
  );
  const template = (templates as any[])[0] || null;
  if (pendingRows[0]) return withForwardChainTargetLabel(pendingRows[0], template);
  const rows = await queryRaw<any>(
    `SELECT * FROM ${table} WHERE ${filterSql} ORDER BY ${updatedCol} DESC, CASE WHEN ${messageCol} LIKE '%forward-chain-hop-summary%' THEN 0 ELSE 1 END, ${createdCol} DESC LIMIT 1`,
    filterArgs,
  );
  return withForwardChainTargetLabel(rows[0], template);
}

export async function getForwardGroupPrimaryTemplateRule(groupId: number) {
  const templates = await getForwardGroupTemplateRules(groupId);
  return (templates as any[])[0] || null;
}

export type ForwardGroupChainProbe = {
  groupId: number;
  fromHostId: number;
  targetIp: string;
  targetPort: number;
  method: LinkProbeMethod;
  hopIndex: number;
  hopCount: number;
  hopLabel: string;
  routeLabel: string;
};

export type ForwardGroupChinaHealthProbe = {
  groupId: number;
  memberId: number;
  fromHostId: number;
  targetIp: string;
  targetPort: number;
  method: "tcp";
  probeType: "china";
};

export async function getForwardGroupChainProbes(groupId: number, options: { includeFinalTarget?: boolean; templateRule?: any; method?: LinkProbeMethod; sourcePort?: number } = {}) {
  const group = await getForwardGroupById(groupId) as any;
  if (!group || groupModeOf(group) !== "chain") return [] as ForwardGroupChainProbe[];
  const template = options.templateRule || (options.includeFinalTarget ? await getForwardGroupPrimaryTemplateRule(groupId) : null) as any;
  const members = sortedMembers(group, true) as any[];
  const entryMembers = await chainEntryMembers(group);
  const hasExternalEntry = entryMembers.length > 0;
  if (members.length < (hasExternalEntry ? 1 : 2)) return [] as ForwardGroupChainProbe[];

  const hostById = new Map<number, any>();
  for (const member of [...entryMembers, ...members]) {
    const hostId = Number(member.hostId || 0);
    if (hostId > 0 && !hostById.has(hostId)) hostById.set(hostId, await getHostById(hostId));
  }

  const probes: ForwardGroupChainProbe[] = [];
  const sourcePort = Number(options.sourcePort ?? template?.sourcePort ?? 0);
  const hopProbeMethod = options.method || (template ? linkProbeMethodForProtocol(template?.protocol) : "ping");
  const hasFinalTarget = !!options.includeFinalTarget
    && !!template
    && String(template.targetIp || "").trim()
    && Number(template.targetPort || 0) > 0;
  const entryHopCount = hasExternalEntry ? 1 : 0;
  const hopCount = entryHopCount + Math.max(0, members.length - 1) + (hasFinalTarget ? 1 : 0);
  let hopIndex = 0;

  if (hasExternalEntry) {
    const firstMember = members[0] as any;
    const firstHostId = Number(firstMember.hostId || 0);
    const firstHost = hostById.get(firstHostId);
    const targetIp = resolveChainConnectHost(firstMember, firstHost);
    const firstName = String(firstHost?.name || `主机${firstHostId}`);
    if (targetIp && (hopProbeMethod === "ping" || sourcePort > 0)) {
      for (const entryMember of entryMembers) {
        const entryHostId = Number(entryMember.hostId || 0);
        const entryHost = hostById.get(entryHostId);
        if (!entryHostId) continue;
        const entryName = String(entryHost?.name || `主机${entryHostId}`);
        probes.push({
          groupId,
          fromHostId: entryHostId,
          targetIp,
          targetPort: hopProbeMethod === "ping" ? 0 : sourcePort,
          method: hopProbeMethod,
          hopIndex,
          hopCount,
          hopLabel: `${hopIndex + 1}/${hopCount} ${entryHostId}->${firstHostId}`,
          routeLabel: `${entryName} -> ${firstName}`,
        });
      }
    }
    hopIndex += 1;
  }
  for (let index = 0; index < members.length - 1; index++) {
    const current = members[index] as any;
    const next = members[index + 1] as any;
    const currentHostId = Number(current.hostId || 0);
    const nextHostId = Number(next.hostId || 0);
    const currentHost = hostById.get(currentHostId);
    const nextHost = hostById.get(nextHostId);
    const targetIp = resolveChainConnectHost(next, nextHost);
    if (!currentHostId || !targetIp) continue;
    const currentName = String(currentHost?.name || `主机${currentHostId}`);
    const nextName = String(nextHost?.name || `主机${nextHostId}`);
    probes.push({
      groupId,
      fromHostId: currentHostId,
      targetIp,
      targetPort: hopProbeMethod === "ping" ? 0 : (sourcePort > 0 ? sourcePort : 0),
      method: hopProbeMethod,
      hopIndex,
      hopCount,
      hopLabel: `${hopIndex + 1}/${hopCount} ${currentHostId}->${nextHostId}`,
      routeLabel: `${currentName} -> ${nextName}`,
    });
    hopIndex += 1;
  }
  if (hasFinalTarget) {
    const lastMember = members[members.length - 1] as any;
    const lastHostId = Number(lastMember.hostId || 0);
    const lastHost = hostById.get(lastHostId);
    const targetIp = String(template.targetIp || "").trim();
    const targetPort = Number(template.targetPort || 0);
    if (lastHostId > 0 && targetIp && targetPort > 0) {
      const targetLabel = await forwardChainTargetLabel(template);
      const finalProbeMethod = linkProbeMethodForProtocol(template?.protocol);
      probes.push({
        groupId,
        fromHostId: lastHostId,
        targetIp,
        targetPort: finalProbeMethod === "ping" ? 0 : targetPort,
        method: finalProbeMethod,
        hopIndex,
        hopCount,
        hopLabel: `${hopIndex + 1}/${hopCount} ${lastHostId}->target`,
        routeLabel: `${hostDisplayLabel(lastHost, `主机${lastHostId}`)} -> ${targetLabel}`,
      });
    }
  }
  return probes;
}

export async function getForwardGroupChinaHealthProbesForHost(hostId: number) {
  const groups = await getForwardGroups() as any[];
  const probes: ForwardGroupChinaHealthProbe[] = [];
  for (const group of groups) {
    if (!group?.isEnabled || !supportsChinaHealthMode(groupModeOf(group)) || !group.chinaHealthCheckEnabled) continue;
    let target;
    try {
      target = normalizeChinaHealthTarget(group.chinaHealthCheckTarget);
    } catch (error) {
      appendPanelLog("warn", `[ForwardGroup] china health target invalid group=${group.id} target=${String(group.chinaHealthCheckTarget || "-")}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const member of sortedMembers(group, true) as any[]) {
      const entryHostId = await memberEntryHostId(member).catch(() => 0);
      if (Number(entryHostId) !== Number(hostId)) continue;
      probes.push({
        groupId: Number(group.id),
        memberId: Number(member.id),
        fromHostId: Number(entryHostId),
        targetIp: target.host,
        targetPort: target.port,
        method: "tcp",
        probeType: "china",
      });
    }
  }
  return probes;
}

export async function updateForwardGroupMemberChinaHealth(input: {
  groupId: number;
  memberId: number;
  hostId: number;
  latencyMs: number | null;
  isTimeout: boolean;
}) {
  const group = await getForwardGroupById(Number(input.groupId)) as any;
  if (!group || !group.chinaHealthCheckEnabled || !supportsChinaHealthMode(groupModeOf(group))) return false;
  const member = (group.members || []).find((item: any) => Number(item.id) === Number(input.memberId));
  if (!member) return false;
  const entryHostId = await memberEntryHostId(member);
  if (Number(entryHostId) !== Number(input.hostId)) return false;
  const db = await getDb();
  await db.update(forwardGroupMembers).set({
    chinaHealthStatus: input.isTimeout ? "unhealthy" : "healthy",
    chinaHealthLatencyMs: input.isTimeout ? null : input.latencyMs,
    chinaHealthCheckedAt: nowDate(),
    updatedAt: nowDate(),
  } as any).where(eq(forwardGroupMembers.id, Number(input.memberId)));
  await runForwardGroupFailover(Number(input.groupId));
  return true;
}

export async function resetForwardGroupChinaHealth(groupId: number) {
  const db = await getDb();
  await db.update(forwardGroupMembers).set({
    chinaHealthStatus: "unknown",
    chinaHealthLatencyMs: null,
    chinaHealthCheckedAt: null,
    updatedAt: nowDate(),
  } as any).where(eq(forwardGroupMembers.groupId, Number(groupId)));
}

async function insertForwardGroupEvent(groupId: number, memberId: number | null, type: string, message: string) {
  if (type.startsWith("ddns-")) {
    const truncated = message.slice(0, 500);
    const key = `${groupId}:${memberId ?? "-"}:${type}`;
    if (lastDdnsEventByKey.get(key) === truncated) {
      return;
    }
    lastDdnsEventByKey.set(key, truncated);
    message = truncated;
  }
  const level = type.includes("error") ? "error" : type.includes("skip") ? "warn" : "info";
  appendPanelLog(level, `[DDNS] group=${groupId} member=${memberId ?? "-"} type=${type} ${message}`);
  await insertAndGetId("forward_group_events", {
    groupId,
    memberId,
    type,
    message: message.slice(0, 500),
    createdAt: nowDate(),
  });
}

async function memberEntryAddress(member: any) {
  if (member.memberType === "host") {
    const host = await getHostById(Number(member.hostId));
    return entryAddressForHost(host);
  }
  if (member.memberType === "tunnel") {
    const tunnel = await getTunnelById(Number(member.tunnelId));
    if (!tunnel) return "";
    const entry = await getHostById(Number(tunnel.entryHostId));
    return entryAddressForHost(entry);
  }
  return "";
}

async function memberDdnsValue(member: any, recordType: ForwardGroupRecordType) {
  if (member.memberType === "host") {
    const host = await getHostById(Number(member.hostId));
    return ddnsValueForHostByRecordType(host, recordType);
  }
  if (member.memberType === "tunnel") {
    const tunnel = await getTunnelById(Number(member.tunnelId));
    if (!tunnel) return "";
    const entry = await getHostById(Number(tunnel.entryHostId));
    return ddnsValueForHostByRecordType(entry, recordType);
  }
  return "";
}

async function firstResolvableMember(members: any[], recordType: ForwardGroupRecordType) {
  for (const member of members) {
    if (member?.isEnabled === false) continue;
    const value = await memberDdnsValue(member, recordType).catch(() => "");
    if (value) return { member, value };
  }
  return { member: null, value: "" };
}

export async function validateForwardGroupRecordMembers(group: any, members: ForwardGroupMemberInput[] | any[]) {
  const mode = groupModeOf(group);
  if (mode !== "failover" && mode !== "entry") return;
  const recordType = normalizeForwardGroupRecordType((group as any)?.recordType);
  const requirement = recordTypeRequirementLabel(recordType);
  const label = mode === "entry" ? "入口组" : "转发组";
  const missing: string[] = [];
  for (const member of members || []) {
    if (member?.isEnabled === false) continue;
    const value = await memberDdnsValue(member, recordType).catch(() => "");
    if (value) continue;
    let name = "";
    if (member.memberType === "host") {
      const host = await getHostById(Number(member.hostId)).catch(() => null);
      name = String((host as any)?.name || `主机 #${member.hostId}`);
    } else {
      const tunnel = await getTunnelById(Number(member.tunnelId)).catch(() => null);
      name = String((tunnel as any)?.name || `隧道 #${member.tunnelId}`);
    }
    missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(`${label}使用 ${recordType} 记录时，所有启用成员都需要配置${requirement}：${missing.slice(0, 5).join("、")}`);
  }
}

async function targetHostIdForMember(member: ForwardGroupMemberInput) {
  if (member.memberType === "host") {
    if (!member.hostId) throw new Error("Forward group member host is required");
    const host = await getHostById(Number(member.hostId));
    if (!host) throw new Error("Host does not exist");
    return Number(host.id);
  }
  if (!member.tunnelId) throw new Error("Forward group member tunnel is required");
  const tunnel = await getTunnelById(Number(member.tunnelId));
  if (!tunnel) throw new Error("Tunnel does not exist");
  return Number(tunnel.entryHostId);
}

async function memberEntryHostId(member: any) {
  if (member.memberType === "host") return Number(member.hostId || 0);
  const tunnel = await getTunnelById(Number(member.tunnelId));
  return Number(tunnel?.entryHostId || 0);
}

export async function getForwardGroupDefaultHostId(groupId: number) {
  const group = await getForwardGroupById(groupId);
  if (!group) throw new Error("Forward group does not exist");
  if (isCollectionGroupMode(groupModeOf(group))) throw new Error("Entry/exit groups cannot be used directly as forwarding rules");
  const members = sortedMembers(group);
  for (const member of members) {
    if (!member.isEnabled) continue;
    const hostId = await memberEntryHostId(member);
    if (hostId) return hostId;
  }
  for (const member of members) {
    const hostId = await memberEntryHostId(member);
    if (hostId) return hostId;
  }
  throw new Error("Forward group has no valid entry agent");
}

export async function getForwardGroupRuleEntryHostIds(groupId: number) {
  const group = await getForwardGroupById(groupId);
  if (!group) throw new Error("Forward group does not exist");
  const members = sortedMembers(group);
  const portMembers = groupModeOf(group) === "chain"
    ? [...(await chainEntryMembers(group)), ...members]
    : members;
  const hostIds = await Promise.all(portMembers
    .filter((member: any) => member?.isEnabled !== false)
    .map((member: any) => memberEntryHostId(member)));
  return Array.from(new Set(hostIds.filter((hostId) => Number.isInteger(hostId) && hostId > 0)));
}

async function existingChildRule(templateRuleId: number, memberId: number, hostId?: number | null) {
  const db = await getDb();
  const conds: any[] = [
    eq(forwardRules.forwardGroupRuleId, templateRuleId),
    eq(forwardRules.forwardGroupMemberId, memberId),
  ];
  if (hostId) conds.push(eq(forwardRules.hostId, Number(hostId)));
  const rows = await db.select().from(forwardRules).where(and(...conds)).limit(1);
  return rows[0];
}

async function isPortUsedOnHostForGroupChild(hostId: number, sourcePort: number, ignoreRuleIds: number[], protocol?: unknown) {
  const table = quoteIdentifier("forward_rules");
  const idCol = quoteIdentifier("id");
  const hostCol = quoteIdentifier("hostId");
  const portCol = quoteIdentifier("sourcePort");
  const pendingCol = quoteIdentifier("pendingDelete");
  const enabledCol = quoteIdentifier("isEnabled");
  const protocolCol = quoteIdentifier("protocol");
  const ignore = ignoreRuleIds.filter((id) => Number(id) > 0);
  const ignoreSql = ignore.length > 0 ? ` AND ${idCol} NOT IN ${inList(ignore).sql}` : "";
  const protocolSql = rawProtocolConflictWhere(protocolCol, protocol);
  const rows = await queryRaw<{ count: number }>(
    `SELECT ${countAll()} FROM ${table} WHERE ${hostCol} = ? AND ${portCol} = ? AND ${pendingCol} = ? AND ${enabledCol} = ?${protocolSql.sql}${ignoreSql}`,
    [hostId, sourcePort, boolValue(false), boolValue(true), ...protocolSql.params, ...ignore],
  );
  return (Number(rows[0]?.count) || 0) > 0;
}

async function entryPortPolicyForMember(member: any): Promise<{ hostId: number; policy: PortPolicy }> {
  if (member.memberType === "tunnel") {
    const tunnel = await getTunnelById(Number(member.tunnelId));
    if (!tunnel) throw new Error("Tunnel does not exist");
    const entryHost = await getHostById(Number((tunnel as any).entryHostId || 0));
    if (!entryHost) throw new Error("Tunnel entry host does not exist");
    return {
      hostId: Number((tunnel as any).entryHostId || 0),
      policy: combinePortPolicies(
        portPolicyFrom(entryHost as any),
        portPolicyFrom({
          portRangeStart: (tunnel as any).portRangeStart,
          portRangeEnd: (tunnel as any).portRangeEnd,
        }),
      ),
    };
  }
  const host = await getHostById(Number(member.hostId));
  if (!host) throw new Error("Host does not exist");
  return {
    hostId: Number(host.id || 0),
    policy: portPolicyFrom(host as any),
  };
}

async function assertEntryPortAllowed(member: any, sourcePort: number) {
  const entry = await entryPortPolicyForMember(member);
  if (!isPortAllowedByPolicy(sourcePort, entry.policy)) {
    throw new Error(portPolicyErrorMessage(entry.policy, "Entry port"));
  }
}

async function usedPortsOnEntryHost(hostId: number, ignoreRuleIds: number[], range?: { start: number; end: number } | null, protocol?: unknown) {
  const table = quoteIdentifier("forward_rules");
  const idCol = quoteIdentifier("id");
  const hostCol = quoteIdentifier("hostId");
  const portCol = quoteIdentifier("sourcePort");
  const pendingCol = quoteIdentifier("pendingDelete");
  const enabledCol = quoteIdentifier("isEnabled");
  const protocolCol = quoteIdentifier("protocol");
  const ignore = ignoreRuleIds.filter((id) => Number(id) > 0);
  const ignoreSql = ignore.length > 0 ? ` AND ${idCol} NOT IN ${inList(ignore).sql}` : "";
  const rangeSql = range ? ` AND ${portCol} BETWEEN ? AND ?` : "";
  const protocolSql = rawProtocolConflictWhere(protocolCol, protocol);
  const rows = await queryRaw<{ port: number }>(
    `SELECT ${portCol} AS "port" FROM ${table} WHERE ${hostCol} = ?${rangeSql} AND ${pendingCol} = ? AND ${enabledCol} = ?${protocolSql.sql}${ignoreSql}`,
    range
      ? [hostId, range.start, range.end, boolValue(false), boolValue(true), ...protocolSql.params, ...ignore]
      : [hostId, boolValue(false), boolValue(true), ...protocolSql.params, ...ignore],
  );
  return new Set(rows.map((row) => Number(row.port)).filter((port) => Number.isInteger(port)));
}

function policyHasRestrictionForGroup(policy: PortPolicy) {
  return !!policy.denyAll || (policy.rangeStart !== null && policy.rangeEnd !== null) || policy.allowlist.length > 0;
}

function longestContiguousRange(ports: number[]) {
  const sorted = Array.from(new Set(ports)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  let bestStart = sorted[0];
  let bestEnd = sorted[0];
  let runStart = sorted[0];
  let previous = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const current = sorted[i];
    if (current === previous + 1) {
      previous = current;
      continue;
    }
    if (previous - runStart > bestEnd - bestStart) {
      bestStart = runStart;
      bestEnd = previous;
    }
    runStart = current;
    previous = current;
  }
  return { start: bestStart, end: bestEnd };
}

function policyRangeForGroup(policy: PortPolicy) {
  if (policy.denyAll) return null;
  if (!policyHasRestrictionForGroup(policy)) return { start: 10000, end: 65535 };
  if (policy.rangeStart !== null && policy.rangeEnd !== null) {
    return { start: policy.rangeStart, end: policy.rangeEnd };
  }
  return longestContiguousRange(policy.allowlist);
}

function candidatePortsForGroup(policy: PortPolicy) {
  if (policy.denyAll) return [];
  const ports: number[] = [];
  if (!policyHasRestrictionForGroup(policy)) {
    for (let port = 10000; port <= 65535; port++) ports.push(port);
    return ports;
  }
  if (policy.rangeStart !== null && policy.rangeEnd !== null) {
    for (let port = policy.rangeStart; port <= policy.rangeEnd; port++) ports.push(port);
  }
  for (const port of policy.allowlist) {
    if (!ports.includes(port)) ports.push(port);
  }
  return ports.filter((port) => isPortAllowedByPolicy(port, policy));
}

export async function getForwardGroupEntryPortRange(groupId: number): Promise<{ start: number; end: number } | null> {
  const group = await getForwardGroupById(groupId);
  if (!group) throw new Error("Forward group does not exist");
  const members = sortedMembers(group, true);
  if (members.length === 0) throw new Error("Forward group has no enabled members");
  const groupMode = groupModeOf(group);
  if (isCollectionGroupMode(groupMode)) throw new Error("Entry/exit groups cannot be used directly as forwarding rules");
  const entryMembers = groupMode === "chain" ? await chainEntryMembers(group) : [];
  if (groupMode === "chain" && (members.length < (entryMembers.length > 0 ? 1 : 2) || members.length > 5)) {
    throw new Error(entryMembers.length > 0 ? "Port forwarding chain requires 1-5 enabled hosts" : "Port forwarding chain requires at least two enabled hosts");
  }

  let policy = portPolicyFrom(null);
  const policyMembers = groupMode === "chain" ? [...entryMembers, ...members] : members;
  for (const member of policyMembers) {
    const entry = await entryPortPolicyForMember(member);
    if (!entry.hostId) throw new Error("Forward group member has no valid entry agent");
    policy = combinePortPolicies(policy, entry.policy);
  }
  return policyRangeForGroup(policy);
}

export async function findAvailableForwardGroupPort(
  groupId: number,
  excludeTemplateRuleId?: number | null,
  allowedRange?: { start: number; end: number } | null,
  protocol?: unknown,
) {
  const group = await getForwardGroupById(groupId);
  if (!group) throw new Error("Forward group does not exist");
  const members = sortedMembers(group, true);
  if (members.length === 0) throw new Error("Forward group has no enabled members");
  const groupMode = groupModeOf(group);
  if (isCollectionGroupMode(groupMode)) throw new Error("Entry/exit groups cannot be used directly as forwarding rules");
  const entryMembers = groupMode === "chain" ? await chainEntryMembers(group) : [];
  const firstChainMember = groupMode === "chain" ? members[0] : null;
  const entryMemberIds = new Set(entryMembers.map((member: any) => Number(member.id)));
  if (groupMode === "chain" && (members.length < (entryMembers.length > 0 ? 1 : 2) || members.length > 5)) {
    throw new Error(entryMembers.length > 0 ? "Port forwarding chain requires 1-5 enabled hosts" : "Port forwarding chain requires at least two enabled hosts");
  }

  const entries: Array<{ hostId: number; ignoreRuleIds: number[] }> = [];
  let policy = portPolicyFrom(null);

  const candidateMembers = groupMode === "chain" ? [...entryMembers, ...members] : members;
  for (const member of candidateMembers) {
    const entry = await entryPortPolicyForMember(member);
    if (!entry.hostId) throw new Error("Forward group member has no valid entry agent");
    const childMemberId = groupMode === "chain" && entryMemberIds.has(Number(member.id)) && firstChainMember
      ? Number(firstChainMember.id)
      : Number(member.id);
    const existing = excludeTemplateRuleId
      ? await existingChildRule(Number(excludeTemplateRuleId), childMemberId, entry.hostId)
      : null;
    entries.push({
      hostId: entry.hostId,
      ignoreRuleIds: [Number(excludeTemplateRuleId || 0), Number(existing?.id || 0)].filter(Boolean),
    });
    policy = combinePortPolicies(policy, entry.policy);
  }
  if (allowedRange) {
    policy = combinePortPolicies(policy, portPolicyFrom({ portRangeStart: allowedRange.start, portRangeEnd: allowedRange.end }));
  }
  const candidates = candidatePortsForGroup(policy);
  if (candidates.length === 0) return null;

  const usedPortSets = await Promise.all(
    entries.map((entry) => usedPortsOnEntryHost(entry.hostId, entry.ignoreRuleIds, null, protocol)),
  );
  const isAvailable = (port: number) => usedPortSets.every((usedPorts) => !usedPorts.has(port));

  const randomAttempts = Math.min(120, candidates.length);
  for (let i = 0; i < randomAttempts; i++) {
    const port = candidates[Math.floor(Math.random() * candidates.length)];
    if (isAvailable(port)) return port;
  }

  for (const port of candidates) {
    if (isAvailable(port)) return port;
  }
  return null;
}

export async function validateForwardGroupRuleConfig(groupId: number, config: ForwardGroupRuleConfig) {
  const group = await getForwardGroupById(groupId);
  if (!group) throw new Error("Forward group does not exist");
  if (!(await forwardGroupRuntimeDependenciesEnabled(group))) throw new Error("转发资源未启用或关联入口组已停用");
  const sourcePort = Number(config.sourcePort || 0);
  const protocol = normalizeRuleProtocol(config.protocol);
  if (!Number.isInteger(sourcePort) || sourcePort < 1 || sourcePort > 65535) {
    throw new Error("Forward group entry port must be 1-65535");
  }
  const members = sortedMembers(group);
  if (members.length === 0) throw new Error("Forward group has no members");
  const groupMode = groupModeOf(group);
  if (isCollectionGroupMode(groupMode)) throw new Error("Entry/exit groups cannot be used directly as forwarding rules");
  if (groupMode === "port") {
    if (members.length !== 1) throw new Error("端口转发需要配置 1 台所属主机");
    if (String(group.groupType || "host") !== "host") throw new Error("端口转发仅支持主机成员");
    if (members.some((member) => member.memberType !== "host")) throw new Error("端口转发仅支持主机成员");
  }
  if (groupMode === "chain") {
    const enabledMembers = members.filter((member: any) => !!member.isEnabled);
    const entryMembers = await chainEntryMembers(group);
    const minEnabledMembers = entryMembers.length > 0 ? 1 : 2;
    if (String((group as any).groupType || "host") !== "host") {
      throw new Error("Port forwarding chain only supports host members");
    }
    if (enabledMembers.length < minEnabledMembers || enabledMembers.length > 5) {
      throw new Error(entryMembers.length > 0 ? "Port forwarding chain requires 1-5 enabled hosts" : "Port forwarding chain requires 2-5 enabled hosts");
    }
    const hasExternalEntry = entryMembers.length > 0;
    for (const [index, member] of enabledMembers.entries()) {
      if (member.memberType !== "host") throw new Error("Port forwarding chain only supports host members");
      const host = await getHostById(Number(member.hostId));
      if (!host) throw new Error("Host does not exist");
      if (index === 0 && !hasExternalEntry) {
        if (!entryAddressForHost(host)) throw new Error("Port forwarding chain entry host has no entry address");
      } else if (!resolveChainConnectHost(member, host)) {
        throw new Error("Port forwarding chain host has no usable connect address");
      }
    }
    for (const entryMember of entryMembers) {
      const host = await getHostById(Number(entryMember.hostId));
      if (!host || !entryAddressForHost(host)) throw new Error("Entry group host has no entry address");
    }
  }

  const portCheckMembers = groupMode === "chain"
    ? [...(await chainEntryMembers(group)), ...members]
    : members;
  const firstChainMember = groupMode === "chain"
    ? members.filter((member: any) => !!member.isEnabled)[0] || null
    : null;
  const externalEntryMemberIds = groupMode === "chain"
    ? new Set((await chainEntryMembers(group)).map((member: any) => Number(member.id)))
    : new Set<number>();
  for (const member of portCheckMembers) {
    if (!member.isEnabled) continue;
    const hostId = await memberEntryHostId(member);
    if (!hostId) throw new Error("Forward group member has no valid entry agent");
    await assertEntryPortAllowed(member, sourcePort);
    const childMemberId = groupMode === "chain" && externalEntryMemberIds.has(Number(member.id)) && firstChainMember
      ? Number(firstChainMember.id)
      : Number(member.id);
    const existing = config.excludeTemplateRuleId
      ? await existingChildRule(Number(config.excludeTemplateRuleId), childMemberId, hostId)
      : null;
    const used = await isPortUsedOnHostForGroupChild(
      hostId,
      sourcePort,
      [Number(config.excludeTemplateRuleId || 0), Number(existing?.id || 0)].filter(Boolean),
      protocol,
    );
    if (used) throw new Error(`Entry agent port ${sourcePort} is already used`);
  }
  return group;
}

export function filterForwardGroupFieldsForUse(groups: any[]) {
  return groups.map((group: any) => ({
    id: group.id,
    name: group.name,
    remark: group.remark || null,
    groupType: group.groupType,
    groupMode: groupModeOf(group),
    entryGroupId: group.entryGroupId ?? null,
    forwardType: group.forwardType,
    domain: group.domain,
    recordType: group.recordType,
    trafficMultiplier: group.trafficMultiplier,
    failoverSeconds: group.failoverSeconds,
    recoverSeconds: group.recoverSeconds,
    chinaHealthCheckEnabled: !!group.chinaHealthCheckEnabled,
    chinaHealthCheckTarget: group.chinaHealthCheckTarget || null,
    telegramSwitchNotifyEnabled: !!group.telegramSwitchNotifyEnabled,
    ddnsAutoResolveEnabled: group.ddnsAutoResolveEnabled !== false,
    autoFailback: group.autoFailback,
    isEnabled: group.isEnabled,
    lastStatus: group.lastStatus,
    lastDdnsValue: group.lastDdnsValue,
    lastFailoverAt: group.lastFailoverAt,
    lastRecoverAt: group.lastRecoverAt,
    templateRuleCount: group.templateRuleCount,
    members: (group.members || []).map((member: any) => ({
      id: member.id,
      groupId: member.groupId,
      memberType: member.memberType,
      hostId: member.hostId ?? null,
      tunnelId: member.tunnelId ?? null,
      connectHost: member.connectHost ?? null,
      entryAddress: member.entryAddress ?? null,
      healthStatus: member.healthStatus,
      lastLatencyMs: member.lastLatencyMs,
      chinaHealthStatus: member.chinaHealthStatus,
      chinaHealthLatencyMs: member.chinaHealthLatencyMs,
      chinaHealthCheckedAt: member.chinaHealthCheckedAt,
      priority: member.priority,
      isEnabled: member.isEnabled,
    })),
  }));
}

async function refreshRuleEndpoints(rule: any, reason: string) {
  if (!rule) return;
  pushAgentRefresh(Number(rule.hostId), reason);
  if ((rule as any).tunnelId) {
    const tunnel = await getTunnelById(Number((rule as any).tunnelId));
    if (tunnel) {
      pushAgentRefresh(Number(tunnel.entryHostId), `${reason}-entry`);
      pushAgentRefresh(Number(tunnel.exitHostId), `${reason}-exit`);
    }
  }
}

async function refreshForwardChainRuntime(groupId: number, reason: string) {
  const group = await getForwardGroupById(groupId);
  if (!group || groupModeOf(group) !== "chain") return;
  const hostIds = new Set<number>();
  for (const member of await chainEntryMembers(group)) {
    const hostId = Number(member?.hostId || 0);
    if (hostId > 0) hostIds.add(hostId);
  }
  for (const member of sortedMembers(group, true) as any[]) {
    const hostId = await memberEntryHostId(member).catch(() => 0);
    if (hostId > 0) hostIds.add(hostId);
  }
  const childRules = await getForwardGroupChildRules(groupId);
  for (const rule of childRules as any[]) {
    const hostId = Number(rule?.hostId || 0);
    if (hostId > 0) hostIds.add(hostId);
  }
  for (const hostId of hostIds) pushAgentRefresh(hostId, `${reason}-chain-${groupId}`);
  if (hostIds.size > 0) {
    appendPanelLog("info", `[ForwardChain] refresh group=${groupId} reason=${reason} hosts=${Array.from(hostIds).join(",")}`);
  }
}

async function dependentChainGroupIds(entryGroupId: number) {
  const db = await getDb();
  if (!db) return [] as number[];
  const rows = await db.select({ id: forwardGroups.id }).from(forwardGroups).where(and(
    eq(forwardGroups.groupMode, "chain"),
    eq(forwardGroups.entryGroupId, entryGroupId),
  ));
  return (rows as any[]).map((row) => Number(row.id || 0)).filter((id) => id > 0);
}

async function forwardGroupRuntimeDependenciesEnabled(group: any) {
  if (!group?.isEnabled) return false;
  if (groupModeOf(group) !== "chain") return true;
  const entryGroupId = Number(group?.entryGroupId || 0);
  if (entryGroupId <= 0) return true;
  const entryGroup = await getForwardGroupById(entryGroupId) as any;
  return !!entryGroup?.isEnabled && groupModeOf(entryGroup) === "entry";
}

async function refreshControlledForwardRules(rules: any[], reason: string) {
  const hostIds = new Set<number>();
  const tunnelIds = new Set<number>();
  for (const rule of rules) {
    if (rule?.isForwardGroupTemplate) continue;
    const hostId = Number(rule?.hostId || 0);
    if (hostId > 0) hostIds.add(hostId);
    const tunnelId = Number(rule?.tunnelId || 0);
    if (tunnelId > 0) tunnelIds.add(tunnelId);
  }
  for (const hostId of hostIds) pushAgentRefresh(hostId, reason);
  for (const tunnelId of tunnelIds) {
    const tunnel = await getTunnelById(tunnelId);
    if (tunnel) await refreshControlledTunnelRuntime(tunnel, reason);
  }
}

async function disableForwardRulesByGroupIds(groupIds: number[], reason: string) {
  const ids = Array.from(new Set(groupIds.map((id) => Number(id)).filter((id) => id > 0)));
  if (ids.length === 0) return 0;
  const db = await getDb();
  if (!db) return 0;
  const rules = await db.select().from(forwardRules).where(and(
    inArray(forwardRules.forwardGroupId, ids),
    eq(forwardRules.pendingDelete, false),
  ));
  const controlledRules = (rules as any[]).filter((rule) => (
    !!rule.isEnabled || !!rule.disabledByTunnel || !!rule.disabledByGroup
  ));
  const controlledIds = controlledRules.map((rule) => Number(rule.id || 0)).filter((id) => id > 0);
  if (controlledIds.length > 0) {
    await db.update(forwardRules).set({
      isEnabled: false,
      isRunning: false,
      disabledByGroup: true,
      updatedAt: nowDate(),
    } as any).where(inArray(forwardRules.id, controlledIds));
    await refreshControlledForwardRules(controlledRules, reason);
  }
  return controlledIds.length;
}

async function restoreForwardRulesByGroupId(groupId: number, reason: string) {
  const group = await getForwardGroupById(groupId) as any;
  if (!group || !(await forwardGroupRuntimeDependenciesEnabled(group))) return 0;
  const db = await getDb();
  if (!db) return 0;
  const rules = await db.select().from(forwardRules).where(and(
    eq(forwardRules.forwardGroupId, groupId),
    eq(forwardRules.disabledByGroup, true),
    eq(forwardRules.pendingDelete, false),
  ));
  for (const rule of rules as any[]) {
    const isTemplate = !!rule.isForwardGroupTemplate;
    const canEnableTemplate = isTemplate
      && !rule.disabledByTunnel
      && !rule.disabledByUser
      && !String(rule.protocolBlockReason || "").trim();
    await db.update(forwardRules).set({
      isEnabled: canEnableTemplate,
      isRunning: false,
      disabledByGroup: false,
      updatedAt: nowDate(),
    } as any).where(eq(forwardRules.id, Number(rule.id)));
  }
  await syncForwardGroupRules(groupId);
  await refreshControlledForwardRules(rules as any[], reason);
  return rules.length;
}

async function tunnelGroupDependenciesEnabled(tunnel: any) {
  const refs: Array<{ id: number; mode: "entry" | "exit" }> = [
    { id: Number(tunnel?.entryGroupId || 0), mode: "entry" },
    { id: Number(tunnel?.exitGroupId || 0), mode: "exit" },
  ];
  for (const ref of refs) {
    if (ref.id <= 0) continue;
    const group = await getForwardGroupById(ref.id) as any;
    if (!group?.isEnabled || groupModeOf(group) !== ref.mode) return false;
  }
  return true;
}

async function setTunnelsEnabledByGroup(groupId: number, groupMode: "entry" | "exit", isEnabled: boolean) {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db.select().from(tunnels).where(
    groupMode === "entry" ? eq(tunnels.entryGroupId, groupId) : eq(tunnels.exitGroupId, groupId),
  );
  let changed = 0;
  for (const row of rows as any[]) {
    const tunnelId = Number(row.id || 0);
    if (tunnelId <= 0) continue;
    await withKeyedTaskLock(`tunnel:${tunnelId}`, async () => {
      const tunnel = await getTunnelById(tunnelId) as any;
      if (!tunnel) return;
      if (!isEnabled) {
        if (!tunnel.isEnabled && !tunnel.disabledByGroup) return;
        await updateTunnel(tunnelId, {
          isEnabled: false,
          isRunning: false,
          disabledByGroup: true,
        } as any);
        await disableForwardRulesByTunnel(tunnelId);
        await refreshControlledTunnelRuntime({ ...tunnel, isEnabled: false, disabledByGroup: true }, `${groupMode}-group-disabled`, { resetRules: true });
        changed += 1;
        return;
      }
      if (!tunnel.disabledByGroup || !(await tunnelGroupDependenciesEnabled(tunnel))) return;
      await updateTunnel(tunnelId, {
        isEnabled: true,
        isRunning: false,
        disabledByGroup: false,
      } as any);
      await restoreForwardRulesByTunnel(tunnelId);
      await refreshControlledTunnelRuntime({ ...tunnel, isEnabled: true, disabledByGroup: false }, `${groupMode}-group-enabled`, { resetRules: true });
      changed += 1;
    });
  }
  return changed;
}

export async function setForwardGroupEnabled(groupId: number, isEnabled: boolean) {
  const group = await getForwardGroupById(groupId) as any;
  if (!group) throw new Error("转发资源不存在");
  const mode = groupModeOf(group);
  const wasEnabled = !!group.isEnabled;
  if (isEnabled && mode === "chain" && Number(group.entryGroupId || 0) > 0) {
    const entryGroup = await getForwardGroupById(Number(group.entryGroupId)) as any;
    if (!entryGroup?.isEnabled || groupModeOf(entryGroup) !== "entry") {
      throw new Error("关联入口组未启用，请先开启入口组");
    }
  }

  const ruleGroupIds = mode === "entry"
    ? await dependentChainGroupIds(groupId)
    : isCollectionGroupMode(mode)
      ? []
      : [groupId];
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(forwardGroups).set({
    isEnabled,
    updatedAt: nowDate(),
  } as any).where(eq(forwardGroups.id, groupId));

  let affectedRules = 0;
  let affectedTunnels = 0;
  try {
    if (!isEnabled) {
      affectedRules = await disableForwardRulesByGroupIds(ruleGroupIds, `${mode}-group-disabled`);
      for (const id of ruleGroupIds) await syncForwardGroupRules(id);
      if (mode === "entry" || mode === "exit") {
        affectedTunnels = await setTunnelsEnabledByGroup(groupId, mode, false);
      }
    } else {
      for (const id of ruleGroupIds) {
        affectedRules += await restoreForwardRulesByGroupId(id, `${mode}-group-enabled`);
      }
      if (mode === "entry" || mode === "exit") {
        affectedTunnels = await setTunnelsEnabledByGroup(groupId, mode, true);
      }
      if (mode === "failover" || mode === "entry" || mode === "exit") {
        await runForwardGroupFailover(groupId, { manual: true, forceSync: true });
      }
    }
  } catch (error) {
    if (isEnabled && !wasEnabled) {
      try {
        await db.update(forwardGroups).set({ isEnabled: false, updatedAt: nowDate() } as any).where(eq(forwardGroups.id, groupId));
        await disableForwardRulesByGroupIds(ruleGroupIds, `${mode}-group-enable-rollback`);
        for (const id of ruleGroupIds) await syncForwardGroupRules(id);
        if (mode === "entry" || mode === "exit") await setTunnelsEnabledByGroup(groupId, mode, false);
      } catch (rollbackError) {
        appendPanelLog("warn", `[ForwardGroup] enable rollback failed group=${groupId}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    throw error;
  }
  await insertForwardGroupEvent(groupId, null, isEnabled ? "enabled" : "disabled", isEnabled ? "链路资源已启用。" : "链路资源已停用，关联规则已受控关闭。");
  return { success: true, affectedRules, affectedTunnels };
}

async function ensureMemberRuleForTemplate(group: any, templateRule: any, member: any, options: SyncForwardGroupRulesOptions = {}) {
  const existing = await existingChildRule(Number(templateRule.id), Number(member.id));
  const enabled = !!group.isEnabled && !!templateRule.isEnabled && !!member.isEnabled;
  if (!enabled) {
    if (existing) {
      await updateForwardRule(Number(existing.id), { isEnabled: false, isRunning: false } as any);
      await refreshRuleEndpoints(existing, "forward-group-child-disabled");
    }
    return null;
  }

  const hostId = await memberEntryHostId(member);
  if (!hostId) throw new Error("Forward group member has no valid entry agent");
  await assertEntryPortAllowed(member, Number(templateRule.sourcePort));
  const used = await isPortUsedOnHostForGroupChild(
    hostId,
    Number(templateRule.sourcePort),
    [Number(templateRule.id), Number(existing?.id || 0)].filter(Boolean),
    templateRule.protocol,
  );
  if (used) throw new Error(`Entry agent port ${templateRule.sourcePort} is already used`);

  let tunnelExitPortReservation: HostPortReservation | null = null;
  try {
  let tunnelId: number | null = null;
  let tunnelExitPort: number | null = null;
  let tunnel: any = null;
  if (member.memberType === "tunnel") {
    tunnelId = Number(member.tunnelId);
    tunnel = await getTunnelById(tunnelId);
    if (!tunnel) throw new Error("Tunnel does not exist");
    if (!tunnel.isEnabled) {
      if (existing) {
        await updateForwardRule(Number(existing.id), { isEnabled: false, isRunning: false } as any);
        await refreshRuleEndpoints(existing, "forward-group-tunnel-disabled");
      }
      return null;
    }
    tunnelExitPort = Number(existing?.tunnelExitPort || 0) || null;
    if (!tunnelExitPort) {
      const exit = await getHostById(Number(tunnel.exitHostId));
      const excludeRuleIds = [Number(templateRule.id), Number(existing?.id || 0)].filter(Boolean);
      tunnelExitPortReservation = await reserveAvailableHostPort({
        hostId: Number(tunnel.exitHostId),
        protocol: "both",
        findPort: (reservedPorts) => findAvailableTunnelExitPort(
          Number(tunnel.exitHostId),
          (exit as any)?.portRangeStart,
          (exit as any)?.portRangeEnd,
          reservedPorts,
          excludeRuleIds,
        ),
        isUsed: (port) => isPortUsedOnHost(Number(tunnel.exitHostId), port, excludeRuleIds, "both"),
      });
      if (!tunnelExitPortReservation) throw new Error("Tunnel exit agent has no available port");
      tunnelExitPort = tunnelExitPortReservation.port;
    }
  }
  const protocol = String(templateRule.protocol || "both");
  const protocolTcpSupported = protocol === "tcp" || protocol === "both";
  const protocolUdpSupported = protocol === "udp" || protocol === "both";
  const isPortGroup = groupModeOf(group) === "port";
  const directRuntimeSource = isPortGroup ? group : templateRule;
  const failoverRuntimeSource = templateRule;
  const directForwardType = String((directRuntimeSource as any).forwardType || "iptables");
  const directProxySupported = protocolTcpSupported && (directForwardType === "gost" || directForwardType === "realm");
  const directRealmOptimizationSupported = protocolTcpSupported && directForwardType === "realm";
  const templateFailoverEnabled = !!(failoverRuntimeSource as any).failoverEnabled && protocol === "tcp";
  const directFailoverEnabled = templateFailoverEnabled && directForwardType === "gost";
  const tunnelMode = String(tunnel?.mode || "").toLowerCase();
  const tunnelFailoverSupported = member.memberType === "tunnel" && isMainBackupGostTunnelMode(tunnelMode);
  const childFailoverEnabled = member.memberType === "tunnel" ? templateFailoverEnabled && tunnelFailoverSupported : directFailoverEnabled;
  const tunnelProxySupported = member.memberType === "tunnel" && !!tunnel && tunnelMode !== "nginx_stream" && tunnelMode !== "nginx_tls";
  const tunnelForwardx = member.memberType === "tunnel" && tunnelMode === "forwardx";
  const blockedByAnotherController = !!existing?.disabledByUser
    || !!existing?.disabledByTunnel
    || !!String(existing?.protocolBlockReason || "").trim();

  const payload: any = {
    hostId,
    name: `[Group:${group.name}] ${templateRule.name}`,
    forwardType: member.memberType === "tunnel" ? "gost" : directForwardType,
    protocol,
    gostMode: "direct",
    gostRelayHost: null,
    gostRelayPort: null,
    tunnelId,
    tunnelExitPort,
    forwardGroupId: Number(group.id),
    forwardGroupRuleId: Number(templateRule.id),
    forwardGroupMemberId: Number(member.id),
    isForwardGroupTemplate: false,
    sourcePort: Number(templateRule.sourcePort),
    targetIp: templateRule.targetIp,
    targetPort: Number(templateRule.targetPort),
    telegramErrorNotifyEnabled: !!(templateRule as any).telegramErrorNotifyEnabled,
    blockHttp: false,
    blockSocks: false,
    blockTls: false,
    proxyProtocolReceive: member.memberType === "tunnel" ? tunnelProxySupported && protocolTcpSupported && !!tunnel.proxyProtocolReceive : directProxySupported && !!(directRuntimeSource as any).proxyProtocolReceive,
    proxyProtocolSend: member.memberType === "tunnel" ? tunnelProxySupported && protocolTcpSupported && !!tunnel.proxyProtocolSend : directProxySupported && !!(directRuntimeSource as any).proxyProtocolSend,
    proxyProtocolExitReceive: member.memberType === "tunnel" ? tunnelProxySupported && protocolTcpSupported && !!tunnel.proxyProtocolExitReceive : false,
    proxyProtocolExitSend: member.memberType === "tunnel" ? tunnelProxySupported && protocolTcpSupported && !!tunnel.proxyProtocolExitSend : false,
    proxyProtocolVersion: member.memberType === "tunnel" ? (tunnelProxySupported && Number(tunnel.proxyProtocolVersion) === 2 ? 2 : 1) : (directProxySupported && Number((directRuntimeSource as any).proxyProtocolVersion) === 2 ? 2 : 1),
    tcpFastOpen: member.memberType === "tunnel" ? tunnelForwardx && protocolTcpSupported && !!tunnel.tcpFastOpen : directRealmOptimizationSupported && !!(directRuntimeSource as any).tcpFastOpen,
    zeroCopy: member.memberType === "tunnel" ? false : directRealmOptimizationSupported && !!(directRuntimeSource as any).zeroCopy,
    udpOverTcp: member.memberType === "tunnel" ? tunnelForwardx && protocolUdpSupported && !!tunnel.udpOverTcp : false,
    udpOverTcpPort: null,
    failoverEnabled: childFailoverEnabled,
    failoverStrategy: (failoverRuntimeSource as any).failoverStrategy || "fallback",
    failoverTargets: childFailoverEnabled ? (failoverRuntimeSource as any).failoverTargets || null : null,
    failoverSeconds: Number((failoverRuntimeSource as any).failoverSeconds || 60),
    recoverSeconds: Number((failoverRuntimeSource as any).recoverSeconds || 120),
    autoFailback: (failoverRuntimeSource as any).autoFailback !== false,
    isEnabled: !blockedByAnotherController,
    disabledByGroup: false,
    isRunning: false,
    pendingDelete: false,
    userId: Number(templateRule.userId),
  };

  if (existing) {
    if (canPreserveChildRuleRuntime(existing, payload, options)) return Number(existing.id);
    await updateForwardRule(Number(existing.id), payload);
    if (member.memberType === "tunnel") {
      const tunnel = await getTunnelById(Number(tunnelId || 0));
      if (tunnel) await reconcileForwardRuleTunnelExits({ ...existing, ...payload, id: existing.id }, tunnel);
    }
    await refreshRuleEndpoints({ ...existing, ...payload, id: existing.id }, "forward-group-child-updated");
    return Number(existing.id);
  }

  const ruleId = await createForwardRule(payload);
  if (member.memberType === "tunnel") {
    const tunnel = await getTunnelById(Number(tunnelId || 0));
    if (tunnel) await reconcileForwardRuleTunnelExits({ ...payload, id: ruleId }, tunnel);
  }
  await refreshRuleEndpoints({ ...payload, id: ruleId }, "forward-group-child-created");
  return ruleId;
  } finally {
    tunnelExitPortReservation?.release();
  }
}

async function ensureChainRuleForTemplate(
  group: any,
  templateRule: any,
  member: any,
  nextMember: any | null,
  index: number,
  total: number,
  options: SyncForwardGroupRulesOptions = {},
  overrides: {
    sourceMember?: any | null;
    sourceHost?: any | null;
    targetIp?: string | null;
    targetPort?: number | null;
    namePrefix?: string;
  } = {},
) {
  const sourceMember = overrides.sourceMember || member;
  if (sourceMember.memberType !== "host") throw new Error("Port forwarding chain only supports host members");
  const sourceHostId = Number(overrides.sourceHost?.id || sourceMember.hostId || 0);
  const existing = await existingChildRule(Number(templateRule.id), Number(member.id), sourceHostId);
  if (!existing && options.createMissing === false) return null;
  const enabled = !!group.isEnabled && !!templateRule.isEnabled && !!member.isEnabled && !!sourceMember.isEnabled;
  if (!enabled) {
    if (existing) {
      await updateForwardRule(Number(existing.id), { isEnabled: false, isRunning: false } as any);
      await refreshRuleEndpoints(existing, "forward-chain-child-disabled");
    }
    return null;
  }

  if (member.memberType !== "host") throw new Error("Port forwarding chain only supports host members");
  const hostId = sourceHostId || await memberEntryHostId(sourceMember);
  if (!hostId) throw new Error("Port forwarding chain member has no valid entry agent");
  if (options.validatePorts !== false) {
    await assertEntryPortAllowed(sourceMember, Number(templateRule.sourcePort));
    const used = await isPortUsedOnHostForGroupChild(
      hostId,
      Number(templateRule.sourcePort),
      [Number(templateRule.id), Number(existing?.id || 0)].filter(Boolean),
      templateRule.protocol,
    );
    if (used) throw new Error(`Entry agent port ${templateRule.sourcePort} is already used`);
  }

  let targetIp = String(templateRule.targetIp || "").trim();
  let targetPort = Number(templateRule.targetPort);
  if (overrides.targetIp) {
    targetIp = String(overrides.targetIp || "").trim();
    targetPort = Number(overrides.targetPort || templateRule.sourcePort);
  } else if (nextMember) {
    if (nextMember.memberType !== "host") throw new Error("Port forwarding chain only supports host members");
    const nextHost = await getHostById(Number(nextMember.hostId));
    targetIp = resolveChainConnectHost(nextMember, nextHost);
    targetPort = Number(templateRule.sourcePort);
    if (!targetIp) throw new Error("Next chain host has no usable connect address");
  }

  const chainForwardType = String((group as any).forwardType || templateRule.forwardType || "iptables");
  const protocol = String(templateRule.protocol || "both");
  const protocolTcpSupported = protocol === "tcp" || protocol === "both";
  const chainProxyProtocolSupported = protocolTcpSupported && (chainForwardType === "gost" || chainForwardType === "realm");
  const chainRealmOptimizationSupported = protocolTcpSupported && chainForwardType === "realm";
  const blockedByAnotherController = !!existing?.disabledByUser
    || !!existing?.disabledByTunnel
    || !!String(existing?.protocolBlockReason || "").trim();

  const payload: any = {
    hostId,
    name: `[Chain:${group.name}] ${overrides.namePrefix || `${index + 1}/${total}`} ${templateRule.name}`,
    forwardType: chainForwardType,
    protocol,
    gostMode: "direct",
    gostRelayHost: null,
    gostRelayPort: null,
    tunnelId: null,
    tunnelExitPort: null,
    forwardGroupId: Number(group.id),
    forwardGroupRuleId: Number(templateRule.id),
    forwardGroupMemberId: Number(member.id),
    isForwardGroupTemplate: false,
    sourcePort: Number(templateRule.sourcePort),
    targetIp,
    targetPort,
    telegramErrorNotifyEnabled: !!(templateRule as any).telegramErrorNotifyEnabled,
    blockHttp: false,
    blockSocks: false,
    blockTls: false,
    proxyProtocolReceive: chainProxyProtocolSupported && !!(group as any).proxyProtocolReceive,
    proxyProtocolSend: chainProxyProtocolSupported && !!(group as any).proxyProtocolSend,
    proxyProtocolExitReceive: false,
    proxyProtocolExitSend: false,
    proxyProtocolVersion: chainProxyProtocolSupported && Number((group as any).proxyProtocolVersion) === 2 ? 2 : 1,
    tcpFastOpen: chainRealmOptimizationSupported && !!(group as any).tcpFastOpen,
    zeroCopy: chainRealmOptimizationSupported && !!(group as any).zeroCopy,
    udpOverTcp: false,
    udpOverTcpPort: null,
    failoverEnabled: false,
    failoverStrategy: "fallback",
    failoverTargets: null,
    failoverSeconds: 60,
    recoverSeconds: 120,
    autoFailback: true,
    isEnabled: !blockedByAnotherController,
    disabledByGroup: false,
    isRunning: false,
    pendingDelete: false,
    userId: Number(templateRule.userId),
  };

  if (existing) {
    if (canPreserveChildRuleRuntime(existing, payload, options)) return Number(existing.id);
    await updateForwardRule(Number(existing.id), payload);
    await refreshRuleEndpoints({ ...existing, ...payload, id: existing.id }, "forward-chain-child-updated");
    return Number(existing.id);
  }

  const ruleId = await createForwardRule(payload);
  await refreshRuleEndpoints({ ...payload, id: ruleId }, "forward-chain-child-created");
  return ruleId;
}

async function removeStaleForwardGroupChildRules(
  groupId: number,
  liveMemberIds: Set<number>,
  liveTemplateIds: Set<number>,
  liveChildKeys: Set<string>,
) {
  const childRules = await getForwardGroupChildRules(groupId);
  for (const child of childRules as any[]) {
    const childKey = `${Number(child.forwardGroupRuleId)}:${Number(child.forwardGroupMemberId)}:${Number(child.hostId)}`;
    if (
      !liveMemberIds.has(Number(child.forwardGroupMemberId))
      || !liveTemplateIds.has(Number(child.forwardGroupRuleId))
      || !liveChildKeys.has(childKey)
    ) {
      await removeManagedRule(Number(child.id));
    }
  }
}

async function removeManagedRule(ruleId: number) {
  const rule = await getForwardRuleById(ruleId);
  if (!rule) return;
  const billingResource = await findTrafficBillingResourceForRule(rule);
  const fallback = trafficBillingResourceCandidatesForRule(rule)[0];
  const resource = billingResource || fallback;
  if (!resource) {
    await markForwardRulePendingDelete(ruleId);
    await refreshRuleEndpoints(rule, "forward-group-child-deleted");
    return;
  }
  const billed = await settleTrafficBillingRuleOnDelete({
    userId: Number((rule as any).userId),
    ruleId: Number((rule as any).id),
    resourceType: resource.resourceType,
    resourceId: resource.resourceId,
  });
  if (billed && Number(billed.balanceAfterCents) < 0) {
    await setUserForwardAccess(Number((rule as any).userId), false, "traffic_billing_balance");
  }
  await markForwardRulePendingDelete(ruleId);
  await refreshRuleEndpoints(rule, "forward-group-child-deleted");
}

export async function syncForwardGroupRules(groupId: number, options: SyncForwardGroupRulesOptions = {}) {
  return withKeyedTaskLock(`forward-group-sync:${groupId}`, async () => {
  const group = await getForwardGroupById(groupId);
  if (!group) return;
  const db = await getDb();
  const members = sortedMembers(group) as any[];
  const groupMode = groupModeOf(group);
  const preserveRuntime = !!options.preserveRuntime;
  const activeChainMembers = groupMode === "chain" ? members.filter((member: any) => !!member.isEnabled) : members;

  if (groupMode === "port") {
    if (members.length !== 1) throw new Error("端口转发需要配置 1 台所属主机");
    if (String(group.groupType || "host") !== "host") throw new Error("端口转发仅支持主机成员");
    if (members.some((member) => member.memberType !== "host")) throw new Error("端口转发仅支持主机成员");
    await repairPortForwardRuleHostReferences(groupId);
  }

  const templates = await getForwardGroupTemplateRules(groupId);

  if (isCollectionGroupMode(groupMode)) {
    const childRules = await getForwardGroupChildRules(groupId);
    for (const child of childRules as any[]) await removeManagedRule(Number(child.id));
    for (const template of templates as any[]) await markForwardRulePendingDelete(Number(template.id));
    for (const member of members) {
      if (member.ruleId) {
        await removeManagedRule(Number(member.ruleId));
        await db.update(forwardGroupMembers).set({ ruleId: null, updatedAt: nowDate() } as any).where(eq(forwardGroupMembers.id, member.id));
      }
    }
    return;
  }

  const runtimeDependenciesEnabled = await forwardGroupRuntimeDependenciesEnabled(group);
  const hasEnabledTemplates = (templates as any[]).some((template) => !!template.isEnabled);
  if (!runtimeDependenciesEnabled || !hasEnabledTemplates) {
    const childRules = (await getForwardGroupChildRules(groupId) as any[]).filter((rule) => !rule.pendingDelete);
    const childIds = childRules.map((rule) => Number(rule.id || 0)).filter((id) => id > 0);
    if (childIds.length > 0) {
      await db.update(forwardRules).set({
        isEnabled: false,
        isRunning: false,
        updatedAt: nowDate(),
      } as any).where(inArray(forwardRules.id, childIds));
      await refreshControlledForwardRules(childRules, "forward-group-runtime-disabled");
    }
    const templateIds = (templates as any[]).map((template) => Number(template.id || 0)).filter((id) => id > 0);
    if (templateIds.length > 0) {
      await db.update(forwardRules).set({ isRunning: false, updatedAt: nowDate() } as any).where(inArray(forwardRules.id, templateIds));
    }
    return;
  }

  const liveMemberIds = new Set((groupMode === "chain" ? activeChainMembers : members).map((m: any) => Number(m.id)));
  const liveTemplateIds = new Set((templates as any[]).map((rule: any) => Number(rule.id)));

  if (groupMode === "chain") {
    const liveChildKeys = new Set<string>();
    const entryMembers = await chainEntryMembers(group);
    const firstChainMember = activeChainMembers[0] || null;
    for (const template of templates as any[]) {
      if (firstChainMember && entryMembers.length > 0) {
        for (const entryMember of entryMembers) {
          const entryHostId = await memberEntryHostId(entryMember);
          if (entryHostId > 0) liveChildKeys.add(`${Number(template.id)}:${Number(firstChainMember.id)}:${entryHostId}`);
        }
      }
      for (const member of activeChainMembers) {
        const hostId = await memberEntryHostId(member);
        if (hostId > 0) liveChildKeys.add(`${Number(template.id)}:${Number(member.id)}:${hostId}`);
      }
    }
    await removeStaleForwardGroupChildRules(groupId, liveMemberIds, liveTemplateIds, liveChildKeys);
  } else {
    const childRules = await getForwardGroupChildRules(groupId);
    for (const child of childRules as any[]) {
      if (!liveMemberIds.has(Number(child.forwardGroupMemberId)) || !liveTemplateIds.has(Number(child.forwardGroupRuleId))) {
        await removeManagedRule(Number(child.id));
      }
    }
  }

  for (const member of members) {
    if (member.ruleId) {
      await removeManagedRule(Number(member.ruleId));
      await db.update(forwardGroupMembers).set({ ruleId: null, updatedAt: nowDate() } as any).where(eq(forwardGroupMembers.id, member.id));
    }
  }

  for (const template of templates as any[]) {
    if (groupMode === "chain") {
      const entryMembers = await chainEntryMembers(group);
      const minChainMembers = entryMembers.length > 0 ? 1 : 2;
      if (activeChainMembers.length < minChainMembers || activeChainMembers.length > 5) {
        throw new Error(entryMembers.length > 0 ? "Port forwarding chain requires 1-5 enabled hosts" : "Port forwarding chain requires 2-5 enabled hosts");
      }
      if (entryMembers.length > 0) {
        const firstMember = activeChainMembers[0];
        const firstHost = await getHostById(Number(firstMember.hostId));
        const targetIp = resolveChainConnectHost(firstMember, firstHost);
        if (!targetIp) throw new Error("First chain host has no usable connect address");
        for (const [entryIndex, entryMember] of entryMembers.entries()) {
          const entryHostId = await memberEntryHostId(entryMember);
          if (activeChainMembers.some((member: any) => Number(member.hostId || 0) === entryHostId)) {
            throw new Error("Entry group host cannot also be used inside the port forwarding chain");
          }
          const entryHost = await getHostById(entryHostId);
          const ruleId = await ensureChainRuleForTemplate(group, template, firstMember, null, entryIndex, entryMembers.length, options, {
            sourceMember: entryMember,
            sourceHost: entryHost,
            targetIp,
            targetPort: Number(template.sourcePort),
            namePrefix: `entry ${entryIndex + 1}/${entryMembers.length}`,
          });
          if (ruleId && !preserveRuntime) {
            await db.update(forwardRules).set({ isRunning: false, updatedAt: nowDate() }).where(eq(forwardRules.id, ruleId));
          }
        }
      }
      for (const [index, member] of activeChainMembers.entries()) {
        const nextMember = activeChainMembers[index + 1] || null;
        const ruleId = await ensureChainRuleForTemplate(group, template, member, nextMember, index, activeChainMembers.length, options);
        if (ruleId && !preserveRuntime) {
          await db.update(forwardRules).set({ isRunning: false, updatedAt: nowDate() }).where(eq(forwardRules.id, ruleId));
        }
      }
    } else {
      for (const member of members) {
        const ruleId = await ensureMemberRuleForTemplate(group, template, member, options);
        if (ruleId && !preserveRuntime) {
          await db.update(forwardRules).set({ isRunning: false, updatedAt: nowDate() }).where(eq(forwardRules.id, ruleId));
        }
      }
    }
    if (!preserveRuntime) {
      await db.update(forwardRules).set({ isRunning: false, updatedAt: nowDate() }).where(eq(forwardRules.id, template.id));
    }
  }

  if (!preserveRuntime) {
    for (const member of members) {
      if (member.memberType === "tunnel" && member.tunnelId) {
        const tunnel = await getTunnelById(Number(member.tunnelId));
        if (tunnel) await updateTunnel(Number(member.tunnelId), { isRunning: false } as any);
      }
    }
  }
  });
}

export async function syncForwardGroupTemplateRule(templateRuleId: number) {
  const template = await getForwardRuleById(templateRuleId);
  if (!template || !(template as any).forwardGroupId) return;
  await syncForwardGroupRules(Number((template as any).forwardGroupId));
}

export async function createForwardGroup(data: InsertForwardGroup, members: ForwardGroupMemberInput[]) {
  if (members.length === 0) throw new Error("转发组至少需要一个成员");
  const groupMode = groupModeOf(data);
  validateForwardGroupModeMembers(groupMode, String((data as any).groupType || "host"), members, {
    externalEntry: groupMode === "chain" && Number((data as any).entryGroupId || 0) > 0,
  });
  if (groupMode === "entry" && !String((data as any).domain || "").trim()) throw new Error("入口组需要指定入口域名");
  for (const member of members) await targetHostIdForMember(member);
  const normalizedMembers = await Promise.all(members.map((member, index) => normalizeForwardGroupMemberInput(groupMode, member, index, {
    externalEntry: groupMode === "chain" && Number((data as any).entryGroupId || 0) > 0,
  })));
  await validateForwardGroupRecordMembers({ ...data, groupMode }, normalizedMembers as any);
  const sortOrder = (data as any).sortOrder === undefined
    ? await nextForwardGroupSortOrder(Number((data as any).userId || 0), groupMode)
    : Math.max(0, Math.floor(Number((data as any).sortOrder) || 0));
  const id = await insertAndGetId("forward_groups", {
    ...data,
    groupMode,
    sortOrder,
    forwardType: (data as any).forwardType || "iptables",
    sourcePort: Number((data as any).sourcePort || 1),
    protocol: (data as any).protocol || "both",
    targetIp: (data as any).targetIp || "0.0.0.0",
    targetPort: Number((data as any).targetPort || 1),
    createdAt: nowDate(),
    updatedAt: nowDate(),
  } as any);
  for (const [index, member] of normalizedMembers.entries()) {
    await insertAndGetId("forward_group_members", {
      groupId: id,
      memberType: member.memberType,
      hostId: member.memberType === "host" ? member.hostId : null,
      tunnelId: member.memberType === "tunnel" ? member.tunnelId : null,
      connectHost: member.connectHost ?? null,
      priority: member.priority ?? index,
      isEnabled: member.isEnabled ?? true,
      createdAt: nowDate(),
      updatedAt: nowDate(),
    });
  }
  await insertForwardGroupEvent(id, null, "created", groupMode === "chain"
    ? "Port forwarding chain created; rules will generate hop routes when this chain is selected."
    : groupMode === "entry"
      ? "入口组已创建；开启自动解析后会把入口主机同步到同一个入口域名。"
      : groupMode === "exit"
        ? "出口组已创建；可在隧道中作为出口组选择。"
        : "Forward group created; use it from forwarding rules to generate member routes.");
  return id;
}

type RuleProtocol = "tcp" | "udp" | "both";

function normalizeRuleProtocol(protocol: unknown): RuleProtocol {
  const text = String(protocol || "both").toLowerCase();
  return text === "tcp" || text === "udp" ? text : "both";
}

function rawProtocolConflictWhere(protocolColumn: string, protocol: unknown) {
  const requestedProtocol = normalizeRuleProtocol(protocol);
  if (requestedProtocol === "both") return { sql: "", params: [] as unknown[] };
  return {
    sql: ` AND (${protocolColumn} IS NULL OR ${protocolColumn} = ? OR ${protocolColumn} = ? OR ${protocolColumn} = ?)`,
    params: ["", "both", requestedProtocol] as unknown[],
  };
}

async function nextForwardGroupSortOrder(userId: number, groupMode: ForwardGroupMode) {
  const q = quoteIdentifier;
  const params: any[] = [groupMode];
  let where = ` WHERE ${q("groupMode")} = ?`;
  if (userId > 0) {
    where += ` AND ${q("userId")} = ?`;
    params.push(userId);
  }
  const rows = await queryRaw<{ nextSortOrder: number }>(
    `SELECT COALESCE(MAX(${q("sortOrder")}), -1) + 1 AS ${q("nextSortOrder")} FROM ${q("forward_groups")}${where}`,
    params,
  ).catch(() => []);
  const value = Number(rows[0]?.nextSortOrder || 0);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export async function reorderForwardGroups(groupMode: ForwardGroupMode, ids: number[]) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const mode = groupModeOf({ groupMode });
  const orderedIds = ids.map((id) => Math.floor(Number(id))).filter((id) => Number.isInteger(id) && id > 0);
  if (orderedIds.length === 0 || new Set(orderedIds).size !== orderedIds.length) throw new Error("排序数据无效");
  const rows = await db.select({
    id: forwardGroups.id,
    groupMode: forwardGroups.groupMode,
  }).from(forwardGroups).where(inArray(forwardGroups.id, orderedIds));
  if (rows.length !== orderedIds.length) throw new Error("排序中包含不存在的转发项目");
  if ((rows as any[]).some((row) => groupModeOf(row) !== mode)) throw new Error("排序项目类型不一致");
  const q = quoteIdentifier;
  for (const [index, id] of orderedIds.entries()) {
    await executeRaw(`UPDATE ${q("forward_groups")} SET ${q("sortOrder")} = ? WHERE ${q("id")} = ?`, [index, id]);
  }
}

export async function updateForwardGroup(id: number, data: Partial<InsertForwardGroup>, options: { skipSync?: boolean } = {}) {
  const db = await getDb();
  await db.update(forwardGroups).set({ ...data, updatedAt: nowDate() }).where(eq(forwardGroups.id, id));
  if (!options.skipSync) {
    await syncForwardGroupRules(id);
    const group = await getForwardGroupById(id);
    if (groupModeOf(group) === "entry") {
      await syncChainsUsingEntryGroup(id);
      await refreshTunnelsUsingEntryGroup(id);
    }
  }
}

export async function replaceForwardGroupMembers(
  groupId: number,
  members: ForwardGroupMemberInput[],
  options: { skipSync?: boolean } = {},
) {
  if (members.length === 0) throw new Error("转发组至少需要一个成员");
  const group = await getForwardGroupById(groupId);
  const groupMode = groupModeOf(group);
  validateForwardGroupModeMembers(groupMode, String((group as any)?.groupType || "host"), members, {
    externalEntry: groupMode === "chain" && Number((group as any)?.entryGroupId || 0) > 0,
  });
  const normalizedMembers = await Promise.all(members.map((member, index) => normalizeForwardGroupMemberInput(groupMode, member, index, {
    externalEntry: groupMode === "chain" && Number((group as any)?.entryGroupId || 0) > 0,
  })));
  await validateForwardGroupRecordMembers(group, normalizedMembers as any);
  const db = await getDb();
  const existing = await db.select().from(forwardGroupMembers).where(eq(forwardGroupMembers.groupId, groupId));
  const keepKeys = new Set(normalizedMembers.map((m) => `${m.memberType}:${m.memberType === "host" ? m.hostId : m.tunnelId}`));

  for (const old of existing as any[]) {
    const key = `${old.memberType}:${old.memberType === "host" ? old.hostId : old.tunnelId}`;
    if (!keepKeys.has(key)) {
      const childRules = await getForwardGroupChildRulesForMember(Number(old.id));
      for (const rule of childRules as any[]) await removeManagedRule(Number(rule.id));
      if (old.ruleId) await removeManagedRule(Number(old.ruleId));
      await db.delete(forwardGroupMembers).where(eq(forwardGroupMembers.id, old.id));
    }
  }

  const current = await db.select().from(forwardGroupMembers).where(eq(forwardGroupMembers.groupId, groupId));
  for (const [index, member] of normalizedMembers.entries()) {
    await targetHostIdForMember(member);
    const found = (current as any[]).find((row) => row.memberType === member.memberType
      && Number(row.memberType === "host" ? row.hostId : row.tunnelId) === Number(member.memberType === "host" ? member.hostId : member.tunnelId));
    const payload: Partial<InsertForwardGroupMember> = {
      priority: member.priority ?? index,
      isEnabled: member.isEnabled ?? true,
      connectHost: member.connectHost ?? null,
      updatedAt: nowDate(),
    } as any;
    if (found) {
      await db.update(forwardGroupMembers).set(payload).where(eq(forwardGroupMembers.id, found.id));
    } else {
      await insertAndGetId("forward_group_members", {
        groupId,
        memberType: member.memberType,
        hostId: member.memberType === "host" ? member.hostId : null,
        tunnelId: member.memberType === "tunnel" ? member.tunnelId : null,
        connectHost: member.connectHost ?? null,
        priority: member.priority ?? index,
        isEnabled: member.isEnabled ?? true,
        createdAt: nowDate(),
        updatedAt: nowDate(),
      });
    }
  }
  if (options.skipSync) return;
  if (isCollectionGroupMode(groupMode)) {
    await runForwardGroupFailover(groupId, { forceSync: true, manual: true });
    if (groupMode === "entry") {
      await syncChainsUsingEntryGroup(groupId);
      await refreshTunnelsUsingEntryGroup(groupId);
    }
  } else {
    await syncForwardGroupRules(groupId, groupMode === "chain" ? { validatePorts: false } : {});
    if (groupMode === "chain") await refreshForwardChainRuntime(groupId, "forward-chain-members-updated");
  }
}

export async function deleteForwardGroup(id: number) {
  const db = await getDb();
  const childRules = await getForwardGroupChildRules(id);
  for (const rule of childRules as any[]) await removeManagedRule(Number(rule.id));
  const templates = await getForwardGroupTemplateRules(id);
  for (const template of templates as any[]) {
    const billingResource = await findTrafficBillingResourceForRule(template);
    const fallback = trafficBillingResourceCandidatesForRule(template)[0];
    const resource = billingResource || fallback;
    if (resource) {
      const billed = await settleTrafficBillingRuleOnDelete({
        userId: Number((template as any).userId),
        ruleId: Number((template as any).id),
        resourceType: resource.resourceType,
        resourceId: resource.resourceId,
      });
      if (billed && Number(billed.balanceAfterCents) < 0) {
        await setUserForwardAccess(Number((template as any).userId), false, "traffic_billing_balance");
      }
    }
    await markForwardRulePendingDelete(Number(template.id));
  }
  const members = await db.select().from(forwardGroupMembers).where(eq(forwardGroupMembers.groupId, id));
  for (const member of members as any[]) {
    if (member.ruleId) await removeManagedRule(Number(member.ruleId));
  }
  await db.delete(forwardGroupEvents).where(eq(forwardGroupEvents.groupId, id));
  await db.delete(forwardGroupMembers).where(eq(forwardGroupMembers.groupId, id));
  await db.delete(userForwardGroupPermissions).where(eq(userForwardGroupPermissions.forwardGroupId, id));
  await db.delete(forwardGroups).where(eq(forwardGroups.id, id));
}

export async function reorderForwardGroupMembers(groupId: number, memberIds: number[]) {
  const db = await getDb();
  for (const [index, memberId] of memberIds.entries()) {
    await db.update(forwardGroupMembers).set({ priority: index, updatedAt: nowDate() }).where(and(
      eq(forwardGroupMembers.groupId, groupId),
      eq(forwardGroupMembers.id, memberId),
    ));
  }
  await insertForwardGroupEvent(groupId, null, "reorder", "Member priority updated.");
}

export async function syncForwardChainsForHost(hostId: number, previousHost?: any) {
  const db = await getDb();
  if (!db) return;
  const currentHost = await getHostById(hostId);
  const rows = await db
    .select({
      groupId: forwardGroupMembers.groupId,
    })
    .from(forwardGroupMembers)
    .where(and(
      eq(forwardGroupMembers.memberType, "host"),
      eq(forwardGroupMembers.hostId, hostId),
    ));
  const groupIds = Array.from(new Set((rows as any[]).map((row) => Number(row.groupId)).filter((id) => id > 0)));
  for (const groupId of groupIds) {
    const group = await getForwardGroupById(groupId);
    const mode = groupModeOf(group);
    if (mode === "entry") await runForwardGroupFailover(groupId);
    if (mode === "chain") {
      const members = sortedMembers(group) as any[];
      const entryMembers = await chainEntryMembers(group);
      const hasExternalEntry = entryMembers.length > 0;
      const currentPublic = entryAddressForHost(currentHost);
      const currentPrivate = privateAddressForHost(currentHost);
      const currentIpv6 = ipv6AddressForConnectHost(currentHost);
      const previousPublic = entryAddressForHost(previousHost);
      const previousPrivate = privateAddressForHost(previousHost);
      const previousIpv6 = ipv6AddressForConnectHost(previousHost);
      for (const [index, member] of members.entries()) {
        if (Number(member.hostId || 0) !== Number(hostId)) continue;
        const stored = String(member.connectHost || "").trim();
        let nextConnectHost: string | null | undefined;
        if (index === 0 && !hasExternalEntry) {
          nextConnectHost = null;
        } else if (previousPrivate && stored === previousPrivate) {
          nextConnectHost = currentPrivate || null;
        } else if (previousIpv6 && stored === previousIpv6) {
          nextConnectHost = currentIpv6 || null;
        } else if (previousPublic && stored === previousPublic) {
          nextConnectHost = null;
        }
        if (nextConnectHost !== undefined && (stored || null) !== nextConnectHost) {
          await db.update(forwardGroupMembers).set({
            connectHost: nextConnectHost,
            updatedAt: nowDate(),
          } as any).where(eq(forwardGroupMembers.id, member.id));
        }
      }
      await syncForwardGroupRules(groupId, { validatePorts: false, createMissing: false });
      await refreshForwardChainRuntime(groupId, "host-address-updated");
    }
  }
}

export async function runForwardGroupsForHostAddressChange(hostId: number, reason = "host-address-changed") {
  const db = await getDb();
  if (!db) return 0;
  const id = Number(hostId || 0);
  if (!Number.isInteger(id) || id <= 0) return 0;

  const directRows = await db
    .select({ groupId: forwardGroupMembers.groupId })
    .from(forwardGroupMembers)
    .where(and(
      eq(forwardGroupMembers.memberType, "host"),
      eq(forwardGroupMembers.hostId, id),
      eq(forwardGroupMembers.isEnabled, true),
    ));
  const tunnelRows = await db
    .select({ groupId: forwardGroupMembers.groupId })
    .from(forwardGroupMembers)
    .innerJoin(tunnels, eq(forwardGroupMembers.tunnelId, tunnels.id))
    .where(and(
      eq(forwardGroupMembers.memberType, "tunnel"),
      eq(tunnels.entryHostId, id),
      eq(forwardGroupMembers.isEnabled, true),
    ));
  const groupIds = Array.from(new Set([
    ...directRows.map((row: any) => Number(row.groupId || 0)),
    ...tunnelRows.map((row: any) => Number(row.groupId || 0)),
  ].filter((value) => Number.isInteger(value) && value > 0)));
  if (groupIds.length === 0) return 0;

  const groups = await Promise.all(groupIds.map((groupId) => getForwardGroupById(groupId)));
  const activeGroups = (groups as any[]).filter((group: any) => {
    const mode = groupModeOf(group);
    return group?.isEnabled !== false && (mode === "failover" || mode === "entry");
  });
  if (activeGroups.length === 0) return 0;

  appendPanelLog("info", `[HostAddress] host=${id} refreshing ${activeGroups.length} DDNS group(s) reason=${reason}`);
  await runForwardGroupFailoverForGroups(activeGroups, {
    forceSync: true,
    suppressSwitchNotify: true,
  });
  return activeGroups.length;
}

async function latestTcping(ruleId: number) {
  const table = quoteIdentifier("tcping_stats");
  const result = await queryRaw<any>(
    `SELECT * FROM ${table} WHERE ${quoteIdentifier("ruleId")} = ? ORDER BY ${quoteIdentifier("recordedAt")} DESC LIMIT 1`,
    [ruleId],
  );
  return result[0];
}

async function evaluateMemberHealth(member: any, group: any) {
  const db = await getDb();
  const now = nowDate();
  const childRules = await getForwardGroupChildRulesForMember(Number(member.id));
  let healthy = false;
  let latencyMs: number | null = null;
  let message = "";

  if (!member.isEnabled) {
    message = "Member disabled";
  } else if (childRules.length === 0) {
    message = "No forwarding rule is using this group yet";
  } else {
    const templateRuleIds = Array.from(new Set((childRules as any[])
      .map((rule: any) => Number(rule.forwardGroupRuleId || 0))
      .filter((id: number) => Number.isInteger(id) && id > 0)));
    const templateRows = templateRuleIds.length > 0
      ? await db
        .select({
          id: forwardRules.id,
          isEnabled: forwardRules.isEnabled,
          pendingDelete: forwardRules.pendingDelete,
        })
        .from(forwardRules)
        .where(inArray(forwardRules.id, templateRuleIds))
      : [];
    const enabledTemplateIds = new Set((templateRows as any[])
      .filter((rule: any) => dbBool(rule.isEnabled) && !dbBool(rule.pendingDelete))
      .map((rule: any) => Number(rule.id || 0))
      .filter((id: number) => id > 0));
    const activeChildRules = (childRules as any[])
      .filter((rule: any) => enabledTemplateIds.has(Number(rule.forwardGroupRuleId || 0)));

    if (activeChildRules.length === 0) {
      message = "No enabled forwarding rule is using this group member";
    } else {
      healthy = true;
      const latencies: number[] = [];
      for (const rule of activeChildRules as any[]) {
        if (!dbBool(rule.isEnabled) || dbBool(rule.pendingDelete)) {
          healthy = false;
          message = "Member rule disabled";
          break;
        }
        if (!dbBool(rule.isRunning)) {
          healthy = false;
          message = "Member rule not running yet";
          break;
        }
        const stat = await latestTcping(Number(rule.id));
        if (stat?.isTimeout) {
          healthy = false;
          message = "Latency probe timeout";
          break;
        }
        if (stat && typeof stat.latencyMs !== "undefined" && stat.latencyMs !== null) {
          latencies.push(Number(stat.latencyMs));
        }
      }
      if (healthy && group.chinaHealthCheckEnabled) {
        const chinaStatus = String(member.chinaHealthStatus || "unknown");
        if (chinaStatus === "unhealthy") {
          healthy = false;
          message = "国内健康度检测超时";
        } else if (chinaStatus !== "healthy") {
          healthy = false;
          message = "等待国内健康度检测数据";
        } else if (typeof member.chinaHealthLatencyMs === "number") {
          latencies.push(Number(member.chinaHealthLatencyMs));
        }
      }
      if (healthy) {
        latencyMs = latencies.length > 0 ? Math.round(latencies.reduce((sum, v) => sum + v, 0) / latencies.length) : null;
        message = latencies.length > 0 ? "Latency probe normal" : "Rule is running, waiting for latency probe data";
      }
    }
  }

  const prevFailure = toDate(member.failureSince);
  const prevHealthy = toDate(member.healthySince);
  const failureSince = healthy ? null : (prevFailure || now);
  const healthySince = healthy ? (prevHealthy || now) : null;
  await db.update(forwardGroupMembers).set({
    healthStatus: healthy ? "healthy" : "unhealthy",
    lastLatencyMs: latencyMs,
    failureSince,
    healthySince,
    lastCheckedAt: now,
    updatedAt: now,
  } as any).where(eq(forwardGroupMembers.id, member.id));

  const failedLongEnough = !!failureSince && Date.now() - failureSince.getTime() >= Number(group.failoverSeconds || 60) * 1000;
  const recoveredLongEnough = !!healthySince && Date.now() - healthySince.getTime() >= Number(group.recoverSeconds || 120) * 1000;
  return { ...member, healthy, latencyMs, message, failureSince, healthySince, failedLongEnough, recoveredLongEnough };
}

async function syncEntryGroupDdns(group: any, ddnsSettings: any, options: ForwardGroupFailoverOptions = {}) {
  const db = await getDb();
  const members = sortedMembers(group, true) as any[];
  const recordType = normalizeForwardGroupRecordType(group.recordType);
  const forceSync = !!options.forceSync;
  const previousValue = String(group.lastDdnsValue || "").trim();
  const values: string[] = [];
  const excluded: string[] = [];
  let activeMemberId: number | null = null;
  const chinaHealthEnabled = !!group.chinaHealthCheckEnabled;
  for (const member of members) {
    if (member.memberType !== "host") continue;
    const value = await memberDdnsValue(member, recordType).catch(() => "");
    if (!value) continue;
    if (chinaHealthEnabled && String(member.chinaHealthStatus || "unknown") === "unhealthy") {
      if (!excluded.includes(value)) excluded.push(value);
      continue;
    }
    if (!values.includes(value)) {
      values.push(value);
      if (!activeMemberId) activeMemberId = Number(member.id || 0) || null;
    }
    if (recordType === "CNAME") break;
  }
  const joined = values.join(",");
  const excludedSuffix = excluded.length > 0 ? `；已临时剔除 ${excluded.length} 个不健康入口` : "";

  if (!String(group.domain || "").trim()) {
    await db.update(forwardGroups).set({
      lastStatus: "error",
      lastMessage: "入口组需要指定入口域名。",
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, group.id));
    return;
  }
  if (values.length === 0) {
    const requirement = recordTypeRequirementLabel(recordType);
    await db.update(forwardGroups).set({
      lastStatus: "down",
      lastMessage: excluded.length > 0 ? `入口组没有健康的${requirement}。` : `入口组没有可用${requirement}。`,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, group.id));
    return;
  }

  if (group.ddnsAutoResolveEnabled === false) {
    await db.update(forwardGroups).set({
      activeMemberId,
      lastDdnsValue: joined,
      lastStatus: "healthy",
      lastMessage: `自动解析已关闭；请手动将 ${String(group.domain || "-")} 解析到 ${values.join(", ")}${excludedSuffix}`,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, group.id));
    await insertForwardGroupEvent(group.id, null, "ddns-skip", `入口组自动解析已关闭；domain=${String(group.domain || "-")} values=${joined}${excludedSuffix}`);
    return;
  }
  if (!ddnsSettings.enabled || ddnsSettings.provider === "disabled") {
    await db.update(forwardGroups).set({
      activeMemberId,
      lastDdnsValue: joined,
      lastStatus: "healthy",
      lastMessage: `系统 DDNS 未启用；建议入口 ${values.join(", ")}${excludedSuffix}`,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, group.id));
    await insertForwardGroupEvent(group.id, null, "ddns-skip", `入口组 DDNS 未启用；domain=${String(group.domain || "-")} values=${joined}${excludedSuffix}`);
    return;
  }

  if (!forceSync && String(group.lastDdnsValue || "") === joined) {
    await db.update(forwardGroups).set({
      lastStatus: "healthy",
      lastMessage: `入口组 DDNS 已是最新；${values.length} 个入口${excludedSuffix}`,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, group.id));
    return;
  }

  try {
    await updateDdnsRecordValues({
      groupId: Number(group.id),
      domain: String(group.domain || ""),
      recordType,
      values,
      ttl: Number(ddnsSettings.ttl || 600),
    });
    await db.update(forwardGroups).set({
      activeMemberId,
      lastDdnsValue: joined,
      lastDdnsAt: nowDate(),
      lastFailoverAt: nowDate(),
      lastStatus: "healthy",
      lastMessage: `入口组 DDNS 已同步 ${values.length} 个入口${excludedSuffix}`,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, group.id));
    await insertForwardGroupEvent(group.id, null, "ddns-update", `入口组 DDNS 已同步；domain=${String(group.domain || "-")} values=${joined}${excludedSuffix}${forceSync ? " force=true" : ""}`);
    if (groupSwitchNotifyEnabled(group) && !switchNotifySuppressed(options) && previousValue && previousValue !== joined) {
      void notifyForwardGroupSwitch({
        groupId: Number(group.id),
        groupName: String(group.name || "入口组"),
        groupMode: "entry",
        domain: String(group.domain || ""),
        recordType,
        fromLabel: "原入口集合",
        fromValue: previousValue,
        toLabel: `${values.length} 个健康入口`,
        toValue: joined,
        reason: excluded.length > 0 ? "国内健康度检测失败，已自动剔除不健康入口" : "入口可用列表变化，已自动同步解析",
        detail: excluded.length > 0 ? `剔除 ${excluded.length} 个入口；健康入口 ${values.length} 个` : `健康入口 ${values.length} 个`,
      }).catch((error) => {
        console.warn(`[ForwardGroup] switch notify failed group=${group.id}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(forwardGroups).set({
      lastStatus: "error",
      lastMessage: message,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, group.id));
    await insertForwardGroupEvent(group.id, null, "ddns-error", `入口组 DDNS 更新失败；${message}；domain=${String(group.domain || "-")} values=${joined}`);
  }
}

async function markExitGroupReady(group: any) {
  const db = await getDb();
  const members = sortedMembers(group, true) as any[];
  await db.update(forwardGroups).set({
    activeMemberId: Number(members[0]?.id || 0) || null,
    lastStatus: members.length > 0 ? "healthy" : "down",
    lastMessage: members.length > 0 ? "出口组已保存，可在隧道中作为出口组选择。" : "出口组没有已启用主机。",
    updatedAt: nowDate(),
  }).where(eq(forwardGroups.id, group.id));
}

async function syncSingleForwardGroupDdns(
  group: any,
  member: any,
  value: string,
  ddnsSettings: any,
  options: {
    forceSync?: boolean;
    eventType?: string;
    successMessage?: string;
    currentMessage?: string;
    suppressSwitchNotify?: boolean;
    switchReason?: string;
    switchDetail?: string;
    previousMember?: any | null;
  } = {},
) {
  const db = await getDb();
  const recordType = normalizeForwardGroupRecordType(group.recordType);
  const detail = describeDdnsTarget(group, value, ddnsSettings.provider);
  const memberId = Number(member?.id || 0) || null;
  const forceSync = !!options.forceSync;
  const eventType = options.eventType || "failover";
  const successMessage = options.successMessage || "DDNS 已切换";
  const currentMessage = options.currentMessage || "DDNS 已是最新，解析记录已指向选中入口";
  const previousMemberId = Number(group.activeMemberId || 0);
  const previousValue = String(group.lastDdnsValue || "").trim();

  if (!ddnsSettings.enabled || ddnsSettings.provider === "disabled") {
    await db.update(forwardGroups).set({
      activeMemberId: memberId,
      lastDdnsValue: value,
      lastStatus: "healthy",
      lastMessage: `系统 DDNS 未启用；建议入口 ${value}`,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, group.id));
    await insertForwardGroupEvent(group.id, memberId, "ddns-skip", `系统 DDNS 未启用，解析记录未更新；${detail}`);
    return;
  }

  if (!forceSync && Number(group.activeMemberId) === Number(memberId) && String(group.lastDdnsValue || "") === value) {
    await db.update(forwardGroups).set({
      lastStatus: "healthy",
      lastMessage: `当前入口 ${value}`,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, group.id));
    await insertForwardGroupEvent(group.id, memberId, "ddns-current", `${currentMessage}；${detail}`);
    return;
  }

  try {
    await insertForwardGroupEvent(group.id, memberId, "ddns-update", `Starting DDNS update; ${detail}${forceSync ? " force=true" : ""}`);
    await updateDdnsRecord({
      groupId: Number(group.id),
      domain: String(group.domain || ""),
      recordType,
      value,
    });
    await db.update(forwardGroups).set({
      activeMemberId: memberId,
      lastDdnsValue: value,
      lastDdnsAt: nowDate(),
      lastFailoverAt: nowDate(),
      lastStatus: "healthy",
      lastMessage: `${successMessage}到 ${value}`,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, group.id));
    await insertForwardGroupEvent(group.id, memberId, eventType, `${successMessage}；${detail}`);
    if (groupSwitchNotifyEnabled(group) && !options.suppressSwitchNotify && previousMemberId > 0 && Number(previousMemberId) !== Number(memberId)) {
      const [fromLabel, toLabel] = await Promise.all([
        forwardGroupMemberLabel(options.previousMember, previousMemberId),
        forwardGroupMemberLabel(member, memberId),
      ]);
      void notifyForwardGroupSwitch({
        groupId: Number(group.id),
        groupName: String(group.name || "转发组"),
        groupMode: "failover",
        domain: String(group.domain || ""),
        recordType,
        fromLabel,
        fromValue: previousValue,
        toLabel,
        toValue: value,
        reason: options.switchReason || "入口不可用，已自动切换到健康成员",
        detail: options.switchDetail || "",
      }).catch((error) => {
        console.warn(`[ForwardGroup] switch notify failed group=${group.id}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(forwardGroups).set({
      lastStatus: "error",
      lastMessage: message,
      updatedAt: nowDate(),
    }).where(eq(forwardGroups.id, group.id));
    await insertForwardGroupEvent(group.id, memberId, "ddns-error", `DDNS 更新失败；${message}；${detail}`);
  }
}

async function runForwardGroupFailoverForGroups(groups: any[], options: ForwardGroupFailoverOptions = {}) {
  const db = await getDb();
  const ddnsSettings = await getDdnsSettings();
  for (const group of groups as any[]) {
    if (!group.isEnabled) continue;
    const mode = groupModeOf(group);
    if (mode === "chain" || mode === "port") continue;
    if (mode === "entry") {
      if (group.chinaHealthCheckEnabled) {
        for (const member of sortedMembers(group, true) as any[]) {
          const entryHostId = await memberEntryHostId(member).catch(() => 0);
          if (entryHostId > 0) {
            const requested = requestHostTcping(entryHostId);
            if (requested) pushAgentRefresh(entryHostId, "forward-group-china-health");
          }
        }
      }
      await syncEntryGroupDdns(group, ddnsSettings, options);
      continue;
    }
    if (mode === "exit") {
      await markExitGroupReady(group);
      continue;
    }
    const recordType = normalizeForwardGroupRecordType(group.recordType);
    const members = [...(group.members || [])].sort((a, b) => Number(a.priority) - Number(b.priority));
    if (members.length === 0) continue;
    const templates = await getForwardGroupTemplateRules(Number(group.id));
    if (templates.length === 0) {
      const { member: firstMember, value: firstValue } = await firstResolvableMember(members, recordType);
      if (group.domain && firstMember && firstValue) {
        await syncSingleForwardGroupDdns(group, firstMember, firstValue, ddnsSettings, {
          forceSync: !!options.forceSync,
          eventType: options.forcePriority ? "failover" : "ddns-update",
          successMessage: "DDNS 已切换",
          currentMessage: "DDNS 已是最新，解析记录已指向选中入口",
          suppressSwitchNotify: true,
        });
        continue;
      }
      await db.update(forwardGroups).set({
        activeMemberId: Number(firstMember?.id || 0) || null,
        lastDdnsValue: firstValue || null,
        lastStatus: firstValue ? "healthy" : "unknown",
        lastMessage: group.domain
          ? `当前还没有转发规则使用这个组；${firstValue ? `建议入口 ${firstValue}` : `没有可用${recordTypeRequirementLabel(recordType)}。`}`
          : "当前还没有转发规则使用这个组。",
        updatedAt: nowDate(),
      }).where(eq(forwardGroups.id, group.id));
      continue;
    }

    await syncForwardGroupRules(Number(group.id), { preserveRuntime: true });
    if (group.chinaHealthCheckEnabled) {
      for (const member of sortedMembers(group, true) as any[]) {
        const entryHostId = await memberEntryHostId(member).catch(() => 0);
        if (entryHostId > 0) {
          const requested = requestHostTcping(entryHostId);
          if (requested) pushAgentRefresh(entryHostId, "forward-group-china-health");
        }
      }
    }
    const evaluated = [];
    for (const member of members) evaluated.push(await evaluateMemberHealth(member, group));

    if (!group.domain) {
      await db.update(forwardGroups).set({
        lastStatus: evaluated.some((m) => m.healthy) ? "healthy" : "down",
        lastMessage: "未配置 DDNS 域名，仅更新成员健康状态。",
        updatedAt: nowDate(),
      }).where(eq(forwardGroups.id, group.id));
      continue;
    }

    const active = evaluated.find((m) => Number(m.id) === Number(group.activeMemberId));
    const firstHealthy = evaluated.find((m) => m.healthy);
    const failbackCandidate = evaluated.find((m) => m.healthy && m.recoveredLongEnough);
    const shouldFailback = !!group.autoFailback
      && !!active
      && !!failbackCandidate
      && Number(failbackCandidate.priority) < Number(active.priority);
    const shouldFailover = !active || (!!active && !active.healthy && active.failedLongEnough);
    let next = active;
    let switchReason = "";
    let switchDetail = "";
    if (options.forcePriority) next = (await firstResolvableMember(members, recordType)).member || firstHealthy;
    else if (shouldFailback) {
      next = failbackCandidate;
      switchReason = "高优先级入口恢复，已自动回切";
      switchDetail = `恢复稳定时间已达到 ${Number(group.recoverSeconds || 120)} 秒`;
    } else if (shouldFailover) {
      next = firstHealthy;
      switchReason = active
        ? `${normalizeHealthReason(active.message)}导致切换`
        : "当前没有可用活动入口，已自动选择健康成员";
      switchDetail = active
        ? `原入口异常持续已达到 ${Number(group.failoverSeconds || 60)} 秒；检测结果：${normalizeHealthReason(active.message)}`
        : "未记录活动成员或活动成员已不存在";
    }

    if (!next) {
      await db.update(forwardGroups).set({
        lastStatus: "down",
        lastMessage: "没有可用于 DDNS 故障转移的健康成员。",
        updatedAt: nowDate(),
      }).where(eq(forwardGroups.id, group.id));
      continue;
    }

    const value = await memberDdnsValue(next, recordType);
    if (!value) {
      const requirement = recordTypeRequirementLabel(recordType);
      await insertForwardGroupEvent(group.id, next.id, "ddns-error", `健康成员没有可用${requirement}。`);
      continue;
    }

    await syncSingleForwardGroupDdns(group, next, value, ddnsSettings, {
      forceSync: !!options.forceSync,
      eventType: "failover",
      successMessage: "DDNS 已切换",
      currentMessage: "DDNS 已是最新，解析记录已指向选中入口",
      suppressSwitchNotify: switchNotifySuppressed(options) || Number(group.activeMemberId || 0) === Number(next.id || 0),
      switchReason,
      switchDetail,
      previousMember: active || null,
    });
  }
}

export async function runForwardGroupFailover(groupId: number, options: ForwardGroupFailoverOptions = {}) {
  const group = await getForwardGroupById(groupId);
  if (!group) return;
  await runForwardGroupFailoverForGroups([group], options);
}

export async function runForwardGroupFailoverSweep(options: ForwardGroupFailoverOptions = {}) {
  const groups = await getForwardGroups();
  await runForwardGroupFailoverForGroups(groups as any[], options);
}
