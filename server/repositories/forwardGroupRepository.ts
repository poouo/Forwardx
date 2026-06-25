import { isIP } from "node:net";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  forwardGroupEvents,
  forwardGroupMembers,
  forwardGroups,
  forwardRules,
  type InsertForwardGroup,
  type InsertForwardGroupMember,
} from "../../drizzle/schema";
import { pushAgentRefresh, requestHostTcping } from "../agentEvents";
import { appendPanelLog } from "../_core/panelLogger";
import { getDdnsSettings, updateDdnsRecord, updateDdnsRecordValues } from "../ddns";
import { getDb, insertAndGetId, nowDate, queryRaw } from "../dbRuntime";
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
import { findAvailableTunnelExitPort, getTunnelById, getTunnelExitNodes, getTunnelHops, getTunnels, reconcileForwardRuleTunnelExits, resetForwardRulesByTunnel, updateTunnel } from "./tunnelRepository";
import { setUserForwardAccess } from "./userRepository";
import { settleTrafficBillingRuleOnDelete } from "./trafficBillingRepository";
import { combinePortPolicies, isPortAllowedByPolicy, portPolicyErrorMessage, portPolicyFrom, type PortPolicy } from "../portPolicy";
import { clearTunnelRuntimeStatus } from "../tunnelRuntimeStatus";

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
  excludeTemplateRuleId?: number | null;
};

type SyncForwardGroupRulesOptions = {
  validatePorts?: boolean;
  createMissing?: boolean;
  preserveRuntime?: boolean;
};

type ForwardGroupMode = "failover" | "chain" | "entry" | "exit";
type ForwardGroupRecordType = "A" | "AAAA" | "CNAME";

const DEFAULT_CHINA_HEALTH_TARGET = "www.189.cn:80";

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
    if (lastColon > 0 && withoutScheme.indexOf(":") === lastColon) {
      const maybePort = Number(withoutScheme.slice(lastColon + 1));
      if (Number.isInteger(maybePort) && maybePort >= 1 && maybePort <= 65535) {
        host = withoutScheme.slice(0, lastColon);
        port = maybePort;
      }
    }
  }

  host = host.trim();
  if (!host || host.length > 253 || /[\s'"<>/]/.test(host)) {
    throw new Error("China health target format is invalid");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("China health target port must be 1-65535");
  }
  return { host, port, text: `${host}:${port}` };
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
  return mode === "chain" || mode === "entry" || mode === "exit" ? mode : "failover";
}

function isCollectionGroupMode(mode: ForwardGroupMode) {
  return mode === "entry" || mode === "exit";
}

function supportsChinaHealthMode(mode: ForwardGroupMode) {
  return mode === "failover" || mode === "entry";
}

function validateForwardGroupModeMembers(groupMode: ForwardGroupMode, groupType: string, members: ForwardGroupMemberInput[], options: { externalEntry?: boolean } = {}) {
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
    await syncForwardGroupRules(Number(row.id), options);
  }
}

async function refreshTunnelsUsingEntryGroup(entryGroupId: number, reason = "entry-group-updated") {
  const id = Number(entryGroupId);
  if (!Number.isFinite(id) || id <= 0) return;
  const allTunnels = await getTunnels() as any[];
  const affectedTunnels = allTunnels.filter((tunnel: any) => Number(tunnel?.entryGroupId || 0) === id);
  if (affectedTunnels.length === 0) return;

  const entryGroup = await getForwardGroupById(id) as any;
  const entryHostIds = new Set<number>();
  if (entryGroup && entryGroup.isEnabled && groupModeOf(entryGroup) === "entry") {
    for (const member of sortedMembers(entryGroup, true) as any[]) {
      if (member?.memberType !== "host") continue;
      const hostId = Number(member.hostId || 0);
      if (Number.isFinite(hostId) && hostId > 0) entryHostIds.add(hostId);
    }
  }

  for (const tunnel of affectedTunnels) {
    const tunnelId = Number(tunnel?.id || 0);
    if (!Number.isFinite(tunnelId) || tunnelId <= 0) continue;
    clearTunnelRuntimeStatus(tunnelId);
    await updateTunnel(tunnelId, { isRunning: false } as any);
    await resetForwardRulesByTunnel(tunnelId);

    const hostIds = new Set<number>(entryHostIds);
    const primaryEntryHostId = Number(tunnel?.entryHostId || 0);
    if (hostIds.size === 0 && Number.isFinite(primaryEntryHostId) && primaryEntryHostId > 0) hostIds.add(primaryEntryHostId);

    const exitHostId = Number(tunnel?.exitHostId || 0);
    if (Number.isFinite(exitHostId) && exitHostId > 0) hostIds.add(exitHostId);

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
}

function describeDdnsTarget(group: any, value: string, provider?: string) {
  const providerLabel = provider ? `provider=${provider}` : "provider=disabled";
  return `${providerLabel} domain=${String(group.domain || "-")} type=${String(group.recordType || "A")} value=${value}`;
}

export async function getForwardGroups(userId?: number) {
  const db = await getDb();
  if (!db) return [];
  const groupRows = userId
    ? await db.select().from(forwardGroups).where(eq(forwardGroups.userId, userId)).orderBy(desc(forwardGroups.createdAt))
    : await db.select().from(forwardGroups).orderBy(desc(forwardGroups.createdAt));
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
  method: "tcp" | "ping";
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

export async function getForwardGroupChainProbes(groupId: number, options: { includeFinalTarget?: boolean; templateRule?: any } = {}) {
  const group = await getForwardGroupById(groupId) as any;
  if (!group || groupModeOf(group) !== "chain") return [] as ForwardGroupChainProbe[];
  const template = options.templateRule || await getForwardGroupPrimaryTemplateRule(groupId) as any;
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
  const sourcePort = Number(template?.sourcePort || 0);
  const protocol = String(template?.protocol || "both").toLowerCase();
  const hopProbeMethod: "tcp" | "ping" = protocol === "udp" ? "ping" : "tcp";
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
    if (targetIp && sourcePort > 0) {
      for (const entryMember of entryMembers) {
        const entryHostId = Number(entryMember.hostId || 0);
        const entryHost = hostById.get(entryHostId);
        if (!entryHostId) continue;
        const entryName = String(entryHost?.name || `主机${entryHostId}`);
        probes.push({
          groupId,
          fromHostId: entryHostId,
          targetIp,
          targetPort: sourcePort,
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
      targetPort: sourcePort > 0 ? sourcePort : 0,
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
      probes.push({
        groupId,
        fromHostId: lastHostId,
        targetIp,
        targetPort,
        method: "tcp",
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
    } catch {
      target = normalizeChinaHealthTarget(null);
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

async function isPortUsedOnHostForGroupChild(hostId: number, sourcePort: number, ignoreRuleIds: number[]) {
  const table = quoteIdentifier("forward_rules");
  const idCol = quoteIdentifier("id");
  const hostCol = quoteIdentifier("hostId");
  const portCol = quoteIdentifier("sourcePort");
  const pendingCol = quoteIdentifier("pendingDelete");
  const enabledCol = quoteIdentifier("isEnabled");
  const ignore = ignoreRuleIds.filter((id) => Number(id) > 0);
  const ignoreSql = ignore.length > 0 ? ` AND ${idCol} NOT IN ${inList(ignore).sql}` : "";
  const rows = await queryRaw<{ count: number }>(
    `SELECT ${countAll()} FROM ${table} WHERE ${hostCol} = ? AND ${portCol} = ? AND ${pendingCol} = ? AND ${enabledCol} = ?${ignoreSql}`,
    [hostId, sourcePort, boolValue(false), boolValue(true), ...ignore],
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

async function usedPortsOnEntryHost(hostId: number, ignoreRuleIds: number[], range?: { start: number; end: number } | null) {
  const table = quoteIdentifier("forward_rules");
  const idCol = quoteIdentifier("id");
  const hostCol = quoteIdentifier("hostId");
  const portCol = quoteIdentifier("sourcePort");
  const pendingCol = quoteIdentifier("pendingDelete");
  const enabledCol = quoteIdentifier("isEnabled");
  const ignore = ignoreRuleIds.filter((id) => Number(id) > 0);
  const ignoreSql = ignore.length > 0 ? ` AND ${idCol} NOT IN ${inList(ignore).sql}` : "";
  const rangeSql = range ? ` AND ${portCol} BETWEEN ? AND ?` : "";
  const rows = await queryRaw<{ port: number }>(
    `SELECT ${portCol} AS "port" FROM ${table} WHERE ${hostCol} = ?${rangeSql} AND ${pendingCol} = ? AND ${enabledCol} = ?${ignoreSql}`,
    range
      ? [hostId, range.start, range.end, boolValue(false), boolValue(true), ...ignore]
      : [hostId, boolValue(false), boolValue(true), ...ignore],
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
    entries.map((entry) => usedPortsOnEntryHost(entry.hostId, entry.ignoreRuleIds)),
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
  const sourcePort = Number(config.sourcePort || 0);
  if (!Number.isInteger(sourcePort) || sourcePort < 1 || sourcePort > 65535) {
    throw new Error("Forward group entry port must be 1-65535");
  }
  const members = sortedMembers(group);
  if (members.length === 0) throw new Error("Forward group has no members");
  const groupMode = groupModeOf(group);
  if (isCollectionGroupMode(groupMode)) throw new Error("Entry/exit groups cannot be used directly as forwarding rules");
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
    failoverSeconds: group.failoverSeconds,
    recoverSeconds: group.recoverSeconds,
    chinaHealthCheckEnabled: !!group.chinaHealthCheckEnabled,
    chinaHealthCheckTarget: group.chinaHealthCheckTarget || null,
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

async function ensureMemberRuleForTemplate(group: any, templateRule: any, member: any, options: SyncForwardGroupRulesOptions = {}) {
  const existing = await existingChildRule(Number(templateRule.id), Number(member.id));
  const enabled = !!group.isEnabled && !!templateRule.isEnabled && !!member.isEnabled;
  if (!enabled) {
    if (existing) {
      await updateForwardRule(Number(existing.id), { isEnabled: false, isRunning: !!existing.isRunning } as any);
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
  );
  if (used) throw new Error(`Entry agent port ${templateRule.sourcePort} is already used`);

  let tunnelId: number | null = null;
  let tunnelExitPort: number | null = null;
  if (member.memberType === "tunnel") {
    tunnelId = Number(member.tunnelId);
    const tunnel = await getTunnelById(tunnelId);
    if (!tunnel) throw new Error("Tunnel does not exist");
    if (!tunnel.isEnabled) throw new Error(`Tunnel ${tunnel.name} is disabled`);
    tunnelExitPort = Number(existing?.tunnelExitPort || 0) || null;
    if (!tunnelExitPort) {
      const exit = await getHostById(Number(tunnel.exitHostId));
      tunnelExitPort = await findAvailableTunnelExitPort(Number(tunnel.exitHostId), (exit as any)?.portRangeStart, (exit as any)?.portRangeEnd);
      if (!tunnelExitPort) throw new Error("Tunnel exit agent has no available port");
    }
  }

  const payload: any = {
    hostId,
    name: `[Group:${group.name}] ${templateRule.name}`,
    forwardType: member.memberType === "tunnel" ? "gost" : templateRule.forwardType,
    protocol: templateRule.protocol,
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
    blockHttp: false,
    blockSocks: false,
    blockTls: false,
    proxyProtocolReceive: !!(templateRule as any).proxyProtocolReceive,
    proxyProtocolSend: !!(templateRule as any).proxyProtocolSend,
    proxyProtocolExitReceive: member.memberType === "tunnel" ? !!(templateRule as any).proxyProtocolExitReceive : false,
    proxyProtocolExitSend: member.memberType === "tunnel" ? !!(templateRule as any).proxyProtocolExitSend : false,
    tcpFastOpen: member.memberType === "tunnel" ? !!(templateRule as any).tcpFastOpen : !!(templateRule as any).tcpFastOpen,
    zeroCopy: member.memberType === "tunnel" ? false : !!(templateRule as any).zeroCopy,
    failoverEnabled: !!(templateRule as any).failoverEnabled,
    failoverStrategy: (templateRule as any).failoverStrategy || "fallback",
    failoverTargets: (templateRule as any).failoverTargets || null,
    failoverSeconds: Number((templateRule as any).failoverSeconds || 60),
    recoverSeconds: Number((templateRule as any).recoverSeconds || 120),
    autoFailback: (templateRule as any).autoFailback !== false,
    isEnabled: true,
    isRunning: false,
    pendingDelete: false,
    userId: Number(templateRule.userId),
  };

  if (existing) {
    if (options.preserveRuntime && existing.isEnabled && !existing.pendingDelete) return Number(existing.id);
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
      await updateForwardRule(Number(existing.id), { isEnabled: false, isRunning: !!existing.isRunning } as any);
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

  const payload: any = {
    hostId,
    name: `[Chain:${group.name}] ${overrides.namePrefix || `${index + 1}/${total}`} ${templateRule.name}`,
    forwardType: templateRule.forwardType,
    protocol: templateRule.protocol,
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
    blockHttp: false,
    blockSocks: false,
    blockTls: false,
    proxyProtocolReceive: false,
    proxyProtocolSend: false,
    proxyProtocolExitReceive: false,
    proxyProtocolExitSend: false,
    tcpFastOpen: false,
    zeroCopy: false,
    failoverEnabled: false,
    failoverStrategy: "fallback",
    failoverTargets: null,
    failoverSeconds: 60,
    recoverSeconds: 120,
    autoFailback: true,
    isEnabled: true,
    isRunning: false,
    pendingDelete: false,
    userId: Number(templateRule.userId),
  };

  if (existing) {
    if (options.preserveRuntime && existing.isEnabled && !existing.pendingDelete) return Number(existing.id);
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
  const tunnelId = Number((rule as any).tunnelId || 0);
  const billed = await settleTrafficBillingRuleOnDelete({
    userId: Number((rule as any).userId),
    ruleId: Number((rule as any).id),
    resourceType: tunnelId > 0 ? "tunnel" : "host",
    resourceId: tunnelId > 0 ? tunnelId : Number((rule as any).hostId),
  });
  if (billed && Number(billed.balanceAfterCents) < 0) {
    await setUserForwardAccess(Number((rule as any).userId), false, "traffic_billing_balance");
  }
  await markForwardRulePendingDelete(ruleId);
  await refreshRuleEndpoints(rule, "forward-group-child-deleted");
}

export async function syncForwardGroupRules(groupId: number, options: SyncForwardGroupRulesOptions = {}) {
  const group = await getForwardGroupById(groupId);
  if (!group) return;
  const db = await getDb();
  const members = sortedMembers(group) as any[];
  const groupMode = groupModeOf(group);
  const preserveRuntime = !!options.preserveRuntime;
  const activeChainMembers = groupMode === "chain" ? members.filter((member: any) => !!member.isEnabled) : members;
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
  const id = await insertAndGetId("forward_groups", {
    ...data,
    groupMode,
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

export async function replaceForwardGroupMembers(groupId: number, members: ForwardGroupMemberInput[]) {
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
  if (isCollectionGroupMode(groupMode)) {
    await runForwardGroupFailover(groupId);
    if (groupMode === "entry") {
      await syncChainsUsingEntryGroup(groupId);
      await refreshTunnelsUsingEntryGroup(groupId);
    }
  } else {
    await syncForwardGroupRules(groupId, groupMode === "chain" ? { validatePorts: false, createMissing: false } : {});
  }
}

export async function deleteForwardGroup(id: number) {
  const db = await getDb();
  const childRules = await getForwardGroupChildRules(id);
  for (const rule of childRules as any[]) await removeManagedRule(Number(rule.id));
  const templates = await getForwardGroupTemplateRules(id);
  for (const template of templates as any[]) {
    const tunnelId = Number((template as any).tunnelId || 0);
    const billed = await settleTrafficBillingRuleOnDelete({
      userId: Number((template as any).userId),
      ruleId: Number((template as any).id),
      resourceType: tunnelId > 0 ? "tunnel" : "host",
      resourceId: tunnelId > 0 ? tunnelId : Number((template as any).hostId),
    });
    if (billed && Number(billed.balanceAfterCents) < 0) {
      await setUserForwardAccess(Number((template as any).userId), false, "traffic_billing_balance");
    }
    await markForwardRulePendingDelete(Number(template.id));
  }
  const members = await db.select().from(forwardGroupMembers).where(eq(forwardGroupMembers.groupId, id));
  for (const member of members as any[]) {
    if (member.ruleId) await removeManagedRule(Number(member.ruleId));
  }
  await db.delete(forwardGroupEvents).where(eq(forwardGroupEvents.groupId, id));
  await db.delete(forwardGroupMembers).where(eq(forwardGroupMembers.groupId, id));
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
    }
  }
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
    healthy = true;
    const latencies: number[] = [];
    for (const rule of childRules as any[]) {
      if (!rule.isEnabled || rule.pendingDelete) {
        healthy = false;
        message = "Member rule disabled";
        break;
      }
      if (!rule.isRunning) {
        healthy = false;
        message = "Member rule not running yet";
        break;
      }
      const stat = await latestTcping(Number(rule.id));
      if (stat?.isTimeout) {
        healthy = false;
        message = "TCPing timeout";
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
      message = latencies.length > 0 ? "TCPing 正常" : "规则运行中，等待 TCPing 数据";
    }
  }

  const db = await getDb();
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

async function syncEntryGroupDdns(group: any, ddnsSettings: any) {
  const db = await getDb();
  const members = sortedMembers(group, true) as any[];
  const recordType = normalizeForwardGroupRecordType(group.recordType);
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

  if (String(group.lastDdnsValue || "") === joined) {
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
    await insertForwardGroupEvent(group.id, null, "ddns-update", `入口组 DDNS 已同步；domain=${String(group.domain || "-")} values=${joined}${excludedSuffix}`);
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
async function runForwardGroupFailoverForGroups(groups: any[]) {
  const db = await getDb();
  const ddnsSettings = await getDdnsSettings();
  for (const group of groups as any[]) {
    if (!group.isEnabled) continue;
    const mode = groupModeOf(group);
    if (mode === "chain") continue;
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
      await syncEntryGroupDdns(group, ddnsSettings);
      continue;
    }
    if (mode === "exit") {
      await markExitGroupReady(group);
      continue;
    }
    const templates = await getForwardGroupTemplateRules(Number(group.id));
    if (templates.length === 0) {
      await db.update(forwardGroups).set({
        lastStatus: "unknown",
        lastMessage: "当前还没有转发规则使用这个组。",
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
    const members = [...(group.members || [])].sort((a, b) => Number(a.priority) - Number(b.priority));
    if (members.length === 0) continue;

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
    const next = shouldFailback
      ? failbackCandidate
      : shouldFailover
        ? firstHealthy
        : active;

    if (!next) {
      await db.update(forwardGroups).set({
        lastStatus: "down",
        lastMessage: "没有可用于 DDNS 故障转移的健康成员。",
        updatedAt: nowDate(),
      }).where(eq(forwardGroups.id, group.id));
      continue;
    }

    const recordType = normalizeForwardGroupRecordType(group.recordType);
    const value = await memberDdnsValue(next, recordType);
    if (!value) {
      const requirement = recordTypeRequirementLabel(recordType);
      await insertForwardGroupEvent(group.id, next.id, "ddns-error", `健康成员没有可用${requirement}。`);
      continue;
    }

    if (!ddnsSettings.enabled || ddnsSettings.provider === "disabled") {
      const detail = describeDdnsTarget(group, value, ddnsSettings.provider);
      await db.update(forwardGroups).set({
        activeMemberId: next.id,
        lastStatus: "healthy",
        lastMessage: `系统 DDNS 未启用；建议入口 ${value}`,
        updatedAt: nowDate(),
      }).where(eq(forwardGroups.id, group.id));
      await insertForwardGroupEvent(group.id, next.id, "ddns-skip", `系统 DDNS 未启用，解析记录未更新；${detail}`);
      continue;
    }

    if (Number(group.activeMemberId) === Number(next.id) && String(group.lastDdnsValue || "") === value) {
      const detail = describeDdnsTarget(group, value, ddnsSettings.provider);
      await db.update(forwardGroups).set({
        lastStatus: "healthy",
        lastMessage: `当前入口 ${value}`,
        updatedAt: nowDate(),
      }).where(eq(forwardGroups.id, group.id));
      await insertForwardGroupEvent(group.id, next.id, "ddns-current", `DDNS 已是最新，解析记录已指向选中入口；${detail}`);
      continue;
    }

    try {
      const detail = describeDdnsTarget(group, value, ddnsSettings.provider);
      await insertForwardGroupEvent(group.id, next.id, "ddns-update", `Starting DDNS update; ${detail}`);
      await updateDdnsRecord({
        groupId: Number(group.id),
        domain: String(group.domain || ""),
        recordType,
        value,
      });
      await db.update(forwardGroups).set({
        activeMemberId: next.id,
        lastDdnsValue: value,
        lastDdnsAt: nowDate(),
        lastFailoverAt: nowDate(),
        lastStatus: "healthy",
        lastMessage: `DDNS 已切换到 ${value}`,
        updatedAt: nowDate(),
      }).where(eq(forwardGroups.id, group.id));
      await insertForwardGroupEvent(group.id, next.id, "failover", `DDNS 已切换；${detail}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail = describeDdnsTarget(group, value, ddnsSettings.provider);
      await db.update(forwardGroups).set({
        lastStatus: "error",
        lastMessage: message,
        updatedAt: nowDate(),
      }).where(eq(forwardGroups.id, group.id));
      await insertForwardGroupEvent(group.id, next.id, "ddns-error", `DDNS 更新失败；${message}；${detail}`);
    }
  }
}

export async function runForwardGroupFailover(groupId: number) {
  const group = await getForwardGroupById(groupId);
  if (!group) return;
  await runForwardGroupFailoverForGroups([group]);
}

export async function runForwardGroupFailoverSweep() {
  const groups = await getForwardGroups();
  await runForwardGroupFailoverForGroups(groups as any[]);
}
