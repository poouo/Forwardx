export type BotChoice = { label: string; input: Record<string, unknown> };
export type BotChoicePrompt = { question: string; field: string; choices: BotChoice[]; page: number; pages: number };
export type RuleRouteChoice = { id: number; name: string; type: "tunnel" | "group"; groupMode?: string };

/** Only an unambiguous, single creation request can bypass model planning. */
export function simpleRuleCreateRequest(text: string): Record<string, unknown> | null {
  const match = text.trim().match(/^(?:(?:请|帮我|麻烦|请帮我)\s*)?(?:添加|新增|创建|增加|add|create)\s*(?:一个|一条|a\s+)?(?:端口)?(?:转发规则|转发|forward(?:ing)?\s+rule)\s*(?:(?:到|目标|to\s*|target\s*[:：]?)\s*)*(\[[a-f\d:]+\]|[a-z\d][a-z\d.-]*)[:：](\d{1,5})[。.!！]?$/i);
  if (!match) return null;
  const targetPort = Number(match[2]);
  if (targetPort < 1 || targetPort > 65535) return null;
  return { targetIp: match[1].replace(/^\[|\]$/g, ""), targetPort };
}

export function ruleCreatePrompt(input: Record<string, unknown>, routes: RuleRouteChoice[], requestedPage = 0): BotChoicePrompt | null {
  if (!input.targetIp || !input.targetPort) return { question: "请补充目标地址和端口，例如 10.10.10.10:22。", field: "target", choices: [], page: 0, pages: 1 };
  if (!input.tunnelId && !input.forwardGroupId) {
    const pageSize = 8;
    const pages = Math.max(1, Math.ceil(routes.length / pageSize));
    const page = Math.max(0, Math.min(pages - 1, Math.floor(requestedPage) || 0));
    return { question: routes.length ? "请选择要添加到哪个隧道或端口转发链；也可以输入链路名称或 ID。" : "当前没有可用的隧道或端口转发链，请先创建资源或联系管理员授权，然后发送“继续”。",
      field: "route", page, pages, choices: routes.slice(page * pageSize, (page + 1) * pageSize).map(route => ({
        label: `${route.type === "tunnel" ? "🔗 隧道" : route.groupMode === "chain" ? "🔀 转发链" : route.groupMode === "port" ? "🖥 端口转发" : "🔁 转发组"} #${route.id} ${Array.from(route.name).slice(0, 24).join("").replace(/[\r\n\t]/g, " ")}`,
        input: route.type === "tunnel" ? { tunnelId: route.id, forwardGroupId: null } : { forwardGroupId: route.id, tunnelId: null },
      })) };
  }
  if (input.sourcePort === undefined) return { question: "入口监听端口使用哪个？点击随机分配，或直接输入 1–65535 的端口号。", field: "sourcePort", page: 0, pages: 1,
    choices: [{ label: "🎲 随机分配可用端口", input: { sourcePort: 0 } }] };
  if (input.protocol === undefined) return { question: "请选择需要转发的协议。", field: "protocol", page: 0, pages: 1,
    choices: ["tcp", "udp", "both"].map(protocol => ({ label: protocol === "both" ? "TCP + UDP" : protocol.toUpperCase(), input: { protocol } })) };
  return null;
}

/** Local supplements never change the operation or replace already known fields implicitly. */
export function ruleCreateTextPatch(text: string, field: string): Record<string, unknown> | null {
  const raw = text.trim();
  if (field === "target") return simpleRuleCreateRequest(`添加转发规则到${raw}`);
  if (field === "route") {
    const match = raw.match(/^(隧道|tunnel|端口转发|转发链|转发组|group)\s*#?(\d+)$/i);
    const id = Number(match?.[2]);
    if (match && Number.isSafeInteger(id) && id > 0) return /^(隧道|tunnel)$/i.test(match[1]) ? { tunnelId: id, forwardGroupId: null } : { forwardGroupId: id, tunnelId: null };
  }
  if (field === "sourcePort") {
    if (/^(随机(?:分配)?(?:端口)?|random(?:\s+port)?|0)$/i.test(raw)) return { sourcePort: 0 };
    const match = raw.match(/^(?:(?:入口|监听|源)?端口\s*[:：]?\s*)?(\d{1,5})$/);
    const port = Number(match?.[1]);
    if (port > 0 && port <= 65535) return { sourcePort: port };
  }
  if (field === "protocol") {
    const protocol = raw.toLowerCase().replace(/\s/g, "");
    if (protocol === "tcp" || protocol === "udp") return { protocol };
    if (["both", "tcp+udp", "tcp/udp", "双协议", "全部"].includes(protocol)) return { protocol: "both" };
  }
  return null;
}
