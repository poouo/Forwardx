import { z } from "zod";
import { aiSkillRegistry, type AiSkillDefinition } from "./registry";

export const FORWARDX_QUERY_INTENTS = [
  "usage",
  "rules",
  "rule_detail",
  "rule_usage",
  "rule_rank",
  "hosts",
  "tunnels",
  "forward_groups",
  "users",
  "account",
  "help",
  "unsupported",
] as const;

export const FORWARDX_MANAGE_ACTIONS = [
  "none",
  "balance_set",
  "balance_adjust",
  "renew",
  "account_enable",
  "account_disable",
  "forward_enable",
  "forward_disable",
  "rule_enable",
  "rule_disable",
  "rule_create",
  "rule_delete",
  "tunnel_rules_enable",
  "tunnel_rules_disable",
  "traffic_reset",
  "redeem_code_generate_balance",
  "discount_code_generate_percent",
  "registration_enable",
  "registration_disable",
] as const;

const numericValueSchema = z.union([z.number(), z.string()]);
const booleanValueSchema = z.union([z.boolean(), z.enum(["true", "false"])]);

export const forwardxQueryIntentResponseSchema = z.object({
  intent: z.enum(FORWARDX_QUERY_INTENTS),
  id: numericValueSchema.optional(),
  keyword: z.string().max(120).optional(),
  ruleStatus: z.enum(["running", "pending", "disabled", "abnormal"]).optional(),
  rankMetric: z.enum(["traffic", "connections", "latency"]).optional(),
  rankOrder: z.enum(["desc", "asc"]).optional(),
  limit: numericValueSchema.optional(),
}).strip();

export const forwardxManageIntentResponseSchema = z.object({
  action: z.enum(FORWARDX_MANAGE_ACTIONS),
  target: z.string().max(120).optional(),
  amountYuan: numericValueSchema.optional(),
  durationValue: numericValueSchema.optional(),
  durationUnit: z.enum(["day", "month", "year"]).optional(),
  ruleId: numericValueSchema.optional(),
  tunnel: z.string().max(120).optional(),
  host: z.string().max(120).optional(),
  forwardMode: z.enum(["host", "tunnel"]).optional(),
  sourcePort: numericValueSchema.optional(),
  targetIp: z.string().max(255).optional(),
  targetPort: numericValueSchema.optional(),
  codeCount: numericValueSchema.optional(),
  discountPercent: numericValueSchema.optional(),
  writeLike: booleanValueSchema.optional(),
}).strip();

export const forwardxCoreSkill: AiSkillDefinition = {
  id: "forwardx-core",
  version: "1.0.0",
  name: "ForwardX 核心管理",
  description: "理解 ForwardX 主机、转发规则、隧道、转发组、用户与计费资源，并将自然语言路由到受控的本地工具。",
  instructions: [
    "模型只负责识别意图和提取参数，不直接回答运行数据，也不生成可执行代码。",
    "所有面板数据均由本地只读工具查询，不向模型发送数据库记录。",
    "所有写操作必须经过参数校验、权限检查、操作预览和用户二次确认。",
    "不确定资源或参数时进入澄清流程，不猜测主机、隧道、规则或用户。",
  ],
  tools: [
    { name: "usage.query", mode: "read", description: "查询账户流量、余额、套餐和额度", permission: "self", inputFields: [] },
    { name: "rules.query", mode: "read", description: "查询规则、状态、流量、连接和延迟排行", permission: "authenticated", inputFields: ["keyword", "ruleStatus", "rankMetric", "rankOrder", "limit"] },
    { name: "hosts.query", mode: "read", description: "查询有权限查看的主机及 Agent 状态", permission: "authenticated", inputFields: ["keyword"] },
    { name: "tunnels.query", mode: "read", description: "查询有权限使用的隧道和链路", permission: "authenticated", inputFields: ["keyword"] },
    { name: "forward_groups.query", mode: "read", description: "查询转发组、入口组和转发链", permission: "authenticated", inputFields: ["keyword"] },
    { name: "users.query", mode: "read", description: "查询用户概览和使用情况", permission: "admin", inputFields: ["keyword"] },
    { name: "rules.manage", mode: "write", description: "创建、删除、启用或停用规则", permission: "self", requiresConfirmation: true, inputFields: ["action", "ruleId", "forwardMode", "host", "tunnel", "sourcePort", "targetIp", "targetPort"] },
    { name: "users.manage", mode: "write", description: "调整用户余额、期限、状态、流量和转发权限", permission: "admin", requiresConfirmation: true, inputFields: ["action", "target", "amountYuan", "durationValue", "durationUnit"] },
    { name: "codes.manage", mode: "write", description: "生成余额兑换码或折扣码", permission: "admin", requiresConfirmation: true, inputFields: ["action", "amountYuan", "codeCount", "discountPercent"] },
    { name: "registration.manage", mode: "write", description: "启用或关闭公开注册", permission: "admin", requiresConfirmation: true, inputFields: ["action"] },
  ],
};

aiSkillRegistry.register(forwardxCoreSkill);

function skillHeader(mode: "read" | "write") {
  const tools = forwardxCoreSkill.tools.filter((tool) => tool.mode === mode);
  return [
    `Skill: ${forwardxCoreSkill.id}@${forwardxCoreSkill.version}.`,
    ...forwardxCoreSkill.instructions,
    `Available ${mode} tools: ${tools.map((tool) => tool.name).join(", ")}.`,
  ];
}

export function buildForwardxQueryIntentPrompt() {
  return [
    ...skillHeader("read"),
    "Classify the ForwardX Telegram message into one read-only query intent.",
    "Return only JSON with keys: intent, id, keyword, ruleStatus, rankMetric, rankOrder, limit.",
    `Allowed intents: ${FORWARDX_QUERY_INTENTS.join(",")}.`,
    "For abnormal, pending, disabled, or running rule queries, use rules and set ruleStatus.",
    "Use rule_usage only for traffic usage of one explicit rule id; use rule_detail for explicit detail/status requests.",
    "Use rule_rank for highest/lowest traffic, connections, or latency and set rankMetric/rankOrder.",
    "Rules filtered by a user or host remain rules queries. Keep precise user, host, port, IP, domain, and id keywords.",
    "Do not use vague words such as now/current/all/my as keyword.",
    "Any request that changes data must return unsupported.",
    "Do not answer the user and do not include markdown.",
  ].join(" ");
}

export function buildForwardxManageIntentPrompt() {
  return [
    ...skillHeader("write"),
    "Classify the ForwardX Telegram message into one write operation.",
    "Return only JSON keys: action,target,amountYuan,durationValue,durationUnit,ruleId,tunnel,host,forwardMode,sourcePort,targetIp,targetPort,codeCount,discountPercent,writeLike.",
    `Allowed actions: ${FORWARDX_MANAGE_ACTIONS.join(",")}.`,
    "Use rule_enable/rule_disable only for a specific rule id, and tunnel_rules_enable/tunnel_rules_disable for rules belonging to one tunnel.",
    "Use rule_create/rule_delete for forwarding rule changes. sourcePort may be 0 only when a random source port is requested.",
    "Use balance_adjust for recharge/add/subtract and balance_set only for an absolute balance.",
    "Use redeem_code_generate_balance for balance redemption codes and discount_code_generate_percent for discount codes.",
    "Use registration_enable/registration_disable for public self-service registration.",
    "Never invent omitted amounts, durations, counts, discounts, users, hosts, tunnels, ports, or addresses; leave those fields absent so the local guided flow can ask the user.",
    "If the message is read-only, set action to none and writeLike to false.",
    "Do not answer the user and do not include markdown.",
  ].join(" ");
}
