import * as db from "./db";
import { requireHostAccess, requireRuleAccess } from "./routers/helpers";
import { canUseForwardRuleResource, getLinkAccessScope } from "./linkAccessView";
import { hasRecentAuthenticatedAgentActivity } from "./agentActivity";

export type DiagnosticCheck = { name: string; status: "ok" | "warning" | "error" | "unknown"; message: string; messageTemplate?: string; messageArgs?: string[] };
export async function diagnoseNetwork(actor: { id: number; role: string }, input: { hostId?: number; ruleId?: number }) {
  if (actor.role !== "admin" && await db.getSetting("lookingGlassUserEnabled") === "false") throw new Error("管理员已关闭普通用户使用网络测试");
  const checks: DiagnosticCheck[] = [];
  const add = (name: string, status: DiagnosticCheck["status"], message: string, messageTemplate?: string, messageArgs?: string[]) => checks.push({ name, status, message, ...(messageTemplate ? { messageTemplate, messageArgs } : {}) });
  let hostId = input.hostId, resourceName = "";
  if (input.ruleId) {
    const rule: any = await requireRuleAccess({ user: actor }, input.ruleId);
    resourceName = rule.name || `#${rule.id}`;
    const allowed = actor.role === "admin" || canUseForwardRuleResource(rule, await getLinkAccessScope(actor));
    add("资源授权", allowed ? "ok" : "error", allowed ? "当前账户可使用该规则资源" : "资源权限已撤销，可编辑规则改用有权限的资源");
    add("规则开关", rule.isEnabled ? "ok" : "warning", rule.isEnabled ? "规则已启用" : "规则已停用");
    add("运行状态", rule.isRunning ? "ok" : "warning", rule.isRunning ? "Agent 已上报运行；不代表目标业务一定可用" : "尚未确认运行，请检查同步和 Agent 状态");
    const expired = rule.expiresAt && new Date(rule.expiresAt).getTime() <= Date.now();
    add("规则有效期", expired ? "error" : "ok", expired ? "规则已到期" : "未发现规则自身到期");
    const owner: any = await db.getUserById(rule.userId);
    const ownerExpired = owner?.expiresAt && new Date(owner.expiresAt).getTime() <= Date.now();
    add("账户状态", !owner || owner.accountEnabled === false || ownerExpired ? "error" : "ok", !owner || owner.accountEnabled === false ? "所属账户不可用" : ownerExpired ? "所属账户已到期" : "所属账户启用且未到期");
    add("目标配置", rule.targetIp && Number(rule.targetPort) > 0 ? "ok" : "error", rule.targetIp && Number(rule.targetPort) > 0 ? "目标地址与端口已填写；未执行目标连通性探测" : "缺少目标地址或端口");
    if (actor.role === "admin") hostId = rule.hostId;
    else {
      // Do not expand topology permissions merely because a rule references an internal host.
      try { await requireHostAccess({ user: actor }, rule.hostId); hostId = rule.hostId; }
      catch { hostId = undefined; add("入口信息", "unknown", "入口主机详情不在当前账户可见范围内"); }
    }
  }
  if (hostId) {
    const host: any = await requireHostAccess({ user: actor }, hostId);
    if (!resourceName) resourceName = host.name || `#${host.id}`;
    const seen = host.lastHeartbeat ? new Date(host.lastHeartbeat).getTime() : 0;
    const online = hasRecentAuthenticatedAgentActivity(host.id) || (host.isOnline && seen > Date.now() - 120000);
    add("Agent 通讯", online ? "ok" : "warning", online ? "近期收到 Agent 通讯" : "近期未确认通讯，请核对 Agent 状态，不据此推断业务链路必然断开");
    add("Agent 安装", host.agentToken ? "ok" : "error", host.agentToken ? `已绑定 Agent，版本 ${host.agentVersion || "未上报"}` : "主机尚未绑定 Agent", host.agentToken ? "已绑定 Agent，版本 {0}" : undefined, host.agentToken ? [host.agentVersion || "—"] : undefined);
    const [metric] = await db.getLatestHostMetrics(host.id, 1);
    if (!metric || Date.now() - new Date(metric.recordedAt).getTime() > 120000) add("资源采样", "unknown", "缺少近期指标，不能据旧数据判断当前资源状态");
    else for (const [key, name] of [["cpuUsage", "CPU"], ["memoryUsage", "内存"], ["diskUsage", "磁盘"]]) {
      const value = (metric as any)[key];
      add(name, value == null ? "unknown" : Number(value) >= 90 ? "warning" : "ok", value == null ? "未上报" : `最近使用率 ${Number(value).toFixed(1)}%`, value == null ? undefined : "最近使用率 {0}%", value == null ? undefined : [Number(value).toFixed(1)]);
    }
  }
  add("诊断边界", "unknown", "配置体检不发送探测、不验证目标业务成功；请结合 Ping、TCP、MTR 和真实业务测试。报告不含密码或密钥，资源名称仍可能包含个人信息。");
  return { resourceName, sampledAt: new Date().toISOString(), checks };
}
