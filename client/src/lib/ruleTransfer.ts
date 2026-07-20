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
    return { ok: false, error: "文件内容不是有效的规则对象" };
  }
  const source = raw as Record<string, unknown>;
  if (source.kind !== RULE_TRANSFER_FILE_KIND) {
    return { ok: false, error: "文件不是 ForwardX 转发规则导出文件" };
  }
  if (source.version !== RULE_TRANSFER_FILE_VERSION) {
    return { ok: false, error: `不支持该规则文件版本（当前支持 v${RULE_TRANSFER_FILE_VERSION}）` };
  }
  if (!Array.isArray(source.rules) || source.rules.length === 0) {
    return { ok: false, error: "文件中没有可导入的规则" };
  }
  if (source.rules.length > RULE_TRANSFER_MAX_IMPORT_COUNT) {
    return { ok: false, error: `单次最多导入 ${RULE_TRANSFER_MAX_IMPORT_COUNT} 条规则` };
  }

  const rules: RuleTransferFileRule[] = [];
  for (let index = 0; index < source.rules.length; index += 1) {
    const parsed = ruleTransferRuleSchema.safeParse(source.rules[index]);
    if (!parsed.success) {
      return { ok: false, error: `第 ${index + 1} 条规则${issueMessage(parsed.error.issues[0])}` };
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

function protocolsOverlap(left: ForwardRuleProtocol, right: ForwardRuleProtocol) {
  return left === "both" || right === "both" || left === right;
}

export function findRuleTransferPortConflict(rules: readonly RuleTransferFileRule[]) {
  const seen = new Map<number, Array<{ index: number; protocol: ForwardRuleProtocol }>>();
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (rule.sourcePort === 0) continue;
    const previous = seen.get(rule.sourcePort) || [];
    const conflict = previous.find((item) => protocolsOverlap(item.protocol, rule.protocol));
    if (conflict) {
      return {
        port: rule.sourcePort,
        firstIndex: conflict.index,
        secondIndex: index,
      };
    }
    previous.push({ index, protocol: rule.protocol });
    seen.set(rule.sourcePort, previous);
  }
  return null;
}
