import { z } from "zod";
import { queryRaw } from "../dbRuntime";
import { quoteIdentifier as q, boolLiteral } from "../dbCompat";
import { operationsDate, operationsRange } from "../../shared/operations";

export const userQuerySchema = z.object({
  keyword: z.string().trim().max(120).optional(),
  role: z.enum(["admin", "user"]).optional(),
  status: z.enum(["all", "enabled", "disabled", "expired"]).default("all"),
  limit: z.number().int().min(1).max(30).default(10),
  offset: z.number().int().min(0).max(100000).default(0),
}).strict();
export const trafficQuerySchema = z.object({
  entity: z.enum(["users", "rules", "hosts", "resources"]).default("users"),
  period: z.enum(["today", "yesterday", "7d", "30d", "custom"]).default("today"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  userId: z.number().int().positive().optional(),
  scope: z.enum(["self", "visible"]).default("visible"),
  direction: z.enum(["total", "in", "out"]).default("total"),
  order: z.enum(["desc", "asc"]).default("desc"),
  limit: z.number().int().min(1).max(30).default(3),
}).strict();

export async function queryUsers(input: z.input<typeof userQuerySchema>, summaryOnly = false) {
  const args = userQuerySchema.parse(input);
  const conditions: string[] = [], params: unknown[] = [];
  if (args.keyword) {
    const keyword = `%${args.keyword.replace(/[%_\\]/g, "")}%`;
    conditions.push(`(${q("username")} LIKE ? OR ${q("name")} LIKE ? OR ${q("displayRemark")} LIKE ?)`);
    params.push(keyword, keyword, keyword);
  }
  if (args.role) { conditions.push(`${q("role")} = ?`); params.push(args.role); }
  if (args.status === "enabled" || args.status === "disabled") conditions.push(`${q("accountEnabled")} = ${boolLiteral(args.status === "enabled")}`);
  const now = Math.floor(Date.now() / 1000);
  if (args.status === "expired") { conditions.push(`${q("expiresAt")} IS NOT NULL AND ${q("expiresAt")} <= ?`); params.push(now); }
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const [summary] = await queryRaw<any>(`SELECT COUNT(*) AS ${q("total")}, SUM(CASE WHEN ${q("accountEnabled")} = ${boolLiteral(true)} THEN 1 ELSE 0 END) AS ${q("enabled")}, SUM(CASE WHEN ${q("role")} = 'admin' THEN 1 ELSE 0 END) AS ${q("admins")}, SUM(CASE WHEN ${q("expiresAt")} IS NOT NULL AND ${q("expiresAt")} <= ? THEN 1 ELSE 0 END) AS ${q("expired")} FROM ${q("users")}${where}`, [now, ...params]);
  const total = Number(summary?.total || 0), enabled = Number(summary?.enabled || 0), admins = Number(summary?.admins || 0);
  const result = { total, enabled, disabled: total - enabled, admins, users: total - admins, expired: Number(summary?.expired || 0), sampledAt: new Date().toISOString() };
  if (summaryOnly) return result;
  const items = await queryRaw<any>(`SELECT ${["id", "username", "name", "displayRemark", "role", "accountEnabled", "expiresAt"].map(q).join(",")} FROM ${q("users")}${where} ORDER BY ${q("id")} ASC LIMIT ${args.limit} OFFSET ${args.offset}`, params);
  return { ...result, offset: args.offset, hasMore: args.offset + items.length < total, items };
}

export function trafficRange(args: z.infer<typeof trafficQuerySchema>, now = Date.now()) {
  if (args.period !== "custom" && (args.from || args.to)) throw new Error("指定日期时必须选择自定义日期范围");
  let from = operationsDate(now / 1000), to = from;
  if (args.period === "custom") {
    if (!args.from || !args.to) throw new Error("自定义排行必须提供开始和结束日期");
    from = args.from; to = args.to;
  } else if (args.period === "yesterday") from = to = operationsDate(now / 1000 - 86400);
  else if (args.period === "7d" || args.period === "30d") from = operationsDate(now / 1000 - (args.period === "7d" ? 6 : 29) * 86400);
  return { ...operationsRange(from, to, now / 1000), from, to };
}

/** Aggregate on the server, before LIMIT; never ask the model to count a truncated list. */
export async function queryTraffic(actor: { id: number; role: string }, input: z.input<typeof trafficQuerySchema>) {
  const args = trafficQuerySchema.parse(input), range = trafficRange(args);
  if (actor.role !== "admin" && args.userId && args.userId !== actor.id) throw new Error("无权查看其他用户的流量");
  const userId = actor.role === "admin" && args.scope !== "self" ? args.userId : actor.id;
  const params: unknown[] = [range.start, range.end];
  const where = `d.${q("dayStart")} >= ? AND d.${q("dayStart")} < ?${userId ? ` AND d.${q("userId")} = ?` : ""}`;
  if (userId) params.push(userId);
  const key = { users: "userId", rules: "logicalRuleId", hosts: "hostId", resources: "resourceKey" }[args.entity];
  const label = args.entity === "users" ? `MAX(COALESCE(NULLIF(u.${q("displayRemark")},''),u.${q("username")}))` : `MAX(d.${q({ rules: "ruleName", hosts: "hostName", resources: "resourceName" }[args.entity])})`;
  const bytesIn = `COALESCE(SUM(d.${q("bytesIn")}),0)`, bytesOut = `COALESCE(SUM(d.${q("bytesOut")}),0)`;
  const order = args.direction === "in" ? bytesIn : args.direction === "out" ? bytesOut : `(${bytesIn} + ${bytesOut})`;
  const from = `FROM ${q("operations_traffic_daily")} d${args.entity === "users" ? ` LEFT JOIN ${q("users")} u ON u.${q("id")} = d.${q("userId")}` : ""} WHERE ${where}`;
  const [items, totals, coverage] = await Promise.all([
    queryRaw<any>(`SELECT d.${q(key)} AS ${q("id")}, ${label} AS ${q("name")}, ${bytesIn} AS ${q("bytesIn")}, ${bytesOut} AS ${q("bytesOut")} ${from} GROUP BY d.${q(key)} ORDER BY ${order} ${args.order === "asc" ? "ASC" : "DESC"}, d.${q(key)} ASC LIMIT ${args.limit}`, params),
    queryRaw<any>(`SELECT COUNT(DISTINCT d.${q(key)}) AS ${q("total")}, ${bytesIn} AS ${q("bytesIn")}, ${bytesOut} AS ${q("bytesOut")} ${from}`, params),
    queryRaw<any>(`SELECT MIN(${q("dayStart")}) AS ${q("since")} FROM ${q("operations_traffic_daily")}${userId ? ` WHERE ${q("userId")} = ?` : ""}`, userId ? [userId] : []),
  ]);
  return { entity: args.entity, from: range.from, to: range.to, timezone: "Asia/Shanghai", direction: args.direction, order: args.order,
    total: Number(totals[0]?.total || 0), bytesIn: Number(totals[0]?.bytesIn || 0), bytesOut: Number(totals[0]?.bytesOut || 0),
    coverageSince: coverage[0]?.since ? new Date(Number(coverage[0].since) * 1000).toISOString() : null,
    note: "实际采集流量（字节），不含计费倍率；仅统计已保留的日汇总，不代表账户累计用量。", sampledAt: new Date().toISOString(),
    items: items.map(row => ({ ...row, name: row.name || `#${row.id}`, bytesIn: Number(row.bytesIn), bytesOut: Number(row.bytesOut), totalBytes: Number(row.bytesIn) + Number(row.bytesOut) })) };
}
