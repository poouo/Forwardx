import { t } from "@/i18n";
import type { ForwardRuleProtocol } from "@shared/forwardTypes";
import {
  parseRuleTransferFile, parseRuleTransferText, RULE_TRANSFER_FILE_KIND, RULE_TRANSFER_FILE_VERSION,
  RULE_TRANSFER_MAX_FILE_SIZE, RULE_TRANSFER_MAX_IMPORT_COUNT,
  type RuleTransferFile, type RuleTransferFileRule,
} from "./ruleTransfer";
import {isBatchPortConflictError} from "./batchOperations";

export type CompatibleRuleFile = RuleTransferFile & { importSource?: "nyanpass" | "text" };
export type CompatibleRuleParseResult = {ok:true;file:CompatibleRuleFile} | {ok:false;error:string};
const allowedFields = new Set(["name","listen_port","dest","dest_policy","accept_proxy_protocol","proxy_protocol","speed_limit","ip_limit","connection_limit","tls"]);
const strategies = {random:"random",round:"round_robin",ip_hash:"ip_hash",failover:"fallback"} as const;

function target(value: unknown) {
  if (typeof value !== "string") return null;
  // Require brackets for IPv6, just like the source UI. Never split at the
  // first colon or interpret a URL/path as a target address.
  const match = value.trim().match(/^(?:\[([a-fA-F0-9:.]+)\]|([^\s:[\]/?#]+)):(\d+)$/);
  if (!match) return null;
  if (match[1]) {
    try {new URL(`http://[${match[1]}]/`);} catch {return null;}
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(match[2]) && match[2].split(".").some(part=>Number(part)>255)) return null;
  const port = Number(match[3]);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? {targetIp:match[1] || match[2],targetPort:port} : null;
}

function convertRule(value: unknown, index: number): RuleTransferFileRule & {rateLimitMbps?:number} {
  const fail = (reason: string): never => {throw new Error(t("ny 第 {0} 条规则：{1}",[index+1,reason]));};
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(t("规则必须是 JSON 对象"));
  const row = value as Record<string, unknown>;
  const unknown = Object.keys(row).filter(key=>!allowedFields.has(key));
  if (unknown.length) return fail(t("不支持的配置字段：{0}",[unknown.join(", ").slice(0,200)]));
  if (!Number.isInteger(row.listen_port) || Number(row.listen_port)<0 || Number(row.listen_port)>65535) return fail(t("监听端口必须是 0-65535 的整数"));
  if (!Array.isArray(row.dest) || !row.dest.length || row.dest.length>11) return fail(t("目标列表需包含 1-11 个地址"));
  const destinations = row.dest.map(target);
  if (destinations.some(item=>!item)) return fail(t("目标地址格式应为 host:port 或 [IPv6]:port"));
  for (const field of ["ip_limit","connection_limit","speed_limit","accept_proxy_protocol","proxy_protocol"] as const) {
    const number = row[field];
    if (number != null && (typeof number !== "number" || !Number.isSafeInteger(number) || number<0)) return fail(t("字段 {0} 必须是非负整数",[field]));
  }
  if (Number(row.ip_limit)>0 || Number(row.connection_limit)>0) return fail(t("暂不支持 ny 的单规则 IP 数或连接数限制"));
  if (row.tls != null) return fail(t("暂不支持 ny 的 TLS 入站、共享端口或 SNI 子规则"));
  const receive = Number(row.accept_proxy_protocol || 0), send = Number(row.proxy_protocol || 0);
  if (![0,1].includes(receive) || ![0,1,3].includes(send)) return fail(t("暂仅支持关闭 PROXY、TCP PROXY v1 或 TCP PROXY v2；不支持 UDP PROXY"));
  const policy = row.dest_policy ?? "random";
  if (typeof policy !== "string" || !(policy in strategies) || !Object.hasOwn(strategies,policy)) return fail(t("不支持的负载均衡策略：{0}",[String(policy).slice(0,80)]));
  const speed = Number(row.speed_limit || 0);
  if (speed && (speed%125000!==0 || speed/125000>1_000_000)) return fail(t("ny 限速无法精确换算为整数 Mbps"));
  const [first,...rest] = destinations as Array<{targetIp:string;targetPort:number}>;
  const parsed = parseRuleTransferFile({kind:RULE_TRANSFER_FILE_KIND,version:RULE_TRANSFER_FILE_VERSION,rules:[{
    name:row.name ?? t("导入规则"),sourcePort:row.listen_port,...first,
    forwardType:"gost",protocol:"both",isEnabled:false,
    proxyProtocolReceive:receive===1,proxyProtocolSend:send!==0,proxyProtocolVersion:send===3?2:1,
    failoverEnabled:rest.length>0,failoverTargets:rest,failoverStrategy:strategies[policy as keyof typeof strategies],
  }]});
  if (!parsed.ok) return fail(parsed.error);
  return {...parsed.file.rules[0],...(speed ? {rateLimitMbps:speed/125000} : {})};
}

/** Read source exports as data only. No source IDs, credentials or code run. */
export function parseCompatibleRuleTransferText(text: string): CompatibleRuleParseResult {
  if (new TextEncoder().encode(text).byteLength>RULE_TRANSFER_MAX_FILE_SIZE) return {ok:false,error:t("规则文件不能超过 5 MiB")};
  const source = text.replace(/^\uFEFF/,"").trim();
  if (!source) return {ok:false,error:t("文件中没有可导入的规则")};
  if (!/^[\[{"]/.test(source) || /^\[[^\]\r\n]+\]\s*[:：]/.test(source)) {
    const parsed = parseRuleTransferText(source);
    return parsed.ok ? { ok: true, file: { ...parsed.file, importSource: "text" } } : parsed;
  }
  try {
    let raw: unknown;
    try {raw=JSON.parse(source);} catch {
      const lines=source.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
      if (lines.length>RULE_TRANSFER_MAX_IMPORT_COUNT) return {ok:false,error:t("单次最多导入 {0} 条规则",[RULE_TRANSFER_MAX_IMPORT_COUNT])};
      raw=lines.map((line,index)=>{
        try {return JSON.parse(line);} catch {throw new Error(t("ny 第 {0} 行不是有效的 JSON",[index+1]));}
      });
    }
    // A declared native file must still pass the existing strict version and
    // field validation; never reinterpret a broken native file as ny.
    if (raw && typeof raw === "object" && !Array.isArray(raw) && "kind" in raw) return parseRuleTransferFile(raw);
    const rows=Array.isArray(raw)?raw:[raw];
    if (!rows.length) return {ok:false,error:t("文件中没有可导入的规则")};
    if (rows.length>RULE_TRANSFER_MAX_IMPORT_COUNT) return {ok:false,error:t("单次最多导入 {0} 条规则",[RULE_TRANSFER_MAX_IMPORT_COUNT])};
    return {ok:true,file:{kind:RULE_TRANSFER_FILE_KIND,version:RULE_TRANSFER_FILE_VERSION,importSource:"nyanpass",rules:rows.map(convertRule)}};
  } catch (error) {
    return {ok:false,error:error instanceof Error?error.message:t("文件无法解析，请选择 JSON 格式的规则文件")};
  }
}

/** The existing create API intentionally normalizes unsupported settings. For
 * experimental imports reject those combinations before sending any writes. */
export function validateNyanpassImportTarget(rules: RuleTransferFileRule[], options: {
  protocol:ForwardRuleProtocol; scope:string; resource:any; admin:boolean;
}): string | null {
  const {protocol,scope,resource,admin}=options;
  if (!resource) return t("请选择导入目标");
  const direct = scope === "local" && resource.groupMode === "port" && resource.groupType === "host";
  const tool = resource.forwardType;
  const on=(value:unknown)=>value===true || value===1;
  for (let index=0;index<rules.length;index++) {
    const rule=rules[index];
    const fail=(reason:string)=>t("ny 第 {0} 条规则：{1}",[index+1,reason]);
    if (rule.rateLimitMbps && !admin) return fail(t("含限速的 ny 规则需要管理员导入"));
    if (rule.failoverEnabled && !(direct && tool==="gost" && protocol==="tcp")) return fail(t("ny 多目标暂仅支持导入 TCP 的 GOST 普通端口转发资源"));
    const proxy=rule.proxyProtocolReceive || rule.proxyProtocolSend;
    if (proxy && !(direct && ["gost","realm"].includes(tool) && protocol==="tcp")) return fail(t("ny PROXY 配置暂仅支持导入 TCP 的 GOST/Realm 普通端口转发资源"));
    if (on(resource.proxyProtocolReceive)!==rule.proxyProtocolReceive || on(resource.proxyProtocolSend)!==rule.proxyProtocolSend
      || on(resource.proxyProtocolExitReceive) || on(resource.proxyProtocolExitSend)
      || (rule.proxyProtocolSend && Number(resource.proxyProtocolVersion || 1)!==rule.proxyProtocolVersion)) {
      return fail(t("目标资源的 PROXY 设置与 ny 规则不一致，请先核对资源配置；不会自动修改资源"));
    }
  }
  return null;
}

export async function createImportedRule<T>(port:number, preservePort:boolean, create:(sourcePort:number)=>Promise<T>):Promise<T> {
  try {return await create(port);} catch(error) {
    // A migration must not silently change externally published entry ports.
    // Explicit user ports and experimental migrations never silently fall back.
    if (preservePort || port<=0 || !isBatchPortConflictError(error)) throw error;
    return create(0);
  }
}
