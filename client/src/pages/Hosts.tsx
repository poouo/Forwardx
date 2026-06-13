import { useAuth } from "@/_core/hooks/useAuth";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import AgentTokenManager, { type AgentTokenViewMode } from "@/components/AgentTokenManager";
import AutoAnimateContainer from "@/components/AutoAnimateContainer";
import DashboardLayout from "@/components/DashboardLayout";
import { PersistentPagination, usePersistentPagination } from "@/components/PersistentPagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import DataSectionLoading from "@/components/DataSectionLoading";
import { countryFeatureHasCode, normalizeCountryCode } from "@/lib/countryFeatures";
import { trpc } from "@/lib/trpc";
import {
  Plus,
  Trash2,
  Pencil,
  Server,
  Monitor,
  Cpu,
  HardDrive,
  MemoryStick,
  Clock,
  ArrowDownToLine,
  ArrowUpFromLine,
  LayoutGrid,
  List,
  Globe,
  MapPinned,
  Download,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Activity,
  Key,
} from "lucide-react";
import type { GlobeMethods } from "react-globe.gl";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
const ReactGlobe = lazy(() => import("react-globe.gl")) as typeof import("react-globe.gl").default;
const HostFlatMap = lazy(() => import("@/components/HostFlatMap"));
const AGENT_UPGRADE_TIMEOUT_MS = 10 * 60 * 1000;
const HOSTS_LIST_CACHE_KEY = "forwardx.hosts.list.snapshot";
const HOST_METRICS_CACHE_PREFIX = "forwardx.hosts.metrics.";
const GLOBE_EARTH_IMAGE_URL = "/globe/earth-dark.jpg";
const GLOBE_BUMP_IMAGE_URL = "/globe/earth-topology.png";
const GLOBE_BACKGROUND_IMAGE_URL = "/globe/night-sky.png";
const GLOBE_COUNTRIES_URL = "/globe/ne_110m_admin_0_countries.geojson";
const HOST_GLOBE_CLUSTER_DISTANCE_DEGREES = 2.4;
const HOST_GLOBE_LABEL_PULL_DEGREES = 8.2;
const HOST_GLOBE_LABEL_ROW_DEGREES = 3.8;
const HOST_GLOBE_MAX_LABELS_PER_COLUMN = 6;

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

function readCachedHosts() {
  const hosts = readJsonCache<any[]>(HOSTS_LIST_CACHE_KEY, []);
  return Array.isArray(hosts) ? hosts : [];
}

function writeCachedHosts(hosts: any[]) {
  writeJsonCache(HOSTS_LIST_CACHE_KEY, hosts);
}

function readCachedHostMetrics(hostId: number | string) {
  const metrics = readJsonCache<any[]>(`${HOST_METRICS_CACHE_PREFIX}${hostId}`, []);
  return Array.isArray(metrics) ? metrics : [];
}

function writeCachedHostMetrics(hostId: number | string, metrics: any[]) {
  writeJsonCache(`${HOST_METRICS_CACHE_PREFIX}${hostId}`, metrics.slice(0, 2));
}

function parseCustomPortsInput(value: string) {
  const text = String(value || "").trim();
  if (!text) return { ports: [] as number[], invalid: [] as string[], normalized: "" };
  const tokens = text.split(",").map((item) => item.trim());
  const invalid: string[] = [];
  const ports: number[] = [];
  for (const token of tokens) {
    if (!token || !/^\d+$/.test(token)) {
      invalid.push(token || "空值");
      continue;
    }
    const port = Number(token);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      invalid.push(token);
      continue;
    }
    ports.push(port);
  }
  const normalizedPorts = Array.from(new Set(ports)).sort((a, b) => a - b);
  return {
    ports: normalizedPorts,
    invalid,
    normalized: normalizedPorts.join(","),
  };
}

function formatHostPortPolicy(host: any) {
  const parts: string[] = [];
  if ((host as any).portRangeStart != null && (host as any).portRangeEnd != null) {
    parts.push(`${(host as any).portRangeStart}-${(host as any).portRangeEnd}`);
  }
  const custom = parseCustomPortsInput(String((host as any).portAllowlist || "")).normalized;
  if (custom) parts.push(custom);
  return parts.length > 0 ? parts.join(" + ") : "不限制";
}

function metricUsageProgressClass(value: unknown, isOnline: boolean) {
  if (!isOnline) return "h-1.5 bg-muted [&>div]:bg-muted-foreground/40";
  const usage = Number(value || 0);
  if (usage >= 80) return "h-1.5 bg-muted [&>div]:bg-red-500";
  if (usage >= 50) return "h-1.5 bg-muted [&>div]:bg-amber-500";
  return "h-1.5 bg-muted [&>div]:bg-emerald-500";
}

function usePageVisible() {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const onVisibilityChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);
  return visible;
}

function formatBytes(bytes: number | null | undefined): string {
  const num = Number(bytes);
  if (!num || isNaN(num) || num === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(Math.abs(num)) / Math.log(k));
  return parseFloat((num / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatUptime(seconds: number | null | undefined): string {
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

function compareVersions(a: string | null | undefined, b: string | null | undefined) {
  const pa = normalizeVersion(a).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = normalizeVersion(b).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function pickLatestVersion(...versions: Array<string | null | undefined>) {
  return versions
    .map(normalizeVersion)
    .filter(Boolean)
    .reduce((latest, version) => (compareVersions(version, latest) > 0 ? version : latest), "");
}

function isAgentVersionBehind(version: string | null | undefined, target: string | null | undefined) {
  if (!version || !target) return false;
  return compareVersions(version, target) < 0;
}

function isAgentUpgradeTimedOut(host: any) {
  if (!host?.agentUpgradeRequested || !host.agentUpgradeRequestedAt) return false;
  const requestedAt = new Date(host.agentUpgradeRequestedAt).getTime();
  return Number.isFinite(requestedAt) && Date.now() - requestedAt > AGENT_UPGRADE_TIMEOUT_MS;
}

function hostAddressLines(host: any) {
  const rows: Array<{ label: string; value: string }> = [];
  if (host.ipv4) rows.push({ label: "IPv4", value: host.ipv4 });
  if (host.ipv6) rows.push({ label: "IPv6", value: host.ipv6 });
  if (rows.length === 0 && host.ip && host.ip !== "unknown") rows.push({ label: "IP", value: host.ip });
  if (rows.length === 0) rows.push({ label: "IP", value: "-" });
  return rows;
}

function agentDetectedIpText(host: any) {
  return hostAddressText(host);
}

function hostAddressText(host: any) {
  const parts: string[] = [];
  if (host.ipv4) parts.push(`IPv4 ${host.ipv4}`);
  if (host.ipv6) parts.push(`IPv6 ${host.ipv6}`);
  if (parts.length === 0 && host.ip && host.ip !== "unknown") parts.push(`IP ${host.ip}`);
  return parts.join("  /  ") || "-";
}

function hostRegionText(host: any) {
  const parts = [host.geoCountryName || host.geoCountryCode, host.geoRegion]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return parts.join(" / ");
}

function HostRegionBadge({ host, compact = false }: { host: any; compact?: boolean }) {
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

function hostGeoCoordinate(host: any) {
  if (host?.geoLatitudeMicro == null || host?.geoLongitudeMicro == null) return null;
  const lat = Number(host.geoLatitudeMicro) / 1_000_000;
  const lng = Number(host.geoLongitudeMicro) / 1_000_000;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

type HostGlobePoint = {
  host: any;
  lat: number;
  lng: number;
  displayLat: number;
  displayLng: number;
  color: string;
  glowColor: string;
  statusText: string;
  regionText: string;
  addressText: string;
  countryCode: string;
  flagUrl: string;
  label: string;
};

type HostGlobeLeaderPath = {
  point: HostGlobePoint;
  coords: Array<{ lat: number; lng: number; alt: number }>;
};

type HostGlobeCluster = {
  centerLat: number;
  centerLng: number;
  points: HostGlobePoint[];
};

type GlobeCountryFeature = {
  type: "Feature";
  properties?: Record<string, unknown>;
  geometry: {
    type: string;
    coordinates: unknown;
  };
};

function clampLatitude(lat: number) {
  return Math.max(-85, Math.min(85, lat));
}

function normalizeLongitude(lng: number) {
  if (lng < -180) return lng + 360;
  if (lng > 180) return lng - 360;
  return lng;
}

function longitudeDistanceDegrees(a: number, b: number) {
  const diff = Math.abs(a - b);
  return Math.min(diff, 360 - diff);
}

function hostCountryCode(host: any) {
  return normalizeCountryCode(host?.geoCountryCode);
}

function hostFlagUrl(host: any) {
  const countryCode = hostCountryCode(host).toLowerCase();
  return /^[a-z]{2}$/.test(countryCode) ? `https://flagcdn.com/24x18/${countryCode}.png` : "";
}

function hostGlobeLabel(host: any) {
  const name = String(host?.name || hostAddressText(host) || "-").trim();
  return name.length > 10 ? `${name.slice(0, 9)}…` : name;
}

function hostGlobePointPulledOut(point: HostGlobePoint) {
  return Math.abs(point.lat - point.displayLat) > 0.01 || Math.abs(point.lng - point.displayLng) > 0.01;
}

function hostGlobeClusterDistance(point: HostGlobePoint, cluster: HostGlobeCluster) {
  const latDiff = point.lat - cluster.centerLat;
  const lngScale = Math.max(0.35, Math.cos((((point.lat + cluster.centerLat) / 2) * Math.PI) / 180));
  const lngDiff = longitudeDistanceDegrees(point.lng, cluster.centerLng) * lngScale;
  return Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);
}

function buildHostGlobeClusters(points: HostGlobePoint[]) {
  const clusters: HostGlobeCluster[] = [];
  points
    .slice()
    .sort((a, b) => a.lng - b.lng || a.lat - b.lat)
    .forEach((point) => {
      const cluster = clusters.find((item) => hostGlobeClusterDistance(point, item) <= HOST_GLOBE_CLUSTER_DISTANCE_DEGREES);
      if (!cluster) {
        clusters.push({ centerLat: point.lat, centerLng: point.lng, points: [point] });
        return;
      }
      cluster.points.push(point);
      cluster.centerLat = cluster.points.reduce((sum, item) => sum + item.lat, 0) / cluster.points.length;
      cluster.centerLng = cluster.points.reduce((sum, item) => sum + item.lng, 0) / cluster.points.length;
    });
  return clusters;
}

function spreadHostGlobePoints(points: HostGlobePoint[]) {
  return buildHostGlobeClusters(points).flatMap((cluster) => {
    if (cluster.points.length <= 1) return cluster.points;
    const sorted = cluster.points.slice().sort((a, b) => String(a.host.name || "").localeCompare(String(b.host.name || "")) || Number(a.host.id || 0) - Number(b.host.id || 0));
    const lngScale = Math.max(0.36, Math.cos((cluster.centerLat * Math.PI) / 180));
    const pullLng = HOST_GLOBE_LABEL_PULL_DEGREES + Math.min(6, sorted.length * 0.55);
    const rowStep = Math.max(HOST_GLOBE_LABEL_ROW_DEGREES, Math.min(6.2, 3.2 + sorted.length * 0.35));
    return sorted.map((point, index) => {
      const column = Math.floor(index / HOST_GLOBE_MAX_LABELS_PER_COLUMN);
      const row = index % HOST_GLOBE_MAX_LABELS_PER_COLUMN;
      const columnSize = Math.min(HOST_GLOBE_MAX_LABELS_PER_COLUMN, sorted.length - column * HOST_GLOBE_MAX_LABELS_PER_COLUMN);
      const rowOffset = row - (columnSize - 1) / 2;
      return {
        ...point,
        displayLat: clampLatitude(cluster.centerLat + rowOffset * rowStep),
        displayLng: normalizeLongitude(cluster.centerLng + (pullLng + column * 6.8) / lngScale),
      };
    });
  });
}

function createHostGlobeLeaderPaths(points: HostGlobePoint[]): HostGlobeLeaderPath[] {
  return points
    .filter(hostGlobePointPulledOut)
    .map((point) => ({
      point,
      coords: [
        { lat: point.lat, lng: point.lng, alt: 0.052 },
        { lat: point.displayLat, lng: point.displayLng, alt: 0.118 },
      ],
    }));
}

function createHostGlobeLabelElement(
  point: HostGlobePoint,
  onEdit: (host: any) => void,
  onHoverChange: (point: HostGlobePoint | null) => void
) {
  const element = document.createElement("div");
  element.innerHTML = `
    <span style="width:7px;height:7px;flex:0 0 auto;border-radius:999px;background:${point.color};box-shadow:0 0 10px ${point.glowColor};"></span>
    <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;">${escapeTooltipHtml(point.label)}</span>
  `;
  element.style.cssText = [
    "display:inline-flex",
    "align-items:center",
    "gap:6px",
    "max-width:150px",
    "padding:3px 8px",
    "border:1px solid rgba(255,255,255,.18)",
    "border-radius:999px",
    "background:rgba(2,6,23,.58)",
    "box-shadow:0 8px 22px rgba(0,0,0,.28),0 0 0 1px rgba(15,23,42,.3)",
    "backdrop-filter:blur(8px)",
    "color:#f8fafc",
    "font:600 13px Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    "line-height:1.15",
    "letter-spacing:0",
    "white-space:nowrap",
    "text-shadow:0 1px 4px rgba(0,0,0,.6)",
    "transform:translate(-50%,-50%)",
    "pointer-events:auto",
    "user-select:none",
    "cursor:pointer",
  ].join(";");
  element.title = `${point.host.name || point.label} · ${point.regionText || "地区获取中"}`;
  element.addEventListener("pointerenter", () => onHoverChange(point));
  element.addEventListener("pointerleave", () => onHoverChange(null));
  element.addEventListener("mouseenter", () => onHoverChange(point));
  element.addEventListener("mouseleave", () => onHoverChange(null));
  element.addEventListener("pointerdown", (event) => event.stopPropagation());
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    onHoverChange(null);
    onEdit(point.host);
  });
  return element;
}

function escapeTooltipHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function renderHostGlobeTooltip(point: HostGlobePoint) {
  const rows = [
    { label: "地址", value: point.addressText },
    { label: "地区", value: point.regionText || "地区获取中" },
    { label: "系统", value: point.host.osInfo || "系统信息未上报" },
    { label: "Agent", value: point.host.agentVersion ? `v${point.host.agentVersion}` : "未上报" },
  ];
  const regionValue = point.flagUrl
    ? `<span style="display:inline-flex;min-width:0;align-items:center;gap:7px;"><img src="${escapeTooltipHtml(point.flagUrl)}" alt="${escapeTooltipHtml(point.countryCode)}" referrerpolicy="no-referrer" style="width:20px;height:15px;flex:0 0 auto;border-radius:2px;object-fit:cover;box-shadow:0 0 0 1px rgba(255,255,255,.16);" onerror="this.style.display='none';this.nextElementSibling.style.display='inline';" /><span style="display:none;flex:0 0 auto;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono',monospace;font-size:11px;color:#cbd5e1;">${escapeTooltipHtml(point.countryCode)}</span><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;">${escapeTooltipHtml(point.regionText || "地区获取中")}</span></span>`
    : escapeTooltipHtml(point.regionText || "地区获取中");
  return `
    <div style="min-width:260px;max-width:320px;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(8,13,24,.92);box-shadow:0 18px 44px rgba(0,0,0,.4);backdrop-filter:blur(10px);color:#f8fafc;padding:12px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;">
        <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:700;">${escapeTooltipHtml(point.host.name || "-")}</div>
        <div style="display:flex;align-items:center;gap:6px;color:#cbd5e1;font-size:12px;">
          <span style="width:8px;height:8px;border-radius:999px;background:${point.color};box-shadow:0 0 14px ${point.glowColor};"></span>
          ${escapeTooltipHtml(point.statusText)}
        </div>
      </div>
      ${rows.map((row) => `
        <div style="display:grid;grid-template-columns:42px minmax(0,1fr);gap:8px;align-items:start;margin-top:6px;font-size:12px;line-height:1.45;">
          <span style="color:#94a3b8;">${escapeTooltipHtml(row.label)}</span>
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;color:#e2e8f0;${row.label === "地址" || row.label === "Agent" ? "font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono',monospace;" : ""}">${row.label === "地区" ? regionValue : escapeTooltipHtml(row.value)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function HostWorldMap({
  hosts,
  onEdit,
}: {
  hosts: any[];
  onEdit: (host: any) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const [globeReady, setGlobeReady] = useState(false);
  const [size, setSize] = useState({ width: 1400, height: 780 });
  const [hoveredPoint, setHoveredPoint] = useState<HostGlobePoint | null>(null);
  const [countries, setCountries] = useState<GlobeCountryFeature[]>([]);

  const points = useMemo(() => {
    const rawPoints = hosts.map((host) => {
      const coord = hostGeoCoordinate(host);
      if (!coord) return null;
      const isOnline = !!host.isOnline;
      return {
        host,
        lat: coord.lat,
        lng: coord.lng,
        displayLat: coord.lat,
        displayLng: coord.lng,
        color: isOnline ? "#4ade80" : "#fbbf24",
        glowColor: isOnline ? "rgba(74,222,128,.9)" : "rgba(251,191,36,.82)",
        statusText: isOnline ? "在线" : "离线",
        regionText: hostRegionText(host),
        addressText: hostAddressText(host),
        countryCode: hostCountryCode(host),
        flagUrl: hostFlagUrl(host),
        label: hostGlobeLabel(host),
      };
    })
    .filter(Boolean) as HostGlobePoint[];
    return spreadHostGlobePoints(rawPoints);
  }, [hosts]);

  const missingCount = Math.max(0, hosts.length - points.length);
  const onlinePoints = useMemo(() => points.filter((point) => point.host.isOnline), [points]);
  const leaderPaths = useMemo(() => createHostGlobeLeaderPaths(points), [points]);
  const hostCountryCodes = useMemo(() => {
    const codes = new Set<string>();
    hosts.forEach((host) => {
      const code = hostCountryCode(host);
      if (code) codes.add(code);
    });
    return codes;
  }, [hosts]);

  useEffect(() => {
    let cancelled = false;
    fetch(GLOBE_COUNTRIES_URL)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !Array.isArray(data?.features)) return;
        setCountries(data.features as GlobeCountryFeature[]);
      })
      .catch(() => {
        if (!cancelled) setCountries([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      const viewportHeight = typeof window === "undefined" ? 900 : window.innerHeight;
      const width = Math.max(900, Math.round(rect.width));
      setSize({
        width,
        height: Math.max(720, Math.min(980, Math.round(Math.max(viewportHeight - 230, width * 0.52)))),
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    window.addEventListener("resize", updateSize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateSize);
    };
  }, []);

  useEffect(() => {
    if (!globeReady || !globeRef.current) return;
    const globe = globeRef.current;
    const controls = globe.controls();
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.42;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.rotateSpeed = 0.58;
    controls.zoomSpeed = 0.85;
    controls.minDistance = 105;
    controls.maxDistance = 500;
    globe.pointOfView({ lat: 5, lng: 108, altitude: 1.18 }, 0);
  }, [globeReady]);

  useEffect(() => {
    const controls = globeRef.current?.controls();
    if (!controls) return;
    controls.autoRotate = !hoveredPoint;
  }, [hoveredPoint]);

  return (
    <div className="hidden overflow-hidden rounded-md border border-border/40 bg-[#030712] shadow-sm md:block">
      <div
        ref={containerRef}
        className="relative min-h-[720px] w-full overflow-hidden"
        style={{ height: size.height }}
      >
        <Suspense
          fallback={
            <div className="absolute inset-0 flex items-center justify-center bg-[#030712] text-sm text-white/70">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              正在加载地球视图
            </div>
          }
        >
          <ReactGlobe
            ref={globeRef}
            width={size.width}
            height={size.height}
            backgroundColor="rgba(3,7,18,1)"
            backgroundImageUrl={GLOBE_BACKGROUND_IMAGE_URL}
            globeImageUrl={GLOBE_EARTH_IMAGE_URL}
            bumpImageUrl={GLOBE_BUMP_IMAGE_URL}
            showAtmosphere
            atmosphereColor="#38bdf8"
            atmosphereAltitude={0.22}
            showGraticules={false}
            globeCurvatureResolution={4}
            polygonsData={countries}
            polygonGeoJsonGeometry="geometry"
            polygonAltitude={(country) => countryFeatureHasCode(country as GlobeCountryFeature, hostCountryCodes) ? 0.014 : 0.004}
            polygonCapColor={(country) => countryFeatureHasCode(country as GlobeCountryFeature, hostCountryCodes) ? "rgba(14,165,233,.42)" : "rgba(15,23,42,.05)"}
            polygonSideColor={(country) => countryFeatureHasCode(country as GlobeCountryFeature, hostCountryCodes) ? "rgba(14,165,233,.28)" : "rgba(2,6,23,.14)"}
            polygonStrokeColor={(country) => countryFeatureHasCode(country as GlobeCountryFeature, hostCountryCodes) ? "rgba(125,211,252,.96)" : "rgba(148,163,184,.22)"}
            polygonCapCurvatureResolution={4}
            polygonsTransitionDuration={0}
            pathsData={leaderPaths}
            pathPoints="coords"
            pathPointLat="lat"
            pathPointLng="lng"
            pathPointAlt="alt"
            pathResolution={2}
            pathColor={(path: object) => ((path as HostGlobeLeaderPath).point.host.isOnline ? "rgba(125,211,252,.8)" : "rgba(251,191,36,.78)")}
            pathStroke={1.35}
            pathTransitionDuration={0}
            pointsData={points}
            pointLat="lat"
            pointLng="lng"
            pointAltitude={(point) => ((point as HostGlobePoint).host.isOnline ? 0.045 : 0.032)}
            pointRadius={0.34}
            pointResolution={28}
            pointColor={(point) => (point as HostGlobePoint).color}
            pointsTransitionDuration={0}
            ringsData={onlinePoints}
            ringLat="lat"
            ringLng="lng"
            ringAltitude={0.048}
            ringColor={() => ["rgba(74,222,128,.85)", "rgba(125,211,252,.28)", "rgba(74,222,128,0)"]}
            ringMaxRadius={2.5}
            ringPropagationSpeed={0.72}
            ringRepeatPeriod={2600}
            htmlElementsData={points}
            htmlLat="displayLat"
            htmlLng="displayLng"
            htmlAltitude={0.12}
            htmlElement={(point) => createHostGlobeLabelElement(point as HostGlobePoint, onEdit, setHoveredPoint)}
            htmlTransitionDuration={0}
            pointLabel={(point) => renderHostGlobeTooltip(point as HostGlobePoint)}
            onPointHover={(point) => setHoveredPoint(point as HostGlobePoint | null)}
            onPointClick={(point) => onEdit((point as HostGlobePoint).host)}
            showPointerCursor={(objectType) => objectType === "point"}
            enablePointerInteraction
            onGlobeReady={() => setGlobeReady(true)}
          />
        </Suspense>
        <div className="pointer-events-none absolute left-4 top-4 rounded-md border border-white/10 bg-black/35 px-3 py-2 text-xs text-white shadow-lg backdrop-blur-md">
          <div className="font-medium">全球主机地图</div>
          <div className="mt-1 text-white/70">
            已定位 {points.length} 台 · 待定位 {missingCount} 台
          </div>
        </div>
        {points.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center">
            <div className="rounded-md border border-white/10 bg-black/35 px-4 py-3 text-sm text-white/80 shadow-lg backdrop-blur-md">
              暂无可定位主机
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type HostFormData = {
  name: string;
  ip: string;
  hostType: "master" | "slave";
  networkInterface: string;
  entryIp: string;
  tunnelEntryIp: string;
  portRangeStart: number | null;
  portRangeEnd: number | null;
  portAllowlist: string;
  blockHttp: boolean;
  blockSocks: boolean;
  blockTls: boolean;
};

const defaultFormData: HostFormData = {
  name: "",
  ip: "",
  hostType: "slave",
  networkInterface: "",
  entryIp: "",
  tunnelEntryIp: "",
  portRangeStart: null,
  portRangeEnd: null,
  portAllowlist: "",
  blockHttp: false,
  blockSocks: false,
  blockTls: false,
};

type HostViewMode = "card" | "table" | "map" | "flat-map";
type HostManageTab = "hosts" | "tokens";

const HOST_VIEW_MODE_STORAGE_KEY = "forwardx.hosts.viewMode";
const AGENT_TOKEN_VIEW_MODE_STORAGE_KEY = "forwardx.agentTokens.viewMode";

function getStoredHostViewMode(): HostViewMode {
  if (typeof window === "undefined") return "card";
  try {
    const value = window.localStorage.getItem(HOST_VIEW_MODE_STORAGE_KEY);
    return value === "table" || value === "map" || value === "flat-map" ? value : "card";
  } catch {
    return "card";
  }
}

function storeHostViewMode(viewMode: HostViewMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HOST_VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // Ignore storage failures so the page still works in restricted browsers.
  }
}

function getStoredAgentTokenViewMode(): AgentTokenViewMode {
  if (typeof window === "undefined") return "card";
  try {
    const value = window.localStorage.getItem(AGENT_TOKEN_VIEW_MODE_STORAGE_KEY);
    return value === "table" ? "table" : "card";
  } catch {
    return "card";
  }
}

function storeAgentTokenViewMode(viewMode: AgentTokenViewMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AGENT_TOKEN_VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // Ignore storage failures so the page still works in restricted browsers.
  }
}

/** 单个主机卡片组件 */
function HostCard({
  host,
  onEdit,
  onDelete,
  onUpgrade,
  canUpgrade,
  latestAgentVersion,
  refreshInterval,
}: {
  host: any;
  onEdit: (host: any) => void;
  onDelete: (id: number) => void;
  onUpgrade: (host: any) => void;
  canUpgrade: boolean;
  latestAgentVersion?: string;
  refreshInterval: number | false;
}) {
  const { data: metrics } = trpc.hosts.metrics.useQuery(
    { hostId: host.id, limit: 2 },
    { refetchInterval: refreshInterval }
  );
  const cachedMetrics = useMemo(() => readCachedHostMetrics(host.id), [host.id]);
  const displayMetrics = metrics === undefined ? cachedMetrics : metrics;
  const latestMetric = displayMetrics?.[0];
  const previousMetric = displayMetrics?.[1];
  const totalNetworkIn = latestMetric?.networkIn == null ? null : Number(latestMetric.networkIn);
  const totalNetworkOut = latestMetric?.networkOut == null ? null : Number(latestMetric.networkOut);
  const diskUsed = latestMetric?.diskUsed == null ? null : Number(latestMetric.diskUsed);
  const diskTotal = latestMetric?.diskTotal == null ? null : Number(latestMetric.diskTotal);
  const networkSpeed = useMemo(() => {
    if (!latestMetric || !previousMetric) return { in: null as number | null, out: null as number | null };
    const latestAt = new Date(latestMetric.recordedAt).getTime();
    const previousAt = new Date(previousMetric.recordedAt).getTime();
    const seconds = Math.max(1, (latestAt - previousAt) / 1000);
    const inDelta = Math.max(0, Number(latestMetric.networkIn || 0) - Number(previousMetric.networkIn || 0));
    const outDelta = Math.max(0, Number(latestMetric.networkOut || 0) - Number(previousMetric.networkOut || 0));
    return { in: inDelta / seconds, out: outDelta / seconds };
  }, [latestMetric, previousMetric]);
  const agentNeedsUpdate = isAgentVersionBehind(host.agentVersion, latestAgentVersion);
  const agentUpgradeTimedOut = isAgentUpgradeTimedOut(host);
  const agentUpgrading = !!host.agentUpgradeRequested && !agentUpgradeTimedOut;
  const isOnline = !!host.isOnline;
  const infoPanelClass = isOnline
    ? "border-border/40 bg-background/30"
    : "border-muted-foreground/20 bg-muted/25";
  const uploadTrafficPanelClass = isOnline
    ? "border-blue-300/70 bg-blue-50 text-blue-700 dark:border-blue-400/35 dark:bg-blue-950/25 dark:text-blue-300"
    : "border-muted-foreground/20 bg-muted/25 text-muted-foreground";
  const downloadTrafficPanelClass = isOnline
    ? "border-emerald-300/70 bg-emerald-50 text-emerald-700 dark:border-emerald-400/35 dark:bg-emerald-950/25 dark:text-emerald-300"
    : "border-muted-foreground/20 bg-muted/25 text-muted-foreground";

  useEffect(() => {
    if (!metrics?.length) return;
    writeCachedHostMetrics(host.id, metrics);
  }, [host.id, metrics]);

  return (
    <Card className={`min-h-[420px] backdrop-blur-md transition-colors ${
      isOnline
        ? "border-border/40 bg-card/60 hover:border-border/60"
        : "border-muted-foreground/20 bg-muted/35 shadow-none hover:border-muted-foreground/30"
    }`}>
      <CardHeader className="pb-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <CardTitle className={`min-w-0 text-base font-semibold ${isOnline ? "" : "text-muted-foreground"}`}>
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <Monitor className="h-4 w-4 shrink-0" />
              <span className="min-w-0 max-w-full truncate">{host.name}</span>
              <span className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] font-normal text-muted-foreground ${
                isOnline ? "border-border/50" : "border-muted-foreground/20 bg-muted/20"
              }`}>
                {host.agentVersion ? `v${host.agentVersion}` : "未上报"}
              </span>
              {agentNeedsUpdate && (
                <Badge variant="outline" className="shrink-0 border-amber-500/30 px-1.5 py-0 text-[10px] text-amber-500">
                  新版
                </Badge>
              )}
              {host.agentUpgradeRequested && (
                <Badge variant="outline" className={`shrink-0 px-1.5 py-0 text-[10px] ${agentUpgradeTimedOut ? "border-destructive/30 text-destructive" : "border-blue-500/30 text-blue-500"}`}>
                  {agentUpgradeTimedOut ? "升级失败" : "升级中"}
                </Badge>
              )}
            </span>
          </CardTitle>
          <div className="flex shrink-0 items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={!canUpgrade}
              title={agentUpgradeTimedOut ? "升级超时，可重新下发" : "升级 Agent"}
              onClick={() => onUpgrade(host)}
            >
              {agentUpgrading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => onEdit(host)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={() => {
                if (confirm("确定要删除此主机吗？")) onDelete(host.id);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className={`space-y-3 ${isOnline ? "" : "text-muted-foreground"}`}>
        {/* 基本信息 */}
        <div className="space-y-2">
          <div className={`min-w-0 rounded-md border px-2.5 py-2 ${infoPanelClass}`}>
            <p className="truncate font-mono text-xs leading-5" title={hostAddressText(host)}>
              <span className="mr-1.5 text-muted-foreground">地址</span>
              {hostAddressText(host)}
            </p>
            <div className={`mt-1 ${isOnline ? "" : "opacity-70 grayscale"}`}>
              <HostRegionBadge host={host} />
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <div className="flex items-center gap-1.5">
              <Activity className="h-3.5 w-3.5 text-muted-foreground" />
              <span className={`h-2 w-2 rounded-full ${isOnline ? "bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" : "bg-destructive shadow-sm shadow-destructive/50"}`} />
              <span className={isOnline ? "" : "font-medium text-destructive"}>{isOnline ? "在线" : "离线"}</span>
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate" title={host.osInfo || ""}>{host.osInfo || "-"}</span>
            </div>
          </div>
        </div>

        {/* 监控数据 */}
        {latestMetric ? (
          <div className="space-y-3 pt-2 border-t border-border/30">
            {/* CPU */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground flex items-center gap-1"><Cpu className="h-3 w-3" /> CPU</span>
                <span className="font-medium tabular-nums">{latestMetric.cpuUsage ?? 0}%</span>
              </div>
              <p className="truncate text-[11px] text-muted-foreground" title={host.cpuInfo || ""}>
                {host.cpuInfo || "未上报 CPU 型号"}
              </p>
              <Progress value={latestMetric.cpuUsage ?? 0} className={metricUsageProgressClass(latestMetric.cpuUsage, isOnline)} />
            </div>
            {/* 内存 - 显示具体数据和百分比 */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground flex items-center gap-1"><MemoryStick className="h-3 w-3" /> 内存</span>
                <span className="max-w-[70%] truncate text-right font-medium tabular-nums">
                  {latestMetric.memoryUsed && host.memoryTotal
                    ? `${formatBytes(latestMetric.memoryUsed)} / ${formatBytes(host.memoryTotal)} (${latestMetric.memoryUsage ?? 0}%)`
                    : `${latestMetric.memoryUsage ?? 0}%`}
                </span>
              </div>
              <Progress value={latestMetric.memoryUsage ?? 0} className={metricUsageProgressClass(latestMetric.memoryUsage, isOnline)} />
            </div>
            {/* 磁盘 */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground flex items-center gap-1"><HardDrive className="h-3 w-3" /> 磁盘</span>
                <span className="max-w-[70%] truncate text-right font-medium tabular-nums">
                  {diskUsed !== null && diskTotal
                    ? `${formatBytes(diskUsed)} / ${formatBytes(diskTotal)} (${latestMetric.diskUsage ?? 0}%)`
                    : `-- / -- (${latestMetric.diskUsage ?? 0}%)`}
                </span>
              </div>
              <Progress value={latestMetric.diskUsage ?? 0} className={metricUsageProgressClass(latestMetric.diskUsage, isOnline)} />
            </div>
            {/* 流量 */}
            <div className="grid grid-cols-2 gap-2 pt-1">
              <div
                className={`flex min-h-[74px] min-w-0 flex-col items-center justify-center rounded-md border px-2.5 py-2.5 text-center ${uploadTrafficPanelClass}`}
                title={networkSpeed.out === null ? undefined : `当前上行 ${formatBytes(networkSpeed.out)}/s`}
              >
                <div className="flex min-w-0 items-center justify-center gap-1.5 text-sm font-medium">
                  <ArrowUpFromLine className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">上行流量</span>
                </div>
                <div className="mt-1 font-mono text-sm font-semibold tabular-nums">
                  {totalNetworkOut === null ? "--" : formatBytes(totalNetworkOut)}
                </div>
              </div>
              <div
                className={`flex min-h-[74px] min-w-0 flex-col items-center justify-center rounded-md border px-2.5 py-2.5 text-center ${downloadTrafficPanelClass}`}
                title={networkSpeed.in === null ? undefined : `当前下行 ${formatBytes(networkSpeed.in)}/s`}
              >
                <div className="flex min-w-0 items-center justify-center gap-1.5 text-sm font-medium">
                  <ArrowDownToLine className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">下行流量</span>
                </div>
                <div className="mt-1 font-mono text-sm font-semibold tabular-nums">
                  {totalNetworkIn === null ? "--" : formatBytes(totalNetworkIn)}
                </div>
              </div>
            </div>
            {/* 运行时间 */}
            <div className="flex items-center gap-2 text-xs pt-1">
              <Clock className="h-3 w-3 text-muted-foreground" />
              <span className="text-muted-foreground">运行时间</span>
              <span className="font-medium ml-auto">{formatUptime(latestMetric.uptime)}</span>
            </div>
          </div>
        ) : (
          <div className="text-center py-4 text-muted-foreground/60 border-t border-border/30">
            <p className="text-xs">暂无监控数据</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HostsContent() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const pageVisible = usePageVisible();
  const hostRefreshInterval = pageVisible ? 2000 : false;
  const { data: hosts, isLoading, isError, error, refetch } = trpc.hosts.list.useQuery(undefined, {
    refetchInterval: hostRefreshInterval,
    refetchOnWindowFocus: true,
  });
  const [cachedHosts, setCachedHosts] = useState<any[]>(() => readCachedHosts());
  const displayHosts: any[] = (hosts as any[] | undefined) || cachedHosts;
  const hasDisplayHosts = displayHosts.length > 0;
  const isInitialLoadingWithoutCache = isLoading && !hasDisplayHosts;
  const { data: systemSettings } = trpc.system.getSettings.useQuery();
  const latestAgentVersion = useMemo(
    () => systemSettings?.agentVersion || "",
    [systemSettings?.agentVersion]
  );
  const upgradingHosts = useRef<Map<number, string | null>>(new Map());

  const [showDialog, setShowDialog] = useState(false);
  const [upgradeHost, setUpgradeHost] = useState<any>(null);
  const [bulkUpgradeDialogOpen, setBulkUpgradeDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<HostViewMode>(() => getStoredHostViewMode());
  const [tokenViewMode, setTokenViewMode] = useState<AgentTokenViewMode>(() => getStoredAgentTokenViewMode());
  const [activeManageTab, setActiveManageTab] = useState<HostManageTab>("hosts");
  const [tokenCreateSignal, setTokenCreateSignal] = useState(0);
  const [checkingAgentUpdate, setCheckingAgentUpdate] = useState(false);
  const lastAgentUpdateCheck = useRef(0);
  const [form, setForm] = useState<HostFormData>(defaultFormData);
  const watchMetricsMutation = trpc.hosts.watchMetrics.useMutation();

  useEffect(() => {
    if (!hosts) return;
    setCachedHosts(hosts);
    writeCachedHosts(hosts);
  }, [hosts]);

  const handleViewModeChange = (mode: HostViewMode) => {
    setViewMode(mode);
    storeHostViewMode(mode);
  };

  const handleTokenViewModeChange = (mode: AgentTokenViewMode) => {
    setTokenViewMode(mode);
    storeAgentTokenViewMode(mode);
  };

  const createMutation = trpc.hosts.create.useMutation({
    onSuccess: () => {
      utils.hosts.list.invalidate();
      setShowDialog(false);
      resetForm();
      toast.success("主机添加成功");
    },
    onError: (err) => toast.error(err.message || "添加失败"),
  });

  const updateMutation = trpc.hosts.update.useMutation({
    onSuccess: () => {
      utils.hosts.list.invalidate();
      setShowDialog(false);
      resetForm();
      toast.success("主机更新成功");
    },
    onError: (err) => toast.error(err.message || "更新失败"),
  });

  const deleteMutation = trpc.hosts.delete.useMutation({
    onSuccess: () => {
      utils.hosts.list.invalidate();
      toast.success("主机已删除");
    },
    onError: (err) => toast.error(err.message || "删除失败"),
  });

  const upgradeAgentMutation = trpc.hosts.requestAgentUpgrade.useMutation({
    onSuccess: (data) => {
      utils.hosts.list.invalidate();
      setUpgradeHost(null);
      if ((data as any)?.alreadyLatest) {
        toast.info("该 Agent 已经是最新版本");
        return;
      }
      toast.success(data?.pushed ? "Agent 升级任务已推送，正在升级" : "Agent 升级任务已记录，等待 Agent 回连后执行");
    },
    onError: (err) => toast.error(err.message || "下发升级任务失败"),
  });
  const upgradeAgentsMutation = trpc.hosts.requestAgentUpgradeMany.useMutation({
    onSuccess: (data) => {
      utils.hosts.list.invalidate();
      setBulkUpgradeDialogOpen(false);
      const skippedLatest = (data as any)?.skippedLatest || 0;
      toast.success(`已下发 ${data?.requested || 0} 台 Agent 升级任务，实时推送 ${data?.pushed || 0} 台${skippedLatest ? `，跳过 ${skippedLatest} 台最新版本` : ""}`);
    },
    onError: (err) => toast.error(err.message || "批量下发升级任务失败"),
  });

  useEffect(() => {
    if (!displayHosts.length) return;
    const tracked = upgradingHosts.current;
    const currentIds = new Set<number>();
    for (const host of displayHosts as any[]) {
      currentIds.add(host.id);
      if (host.agentUpgradeRequested) {
        tracked.set(host.id, host.agentUpgradeTargetVersion || latestAgentVersion || null);
        continue;
      }
      if (tracked.has(host.id)) {
        tracked.delete(host.id);
        toast.success(`${host.name} Agent 升级成功，当前版本 ${host.agentVersion ? `v${host.agentVersion}` : "已上报"}`);
      }
    }
    for (const hostId of Array.from(tracked.keys())) {
      if (!currentIds.has(hostId)) tracked.delete(hostId);
    }
  }, [displayHosts, latestAgentVersion]);

  useEffect(() => {
    if (!pageVisible || !displayHosts.length) return;
    const hostIds = displayHosts.map((host: any) => Number(host.id)).filter(Boolean);
    if (hostIds.length === 0) return;
    watchMetricsMutation.mutate({ hostIds });
    const timer = window.setInterval(() => {
      watchMetricsMutation.mutate({ hostIds });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [pageVisible, displayHosts]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetForm = () => {
    setForm(defaultFormData);
    setEditingId(null);
  };

  const openCreate = () => {
    setTokenCreateSignal((value) => value + 1);
  };

  const openEdit = (host: any) => {
    setForm({
      name: host.name,
      ip: host.ip,
      hostType: host.hostType,
      networkInterface: host.networkInterface || "",
      entryIp: host.entryIp || "",
      tunnelEntryIp: host.tunnelEntryIp || "",
      portRangeStart: host.portRangeStart ?? null,
      portRangeEnd: host.portRangeEnd ?? null,
      portAllowlist: host.portAllowlist || "",
      blockHttp: !!host.blockHttp,
      blockSocks: !!host.blockSocks,
      blockTls: !!host.blockTls,
    });
    setEditingId(host.id);
    setShowDialog(true);
  };

  const handleSubmit = () => {
    const name = (form.name || "").trim();
    const entry = (form.entryIp || "").trim();
    const tunnelEntry = (form.tunnelEntryIp || "").trim();
    if (!name) { toast.error("请输入主机名称"); return; }
    if (name.length > 128) { toast.error("主机名称不能超过 128 个字符"); return; }
    if (entry.length > 253) { toast.error("入口 IP / 域名不能超过 253 个字符"); return; }
    if (tunnelEntry.length > 128) { toast.error("内网地址不能超过 128 个字符"); return; }

    const ps = form.portRangeStart;
    const pe = form.portRangeEnd;
    if ((ps != null && pe == null) || (ps == null && pe != null)) {
      toast.error("请同时填写端口区间的起始和结束值，或同时留空"); return;
    }
    if (ps != null && pe != null) {
      if (ps < 1 || ps > 65535 || pe < 1 || pe > 65535) { toast.error("端口区间必须在 1-65535 之间"); return; }
      if (ps > pe) { toast.error("端口区间起始值不能大于结束值"); return; }
    }
    const customPorts = parseCustomPortsInput(form.portAllowlist);
    if (customPorts.invalid.length > 0) {
      toast.error("自定义端口只能填写 1-65535 的整数，多个端口请使用英文逗号分隔");
      return;
    }

    const ni = (form.networkInterface || "").trim();
    const protocolPolicyPayload = user?.role === "admin"
      ? { blockHttp: form.blockHttp, blockSocks: form.blockSocks, blockTls: form.blockTls }
      : {};

    if (editingId) {
      updateMutation.mutate({
        id: editingId,
        name,
        hostType: form.hostType,
        networkInterface: ni || null,
        entryIp: entry || null,
        tunnelEntryIp: tunnelEntry || null,
        portRangeStart: ps ?? null,
        portRangeEnd: pe ?? null,
        portAllowlist: customPorts.normalized || null,
        ...protocolPolicyPayload,
      });
    } else {
      const ip = (form.ip || entry || "unknown").trim();
      createMutation.mutate({
        name,
        ip,
        hostType: form.hostType,
        networkInterface: ni || undefined,
        entryIp: entry || undefined,
        tunnelEntryIp: tunnelEntry || undefined,
        portRangeStart: ps ?? null,
        portRangeEnd: pe ?? null,
        portAllowlist: customPorts.normalized || null,
        ...protocolPolicyPayload,
      });
    }
  };
  const isPending = createMutation.isPending || updateMutation.isPending;
  const customPortInputState = useMemo(() => parseCustomPortsInput(form.portAllowlist), [form.portAllowlist]);
  const onlineCount = useMemo(() => displayHosts.filter((h) => h.isOnline).length, [displayHosts]);
  const updateCount = useMemo(
    () => displayHosts.filter((h) => isAgentVersionBehind(h.agentVersion, latestAgentVersion)).length,
    [displayHosts, latestAgentVersion]
  );
  const bulkUpgradeableHosts = useMemo(
    () => displayHosts.filter((h: any) => {
      const timedOut = isAgentUpgradeTimedOut(h);
      const pending = !!h.agentUpgradeRequested && !timedOut;
      return !pending && (timedOut || isAgentVersionBehind(h.agentVersion, latestAgentVersion));
    }),
    [displayHosts, latestAgentVersion]
  );
  const hostPagination = usePersistentPagination<any>(displayHosts, {
    storageKey: "forwardx.hosts.page",
    pageSize: 12,
    isReady: hasDisplayHosts,
  });
  const pagedHosts = hostPagination.items;
  const isAgentLatest = (host: any) => {
    if (!latestAgentVersion || !host?.agentVersion) return false;
    return compareVersions(host.agentVersion, latestAgentVersion) >= 0;
  };
  const requestAgentUpgrade = (host: any) => {
    if (isAgentLatest(host)) {
      toast.info("该 Agent 已经是最新版本");
      return;
    }
    setUpgradeHost(host);
  };
  const confirmAgentUpgrade = () => {
    if (!upgradeHost) return;
    if (isAgentLatest(upgradeHost)) {
      toast.info("该 Agent 已经是最新版本");
      setUpgradeHost(null);
      return;
    }
    upgradeAgentMutation.mutate({ hostId: upgradeHost.id, targetVersion: latestAgentVersion || null });
  };
  const requestAllAgentUpgrades = () => {
    if (bulkUpgradeableHosts.length === 0) {
      toast.info("暂无需要升级的 Agent");
      return;
    }
    setBulkUpgradeDialogOpen(true);
  };
  const confirmAllAgentUpgrades = () => {
    if (bulkUpgradeableHosts.length === 0) {
      toast.info("暂无需要升级的 Agent");
      setBulkUpgradeDialogOpen(false);
      return;
    }
    upgradeAgentsMutation.mutate({
      hostIds: bulkUpgradeableHosts.map((host: any) => Number(host.id)),
      targetVersion: latestAgentVersion || null,
    });
  };

  const handleCheckAgentUpdate = async () => {
    const now = Date.now();
    const cooldownMs = 30 * 1000;
    const waitMs = cooldownMs - (now - lastAgentUpdateCheck.current);
    if (waitMs > 0) {
      toast.info(`请 ${Math.ceil(waitMs / 1000)} 秒后重试`);
      return;
    }
    try {
      setCheckingAgentUpdate(true);
      lastAgentUpdateCheck.current = now;
      await utils.system.getSettings.invalidate();
      const latestHosts = await utils.hosts.list.fetch();
      const latestSettings = await utils.system.getSettings.fetch();
      const agentVersion = latestSettings?.agentVersion || "";
      const count = latestHosts.filter((host: any) => isAgentVersionBehind(host.agentVersion, agentVersion)).length;
      toast.success(count > 0 ? `发现 ${count} 台 Agent 有新版本` : "Agent 版本检查完成，暂无新版本");
    } catch (err: any) {
      toast.error(err?.message || "检查 Agent 更新失败");
    } finally {
      setCheckingAgentUpdate(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">主机管理</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            管理 Agent 主机和运行状态
          </p>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-end">
          <Badge variant="outline" className="justify-center gap-1.5 px-3 py-1.5 text-xs">
            <Server className="h-3 w-3 text-chart-2" />
            <AnimatedStatValue
              value={`${onlineCount} / ${displayHosts.length} 在线`}
              loading={isInitialLoadingWithoutCache}
              cacheKey="hosts.header.online"
              fallbackValue="0 / 0 在线"
            />
          </Badge>
          {/* 布局切换按钮 */}
          {updateCount > 0 && (
            <Badge variant="outline" className="justify-center gap-1.5 border-amber-500/30 px-3 py-1.5 text-xs text-amber-500">
              <AlertTriangle className="h-3 w-3" />
              {updateCount} 台发现新版本
            </Badge>
          )}
          {activeManageTab === "hosts" && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="col-span-2 w-full gap-2 sm:col-span-1 sm:w-auto"
                disabled={checkingAgentUpdate}
                onClick={handleCheckAgentUpdate}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${checkingAgentUpdate ? "animate-spin" : ""}`} />
                检查 Agent 更新
              </Button>
              {user?.role === "admin" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="col-span-2 w-full gap-2 sm:col-span-1 sm:w-auto"
                  disabled={bulkUpgradeableHosts.length === 0 || upgradeAgentsMutation.isPending}
                  onClick={requestAllAgentUpgrades}
                >
                  {upgradeAgentsMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  一键升级 Agent
                </Button>
              )}
              <div className="hidden items-center overflow-hidden rounded-md border border-border/40 sm:flex">
                <Button
                  variant={viewMode === "card" ? "secondary" : "ghost"}
                  size="icon"
                  className="h-8 w-8 rounded-none"
                  title="卡片视图"
                  onClick={() => handleViewModeChange("card")}
                >
                  <LayoutGrid className="h-4 w-4" />
                </Button>
                <Button
                  variant={viewMode === "table" ? "secondary" : "ghost"}
                  size="icon"
                  className="h-8 w-8 rounded-none"
                  title="列表视图"
                  onClick={() => handleViewModeChange("table")}
                >
                  <List className="h-4 w-4" />
                </Button>
                <Button
                  variant={viewMode === "map" ? "secondary" : "ghost"}
                  size="icon"
                  className="hidden h-8 w-8 rounded-none md:inline-flex"
                  title="3D 地球视图"
                  onClick={() => handleViewModeChange("map")}
                >
                  <Globe className="h-4 w-4" />
                </Button>
                <Button
                  variant={viewMode === "flat-map" ? "secondary" : "ghost"}
                  size="icon"
                  className="hidden h-8 w-8 rounded-none md:inline-flex"
                  title="平面地图视图"
                  onClick={() => handleViewModeChange("flat-map")}
                >
                  <MapPinned className="h-4 w-4" />
                </Button>
              </div>
            </>
          )}
          {activeManageTab === "tokens" && user?.role === "admin" && (
            <div className="hidden items-center overflow-hidden rounded-md border border-border/40 sm:flex">
              <Button
                variant={tokenViewMode === "card" ? "secondary" : "ghost"}
                size="icon"
                className="h-8 w-8 rounded-none"
                title="卡片视图"
                onClick={() => handleTokenViewModeChange("card")}
              >
                <LayoutGrid className="h-4 w-4" />
              </Button>
              <Button
                variant={tokenViewMode === "table" ? "secondary" : "ghost"}
                size="icon"
                className="h-8 w-8 rounded-none"
                title="列表视图"
                onClick={() => handleTokenViewModeChange("table")}
              >
                <List className="h-4 w-4" />
              </Button>
            </div>
          )}
          {user?.role === "admin" && (
            <Button onClick={openCreate} className="col-span-2 w-full gap-2 sm:col-span-1 sm:w-auto">
              <Plus className="h-4 w-4" />
              添加主机
            </Button>
          )}
        </div>
      </div>

      <Tabs
        value={activeManageTab}
        onValueChange={(value) => {
          if (value === "tokens" && user?.role !== "admin") return;
          setActiveManageTab(value as HostManageTab);
        }}
        className="space-y-4"
      >
        <TabsList className={`grid h-auto w-full ${user?.role === "admin" ? "grid-cols-2" : "grid-cols-1"} justify-start gap-1 bg-muted/50 sm:inline-flex sm:w-auto`}>
          <TabsTrigger value="hosts" className="gap-1.5 px-4">
            <Server className="h-3.5 w-3.5" />
            主机管理
          </TabsTrigger>
          {user?.role === "admin" && (
            <TabsTrigger value="tokens" className="gap-1.5 px-4">
              <Key className="h-3.5 w-3.5" />
              Token 管理
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="hosts" className="space-y-4">
      {/* Content */}
      {isInitialLoadingWithoutCache ? (
        <DataSectionLoading label="正在加载主机数据" minHeight="min-h-[260px]" />
      ) : isError ? (
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardContent className="p-0">
            <div className="flex flex-col items-center justify-center px-4 py-20 text-center text-muted-foreground">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
                <AlertTriangle className="h-8 w-8" />
              </div>
              <p className="text-lg font-medium text-foreground">主机加载失败</p>
              <p className="mt-2 max-w-xl break-words text-sm text-muted-foreground">
                {error?.message || "无法获取主机列表，请稍后重试"}
              </p>
              <Button variant="outline" className="mt-5 gap-2" onClick={() => refetch()}>
                <RefreshCw className="h-4 w-4" />
                重新加载
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : hasDisplayHosts ? (
        <>
        {viewMode === "map" ? (
          <>
            <HostWorldMap hosts={displayHosts} onEdit={openEdit} />
            <AutoAnimateContainer className="grid grid-cols-1 gap-4 md:hidden">
              {pagedHosts.map((host) => (
                <HostCard
                  key={host.id}
                  host={host}
                  onEdit={openEdit}
                  onDelete={(id) => deleteMutation.mutate({ id })}
                  onUpgrade={requestAgentUpgrade}
                  canUpgrade={user?.role === "admin"}
                  latestAgentVersion={latestAgentVersion}
                  refreshInterval={hostRefreshInterval}
                />
              ))}
            </AutoAnimateContainer>
            <div className="md:hidden">
              <PersistentPagination pagination={hostPagination} itemName="台主机" />
            </div>
          </>
        ) : viewMode === "flat-map" ? (
          <>
            <Suspense
              fallback={
                <div className="hidden min-h-[720px] items-center justify-center rounded-md border border-border/40 bg-[#020617] text-sm text-white/70 md:flex">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  正在加载平面地图
                </div>
              }
            >
              <HostFlatMap hosts={displayHosts} onEdit={openEdit} />
            </Suspense>
            <AutoAnimateContainer className="grid grid-cols-1 gap-4 md:hidden">
              {pagedHosts.map((host) => (
                <HostCard
                  key={host.id}
                  host={host}
                  onEdit={openEdit}
                  onDelete={(id) => deleteMutation.mutate({ id })}
                  onUpgrade={requestAgentUpgrade}
                  canUpgrade={user?.role === "admin"}
                  latestAgentVersion={latestAgentVersion}
                  refreshInterval={hostRefreshInterval}
                />
              ))}
            </AutoAnimateContainer>
            <div className="md:hidden">
              <PersistentPagination pagination={hostPagination} itemName="台主机" />
            </div>
          </>
        ) : viewMode === "card" ? (
          /* ========== 卡片式布局 ========== */
          <AutoAnimateContainer className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {pagedHosts.map((host) => (
              <HostCard
                key={host.id}
                host={host}
                onEdit={openEdit}
                onDelete={(id) => deleteMutation.mutate({ id })}
                onUpgrade={requestAgentUpgrade}
                canUpgrade={user?.role === "admin"}
                latestAgentVersion={latestAgentVersion}
                refreshInterval={hostRefreshInterval}
              />
            ))}
          </AutoAnimateContainer>
        ) : (
          /* ========== 表格式布局 ========== */
          <>
            <AutoAnimateContainer className="grid grid-cols-1 gap-4 sm:hidden">
              {pagedHosts.map((host) => (
                <HostCard
                  key={host.id}
                  host={host}
                  onEdit={openEdit}
                  onDelete={(id) => deleteMutation.mutate({ id })}
                  onUpgrade={requestAgentUpgrade}
                  canUpgrade={user?.role === "admin"}
                  latestAgentVersion={latestAgentVersion}
                  refreshInterval={hostRefreshInterval}
                />
              ))}
            </AutoAnimateContainer>
            <Card className="hidden border-border/40 bg-card/60 backdrop-blur-md sm:block">
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-[50px]">状态</TableHead>
                      <TableHead>名称</TableHead>
                      <TableHead className="min-w-[220px]">地址</TableHead>
                      <TableHead className="hidden lg:table-cell">端口区间</TableHead>
                      <TableHead className="hidden md:table-cell">系统</TableHead>
                      <TableHead className="hidden lg:table-cell">Agent</TableHead>
                      <TableHead className="hidden sm:table-cell">最后心跳</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <AutoAnimateContainer as={TableBody}>
                    {pagedHosts.map((host) => {
                      const agentUpgradeTimedOut = isAgentUpgradeTimedOut(host);
                      const agentUpgrading = !!host.agentUpgradeRequested && !agentUpgradeTimedOut;
                      return (
                      <TableRow key={host.id}>
                        <TableCell>
                          <div className="flex items-center justify-center">
                            {host.isOnline ? (
                              <span className="h-2.5 w-2.5 rounded-full bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" />
                            ) : (
                              <span className="h-2.5 w-2.5 rounded-full bg-destructive shadow-sm shadow-destructive/50" />
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Server className="h-4 w-4 text-muted-foreground" />
                            <span className="font-medium">{host.name}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            {hostAddressLines(host).map((item) => (
                              <div key={item.label} className="flex min-w-0 items-start gap-1 font-mono text-xs leading-5">
                                <span className="shrink-0 text-[10px] text-muted-foreground">{item.label}</span>
                                <span className="min-w-0 max-w-[260px] break-all">{item.value}</span>
                              </div>
                            ))}
                            <HostRegionBadge host={host} compact />
                          </div>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <span className="text-xs text-muted-foreground font-mono">
                            {formatHostPortPolicy(host)}
                          </span>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <span className="text-xs text-muted-foreground truncate max-w-[120px] block">
                            {host.osInfo || "-"}
                          </span>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-mono text-muted-foreground">
                              {host.agentVersion ? `v${host.agentVersion}` : "-"}
                            </span>
                            {isAgentVersionBehind(host.agentVersion, latestAgentVersion) && (
                              <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-500">
                                发现新版本
                              </Badge>
                            )}
                            {host.agentUpgradeRequested && (
                              <Badge variant="outline" className={`text-[10px] ${agentUpgradeTimedOut ? "border-destructive/30 text-destructive" : "border-blue-500/30 text-blue-500"}`}>
                                {agentUpgradeTimedOut ? "升级失败" : "升级中"}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <span className="text-xs text-muted-foreground">
                            {host.lastHeartbeat
                              ? new Date(host.lastHeartbeat).toLocaleString()
                              : "-"}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              disabled={user?.role !== "admin"}
                              title={agentUpgradeTimedOut ? "升级超时，可重新下发" : "升级 Agent"}
                              onClick={() => requestAgentUpgrade(host)}
                            >
                              {agentUpgrading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => openEdit(host)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              onClick={() => {
                                if (confirm("确定要删除此主机吗？"))
                                  deleteMutation.mutate({ id: host.id });
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                    })}
                  </AutoAnimateContainer>
                </Table>
                </div>
              </CardContent>
            </Card>
          </>
        )}
        {viewMode !== "map" && viewMode !== "flat-map" && <PersistentPagination pagination={hostPagination} itemName="台主机" />}
        </>
      ) : (
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardContent className="p-0">
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <div className="h-16 w-16 rounded-2xl bg-muted/30 flex items-center justify-center mb-4">
                <Server className="h-8 w-8 opacity-40" />
              </div>
              <p className="text-lg font-medium">暂无主机</p>
              <p className="text-sm mt-1 text-muted-foreground/60">
                {user?.role === "admin" ? "点击添加主机生成 Agent 安装命令" : "请联系管理员添加主机"}
              </p>
            </div>
          </CardContent>
        </Card>
      )}
        </TabsContent>
        {user?.role === "admin" && (
          <TabsContent value="tokens" className="space-y-4">
            <AgentTokenManager
              showCreateButton={false}
              hideViewModeToggle
              viewMode={tokenViewMode}
              onViewModeChange={handleTokenViewModeChange}
            />
          </TabsContent>
        )}
      </Tabs>

      {user?.role === "admin" && (
        <AgentTokenManager
          createSignal={tokenCreateSignal}
          dialogOnly
          showCreateButton={false}
          hideViewModeToggle
          onCreateSignalHandled={() => setTokenCreateSignal(0)}
        />
      )}

      {/* Agent Upgrade Dialog */}
      <Dialog open={!!upgradeHost} onOpenChange={(open) => !open && setUpgradeHost(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Download className="h-5 w-5 text-primary" />
              升级 Agent
            </DialogTitle>
            <DialogDescription>
              通过 Agent 下发升级任务。
            </DialogDescription>
          </DialogHeader>
          {upgradeHost && (
            <div className="space-y-3 rounded-lg border border-border/40 bg-muted/20 p-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">主机</span>
                <span className="font-medium">{upgradeHost.name}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">当前 Agent</span>
                <span className="font-mono">{upgradeHost.agentVersion ? `v${upgradeHost.agentVersion}` : "未上报"}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">目标版本</span>
                <span className="font-mono">v{latestAgentVersion || "-"}</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setUpgradeHost(null)}>
              取消
            </Button>
            <Button
              className="gap-2"
              disabled={!upgradeHost || upgradeAgentMutation.isPending}
              onClick={confirmAgentUpgrade}
            >
              {upgradeAgentMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {upgradeAgentMutation.isPending ? "下发中..." : "确认升级"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Agent Upgrade Dialog */}
      <Dialog open={bulkUpgradeDialogOpen} onOpenChange={setBulkUpgradeDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Download className="h-5 w-5 text-primary" />
              一键升级 Agent
            </DialogTitle>
            <DialogDescription>
              点击确认后才会向可升级的 Agent 下发升级任务。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 rounded-lg border border-border/40 bg-muted/20 p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">升级数量</span>
              <span className="font-medium">{bulkUpgradeableHosts.length} 台</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">目标版本</span>
              <span className="font-mono">v{latestAgentVersion || "-"}</span>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBulkUpgradeDialogOpen(false)}
              disabled={upgradeAgentsMutation.isPending}
            >
              取消
            </Button>
            <Button
              className="gap-2"
              disabled={bulkUpgradeableHosts.length === 0 || upgradeAgentsMutation.isPending}
              onClick={confirmAllAgentUpgrades}
            >
              {upgradeAgentsMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {upgradeAgentsMutation.isPending ? "下发中..." : "确认升级"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 添加/编辑对话框 */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? "编辑主机" : "添加主机"}</DialogTitle>
            <DialogDescription>
              {editingId ? "修改主机信息" : "添加 Agent 主机"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>主机名称</Label>
                <Input
                  placeholder="例如: 香港节点-01"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              {editingId && (
                <div className="space-y-2">
                  <Label>Agent 自动检测 IP</Label>
                  <Input value={agentDetectedIpText(displayHosts.find((host: any) => host.id === editingId) || form)} readOnly />
                  <p className="text-xs text-muted-foreground">
                    由 Agent 心跳自动上报，用于面板展示和地理位置识别。
                  </p>
                </div>
              )}
              <div className="space-y-2">
                <Label>入口 IP / 域名</Label>
                <Input
                  placeholder="例如: example.com 或 1.2.3.4"
                  value={form.entryIp}
                  onChange={(e) => setForm({ ...form, entryIp: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  留空时使用 Agent 自动检测 IP；填写域名时由 Agent 监控解析变化并刷新转发。
                </p>
              </div>
              <div className="space-y-2">
                <Label>
                  内网地址
                  <span className="ml-1 text-xs text-muted-foreground">(可选，供隧道链路使用)</span>
                </Label>
                <Input
                  placeholder="例如: 10.0.0.8 或 node-a.internal"
                  value={form.tunnelEntryIp}
                  onChange={(e) => setForm({ ...form, tunnelEntryIp: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  留空则默认使用上方“入口 IP / 域名”。
                </p>
              </div>
              <div className="space-y-2">
                <Label>
                  网卡名称
                  <span className="ml-1 text-xs text-muted-foreground">(可选，留空自动检测)</span>
                </Label>
                <Input
                  placeholder="例如: eth0, ens33, bond0"
                  value={form.networkInterface}
                  onChange={(e) => setForm({ ...form, networkInterface: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  留空自动检测默认出口网卡。
                </p>
              </div>
            </div>
            <div className="space-y-3 border-t border-border/50 pt-4">
              <div>
                <Label className="text-sm font-medium">转发端口区间</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  区间和自定义端口都留空表示不限制。
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">起始端口</Label>
                  <Input
                    type="number"
                    min={1}
                    max={65535}
                    step={1}
                    placeholder="例如: 10000"
                    value={form.portRangeStart ?? ""}
                    onChange={(e) => {
                      const v = e.target.value ? parseInt(e.target.value) : null;
                      setForm({ ...form, portRangeStart: v });
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">结束端口</Label>
                  <Input
                    type="number"
                    min={1}
                    max={65535}
                    step={1}
                    placeholder="例如: 20000"
                    value={form.portRangeEnd ?? ""}
                    onChange={(e) => {
                      const v = e.target.value ? parseInt(e.target.value) : null;
                      setForm({ ...form, portRangeEnd: v });
                    }}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">自定义端口</Label>
                <Input
                  placeholder="例如: 80,443,65095"
                  value={form.portAllowlist}
                  onChange={(e) => setForm({ ...form, portAllowlist: e.target.value })}
                  className={customPortInputState.invalid.length > 0 ? "border-destructive focus-visible:ring-destructive" : undefined}
                />
                {customPortInputState.invalid.length > 0 ? (
                  <p className="text-xs text-destructive">
                    自定义端口只能填写 1-65535 的整数，多个端口使用英文逗号分隔
                  </p>
                ) : customPortInputState.ports.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    自定义端口数量: <span className="font-medium">{customPortInputState.ports.length}</span> 个
                  </p>
                ) : null}
              </div>
              {form.portRangeStart != null && form.portRangeEnd != null && (
                <p className="text-xs text-muted-foreground">
                  可用端口数量: <span className="font-medium">{Math.max(0, form.portRangeEnd - form.portRangeStart + 1)}</span> 个
                </p>
              )}
              {form.portRangeStart != null && form.portRangeEnd != null && form.portRangeStart > form.portRangeEnd && (
                <p className="text-xs text-destructive">
                  起始端口不能大于结束端口
                </p>
              )}
            </div>
            {user?.role === "admin" && (
              <div className="space-y-3 border-t border-border/50 pt-4">
                <div>
                  <Label className="text-sm font-medium">入口协议屏蔽</Label>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    启用后，所有以该主机作为入口的 TCP 转发都会阻断对应协议。
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <label className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-background/60 px-3 py-2">
                    <span className="text-sm font-medium">HTTP</span>
                    <Switch checked={form.blockHttp} onCheckedChange={(checked) => setForm({ ...form, blockHttp: checked })} />
                  </label>
                  <label className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-background/60 px-3 py-2">
                    <span className="text-sm font-medium">SOCKS</span>
                    <Switch checked={form.blockSocks} onCheckedChange={(checked) => setForm({ ...form, blockSocks: checked })} />
                  </label>
                  <label className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-background/60 px-3 py-2">
                    <span className="text-sm font-medium">TLS</span>
                    <Switch checked={form.blockTls} onCheckedChange={(checked) => setForm({ ...form, blockTls: checked })} />
                  </label>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={isPending || !form.name}>
              {isPending ? "处理中..." : editingId ? "保存" : "添加"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function Hosts() {
  return (
    <DashboardLayout>
      <HostsContent />
    </DashboardLayout>
  );
}

