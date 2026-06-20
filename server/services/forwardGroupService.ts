import * as db from "../db";
import { appendPanelLog } from "../_core/panelLogger";
import { pushAgentRefresh } from "../agentEvents";
import { createHopTestBatch, registerHopTest } from "../hopTestState";

export type ForwardGroupMode = "failover" | "chain";
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
  groupMode?: ForwardGroupMode;
  groupType: ForwardGroupType;
  domain?: string | null;
  recordType?: "A" | "AAAA" | "CNAME";
  failoverSeconds: number;
  recoverSeconds: number;
  autoFailback: boolean;
  isEnabled: boolean;
  members: ForwardGroupMemberRequest[];
};

export function normalizeForwardGroupMembers(
  groupMode: ForwardGroupMode,
  groupType: ForwardGroupType,
  members: ForwardGroupMemberRequest[],
) {
  const effectiveGroupType = groupMode === "chain" ? "host" : groupType;
  if (groupMode === "chain" && (members.length < 2 || members.length > 5)) {
    throw new Error("端口转发链需要配置 2-5 台主机");
  }
  const seen = new Set<string>();
  return members.map((member, index) => {
    if (member.memberType !== effectiveGroupType) {
      throw new Error(groupMode === "chain" ? "端口转发链仅支持主机成员" : "成员类型必须与转发组类型一致");
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
      connectHost: groupMode === "chain" ? String(member.connectHost || "").trim() || null : null,
      priority: member.priority ?? index,
      isEnabled: groupMode === "chain" ? true : member.isEnabled ?? true,
    };
  });
}

function normalizeForwardGroupInput(input: ForwardGroupInput, userId?: number) {
  const groupMode: ForwardGroupMode = input.groupMode === "chain" ? "chain" : "failover";
  const groupType: ForwardGroupType = groupMode === "chain" ? "host" : input.groupType;
  const members = normalizeForwardGroupMembers(groupMode, groupType, input.members);
  return {
    data: {
      name: input.name,
      groupMode,
      groupType,
      forwardType: groupType === "tunnel" ? "gost" : "iptables",
      domain: groupMode === "chain" ? null : input.domain?.trim() || null,
      recordType: groupMode === "chain" ? "A" : input.recordType || "A",
      failoverSeconds: input.failoverSeconds,
      recoverSeconds: input.recoverSeconds,
      autoFailback: input.autoFailback,
      isEnabled: input.isEnabled,
      ...(userId ? { userId } : {}),
    },
    createData: {
      name: input.name,
      groupMode,
      groupType,
      forwardType: groupType === "tunnel" ? "gost" : "iptables",
      domain: groupMode === "chain" ? null : input.domain?.trim() || null,
      recordType: groupMode === "chain" ? "A" : input.recordType || "A",
      sourcePort: 1,
      protocol: "both",
      targetIp: "0.0.0.0",
      targetPort: 1,
      failoverSeconds: input.failoverSeconds,
      recoverSeconds: input.recoverSeconds,
      autoFailback: input.autoFailback,
      isEnabled: input.isEnabled,
      userId,
    },
    members,
  };
}

export async function createForwardGroupFromInput(input: ForwardGroupInput, userId: number) {
  const normalized = normalizeForwardGroupInput(input, userId);
  const id = await db.createForwardGroup(normalized.createData as any, normalized.members as any);
  if (normalized.data.groupMode !== "chain") await db.runForwardGroupFailover(id);
  return id;
}

export async function updateForwardGroupFromInput(id: number, input: ForwardGroupInput) {
  const normalized = normalizeForwardGroupInput(input);
  await db.updateForwardGroup(id, normalized.data as any, { skipSync: true });
  await db.replaceForwardGroupMembers(id, normalized.members as any);
  if (normalized.data.groupMode !== "chain") await db.runForwardGroupFailover(id);
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

  await db.syncForwardGroupRules(groupId, { validatePorts: false, createMissing: false });
  const template = await db.getForwardGroupPrimaryTemplateRule(groupId) as any;
  const probes = await db.getForwardGroupChainProbes(groupId);
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
      ruleId: Number(template?.id || 0),
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
    appendPanelLog("info", `[SelfTest] forward-chain=${groupId} queued hop=${probe.hopLabel} method=${probe.method} target=${probe.targetIp}:${probe.targetPort}`);
  }
  return { success: false, pending: true, queued };
}
