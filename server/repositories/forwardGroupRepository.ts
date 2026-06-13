import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  forwardGroupEvents,
  forwardGroupMembers,
  forwardGroups,
  forwardRules,
  type InsertForwardGroup,
  type InsertForwardGroupMember,
} from "../../drizzle/schema";
import { pushAgentRefresh } from "../agentEvents";
import { appendPanelLog } from "../_core/panelLogger";
import { getDdnsSettings, updateDdnsRecord } from "../ddns";
import { getDb, insertAndGetId, nowDate, queryRaw, quoteDbIdentifier } from "../dbRuntime";
import {
  createForwardRule,
  getForwardGroupChildRules,
  getForwardGroupChildRulesForMember,
  getForwardGroupTemplateRules,
  getForwardRuleById,
  markForwardRulePendingDelete,
  updateForwardRule,
} from "./forwardRuleRepository";
import { getHostById } from "./hostRepository";
import { findAvailableTunnelExitPort, getTunnelById, updateTunnel } from "./tunnelRepository";
import { setUserForwardAccess } from "./userRepository";
import { settleTrafficBillingRuleOnDelete } from "./trafficBillingRepository";
import { combinePortPolicies, isPortAllowedByPolicy, portPolicyErrorMessage, portPolicyFrom, type PortPolicy } from "../portPolicy";

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
};

type ForwardGroupMode = "failover" | "chain";

function quoteId(id: string) {
  return quoteDbIdentifier(id);
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

function privateAddressForHost(host: any) {
  return String(host?.tunnelEntryIp || "").trim();
}

function isSafeHostAddress(value: string) {
  const text = value.trim();
  return !!text && text.length <= 253 && !/[\s'"<>]/.test(text);
}

function groupModeOf(group: any): ForwardGroupMode {
  return String(group?.groupMode || "failover") === "chain" ? "chain" : "failover";
}

function normalizeStoredChainConnectHost(rawConnectHost: string | null | undefined, host: any) {
  const raw = String(rawConnectHost || "").trim();
  const publicAddr = entryAddressForHost(host);
  const privateAddr = privateAddressForHost(host);
  if (!raw) return null;
  if (!isSafeHostAddress(raw)) throw new Error("Chain host connect address is invalid");
  if (privateAddr && raw === privateAddr) return privateAddr;
  if (publicAddr && raw === publicAddr) return null;
  if (!privateAddr) return null;
  throw new Error("Chain host connect address must use entry address or configured private IP");
}

function resolveChainConnectHost(member: any, host: any) {
  const stored = String(member?.connectHost || "").trim();
  const publicAddr = entryAddressForHost(host);
  const privateAddr = privateAddressForHost(host);
  if (privateAddr && stored && stored !== publicAddr) return privateAddr;
  return publicAddr || stored;
}

async function normalizeForwardGroupMemberInput(groupMode: ForwardGroupMode, member: ForwardGroupMemberInput, index: number): Promise<ForwardGroupMemberInput> {
  if (groupMode !== "chain") return { ...member, connectHost: null };
  if (member.memberType !== "host" || !member.hostId) return { ...member, connectHost: null };
  const host = await getHostById(Number(member.hostId));
  if (!host) throw new Error("Host does not exist");
  return {
    ...member,
    connectHost: index === 0 ? null : normalizeStoredChainConnectHost(member.connectHost ?? null, host),
  };
}

function sortedMembers(group: any, enabledOnly = false) {
  const members = [...((group as any).members || [])].sort((a, b) => Number(a.priority) - Number(b.priority));
  return enabledOnly ? members.filter((member: any) => !!member.isEnabled) : members;
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
    `SELECT s.${quoteId("groupId")}, s.${quoteId("latencyMs")}, s.${quoteId("isTimeout")}, s.${quoteId("recordedAt")}
     FROM ${quoteId("forward_group_latency_stats")} s
     INNER JOIN (
       SELECT ${quoteId("groupId")}, MAX(${quoteId("recordedAt")}) AS ${quoteId("recordedAt")}
       FROM ${quoteId("forward_group_latency_stats")}
       WHERE ${quoteId("groupId")} IN (${ids.map(() => "?").join(",")})
       GROUP BY ${quoteId("groupId")}
     ) latest ON latest.${quoteId("groupId")} = s.${quoteId("groupId")} AND latest.${quoteId("recordedAt")} = s.${quoteId("recordedAt")}`,
    ids,
  ).catch(() => []);
  const latestLatencyByGroup = new Map<number, any>();
  for (const row of latencyRows as any[]) {
    latestLatencyByGroup.set(Number(row.groupId), row);
  }
  const hydratedMembers = await Promise.all((members as any[]).map(async (member: any) => ({
    ...member,
    entryAddress: await memberEntryAddress(member).catch(() => ""),
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

export async function getLatestForwardGroupTest(groupId: number) {
  const templates = await getForwardGroupTemplateRules(groupId);
  const templateIds = (templates as any[]).map((rule: any) => Number(rule.id)).filter((id: number) => id > 0);
  const table = quoteId("forward_tests");
  const ruleCol = quoteId("ruleId");
  const updatedCol = quoteId("updatedAt");
  const createdCol = quoteId("createdAt");
  const messageCol = quoteId("message");
  const groupNeedle = `"groupId":${Number(groupId)}`;
  const ruleFilter = templateIds.length > 0
    ? `${ruleCol} IN (${templateIds.map(() => "?").join(",")}) OR `
    : "";
  const filterSql = `(${ruleFilter}${messageCol} LIKE ?)`;
  const filterArgs: any[] = [...templateIds, `%${groupNeedle}%`];
  const pendingRows = await queryRaw<any>(
    `SELECT * FROM ${table} WHERE ${filterSql} AND ${quoteId("status")} IN ('pending', 'running') ORDER BY ${updatedCol} DESC, ${createdCol} DESC LIMIT 1`,
    filterArgs,
  );
  if (pendingRows[0]) return pendingRows[0];
  const rows = await queryRaw<any>(
    `SELECT * FROM ${table} WHERE ${filterSql} ORDER BY ${updatedCol} DESC, CASE WHEN ${messageCol} LIKE '%forward-chain-hop-summary%' THEN 0 ELSE 1 END, ${createdCol} DESC LIMIT 1`,
    filterArgs,
  );
  return rows[0];
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

export async function getForwardGroupChainProbes(groupId: number, options: { includeFinalTarget?: boolean } = {}) {
  const group = await getForwardGroupById(groupId) as any;
  if (!group || groupModeOf(group) !== "chain") return [] as ForwardGroupChainProbe[];
  const template = await getForwardGroupPrimaryTemplateRule(groupId) as any;
  const members = sortedMembers(group, true) as any[];
  if (members.length < 2) return [] as ForwardGroupChainProbe[];

  const hostById = new Map<number, any>();
  for (const member of members) {
    const hostId = Number(member.hostId || 0);
    if (hostId > 0 && !hostById.has(hostId)) hostById.set(hostId, await getHostById(hostId));
  }

  const probes: ForwardGroupChainProbe[] = [];
  const sourcePort = Number(template?.sourcePort || 0);
  const hasFinalTarget = !!options.includeFinalTarget
    && !!template
    && String(template.targetIp || "").trim()
    && Number(template.targetPort || 0) > 0;
  const hopCount = members.length - 1 + (hasFinalTarget ? 1 : 0);
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
      method: "ping",
      hopIndex: index,
      hopCount,
      hopLabel: `${index + 1}/${hopCount} ${currentHostId}->${nextHostId}`,
      routeLabel: `${currentName} -> ${nextName}`,
    });
  }
  if (hasFinalTarget) {
    const lastMember = members[members.length - 1] as any;
    const lastHostId = Number(lastMember.hostId || 0);
    const lastHost = hostById.get(lastHostId);
    const targetIp = String(template.targetIp || "").trim();
    const targetPort = Number(template.targetPort || 0);
    if (lastHostId > 0 && targetIp && targetPort > 0) {
      probes.push({
        groupId,
        fromHostId: lastHostId,
        targetIp,
        targetPort,
        method: "tcp",
        hopIndex: probes.length,
        hopCount,
        hopLabel: `${probes.length + 1}/${hopCount} ${lastHostId}->target`,
        routeLabel: `${String(lastHost?.name || `主机${lastHostId}`)} -> 目标 ${targetIp}:${targetPort}`,
      });
    }
  }
  return probes;
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

async function existingChildRule(templateRuleId: number, memberId: number) {
  const db = await getDb();
  const rows = await db.select().from(forwardRules).where(and(
    eq(forwardRules.forwardGroupRuleId, templateRuleId),
    eq(forwardRules.forwardGroupMemberId, memberId),
  )).limit(1);
  return rows[0];
}

async function isPortUsedOnHostForGroupChild(hostId: number, sourcePort: number, ignoreRuleIds: number[]) {
  const table = quoteId("forward_rules");
  const idCol = quoteId("id");
  const hostCol = quoteId("hostId");
  const portCol = quoteId("sourcePort");
  const pendingCol = quoteId("pendingDelete");
  const enabledCol = quoteId("isEnabled");
  const ignore = ignoreRuleIds.filter((id) => Number(id) > 0);
  const ignoreSql = ignore.length > 0 ? ` AND ${idCol} NOT IN (${ignore.map(() => "?").join(",")})` : "";
  const rows = await queryRaw<{ count: number }>(
    `SELECT COUNT(*) AS "count" FROM ${table} WHERE ${hostCol} = ? AND ${portCol} = ? AND ${pendingCol} = ? AND ${enabledCol} = ?${ignoreSql}`,
    [hostId, sourcePort, false, true, ...ignore],
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
  const table = quoteId("forward_rules");
  const idCol = quoteId("id");
  const hostCol = quoteId("hostId");
  const portCol = quoteId("sourcePort");
  const pendingCol = quoteId("pendingDelete");
  const enabledCol = quoteId("isEnabled");
  const ignore = ignoreRuleIds.filter((id) => Number(id) > 0);
  const ignoreSql = ignore.length > 0 ? ` AND ${idCol} NOT IN (${ignore.map(() => "?").join(",")})` : "";
  const rangeSql = range ? ` AND ${portCol} BETWEEN ? AND ?` : "";
  const rows = await queryRaw<{ port: number }>(
    `SELECT ${portCol} AS "port" FROM ${table} WHERE ${hostCol} = ?${rangeSql} AND ${pendingCol} = ? AND ${enabledCol} = ?${ignoreSql}`,
    range ? [hostId, range.start, range.end, false, true, ...ignore] : [hostId, false, true, ...ignore],
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
  if (groupModeOf(group) === "chain" && members.length < 2) {
    throw new Error("Port forwarding chain requires at least two enabled hosts");
  }

  let policy = portPolicyFrom(null);
  for (const member of members) {
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
  if (groupModeOf(group) === "chain" && members.length < 2) {
    throw new Error("Port forwarding chain requires at least two enabled hosts");
  }

  const entries: Array<{ hostId: number; ignoreRuleIds: number[] }> = [];
  let policy = portPolicyFrom(null);

  for (const member of members) {
    const entry = await entryPortPolicyForMember(member);
    if (!entry.hostId) throw new Error("Forward group member has no valid entry agent");
    const existing = excludeTemplateRuleId
      ? await existingChildRule(Number(excludeTemplateRuleId), Number(member.id))
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
    if (isAvailable(port)) {
      return port;
    }
  }

  for (const port of candidates) {
    if (isAvailable(port)) {
      return port;
    }
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
  if (groupMode === "chain") {
    const enabledMembers = members.filter((member: any) => !!member.isEnabled);
    if (String((group as any).groupType || "host") !== "host") {
      throw new Error("Port forwarding chain only supports host members");
    }
    if (enabledMembers.length < 2 || enabledMembers.length > 5) {
      throw new Error("Port forwarding chain requires 2-5 enabled hosts");
    }
    for (const [index, member] of enabledMembers.entries()) {
      if (member.memberType !== "host") throw new Error("Port forwarding chain only supports host members");
      const host = await getHostById(Number(member.hostId));
      if (!host) throw new Error("Host does not exist");
      if (index === 0) {
        if (!entryAddressForHost(host)) throw new Error("Port forwarding chain entry host has no entry address");
      } else if (!resolveChainConnectHost(member, host)) {
        throw new Error("Port forwarding chain host has no usable connect address");
      }
    }
  }

  for (const member of members) {
    if (!member.isEnabled) continue;
    const hostId = await memberEntryHostId(member);
    if (!hostId) throw new Error("Forward group member has no valid entry agent");
    await assertEntryPortAllowed(member, sourcePort);
    const existing = config.excludeTemplateRuleId
      ? await existingChildRule(Number(config.excludeTemplateRuleId), Number(member.id))
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
    groupType: group.groupType,
    groupMode: groupModeOf(group),
    forwardType: group.forwardType,
    domain: group.domain,
    recordType: group.recordType,
    failoverSeconds: group.failoverSeconds,
    recoverSeconds: group.recoverSeconds,
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

async function ensureMemberRuleForTemplate(group: any, templateRule: any, member: any) {
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
    await updateForwardRule(Number(existing.id), payload);
    await refreshRuleEndpoints({ ...existing, ...payload, id: existing.id }, "forward-group-child-updated");
    return Number(existing.id);
  }

  const ruleId = await createForwardRule(payload);
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
) {
  const existing = await existingChildRule(Number(templateRule.id), Number(member.id));
  if (!existing && options.createMissing === false) return null;
  const enabled = !!group.isEnabled && !!templateRule.isEnabled && !!member.isEnabled;
  if (!enabled) {
    if (existing) {
      await updateForwardRule(Number(existing.id), { isEnabled: false, isRunning: !!existing.isRunning } as any);
      await refreshRuleEndpoints(existing, "forward-chain-child-disabled");
    }
    return null;
  }

  if (member.memberType !== "host") throw new Error("Port forwarding chain only supports host members");
  const hostId = await memberEntryHostId(member);
  if (!hostId) throw new Error("Port forwarding chain member has no valid entry agent");
  if (options.validatePorts !== false) {
    await assertEntryPortAllowed(member, Number(templateRule.sourcePort));
    const used = await isPortUsedOnHostForGroupChild(
      hostId,
      Number(templateRule.sourcePort),
      [Number(templateRule.id), Number(existing?.id || 0)].filter(Boolean),
    );
    if (used) throw new Error(`Entry agent port ${templateRule.sourcePort} is already used`);
  }

  let targetIp = String(templateRule.targetIp || "").trim();
  let targetPort = Number(templateRule.targetPort);
  if (nextMember) {
    if (nextMember.memberType !== "host") throw new Error("Port forwarding chain only supports host members");
    const nextHost = await getHostById(Number(nextMember.hostId));
    targetIp = resolveChainConnectHost(nextMember, nextHost);
    targetPort = Number(templateRule.sourcePort);
    if (!targetIp) throw new Error("Next chain host has no usable connect address");
  }

  const payload: any = {
    hostId,
    name: `[Chain:${group.name}] ${index + 1}/${total} ${templateRule.name}`,
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
    await updateForwardRule(Number(existing.id), payload);
    await refreshRuleEndpoints({ ...existing, ...payload, id: existing.id }, "forward-chain-child-updated");
    return Number(existing.id);
  }

  const ruleId = await createForwardRule(payload);
  await refreshRuleEndpoints({ ...payload, id: ruleId }, "forward-chain-child-created");
  return ruleId;
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
  const activeChainMembers = groupMode === "chain" ? members.filter((member: any) => !!member.isEnabled) : members;
  const templates = await getForwardGroupTemplateRules(groupId);
  const liveMemberIds = new Set((groupMode === "chain" ? activeChainMembers : members).map((m: any) => Number(m.id)));
  const liveTemplateIds = new Set((templates as any[]).map((rule: any) => Number(rule.id)));

  const childRules = await getForwardGroupChildRules(groupId);
  for (const child of childRules as any[]) {
    if (!liveMemberIds.has(Number(child.forwardGroupMemberId)) || !liveTemplateIds.has(Number(child.forwardGroupRuleId))) {
      await removeManagedRule(Number(child.id));
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
      if (activeChainMembers.length < 2 || activeChainMembers.length > 5) {
        throw new Error("Port forwarding chain requires 2-5 enabled hosts");
      }
      for (const [index, member] of activeChainMembers.entries()) {
        const nextMember = activeChainMembers[index + 1] || null;
        const ruleId = await ensureChainRuleForTemplate(group, template, member, nextMember, index, activeChainMembers.length, options);
        if (ruleId) {
          await db.update(forwardRules).set({ isRunning: false, updatedAt: nowDate() }).where(eq(forwardRules.id, ruleId));
        }
      }
    } else {
      for (const member of members) {
        const ruleId = await ensureMemberRuleForTemplate(group, template, member);
        if (ruleId) {
          await db.update(forwardRules).set({ isRunning: false, updatedAt: nowDate() }).where(eq(forwardRules.id, ruleId));
        }
      }
    }
    await db.update(forwardRules).set({ isRunning: false, updatedAt: nowDate() }).where(eq(forwardRules.id, template.id));
  }

  for (const member of members) {
    if (member.memberType === "tunnel" && member.tunnelId) {
      const tunnel = await getTunnelById(Number(member.tunnelId));
      if (tunnel) await updateTunnel(Number(member.tunnelId), { isRunning: false } as any);
    }
  }
}

export async function syncForwardGroupTemplateRule(templateRuleId: number) {
  const template = await getForwardRuleById(templateRuleId);
  if (!template || !(template as any).forwardGroupId) return;
  await syncForwardGroupRules(Number((template as any).forwardGroupId));
}

export async function createForwardGroup(data: InsertForwardGroup, members: ForwardGroupMemberInput[]) {
  if (members.length === 0) throw new Error("Forward group requires at least one member");
  const groupMode = groupModeOf(data);
  if (groupMode === "chain") {
    if (members.length < 2 || members.length > 5) throw new Error("Port forwarding chain requires 2-5 hosts");
    if (String((data as any).groupType || "host") !== "host") throw new Error("Port forwarding chain only supports host members");
    if (members.some((member) => member.memberType !== "host")) throw new Error("Port forwarding chain only supports host members");
  }
  for (const member of members) await targetHostIdForMember(member);
  const normalizedMembers = await Promise.all(members.map((member, index) => normalizeForwardGroupMemberInput(groupMode, member, index)));
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
    : "Forward group created; use it from forwarding rules to generate member routes.");
  return id;
}

export async function updateForwardGroup(id: number, data: Partial<InsertForwardGroup>, options: { skipSync?: boolean } = {}) {
  const db = await getDb();
  await db.update(forwardGroups).set({ ...data, updatedAt: nowDate() }).where(eq(forwardGroups.id, id));
  if (!options.skipSync) await syncForwardGroupRules(id);
}

export async function replaceForwardGroupMembers(groupId: number, members: ForwardGroupMemberInput[]) {
  if (members.length === 0) throw new Error("Forward group requires at least one member");
  const group = await getForwardGroupById(groupId);
  const groupMode = groupModeOf(group);
  if (groupMode === "chain") {
    if (members.length < 2 || members.length > 5) throw new Error("Port forwarding chain requires 2-5 hosts");
    if (members.some((member) => member.memberType !== "host")) throw new Error("Port forwarding chain only supports host members");
  }
  const normalizedMembers = await Promise.all(members.map((member, index) => normalizeForwardGroupMemberInput(groupMode, member, index)));
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
  await syncForwardGroupRules(groupId, groupMode === "chain" ? { validatePorts: false, createMissing: false } : {});
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
    if (groupModeOf(group) === "chain") {
      const members = sortedMembers(group) as any[];
      const currentPublic = entryAddressForHost(currentHost);
      const currentPrivate = privateAddressForHost(currentHost);
      const previousPublic = entryAddressForHost(previousHost);
      const previousPrivate = privateAddressForHost(previousHost);
      for (const [index, member] of members.entries()) {
        if (Number(member.hostId || 0) !== Number(hostId)) continue;
        const stored = String(member.connectHost || "").trim();
        let nextConnectHost: string | null | undefined;
        if (index === 0) {
          nextConnectHost = null;
        } else if (previousPrivate && stored === previousPrivate) {
          nextConnectHost = currentPrivate || null;
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
  const table = quoteId("tcping_stats");
  const result = await queryRaw<any>(
    `SELECT * FROM ${table} WHERE ${quoteId("ruleId")} = ? ORDER BY ${quoteId("recordedAt")} DESC LIMIT 1`,
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
    if (healthy) {
      latencyMs = latencies.length > 0 ? Math.round(latencies.reduce((sum, v) => sum + v, 0) / latencies.length) : null;
      message = latencies.length > 0 ? "TCPing healthy" : "Rules running; waiting for TCPing data";
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

export async function runForwardGroupFailoverSweep() {
  const groups = await getForwardGroups();
  const db = await getDb();
  const ddnsSettings = await getDdnsSettings();
  for (const group of groups as any[]) {
    if (!group.isEnabled) continue;
    if (groupModeOf(group) === "chain") continue;
    const templates = await getForwardGroupTemplateRules(Number(group.id));
    if (templates.length === 0) {
      await db.update(forwardGroups).set({
        lastStatus: "unknown",
        lastMessage: "No forwarding rule is using this group yet.",
        updatedAt: nowDate(),
      }).where(eq(forwardGroups.id, group.id));
      continue;
    }

    await syncForwardGroupRules(Number(group.id));
    const members = [...(group.members || [])].sort((a, b) => Number(a.priority) - Number(b.priority));
    if (members.length === 0) continue;

    const evaluated = [];
    for (const member of members) evaluated.push(await evaluateMemberHealth(member, group));

    if (!group.domain) {
      await db.update(forwardGroups).set({
        lastStatus: evaluated.some((m) => m.healthy) ? "healthy" : "down",
        lastMessage: "DDNS domain is not configured; member health was updated only.",
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
        lastMessage: "No healthy member is available for DDNS failover.",
        updatedAt: nowDate(),
      }).where(eq(forwardGroups.id, group.id));
      continue;
    }

    const value = await memberEntryAddress(next);
    if (!value) {
      await insertForwardGroupEvent(group.id, next.id, "ddns-error", "Healthy member has no entry address.");
      continue;
    }

    if (!ddnsSettings.enabled || ddnsSettings.provider === "disabled") {
      const detail = describeDdnsTarget(group, value, ddnsSettings.provider);
      await db.update(forwardGroups).set({
        activeMemberId: next.id,
        lastStatus: "healthy",
        lastMessage: `DDNS disabled; recommended entry ${value}`,
        updatedAt: nowDate(),
      }).where(eq(forwardGroups.id, group.id));
      await insertForwardGroupEvent(group.id, next.id, "ddns-skip", `DDNS disabled; record was not updated; ${detail}`);
      continue;
    }

    if (Number(group.activeMemberId) === Number(next.id) && String(group.lastDdnsValue || "") === value) {
      const detail = describeDdnsTarget(group, value, ddnsSettings.provider);
      await db.update(forwardGroups).set({
        lastStatus: "healthy",
        lastMessage: `Current entry ${value}`,
        updatedAt: nowDate(),
      }).where(eq(forwardGroups.id, group.id));
      await insertForwardGroupEvent(group.id, next.id, "ddns-current", `DDNS current; record already points to the selected entry; ${detail}`);
      continue;
    }

    try {
      const detail = describeDdnsTarget(group, value, ddnsSettings.provider);
      await insertForwardGroupEvent(group.id, next.id, "ddns-update", `Starting DDNS update; ${detail}`);
      await updateDdnsRecord({
        groupId: Number(group.id),
        domain: String(group.domain || ""),
        recordType: String(group.recordType || "A"),
        value,
      });
      await db.update(forwardGroups).set({
        activeMemberId: next.id,
        lastDdnsValue: value,
        lastDdnsAt: nowDate(),
        lastFailoverAt: nowDate(),
        lastStatus: "healthy",
        lastMessage: `DDNS switched to ${value}`,
        updatedAt: nowDate(),
      }).where(eq(forwardGroups.id, group.id));
      await insertForwardGroupEvent(group.id, next.id, "failover", `DDNS switched; ${detail}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail = describeDdnsTarget(group, value, ddnsSettings.provider);
      await db.update(forwardGroups).set({
        lastStatus: "error",
        lastMessage: message,
        updatedAt: nowDate(),
      }).where(eq(forwardGroups.id, group.id));
      await insertForwardGroupEvent(group.id, next.id, "ddns-error", `DDNS update failed; ${message}; ${detail}`);
    }
  }
}
