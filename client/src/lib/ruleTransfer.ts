import { t as translateText } from "@/i18n";
import {
  FORWARD_TYPES,
  type ForwardRuleProtocol,
  type ForwardType,
} from "@shared/forwardTypes";
import { z } from "zod";

export const RULE_TRANSFER_FILE_KIND = "forwardx.forward-rules";
export const RULE_TRANSFER_FILE_VERSION = 1;
export const RULE_TRANSFER_MAX_IMPORT_COUNT = 500;
export const RULE_TRANSFER_MAX_FILE_SIZE = 5 * 1024 * 1024;
export const RULE_IMPORT_PORT_TEXT_MAX_LENGTH = 8192;

/** Expand in user-supplied order. Reject overlaps instead of silently shifting assignments. */
export function parseRuleImportPorts(text: string): { ok: true; ports: number[] } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, ports: [] };
  if (text.length > RULE_IMPORT_PORT_TEXT_MAX_LENGTH) return { ok: false, error: translateText("监听端口配置过长") };
  const ports: number[] = [];
  const seen = new Set<number>();
  for (const part of text.split(/[,，]/)) {
    const match = part.trim().match(/^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/);
    if (!match) return { ok: false, error: translateText("监听端口格式错误，请使用 10000-10020,10025") };
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    if (start < 1 || end > 65535 || start > end) return { ok: false, error: translateText("监听端口须在 1-65535 之间，范围起点不能大于终点") };
    for (let port = start; port <= end; port++) {
      if (seen.has(port)) return { ok: false, error: translateText("监听端口 {0} 重复，请检查范围是否重叠", [port]) };
      seen.add(port);
      ports.push(port);
    }
  }
  return { ok: true, ports };
}

export function assignRuleImportPorts<T extends { sourcePort: number }>(rules: readonly T[], ports: readonly number[], onlyUnassigned = false): T[] {
  let portIndex = 0;
  return rules.map(rule => {
    // Manual per-line ports take precedence and do not consume the bulk port list.
    if (onlyUnassigned && rule.sourcePort > 0) return { ...rule };
    return ports.length ? { ...rule, sourcePort: ports[portIndex++] ?? 0 } : { ...rule };
  });
}

/** host:port or listener:host:port; IPv6 targets must be bracketed to avoid ambiguity. */
export function parseManualRuleImportLine(line: string): { sourcePort: number; targetIp: string; targetPort: number } | { error: string } {
  const match = line.trim().replace(/：/g, ":").match(/^(?:(\d+)\s*:\s*)?(\[[^\]]+\]|[^\s:\[\]]+)\s*:\s*(\d+)$/);
  if (!match) return { error: translateText("请按 目标地址:端口 或 监听端口:目标地址:端口 填写，IPv6 地址需加方括号") };
  const sourcePort = match[1] === undefined ? 0 : Number(match[1]);
  const targetPort = Number(match[3]);
  if ((match[1] !== undefined && (!Number.isInteger(sourcePort) || sourcePort < 1 || sourcePort > 65535)) || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    return { error: translateText("端口必须在 1-65535 之间") };
  }
  const bracketed = match[2].startsWith("[");
  const targetIp = bracketed ? match[2].slice(1, -1) : match[2];
  if (!targetHostSchema.safeParse(targetIp).success) return { error: translateText("地址格式不正确") };
  if (bracketed) {
    try { new URL(`http://[${targetIp}]/`); }
    catch { return { error: translateText("地址格式不正确") }; }
  }
  return { sourcePort, targetIp, targetPort };
}

export type ProxyProtocolVersion = 1 | 2;
export type FailoverStrategy = "fallback" | "round_robin" | "random" | "ip_hash";

export type RuleTransferFileRule = {
  name: string;
  forwardType: ForwardType;
  protocol: ForwardRuleProtocol;
  sourcePort: number;
  targetIp: string;
  targetPort: number;
  isEnabled: boolean;
  rateLimitMbps?: number;
  telegramErrorNotifyEnabled?: boolean;
  proxyProtocolReceive: boolean;
  proxyProtocolSend: boolean;
  proxyProtocolExitReceive: boolean;
  proxyProtocolExitSend: boolean;
  proxyProtocolVersion: ProxyProtocolVersion;
  tcpFastOpen: boolean;
  zeroCopy: boolean;
  udpOverTcp: boolean;
  udpOverTcpPort: number;
  failoverEnabled: boolean;
  failoverStrategy: FailoverStrategy;
  failoverTargets: Array<{ targetIp: string; targetPort: number }>;
  failoverSeconds: number;
  recoverSeconds: number;
  autoFailback: boolean;
};

export type RuleTransferFile = {
  kind: typeof RULE_TRANSFER_FILE_KIND;
  version: typeof RULE_TRANSFER_FILE_VERSION;
  exportedAt?: string;
  scope?: {
    type?: string;
    id?: number;
    name?: string;
  };
  rules: RuleTransferFileRule[];
};

export type RuleTransferParseResult =
  | { ok: true; file: RuleTransferFile }
  | { ok: false; error: string };

export function serializeRuleTransferText(rules: readonly Pick<RuleTransferFileRule, "sourcePort" | "targetIp" | "targetPort">[]): string {
  return rules.map(rule => {
    const host = rule.targetIp.includes(":") && !rule.targetIp.startsWith("[") ? `[${rule.targetIp}]` : rule.targetIp;
    return `${rule.sourcePort > 0 ? rule.sourcePort + ":" : ""}${host}:${rule.targetPort}`;
  }).join("\n");
}

export function parseRuleTransferText(text: string): RuleTransferParseResult {
  if (new TextEncoder().encode(text).byteLength > RULE_TRANSFER_MAX_FILE_SIZE) return { ok: false, error: translateText("规则文件不能超过 5 MiB") };
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return { ok: false, error: translateText("文件中没有可导入的规则") };
  if (lines.length > RULE_TRANSFER_MAX_IMPORT_COUNT) return { ok: false, error: translateText("单次最多导入 {0} 条规则", [RULE_TRANSFER_MAX_IMPORT_COUNT]) };
  const rules = [];
  for (let index = 0; index < lines.length; index++) {
    const parsed = parseManualRuleImportLine(lines[index]);
    if ("error" in parsed) return { ok: false, error: translateText("第 {0} 行：{1}", [index + 1, parsed.error]) };
    const host = parsed.targetIp.includes(":") ? `[${parsed.targetIp}]` : parsed.targetIp;
    rules.push({ ...parsed, name: `${host}:${parsed.targetPort}`.slice(0, 128) });
  }
  return parseRuleTransferFile({ kind: RULE_TRANSFER_FILE_KIND, version: RULE_TRANSFER_FILE_VERSION, rules });
}

const targetHostSchema = z.string().trim().min(1).max(253).refine(
  (value) => /^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$|^[a-fA-F0-9:.]+$/.test(value),
  "地址格式不正确",
);

const failoverTargetSchema = z.object({
  targetIp: targetHostSchema,
  targetPort: z.number().int().min(1).max(65535),
});

const ruleTransferRuleSchema = z.object({
  name: z.string().trim().min(1).max(128).optional().default("导入规则"),
  forwardType: z.enum(FORWARD_TYPES).optional().default("iptables"),
  protocol: z.enum(["tcp", "udp", "both"]).optional().default("both"),
  sourcePort: z.number().int().min(0).max(65535),
  targetIp: targetHostSchema,
  targetPort: z.number().int().min(1).max(65535),
  isEnabled: z.boolean().optional().default(true),
  telegramErrorNotifyEnabled: z.boolean().optional().default(false),
  proxyProtocolReceive: z.boolean().optional().default(false),
  proxyProtocolSend: z.boolean().optional().default(false),
  proxyProtocolExitReceive: z.boolean().optional().default(false),
  proxyProtocolExitSend: z.boolean().optional().default(false),
  proxyProtocolVersion: z.union([z.literal(1), z.literal(2)]).optional().default(1),
  tcpFastOpen: z.boolean().optional().default(false),
  zeroCopy: z.boolean().optional().default(false),
  udpOverTcp: z.boolean().optional().default(false),
  udpOverTcpPort: z.number().int().min(0).max(65535).optional().default(0),
  failoverEnabled: z.boolean().optional().default(false),
  failoverStrategy: z.enum(["fallback", "round_robin", "random", "ip_hash"]).optional().default("fallback"),
  failoverTargets: z.array(failoverTargetSchema).max(10).optional().default([]),
  failoverSeconds: z.number().int().min(10).max(3600).optional().default(60),
  recoverSeconds: z.number().int().min(10).max(3600).optional().default(120),
  autoFailback: z.boolean().optional().default(true),
});

function issueMessage(issue: z.ZodIssue) {
  const field = issue.path.length > 0 ? `字段 ${issue.path.join(".")}` : "内容";
  return `${field}${issue.message ? `：${issue.message}` : "格式不正确"}`;
}

export function parseRuleTransferFile(raw: unknown): RuleTransferParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: translateText("文件内容不是有效的规则对象") };
  }
  const source = raw as Record<string, unknown>;
  if (source.kind !== RULE_TRANSFER_FILE_KIND) {
    return { ok: false, error: translateText("文件不是 ForwardX 转发规则导出文件") };
  }
  if (source.version !== RULE_TRANSFER_FILE_VERSION) {
    return { ok: false, error: translateText("不支持该规则文件版本（当前支持 v{0}）", [RULE_TRANSFER_FILE_VERSION]) };
  }
  if (!Array.isArray(source.rules) || source.rules.length === 0) {
    return { ok: false, error: translateText("文件中没有可导入的规则") };
  }
  if (source.rules.length > RULE_TRANSFER_MAX_IMPORT_COUNT) {
    return { ok: false, error: translateText("单次最多导入 {0} 条规则", [RULE_TRANSFER_MAX_IMPORT_COUNT]) };
  }

  const rules: RuleTransferFileRule[] = [];
  for (let index = 0; index < source.rules.length; index += 1) {
    const parsed = ruleTransferRuleSchema.safeParse(source.rules[index]);
    if (!parsed.success) {
      return { ok: false, error: translateText("第 {0} 条规则{1}", [index + 1, issueMessage(parsed.error.issues[0])]) };
    }
    rules.push(parsed.data);
  }

  const scopeSource = source.scope && typeof source.scope === "object" && !Array.isArray(source.scope)
    ? source.scope as Record<string, unknown>
    : null;
  return {
    ok: true,
    file: {
      kind: RULE_TRANSFER_FILE_KIND,
      version: RULE_TRANSFER_FILE_VERSION,
      exportedAt: typeof source.exportedAt === "string" ? source.exportedAt : undefined,
      scope: scopeSource
        ? {
            type: typeof scopeSource.type === "string" ? scopeSource.type : undefined,
            id: typeof scopeSource.id === "number" ? scopeSource.id : undefined,
            name: typeof scopeSource.name === "string" ? scopeSource.name : undefined,
          }
        : undefined,
      rules,
    },
  };
}

export function findRuleTransferPortConflict(rules: readonly RuleTransferFileRule[]) {
  const seen = new Map<number, number>();
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (rule.sourcePort === 0) continue;
    const previousIndex = seen.get(rule.sourcePort);
    if (previousIndex !== undefined) {
      return {
        port: rule.sourcePort,
        firstIndex: previousIndex,
        secondIndex: index,
      };
    }
    seen.set(rule.sourcePort, index);
  }
  return null;
}
