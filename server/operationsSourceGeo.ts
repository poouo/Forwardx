import net from "node:net";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { Header, IPv4, IPv6, newWithBuffer, type Searcher } from "ip2region.js";
import { chinaProvince } from "../shared/operations";
import { executeRaw, queryRaw, getDatabaseKind } from "./dbRuntime";
import { quoteIdentifier as q } from "./dbCompat";

export const SOURCE_GEO_VERSION = "1bf6cabfb63c1a14";
const assets = {
  4: { bytes: 11122642, hash: "27ecba8c9a6d5e3b280aedbe7ee15c65372b179fbd0dad3845d8c608f2fcace1" },
  6: { bytes: 37277813, hash: "939f6b46bd2b8bec3cf7c5ceb8ba782266ae9b1f35b5ba7916700dec0b7506ed" },
};
const decompress = promisify(gunzip);
const searchers = new Map<number, Promise<Searcher>>();
const blocked = new net.BlockList();
for (const [ip, bits] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const) blocked.addSubnet(ip,bits,"ipv4");
blocked.addSubnet("2001:db8::",32,"ipv6");
const globalV6 = new net.BlockList();
globalV6.addSubnet("2000::",3,"ipv6");
export function sourceGeoPublicAddress(address: string) {
  const ip = address.replace(/^::ffff:/i, "").toLowerCase(), family = net.isIP(ip);
  return family === 4 ? !blocked.check(ip,"ipv4") : family === 6 && globalV6.check(ip,"ipv6") && !blocked.check(ip,"ipv6");
}

async function loadSearcher(family: 4 | 6) {
  if (!searchers.has(family)) searchers.set(family, (async () => {
    const directory = process.env.FORWARDX_SOURCE_GEO_DIR || path.resolve(process.cwd(), process.env.NODE_ENV === "production" ? "dist/geo" : "server/assets/ip2region");
    const content = await decompress(await readFile(path.join(directory, `ip2region_v${family}.xdb.gz`)), { maxOutputLength: assets[family].bytes });
    if (content.length !== assets[family].bytes || createHash("sha256").update(content).digest("hex") !== assets[family].hash) throw new Error("source geo data integrity check failed");
    const header = new Header(content.subarray(0,256));
    if (header.version !== 3 || header.ipVersion !== family || header.runtimePtrBytes !== 4 || header.endIndexPtr >= content.length) throw new Error("unsupported source geo data format");
    console.info(`[OperationsGeo] offline IPv${family} database ready version=${SOURCE_GEO_VERSION}`);
    return newWithBuffer(family === 4 ? IPv4 : IPv6, content);
  })());
  return searchers.get(family)!;
}

export type SourceGeo = { countryCode: string; countryName: string | null; region: string | null; city: string | null; isp: string | null };
export function parseSourceGeo(region: string): SourceGeo | null {
  const parts = region.split("|");
  const code = parts[4]?.trim().toUpperCase();
  if (!code || !/^[A-Z]{2}$/.test(code) || code === "ZZ") return null;
  const text = (index: number) => parts[index] && parts[index] !== "0" ? parts[index].trim().slice(0,128) : null;
  return { countryCode: code, countryName: text(0), region: chinaProvince(code,text(1) || "") || text(1), city: text(2), isp: text(3) };
}
export async function lookupOperationsSourceGeo(address: string) {
  const ip = address.replace(/^::ffff:/i, "").toLowerCase();
  if (!sourceGeoPublicAddress(ip)) return null;
  const searcher = await loadSearcher(net.isIP(ip) as 4 | 6);
  return parseSourceGeo(await searcher.search(ip));
}

let lastWarning = 0;
// Bounded, lazy backfill on dashboard requests, never on Agent heartbeat. Cache
// is separate from hostGeo so routine host/visitor API lookups are unchanged.
export async function resolveOperationsSourceGeo(start: number, end: number, userId?: number, after = "", limit = 256, search = "") {
  const batchSize = Math.max(1, Math.min(512, Math.trunc(limit) || 256));
  const now = Math.floor(Date.now()/1000);
  const conditions = [`s.${q("dayStart")} >= ?`, `s.${q("dayStart")} < ?`, `s.${q("ip")} > ?`, `l.${q("address")} IS NULL`, `g.${q("address")} IS NULL`];
  const params: any[] = [now,SOURCE_GEO_VERSION,now,start,end,after];
  if (userId !== undefined) { conditions.push(`s.${q("userId")} = ?`); params.push(userId); }
  if (search) { conditions.push(`s.${q("ip")} LIKE ?`); params.push(`%${search.replace(/[%_\\]/g, "")}%`); }
  const candidates = await queryRaw<{ip:string}>(`SELECT DISTINCT s.${q("ip")} FROM ${q("operations_source_daily")} s LEFT JOIN ${q("operations_ip_geo")} l ON l.${q("address")} = s.${q("ip")} AND l.${q("expiresAt")} > ? AND l.${q("datasetVersion")} = ? LEFT JOIN ${q("ip_geo_cache")} g ON g.${q("address")} = s.${q("ip")} AND g.${q("expiresAt")} > ? WHERE ${conditions.join(" AND ")} ORDER BY s.${q("ip")} LIMIT ${batchSize+1}`,params);
  const rows: any[][] = [];
  let resolved = 0;
  try {
    for (const {ip} of candidates.slice(0,batchSize)) {
      const geo = await lookupOperationsSourceGeo(ip);
      if (geo) resolved++;
      rows.push([ip,geo?.countryCode || "ZZ",geo?.countryName || null,geo?.region || null,geo?.city || null,geo?.isp || null,SOURCE_GEO_VERSION,now+(geo ? 30 : 1)*86400]);
    }
  } catch {
    if (Date.now()-lastWarning > 300000) { lastWarning=Date.now(); console.warn("[OperationsGeo] offline database unavailable or invalid; source locations remain unknown, no external requests made"); }
  }
  const columns = ["address","countryCode","countryName","region","city","isp","datasetVersion","expiresAt"];
  const mysql = getDatabaseKind() === "mysql";
  const update = columns.slice(1).map(column => `${q(column)} = ${mysql ? `VALUES(${q(column)})` : `excluded.${q(column)}`}`).join(",");
  for (let offset=0;offset<rows.length;offset+=50) {
    const batch = rows.slice(offset,offset+50);
    await executeRaw(`INSERT INTO ${q("operations_ip_geo")} (${columns.map(q).join(",")}) VALUES ${batch.map(()=>`(${columns.map(()=>"?").join(",")})`).join(",")} ${mysql ? "ON DUPLICATE KEY UPDATE" : `ON CONFLICT (${q("address")}) DO UPDATE SET`} ${update}`,batch.flat());
  }
  return {attempted:rows.length,resolved,next:candidates.length>batchSize ? candidates[batchSize-1].ip : "",remaining:candidates.length>batchSize};
}
