/** Fast path for unambiguous read requests; never handles requests containing writes. */
export function preciseQuery(text: string): { intent: "panel_query"; tool: "users.summary" | "traffic.rank"; input: Record<string, unknown> } | null {
  const value = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (/(删除|修改|设置|充值|关闭|开启|禁用|启用|增加|添加|创建|重置|续费|续期|delete|update|create|disable|enable|reset)/i.test(value)) return null;
  if (/(用户|账户|账号|users?|accounts?)/i.test(value) && /(几个|多少|数量|总数|how many|count)/i.test(value) && !/(流量|余额|规则|主机|隧道|在线|登录)/.test(value)) {
    const rest = value.replace(/当前|现在|目前|总共|一共|共有|有|几个|多少|数量|总数|个|位|用户|账户|账号|管理员|普通|停用|到期|过期|的|帮我|请|给我|查询|查看|一下|[\s，。？！?,!]/g, "");
    if (rest) return null;
    return { intent: "panel_query" as const, tool: "users.summary" as const, input: {
      ...( /(停用|禁用)/.test(value) ? { status: "disabled" } : /(到期|过期)/.test(value) ? { status: "expired" } : {}),
      ...( /(管理员)/.test(value) ? { role: "admin" } : /(普通用户)/.test(value) ? { role: "user" } : {}),
    } };
  }
  if (!/(流量|traffic)/i.test(value) || !/(排行|排名|前三|前\s*[\d一二两三四五六七八九十]+|top|最多|最少)/i.test(value)) return null;
  const count = value.match(/(?:前|top\s*)(\d+|[一二两三四五六七八九十]+)/i)?.[1];
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const limit = count ? Number(count) || digits[count] : 3;
  // Do not silently strip user names, custom dates or an unsupported N from a query.
  if (!limit || limit > 30 || /(用户|主机|规则|隧道)\s*[#\d]|\d{4}[-年]|名为|叫做/.test(value)) return null;
  const residue = value.replace(/(?:前|top\s*)(\d+|[一二两三四五六七八九十]+)/gi, "").replace(/最近\s*(7|30)\s*天/g, "")
    .replace(/帮我|请|给我|查一下|查询|查看|看看|看下|列出|显示|一下|当前|现在|目前|今天|今日|昨天|昨日|最近|本日|我的|全部|所有|用户|账户|账号|主机|服务器|规则|转发|资源|流量|排行|排名|最多|最少|上行|下行|入向|出向|的|个|名|条|是多少|哪些|有|[\s，。？！?,!]/g, "");
  if (residue) return null;
  return { intent: "panel_query" as const, tool: "traffic.rank" as const, input: {
    entity: /主机|服务器/.test(value) ? "hosts" : /规则|转发/.test(value) ? "rules" : /资源/.test(value) ? "resources" : "users",
    period: /昨天|昨日/.test(value) ? "yesterday" : /30\s*天/.test(value) ? "30d" : /7\s*天/.test(value) ? "7d" : "today",
    direction: /上行|入向/.test(value) ? "in" : /下行|出向/.test(value) ? "out" : "total", order: /最少/.test(value) ? "asc" : "desc", limit,
    ...( /我的/.test(value) ? { scope: "self" } : {}),
  } };
}
