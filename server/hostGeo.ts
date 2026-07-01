import dns from "node:dns/promises";
import net from "node:net";
import * as db from "./db";
import { executeRaw, queryRaw } from "./dbRuntime";
import { quoteIdentifier } from "./dbCompat";

const GEO_REQUEST_TIMEOUT_MS = 8000;
const ADDRESS_GEO_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const ADDRESS_GEO_STALE_MS = 30 * 24 * 60 * 60 * 1000;
const GEO_REFRESH_INTERVAL_MS = ADDRESS_GEO_FRESH_MS;
const ADDRESS_GEO_NEGATIVE_CACHE_MS = 30 * 60 * 1000;
const GEO_RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;
const GEO_PROVIDER = "ipapi.co";

const refreshingHostIds = new Set<number>();
const addressGeoCache = new Map<string, AddressGeoCacheEntry>();
const addressGeoInflight = new Map<string, Promise<AddressGeoLookupResult | null>>();
let geoRateLimitedUntil = 0;

type AddressGeoCacheEntry = {
  freshUntil: number;
  expiresAt: number;
  value: AddressGeoLookupResult | null;
};

export type AddressGeoLookupResult = {
  address: string;
  resolvedAddress: string;
  geoCountryCode: string;
  geoCountryName: string | null;
  geoRegion: string | null;
  geoEmoji: string | null;
  geoLatitudeMicro: number | null;
  geoLongitudeMicro: number | null;
  geoUpdatedAt: Date;
};

function countryCodeToEmoji(countryCode: string | null | undefined) {
  const code = String(countryCode || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "";
  return Array.from(code)
    .map((char) => String.fromCodePoint(0x1f1e6 + char.charCodeAt(0) - 65))
    .join("");
}

function toTime(value: unknown) {
  if (!value) return 0;
  const time = new Date(value as any).getTime();
  return Number.isFinite(time) ? time : 0;
}

function toCoordinateMicro(value: unknown) {
  if (value == null || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 1_000_000);
}

function epochSeconds(value = new Date()) {
  return Math.floor(value.getTime() / 1000);
}

function rowDate(value: unknown) {
  if (value instanceof Date) return value;
  const num = Number(value || 0);
  if (Number.isFinite(num) && num > 0) return new Date(num * 1000);
  const parsed = new Date(value as any);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function cacheResultFromRow(row: any): AddressGeoLookupResult | null {
  const countryCode = String(row?.geoCountryCode || "").trim().toUpperCase();
  const resolvedAddress = String(row?.resolvedAddress || "").trim();
  const address = String(row?.address || resolvedAddress || "").trim();
  if (!countryCode || !resolvedAddress || !address) return null;
  return {
    address,
    resolvedAddress,
    geoCountryCode: countryCode,
    geoCountryName: String(row?.geoCountryName || "").trim() || null,
    geoRegion: String(row?.geoRegion || "").trim() || null,
    geoEmoji: String(row?.geoEmoji || "").trim() || countryCodeToEmoji(countryCode) || null,
    geoLatitudeMicro: row?.geoLatitudeMicro == null ? null : Number(row.geoLatitudeMicro),
    geoLongitudeMicro: row?.geoLongitudeMicro == null ? null : Number(row.geoLongitudeMicro),
    geoUpdatedAt: rowDate(row?.fetchedAt || row?.geoUpdatedAt),
  };
}

function isRefreshDue(host: any) {
  if (!host?.geoCountryCode && !host?.geoCountryName && !host?.geoEmoji) return true;
  if (host?.geoLatitudeMicro == null || host?.geoLongitudeMicro == null) return true;
  const updatedAt = toTime(host?.geoUpdatedAt);
  return !updatedAt || Date.now() - updatedAt >= GEO_REFRESH_INTERVAL_MS;
}

function pickLookupAddress(host: any) {
  const candidates = [host?.ipv4, host?.ipv6, host?.ip, host?.entryIp];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (!value || value.toLowerCase() === "unknown") continue;
    return value;
  }
  return "";
}

function isIpAddress(value: string) {
  return net.isIP(normalizeLookupAddress(value)) !== 0;
}

function normalizeLookupAddress(value: string) {
  const trimmed = String(value || "").trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1).trim();
  return trimmed;
}

function isPrivateIpv4(address: string) {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 2) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function expandIpv6(address: string) {
  const normalized = address.toLowerCase().split("%")[0];
  const ipv4Match = normalized.match(/(.+):(\d{1,3}(?:\.\d{1,3}){3})$/);
  const value = ipv4Match ? `${ipv4Match[1]}:0:0` : normalized;
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const fill = Array(Math.max(0, 8 - left.length - right.length)).fill("0");
  const groups = halves.length === 1 ? left : [...left, ...fill, ...right];
  if (groups.length !== 8) return null;
  const parsed = groups.map((group) => Number.parseInt(group || "0", 16));
  if (parsed.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) return null;
  return parsed;
}

function isPrivateIpv6(address: string) {
  const groups = expandIpv6(address);
  if (!groups) return true;
  const first = groups[0];
  const second = groups[1];
  const isLoopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  const isUnspecified = groups.every((group) => group === 0);
  return (
    isUnspecified ||
    isLoopback ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first === 0x2001 && second === 0x0db8)
  );
}

function isPrivateAddress(address: string) {
  const normalized = normalizeLookupAddress(address);
  const family = net.isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  if (family === 6) return isPrivateIpv6(normalized);
  return false;
}

async function resolveLookupAddress(address: string) {
  const normalized = normalizeLookupAddress(address);
  if (isIpAddress(normalized)) return normalized;
  const results = await dns.lookup(normalized, { all: true, family: 0, verbatim: false });
  const publicResult = results.find((result) => !isPrivateAddress(result.address));
  return (publicResult || results[0])?.address || normalized;
}

async function fetchHostGeo(address: string) {
  const now = Date.now();
  if (geoRateLimitedUntil > now) {
    throw new Error(`ipapi.co rate limited until ${new Date(geoRateLimitedUntil).toISOString()}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEO_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(address)}/json/`, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "User-Agent": "ForwardX",
      },
      signal: controller.signal,
    });
    if (res.status === 429) {
      geoRateLimitedUntil = Date.now() + GEO_RATE_LIMIT_COOLDOWN_MS;
      throw new Error("ipapi.co 429 rate limited");
    }
    if (!res.ok) throw new Error(`ipapi.co ${res.status}`);
    const data = await res.json() as any;
    const countryCode = String(data.country_code || "").trim().toUpperCase();
    if (!countryCode || data.error) throw new Error(String(data.reason || data.error || "ipapi.co empty response"));
    return {
      geoCountryCode: countryCode,
      geoCountryName: String(data.country_name || "").trim() || null,
      geoRegion: String(data.region || "").trim() || null,
      geoEmoji: String(data.emoji || "").trim() || countryCodeToEmoji(countryCode) || null,
      geoLatitudeMicro: toCoordinateMicro(data.latitude),
      geoLongitudeMicro: toCoordinateMicro(data.longitude),
      geoUpdatedAt: new Date(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function cacheEntryFromRow(row: any): AddressGeoCacheEntry | null {
  const value = cacheResultFromRow(row);
  if (!value) return null;
  const fetchedAt = toTime(row?.fetchedAt);
  const expiresAt = Number(row?.expiresAt || 0);
  return {
    freshUntil: fetchedAt > 0 ? fetchedAt + ADDRESS_GEO_FRESH_MS : Date.now(),
    expiresAt: expiresAt > 0 ? expiresAt * 1000 : Date.now() + ADDRESS_GEO_STALE_MS,
    value,
  };
}

async function readPersistentGeoCacheEntry(cacheKey: string) {
  const q = quoteIdentifier;
  const nowSec = epochSeconds();
  const rows = await queryRaw<any>(
    `SELECT ${q("address")}, ${q("resolvedAddress")}, ${q("geoCountryCode")}, ${q("geoCountryName")}, ${q("geoRegion")}, ${q("geoEmoji")}, ${q("geoLatitudeMicro")}, ${q("geoLongitudeMicro")}, ${q("fetchedAt")}, ${q("expiresAt")}
       FROM ${q("ip_geo_cache")}
      WHERE ${q("address")} = ? AND ${q("expiresAt")} > ?
      LIMIT 1`,
    [cacheKey, nowSec],
  ).catch(() => []);
  const entry = cacheEntryFromRow(rows[0]);
  if (entry) addressGeoCache.set(cacheKey, entry);
  return entry;
}

async function writePersistentGeoCache(cacheKey: string, value: AddressGeoLookupResult) {
  const nowSec = epochSeconds();
  const expiresAt = Math.floor((Date.now() + ADDRESS_GEO_STALE_MS) / 1000);
  const q = quoteIdentifier;
  const table = q("ip_geo_cache");
  const columns = [
    "address",
    "resolvedAddress",
    "geoCountryCode",
    "geoCountryName",
    "geoRegion",
    "geoEmoji",
    "geoLatitudeMicro",
    "geoLongitudeMicro",
    "provider",
    "fetchedAt",
    "expiresAt",
  ];
  const params = [
    cacheKey,
    value.resolvedAddress,
    value.geoCountryCode,
    value.geoCountryName,
    value.geoRegion,
    value.geoEmoji,
    value.geoLatitudeMicro,
    value.geoLongitudeMicro,
    GEO_PROVIDER,
    nowSec,
    expiresAt,
  ];
  await executeRaw(`DELETE FROM ${table} WHERE ${q("address")} = ?`, [cacheKey]).catch(() => undefined);
  await executeRaw(
    `INSERT INTO ${table} (${columns.map(q).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    params,
  ).catch(() => undefined);
}

export async function cleanOldAddressGeoCache() {
  const cutoff = epochSeconds(new Date(Date.now() - ADDRESS_GEO_STALE_MS));
  await executeRaw(
    `DELETE FROM ${quoteIdentifier("ip_geo_cache")} WHERE ${quoteIdentifier("expiresAt")} <= ?`,
    [cutoff],
  ).catch(() => undefined);
}

async function lookupAddressGeoUncached(normalized: string, cacheKey: string): Promise<AddressGeoLookupResult | null> {
  const staleEntry = await readPersistentGeoCacheEntry(cacheKey);
  if (staleEntry && staleEntry.freshUntil > Date.now()) return staleEntry.value;
  if (staleEntry?.value && staleEntry.expiresAt > Date.now() && geoRateLimitedUntil > Date.now()) return staleEntry.value;

  const resolvedAddress = await resolveLookupAddress(normalized);
  if (!resolvedAddress || isPrivateAddress(resolvedAddress)) {
    addressGeoCache.set(cacheKey, { freshUntil: Date.now() + ADDRESS_GEO_NEGATIVE_CACHE_MS, expiresAt: Date.now() + ADDRESS_GEO_NEGATIVE_CACHE_MS, value: null });
    return null;
  }

  const resolvedKey = resolvedAddress.toLowerCase();
  if (resolvedKey !== cacheKey) {
    const resolvedEntry = await readPersistentGeoCacheEntry(resolvedKey);
    if (resolvedEntry && resolvedEntry.freshUntil > Date.now() && resolvedEntry.value) {
      const value = { ...resolvedEntry.value, address: normalized, resolvedAddress };
      addressGeoCache.set(cacheKey, { ...resolvedEntry, value });
      await writePersistentGeoCache(cacheKey, value);
      return value;
    }
  }

  let geo: Awaited<ReturnType<typeof fetchHostGeo>>;
  try {
    geo = await fetchHostGeo(resolvedAddress);
  } catch (error) {
    if (staleEntry?.value) return staleEntry.value;
    if (resolvedKey !== cacheKey) {
      const resolvedStaleEntry = await readPersistentGeoCacheEntry(resolvedKey);
      if (resolvedStaleEntry?.value) return { ...resolvedStaleEntry.value, address: normalized, resolvedAddress };
    }
    throw error;
  }
  if (geo.geoLatitudeMicro == null || geo.geoLongitudeMicro == null) {
    if (staleEntry?.value) return staleEntry.value;
    addressGeoCache.set(cacheKey, { freshUntil: Date.now() + ADDRESS_GEO_NEGATIVE_CACHE_MS, expiresAt: Date.now() + ADDRESS_GEO_NEGATIVE_CACHE_MS, value: null });
    return null;
  }
  const value = {
    address: normalized,
    resolvedAddress,
    ...geo,
  };
  addressGeoCache.set(cacheKey, { freshUntil: Date.now() + ADDRESS_GEO_FRESH_MS, expiresAt: Date.now() + ADDRESS_GEO_STALE_MS, value });
  await writePersistentGeoCache(cacheKey, value);
  if (resolvedKey !== cacheKey) {
    await writePersistentGeoCache(resolvedKey, { ...value, address: resolvedAddress });
  }
  return value;
}

async function refreshHostGeo(host: any) {
  const hostId = Number(host?.id) || 0;
  if (!hostId || refreshingHostIds.has(hostId)) return;
  if (!isRefreshDue(host)) return;

  refreshingHostIds.add(hostId);
  try {
    const address = pickLookupAddress(host);
    if (!address) {
      return;
    }
    const geo = await lookupAddressGeo(address);
    if (!geo) return;
    await db.updateHost(hostId, {
      geoCountryCode: geo.geoCountryCode,
      geoCountryName: geo.geoCountryName,
      geoRegion: geo.geoRegion,
      geoEmoji: geo.geoEmoji,
      geoLatitudeMicro: geo.geoLatitudeMicro,
      geoLongitudeMicro: geo.geoLongitudeMicro,
      geoUpdatedAt: geo.geoUpdatedAt,
    } as any);
  } catch (error: any) {
    console.warn(`[HostGeo] refresh failed host=${hostId}:`, error?.message || error);
  } finally {
    refreshingHostIds.delete(hostId);
  }
}

export async function lookupAddressGeo(address: string): Promise<AddressGeoLookupResult | null> {
  const normalized = normalizeLookupAddress(address);
  if (!normalized) return null;
  const cacheKey = normalized.toLowerCase();
  const cached = addressGeoCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() && cached.freshUntil > Date.now()) return cached.value;
  if (cached?.value && cached.expiresAt > Date.now() && geoRateLimitedUntil > Date.now()) return cached.value;
  const inflight = addressGeoInflight.get(cacheKey);
  if (inflight) return inflight;

  const promise = lookupAddressGeoUncached(normalized, cacheKey)
    .catch((error: any) => {
      const fallback = addressGeoCache.get(cacheKey);
      if (fallback?.value && fallback.expiresAt > Date.now()) return fallback.value;
      addressGeoCache.set(cacheKey, { freshUntil: Date.now() + ADDRESS_GEO_NEGATIVE_CACHE_MS, expiresAt: Date.now() + ADDRESS_GEO_NEGATIVE_CACHE_MS, value: null });
      console.warn(`[HostGeo] lookup failed address=${normalized}:`, error?.message || error);
      return null;
    })
    .finally(() => {
      addressGeoInflight.delete(cacheKey);
    });
  addressGeoInflight.set(cacheKey, promise);
  return promise;
}

export function scheduleHostGeoRefresh(hostRows: any[]) {
  const dueHosts = hostRows.filter(isRefreshDue);
  for (const host of dueHosts) {
    void refreshHostGeo(host);
  }
}
