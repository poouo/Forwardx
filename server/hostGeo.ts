import * as db from "./db";

const GEO_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const GEO_REQUEST_TIMEOUT_MS = 8000;

const refreshingHostIds = new Set<number>();

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

function isRefreshDue(host: any) {
  if (!host?.geoCountryCode && !host?.geoCountryName && !host?.geoEmoji) return true;
  const updatedAt = toTime(host?.geoUpdatedAt);
  return !updatedAt || Date.now() - updatedAt >= GEO_REFRESH_INTERVAL_MS;
}

function pickLookupAddress(host: any) {
  const candidates = [host?.entryIp, host?.ipv4, host?.ipv6, host?.ip];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (!value) continue;
    if (value.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return value;
  }
  return "";
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
    const geo = await fetchHostGeo(address);
    await db.updateHost(hostId, geo as any);
  } catch (error: any) {
    console.warn(`[HostGeo] refresh failed host=${hostId}:`, error?.message || error);
  } finally {
    refreshingHostIds.delete(hostId);
  }
}

export function scheduleHostGeoRefresh(hostRows: any[]) {
  const dueHosts = hostRows.filter(isRefreshDue);
  for (const host of dueHosts) {
    void refreshHostGeo(host);
  }
}
