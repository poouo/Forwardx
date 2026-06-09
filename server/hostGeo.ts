import dns from "node:dns/promises";
import net from "node:net";
import * as db from "./db";

const GEO_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const GEO_REQUEST_TIMEOUT_MS = 8000;
const ADDRESS_GEO_CACHE_MS = 24 * 60 * 60 * 1000;
const ADDRESS_GEO_NEGATIVE_CACHE_MS = 30 * 60 * 1000;

const refreshingHostIds = new Set<number>();
const addressGeoCache = new Map<string, { expiresAt: number; value: AddressGeoLookupResult | null }>();

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

function isRefreshDue(host: any) {
  if (!host?.geoCountryCode && !host?.geoCountryName && !host?.geoEmoji) return true;
  if (host?.geoLatitudeMicro == null || host?.geoLongitudeMicro == null) return true;
  const updatedAt = toTime(host?.geoUpdatedAt);
  return !updatedAt || Date.now() - updatedAt >= GEO_REFRESH_INTERVAL_MS;
}

function pickLookupAddress(host: any) {
  const candidates = [host?.entryIp, host?.ipv4, host?.ipv6, host?.ip];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (!value) continue;
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
    const lookupAddress = await resolveLookupAddress(address);
    const geo = await fetchHostGeo(lookupAddress);
    await db.updateHost(hostId, geo as any);
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
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const resolvedAddress = await resolveLookupAddress(normalized);
    if (!resolvedAddress || isPrivateAddress(resolvedAddress)) {
      addressGeoCache.set(cacheKey, { expiresAt: Date.now() + ADDRESS_GEO_NEGATIVE_CACHE_MS, value: null });
      return null;
    }
    const geo = await fetchHostGeo(resolvedAddress);
    if (geo.geoLatitudeMicro == null || geo.geoLongitudeMicro == null) {
      addressGeoCache.set(cacheKey, { expiresAt: Date.now() + ADDRESS_GEO_NEGATIVE_CACHE_MS, value: null });
      return null;
    }
    const value = {
      address: normalized,
      resolvedAddress,
      ...geo,
    };
    addressGeoCache.set(cacheKey, { expiresAt: Date.now() + ADDRESS_GEO_CACHE_MS, value });
    return value;
  } catch (error: any) {
    addressGeoCache.set(cacheKey, { expiresAt: Date.now() + ADDRESS_GEO_NEGATIVE_CACHE_MS, value: null });
    console.warn(`[HostGeo] lookup failed address=${normalized}:`, error?.message || error);
    return null;
  }
}

export function scheduleHostGeoRefresh(hostRows: any[]) {
  const dueHosts = hostRows.filter(isRefreshDue);
  for (const host of dueHosts) {
    void refreshHostGeo(host);
  }
}
