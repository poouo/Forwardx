import { createHash } from "node:crypto";
import { z } from "zod";
import { FORWARD_TYPES, TUNNEL_PROTOCOLS, normalizeForwardProtocolSettings } from "../../shared/forwardTypes";
import type { TrpcContext } from "../_core/context";
import { SIDEBAR_MENU_KEYS, SIDEBAR_MENU_LABELS, DEFAULT_SIDEBAR_MENU_SETTINGS, normalizeSidebarMenuSettings } from "../../shared/sidebarMenu";

const id = z.number().int().positive();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const port = z.number().int().min(1).max(65535);
const name = z.string().trim().min(1).max(128);
const date = z.string().datetime({ offset: true }).nullable().describe("ISO-8601 with timezone; null=unlimited/clear");
const ids = z.array(id).max(100);
const empty = z.object({}).strict();
const target = z.object({ id }).strict();
const filters = z.object({ keyword: z.string().max(120).optional(), limit: z.number().int().min(1).max(30).optional() }).strict();
const transport = {
  proxyProtocolReceive: z.boolean().optional(), proxyProtocolSend: z.boolean().optional(),
  proxyProtocolExitReceive: z.boolean().optional(), proxyProtocolExitSend: z.boolean().optional(),
  proxyProtocolVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  tcpFastOpen: z.boolean().optional(), zeroCopy: z.boolean().optional(), udpOverTcp: z.boolean().optional(),
  udpOverTcpPort: port.nullable().optional(),
};
const blocking = { blockHttp: z.boolean().optional(), blockSocks: z.boolean().optional(), blockTls: z.boolean().optional() };
const failover = {
  failoverEnabled: z.boolean().optional(), failoverStrategy: z.enum(["fallback", "round_robin", "random", "ip_hash"]).optional(),
  failoverSeconds: z.number().int().min(10).max(3600).optional(), recoverSeconds: z.number().int().min(10).max(3600).optional(),
  autoFailback: z.boolean().optional(),
  failoverTargets: z.array(z.object({ targetIp: z.string().min(1).max(253), targetPort: port }).strict()).max(10).optional(),
};
const ruleFields = {
  rateLimitMbps: z.number().int().min(0).max(1_000_000).optional(), trafficLimit: count.optional(),
  trafficMode: z.enum(["outbound", "both", "max"]).optional(),
  createdAt: z.string().datetime({ offset: true }).optional(), expiresAt: date.optional(),
  name: name.optional(), forwardType: z.enum(FORWARD_TYPES).optional(), protocol: z.enum(["tcp", "udp", "both"]).optional(),
  sourcePort: z.number().int().min(0).max(65535).optional(), targetIp: z.string().min(1).max(253).optional(), targetPort: port.optional(),
  tunnelId: id.nullable().optional(), forwardGroupId: id.nullable().optional(), tunnelExitPort: port.nullable().optional(),
  telegramErrorNotifyEnabled: z.boolean().optional(), isEnabled: z.boolean().optional(), ...transport, ...blocking, ...failover,
};
const members = z.array(z.object({ memberType: z.enum(["host", "tunnel"]), hostId: id.nullable().optional(), tunnelId: id.nullable().optional(), connectHost: z.string().max(253).nullable().optional(), priority: count.optional(), isEnabled: z.boolean().optional() }).strict()).min(1).max(20);
const groupFields = {
  name: name.optional(), remark: z.string().max(255).nullable().optional(),
  forwardType: z.enum(FORWARD_TYPES).optional(), protocol: z.enum(["tcp", "udp", "both"]).optional(),
  rateLimitMbps: z.number().int().min(0).max(1_000_000).optional(), trafficMultiplier: z.number().int().min(1).max(5000).optional(),
  telegramSwitchNotifyEnabled: z.boolean().optional(), chinaHealthCheckEnabled: z.boolean().optional(),
  chinaHealthCheckTarget: z.string().max(253).nullable().optional(), ddnsAutoResolveEnabled: z.boolean().optional(),
  ...transport, ...failover,
  members: members.optional(),
};
const planFields = {
  name: name.optional(), description: z.string().max(500).nullable().optional(), priceCents: z.number().int().min(0).max(100_000_000).optional().describe("cents; 100=1 CNY"),
  durationDays: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365), z.literal(730)]).optional(),
  portCount: z.number().int().min(1).max(1024).optional(), trafficLimit: count.optional().describe("bytes; 0=unlimited"),
  rateLimitMbps: z.number().int().min(0).max(1_000_000).optional(), maxRules: count.optional(), maxConnections: count.optional(), maxIPs: count.optional(),
  isActive: z.boolean().optional(), isStoreVisible: z.boolean().optional(), hostIds: ids.optional(), tunnelIds: ids.optional(), forwardGroupIds: ids.optional(),
};
function patch(shape: z.ZodRawShape) {
  return z.object({ id, ...shape }).strict().refine((v) => Object.keys(v).length > 1, "请提供至少一个需要修改的字段");
}

type Setting = { label: string; path: string; dbKey: string; schema: z.ZodTypeAny; fallback: unknown; route?: string; warning?: string };
const setting = (label: string, path: string, dbKey = path, fallback: unknown = false, schema: z.ZodTypeAny = z.boolean(), warning?: string): Setting => ({ label, path, dbKey, fallback, schema, warning });
/** These are capabilities, not arbitrary system_settings keys. Credentials and connection endpoints are deliberately absent. */
export const PANEL_SETTINGS: Record<string, Setting> = {
  registrationEnabled: setting("开放注册", "registrationEnabled", undefined, true),
  twoFactorEnabled: setting("两步验证", "twoFactorEnabled", undefined, false, z.boolean(), "关闭会降低账户登录安全性"),
  allowMultiDeviceLogin: setting("多设备登录", "allowMultiDeviceLogin"),
  lookingGlassUserEnabled: setting("用户网络测试", "lookingGlassUserEnabled", undefined, true),
  updateAutoCheckEnabled: setting("自动检查更新", "updateAutoCheckEnabled", undefined, true),
  pluginsEnabled: setting("插件功能", "pluginsEnabled"),
  homepageEnabled: setting("公开首页", "homepageEnabled", undefined, true),
  homepageCustomEnabled: setting("自定义首页", "homepageCustomEnabled"),
  publicHostMonitorEnabled: setting("公开主机监控", "publicHostMonitor.enabled", "publicHostMonitorEnabled", false, z.boolean(), "开启后允许未登录访客查看公开监控"),
  agentPreferPanelInstall: setting("优先从面板安装Agent", "agentPreferPanelInstall"),
  githubAcceleratorEnabled: setting("GitHub下载加速", "githubAccelerator.enabled", "githubAcceleratorEnabled"),
  githubPanelUpdateEnabled: setting("面板更新使用加速", "githubAccelerator.panelUpdateEnabled", "githubAcceleratorPanelUpdateEnabled"),
  emailEnabled: setting("邮件功能", "email.enabled", "emailEnabled"),
  emailVerifyRegistration: setting("注册邮箱验证", "email.verifyRegistration", "emailVerifyRegistration"),
  emailWhitelistEnabled: setting("邮箱注册白名单", "email.whitelistEnabled", "emailWhitelistEnabled"),
  emailExpiryReminder: setting("邮件到期提醒", "email.expiryReminder", "emailExpiryReminder"),
  emailTrafficReminder: setting("邮件流量提醒", "email.trafficReminder", "emailTrafficReminder"),
  emailTrafficReminderThreshold: setting("邮件剩余流量提醒阈值(%)", "email.trafficReminderThreshold", "emailTrafficReminderThreshold", 20, z.number().int().min(1).max(99)),
  telegramExpiryReminder: setting("TG到期提醒", "telegram.expiryReminder", "telegramExpiryReminder"),
  telegramTrafficReminder: setting("TG流量提醒", "telegram.trafficReminder", "telegramTrafficReminder"),
  telegramHostStatusNotify: setting("TG主机上下线通知", "telegram.hostStatusNotify", "telegramHostStatusNotify"),
  telegramTrafficReminderThreshold: setting("TG剩余流量提醒阈值(%)", "telegram.trafficReminderThreshold", "telegramTrafficReminderThreshold", 20, z.number().int().min(1).max(99)),
  discordExpiryReminder: setting("Discord到期提醒", "discord.expiryReminder", "discordExpiryReminder"),
  discordTrafficReminder: setting("Discord流量提醒", "discord.trafficReminder", "discordTrafficReminder"),
  discordHostStatusNotify: setting("Discord主机上下线通知", "discord.hostStatusNotify", "discordHostStatusNotify"),
  discordTrafficReminderThreshold: setting("Discord剩余流量提醒阈值(%)", "discord.trafficReminderThreshold", "discordTrafficReminderThreshold", 20, z.number().int().min(1).max(99)),
  ddnsEnabled: setting("DDNS功能", "ddns.enabled", "ddnsEnabled"),
  aiUserManageEnabled: setting("普通用户AI对话管理", "deepseek.telegramUserManageEnabled", "telegramAiUserManageEnabled", true),
  aiAutoRecallEnabled: setting("AI消息自动撤回", "deepseek.telegramAutoRecallEnabled", "telegramAiAutoRecallEnabled"),
  aiAutoRecallSeconds: setting("AI消息撤回时间(秒)", "deepseek.telegramAutoRecallSeconds", "telegramAiAutoRecallSeconds", 60, z.number().int().min(30).max(1200)),
  siteTitle: setting("站点名称", "siteTitle", undefined, "ForwardX", z.string().trim().min(1).max(80)),
  tunnelRuntimeDefault: setting("默认隧道运行时", "tunnelRuntimeDefault", undefined, "forwardx", z.enum(["forwardx", "gost"])),
  storeEnabled: { ...setting("套餐商店", "enabled", "storeEnabled"), route: "plans.setStoreEnabled" },
  trafficBillingEnabled: { ...setting("按量计费", "enabled", "trafficBillingEnabled", false, z.boolean(), "可能改变用户资源授权和转发可用性"), route: "trafficBilling.setEnabled" },
  redemptionEnabled: { ...setting("兑换码功能", "redemptionEnabled", undefined, true), route: "billing.setFeatureStatus" },
  discountEnabled: { ...setting("折扣码功能", "discountEnabled", undefined, true), route: "billing.setFeatureStatus" },
};
for (const protocol of Array.from(new Set([...FORWARD_TYPES, ...TUNNEL_PROTOCOLS]))) {
  PANEL_SETTINGS[`protocol.${protocol}`] = setting(`允许使用 ${protocol}`, `forwardProtocols.${protocol}`, "forwardProtocols", true, z.boolean(), "修改协议可用性可能影响该协议的资源使用权限");
}
for (const key of SIDEBAR_MENU_KEYS) PANEL_SETTINGS[`menu.${key}`] = setting(`侧栏：${SIDEBAR_MENU_LABELS[key]}`, `sidebarMenu.${key}`, "sidebarMenu", DEFAULT_SIDEBAR_MENU_SETTINGS[key]);
// Plugin menu visibility is derived from the feature, not sidebarMenu.plugins.
PANEL_SETTINGS["menu.plugins"] = setting("插件菜单与功能", "pluginsEnabled");

type Tool = { label: string; mode: "read" | "write"; admin?: boolean; schema: z.ZodTypeAny; route?: string; resource?: "rule" | "host" | "tunnel" | "group" | "user" | "plan" | "announcement"; fields?: string[]; warning?: string };
export const PANEL_TOOLS = {
  "settings.read": { label: "设置查询", mode: "read", admin: true, schema: filters },
  "settings.set": { label: "修改设置", mode: "write", admin: true, schema: z.object({ key: z.enum(Object.keys(PANEL_SETTINGS) as [string, ...string[]]), value: z.union([z.boolean(), z.number().finite(), z.string().max(128)]) }).strict() },
  "expiry.list": { label: "到期查询", mode: "read", schema: filters.extend({ resource: z.enum(["rules", "users", "hosts", "subscriptions"]), scope: z.enum(["self", "visible"]).optional(), days: z.number().int().min(1).max(3650).optional(), includeExpired: z.boolean().optional() }).strict() },
  "dashboard.read": { label: "仪表盘概览", mode: "read", schema: empty, route: "dashboard.stats" },
  "plans.list": { label: "套餐查询", mode: "read", schema: filters },
  "subscriptions.list": { label: "订阅查询", mode: "read", schema: filters.extend({ userId: id.optional(), scope: z.enum(["self", "visible"]).optional() }).strict() },
  "billing.summary": { label: "账单概览", mode: "read", admin: true, schema: empty, route: "billing.summary" },
  "traffic_billing.list": { label: "按量计费配置", mode: "read", admin: true, schema: empty, route: "trafficBilling.configs" },
  "announcements.list": { label: "公告查询", mode: "read", schema: filters, route: "announcements.list" },
  "hosts.metrics": { label: "主机最新指标", mode: "read", schema: z.object({ hostId: id }).strict(), route: "hosts.metrics" },
  "hosts.traffic": { label: "主机流量", mode: "read", schema: z.object({ hostId: id }).strict(), route: "hosts.traffic" },
  "users.permissions": { label: "用户手动资源授权", mode: "read", admin: true, schema: z.object({ userId: id }).strict() },
  "groups.events": { label: "转发组事件", mode: "read", admin: true, schema: z.object({ groupId: id }).strict(), route: "forwardGroups.events" },
  "rules.update": { label: "修改转发规则", mode: "write", schema: patch(ruleFields), route: "rules.update", resource: "rule" },
  "rules.create": { label: "新增转发规则", mode: "write", schema: z.object({ ...ruleFields, name, sourcePort: z.number().int().min(0).max(65535), targetIp: z.string().min(1).max(253), targetPort: port, userId: id.optional() }).strict().refine(v => !!v.tunnelId || !!v.forwardGroupId, "请指定隧道 tunnelId 或端口转发链 forwardGroupId"), route: "rules.create", warning: "使用真实业务校验分配端口；管理员未指定用户时归属自己" },
  "hosts.update": { label: "修改主机配置", mode: "write", admin: true, schema: patch({
    name: name.optional(), networkInterface: z.string().max(64).optional(),
    entryIp: z.string().max(253).nullable().optional(), tunnelEntryIp: z.string().max(253).nullable().optional(),
    portRangeStart: port.nullable().optional(), portRangeEnd: port.nullable().optional(), portAllowlist: z.string().max(2000).nullable().optional(),
    stoppedAt: date.optional(), trafficLimit: count.optional().describe("bytes; 0=unlimited"),
    trafficMeasureMode: z.enum(["both", "outbound", "max"]).optional(), trafficFailoverEnabled: z.boolean().optional(),
    trafficFailoverThresholdPercent: z.number().int().min(1).max(100).optional(), telegramTrafficAlertEnabled: z.boolean().optional(),
    trafficAlertThresholdPercent: z.number().int().min(1).max(99).optional(), telegramRenewalReminderEnabled: z.boolean().optional(),
    renewalReminderDays: z.number().int().min(1).max(365).optional(), trafficAutoReset: z.boolean().optional(),
    trafficResetDay: z.number().int().min(1).max(31).optional(), billingCycleMonths: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12), z.literal(24), z.literal(36)]).optional(),
    billingMonth: z.number().int().min(1).max(12).optional(), billingDay: z.number().int().min(1).max(31).optional(),
    expiryHandling: z.enum(["none", "extend_cycle"]).optional(), ddnsEnabled: z.boolean().optional(), ddnsDomain: z.string().max(253).nullable().optional(), ...blocking,
  }), route: "hosts.update", resource: "host" },
  "hosts.reset_traffic": { label: "重置主机流量", mode: "write", admin: true, schema: z.object({ hostId: id }).strict(), route: "hosts.resetTraffic", resource: "host", warning: "重置统计不会退还已产生的账单" },
  "tunnels.update": { label: "修改隧道", mode: "write", admin: true, schema: patch({
    name: name.optional(), isEnabled: z.boolean().optional(), entryHostId: id.optional(), exitHostId: id.optional(),
    entryGroupId: id.nullable().optional(), exitGroupId: id.nullable().optional(), mode: z.enum(TUNNEL_PROTOCOLS).optional(),
    forwardxVersion: z.enum(["v1", "v2"]).optional(), listenPort: port.optional(), portRangeStart: port.nullable().optional(), portRangeEnd: port.nullable().optional(),
    rateLimitMbps: z.number().int().min(0).max(1_000_000).optional(), trafficMultiplier: z.number().int().min(1).max(5000).optional(),
    connectHost: z.string().max(128).nullable().optional(), ...blocking,
    proxyProtocolReceive: transport.proxyProtocolReceive, proxyProtocolSend: transport.proxyProtocolSend,
    proxyProtocolExitReceive: transport.proxyProtocolExitReceive, proxyProtocolExitSend: transport.proxyProtocolExitSend,
    proxyProtocolVersion: transport.proxyProtocolVersion, tcpFastOpen: transport.tcpFastOpen, udpOverTcp: transport.udpOverTcp,
  }), route: "tunnels.update", resource: "tunnel", warning: "隧道配置变更可能触发重新下发并影响现有连接" },
  "tunnels.create": { label: "新增隧道", mode: "write", admin: true, schema: z.object({ name, entryHostId: id, exitHostId: id, mode: z.enum(TUNNEL_PROTOCOLS), listenPort: z.number().int().min(0).max(65535), forwardxVersion: z.enum(["v1", "v2"]).optional(), connectHost: z.string().max(128).nullable().optional(), entryGroupId: id.nullable().optional(), exitGroupId: id.nullable().optional() }).strict(), route: "tunnels.create", warning: "0表示明确选择自动分配；证书等高级配置仍需网页完成" },
  "groups.toggle": { label: "启停转发/入口/出口组或链", mode: "write", admin: true, schema: z.object({ id, isEnabled: z.boolean() }).strict(), route: "forwardGroups.toggle", resource: "group" },
  "groups.update": { label: "修改转发/入口/出口组或链", mode: "write", admin: true, schema: patch(groupFields), route: "forwardGroups.updateFields", resource: "group", warning: "只变更列出的配置，未指定成员时保留原成员；PROXY变更会影响后端握手" },
  "groups.create": { label: "新增转发/入口/出口组或链", mode: "write", admin: true, schema: z.object({ ...groupFields, name, groupMode: z.enum(["port", "failover", "chain", "entry", "exit"]), groupType: z.enum(["host", "tunnel"]), members, entryGroupId: id.nullable().optional() }).strict(), route: "forwardGroups.create" },
  "groups.sync": { label: "同步指定转发组", mode: "write", admin: true, schema: target, route: "forwardGroups.sync", resource: "group" },
  "users.limits": { label: "修改用户额度与有效期", mode: "write", admin: true, schema: z.object({
    userId: id, trafficLimit: count.optional().describe("bytes; 0=unlimited"), expiresAt: date.optional(), trafficAutoReset: z.boolean().optional(),
    trafficResetDay: z.number().int().min(1).max(28).optional(), maxRules: count.optional(), maxPorts: count.optional(),
    maxConnections: count.optional(), maxIPs: count.optional(), gostRateLimitIn: count.optional(), gostRateLimitOut: count.optional(),
    displayRemark: z.string().max(24).nullable().optional(),
  }).strict().refine(v => Object.keys(v).length > 1, "请指定额度或有效期"), route: "users.updateTrafficSettings", resource: "user" },
  "users.host_permissions": { label: "替换用户主机授权", mode: "write", admin: true, schema: z.object({ userId: id, hostIds: ids }).strict(), route: "users.setHostPermissions", resource: "user", warning: "全量替换手动授权列表，空列表表示移除全部手动授权；套餐授权不变" },
  "users.tunnel_permissions": { label: "替换用户隧道授权", mode: "write", admin: true, schema: z.object({ userId: id, tunnelIds: ids }).strict(), route: "users.setTunnelPermissions", resource: "user", warning: "全量替换手动授权列表，套餐授权不变" },
  "users.group_permissions": { label: "替换用户转发组授权", mode: "write", admin: true, schema: z.object({ userId: id, forwardGroupIds: ids }).strict(), route: "users.setForwardGroupPermissions", resource: "user", warning: "全量替换手动授权列表，套餐授权不变" },
  "users.permissions_change": { label: "增减用户手动资源授权", mode: "write", admin: true, schema: z.object({ userId: id, resource: z.enum(["host", "tunnel", "group"]), operation: z.enum(["add", "remove"]), resourceIds: ids.min(1) }).strict(), route: "users.changeResourcePermissions", resource: "user", warning: "只增减指定资源，保留其余手动授权和套餐授权" },
  "plans.status": { label: "套餐启停与上架", mode: "write", admin: true, schema: z.object({ id, isActive: z.boolean(), isStoreVisible: z.boolean() }).strict(), route: "plans.updateStatus", resource: "plan" },
  "plans.update": { label: "修改套餐", mode: "write", admin: true, schema: patch({ ...planFields, syncExistingSubscribers: z.boolean() }), route: "plans.updateFields", resource: "plan", warning: "syncExistingSubscribers=true将同步已有订阅权益，否则只影响新订阅；必须明确指定" },
  "plans.create": { label: "新增套餐", mode: "write", admin: true, schema: z.object({ ...planFields, name, priceCents: z.number().int().min(0).max(100_000_000), durationDays: planFields.durationDays.unwrap(), hostIds: ids, tunnelIds: ids, forwardGroupIds: ids }).strict(), route: "plans.create", warning: "配额未指定时使用网页端默认值，预览会列明默认值" },
  "subscriptions.assign": { label: "给用户分配套餐", mode: "write", admin: true, schema: z.object({ userId: id, planId: id }).strict(), route: "plans.assign", resource: "user", warning: "可能改变额度、授权和端口分配；不是购买扣款操作" },
  "subscriptions.extend": { label: "延长订阅", mode: "write", admin: true, schema: z.object({ id, days: z.number().int().min(1).max(3650) }).strict(), route: "plans.extendSubscription" },
  "subscriptions.cancel": { label: "取消订阅", mode: "write", admin: true, schema: target, route: "plans.cancelSubscription", warning: "会收回订阅权益，可能导致转发停用" },
  "traffic_billing.save": { label: "配置资源按量计费", mode: "write", admin: true, schema: z.object({ id: id.optional(), resourceType: z.enum(["host", "tunnel", "forward_group"]), resourceId: id, enabled: z.boolean(), requiresPermission: z.boolean(), description: z.string().max(500).optional(), pricePerGbMilliCents: count.optional().describe("100000=1 CNY/GB"), multiplier: z.number().int().min(1).max(5000).optional() }).strict(), route: "trafficBilling.saveConfig", warning: "可能改变收费及资源授权；价格单位为千分之一分/GB" },
  "announcements.create": { label: "发布公告", mode: "write", admin: true, schema: z.object({ title: z.string().min(1).max(120), content: z.string().min(1).max(4000), type: z.enum(["normal", "popup"]), telegramPush: z.boolean() }).strict(), route: "announcements.create", warning: "telegramPush=true会向当前通知渠道的订阅用户发送公告" },
  "announcements.delete": { label: "删除公告", mode: "write", admin: true, schema: target, route: "announcements.delete", resource: "announcement" },
} satisfies Record<string, Tool>;
export type PanelToolName = keyof typeof PANEL_TOOLS;
export const panelToolNameSchema = z.enum(Object.keys(PANEL_TOOLS) as [PanelToolName, ...PanelToolName[]]);
export const panelInputSchema = z.record(z.unknown()).refine(v => JSON.stringify(v).length <= 8000, "参数过大");
export type PanelCall = { tool: PanelToolName; input: Record<string, unknown> };
export type PreparedPanelCall = PanelCall & { fingerprint: string; preview: string[] };
export class PanelPreflightError extends Error {}

// Runtime schemas are also the source of the model's capability catalog.
function schemaHint(schema: z.ZodTypeAny): string {
  const d = schema._def as any;
  if (d.innerType) return `${schemaHint(d.innerType)}${d.typeName === "ZodOptional" ? "?" : "|null"}`;
  if (d.schema) return schemaHint(d.schema);
  if (d.typeName === "ZodObject") return `{${Object.entries(d.shape()).map(([k, v]) => `${k}:${schemaHint(v as z.ZodTypeAny)}`).join(",")}}`;
  if (d.typeName === "ZodEnum") return d.values.join("|");
  if (d.typeName === "ZodUnion") return d.options.map(schemaHint).join("|");
  if (d.typeName === "ZodLiteral") return JSON.stringify(d.value);
  if (d.typeName === "ZodArray") return `[${schemaHint(d.type)}]`;
  return (schema.description || d.typeName.replace("Zod", "").toLowerCase());
}
export function panelToolCatalog(role: string) {
  return Object.entries(PANEL_TOOLS).filter(([, t]) => !("admin" in t && t.admin) || role === "admin")
    .map(([tool, t]) => `${tool} [${t.mode}] ${t.label} input=${schemaHint(t.schema)}`).join("\n")
    + (role === "admin" ? `\nSetting keys: ${Object.entries(PANEL_SETTINGS).map(([k, s]) => `${k}=${s.label}(${schemaHint(s.schema)})`).join("; ")}` : "");
}
export function parsePanelCall(actor: { role?: string }, tool: unknown, input: unknown, mode: "read" | "write"): PanelCall {
  const key = panelToolNameSchema.parse(tool);
  const def: Tool = PANEL_TOOLS[key];
  if (def.mode !== mode) throw new Error("工具类型不匹配，不能绕过确认执行修改");
  if (def.admin && actor.role !== "admin") throw new Error("只有管理员可以执行此操作");
  const parsed = def.schema.parse(panelInputSchema.parse(input ?? {}));
  if (["rules.create", "rules.update"].includes(key) && actor.role !== "admin" &&
      ["rateLimitMbps", "trafficLimit", "trafficMode", "createdAt", "expiresAt"].some(field => parsed[field] !== undefined)) {
    throw new Error("仅管理员可修改单条规则的限额和有效期");
  }
  if (key === "settings.set") parsed.value = PANEL_SETTINGS[parsed.key].schema.parse(parsed.value);
  return { tool: key, input: parsed };
}

async function callerFor(actorId: number) {
  const db = await import("../db");
  const user = await db.getUserById(actorId);
  if (!user || user.accountEnabled === false) throw new Error("当前账户不存在或已停用");
  const { appRouter } = await import("../routers");
  const ctx = {
    user, authSession: null, authFailureReason: null,
    req: { headers: { "x-request-id": `ai:${actorId}` }, socket: {}, protocol: "https", get: () => undefined },
    res: { clearCookie: () => undefined },
  } as unknown as TrpcContext;
  return { user, caller: appRouter.createCaller(ctx) };
}
async function callRoute(caller: unknown, route: string, input: unknown) {
  // route is always server-owned catalog data, never model input.
  const [area, operation] = route.split(".");
  return (caller as any)[area][operation](input);
}
function nested(path: string, value: unknown): Record<string, unknown> {
  return path.split(".").reverse().reduce<any>((v, key) => ({ [key]: v }), value);
}
function settingValue(all: Record<string, string | null>, key: string) {
  const def = PANEL_SETTINGS[key];
  let raw: unknown = all[def.dbKey];
  if (key.startsWith("protocol.")) {
    try { return normalizeForwardProtocolSettings(JSON.parse(String(raw || "{}")))[key.slice(9) as typeof FORWARD_TYPES[number] | typeof TUNNEL_PROTOCOLS[number]]; } catch { return def.fallback; }
  }
  if (key.startsWith("menu.") && key !== "menu.plugins") {
    try { return normalizeSidebarMenuSettings(JSON.parse(String(raw || "{}")))[key.slice(5) as typeof SIDEBAR_MENU_KEYS[number]]; } catch { return def.fallback; }
  }
  if (raw == null || raw === "") return def.fallback;
  if (def.schema instanceof z.ZodBoolean) return raw === true || raw === "true";
  if (def.schema instanceof z.ZodNumber) return Number(raw);
  return raw;
}
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function pick(row: any, fields: string[]) { return Object.fromEntries(fields.map(k => [k, row?.[k] ?? null])); }
function objectSchema(schema: z.ZodTypeAny): z.AnyZodObject { return schema instanceof z.ZodEffects ? objectSchema(schema.innerType()) : schema as z.AnyZodObject; }

async function snapshot(call: PanelCall, user: any): Promise<{ fingerprint: string; preview: string[]; row?: any }> {
  const db = await import("../db");
  const def: Tool = PANEL_TOOLS[call.tool];
  if (call.tool === "settings.set") {
    const s = PANEL_SETTINGS[String(call.input.key)];
    const current = settingValue(await db.getAllSettings(), String(call.input.key));
    return { fingerprint: digest(current), preview: [`${s.label}：${display(current)} → ${display(call.input.value)}`, ...(s.warning ? [`注意：${s.warning}`] : [])] };
  }
  let row: any;
  const resourceId = Number(call.input.id || call.input.userId || call.input.hostId);
  if (def.resource === "rule") row = await db.getForwardRuleById(resourceId);
  if (def.resource === "host") row = await db.getHostById(resourceId);
  if (def.resource === "tunnel") row = await db.getTunnelById(resourceId);
  if (def.resource === "group") row = await db.getForwardGroupById(resourceId);
  if (def.resource === "user") row = await db.getUserById(resourceId);
  if (def.resource === "plan") row = await db.getSubscriptionPlanById(resourceId);
  if (def.resource === "announcement") row = (await db.listAnnouncements(true)).find((v: any) => v.id === resourceId);
  if (def.resource && !row) throw new Error("操作对象不存在，请重新指定");
  // Owning a visible resource and owning its configuration are different rights.
  if (row && user.role !== "admin" && Number(row.userId) !== Number(user.id)) throw new Error("无权修改其他用户的资源");
  if (def.resource === "rule" && row.forwardGroupRuleId) throw new Error("转发组成员规则由系统维护，请修改模板规则或转发组");
  if (call.tool === "rules.create" && call.input.userId && user.role !== "admin" && call.input.userId !== user.id) throw new Error("普通用户只能给自己添加规则");
  const fields = Object.keys(objectSchema(def.schema).shape).filter(k => !["id", "userId", "hostId"].includes(k));
  let state: unknown = row ? pick(row, [...fields, "id", "name", "username", "title"]) : null;
  if (def.resource === "announcement") state = pick(row, ["id", "title", "content", "type", "isActive"]);
  if (def.resource === "group") state = { ...pick(row, Object.keys(row).filter(k => Object.keys(groupFields).includes(k) || ["groupMode", "groupType", "entryGroupId", "domain", "recordType", "exitStrategy", "isEnabled"].includes(k))), members: (row.members || []).map((m: any) => pick(m, ["memberType", "hostId", "tunnelId", "connectHost", "priority", "isEnabled"])) };
  if (call.tool === "users.permissions_change") {
    state = await readManualPermissions(resourceId, String(call.input.resource));
  } else if (call.tool.startsWith("users.") && call.tool.endsWith("_permissions")) {
    state = call.tool === "users.host_permissions" ? await db.getUserAllowedHostIds(resourceId)
      : call.tool === "users.tunnel_permissions" ? await db.getUserAllowedTunnelIds(resourceId) : await db.getUserManualAllowedForwardGroupIds(resourceId);
  }
  if (call.tool.startsWith("subscriptions.") && call.tool !== "subscriptions.assign") {
    row = (await db.listUserSubscriptions(undefined, { visibility: "admin" })).find((v: any) => Number(v.id) === resourceId);
    if (!row) throw new Error("订阅不存在");
    state = pick(row, ["id", "userId", "planId", "status", "expiresAt"]);
  }
  if (call.tool === "traffic_billing.save") {
    state = (await db.listTrafficBillingConfigs()).find((v: any) => v.resourceType === call.input.resourceType && Number(v.resourceId) === Number(call.input.resourceId)) || null;
    if (call.input.id && (state as any)?.id !== call.input.id) throw new Error("计费配置ID与所选资源不一致");
  }
  if (call.tool === "plans.update") state = pick(row, [...Object.keys(planFields), "currency", "sortOrder", "trafficAddons"]);
  if (call.tool === "subscriptions.assign") {
    const plan = await db.getSubscriptionPlanById(Number(call.input.planId));
    if (!plan) throw new Error("套餐不存在");
    state = { user: pick(row, ["id", "expiresAt", "trafficLimit", "maxRules"]), plan: pick(plan, [...Object.keys(planFields), "currency"]) };
  }
  if (call.tool === "users.limits") state = pick(row, [...fields, ...fields.map(k => `manual${k[0].toUpperCase()}${k.slice(1)}`)]);
  const preview = [row ? `对象：#${resourceId} ${row.name || row.title || row.username || ""}` : "", ...Object.entries(call.input).map(([k,v]) => `${fieldLabel(k)}：${row && fields.includes(k) && k in row && k !== "members" ? `${display(row[k])} → ` : ""}${display(v)}`), ...(def.warning ? [`注意：${def.warning}`] : [])].filter(Boolean);
  if (preview.join("\n").length > 2600) throw new Error("修改内容过多，无法完整展示确认卡片，请拆分为较小操作");
  return { fingerprint: digest(state), preview, row };
}
async function readManualPermissions(userId: number, resource: string) {
  const db = await import("../db");
  const result = resource === "host" ? await db.getUserAllowedHostIds(userId) : resource === "tunnel" ? await db.getUserAllowedTunnelIds(userId) : await db.getUserManualAllowedForwardGroupIds(userId);
  return result.slice().sort((a,b) => a-b);
}
export async function preparePanelCall(actorId: number, tool: unknown, input: unknown): Promise<PreparedPanelCall> {
  const db = await import("../db");
  const user = await db.getUserById(actorId);
  if (!user || user.accountEnabled === false) throw new Error("当前账户不存在或已停用");
  const call = parsePanelCall(user, tool, input, "write");
  const state = await snapshot(call, user);
  const routeCall = webCall(call);
  const normalized = await validateWebInput(routeCall);
  const defaults = Object.entries(normalized).filter(([key]) => !(key in routeCall.input));
  const preview = [...state.preview, ...(defaults.length ? [`网页默认值：${defaults.map(([key,value]) => `${fieldLabel(key)}=${display(value)}`).join("，")}`] : [])];
  if (preview.join("\n").length > 2600) throw new Error("修改内容过多，无法完整展示确认卡片，请拆分操作");
  return { ...call, fingerprint: state.fingerprint, preview };
}
function webCall(call: PanelCall) {
  const def: Tool = PANEL_TOOLS[call.tool];
  const s = call.tool === "settings.set" ? PANEL_SETTINGS[String(call.input.key)] : null;
  return { route: s ? s.route || "system.updateSettings" : def.route!, input: s ? nested(s.path, call.input.value) : call.input };
}
async function validateWebInput(call: { route: string; input: Record<string, unknown> }) {
  const { appRouter } = await import("../routers");
  const procedure = (appRouter._def.procedures as any)[call.route];
  if (!procedure) throw new Error("业务工具未注册");
  let input: any = call.input;
  for (const parser of procedure._def.inputs) input = await parser.parseAsync(input);
  return input as Record<string, unknown>;
}
export async function executePanelCall(actorId: number, prepared: PreparedPanelCall) {
  let context: Awaited<ReturnType<typeof callerFor>>;
  let call: PanelCall;
  let state: Awaited<ReturnType<typeof snapshot>>;
  try {
    context = await callerFor(actorId);
    call = parsePanelCall(context.user, prepared.tool, prepared.input, "write");
    state = await snapshot(call, context.user);
    if (state.fingerprint !== prepared.fingerprint) throw new Error("配置已在预览后发生变化，本次未执行；请重新预览并确认");
    await validateWebInput(webCall(call));
  } catch (error) { throw new PanelPreflightError(error instanceof Error ? error.message : String(error)); }
  const { caller } = context;
  const def: Tool = PANEL_TOOLS[call.tool];
  const { route, input } = webCall(call);
  const result = await callRoute(caller, route, input);
  return { label: def.label, result: projectPanelResult(result) };
}

// Read and execution results are projected even for admins; never return an
// entire router response (many contain tunnel secrets, API keys or password hashes).
const SAFE_FIELDS = new Set(["id", "name", "title", "username", "userId", "hostId", "tunnelId", "planId", "groupId", "forwardGroupId", "resourceId", "resourceType", "enabled", "isActive", "isStoreVisible", "isEnabled", "isOnline", "status", "type", "message", "createdAt", "updatedAt", "recordedAt", "expiresAt", "stoppedAt", "bytesIn", "bytesOut", "totalIn", "totalOut", "trafficUsed", "trafficLimit", "trafficIn", "trafficOut", "cpuUsage", "memoryUsage", "memoryUsed", "memoryTotal", "diskUsage", "diskUsed", "diskTotal", "connections", "balanceCents", "priceCents", "pricePerGbMilliCents", "multiplier", "durationDays", "maxRules", "maxPorts", "maxConnections", "maxIPs", "portRangeStart", "portRangeEnd", "sourcePort", "targetIp", "targetPort", "forwardType", "protocol", "listenPort", "success", "configs", "items", "list", "total", "count", "totalHosts", "onlineHosts", "totalRules", "activeRules", "runningRules", "totalTunnels", "totalTrafficIn", "totalTrafficOut", "activeSubscriptions", "totalPlans", "totalUsers", "totalBalanceCents", "totalRechargeCents", "totalConsumptionCents", "userCount", "activeRedemptionCodes", "activeDiscountCodes", "hostIds", "tunnelIds", "forwardGroupIds", "planName", "amountCents", "currency", "remark", "description", "role", "accountEnabled"]);
export function projectPanelResult(value: any, depth = 0): any {
  if (depth > 5) return "…";
  if (value instanceof Date) return value.toISOString();
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 30).map(v => projectPanelResult(v, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([k]) => SAFE_FIELDS.has(k)).map(([k,v]) => [k, projectPanelResult(v, depth + 1)]));
  return undefined;
}
for (const field of ["rateLimitMbps", "trafficMode", "quotaUsedIn", "quotaUsedOut", "ruleLimitReason", "expirySource", "ruleExpiresAt", "accountExpiresAt"]) SAFE_FIELDS.add(field);
SAFE_FIELDS.add("adminManaged");
function display(v: unknown): string { return v === true ? "开启" : v === false ? "关闭" : v == null ? "不限/未设置" : typeof v === "object" ? JSON.stringify(v) : String(v); }
const FIELD_LABELS: Record<string, string> = {
  adminManaged: "管理员自定义（用户只读）",
  trafficMode: "流量计量方式", quotaUsedIn: "额度累计入向(字节)", quotaUsedOut: "额度累计出向(字节)",
  ruleLimitReason: "规则暂停原因", expirySource: "生效到期来源", ruleExpiresAt: "规则到期时间", accountExpiresAt: "账户到期时间",
  label: "查询内容", id: "ID", name: "名称", title: "标题", username: "用户名", value: "当前值", userId: "用户ID", hostId: "主机ID", tunnelId: "隧道ID", groupId: "转发组ID", forwardGroupId: "转发链/组ID", planId: "套餐ID", planName: "套餐", resourceId: "资源ID", resourceType: "资源类型", resourceIds: "资源ID列表", resource: "资源类型", operation: "操作", total: "匹配总数", count: "数量", items: "查询结果", result: "执行结果", configs: "计费配置", list: "列表", success: "成功", enabled: "启用", isEnabled: "启用", isActive: "有效", isStoreVisible: "商店展示", isOnline: "在线", status: "状态", type: "类型", message: "说明", createdAt: "创建时间", updatedAt: "更新时间", recordedAt: "采样时间", expiresAt: "到期时间", stoppedAt: "主机到期时间", bytesIn: "入向流量(字节)", bytesOut: "出向流量(字节)", trafficLimit: "流量额度(字节,0=不限)", trafficUsed: "已用流量(字节)", totalIn: "总入向(字节)", totalOut: "总出向(字节)", totalTrafficIn: "总入向(字节)", totalTrafficOut: "总出向(字节)", cpuUsage: "CPU使用率", memoryUsage: "内存使用率", diskUsage: "磁盘使用率", memoryUsed: "内存已用(字节)", memoryTotal: "内存总量(字节)", diskUsed: "磁盘已用(字节)", diskTotal: "磁盘总量(字节)", connections: "连接数", balanceCents: "余额(分)", priceCents: "价格(分)", pricePerGbMilliCents: "每GB价格(千分之一分)", durationDays: "期限(天)", maxRules: "规则上限", maxPorts: "端口上限", maxConnections: "连接上限", maxIPs: "IP上限", sourcePort: "入口端口", targetIp: "目标地址", targetPort: "目标端口", forwardType: "转发工具", protocol: "协议", listenPort: "隧道监听端口", portRangeStart: "起始端口", portRangeEnd: "结束端口", proxyProtocolSend: "发送PROXY", proxyProtocolReceive: "接收PROXY", proxyProtocolExitSend: "出口发送PROXY", proxyProtocolExitReceive: "出口接收PROXY", proxyProtocolVersion: "PROXY版本", tcpFastOpen: "TCP Fast Open", zeroCopy: "零拷贝", udpOverTcp: "UDP Over TCP", telegramErrorNotifyEnabled: "规则异常通知", blockHttp: "阻止HTTP", blockSocks: "阻止SOCKS", blockTls: "阻止TLS", rateLimitMbps: "限速(Mbps)", trafficMultiplier: "流量倍率(100=1倍)", members: "成员列表", hostIds: "主机授权", tunnelIds: "隧道授权", forwardGroupIds: "转发组授权", renewalReminderDays: "续费提前提醒(天)", telegramRenewalReminderEnabled: "续费提醒", trafficFailoverEnabled: "达量剔除", trafficFailoverThresholdPercent: "达量剔除阈值(%)", trafficAutoReset: "流量自动重置", trafficResetDay: "重置日", syncExistingSubscribers: "同步已有订阅", userCount: "用户数", activeRedemptionCodes: "有效兑换码", activeDiscountCodes: "有效折扣码", totalBalanceCents: "总余额(分)", totalHosts: "主机总数", onlineHosts: "在线主机", totalRules: "规则总数", runningRules: "运行规则", totalTunnels: "隧道总数", totalUsers: "用户总数", totalPlans: "套餐总数", remark: "备注", description: "说明", role: "角色", accountEnabled: "账号启用", currency: "币种",
};
function fieldLabel(key: string) { return FIELD_LABELS[key] || key; }
export function formatPanelToolResult(value: unknown) {
  function lines(v: any, indent = ""): string[] {
    if (Array.isArray(v)) return v.length ? v.flatMap((item, index) => [`${indent}${index + 1}.`, ...lines(item, `${indent}  `)]) : [`${indent}无匹配记录`];
    if (v && typeof v === "object") return Object.entries(v).flatMap(([key, item]) => item && typeof item === "object" ? [`${indent}${fieldLabel(key)}：`, ...lines(item, `${indent}  `)] : [`${indent}${fieldLabel(key)}：${display(item)}`]);
    return [`${indent}${display(v)}`];
  }
  const text = value === undefined ? "操作已提交，请查看面板确认运行状态" : lines(value).join("\n");
  return text.length > 2800 ? `${text.slice(0, 2800)}\n…结果较长，已截断；请指定ID或名称进一步查询。` : text;
}
export async function queryPanelCall(actorId: number, tool: unknown, input: unknown, resources: (kind: "rules" | "hosts", actor: any) => Promise<any[]>) {
  const db = await import("../db");
  const { user, caller } = await callerFor(actorId);
  const call = parsePanelCall(user, tool, input, "read");
  const def: Tool = PANEL_TOOLS[call.tool];
  let result: any;
  const matches = (r: any) => !call.input.keyword || [r.id, r.name, r.title, r.username, r.planName].some(v => String(v || "").toLowerCase().includes(String(call.input.keyword).toLowerCase()));
  if (call.tool === "settings.read") {
    const all = await db.getAllSettings();
    result = Object.keys(PANEL_SETTINGS).map(key => ({ id: key, name: PANEL_SETTINGS[key].label, value: settingValue(all, key) })).filter(matches);
  } else if (call.tool === "plans.list") {
    result = await callRoute(caller, user.role === "admin" ? "plans.list" : "plans.storeList", undefined);
  } else if (call.tool === "subscriptions.list") {
    if (user.role !== "admin" && call.input.userId && call.input.userId !== user.id) throw new Error("无权查看其他用户的订阅");
    result = await db.listUserSubscriptions(user.role === "admin" && call.input.scope !== "self" ? call.input.userId as number | undefined : user.id, { visibility: user.role === "admin" ? "admin" : "user" });
  } else if (call.tool === "users.permissions") {
    result = { userId: call.input.userId, hostIds: await db.getUserAllowedHostIds(Number(call.input.userId)), tunnelIds: await db.getUserAllowedTunnelIds(Number(call.input.userId)), forwardGroupIds: await db.getUserManualAllowedForwardGroupIds(Number(call.input.userId)) };
  } else if (call.tool === "expiry.list") {
    const kind = call.input.resource;
    const users = user.role === "admin" && call.input.scope !== "self" ? await db.getUserTrafficSummaries() : [user];
    const byId = new Map<number, any>(users.map((u: any) => [Number(u.id), u]));
    result = kind === "users" ? users.map((u: any) => pick(u, ["id", "name", "username", "expiresAt"]))
      : kind === "hosts" ? (await resources("hosts", user)).filter((h: any) => call.input.scope !== "self" || user.role !== "admin" || Number(h.userId) === user.id).map((h: any) => ({ ...pick(h, ["id", "name"]), expiresAt: h.stoppedAt }))
      : kind === "rules" ? (await resources("rules", user)).filter((r: any) => call.input.scope !== "self" || Number(r.userId) === user.id).map((r: any) => {
          const accountExpiresAt = byId.get(Number(r.userId))?.expiresAt || null;
          const own = r.expiresAt || null;
          const useOwn = own && (!accountExpiresAt || new Date(own).getTime() <= new Date(accountExpiresAt).getTime());
          return { ...pick(r, ["id", "name", "userId", "hostId", "tunnelId"]), ruleExpiresAt: own, accountExpiresAt,
            expiresAt: useOwn ? own : accountExpiresAt, expirySource: useOwn ? "rule" : "account" };
        })
      : await db.listUserSubscriptions(user.role === "admin" && call.input.scope !== "self" ? undefined : user.id, { visibility: user.role === "admin" ? "admin" : "user" });
    const now = Date.now();
    result = result.filter((r: any) => matches(r) && r.expiresAt && Number.isFinite(new Date(r.expiresAt).getTime()) && new Date(r.expiresAt).getTime() <= now + Number(call.input.days || 7) * 86400000 && (call.input.includeExpired === true || new Date(r.expiresAt).getTime() >= now) && r.status !== "cancelled" && (call.input.includeExpired === true || r.status !== "expired")).sort((a: any,b: any) => new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime());
    return { label: `${def.label}（${kind === "rules" ? "按规则与所属账户有效期中的较早时间，expirySource 标注来源" : kind}；${call.input.includeExpired ? "含已到期" : "未到期"}；未来${call.input.days || 7}天）`, total: result.length, items: projectPanelResult(result.slice(0, Number(call.input.limit || 15))) };
  } else {
    result = await callRoute(caller, def.route!, call.tool === "hosts.metrics" ? { ...call.input, limit: 1 } : ["announcements.list", "billing.summary", "dashboard.read", "traffic_billing.list"].includes(call.tool) ? undefined : call.input);
  }
  if (Array.isArray(result)) {
    result = result.filter(matches);
    return { label: def.label, total: result.length, items: call.tool === "settings.read" ? result.slice(0, Number(call.input.limit || 15)) : projectPanelResult(result.slice(0, Number(call.input.limit || 15))) };
  }
  return { label: def.label, result: projectPanelResult(result) };
}
