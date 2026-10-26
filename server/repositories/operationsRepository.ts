import net from "node:net";
import { executeRaw, queryRaw, getDatabaseKind } from "../dbRuntime";
import { quoteIdentifier as q } from "../dbCompat";
import { getAllSettings } from "./settingsRepository";
import { deleteExpiredHistoryRows } from "./historyRetention";
import { operationsDay, chinaProvince, provinceAliases, OPERATIONS_SOURCE_PAGE_SIZE, type OperationsSourceSort } from "../../shared/operations";
import { resolveOperationsSourceGeo, SOURCE_GEO_VERSION } from "../operationsSourceGeo";
import { writeMysqlTrafficCounters } from "../mysqlTrafficCounters";

export async function sourceAnalyticsEnabled() {
  return (await getAllSettings()).operationsSourceAnalytics === "true";
}

// Called inside the traffic report's existing transaction, after report deduplication.
// Only accepted accounting deltas enter this history, never relay/exit duplicates.
export async function recordOperationsTraffic(items: any[], contexts: Map<number, any>, host: any) {
  const dayStart = operationsDay(Date.now() / 1000);
  const rawRows = items.map(({ stat, userId }) => {
    const context = contexts.get(Number(stat.ruleId));
    const rule = context?.rule;
    const logicalRuleId = Number(rule?.forwardGroupRuleId || stat.ruleId);
    const resourceKey = rule?.forwardGroupId ? `group:${rule.forwardGroupId}` : rule?.tunnelId ? `tunnel:${rule.tunnelId}` : `host:${host.id}`;
    return [dayStart, Number(stat.ruleId), Number(host.id), userId, logicalRuleId, resourceKey,
      String(context?.logicalRuleName || rule?.name || "").trim().slice(0, 255), String(host.name || host.id).slice(0, 255),
      String(context?.group?.name || context?.tunnel?.name || host.name || resourceKey).slice(0, 255),
      Number(stat.bytesIn) || 0, Number(stat.bytesOut) || 0, Number(stat.connections) || 0];
  });
  const merged = new Map<string, any[]>();
  for (const row of rawRows) {
    const key = `${row[1]}:${row[3]}:${row[5]}`;
    const previous = merged.get(key);
    if (previous) { for (const i of [9, 10, 11]) previous[i] += row[i]; }
    else merged.set(key, row);
  }
  await upsertRows("operations_traffic_daily", ["dayStart", "ruleId", "hostId", "userId", "logicalRuleId", "resourceKey", "ruleName", "hostName", "resourceName", "bytesIn", "bytesOut", "connections"], [...merged.values()], ["dayStart", "ruleId", "hostId", "userId", "resourceKey"], ["bytesIn", "bytesOut", "connections"]);
}

async function upsertRows(table: string, columns: string[], rows: any[][], keys: string[], sums: string[]) {
  if (getDatabaseKind() === "mysql") {
    await writeMysqlTrafficCounters({ table, columns, rows, keys, add: sums,
      replace: columns.filter(column => !keys.includes(column) && !sums.includes(column)),
    }, { query: queryRaw, execute: executeRaw });
    return;
  }
  const incoming = (column: string) => `excluded.${q(column)}`;
  const current = (column: string) => getDatabaseKind() === "postgresql" ? `${q(table)}.${q(column)}` : q(column);
  const suffix = ` ON CONFLICT (${keys.map(q).join(",")}) DO UPDATE SET ` +
    columns.filter(column => !keys.includes(column)).map(column => `${q(column)} = ${sums.includes(column) ? `${current(column)} + ` : ""}${incoming(column)}`).join(",");
  for (let offset = 0; offset < rows.length; offset += 50) {
    const batch = rows.slice(offset, offset + 50);
    await executeRaw(`INSERT INTO ${q(table)} (${columns.map(q).join(",")}) VALUES ${batch.map(() => `(${columns.map(() => "?").join(",")})`).join(",")}${suffix}`, batch.flat());
  }
}

export type SourceObservation = { ruleId: number; ip: string; bytesIn: number; bytesOut: number; accounting: boolean };
export function parseSourceObservations(value: unknown): SourceObservation[] {
  if (!Array.isArray(value)) return [];
  const merged = new Map<string, SourceObservation>();
  for (const row of value.slice(0, 1000)) {
    const ip = String(row?.ip || "").replace(/^::ffff:/i, "").toLowerCase();
    if (!net.isIP(ip) || !Number.isSafeInteger(row?.ruleId) || row.ruleId <= 0 ||
      !Number.isSafeInteger(row.bytesIn) || row.bytesIn < 0 || !Number.isSafeInteger(row.bytesOut) || row.bytesOut < 0 || typeof row.accounting !== "boolean") continue;
    const key = `${row.ruleId}:${ip}`, previous = merged.get(key);
    if (previous) {
      previous.bytesIn = Math.min(Number.MAX_SAFE_INTEGER, previous.bytesIn + row.bytesIn);
      previous.bytesOut = Math.min(Number.MAX_SAFE_INTEGER, previous.bytesOut + row.bytesOut);
      previous.accounting &&= row.accounting;
    } else merged.set(key, { ruleId: row.ruleId, ip, bytesIn: row.bytesIn, bytesOut: row.bytesOut, accounting: row.accounting });
  }
  return [...merged.values()];
}

export async function recordOperationsSources(host: any, value: unknown, contexts: Map<number, any>, entryHosts: Map<number, Set<number>>, status: unknown, sampledAt?: unknown) {
  if (!await sourceAnalyticsEnabled()) return;
  const receivedAt = Math.floor(Date.now() / 1000);
  const now = Number(sampledAt);
  if (!Number.isSafeInteger(now) || now < operationsDay(receivedAt) - 29 * 86400 || now > receivedAt + 300) return;
  const dayStart = operationsDay(now);
  let rows = parseSourceObservations(value).filter(row => {
    const rule = contexts.get(row.ruleId)?.rule;
    if (!rule || !rule.isEnabled || rule.pendingDelete || rule.isForwardGroupTemplate) return false;
    // Sources must be observed on a client-facing ingress, not an accounting exit.
    return rule.tunnelId ? entryHosts.get(Number(rule.tunnelId))?.has(Number(host.id)) : Number(rule.hostId) === Number(host.id);
  }).map(row => {
    const rule = contexts.get(row.ruleId).rule;
    return [dayStart, row.ruleId, Number(host.id), row.ip, Number(rule.userId), Number(rule.forwardGroupRuleId || row.ruleId), row.accounting ? row.bytesIn : 0, row.accounting ? row.bytesOut : 0, row.accounting ? 0 : 1, row.accounting ? 1 : 0, now];
  });
  const count = rows.length ? await queryRaw<any>(`SELECT COUNT(*) AS ${q("count")} FROM ${q("operations_source_daily")} WHERE ${q("hostId")} = ? AND ${q("dayStart")} = ?`, [host.id, dayStart]) : [];
  let available = Math.max(0, 5000 - Number(count[0]?.count || 0));
  let capped = false;
  if (rows.length > available) {
    const existingRows = await queryRaw<any>(`SELECT ${q("ruleId")}, ${q("ip")} FROM ${q("operations_source_daily")} WHERE ${q("hostId")} = ? AND ${q("dayStart")} = ? LIMIT 5000`, [host.id, dayStart]);
    const existing = new Set(existingRows.map(row => `${row.ruleId}:${row.ip}`));
    rows = rows.filter(row => {
      if (existing.has(`${row[1]}:${row[3]}`)) return true;
      if (available > 0) { available--; return true; }
      capped = true; return false;
    });
  }
  await upsertRows("operations_source_daily", ["dayStart", "ruleId", "hostId", "ip", "userId", "logicalRuleId", "bytesIn", "bytesOut", "unknownSamples", "knownSamples", "lastSeen"], rows, ["dayStart", "ruleId", "hostId", "ip"], ["bytesIn", "bytesOut", "unknownSamples", "knownSamples"]);
  const allowed = ["sampled", "unavailable", "limited", "disabled", "no_rules"];
  if (typeof status === "string" && allowed.includes(status)) {
    await upsertRows("operations_source_status", ["hostId", "status", "lastSeen"], [[host.id, capped ? "limited" : status, now]], ["hostId"], []);
  }
}

// Scope operational host health to hosts used by this user's current rules or
// observed history, rather than accidentally showing every host in the panel.
function operationsHostScope(start: number, end: number, userId: number) {
  return {
    sql: `SELECT ${q("hostId")} FROM ${q("forward_rules")} WHERE ${q("userId")} = ? UNION SELECT ${q("hostId")} FROM ${q("operations_traffic_daily")} WHERE ${q("userId")} = ? AND ${q("dayStart")} >= ? AND ${q("dayStart")} < ? UNION SELECT ${q("hostId")} FROM ${q("operations_source_daily")} WHERE ${q("userId")} = ? AND ${q("dayStart")} >= ? AND ${q("dayStart")} < ?`,
    params: [userId, userId, start, end, userId, start, end],
  };
}

export async function getOperationsOverview(start: number, end: number, userId?: number) {
  const userWhere = userId === undefined ? "" : ` AND ${q("userId")} = ?`;
  const where = `${q("dayStart")} >= ? AND ${q("dayStart")} < ?${userWhere}`, params = userId === undefined ? [start, end] : [start, end, userId];
  const hostScope = userId === undefined ? null : operationsHostScope(start, end, userId);
  const groupKey = getDatabaseKind() === "mysql" ? `CONCAT('group:', e.${q("groupId")})` : `('group:' || CAST(e.${q("groupId")} AS TEXT))`;
  const eventScope = userId === undefined ? "" : ` AND (EXISTS (SELECT 1 FROM ${q("forward_rules")} r WHERE r.${q("forwardGroupId")} = e.${q("groupId")} AND r.${q("userId")} = ?) OR EXISTS (SELECT 1 FROM ${q("operations_traffic_daily")} d WHERE d.${q("resourceKey")} = ${groupKey} AND d.${q("userId")} = ? AND d.${q("dayStart")} >= ? AND d.${q("dayStart")} < ?))`;
  const sums = `SUM(${q("bytesIn")}) AS ${q("bytesIn")}, SUM(${q("bytesOut")}) AS ${q("bytesOut")}, SUM(${q("connections")}) AS ${q("connections")}`;
  const ranks = async (id: string, name: string) => queryRaw<any>(`SELECT ${q(id)} AS ${q("id")}, MAX(${q(name)}) AS ${q("name")}, ${sums} FROM ${q("operations_traffic_daily")} WHERE ${where} GROUP BY ${q(id)} ORDER BY SUM(${q("bytesIn")} + ${q("bytesOut")}) DESC LIMIT 20`, params);
  const [trend, rules, hosts, resources, users, current, coverage, events, availability] = await Promise.all([
    queryRaw<any>(`SELECT ${q("dayStart")}, ${sums} FROM ${q("operations_traffic_daily")} WHERE ${where} GROUP BY ${q("dayStart")} ORDER BY ${q("dayStart")}`, params),
    // Older traffic contexts omitted names, storing physical IDs as names.
    queryRaw<any>(`SELECT ${q("logicalRuleId")} AS ${q("id")}, MAX(CASE WHEN TRIM(${q("ruleName")}) = CAST(${q("ruleId")} AS ${getDatabaseKind() === "mysql" ? "CHAR" : "TEXT"}) THEN '' ELSE ${q("ruleName")} END) AS ${q("name")}, ${sums} FROM ${q("operations_traffic_daily")} WHERE ${where} GROUP BY ${q("logicalRuleId")} ORDER BY SUM(${q("bytesIn")} + ${q("bytesOut")}) DESC LIMIT 20`, params), ranks("hostId", "hostName"), ranks("resourceKey", "resourceName"),
    queryRaw<any>(`SELECT d.${q("userId")} AS ${q("id")}, MAX(u.${q("username")}) AS ${q("name")}, SUM(d.${q("bytesIn")}) AS ${q("bytesIn")}, SUM(d.${q("bytesOut")}) AS ${q("bytesOut")} FROM ${q("operations_traffic_daily")} d LEFT JOIN ${q("users")} u ON u.${q("id")} = d.${q("userId")} WHERE d.${q("dayStart")} >= ? AND d.${q("dayStart")} < ?${userId === undefined ? "" : ` AND d.${q("userId")} = ?`} GROUP BY d.${q("userId")} ORDER BY SUM(d.${q("bytesIn")} + d.${q("bytesOut")} ) DESC LIMIT 20`, params),
    queryRaw<any>(`SELECT ${q("isOnline")}, COUNT(*) AS ${q("count")} FROM ${q("hosts")}${hostScope ? ` WHERE ${q("id")} IN (${hostScope.sql})` : ""} GROUP BY ${q("isOnline")}`, hostScope?.params || []),
    queryRaw<any>(`SELECT MIN(${q("dayStart")}) AS ${q("since")} FROM ${q("operations_traffic_daily")}${userId === undefined ? "" : ` WHERE ${q("userId")} = ?`}`, userId === undefined ? [] : [userId]),
    queryRaw<any>(`SELECT e.${q("id")}, e.${q("groupId")}, e.${q("type")}, e.${q("message")}, e.${q("createdAt")} FROM ${q("forward_group_events")} e WHERE e.${q("createdAt")} >= ? AND e.${q("createdAt")} < ?${eventScope} ORDER BY e.${q("createdAt")} DESC LIMIT 50`, userId === undefined ? [start, end] : [start, end, userId, userId, start, end]),
    queryRaw<any>(`SELECT a.${q("hostId")}, MAX(h.${q("name")}) AS ${q("name")}, SUM(CASE WHEN a.${q("offlineIncident")} = 1 AND a.${q("startAt")} >= ? THEN 1 ELSE 0 END) AS ${q("incidents")}, SUM(CASE WHEN a.${q("online")} = 0 THEN (CASE WHEN a.${q("endAt")} < ? THEN a.${q("endAt")} ELSE ? END) - (CASE WHEN a.${q("startAt")} > ? THEN a.${q("startAt")} ELSE ? END) ELSE 0 END) AS ${q("offlineSeconds")} FROM ${q("host_availability_intervals")} a LEFT JOIN ${q("hosts")} h ON h.${q("id")} = a.${q("hostId")} WHERE a.${q("endAt")} > ? AND a.${q("startAt")} < ?${hostScope ? ` AND a.${q("hostId")} IN (${hostScope.sql})` : ""} GROUP BY a.${q("hostId")} ORDER BY ${q("offlineSeconds")} DESC LIMIT 20`, [start, end, end, start, start, start, end, ...(hostScope?.params || [])]),
  ]);
  // Resolve at most 20 logical rule names, not a join over the full history.
  // Keep stored names for deleted rules and do not rewrite historical traffic.
  if (rules.length) {
    const names = await queryRaw<any>(`SELECT ${q("id")}, ${q("name")} FROM ${q("forward_rules")} WHERE ${q("id")} IN (${rules.map(() => "?").join(",")})${userId === undefined ? "" : ` AND ${q("userId")} = ?`}`, [...rules.map(row => row.id), ...(userId === undefined ? [] : [userId])]);
    const byId = new Map(names.map(row => [Number(row.id), String(row.name || "").trim()]));
    for (const rule of rules) rule.name = byId.get(Number(rule.id)) || rule.name || "";
  }
  return { trend, rules, hosts, resources, users, current, since: coverage[0]?.since ?? null, events, availability };
}

export async function getOperationsSourceDetails(start: number, end: number, ip: string, userId?: number) {
  return queryRaw<any>(`SELECT s.${q("logicalRuleId")} AS ${q("ruleId")}, s.${q("hostId")}, MAX(r.${q("name")}) AS ${q("ruleName")}, MAX(h.${q("name")}) AS ${q("hostName")}, MAX(u.${q("username")}) AS ${q("username")}, SUM(s.${q("bytesIn")}) AS ${q("bytesIn")}, SUM(s.${q("bytesOut")}) AS ${q("bytesOut")}, SUM(s.${q("unknownSamples")}) AS ${q("unknownSamples")}, SUM(s.${q("knownSamples")}) AS ${q("knownSamples")}, MAX(s.${q("lastSeen")}) AS ${q("lastSeen")} FROM ${q("operations_source_daily")} s LEFT JOIN ${q("forward_rules")} r ON r.${q("id")} = s.${q("logicalRuleId")} LEFT JOIN ${q("hosts")} h ON h.${q("id")} = s.${q("hostId")} LEFT JOIN ${q("users")} u ON u.${q("id")} = s.${q("userId")} WHERE s.${q("dayStart")} >= ? AND s.${q("dayStart")} < ? AND s.${q("ip")} = ?${userId === undefined ? "" : ` AND s.${q("userId")} = ?`} GROUP BY s.${q("logicalRuleId")}, s.${q("hostId")} ORDER BY SUM(s.${q("bytesIn")} + s.${q("bytesOut")}) DESC LIMIT 100`, userId === undefined ? [start, end, ip] : [start, end, ip, userId]);
}

function sourceGeoColumns() {
  return {code:`COALESCE(NULLIF(l.${q("countryCode")}, 'ZZ'), g.${q("geoCountryCode")})`,region:`COALESCE(l.${q("region")}, g.${q("geoRegion")})`};
}
function sourceGeoJoin(ip: string) {
  return `LEFT JOIN ${q("operations_ip_geo")} l ON l.${q("address")} = ${ip} AND l.${q("expiresAt")} > ? AND l.${q("datasetVersion")} = ? LEFT JOIN ${q("ip_geo_cache")} g ON g.${q("address")} = ${ip} AND g.${q("expiresAt")} > ?`;
}
function geoParams() { const now = Math.floor(Date.now()/1000); return [now,SOURCE_GEO_VERSION,now]; }

export async function getOperationsProvinceDetails(start: number, end: number, province: string, userId?: number, search = "") {
  const {code:geoCode,region:geoRegion} = sourceGeoColumns();
  const aliases = provinceAliases(province);
  if (!aliases.length) return { ips: [], totals: null };
  const specialCode: Record<string,string> = {香港:"HK",澳门:"MO",台湾:"TW"};
  const regionMatch = aliases.map(() => `LOWER(${geoRegion}) LIKE ?`).join(" OR ");
  const special = specialCode[province];
  const conditions = [`s.${q("dayStart")} >= ?`, `s.${q("dayStart")} < ?`, `(${geoCode} = 'CN' AND (${regionMatch})${special ? ` OR ${geoCode} = ?` : ""})`];
  const params: any[] = [...geoParams(),start,end,...aliases.map(alias=>`${alias.toLowerCase()}%`),...(special ? [special] : [])];
  if (userId !== undefined) { conditions.push(`s.${q("userId")} = ?`); params.push(userId); }
  if (search) { conditions.push(`s.${q("ip")} LIKE ?`); params.push(`%${search.replace(/[%_\\]/g, "")}%`); }
  const from = `FROM ${q("operations_source_daily")} s ${sourceGeoJoin(`s.${q("ip")}`)} WHERE ${conditions.join(" AND ")}`;
  const sums = `SUM(s.${q("bytesIn")}) AS ${q("bytesIn")}, SUM(s.${q("bytesOut")}) AS ${q("bytesOut")}, SUM(s.${q("knownSamples")}) AS ${q("knownSamples")}, SUM(s.${q("unknownSamples")}) AS ${q("unknownSamples")}, COUNT(DISTINCT s.${q("logicalRuleId")}) AS ${q("rules")}, COUNT(DISTINCT s.${q("hostId")}) AS ${q("hosts")}, MAX(s.${q("lastSeen")}) AS ${q("lastSeen")}`;
  const [ips,totals] = await Promise.all([
    queryRaw<any>(`SELECT s.${q("ip")}, ${sums}, MAX(l.${q("city")}) AS ${q("city")}, MAX(l.${q("isp")}) AS ${q("isp")} ${from} GROUP BY s.${q("ip")} ORDER BY CASE WHEN SUM(s.${q("knownSamples")}) = 0 THEN 1 ELSE 0 END, SUM(s.${q("bytesIn")} + s.${q("bytesOut")}) DESC, s.${q("ip")} LIMIT 5`,params),
    queryRaw<any>(`SELECT COUNT(DISTINCT s.${q("ip")}) AS ${q("ips")}, ${sums} ${from}`,params),
  ]);
  return {ips,totals:totals[0]};
}

export async function getOperationsSources(start: number, end: number, page: number, search: string, userId?: number, sort: OperationsSourceSort = "traffic") {
  const {code:geoCode,region:geoRegion} = sourceGeoColumns();
  const location = await resolveOperationsSourceGeo(start,end,userId,"",256,search);
  const params: any[] = [start, end], conditions = [`s.${q("dayStart")} >= ? AND s.${q("dayStart")} < ?`];
  if (userId !== undefined) { conditions.push(`s.${q("userId")} = ?`); params.push(userId); }
  if (search) { conditions.push(`s.${q("ip")} LIKE ?`); params.push(`%${search.replace(/[%_\\]/g, "")}%`); }
  const where = conditions.join(" AND ");
  // Aggregate before joining geo cache, so multiple cache aliases cannot multiply traffic.
  const aggregate = `SELECT s.${q("ip")}, SUM(s.${q("bytesIn")}) AS ${q("bytesIn")}, SUM(s.${q("bytesOut")}) AS ${q("bytesOut")}, SUM(s.${q("unknownSamples")}) AS ${q("unknownSamples")}, SUM(s.${q("knownSamples")}) AS ${q("knownSamples")}, COUNT(DISTINCT s.${q("logicalRuleId")}) AS ${q("rules")}, MAX(s.${q("lastSeen")}) AS ${q("lastSeen")} FROM ${q("operations_source_daily")} s WHERE ${where} GROUP BY s.${q("ip")}`;
  const trafficOrder = `CASE WHEN SUM(s.${q("knownSamples")}) = 0 THEN 1 ELSE 0 END, SUM(s.${q("bytesIn")} + s.${q("bytesOut")}) DESC`;
  const order = sort === "rules" ? `COUNT(DISTINCT s.${q("logicalRuleId")}) DESC, ${trafficOrder}` : sort === "recent" ? `MAX(s.${q("lastSeen")}) DESC` : trafficOrder;
  const offset = Math.max(0, Math.min(10000, Math.trunc(page) || 0)) * OPERATIONS_SOURCE_PAGE_SIZE;
  const hostScope = userId === undefined ? null : operationsHostScope(start, end, userId);
  const [ips, totals, geo, statuses, enabled, foreignIps] = await Promise.all([
    queryRaw<any>(`${aggregate} ORDER BY ${order}, s.${q("ip")} LIMIT ${OPERATIONS_SOURCE_PAGE_SIZE} OFFSET ${offset}`, params),
    queryRaw<any>(`SELECT COUNT(DISTINCT s.${q("ip")} ) AS ${q("ips")}, SUM(s.${q("bytesIn")}) AS ${q("bytesIn")}, SUM(s.${q("bytesOut")}) AS ${q("bytesOut")} FROM ${q("operations_source_daily")} s WHERE ${where}`, params),
    queryRaw<any>(`SELECT ${geoCode} AS ${q("geoCountryCode")}, ${geoRegion} AS ${q("geoRegion")}, COUNT(*) AS ${q("ips")}, SUM(a.${q("bytesIn")}) AS ${q("bytesIn")}, SUM(a.${q("bytesOut")}) AS ${q("bytesOut")}, SUM(a.${q("unknownSamples")}) AS ${q("unknownSamples")}, SUM(a.${q("knownSamples")}) AS ${q("knownSamples")} FROM (${aggregate}) a ${sourceGeoJoin(`a.${q("ip")}`)} GROUP BY ${geoCode}, ${geoRegion}`, [...params,...geoParams()]),
    queryRaw<any>(`SELECT s.${q("hostId")}, h.${q("name")}, s.${q("status")}, s.${q("lastSeen")} FROM ${q("operations_source_status")} s LEFT JOIN ${q("hosts")} h ON h.${q("id")} = s.${q("hostId")}${hostScope ? ` WHERE s.${q("hostId")} IN (${hostScope.sql})` : ""} ORDER BY s.${q("hostId")}`, hostScope?.params || []),
    sourceAnalyticsEnabled(),
    queryRaw<any>(`SELECT a.*, ${geoCode} AS ${q("countryCode")} FROM (${aggregate}) a ${sourceGeoJoin(`a.${q("ip")}`)} WHERE ${geoCode} NOT IN ('CN','HK','MO','TW','ZZ','') ORDER BY CASE WHEN a.${q("knownSamples")} = 0 THEN 1 ELSE 0 END, a.${q("bytesIn")} + a.${q("bytesOut")} DESC, a.${q("ip")} LIMIT 3`,[...params,...geoParams()]),
  ]);
  const provinces = new Map<string, { name: string; ips: number; bytesIn: number; bytesOut: number; unknownSamples: number; knownSamples: number }>();
  let unmappedIps = 0;
  let foreignCount = 0, unknownIps = 0;
  const countries = new Map<string,{countryCode:string;ips:number;bytesIn:number;bytesOut:number;knownSamples:number;unknownSamples:number}>();
  for (const row of geo) {
    const name = chinaProvince(row.geoCountryCode, row.geoRegion);
    if (!name) {
      unmappedIps += Number(row.ips);
      const code = String(row.geoCountryCode || "");
      if (/^[A-Z]{2}$/.test(code) && !["CN","HK","MO","TW","ZZ"].includes(code)) {
        foreignCount += Number(row.ips);
        const item = countries.get(code) || {countryCode:code,ips:0,bytesIn:0,bytesOut:0,knownSamples:0,unknownSamples:0};
        for (const key of ["ips","bytesIn","bytesOut","knownSamples","unknownSamples"] as const) item[key] += Number(row[key]) || 0;
        countries.set(code,item);
      } else unknownIps += Number(row.ips);
      continue;
    }
    const item = provinces.get(name) || { name, ips: 0, bytesIn: 0, bytesOut: 0, unknownSamples: 0, knownSamples: 0 };
    for (const key of ["ips", "bytesIn", "bytesOut", "unknownSamples", "knownSamples"] as const) item[key] += Number(row[key]) || 0;
    provinces.set(name, item);
  }
  return { ips, totals: totals[0], provinces: [...provinces.values()], unmappedIps, statuses, enabled, foreignIps, foreignCount, unknownIps, countries:[...countries.values()].sort((a,b)=>b.bytesIn+b.bytesOut-a.bytesIn-a.bytesOut).slice(0,5), location };
}

export async function cleanOperationsHistory() {
  const cutoff = operationsDay(Date.now() / 1000) - 29 * 86400;
  await deleteExpiredHistoryRows("operations_traffic_daily", "dayStart", cutoff);
  await deleteExpiredHistoryRows("operations_source_daily", "dayStart", cutoff);
  await deleteExpiredHistoryRows("operations_source_status", "lastSeen", cutoff);
  await deleteExpiredHistoryRows("operations_ip_geo", "expiresAt", Math.floor(Date.now()/1000));
}
