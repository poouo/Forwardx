const AGENT_UPGRADE_TIMEOUT_MS = 10 * 60 * 1000;
const HOST_METRICS_CACHE_PREFIX = "forwardx.hosts.metrics.";

function readJsonCache<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonCache(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Cached UI data is optional; ignore storage failures.
  }
}

export function readCachedHostMetrics(hostId: number | string) {
  const metrics = readJsonCache<any[]>(`${HOST_METRICS_CACHE_PREFIX}${hostId}`, []);
  return Array.isArray(metrics) ? metrics : [];
}

export function writeCachedHostMetrics(hostId: number | string, metrics: any[]) {
  writeJsonCache(`${HOST_METRICS_CACHE_PREFIX}${hostId}`, metrics.slice(0, 2));
}

export function metricUsageProgressClass(value: unknown, isOnline: boolean) {
  if (!isOnline) return "h-1.5 bg-muted [&>div]:bg-muted-foreground/40";
  const usage = Number(value || 0);
  if (usage >= 80) return "h-1.5 bg-muted [&>div]:bg-red-500";
  if (usage >= 50) return "h-1.5 bg-muted [&>div]:bg-amber-500";
  return "h-1.5 bg-muted [&>div]:bg-emerald-500";
}

export function formatBytes(bytes: number | null | undefined): string {
  const num = Number(bytes);
  if (!num || isNaN(num) || num === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(Math.abs(num)) / Math.log(k));
  return parseFloat((num / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export function formatUptime(seconds: number | null | undefined): string {
  if (!seconds) return "-";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}天 ${h}小时`;
  if (h > 0) return `${h}小时 ${m}分`;
  return `${m}分钟`;
}

function normalizeVersion(version: string | null | undefined) {
  return String(version || "").trim().replace(/^v/i, "");
}

export function compareVersions(a: string | null | undefined, b: string | null | undefined) {
  const pa = normalizeVersion(a).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = normalizeVersion(b).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function isAgentVersionBehind(version: string | null | undefined, target: string | null | undefined) {
  if (!version || !target) return false;
  return compareVersions(version, target) < 0;
}

export function isAgentUpgradeTimedOut(host: any) {
  if (!host?.agentUpgradeRequested || !host.agentUpgradeRequestedAt) return false;
  const requestedAt = new Date(host.agentUpgradeRequestedAt).getTime();
  return Number.isFinite(requestedAt) && Date.now() - requestedAt > AGENT_UPGRADE_TIMEOUT_MS;
}

function isPrimaryAddressFallbackVisible(value: unknown) {
  const text = String(value || "").trim();
  return !!text && text !== "unknown" && !text.includes(":");
}

export function hostAddressLines(host: any) {
  const rows: Array<{ label: string; value: string }> = [];
  if (host.ipv4) rows.push({ label: "IPv4", value: host.ipv4 });
  if (host.ipv6) rows.push({ label: "IPv6", value: host.ipv6 });
  if (rows.length === 0 && host.ip && host.ip !== "unknown") rows.push({ label: "IP", value: host.ip });
  if (rows.length === 0) rows.push({ label: "IP", value: "-" });
  return rows;
}

export function hostPrimaryAddressLines(host: any) {
  const rows: Array<{ label: string; value: string }> = [];
  if (host.ipv4) rows.push({ label: "IPv4", value: host.ipv4 });
  if (rows.length === 0 && isPrimaryAddressFallbackVisible(host.ip)) rows.push({ label: "IP", value: host.ip });
  if (rows.length === 0) rows.push({ label: "IP", value: "-" });
  return rows;
}

export function agentDetectedIpText(host: any) {
  return hostAddressText(host);
}

export function hostAddressText(host: any) {
  const parts: string[] = [];
  if (host.ipv4) parts.push(`IPv4 ${host.ipv4}`);
  if (host.ipv6) parts.push(`IPv6 ${host.ipv6}`);
  if (parts.length === 0 && host.ip && host.ip !== "unknown") parts.push(`IP ${host.ip}`);
  return parts.join("  /  ") || "-";
}

export function hostPrimaryAddressText(host: any) {
  const rows = hostPrimaryAddressLines(host);
  return rows.map((row) => `${row.label} ${row.value}`).join("  /  ") || "-";
}

export function hostRegionText(host: any) {
  const parts = [host.geoCountryName || host.geoCountryCode, host.geoRegion]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return parts.join(" / ");
}

export function HostRegionBadge({ host, compact = false }: { host: any; compact?: boolean }) {
  const countryCode = String(host.geoCountryCode || "").trim().toLowerCase();
  const flagUrl = /^[a-z]{2}$/.test(countryCode) ? `https://flagcdn.com/24x18/${countryCode}.png` : "";
  const fallbackCode = countryCode.toUpperCase();
  const regionText = hostRegionText(host);
  const hasGeo = !!(flagUrl || regionText);
  const title = hasGeo ? [fallbackCode, regionText].filter(Boolean).join(" ") : "地区获取中";
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1 rounded border border-border/50 bg-background/50 px-1.5 py-0.5 text-muted-foreground ${hasGeo ? "" : "opacity-70"} ${compact ? "text-[10px]" : "text-xs"}`}
      title={title}
    >
      {flagUrl && (
        <>
          <img
            src={flagUrl}
            alt={fallbackCode}
            loading="lazy"
            referrerPolicy="no-referrer"
            className={`${compact ? "h-3 w-4" : "h-3.5 w-5"} shrink-0 rounded-[2px] object-cover shadow-sm`}
            onError={(event) => {
              event.currentTarget.style.display = "none";
              const fallback = event.currentTarget.nextElementSibling as HTMLElement | null;
              if (fallback) fallback.style.display = "inline";
            }}
          />
          <span className="hidden shrink-0 font-mono leading-none">{fallbackCode}</span>
        </>
      )}
      <span className="min-w-0 truncate">{regionText || "地区获取中"}</span>
    </span>
  );
}
