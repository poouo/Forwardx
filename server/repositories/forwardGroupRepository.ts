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
import { getDdnsSettings, updateDdnsRecord } from "../ddns";
import { getDatabaseKind, getDb, insertAndGetId, nowDate, queryRaw } from "../dbRuntime";
import { createForwardRule, getForwardRuleById, markForwardRulePendingDelete, updateForwardRule } from "./forwardRuleRepository";
import { getHostById } from "./hostRepository";
import { findAvailableTunnelExitPort, getTunnelById, isPortUsedOnHost, updateTunnel } from "./tunnelRepository";

export type ForwardGroupMemberInput = {
  memberType: "host" | "tunnel";
  hostId?: number | null;
  tunnelId?: number | null;
  priority?: number;
  isEnabled?: boolean;
};

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
  return groupRows.map((group: any) => ({
    ...group,
    members: members.filter((m: any) => Number(m.groupId) === Number(group.id)),
  }));
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
  return { ...group, members };
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

async function insertForwardGroupEvent(groupId: number, memberId: number | null, type: string, message: string) {
  await insertAndGetId("forward_group_events", {
    groupId,
    memberId,
    type,
    message: message.slice(0, 500),
    createdAt: nowDate(),
  });
}

function entryAddressForHost(host: any) {
  return String(host?.entryIp || host?.ipv4 || host?.ipv6 || host?.ip || "").trim();
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
    if (!member.hostId) throw new Error("主机成员缺少 Host");
    const host = await getHostById(Number(member.hostId));
    if (!host) throw new Error("主机不存在");
    return Number(host.id);
  }
  if (!member.tunnelId) throw new Error("隧道成员缺少 Tunnel");
  const tunnel = await getTunnelById(Number(member.tunnelId));
  if (!tunnel) throw new Error("隧道不存在");
  return Number(tunnel.entryHostId);
}

async function ensureMemberRule(group: any, member: any) {
  if (!member.isEnabled || !group.isEnabled) {
    if (member.ruleId) {
      const rule = await getForwardRuleById(Number(member.ruleId));
      await updateForwardRule(Number(member.ruleId), { isEnabled: false, isRunning: !!rule?.isRunning } as any);
      if (rule) pushAgentRefresh(Number(rule.hostId), "forward-group-member-disabled");
    }
    return null;
  }

  const hostId = member.memberType === "host"
    ? Number(member.hostId)
    : Number((await getTunnelById(Number(member.tunnelId)))?.entryHostId || 0);
  if (!hostId) throw new Error("转发组成员入口 Agent 无效");

  const used = await isPortUsedOnHost(hostId, Number(group.sourcePort), member.ruleId ? Number(member.ruleId) : undefined);
  if (used) throw new Error(`入口 Agent 端口 ${group.sourcePort} 已被占用`);

  let tunnelExitPort: number | null = null;
  let tunnelId: number | null = null;
  if (member.memberType === "tunnel") {
    tunnelId = Number(member.tunnelId);
    const tunnel = await getTunnelById(tunnelId);
    if (!tunnel) throw new Error("隧道不存在");
    if (!tunnel.isEnabled) throw new Error(`隧道 ${tunnel.name} 已停用`);
    if (member.ruleId) {
      const db = await getDb();
      const existing = (await db.select().from(forwardRules).where(eq(forwardRules.id, Number(member.ruleId))).limit(1))[0];
      tunnelExitPort = Number(existing?.tunnelExitPort || 0) || null;
    }
    if (!tunnelExitPort) {
      const exit = await getHostById(Number(tunnel.exitHostId));
      tunnelExitPort = await findAvailableTunnelExitPort(Number(tunnel.exitHostId), (exit as any)?.portRangeStart, (exit as any)?.portRangeEnd);
      if (!tunnelExitPort) throw new Error("出口 Agent 已无可用隧道端口");
    }
  }

  const payload: any = {
    hostId,
    name: `[组] ${group.name}`,
    forwardType: member.memberType === "tunnel" ? "gost" : group.forwardType,
    protocol: group.protocol,
    gostMode: "direct",
    gostRelayHost: null,
    gostRelayPort: null,
    tunnelId,
    tunnelExitPort,
    sourcePort: Number(group.sourcePort),
    targetIp: group.targetIp,
    targetPort: Number(group.targetPort),
    isEnabled: true,
    isRunning: false,
    pendingDelete: false,
    userId: Number(group.userId),
  };

  if (member.ruleId) {
    await updateForwardRule(Number(member.ruleId), payload);
    pushAgentRefresh(hostId, "forward-group-member-updated");
    if (member.memberType === "tunnel" && tunnelId) {
      const tunnel = await getTunnelById(tunnelId);
      if (tunnel) {
        pushAgentRefresh(Number(tunnel.entryHostId), "forward-group-member-updated-entry");
        pushAgentRefresh(Number(tunnel.exitHostId), "forward-group-member-updated-exit");
      }
    }
    return Number(member.ruleId);
  }
  const ruleId = await createForwardRule(payload);
  const db = await getDb();
  await db.update(forwardGroupMembers).set({ ruleId, updatedAt: nowDate() }).where(eq(forwardGroupMembers.id, member.id));
  pushAgentRefresh(hostId, "forward-group-member-created");
  if (member.memberType === "tunnel" && tunnelId) {
    const tunnel = await getTunnelById(tunnelId);
    if (tunnel) {
      pushAgentRefresh(Number(tunnel.entryHostId), "forward-group-member-created-entry");
      pushAgentRefresh(Number(tunnel.exitHostId), "forward-group-member-created-exit");
    }
  }
  return ruleId;
}

async function removeManagedRule(ruleId: number) {
  const rule = await getForwardRuleById(ruleId);
  if (!rule) return;
  await markForwardRulePendingDelete(ruleId);
  pushAgentRefresh(Number(rule.hostId), "forward-group-member-deleted");
  if ((rule as any).tunnelId) {
    const tunnel = await getTunnelById(Number((rule as any).tunnelId));
    if (tunnel) {
      pushAgentRefresh(Number(tunnel.entryHostId), "forward-group-member-deleted-entry");
      pushAgentRefresh(Number(tunnel.exitHostId), "forward-group-member-deleted-exit");
    }
  }
}

export async function syncForwardGroupRules(groupId: number) {
  const group = await getForwardGroupById(groupId);
  if (!group) return;
  const db = await getDb();
  for (const member of group.members as any[]) {
    const ruleId = await ensureMemberRule(group, member);
    if (member.memberType === "tunnel" && member.tunnelId) {
      const tunnel = await getTunnelById(Number(member.tunnelId));
      if (tunnel) await updateTunnel(Number(member.tunnelId), { isRunning: false } as any);
    }
    if (ruleId) {
      const rule = (await db.select().from(forwardRules).where(eq(forwardRules.id, ruleId)).limit(1))[0];
      if (rule) await db.update(forwardRules).set({ isRunning: false, updatedAt: nowDate() }).where(eq(forwardRules.id, ruleId));
    }
  }
}

export async function createForwardGroup(data: InsertForwardGroup, members: ForwardGroupMemberInput[]) {
  if (members.length === 0) throw new Error("转发组至少需要一个成员");
  for (const member of members) await targetHostIdForMember(member);
  const id = await insertAndGetId("forward_groups", { ...data, createdAt: nowDate(), updatedAt: nowDate() } as any);
  for (const [index, member] of members.entries()) {
    await insertAndGetId("forward_group_members", {
      groupId: id,
      memberType: member.memberType,
      hostId: member.memberType === "host" ? member.hostId : null,
      tunnelId: member.memberType === "tunnel" ? member.tunnelId : null,
      priority: member.priority ?? index,
      isEnabled: member.isEnabled ?? true,
      createdAt: nowDate(),
      updatedAt: nowDate(),
    });
  }
  await syncForwardGroupRules(id);
  await insertForwardGroupEvent(id, null, "created", "转发组已创建并同步成员规则");
  return id;
}

export async function updateForwardGroup(id: number, data: Partial<InsertForwardGroup>) {
  const db = await getDb();
  await db.update(forwardGroups).set({ ...data, updatedAt: nowDate() }).where(eq(forwardGroups.id, id));
  await syncForwardGroupRules(id);
}

export async function replaceForwardGroupMembers(groupId: number, members: ForwardGroupMemberInput[]) {
  if (members.length === 0) throw new Error("转发组至少需要一个成员");
  const db = await getDb();
  const existing = await db.select().from(forwardGroupMembers).where(eq(forwardGroupMembers.groupId, groupId));
  const keepKeys = new Set(
    members.map((m) => `${m.memberType}:${m.memberType === "host" ? m.hostId : m.tunnelId}`),
  );
  for (const old of existing as any[]) {
    const key = `${old.memberType}:${old.memberType === "host" ? old.hostId : old.tunnelId}`;
    if (!keepKeys.has(key)) {
      if (old.ruleId) await removeManagedRule(Number(old.ruleId));
      await db.delete(forwardGroupMembers).where(eq(forwardGroupMembers.id, old.id));
    }
  }
  const current = await db.select().from(forwardGroupMembers).where(eq(forwardGroupMembers.groupId, groupId));
  for (const [index, member] of members.entries()) {
    await targetHostIdForMember(member);
    const found = (current as any[]).find((row) => row.memberType === member.memberType
      && Number(row.memberType === "host" ? row.hostId : row.tunnelId) === Number(member.memberType === "host" ? member.hostId : member.tunnelId));
    const payload: Partial<InsertForwardGroupMember> = {
      priority: member.priority ?? index,
      isEnabled: member.isEnabled ?? true,
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
        priority: member.priority ?? index,
        isEnabled: member.isEnabled ?? true,
        createdAt: nowDate(),
        updatedAt: nowDate(),
      });
    }
  }
  await syncForwardGroupRules(groupId);
}

export async function deleteForwardGroup(id: number) {
  const db = await getDb();
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
  await insertForwardGroupEvent(groupId, null, "reorder", "成员优先级已更新");
}

async function latestTcping(ruleId: number) {
  const table = getDatabaseKind() === "sqlite" ? `"tcping_stats"` : "`tcping_stats`";
  const result = await queryRaw<any>(
    `SELECT * FROM ${table} WHERE ruleId = ? ORDER BY recordedAt DESC LIMIT 1`,
    [ruleId],
  );
  return result[0];
}

async function evaluateMemberHealth(member: any, group: any) {
  const now = nowDate();
  const rule = member.ruleId
    ? (await (await getDb()).select().from(forwardRules).where(eq(forwardRules.id, Number(member.ruleId))).limit(1))[0]
    : null;
  let healthy = false;
  let latencyMs: number | null = null;
  let message = "";

  if (!member.isEnabled) {
    message = "成员已停用";
  } else if (!rule || !rule.isEnabled || rule.pendingDelete) {
    message = "成员规则未启用";
  } else if (!rule.isRunning) {
    message = "成员规则尚未运行";
  } else {
    const stat = await latestTcping(Number(rule.id));
    if (stat) {
      latencyMs = stat.isTimeout ? null : Number(stat.latencyMs || 0) || null;
      healthy = !stat.isTimeout;
      message = stat.isTimeout ? "TCPing 超时" : "TCPing 正常";
    } else {
      healthy = true;
      message = "规则运行中，等待 TCPing 数据";
    }
  }

  const db = await getDb();
  const prevFailure = member.failureSince ? new Date(member.failureSince) : null;
  const prevHealthy = member.healthySince ? new Date(member.healthySince) : null;
  await db.update(forwardGroupMembers).set({
    healthStatus: healthy ? "healthy" : "unhealthy",
    lastLatencyMs: latencyMs,
    failureSince: healthy ? null : (prevFailure || now),
    healthySince: healthy ? (prevHealthy || now) : null,
    lastCheckedAt: now,
    updatedAt: now,
  } as any).where(eq(forwardGroupMembers.id, member.id));

  const failureSince = healthy ? null : (prevFailure || now);
  const healthySince = healthy ? (prevHealthy || now) : null;
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
    const members = [...(group.members || [])].sort((a, b) => Number(a.priority) - Number(b.priority));
    if (members.length === 0) continue;
    const evaluated = [];
    for (const member of members) evaluated.push(await evaluateMemberHealth(member, group));
    if (!group.domain) {
      await db.update(forwardGroups).set({
        lastStatus: evaluated.some((m) => m.healthy) ? "healthy" : "down",
        lastMessage: "未配置 DDNS 域名，仅更新成员健康状态",
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
        lastMessage: "没有健康成员可用于 DDNS 切换",
        updatedAt: nowDate(),
      }).where(eq(forwardGroups.id, group.id));
      continue;
    }
    const value = await memberEntryAddress(next);
    if (!value) {
      await insertForwardGroupEvent(group.id, next.id, "ddns-error", "健康成员缺少入口地址");
      continue;
    }
    if (!ddnsSettings.enabled || ddnsSettings.provider === "disabled") {
      await db.update(forwardGroups).set({
        activeMemberId: next.id,
        lastStatus: "healthy",
        lastMessage: `DDNS 未启用，推荐入口 ${value}`,
        updatedAt: nowDate(),
      }).where(eq(forwardGroups.id, group.id));
      continue;
    }
    if (Number(group.activeMemberId) === Number(next.id) && String(group.lastDdnsValue || "") === value) {
      await db.update(forwardGroups).set({
        lastStatus: "healthy",
        lastMessage: `当前入口 ${value}`,
        updatedAt: nowDate(),
      }).where(eq(forwardGroups.id, group.id));
      continue;
    }
    try {
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
        lastMessage: `DDNS 已切换到 ${value}`,
        updatedAt: nowDate(),
      }).where(eq(forwardGroups.id, group.id));
      await insertForwardGroupEvent(group.id, next.id, "failover", `DDNS 已切换到 ${value}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.update(forwardGroups).set({
        lastStatus: "error",
        lastMessage: message,
        updatedAt: nowDate(),
      }).where(eq(forwardGroups.id, group.id));
      await insertForwardGroupEvent(group.id, next.id, "ddns-error", message);
    }
  }
}
