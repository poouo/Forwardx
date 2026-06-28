import * as db from "../db";
import { getDdnsSettings } from "../ddns";
import { appendPanelLog } from "../_core/panelLogger";
import { pushAgentRefresh } from "../agentEvents";
import { createHopTestBatch, registerHopTest } from "../hopTestState";

export type ForwardGroupMode = "failover" | "chain" | "entry" | "exit";
export type ForwardGroupType = "host" | "tunnel";

export type ForwardGroupMemberRequest = {
  memberType: ForwardGroupType;
  hostId?: number | null;
  tunnelId?: number | null;
  connectHost?: string | null;
  priority?: number;
  isEnabled?: boolean;
};

export type ForwardGroupInput = {
  name: string;
  remark?: string | null;
  groupMode?: ForwardGroupMode;
  entryGroupId?: number | null;
  groupType: ForwardGroupType;
  domain?: string | null;
  recordType?: "A" | "AAAA" | "CNAME";
  failoverSeconds: number;
  recoverSeconds: number;
  chinaHealthCheckEnabled?: boolean;
  chinaHealthCheckTarget?: string | null;
  ddnsAutoResolveEnabled?: boolean;
  autoFailback: boolean;
  isEnabled: boolean;
  members: ForwardGroupMemberRequest[];
};

export function normalizeForwardGroupMembers(
  groupMode: ForwardGroupMode,
  groupType: ForwardGroupType,
  members: ForwardGroupMemberRequest[],
  options: { externalEntry?: boolean } = {},
) {
  const isCollectionGroup = groupMode === "entry" || groupMode === "exit";
  const effectiveGroupType = groupMode === "chain" || isCollectionGroup ? "host" : groupType;
  const minChainMembers = options.externalEntry ? 1 : 2;
  if (groupMode === "chain" && (members.length < minChainMembers || members.length > 5)) {
    if (options.externalEntry) throw new Error("端口转发链需要配置 1-5 台主机");
    throw new Error("端口转发链需要配置 2-5 台主机");
  }
  if (isCollectionGroup && (members.length < 1 || members.length > 5)) {
    throw new Error(groupMode === "entry" ? "入口组需要配置 1-5 台主机" : "出口组需要配置 1-5 台主机");
  }
  const seen = new Set<string>();
  return members.map((member, index) => {
    if (member.memberType !== effectiveGroupType) {
      throw new Error(groupMode === "chain" ? "端口转发链仅支持主机成员" : isCollectionGroup ? "入口组/出口组仅支持主机成员" : "成员类型必须与转发组类型一致");
    }
    const id = effectiveGroupType === "host" ? Number(member.hostId || 0) : Number(member.tunnelId || 0);
    if (!id) throw new Error(effectiveGroupType === "host" ? "请选择成员主机" : "请选择成员隧道");
    const key = `${effectiveGroupType}:${id}`;
    if (seen.has(key)) throw new Error("成员不能重复");
    seen.add(key);
    return {
      memberType: effectiveGroupType,
      hostId: effectiveGroupType === "host" ? id : null,
      tunnelId: effectiveGroupType === "tunnel" ? id : null,
      connectHost: groupMode === "chain" || groupMode === "exit" ? String(member.connectHost || "").trim() || null : null,
      priority: member.priority ?? index,
      isEnabled: groupMode === "chain" ? true : member.isEnabled ?? true,
    };
  });
}

function memberPrioritySignature(members: ForwardGroupMemberRequest[]) {
  return members
    .map((member, index) => ({
      key: `${member.memberType}:${member.memberType === "host" ? Number(member.hostId || 0) : Number(member.tunnelId || 0)}`,
      enabled: member.isEnabled !== false,
      priority: Number(member.priority ?? index),
    }))
    .sort((a, b) => a.priority - b.priority)
    .map((member) => `${member.key}:${member.enabled ? 1 : 0}`)
    .join("|");
}

async function assertEntryGroupReference(entryGroupId: number | null, userId?: number) {
  if (!entryGroupId) return null;
  const entryGroup = await db.getForwardGroupById(entryGroupId) as any;
  if (!entryGroup || String(entryGroup.groupMode || "") !== "entry") throw new Error("入口组不存在或类型不正确");
  if (userId && Number(entryGroup.userId) !== Number(userId)) throw new Error("无权使用该入口组");
  if (!entryGroup.isEnabled) throw new Error("入口组未启用");
  if (!String(entryGroup.domain || "").trim()) throw new Error("入口组未配置入口域名");
  return entryGroup;
}

async function assertDdnsServiceConfiguredForEntryGroup(ddnsAutoResolveEnabled: boolean) {
  if (!ddnsAutoResolveEnabled) return;
  const settings = await getDdnsSettings();
  if (!settings.enabled || settings.provider === "disabled") {
    throw new Error("入口组已开启自动解析，请先在系统设置中配置并启用 DDNS 服务商");
  }
}

async function normalizeForwardGroupInput(input: ForwardGroupInput, userId?: number) {
  const rawMode = input.groupMode;
  const groupMode: ForwardGroupMode = rawMode === "chain" || rawMode === "entry" || rawMode === "exit" ? rawMode : "failover";
  const isCollectionGroup = groupMode === "entry" || groupMode === "exit";
  const groupType: ForwardGroupType = groupMode === "chain" || isCollectionGroup ? "host" : input.groupType;
  const entryGroupId = groupMode === "chain" ? Number(input.entryGroupId || 0) || null : null;
  await assertEntryGroupReference(entryGroupId, userId);
  const domain = groupMode === "entry" || groupMode === "failover" ? input.domain?.trim() || null : null;
  if (groupMode === "entry" && !domain) throw new Error("入口组需要指定入口域名");
  const ddnsAutoResolveEnabled = groupMode === "entry" ? input.ddnsAutoResolveEnabled !== false : true;
  if (groupMode === "entry") await assertDdnsServiceConfiguredForEntryGroup(ddnsAutoResolveEnabled);
  const members = normalizeForwardGroupMembers(groupMode, groupType, input.members, {
    externalEntry: groupMode === "chain" && !!entryGroupId,
  });
  const chinaHealthCheckEnabled = (groupMode === "failover" || groupMode === "entry") && !!input.chinaHealthCheckEnabled;
  const rawChinaHealthTarget = chinaHealthCheckEnabled ? String(input.chinaHealthCheckTarget || "").trim() : "";
  const chinaHealthCheckTarget = chinaHealthCheckEnabled && rawChinaHealthTarget
    ? db.normalizeChinaHealthTarget(rawChinaHealthTarget).text
    : null;
  const recordType = groupMode === "chain" || groupMode === "exit" ? "A" : input.recordType || "A";
  await db.validateForwardGroupRecordMembers({ groupMode, groupType, recordType }, members as any);
  const commonData = {
    name: input.name,
    remark: isCollectionGroup ? null : input.remark?.trim() || null,
    groupMode,
    entryGroupId,
    groupType,
    forwardType: groupType === "tunnel" ? "gost" : "iptables",
    domain,
    recordType,
    failoverSeconds: input.failoverSeconds,
    recoverSeconds: input.recoverSeconds,
    chinaHealthCheckEnabled,
    chinaHealthCheckTarget,
    ddnsAutoResolveEnabled,
    autoFailback: input.autoFailback,
    isEnabled: input.isEnabled,
  };
  return {
    data: {
      ...commonData,
      ...(userId ? { userId } : {}),
    },
    createData: {
      ...commonData,
      sourcePort: 1,
      protocol: "both",
      targetIp: "0.0.0.0",
      targetPort: 1,
      userId,
    },
    members,
  };
}
export async function createForwardGroupFromInput(input: ForwardGroupInput, userId: number) {
  const normalized = await normalizeForwardGroupInput(input, userId);
  const id = await db.createForwardGroup(normalized.createData as any, normalized.members as any);
  if (normalized.data.groupMode !== "chain") await db.runForwardGroupFailover(id);
  return id;
}

export async function updateForwardGroupFromInput(id: number, input: ForwardGroupInput) {
  const existing = await db.getForwardGroupById(id) as any;
  const normalized = await normalizeForwardGroupInput(input);
  const memberPriorityChanged = memberPrioritySignature((existing?.members || []) as ForwardGroupMemberRequest[])
    !== memberPrioritySignature(normalized.members as ForwardGroupMemberRequest[]);
  const shouldResetChinaHealth = !normalized.data.chinaHealthCheckEnabled
    || !!existing?.chinaHealthCheckEnabled !== !!normalized.data.chinaHealthCheckEnabled
    || String(existing?.chinaHealthCheckTarget || "") !== String(normalized.data.chinaHealthCheckTarget || "");
  await db.updateForwardGroup(id, normalized.data as any, { skipSync: true });
  await db.replaceForwardGroupMembers(id, normalized.members as any);
  if (shouldResetChinaHealth) await db.resetForwardGroupChinaHealth(id);
  if (normalized.data.groupMode !== "chain") await db.runForwardGroupFailover(id, {
    forcePriority: memberPriorityChanged,
    forceSync: memberPriorityChanged,
  });
}

export async function getForwardGroupDeleteImpact(groupId: number) {
  const templateRules = ((await db.getForwardGroupTemplateRules(groupId)) as any[])
    .filter((rule) => !rule.pendingDelete);
  const childRules = ((await db.getForwardGroupChildRules(groupId)) as any[])
    .filter((rule) => !rule.pendingDelete);
  return {
    templateRuleCount: templateRules.length,
    childRuleCount: childRules.length,
    forwardRuleCount: templateRules.length + childRules.length,
    forwardRules: [...templateRules, ...childRules].slice(0, 8).map((rule) => ({
      id: Number(rule.id),
      name: String(rule.name || `规则 #${rule.id}`),
      sourcePort: Number(rule.sourcePort || 0),
      targetIp: String(rule.targetIp || ""),
      targetPort: Number(rule.targetPort || 0),
      managed: !rule.isForwardGroupTemplate,
    })),
  };
}

export async function deleteForwardGroupWithImpact(id: number, confirmRules?: boolean) {
  const group = await db.getForwardGroupById(id);
  if (!group) throw new Error("转发组不存在");
  const impact = await getForwardGroupDeleteImpact(id);
  if (impact.forwardRuleCount > 0 && !confirmRules) {
    throw new Error(`此转发组仍有关联转发规则 ${impact.forwardRuleCount} 条，请确认后再删除`);
  }
  await db.deleteForwardGroup(id);
  return { success: true };
}

export async function runForwardGroupChainSelfTest(groupId: number) {
  const group = await db.getForwardGroupById(groupId) as any;
  if (!group) throw new Error("转发链不存在");
  if (String(group.groupMode || "failover") !== "chain") throw new Error("仅端口转发链支持链路自测");

  const probes = await db.getForwardGroupChainProbes(groupId, { includeFinalTarget: false, method: "ping" });
  if (probes.length === 0) throw new Error("转发链没有可测试的有效链路");

  const batchId = createHopTestBatch("fg", groupId);
  let queued = 0;
  for (const probe of probes) {
    const message = JSON.stringify({
      kind: "forward-chain",
      groupId,
      entryIp: probe.targetIp,
      entrySourcePort: probe.targetPort,
      targetIp: probe.targetIp,
      targetPort: probe.targetPort,
      method: probe.method,
      hopLabel: probe.hopLabel,
      routeLabel: probe.routeLabel,
      batchId,
    });
    const testId = await db.createForwardTest({
      ruleId: 0,
      hostId: probe.fromHostId,
      userId: Number(group.userId),
      status: "pending",
      listenOk: false,
      targetReachable: false,
      forwardOk: false,
      message,
    } as any);
    registerHopTest(batchId, Number(testId));
    pushAgentRefresh(probe.fromHostId, "forward-chain-selftest");
    queued += 1;
    appendPanelLog("info", `[SelfTest] forward-chain=${groupId} queued hop=${probe.hopLabel} method=${probe.method} target=${probe.targetIp}${probe.targetPort ? `:${probe.targetPort}` : ""}`);
  }
  return { success: false, pending: true, queued };
}
