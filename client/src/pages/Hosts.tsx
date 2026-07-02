import { useAuth } from "@/_core/hooks/useAuth";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import AgentTokenManager, { type AgentTokenViewMode } from "@/components/AgentTokenManager";
import AutoAnimateContainer from "@/components/AutoAnimateContainer";
import DashboardLayout from "@/components/DashboardLayout";
import DateTimePickerInput, {
  formatDateInputValue as formatDateTimeLocal,
  parseDateInputValue as parseDateTimeLocal,
} from "@/components/DatePickerInput";
import HostCard from "@/components/hosts/HostCard";
import HostGroupManager, { type HostGroupView, type HostGroupViewMode } from "@/components/hosts/HostGroupManager";
import HostProbeServiceManager, { type HostProbeServiceViewMode } from "@/components/hosts/HostProbeServiceManager";
import HostProbeServiceLatencyDialog from "@/components/hosts/HostProbeServiceLatencyDialog";
import {
  agentDetectedIpText,
  compareVersions,
  formatBytes,
  formatUptime,
  hostAddressText,
  hostPrimaryAddressText,
  HostRegionBadge,
  hostRegionText,
  isAgentUpgradeTimedOut,
  isAgentVersionBehind,
  metricUsageProgressClass,
} from "@/components/hosts/hostDisplay";
import { PersistentPagination, usePersistentPagination } from "@/components/PersistentPagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
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
import { Progress } from "@/components/ui/progress";
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
import { Switch } from "@/components/ui/switch";
import DataSectionLoading from "@/components/DataSectionLoading";
import { countryFeatureHasCode, normalizeCountryCode } from "@/lib/countryFeatures";
import { useUrlTab } from "@/hooks/useUrlTab";
import { pollingInterval, visiblePollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowRightLeft,
  CalendarDays,
  CircleCheck,
  Clock,
  Cpu,
  Plus,
  Trash2,
  Pencil,
  Server,
  HardDrive,
  LayoutGrid,
  List,
  Globe,
  RadioTower,
  MapPinned,
  Download,
  Gauge,
  AlertTriangle,
  Loader2,
  MemoryStick,
  RefreshCw,
  Key,
  Rows3,
  RotateCcw,
  ActivitySquare,
  FolderKanban,
  Wifi,
} from "lucide-react";
import type { GlobeMethods } from "react-globe.gl";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
const ReactGlobe = lazy(() => import("react-globe.gl")) as typeof import("react-globe.gl").default;
const HostFlatMap = lazy(() => import("@/components/HostFlatMap"));
const HOSTS_LIST_CACHE_KEY = "forwardx.hosts.list.snapshot";
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

function usePageVisible() {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const onVisibilityChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);
  return visible;
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
    ? `<span style="display:inline-flex;min-width:0;align-items:center;gap:7px;"><img src="${escapeTooltipHtml(point.flagUrl)}" alt="${escapeTooltipHtml(point.countryCode)}" referrerpolicy="no-referrer" style="width:20px;height:15px;flex:0 0 auto;border-radius:2px;object-fit:cover;" onerror="this.style.display='none';this.nextElementSibling.style.display='inline';" /><span style="display:none;flex:0 0 auto;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono',monospace;font-size:11px;color:#cbd5e1;">${escapeTooltipHtml(point.countryCode)}</span><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;">${escapeTooltipHtml(point.regionText || "地区获取中")}</span></span>`
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

type HostTrafficMeasureMode = "outbound" | "both" | "max";

const HOST_TRAFFIC_GB_BYTES = 1024 ** 3;

type HostFormData = {
  name: string;
  ip: string;
  hostType: "master" | "slave";
  networkInterface: string;
  sortOrder: string;
  entryIp: string;
  tunnelEntryIp: string;
  portRangeStart: number | null;
  portRangeEnd: number | null;
  portAllowlist: string;
  purchasedAt: string;
  stoppedAt: string;
  trafficLimitGb: string;
  trafficMeasureMode: HostTrafficMeasureMode;
  telegramTrafficAlertEnabled: boolean;
  trafficAlertThresholdPercent: number;
  telegramRenewalReminderEnabled: boolean;
  renewalReminderDays: number;
  trafficAutoReset: boolean;
  trafficResetDay: number;
  ddnsEnabled: boolean;
  ddnsIpVersion: "ipv4" | "ipv6";
  ddnsDomain: string;
  blockHttp: boolean;
  blockSocks: boolean;
  blockTls: boolean;
};

const defaultFormData: HostFormData = {
  name: "",
  ip: "",
  hostType: "slave",
  networkInterface: "",
  sortOrder: "",
  entryIp: "",
  tunnelEntryIp: "",
  portRangeStart: null,
  portRangeEnd: null,
  portAllowlist: "",
  purchasedAt: "",
  stoppedAt: "",
  trafficLimitGb: "",
  trafficMeasureMode: "both",
  telegramTrafficAlertEnabled: false,
  trafficAlertThresholdPercent: 20,
  telegramRenewalReminderEnabled: false,
  renewalReminderDays: 7,
  trafficAutoReset: false,
  trafficResetDay: 1,
  ddnsEnabled: false,
  ddnsIpVersion: "ipv4",
  ddnsDomain: "",
  blockHttp: false,
  blockSocks: false,
  blockTls: false,
};

function normalizeHostSortOrder(value: unknown) {
  const parsed = Math.floor(Number(value ?? 0));
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(200, Math.max(0, parsed));
}

function clampMonthlyResetDay(value: number) {
  return Math.min(31, Math.max(1, Math.floor(Number(value) || 1)));
}

function clampTrafficAlertThresholdPercent(value: number) {
  return Math.min(99, Math.max(1, Math.floor(Number(value) || 20)));
}

function clampRenewalReminderDays(value: number) {
  return Math.min(365, Math.max(1, Math.floor(Number(value) || 7)));
}

function normalizeHostTrafficMeasureMode(value: unknown): HostTrafficMeasureMode {
  if (value === "outbound" || value === "max") return value;
  return "both";
}

function normalizeHostDdnsIpVersion(value: unknown, recordType?: unknown): "ipv4" | "ipv6" {
  if (value === "ipv6" || (!value && String(recordType || "").toUpperCase() === "AAAA")) return "ipv6";
  return "ipv4";
}

function formatTrafficLimitGbInput(value: unknown) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const gb = bytes / HOST_TRAFFIC_GB_BYTES;
  return Number.isInteger(gb) ? String(gb) : String(Number(gb.toFixed(3)));
}

function formatBytesPerSecond(value: unknown) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B/s";
  return `${formatBytes(bytes)}/s`;
}

function formatOptionalBytesPerSecond(value: unknown) {
  if (value === null || value === undefined) return "--";
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "--";
  return formatBytesPerSecond(bytes);
}

function clampPercent(value: unknown) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function formatUsagePercent(value: unknown) {
  const percent = clampPercent(value);
  return percent === null ? "--" : `${percent}%`;
}

function formatMetricSizeDetail(used: unknown, total: unknown) {
  const usedBytes = Number(used);
  const totalBytes = Number(total);
  if (!Number.isFinite(usedBytes) || usedBytes <= 0) return "";
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return formatBytes(usedBytes);
  return `${formatBytes(usedBytes)} / ${formatBytes(totalBytes)}`;
}

const hostListDayMs = 24 * 60 * 60 * 1000;

function parseHostDateTime(value: unknown) {
  if (!value) return null;
  const ms = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function formatHostRemainingDays(purchasedAt: unknown, stoppedAt: unknown) {
  const purchasedMs = parseHostDateTime(purchasedAt);
  const stoppedMs = parseHostDateTime(stoppedAt);
  if (purchasedMs === null || stoppedMs === null || stoppedMs <= purchasedMs) return "--";
  const remainingMs = stoppedMs - Date.now();
  if (remainingMs <= 0) return "已到期";
  if (remainingMs < hostListDayMs) return "不足1天";
  return `${Math.ceil(remainingMs / hostListDayMs)}天`;
}

function hostRemainingClass(value: string) {
  if (value === "已到期") return "text-destructive";
  if (value === "不足1天") return "text-amber-500";
  if (value === "--") return "text-muted-foreground";
  return "text-emerald-500";
}

function compactHostOsInfo(value: unknown) {
  return String(value || "")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "-";
}

function HostListResourceMetric({
  icon: Icon,
  label,
  value,
  detail,
  isOnline,
}: {
  icon: typeof ActivitySquare;
  label: string;
  value: unknown;
  detail?: string;
  isOnline: boolean;
}) {
  const percent = clampPercent(value);
  const progressValue = percent ?? 0;
  const progressClass = percent === null
    ? "h-1.5 bg-muted [&>div]:bg-muted-foreground/20"
    : metricUsageProgressClass(progressValue, isOnline);
  return (
    <div className="min-w-[112px] space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">{label}</span>
        <span className="ml-auto font-semibold tabular-nums text-foreground">{formatUsagePercent(value)}</span>
      </div>
      <Progress value={progressValue} className={progressClass} />
      {detail && (
        <div className="truncate text-[10px] leading-none text-muted-foreground/70" title={detail}>
          {detail}
        </div>
      )}
    </div>
  );
}

function HostListFlowPair({
  inValue,
  outValue,
  inTitle,
  outTitle,
}: {
  inValue: string;
  outValue: string;
  inTitle?: string;
  outTitle?: string;
}) {
  return (
    <div className="min-w-[118px] space-y-1 text-xs tabular-nums">
      <div className="flex items-center gap-1.5 text-emerald-500" title={inTitle || inValue}>
        <ArrowDownToLine className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium">{inValue}</span>
      </div>
      <div className="flex items-center gap-1.5 text-sky-500" title={outTitle || outValue}>
        <ArrowUpFromLine className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium">{outValue}</span>
      </div>
    </div>
  );
}

function HostListStatusBadge({ host }: { host: any }) {
  const online = !!host?.isOnline;
  return (
    <div className="inline-flex min-w-[68px] items-center justify-center gap-2 whitespace-nowrap rounded-full border border-border/50 bg-background/50 px-2.5 py-1 text-xs font-medium">
      <span className={`h-2 w-2 rounded-full ${online ? "bg-emerald-500 shadow-sm shadow-emerald-500/50" : "bg-destructive shadow-sm shadow-destructive/50"}`} />
      <span className={online ? "text-emerald-500" : "text-destructive"}>{online ? "在线" : "离线"}</span>
    </div>
  );
}

function HostSummaryCard({
  title,
  value,
  subtitle,
  icon: Icon,
  leadingIcon: LeadingIcon,
  leadingTone = "bg-emerald-500",
  tone,
  loading,
  cacheKey,
  className,
}: {
  title: string;
  value: string;
  subtitle?: string;
  icon: typeof ActivitySquare;
  leadingIcon?: typeof ActivitySquare;
  leadingTone?: string;
  tone: string;
  loading?: boolean;
  cacheKey: string;
  className?: string;
}) {
  return (
    <Card className={`group relative h-full overflow-hidden border-border/40 bg-card/60 backdrop-blur-md transition-all duration-300 hover:-translate-y-0.5 hover:border-border/70 hover:shadow-lg hover:shadow-primary/5 ${className || ""}`.trim()}>
      <div className={`absolute inset-0 opacity-[0.035] transition-opacity group-hover:opacity-[0.07] ${tone}`} />
      <CardContent className="relative flex h-full min-h-[112px] flex-col justify-center p-3.5 sm:min-h-[112px] sm:p-4">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
        <div className="absolute right-4 top-3.5 hidden h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary shadow-sm sm:flex">
          <Icon className="h-5 w-5" />
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2.5 pr-12">
          {LeadingIcon && (
            <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg shadow-sm ${leadingTone}`}>
              <LeadingIcon className="h-4 w-4 text-white" />
            </div>
          )}
          <div className="min-w-0">
            <AnimatedStatValue
              as="span"
              value={value}
              loading={loading}
              cacheKey={cacheKey}
              fallbackValue="0"
              className="block truncate text-2xl font-bold leading-none tracking-tight tabular-nums"
              title={value}
            />
            {subtitle && (
              <p className="mt-2 truncate text-xs text-muted-foreground" title={subtitle}>
                {subtitle}
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function HostTrafficDirectionStat({
  label,
  value,
  icon: Icon,
  tone,
  loading,
  cacheKey,
  className,
}: {
  label: string;
  value: string;
  icon: typeof ActivitySquare;
  tone: string;
  loading?: boolean;
  cacheKey: string;
  className?: string;
}) {
  return (
    <div className={`min-w-0 ${className || ""}`.trim()}>
      <div className="flex items-center gap-2.5">
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg shadow-sm ${tone}`}>
          <Icon className="h-4 w-4 text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
          <AnimatedStatValue
            as="p"
            value={value}
            loading={loading}
            cacheKey={cacheKey}
            fallbackValue="0 B/s"
            className="mt-0.5 whitespace-nowrap text-base font-semibold leading-tight tabular-nums sm:text-lg"
            title={value}
          />
        </div>
      </div>
    </div>
  );
}

function HostTrafficSummaryCard({
  title,
  inValue,
  outValue,
  icon: Icon,
  loading,
  cacheKey,
  className,
}: {
  title: string;
  inValue: string;
  outValue: string;
  icon: typeof ActivitySquare;
  loading?: boolean;
  cacheKey: string;
  className?: string;
}) {
  return (
    <Card className={`group relative h-full overflow-hidden border-border/40 bg-card/60 backdrop-blur-md transition-all duration-300 hover:-translate-y-0.5 hover:border-border/70 hover:shadow-lg hover:shadow-primary/5 ${className || ""}`.trim()}>
      <div className="absolute inset-0 bg-gradient-to-br from-primary/10 to-transparent opacity-[0.035] transition-opacity group-hover:opacity-[0.07]" />
      <CardContent className="relative flex h-full flex-col justify-start p-3.5 sm:p-4">
        <div className="flex min-h-0 items-start justify-between gap-3">
          <div className="min-w-0 space-y-1 pr-12">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
          </div>
          <div className="pointer-events-none absolute right-4 top-3.5 hidden h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary shadow-sm sm:flex">
            <Icon className="h-5 w-5" />
          </div>
        </div>
        <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(145px,1fr))] gap-2.5">
          <HostTrafficDirectionStat
            label="入向"
            value={inValue}
            loading={loading}
            cacheKey={`${cacheKey}.in`}
            icon={ArrowDownToLine}
            tone="bg-emerald-500"
          />
          <HostTrafficDirectionStat
            label="出向"
            value={outValue}
            loading={loading}
            cacheKey={`${cacheKey}.out`}
            icon={ArrowUpFromLine}
            tone="bg-amber-500"
          />
        </div>
      </CardContent>
    </Card>
  );
}

type HostViewMode = "card" | "compact-card" | "table" | "map" | "flat-map";
type HostManageTab = "hosts" | "groups" | "services" | "tokens";
type HostDialogTab = "basic" | "other";

const HOST_MANAGE_TABS_ADMIN = ["hosts", "groups", "tokens", "services"] as const;
const HOST_MANAGE_TABS_USER = ["hosts"] as const;

const HOST_DIALOG_TABS = [
  { value: "basic", label: "基础信息", icon: Server },
  { value: "other", label: "其他配置", icon: Gauge },
] as const;

const HOST_MANAGE_TAB_STORAGE_KEY = "forwardx.hosts.manageTab";
const HOST_VIEW_MODE_STORAGE_KEY = "forwardx.hosts.viewMode";
const AGENT_TOKEN_VIEW_MODE_STORAGE_KEY = "forwardx.agentTokens.viewMode";
const HOST_PROBE_SERVICE_VIEW_MODE_STORAGE_KEY = "forwardx.hostProbeServices.viewMode";
const HOST_GROUP_VIEW_MODE_STORAGE_KEY = "forwardx.hostGroups.viewMode";

function getStoredHostViewMode(): HostViewMode {
  if (typeof window === "undefined") return "card";
  try {
    const value = window.localStorage.getItem(HOST_VIEW_MODE_STORAGE_KEY);
    return value === "compact-card" || value === "table" || value === "map" || value === "flat-map" ? value : "card";
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

function getStoredHostProbeServiceViewMode(): HostProbeServiceViewMode {
  if (typeof window === "undefined") return "card";
  try {
    const value = window.localStorage.getItem(HOST_PROBE_SERVICE_VIEW_MODE_STORAGE_KEY);
    return value === "table" ? "table" : "card";
  } catch {
    return "card";
  }
}

function storeHostProbeServiceViewMode(viewMode: HostProbeServiceViewMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HOST_PROBE_SERVICE_VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // Ignore storage failures so the page still works in restricted browsers.
  }
}

function getStoredHostGroupViewMode(): HostGroupViewMode {
  if (typeof window === "undefined") return "card";
  try {
    const value = window.localStorage.getItem(HOST_GROUP_VIEW_MODE_STORAGE_KEY);
    return value === "table" ? "table" : "card";
  } catch {
    return "card";
  }
}

function storeHostGroupViewMode(viewMode: HostGroupViewMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HOST_GROUP_VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // Ignore storage failures so the page still works in restricted browsers.
  }
}

function hostGroupHostIds(group: HostGroupView | null | undefined) {
  if (!group) return [];
  const rawIds = Array.isArray(group.hostIds)
    ? group.hostIds
    : (group.members || []).map((member) => member.hostId);
  return Array.from(new Set(rawIds
    .map((id) => Math.floor(Number(id)))
    .filter((id) => Number.isInteger(id) && id > 0)));
}

function HostGroupFilterBar({
  groups,
  hosts,
  selectedGroupId,
  onSelectGroup,
}: {
  groups: HostGroupView[];
  hosts: any[];
  selectedGroupId: number | "all";
  onSelectGroup: (groupId: number | "all") => void;
}) {
  const hostsById = useMemo(() => new Map((hosts || []).map((host: any) => [Number(host.id), host])), [hosts]);
  const enabledGroups = useMemo(
    () => [...(groups || [])]
      .filter((group) => group.isEnabled !== false)
      .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || Number(b.id || 0) - Number(a.id || 0)),
    [groups],
  );
  if (enabledGroups.length === 0) return null;
  const chipClass = (active: boolean) => [
    "inline-flex h-9 shrink-0 items-center gap-2 rounded-md border px-3 text-sm transition-colors",
    active
      ? "border-primary/35 bg-primary/10 text-primary shadow-sm"
      : "border-border/45 bg-card/60 text-muted-foreground hover:bg-muted/45 hover:text-foreground",
  ].join(" ");
  const countForGroup = (group: HostGroupView) => hostGroupHostIds(group).filter((hostId) => hostsById.has(hostId)).length;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border/40 bg-card/50 p-2 backdrop-blur-md">
      <button type="button" className={chipClass(selectedGroupId === "all")} onClick={() => onSelectGroup("all")}>
        <Server className="h-3.5 w-3.5" />
        <span>全部</span>
        <span className="rounded bg-background/70 px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">{hosts.length}</span>
      </button>
      {enabledGroups.map((group) => (
        <button
          key={group.id}
          type="button"
          className={chipClass(selectedGroupId === Number(group.id))}
          onClick={() => onSelectGroup(Number(group.id))}
          title={group.name}
        >
          <FolderKanban className="h-3.5 w-3.5" />
          <span className="max-w-[160px] truncate">{group.name}</span>
          <span className="rounded bg-background/70 px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">{countForGroup(group)}</span>
        </button>
      ))}
    </div>
  );
}

function HostsContent() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const confirmDialog = useConfirmDialog();
  const pageVisible = usePageVisible();
  const hostListRefreshInterval = visiblePollingInterval("slow", pageVisible);
  const { data: hosts, isLoading, isError, error, refetch } = trpc.hosts.list.useQuery(undefined, {
    refetchInterval: hostListRefreshInterval,
    refetchOnWindowFocus: true,
    staleTime: 25_000,
  });
  const [cachedHosts, setCachedHosts] = useState<any[]>(() => readCachedHosts());
  const baseDisplayHosts = useMemo<any[]>(() => {
    const source = ((hosts as any[] | undefined) || cachedHosts) as any[];
    return [...source].sort((a: any, b: any) => {
      const sortA = normalizeHostSortOrder(a?.sortOrder);
      const sortB = normalizeHostSortOrder(b?.sortOrder);
      if (sortA !== sortB) return sortA - sortB;
      const createdAtA = new Date(a?.createdAt || 0).getTime();
      const createdAtB = new Date(b?.createdAt || 0).getTime();
      if (Number.isFinite(createdAtA) && Number.isFinite(createdAtB) && createdAtA !== createdAtB) {
        return createdAtB - createdAtA;
      }
      return Number(b?.id || 0) - Number(a?.id || 0);
    });
  }, [hosts, cachedHosts]);
  const { data: systemSettings } = trpc.system.getSettings.useQuery();
  const latestAgentVersion = useMemo(
    () => systemSettings?.agentVersion || "",
    [systemSettings?.agentVersion]
  );
  const ddnsProviderEnabled = Boolean(systemSettings?.ddns?.enabled && systemSettings?.ddns?.provider && systemSettings.ddns.provider !== "disabled");
  const telegramBotReady = Boolean(systemSettings?.telegram?.enabled && systemSettings?.telegram?.configured);
  const telegramBotSettingsLoaded = Boolean(systemSettings?.telegram);
  const upgradingHosts = useRef<Map<number, string | null>>(new Map());

  const [showDialog, setShowDialog] = useState(false);
  const [hostDialogTab, setHostDialogTab] = useState<HostDialogTab>("basic");
  const [upgradeHost, setUpgradeHost] = useState<any>(null);
  const [probeLatencyHost, setProbeLatencyHost] = useState<any>(null);
  const [resetTrafficHost, setResetTrafficHost] = useState<any>(null);
  const [resetTrafficHostId, setResetTrafficHostId] = useState<number | null>(null);
  const [bulkUpgradeDialogOpen, setBulkUpgradeDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<HostViewMode>(() => getStoredHostViewMode());
  const [hostCardModeTransitionKey, setHostCardModeTransitionKey] = useState(0);
  const [tokenViewMode, setTokenViewMode] = useState<AgentTokenViewMode>(() => getStoredAgentTokenViewMode());
  const [serviceViewMode, setServiceViewMode] = useState<HostProbeServiceViewMode>(() => getStoredHostProbeServiceViewMode());
  const [hostGroupViewMode, setHostGroupViewMode] = useState<HostGroupViewMode>(() => getStoredHostGroupViewMode());
  const [activeManageTab, setActiveManageTab] = useUrlTab<HostManageTab>({
    values: user?.role === "admin" ? HOST_MANAGE_TABS_ADMIN : HOST_MANAGE_TABS_USER,
    defaultValue: "hosts",
    storageKey: HOST_MANAGE_TAB_STORAGE_KEY,
  });
  const hostLiveRefreshInterval = visiblePollingInterval("live", pageVisible && activeManageTab === "hosts");
  const { data: hostStatusRows = [] } = trpc.hosts.statusSummary.useQuery(undefined, {
    enabled: !!hostLiveRefreshInterval && baseDisplayHosts.length > 0,
    refetchInterval: hostLiveRefreshInterval,
    refetchOnWindowFocus: false,
  });
  const hostStatusById = useMemo(() => {
    const map = new Map<number, any>();
    for (const row of hostStatusRows as any[]) {
      const hostId = Number(row?.id);
      if (Number.isInteger(hostId) && hostId > 0) map.set(hostId, row);
    }
    return map;
  }, [hostStatusRows]);
  const displayHosts = useMemo<any[]>(() => baseDisplayHosts.map((host: any) => {
    const status = hostStatusById.get(Number(host?.id));
    return status ? { ...host, ...status } : host;
  }), [baseDisplayHosts, hostStatusById]);
  const hasDisplayHosts = displayHosts.length > 0;
  const isInitialLoadingWithoutCache = isLoading && !hasDisplayHosts;
  const [selectedHostGroupId, setSelectedHostGroupId] = useState<number | "all">("all");
  const [hostGroupCreateSignal, setHostGroupCreateSignal] = useState(0);
  const { data: hostGroups = [], isLoading: isHostGroupsLoading } = trpc.hosts.hostGroups.useQuery(undefined, {
    enabled: user?.role === "admin",
    staleTime: 30_000,
  });
  const enabledHostGroups = useMemo(
    () => (hostGroups as HostGroupView[]).filter((group) => group.isEnabled !== false),
    [hostGroups],
  );
  const selectedHostGroup = useMemo(
    () => selectedHostGroupId === "all"
      ? null
      : enabledHostGroups.find((group) => Number(group.id) === Number(selectedHostGroupId)) || null,
    [enabledHostGroups, selectedHostGroupId],
  );
  const filteredDisplayHosts = useMemo(() => {
    if (selectedHostGroupId === "all") return displayHosts;
    const selectedIds = new Set(hostGroupHostIds(selectedHostGroup));
    return displayHosts.filter((host: any) => selectedIds.has(Number(host.id)));
  }, [displayHosts, selectedHostGroup, selectedHostGroupId]);
  const hasFilteredDisplayHosts = filteredDisplayHosts.length > 0;
  const isHostGroupFiltered = selectedHostGroupId !== "all";
  const filteredHostIds = useMemo(
    () => filteredDisplayHosts.map((host: any) => Number(host.id)).filter((id) => Number.isInteger(id) && id > 0),
    [filteredDisplayHosts],
  );
  const filteredHostIdKey = useMemo(() => filteredHostIds.join(","), [filteredHostIds]);
  const { data: hostSummary, isLoading: isHostSummaryLoading } = trpc.hosts.summary.useQuery(undefined, {
    enabled: activeManageTab === "hosts",
    refetchInterval: hostLiveRefreshInterval || pollingInterval("slow"),
  });
  const { data: groupSummaryTrafficRows = [], isLoading: isGroupSummaryTrafficLoading } = trpc.hosts.trafficSummary.useQuery(
    { hostIds: filteredHostIds },
    { enabled: activeManageTab === "hosts" && isHostGroupFiltered && filteredHostIds.length > 0, refetchInterval: hostLiveRefreshInterval || pollingInterval("slow") },
  );
  const { data: groupSummaryMetricRows = [], isLoading: isGroupSummaryMetricLoading } = trpc.hosts.latestMetricsSummary.useQuery(
    { hostIds: filteredHostIds },
    { enabled: activeManageTab === "hosts" && isHostGroupFiltered && filteredHostIds.length > 0, refetchInterval: hostLiveRefreshInterval || pollingInterval("slow") },
  );
  const groupHostSummary = useMemo(() => {
    if (!isHostGroupFiltered) return null;
    let currentTrafficIn = 0;
    let currentTrafficOut = 0;
    let totalTrafficIn = 0;
    let totalTrafficOut = 0;
    for (const row of groupSummaryMetricRows as any[]) {
      currentTrafficIn += Math.max(0, Number(row?.networkSpeedIn) || 0);
      currentTrafficOut += Math.max(0, Number(row?.networkSpeedOut) || 0);
    }
    for (const row of groupSummaryTrafficRows as any[]) {
      totalTrafficIn += Math.max(0, Number(row?.bytesIn) || 0);
      totalTrafficOut += Math.max(0, Number(row?.bytesOut) || 0);
    }
    return {
      totalHosts: filteredDisplayHosts.length,
      onlineHosts: filteredDisplayHosts.filter((host: any) => !!host.isOnline).length,
      currentTrafficIn,
      currentTrafficOut,
      totalTrafficIn,
      totalTrafficOut,
    };
  }, [filteredDisplayHosts, groupSummaryMetricRows, groupSummaryTrafficRows, isHostGroupFiltered]);
  const effectiveHostSummary = groupHostSummary || hostSummary;
  const isEffectiveHostSummaryLoading = isHostGroupFiltered
    ? (isGroupSummaryTrafficLoading || isGroupSummaryMetricLoading)
    : isHostSummaryLoading;
  const [tokenCreateSignal, setTokenCreateSignal] = useState(0);
  const [serviceCreateSignal, setServiceCreateSignal] = useState(0);
  const [checkingAgentUpdate, setCheckingAgentUpdate] = useState(false);
  const lastAgentUpdateCheck = useRef(0);
  const [form, setForm] = useState<HostFormData>(defaultFormData);
  const watchMetricsMutation = trpc.hosts.watchMetrics.useMutation();

  useEffect(() => {
    if (!telegramBotSettingsLoaded || telegramBotReady) return;
    setForm((current) => {
      if (!current.telegramTrafficAlertEnabled && !current.telegramRenewalReminderEnabled) return current;
      return {
        ...current,
        telegramTrafficAlertEnabled: false,
        telegramRenewalReminderEnabled: false,
      };
    });
  }, [telegramBotSettingsLoaded, telegramBotReady]);

  useEffect(() => {
    if (!hosts) return;
    setCachedHosts(hosts);
    writeCachedHosts(hosts);
  }, [hosts]);

  const handleViewModeChange = (mode: HostViewMode) => {
    setViewMode((current) => {
      if ((current === "card" || current === "compact-card") && (mode === "card" || mode === "compact-card") && current !== mode) {
        setHostCardModeTransitionKey((value) => value + 1);
      }
      return mode;
    });
    storeHostViewMode(mode);
  };

  const handleTokenViewModeChange = (mode: AgentTokenViewMode) => {
    setTokenViewMode(mode);
    storeAgentTokenViewMode(mode);
  };

  const handleServiceViewModeChange = (mode: HostProbeServiceViewMode) => {
    setServiceViewMode(mode);
    storeHostProbeServiceViewMode(mode);
  };

  const handleHostGroupViewModeChange = (mode: HostGroupViewMode) => {
    setHostGroupViewMode(mode);
    storeHostGroupViewMode(mode);
  };

  useEffect(() => {
    if (user?.role !== "admin" && activeManageTab !== "hosts") setActiveManageTab("hosts");
  }, [activeManageTab, setActiveManageTab, user?.role]);

  useEffect(() => {
    if (selectedHostGroupId === "all" || isHostGroupsLoading) return;
    const stillVisible = enabledHostGroups.some((group) => Number(group.id) === Number(selectedHostGroupId));
    if (!stillVisible) setSelectedHostGroupId("all");
  }, [enabledHostGroups, isHostGroupsLoading, selectedHostGroupId]);

  const createMutation = trpc.hosts.create.useMutation({
    onSuccess: () => {
      utils.hosts.list.invalidate();
      utils.hosts.summary.invalidate();
      setShowDialog(false);
      resetForm();
      toast.success("主机添加成功");
    },
    onError: (err) => toast.error(err.message || "添加失败"),
  });

  const updateMutation = trpc.hosts.update.useMutation({
    onSuccess: () => {
      utils.hosts.list.invalidate();
      utils.hosts.summary.invalidate();
      setShowDialog(false);
      resetForm();
      toast.success("主机更新成功");
    },
    onError: (err) => toast.error(err.message || "更新失败"),
  });

  const deleteMutation = trpc.hosts.delete.useMutation({
    onSuccess: () => {
      utils.hosts.list.invalidate();
      utils.hosts.summary.invalidate();
      toast.success("主机已删除");
    },
    onError: (err) => toast.error(err.message || "删除失败"),
  });

  const resetHostTrafficMutation = trpc.hosts.resetTraffic.useMutation({
    onSuccess: () => {
      utils.hosts.trafficSummary.invalidate();
      utils.hosts.summary.invalidate();
      setResetTrafficHost(null);
      toast.success("流量统计已重置");
    },
    onError: (err) => toast.error(err.message || "重置流量统计失败"),
    onSettled: () => setResetTrafficHostId(null),
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

  const resetForm = () => {
    setForm(defaultFormData);
    setEditingId(null);
  };

  const openCreate = () => {
    if (activeManageTab === "services") {
      setServiceCreateSignal((value) => value + 1);
      return;
    }
    if (activeManageTab === "groups") {
      setHostGroupCreateSignal((value) => value + 1);
      return;
    }
    setTokenCreateSignal((value) => value + 1);
  };

  const openEdit = (host: any) => {
    setForm({
      name: host.name,
      ip: host.ip,
      hostType: host.hostType,
      networkInterface: host.networkInterface || "",
      sortOrder: String(normalizeHostSortOrder(host.sortOrder)),
      entryIp: host.entryIp || "",
      tunnelEntryIp: host.tunnelEntryIp || "",
      portRangeStart: host.portRangeStart ?? null,
      portRangeEnd: host.portRangeEnd ?? null,
      portAllowlist: host.portAllowlist || "",
      purchasedAt: formatDateTimeLocal(host.purchasedAt),
      stoppedAt: formatDateTimeLocal(host.stoppedAt),
      trafficLimitGb: formatTrafficLimitGbInput(host.trafficLimit),
      trafficMeasureMode: normalizeHostTrafficMeasureMode(host.trafficMeasureMode),
      telegramTrafficAlertEnabled: (!telegramBotSettingsLoaded || telegramBotReady) && !!host.telegramTrafficAlertEnabled,
      trafficAlertThresholdPercent: clampTrafficAlertThresholdPercent(host.trafficAlertThresholdPercent),
      telegramRenewalReminderEnabled: (!telegramBotSettingsLoaded || telegramBotReady) && !!host.telegramRenewalReminderEnabled,
      renewalReminderDays: clampRenewalReminderDays(host.renewalReminderDays),
      trafficAutoReset: !!host.trafficAutoReset,
      trafficResetDay: clampMonthlyResetDay(host.trafficResetDay || 1),
      ddnsEnabled: !!host.ddnsEnabled,
      ddnsIpVersion: normalizeHostDdnsIpVersion(host.ddnsIpVersion, host.ddnsRecordType),
      ddnsDomain: host.ddnsDomain || "",
      blockHttp: !!host.blockHttp,
      blockSocks: !!host.blockSocks,
      blockTls: !!host.blockTls,
    });
    setEditingId(host.id);
    setHostDialogTab("basic");
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
    const sortOrder = normalizeHostSortOrder(form.sortOrder);
    const purchasedAt = parseDateTimeLocal(form.purchasedAt);
    const stoppedAt = parseDateTimeLocal(form.stoppedAt);
    if (form.purchasedAt && !purchasedAt) { toast.error("机器购买时间格式不正确"); return; }
    if (form.stoppedAt && !stoppedAt) { toast.error("机器停止时间格式不正确"); return; }
    if (purchasedAt && stoppedAt && stoppedAt.getTime() <= purchasedAt.getTime()) {
      toast.error("机器停止时间必须晚于购买时间");
      return;
    }
    const trafficLimitGb = Number(String(form.trafficLimitGb || "").trim() || 0);
    if (user?.role === "admin" && (!Number.isFinite(trafficLimitGb) || trafficLimitGb < 0)) {
      toast.error("套餐流量不能小于 0");
      return;
    }
    if (user?.role === "admin" && form.ddnsEnabled) {
      if (!ddnsProviderEnabled) {
        toast.error("请先在系统设置内启用 DDNS 服务商");
        return;
      }
      if (!form.ddnsDomain.trim()) {
        toast.error("开启 DDNS 服务需要填写域名");
        return;
      }
    }
    const trafficLimitBytes = Math.round(trafficLimitGb * HOST_TRAFFIC_GB_BYTES);
    const trafficAlertThresholdPercent = clampTrafficAlertThresholdPercent(form.trafficAlertThresholdPercent);
    const renewalReminderDays = clampRenewalReminderDays(form.renewalReminderDays);
    const canSaveTelegramReminder = telegramBotSettingsLoaded ? telegramBotReady : true;
    const trafficConfigPayload = user?.role === "admin"
      ? {
          purchasedAt: purchasedAt ? purchasedAt.toISOString() : null,
          stoppedAt: stoppedAt ? stoppedAt.toISOString() : null,
          trafficLimit: trafficLimitBytes,
          trafficMeasureMode: form.trafficMeasureMode,
          telegramTrafficAlertEnabled: canSaveTelegramReminder && form.telegramTrafficAlertEnabled,
          trafficAlertThresholdPercent,
          telegramRenewalReminderEnabled: canSaveTelegramReminder && form.telegramRenewalReminderEnabled,
          renewalReminderDays,
          trafficAutoReset: form.trafficAutoReset,
          trafficResetDay: clampMonthlyResetDay(form.trafficResetDay),
          ddnsEnabled: form.ddnsEnabled,
          ddnsDomain: form.ddnsDomain.trim(),
          ddnsIpVersion: form.ddnsIpVersion,
          ddnsRecordType: (form.ddnsIpVersion === "ipv6" ? "AAAA" : "A") as "A" | "AAAA",
        }
      : {};
    const protocolPolicyPayload = user?.role === "admin"
      ? { blockHttp: form.blockHttp, blockSocks: form.blockSocks, blockTls: form.blockTls }
      : {};

    if (editingId) {
      updateMutation.mutate({
        id: editingId,
        name,
        hostType: form.hostType,
        networkInterface: ni || null,
        sortOrder,
        entryIp: entry || null,
        tunnelEntryIp: tunnelEntry || null,
        portRangeStart: ps ?? null,
        portRangeEnd: pe ?? null,
        portAllowlist: customPorts.normalized || null,
        ...trafficConfigPayload,
        ...protocolPolicyPayload,
      });
    } else {
      const ip = (form.ip || entry || "unknown").trim();
      createMutation.mutate({
        name,
        ip,
        hostType: form.hostType,
        networkInterface: ni || undefined,
        sortOrder,
        entryIp: entry || undefined,
        tunnelEntryIp: tunnelEntry || undefined,
        portRangeStart: ps ?? null,
        portRangeEnd: pe ?? null,
        portAllowlist: customPorts.normalized || null,
        ...trafficConfigPayload,
        ...protocolPolicyPayload,
      });
    }
  };
  const isPending = createMutation.isPending || updateMutation.isPending;
  const customPortInputState = useMemo(() => parseCustomPortsInput(form.portAllowlist), [form.portAllowlist]);
  const onlineCount = useMemo(() => filteredDisplayHosts.filter((h) => h.isOnline).length, [filteredDisplayHosts]);
  const updateCount = useMemo(
    () => filteredDisplayHosts.filter((h) => isAgentVersionBehind(h.agentVersion, latestAgentVersion)).length,
    [filteredDisplayHosts, latestAgentVersion]
  );
  const bulkUpgradeableHosts = useMemo(
    () => filteredDisplayHosts.filter((h: any) => {
      const timedOut = isAgentUpgradeTimedOut(h);
      const pending = !!h.agentUpgradeRequested && !timedOut;
      return !pending && (timedOut || isAgentVersionBehind(h.agentVersion, latestAgentVersion));
    }),
    [filteredDisplayHosts, latestAgentVersion]
  );
  const hostPagination = usePersistentPagination<any>(filteredDisplayHosts, {
    storageKey: "forwardx.hosts.page",
    pageSize: 12,
    isReady: hasDisplayHosts,
  });
  const pagedHosts = hostPagination.items;
  const pagedHostIds = useMemo(
    () => pagedHosts.map((host: any) => Number(host.id)).filter((id) => Number.isInteger(id) && id > 0),
    [pagedHosts]
  );
  const hostCardListMotionKey = useMemo(
    () => [
      viewMode,
      hostCardModeTransitionKey,
      selectedHostGroupId === "all" ? "all" : `group-${selectedHostGroupId}`,
      hostPagination.currentPage,
    ].join(":"),
    [hostCardModeTransitionKey, hostPagination.currentPage, selectedHostGroupId, viewMode],
  );
  useEffect(() => {
    if (!hostLiveRefreshInterval || !filteredHostIds.length) return;
    const hostIds = filteredHostIds;
    if (hostIds.length === 0) return;
    watchMetricsMutation.mutate({ hostIds });
    const timer = window.setInterval(() => {
      watchMetricsMutation.mutate({ hostIds });
    }, hostLiveRefreshInterval);
    return () => window.clearInterval(timer);
  }, [hostLiveRefreshInterval, filteredHostIdKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: probeServices = [] } = trpc.hosts.probeServices.useQuery(undefined, { refetchInterval: pollingInterval("slow") });
  const { data: hostTrafficRows = [] } = trpc.hosts.trafficSummary.useQuery(
    { hostIds: pagedHostIds },
    { enabled: !!hostLiveRefreshInterval && pagedHostIds.length > 0, refetchInterval: hostLiveRefreshInterval }
  );
  const hostTrafficById = useMemo(() => {
    const map = new Map<number, any>();
    for (const row of hostTrafficRows as any[]) map.set(Number(row.hostId), row);
    return map;
  }, [hostTrafficRows]);
  const { data: hostLatestMetricRows = [] } = trpc.hosts.latestMetricsSummary.useQuery(
    { hostIds: pagedHostIds },
    { enabled: !!hostLiveRefreshInterval && pagedHostIds.length > 0, refetchInterval: hostLiveRefreshInterval }
  );
  const hostLatestMetricById = useMemo(() => {
    const map = new Map<number, any>();
    for (const row of hostLatestMetricRows as any[]) map.set(Number(row.hostId), row);
    return map;
  }, [hostLatestMetricRows]);
  const hostLatestMetricSeriesById = useMemo(() => {
    const map = new Map<number, any[]>();
    for (const row of hostLatestMetricRows as any[]) map.set(Number(row.hostId), [row]);
    return map;
  }, [hostLatestMetricRows]);
  const requestResetHostTraffic = (host: any) => {
    const hostId = Number(host?.id);
    if (!Number.isInteger(hostId) || hostId <= 0) return;
    setResetTrafficHost(host);
  };
  const confirmResetHostTraffic = () => {
    const hostId = Number(resetTrafficHost?.id);
    if (!Number.isInteger(hostId) || hostId <= 0) return;
    setResetTrafficHostId(hostId);
    resetHostTrafficMutation.mutate({ hostId });
  };
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
              value={`${onlineCount} / ${filteredDisplayHosts.length} 在线`}
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
                  variant={viewMode === "compact-card" ? "secondary" : "ghost"}
                  size="icon"
                  className="h-8 w-8 rounded-none"
                  title="精简卡片"
                  onClick={() => handleViewModeChange("compact-card")}
                >
                  <Rows3 className="h-4 w-4" />
                </Button>
                <Button
                  variant={viewMode === "card" ? "secondary" : "ghost"}
                  size="icon"
                  className="h-8 w-8 rounded-none"
                  title="标准卡片"
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
          {activeManageTab === "groups" && user?.role === "admin" && (
            <div className="hidden items-center overflow-hidden rounded-md border border-border/40 sm:flex">
              <Button
                variant={hostGroupViewMode === "card" ? "secondary" : "ghost"}
                size="icon"
                className="h-8 w-8 rounded-none"
                title="卡片视图"
                onClick={() => handleHostGroupViewModeChange("card")}
              >
                <LayoutGrid className="h-4 w-4" />
              </Button>
              <Button
                variant={hostGroupViewMode === "table" ? "secondary" : "ghost"}
                size="icon"
                className="h-8 w-8 rounded-none"
                title="列表视图"
                onClick={() => handleHostGroupViewModeChange("table")}
              >
                <List className="h-4 w-4" />
              </Button>
            </div>
          )}
          {activeManageTab === "services" && user?.role === "admin" && (
            <div className="hidden items-center overflow-hidden rounded-md border border-border/40 sm:flex">
              <Button
                variant={serviceViewMode === "card" ? "secondary" : "ghost"}
                size="icon"
                className="h-8 w-8 rounded-none"
                title="卡片视图"
                onClick={() => handleServiceViewModeChange("card")}
              >
                <LayoutGrid className="h-4 w-4" />
              </Button>
              <Button
                variant={serviceViewMode === "table" ? "secondary" : "ghost"}
                size="icon"
                className="h-8 w-8 rounded-none"
                title="列表视图"
                onClick={() => handleServiceViewModeChange("table")}
              >
                <List className="h-4 w-4" />
              </Button>
            </div>
          )}
          {user?.role === "admin" && (
            <Button onClick={openCreate} className="col-span-2 w-full gap-2 sm:col-span-1 sm:w-auto">
              <Plus className="h-4 w-4" />
              {activeManageTab === "services" ? "添加服务" : activeManageTab === "groups" ? "添加分组" : "添加主机"}
            </Button>
          )}
        </div>
      </div>

      <Tabs
        value={activeManageTab}
        onValueChange={(value) => setActiveManageTab(value as HostManageTab)}
        className="space-y-4"
      >
        <TabsList className={`host-management-tabs grid h-auto w-full ${user?.role === "admin" ? "grid-cols-4" : "grid-cols-1"} justify-start gap-1 bg-muted/50 sm:inline-grid sm:w-auto`}>
          <TabsTrigger value="hosts" className="min-w-0 gap-1.5 px-3 sm:w-32">
            <Server className="h-3.5 w-3.5" />
            主机管理
          </TabsTrigger>
          {user?.role === "admin" && (
            <TabsTrigger value="groups" className="min-w-0 gap-1.5 px-3 sm:w-32">
              <FolderKanban className="h-3.5 w-3.5" />
              分组管理
            </TabsTrigger>
          )}
          {user?.role === "admin" && (
            <TabsTrigger value="tokens" className="min-w-0 gap-1.5 px-3 sm:w-32">
              <Key className="h-3.5 w-3.5" />
              Token 管理
            </TabsTrigger>
          )}

          {user?.role === "admin" && (
            <TabsTrigger value="services" className="min-w-0 gap-1.5 px-3 sm:w-32">
              <Rows3 className="h-3.5 w-3.5" />
              服务管理
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="hosts" className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <HostSummaryCard
            title="在线状态"
            value={`${effectiveHostSummary?.onlineHosts ?? onlineCount} / ${effectiveHostSummary?.totalHosts ?? filteredDisplayHosts.length}`}
            subtitle={effectiveHostSummary
              ? (() => {
                const total = effectiveHostSummary?.totalHosts ?? filteredDisplayHosts.length;
                const online = effectiveHostSummary?.onlineHosts ?? onlineCount;
                const offlineCount = Math.max(0, total - online);
                return offlineCount > 0 ? `离线 ${offlineCount} 台` : "全部在线";
              })()
              : "状态正常"}
            icon={Server}
            leadingIcon={CircleCheck}
            tone="bg-gradient-to-br from-emerald-500 to-emerald-600"
            loading={isEffectiveHostSummaryLoading && !effectiveHostSummary}
            cacheKey="hosts.summary.online"
          />
          <HostTrafficSummaryCard
            title="当前瞬时流量"
            inValue={formatBytesPerSecond(effectiveHostSummary?.currentTrafficIn)}
            outValue={formatBytesPerSecond(effectiveHostSummary?.currentTrafficOut)}
            icon={ActivitySquare}
            loading={isEffectiveHostSummaryLoading && !effectiveHostSummary}
            cacheKey="hosts.summary.currentTraffic"
          />
          <HostTrafficSummaryCard
            title="累计流量"
            inValue={formatBytes(effectiveHostSummary?.totalTrafficIn)}
            outValue={formatBytes(effectiveHostSummary?.totalTrafficOut)}
            icon={ArrowRightLeft}
            loading={isEffectiveHostSummaryLoading && !effectiveHostSummary}
            cacheKey="hosts.summary.totalTraffic"
          />
        </div>
        {user?.role === "admin" && (
          <HostGroupFilterBar
            groups={hostGroups as HostGroupView[]}
            hosts={displayHosts}
            selectedGroupId={selectedHostGroupId}
            onSelectGroup={setSelectedHostGroupId}
          />
        )}
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
      ) : hasFilteredDisplayHosts ? (
        <>
        {viewMode === "map" ? (
          <>
            <HostWorldMap hosts={filteredDisplayHosts} onEdit={openEdit} />
            <AutoAnimateContainer className="grid grid-cols-1 gap-4 md:hidden">
              {pagedHosts.map((host) => (
                <HostCard
                  key={host.id}
                  host={host}
                  onEdit={openEdit}
                  onDelete={(id) => deleteMutation.mutate({ id })}
                  onUpgrade={requestAgentUpgrade}
                  canUpgrade={user?.role === "admin"}
                  onResetTraffic={user?.role === "admin" ? requestResetHostTraffic : undefined}
                  onViewProbeLatency={setProbeLatencyHost}
                resetTrafficPending={resetTrafficHostId === host.id && resetHostTrafficMutation.isPending}
                  traffic={hostTrafficById.get(host.id)}
                  metrics={hostLatestMetricSeriesById.get(host.id) ?? null}
                  latestAgentVersion={latestAgentVersion}
                  refreshInterval={hostLiveRefreshInterval}
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
              <HostFlatMap hosts={filteredDisplayHosts} onEdit={openEdit} />
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
                  onResetTraffic={user?.role === "admin" ? requestResetHostTraffic : undefined}
                  onViewProbeLatency={setProbeLatencyHost}
                resetTrafficPending={resetTrafficHostId === host.id && resetHostTrafficMutation.isPending}
                  traffic={hostTrafficById.get(host.id)}
                  metrics={hostLatestMetricSeriesById.get(host.id) ?? null}
                  latestAgentVersion={latestAgentVersion}
                  refreshInterval={hostLiveRefreshInterval}
                />
              ))}
            </AutoAnimateContainer>
            <div className="md:hidden">
              <PersistentPagination pagination={hostPagination} itemName="台主机" />
            </div>
          </>
        ) : viewMode === "card" || viewMode === "compact-card" ? (
          /* ========== 卡片式布局 ========== */
          <AutoAnimateContainer
            key={`host-card-mode-${hostCardListMotionKey}`}
            duration={220}
            layout={false}
            className={
              viewMode === "compact-card"
                ? "standard-card-grid-compact host-card-grid-static host-card-grid-static-compact gap-3"
                : "standard-card-grid host-card-grid-static host-card-grid-static-standard gap-4"
            }
          >
            {pagedHosts.map((host) => (
              <HostCard
                key={host.id}
                host={host}
                onEdit={openEdit}
                onDelete={(id) => deleteMutation.mutate({ id })}
                onUpgrade={requestAgentUpgrade}
                canUpgrade={user?.role === "admin"}
                onResetTraffic={user?.role === "admin" ? requestResetHostTraffic : undefined}
                onViewProbeLatency={setProbeLatencyHost}
                resetTrafficPending={resetTrafficHostId === host.id && resetHostTrafficMutation.isPending}
                traffic={hostTrafficById.get(host.id)}
                metrics={hostLatestMetricSeriesById.get(host.id) ?? null}
                latestAgentVersion={latestAgentVersion}
                refreshInterval={hostLiveRefreshInterval}
                compact={viewMode === "compact-card"}
              />
            ))}
          </AutoAnimateContainer>
        ) : (
          /* ========== 表格式布局 ========== */
          <>
            <AutoAnimateContainer className="grid grid-cols-1 gap-3 sm:hidden">
              {pagedHosts.map((host) => (
                <HostCard
                  key={host.id}
                  host={host}
                  onEdit={openEdit}
                  onDelete={(id) => deleteMutation.mutate({ id })}
                  onUpgrade={requestAgentUpgrade}
                  canUpgrade={user?.role === "admin"}
                  onResetTraffic={user?.role === "admin" ? requestResetHostTraffic : undefined}
                  onViewProbeLatency={setProbeLatencyHost}
                resetTrafficPending={resetTrafficHostId === host.id && resetHostTrafficMutation.isPending}
                  traffic={hostTrafficById.get(host.id)}
                  metrics={hostLatestMetricSeriesById.get(host.id) ?? null}
                  latestAgentVersion={latestAgentVersion}
                  refreshInterval={hostLiveRefreshInterval}
                />
              ))}
            </AutoAnimateContainer>
            <Card className="hidden border-border/40 bg-card/60 backdrop-blur-md sm:block">
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                <Table className="min-w-[1080px]">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-[96px] whitespace-nowrap">状态</TableHead>
                      <TableHead className="w-[300px] min-w-[300px]">设备名称</TableHead>
                      <TableHead className="w-[130px] whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5"><Cpu className="h-3.5 w-3.5" />CPU</span>
                      </TableHead>
                      <TableHead className="w-[140px] whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5"><MemoryStick className="h-3.5 w-3.5" />RAM</span>
                      </TableHead>
                      <TableHead className="w-[140px] whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5"><HardDrive className="h-3.5 w-3.5" />磁盘</span>
                      </TableHead>
                      <TableHead className="w-[136px] whitespace-nowrap">累计流量</TableHead>
                      <TableHead className="w-[136px] whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5"><Wifi className="h-3.5 w-3.5" />实时网络</span>
                      </TableHead>
                      <TableHead className="w-[116px] whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" />运行时间</span>
                      </TableHead>
                      <TableHead className="w-[100px] whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5" />到期</span>
                      </TableHead>
                      <TableHead className="w-[178px] text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <AutoAnimateContainer as={TableBody}>
                    {pagedHosts.map((host) => {
                      const traffic = hostTrafficById.get(host.id);
                      const latestMetric = hostLatestMetricById.get(host.id);
                      const agentUpgradeTimedOut = isAgentUpgradeTimedOut(host);
                      const agentUpgrading = !!host.agentUpgradeRequested && !agentUpgradeTimedOut;
                      const agentNeedsUpdate = isAgentVersionBehind(host.agentVersion, latestAgentVersion);
                      const remainingDays = formatHostRemainingDays(host.purchasedAt, host.stoppedAt);
                      const primaryAddressText = hostPrimaryAddressText(host);
                      const memoryDetail = formatMetricSizeDetail(latestMetric?.memoryUsed, host.memoryTotal);
                      const diskDetail = formatMetricSizeDetail(latestMetric?.diskUsed, latestMetric?.diskTotal);
                      return (
                      <TableRow key={host.id} className="align-middle hover:bg-muted/25">
                        <TableCell className="w-[96px] whitespace-nowrap">
                          <HostListStatusBadge host={host} />
                        </TableCell>
                        <TableCell className="w-[300px] min-w-[300px]">
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background/60 text-muted-foreground shadow-sm">
                              <Server className="h-4 w-4" />
                            </span>
                            <div className="min-w-0 space-y-0.5">
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="min-w-0 truncate font-semibold" title={host.name}>{host.name}</span>
                                {host.agentVersion && (
                                  <span className="shrink-0 rounded border border-border/50 bg-muted/35 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
                                    v{host.agentVersion}
                                  </span>
                                )}
                                {agentNeedsUpdate && (
                                  <Badge variant="outline" className="shrink-0 border-amber-500/30 text-[10px] text-amber-500">
                                    新版本
                                  </Badge>
                                )}
                                {host.agentUpgradeRequested && (
                                  <Badge variant="outline" className={`shrink-0 text-[10px] ${agentUpgradeTimedOut ? "border-destructive/30 text-destructive" : "border-blue-500/30 text-blue-500"}`}>
                                    {agentUpgradeTimedOut ? "升级失败" : "升级中"}
                                  </Badge>
                                )}
                              </div>
                              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                                <HostRegionBadge host={host} compact />
                                <span className="rounded border border-border/40 bg-muted/25 px-1.5 py-0.5 font-mono" title={`端口策略：${formatHostPortPolicy(host)}`}>
                                  {formatHostPortPolicy(host)}
                                </span>
                              </div>
                              <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground" title={primaryAddressText}>
                                <RadioTower className="h-3 w-3 shrink-0" />
                                <span className="min-w-0 truncate font-mono">{primaryAddressText}</span>
                              </div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <HostListResourceMetric icon={Cpu} label="CPU" value={latestMetric?.cpuUsage} isOnline={!!host.isOnline} />
                        </TableCell>
                        <TableCell>
                          <HostListResourceMetric icon={MemoryStick} label="RAM" value={latestMetric?.memoryUsage} detail={memoryDetail} isOnline={!!host.isOnline} />
                        </TableCell>
                        <TableCell>
                          <HostListResourceMetric icon={HardDrive} label="Disk" value={latestMetric?.diskUsage} detail={diskDetail} isOnline={!!host.isOnline} />
                        </TableCell>
                        <TableCell>
                          <HostListFlowPair
                            inValue={formatBytes(Number(traffic?.bytesIn || 0))}
                            outValue={formatBytes(Number(traffic?.bytesOut || 0))}
                            inTitle={`累计入向：${formatBytes(Number(traffic?.bytesIn || 0))}`}
                            outTitle={`累计出向：${formatBytes(Number(traffic?.bytesOut || 0))}`}
                          />
                        </TableCell>
                        <TableCell>
                          <HostListFlowPair
                            inValue={formatOptionalBytesPerSecond(latestMetric?.networkSpeedIn)}
                            outValue={formatOptionalBytesPerSecond(latestMetric?.networkSpeedOut)}
                            inTitle="实时入向"
                            outTitle="实时出向"
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium tabular-nums text-muted-foreground">
                            <Clock className="h-3.5 w-3.5 shrink-0" />
                            <span>{latestMetric?.uptime == null ? "--" : formatUptime(latestMetric.uptime)}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold tabular-nums">
                            <CalendarDays className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className={hostRemainingClass(remainingDays)}>{remainingDays}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              title="查看服务延迟"
                              onClick={() => setProbeLatencyHost(host)}
                            >
                              <Activity className="h-3.5 w-3.5" />
                            </Button>
                            {user?.role === "admin" && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                disabled={resetTrafficHostId === host.id && resetHostTrafficMutation.isPending}
                                title={resetTrafficHostId === host.id && resetHostTrafficMutation.isPending ? "正在重置流量统计" : "重置流量统计"}
                                onClick={() => requestResetHostTraffic(host)}
                              >
                                {resetTrafficHostId === host.id && resetHostTrafficMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                              </Button>
                            )}
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
                              onClick={async () => {
                                if (await confirmDialog({
                                  title: "删除主机",
                                  description: "确定要删除此主机吗？删除后相关状态和配置会同步移除。",
                                  confirmText: "删除",
                                  tone: "destructive",
                                }))
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
              <p className="text-lg font-medium">{isHostGroupFiltered ? "当前分组暂无主机" : "暂无主机"}</p>
              <p className="text-sm mt-1 text-muted-foreground/60">
                {isHostGroupFiltered ? "可以在分组管理中为该分组添加主机" : user?.role === "admin" ? "点击添加主机生成 Agent 安装命令" : "请联系管理员添加主机"}
              </p>
            </div>
          </CardContent>
        </Card>
      )}
        </TabsContent>{user?.role === "admin" && (
          <TabsContent value="tokens" className="space-y-4">
            <AgentTokenManager
              showCreateButton={false}
              hideViewModeToggle
              viewMode={tokenViewMode}
              onViewModeChange={handleTokenViewModeChange}
            />
          </TabsContent>
        )}

        {user?.role === "admin" && (
          <TabsContent value="groups" className="space-y-4">
            <HostGroupManager
              hosts={displayHosts}
              groups={hostGroups as HostGroupView[]}
              isLoading={isHostGroupsLoading}
              createSignal={hostGroupCreateSignal}
              onCreateSignalHandled={() => setHostGroupCreateSignal(0)}
              viewMode={hostGroupViewMode}
            />
          </TabsContent>
        )}

        {user?.role === "admin" && (
          <TabsContent value="services" className="space-y-4">
            <p className="text-xs text-muted-foreground sm:text-sm">
              管理主机 Ping / TCPing 探测服务。
            </p>
            <HostProbeServiceManager
              createSignal={serviceCreateSignal}
              onCreateSignalHandled={() => setServiceCreateSignal(0)}
              viewMode={serviceViewMode}
              onViewModeChange={handleServiceViewModeChange}
              hideViewModeToggle
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

      <HostProbeServiceLatencyDialog
        open={!!probeLatencyHost}
        onOpenChange={(open) => !open && setProbeLatencyHost(null)}
        host={probeLatencyHost}
        services={probeServices as any[]}
      />
      {/* Reset Host Traffic Dialog */}
      <Dialog open={!!resetTrafficHost} onOpenChange={(open) => !open && !resetHostTrafficMutation.isPending && setResetTrafficHost(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="h-5 w-5 text-primary" />
              重置流量统计
            </DialogTitle>
            <DialogDescription>
              确认清空该主机当前累计的流量统计？
            </DialogDescription>
          </DialogHeader>
          {resetTrafficHost && (
            <div className="space-y-3 rounded-lg border border-border/40 bg-muted/20 p-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">主机</span>
                <span className="font-medium">{resetTrafficHost.name}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Agent</span>
                <span className="font-mono">{resetTrafficHost.agentVersion ? `v${resetTrafficHost.agentVersion}` : "未上报"}</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setResetTrafficHost(null)}
              disabled={resetHostTrafficMutation.isPending}
            >
              取消
            </Button>
            <Button
              className="gap-2"
              onClick={confirmResetHostTraffic}
              disabled={!resetTrafficHost || resetHostTrafficMutation.isPending}
            >
              {resetHostTrafficMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              {resetHostTrafficMutation.isPending ? "重置中..." : "确认重置"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

      {/* 编辑主机对话框 */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="flex h-[min(720px,86vh)] max-h-[86vh] flex-col overflow-hidden sm:max-w-[44rem]">
          <DialogHeader className="shrink-0 space-y-1">
            <DialogTitle>编辑主机</DialogTitle>
            <DialogDescription className="sr-only">
              修改主机信息
            </DialogDescription>
          </DialogHeader>
          <Tabs
            value={hostDialogTab}
            onValueChange={(value) => setHostDialogTab(value as HostDialogTab)}
            className="min-h-0 flex flex-1 flex-col overflow-hidden"
          >
            <TabsList className="grid h-auto w-full grid-cols-2 gap-1 rounded-md bg-muted/50 p-1">
              {HOST_DIALOG_TABS.map((item) => {
                const Icon = item.icon;
                return (
                  <TabsTrigger key={item.value} value={item.value} className="min-w-0 gap-2 px-3 py-1.5 text-sm">
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
            <div className="dialog-scroll-area mt-3 min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-4 pl-0.5 pr-7">
              <TabsContent value="basic" className="m-0 space-y-3 !animate-none">
                <section className="space-y-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <Label className="text-sm font-semibold">基础信息</Label>
                    <span className="text-xs text-muted-foreground">主机连接</span>
                  </div>
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label className="text-sm">主机名称</Label>
                      <Input
                        className="h-8"
                        placeholder="例如: 香港节点-01"
                        value={form.name}
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-sm">Agent 检测 IP</Label>
                      <Input className="h-8 bg-muted/40" value={agentDetectedIpText(displayHosts.find((host: any) => host.id === editingId) || form)} readOnly />
                    </div>
                  </div>
                  <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label className="text-sm">入口 IP / 域名</Label>
                      <Input
                        className="h-8"
                        placeholder="例如: example.com 或 1.2.3.4"
                        value={form.entryIp}
                        onChange={(e) => setForm({ ...form, entryIp: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-sm">内网地址 <span className="text-xs text-muted-foreground">可选</span></Label>
                      <Input
                        className="h-8"
                        placeholder="10.0.0.8 或 node-a.internal"
                        value={form.tunnelEntryIp}
                        onChange={(e) => setForm({ ...form, tunnelEntryIp: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label className="text-sm">网卡名称 <span className="text-xs text-muted-foreground">可选</span></Label>
                      <Input
                        className="h-8"
                        placeholder="eth0, ens33, bond0"
                        value={form.networkInterface}
                        onChange={(e) => setForm({ ...form, networkInterface: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-sm">排序 <span className="text-xs text-muted-foreground">0-200，可留空</span></Label>
                      <Input
                        className="h-8"
                        type="number"
                        min={0}
                        max={200}
                        step={1}
                        placeholder="0"
                        value={form.sortOrder}
                        onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
                      />
                    </div>
                  </div>
                </section>

                <section className="space-y-3 border-t border-border/40 pt-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <Label className="text-sm font-semibold">端口限制</Label>
                    <span className="text-xs text-muted-foreground">留空不限</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">起始端口</Label>
                      <Input
                        className="h-8"
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
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">结束端口</Label>
                      <Input
                        className="h-8"
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
                  <div className="mt-2.5 space-y-1">
                    <div className="flex items-center justify-between gap-3">
                      <Label className="text-xs text-muted-foreground">自定义端口</Label>
                      {customPortInputState.invalid.length === 0 && customPortInputState.ports.length > 0 ? (
                        <span className="text-xs text-muted-foreground">{customPortInputState.ports.length} 个</span>
                      ) : null}
                    </div>
                    <Input
                      placeholder="例如: 80,443,65095"
                      value={form.portAllowlist}
                      onChange={(e) => setForm({ ...form, portAllowlist: e.target.value })}
                      className={`h-8 ${customPortInputState.invalid.length > 0 ? "border-destructive focus-visible:ring-destructive" : ""}`}
                    />
                    {customPortInputState.invalid.length > 0 ? (
                      <p className="text-xs text-destructive">
                        自定义端口只能填写 1-65535 的整数，多个端口使用英文逗号分隔
                      </p>
                    ) : null}
                  </div>
                  {form.portRangeStart != null && form.portRangeEnd != null && form.portRangeStart > form.portRangeEnd && (
                    <p className="mt-3 text-xs text-destructive">
                      起始端口不能大于结束端口
                    </p>
                  )}
                </section>
                {user?.role === "admin" && (
                  <section className="space-y-3 border-t border-border/40 pt-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <Label className="text-sm font-semibold">协议屏蔽</Label>
                      <span className="text-xs text-muted-foreground">访问策略</span>
                    </div>
                    <p className="rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                      协议屏蔽支持自定义加密隧道，以及 realm / gost / socat / nginx 等用户态转发；iptables / nftables 内核转发暂不支持。
                    </p>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <label className="flex min-w-0 items-center justify-between gap-3 rounded-md bg-muted/35 px-2.5 py-2">
                        <span className="min-w-0 truncate text-sm font-medium">HTTP</span>
                        <Switch className="shrink-0" checked={form.blockHttp} onCheckedChange={(checked) => setForm({ ...form, blockHttp: checked })} />
                      </label>
                      <label className="flex min-w-0 items-center justify-between gap-3 rounded-md bg-muted/35 px-2.5 py-2">
                        <span className="min-w-0 truncate text-sm font-medium">SOCKS</span>
                        <Switch className="shrink-0" checked={form.blockSocks} onCheckedChange={(checked) => setForm({ ...form, blockSocks: checked })} />
                      </label>
                      <label className="flex min-w-0 items-center justify-between gap-3 rounded-md bg-muted/35 px-2.5 py-2">
                        <span className="min-w-0 truncate text-sm font-medium">TLS</span>
                        <Switch className="shrink-0" checked={form.blockTls} onCheckedChange={(checked) => setForm({ ...form, blockTls: checked })} />
                      </label>
                    </div>
                  </section>
                )}
              </TabsContent>

              <TabsContent value="other" className="m-0 !animate-none">
                <section className="space-y-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <Label className="text-sm font-semibold">其他配置</Label>
                    <span className="text-xs text-muted-foreground">主机统计</span>
                  </div>
                  {user?.role === "admin" ? (
                    <>
                      <div className="grid min-w-0 gap-2.5 px-1 md:grid-cols-2">
                        <div className="space-y-1">
                          <Label className="text-sm">机器购买时间</Label>
                          <DateTimePickerInput
                            value={form.purchasedAt}
                            onChange={(value) => setForm({ ...form, purchasedAt: value })}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-sm">机器停止时间</Label>
                          <DateTimePickerInput
                            value={form.stoppedAt}
                            onChange={(value) => setForm({ ...form, stoppedAt: value })}
                            align="end"
                          />
                        </div>
                        <div className="min-w-0 space-y-1">
                          <Label className="text-sm">套餐流量</Label>
                          <div className="flex h-8 min-w-0 overflow-hidden rounded-md border border-input bg-background focus-within:border-ring focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring">
                            <Input
                              className="h-8 min-w-0 flex-1 rounded-none border-0 bg-transparent px-3 py-1 focus-visible:border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                              type="text"
                              inputMode="decimal"
                              placeholder="例如: 2000"
                              value={form.trafficLimitGb}
                              onChange={(e) => setForm({ ...form, trafficLimitGb: e.target.value })}
                            />
                            <span className="flex h-full shrink-0 items-center border-l border-border/60 bg-muted/50 px-2.5 text-sm text-muted-foreground">
                              GB
                            </span>
                          </div>
                        </div>
                        <div className="min-w-0 space-y-1">
                          <Label className="text-sm">流量计算</Label>
                          <Select
                            value={form.trafficMeasureMode}
                            onValueChange={(value) => setForm({ ...form, trafficMeasureMode: normalizeHostTrafficMeasureMode(value) })}
                          >
                            <SelectTrigger className="h-8 min-w-0">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="outbound">仅出向</SelectItem>
                              <SelectItem value="both">双向</SelectItem>
                              <SelectItem value="max">取最大值</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div className="mt-2.5 flex min-h-9 flex-col gap-2 rounded-md bg-muted/35 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 space-y-0.5">
                          <Label className="text-sm font-medium">流量耗尽提醒</Label>
                          <p className="text-xs text-muted-foreground">
                            {telegramBotReady ? "开启后通过 TG 机器人发送提醒。" : "请先在系统设置内配置并启用 TG 机器人。"}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <div className="flex h-8 w-20 overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                            <Input
                              className="h-8 rounded-none border-0 px-2 text-right focus-visible:ring-0 focus-visible:ring-offset-0"
                              type="number"
                              min={1}
                              max={99}
                              step={1}
                              value={form.trafficAlertThresholdPercent}
                              onChange={(e) => setForm({ ...form, trafficAlertThresholdPercent: clampTrafficAlertThresholdPercent(Number(e.target.value)) })}
                            />
                            <span className="flex h-8 shrink-0 items-center border-l border-border/60 bg-muted/50 px-1.5 text-sm text-muted-foreground">%</span>
                          </div>
                          <Switch
                            checked={telegramBotReady && form.telegramTrafficAlertEnabled}
                            disabled={!telegramBotReady}
                            onCheckedChange={(checked) => setForm({ ...form, telegramTrafficAlertEnabled: checked })}
                          />
                        </div>
                      </div>
                      <div className="mt-2.5 flex min-h-9 flex-col gap-2 rounded-md bg-muted/35 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 space-y-0.5">
                          <Label className="text-sm font-medium">续费提醒</Label>
                          <p className="text-xs text-muted-foreground">
                            {telegramBotReady ? "机器剩余日期不足指定天数时通过 TG 机器人提醒。" : "请先在系统设置内配置并启用 TG 机器人。"}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <div className="flex h-8 w-24 overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                            <Input
                              className="h-8 rounded-none border-0 px-2 text-right focus-visible:ring-0 focus-visible:ring-offset-0"
                              type="number"
                              min={1}
                              max={365}
                              step={1}
                              value={form.renewalReminderDays}
                              onChange={(e) => setForm({ ...form, renewalReminderDays: clampRenewalReminderDays(Number(e.target.value)) })}
                            />
                            <span className="flex h-8 shrink-0 items-center border-l border-border/60 bg-muted/50 px-2 text-sm text-muted-foreground">天</span>
                          </div>
                          <Switch
                            checked={telegramBotReady && form.telegramRenewalReminderEnabled}
                            disabled={!telegramBotReady}
                            onCheckedChange={(checked) => setForm({ ...form, telegramRenewalReminderEnabled: checked })}
                          />
                        </div>
                      </div>
                      <div className="mt-2.5 flex min-h-9 flex-col gap-2 rounded-md bg-muted/35 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <Label className="text-sm font-medium">自动重置流量</Label>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Select
                            value={String(clampMonthlyResetDay(form.trafficResetDay))}
                            onValueChange={(value) => setForm({ ...form, trafficResetDay: clampMonthlyResetDay(Number(value)) })}
                          >
                            <SelectTrigger className="h-8 w-24">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                                <SelectItem key={day} value={String(day)}>{day} 号</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Switch checked={form.trafficAutoReset} onCheckedChange={(checked) => setForm({ ...form, trafficAutoReset: checked })} />
                        </div>
                      </div>
                      <p className="mt-1.5 px-3 text-xs text-muted-foreground">当月没有该日期时按最后一天重置。</p>
                      <div className="mt-2.5 space-y-2 rounded-md bg-muted/35 px-3 py-2.5">
                        <div className="flex min-h-8 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex min-w-0 items-center gap-2">
                            <RadioTower className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <Label className="text-sm font-medium">DDNS 服务</Label>
                            {!ddnsProviderEnabled ? (
                              <Badge variant="secondary" className="shrink-0 text-[11px]">未配置服务商</Badge>
                            ) : null}
                          </div>
                          <Switch
                            checked={form.ddnsEnabled}
                            disabled={!ddnsProviderEnabled && !form.ddnsEnabled}
                            onCheckedChange={(checked) => setForm({ ...form, ddnsEnabled: checked })}
                          />
                        </div>
                        <div className="grid min-w-0 gap-2.5 sm:grid-cols-[8rem_minmax(0,1fr)]">
                          <Select
                            value={form.ddnsIpVersion}
                            disabled={!ddnsProviderEnabled}
                            onValueChange={(value) => setForm({ ...form, ddnsIpVersion: normalizeHostDdnsIpVersion(value) })}
                          >
                            <SelectTrigger className="h-8 min-w-0">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="ipv4">IPv4 / A</SelectItem>
                              <SelectItem value="ipv6">IPv6 / AAAA</SelectItem>
                            </SelectContent>
                          </Select>
                          <Input
                            className="h-8 min-w-0"
                            placeholder="例如: node.example.com"
                            value={form.ddnsDomain}
                            disabled={!ddnsProviderEnabled}
                            onChange={(e) => setForm({ ...form, ddnsDomain: e.target.value })}
                          />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          开启后，Agent 上报的对应 IP 发生变化时会自动更新到系统设置中的 DDNS 服务商。
                        </p>
                      </div>
                    </>
                  ) : (
                    <div className="rounded-md bg-muted/35 px-3 py-2 text-sm text-muted-foreground">
                      仅管理员可配置主机其他配置。
                    </div>
                  )}
                </section>
              </TabsContent>

            </div>
          </Tabs>
          <DialogFooter className="shrink-0 pt-2">
            <Button variant="outline" onClick={() => setShowDialog(false)}>
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={isPending || !form.name}>
              {isPending ? "处理中..." : "保存"}
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
