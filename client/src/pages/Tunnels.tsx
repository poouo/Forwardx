import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import AutoAnimateContainer from "@/components/AutoAnimateContainer";
import { LatencyRating } from "@/components/LatencyRating";
import { LatencyPeakCutToggle } from "@/components/LatencyPeakCutToggle";
import { LatencyStabilityStats } from "@/components/LatencyStabilityStats";
import type { LinkCreateType } from "@/components/LinkCreateTypeSelector";
import { LinkTestProbeView, getLinkTestTotalLatency, hasPendingLinkTestDetails, parseLinkTestMessage, type LinkTestPlannedSegment } from "@/components/LinkTestLatencySummary";
import { PersistentPagination, usePersistentPagination } from "@/components/PersistentPagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { segmentedControlClassName, segmentedIconClassName, segmentedOptionClassName } from "@/components/ui/segmented";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { SlidingTabsList, type SlidingTabItem } from "@/components/ui/sliding-tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import DataSectionLoading from "@/components/DataSectionLoading";
import { countryFeatureHasCode, normalizeCountryCode, type CountryFeatureLike } from "@/lib/countryFeatures";
import { applyLatencyPeakCut, clipLatencyForChart, getLatencyStabilityStats, getLatencyYAxisMax, getLatencyYAxisTicks, isLatencySeriesCacheFresh } from "@/lib/latencyChart";
import { useUrlTab } from "@/hooks/useUrlTab";
import { addHostNodeMeta, hostDisplayName } from "@/lib/linkTestNodeMeta";
import { pollingInterval } from "@/lib/polling";
import { getTunnelExitNames, getTunnelHopIds, getTunnelLoadBalanceExitNames, getTunnelRouteText, tunnelHopHostName } from "@/lib/tunnelDisplay";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  ArrowRight,
  ArrowRightLeft,
  ChevronRight,
  Globe,
  LayoutGrid,
  List,
  Loader2,
  LogIn,
  LogOut,
  Network,
  Server,
  Pencil,
  Plus,
  Route,
  ShieldCheck,
  Stethoscope,
  Trash2,
  XCircle,
} from "lucide-react";
import type { GlobeMethods } from "react-globe.gl";
import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  FORWARD_PROTOCOL_LABELS,
  FORWARD_TYPE_LABELS,
  FORWARD_TYPES,
  isNginxForwardProtocolEnabled,
  normalizeForwardProtocolSettings,
  type ForwardProtocolKey,
  type ForwardType,
} from "@shared/forwardTypes";
import {
  trafficMultiplierFromInput,
  trafficMultiplierToInputValue,
} from "@shared/trafficMultiplier";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import MultiHopEditor from "@/components/MultiHopEditor";
import { ForwardGroupsContent } from "@/pages/ForwardGroups";

const loadReactGlobe = () => import("react-globe.gl");
const ReactGlobe = lazy(loadReactGlobe) as typeof import("react-globe.gl").default;

function TunnelSectionTransition({
  transitionKey,
  children,
}: {
  transitionKey: string;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={transitionKey}
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.995 }}
        animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.995 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

type TunnelForm = {
  name: string;
  entryGroupId: number | null;
  entryHostId: number | null;
  exitHostId: number | null;
  hopHostIds: number[];
  hopConnectHosts: Array<string | null>;
  mode: "forwardx" | "tls" | "wss" | "tcp" | "mtls" | "mwss" | "mtcp" | "nginx_stream" | "nginx_tls";
  certDomain: string;
  certPem: string;
  certKeyPem: string;
  listenPort: number;
  rateLimitMbps: number;
  trafficMultiplier: number;
  networkType: "public" | "private";
  connectHost: string;
  proxyProtocolReceive: boolean;
  proxyProtocolSend: boolean;
  proxyProtocolExitReceive: boolean;
  proxyProtocolExitSend: boolean;
  proxyProtocolVersion: 1 | 2;
  tcpFastOpen: boolean;
  udpOverTcp: boolean;
  loadBalanceEnabled: boolean;
  loadBalanceStrategy: "round_robin" | "random" | "least_conn" | "ip_hash" | "fallback";
  loadBalanceExits: Array<{ hostId: number | null; connectHost: string }>;
  exitGroupId: number | null;
  blockHttp: boolean;
  blockSocks: boolean;
  blockTls: boolean;
};

type ChainCreateForm = {
  name: string;
  entryGroupId: number | null;
  hopHostIds: number[];
  hopConnectHosts: Array<string | null>;
  forwardType: ForwardType;
  proxyProtocolReceive: boolean;
  proxyProtocolSend: boolean;
  proxyProtocolVersion: 1 | 2;
  tcpFastOpen: boolean;
  zeroCopy: boolean;
  trafficMultiplier: number;
  isEnabled: boolean;
};

type TunnelLatencyPoint = {
  label: string;
  fullLabel: string;
  [key: string]: string | number | boolean | null | undefined;
};

function normalizePemText(value: unknown) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

type TunnelLatencySeriesDatum = {
  recordedAt: string | Date;
  latencyMs?: number | null;
  isTimeout?: boolean | null;
  seriesKey?: string | null;
  seriesLabel?: string | null;
};

type TunnelLatencySeriesMeta = {
  key: string;
  dataKey: string;
  rawKey: string;
  timeoutKey: string;
  label: string;
  color: string;
};

type TunnelGlobeHostPoint = {
  pointKind?: "host";
  host: any;
  id: number;
  name: string;
  lat: number;
  lng: number;
  regionText: string;
};

type TunnelGlobeLink = {
  id: string;
  kind: "tunnel" | "chain";
  item: any;
  name: string;
  routeText: string;
  routeHosts: TunnelGlobeHostPoint[];
  statusText: string;
  latencyText: string;
  color: string;
  trackColor: string;
  glowColor: string;
};

type TunnelGlobePath = {
  link: TunnelGlobeLink;
  segmentIndex: number;
  layerIndex: number;
  layerCount: number;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  altitude: number;
  coords: Array<{ lat: number; lng: number; alt: number }>;
};

type TunnelGlobeCountryFeature = CountryFeatureLike & {
  type: "Feature";
  geometry: {
    type: string;
    coordinates: unknown;
  };
};

const tunnelLatencyColors = [
  "var(--color-chart-2)",
  "var(--color-chart-1)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "var(--color-primary)",
  "#f97316",
];

function normalizeTunnelLatencySeriesKey(value: unknown) {
  const key = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return key || "total";
}

function tunnelLatencySeriesDisplayName(key: string, label?: string | null) {
  const cleanLabel = String(label || "").trim();
  if (cleanLabel) return cleanLabel;
  if (key === "total") return "总延迟";
  if (key === "primary") return "主出口";
  return key.replace(/^exit-/, "出口 ");
}
const tunnelLatencySeriesCache = new Map<number, TunnelLatencySeriesDatum[]>();
const tunnelLatencyAnimatedKeys = new Set<number>();
const TUNNEL_GLOBE_EARTH_IMAGE_URL = "/globe/earth-dark.jpg";
const TUNNEL_GLOBE_COUNTRIES_URL = "/globe/ne_110m_admin_0_countries.geojson";
const TUNNEL_GLOBE_PATH_SURFACE_ALTITUDE = 0.026;
const TUNNEL_GLOBE_PATH_MIN_ALTITUDE = 0.038;
const TUNNEL_GLOBE_PATH_MAX_ALTITUDE = 0.082;
const TUNNEL_GLOBE_PATH_LAYER_ALTITUDE_STEP = 0.005;
const TUNNEL_GLOBE_PATH_LAYER_ALTITUDE_MAX = 0.014;
let reactGlobePrefetchStarted = false;

const defaultForm: TunnelForm = {
  name: "",
  entryGroupId: null,
  entryHostId: null,
  exitHostId: null,
  hopHostIds: [],
  hopConnectHosts: [],
  mode: "forwardx",
  certDomain: "",
  certPem: "",
  certKeyPem: "",
  listenPort: 0,
  rateLimitMbps: 0,
  trafficMultiplier: 1,
  networkType: "public",
  connectHost: "",
  proxyProtocolReceive: false,
  proxyProtocolSend: false,
  proxyProtocolExitReceive: false,
  proxyProtocolExitSend: false,
  proxyProtocolVersion: 1,
  tcpFastOpen: false,
  udpOverTcp: false,
  loadBalanceEnabled: false,
  loadBalanceStrategy: "round_robin",
  loadBalanceExits: [],
  exitGroupId: null,
  blockHttp: false,
  blockSocks: false,
  blockTls: false,
};

const defaultChainCreateForm: ChainCreateForm = {
  name: "",
  entryGroupId: null,
  hopHostIds: [],
  hopConnectHosts: [],
  forwardType: "iptables",
  proxyProtocolReceive: false,
  proxyProtocolSend: false,
  proxyProtocolVersion: 1,
  tcpFastOpen: false,
  zeroCopy: false,
  trafficMultiplier: 1,
  isEnabled: true,
};

function isValidPort(port: number, allowZero = false) {
  return Number.isInteger(port) && port >= (allowZero ? 0 : 1) && port <= 65535;
}

function isValidConnectHost(value: string) {
  // 接受 IP 地址或域名。简单验证：非空，不含危险字符。
  const v = value.trim();
  if (!v) return false;
  // Quick sanity: reject strings with obviously invalid characters
  if (/[\s'"<>]/.test(v)) return false;
  if (v.length > 253) return false;
  return true;
}

function sameNumberArray(a: number[], b: number[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameNullableStringArray(a: Array<string | null>, b: Array<string | null>) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if ((a[i] || null) !== (b[i] || null)) return false;
  }
  return true;
}

function addressKey(value: unknown) {
  const text = String(value || "").trim();
  const unwrapped = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1).trim() : text;
  return unwrapped.toLowerCase();
}

function sameAddress(a: unknown, b: unknown) {
  const left = addressKey(a);
  const right = addressKey(b);
  return !!left && !!right && left === right;
}

function normalizeHopConnectHosts(
  raw: Array<string | null>,
  hostCount: number,
): Array<string | null> {
  const next = [...raw].slice(0, Math.max(0, hostCount));
  while (next.length < hostCount) next.push(null);
  if (hostCount > 0) next[0] = null;
  return next;
}

function hostPublicAddress(host: any) {
  return String(host?.entryIp || host?.ipv4 || host?.ipv6 || host?.ip || "").trim();
}

function hostPrivateAddress(host: any) {
  return String(host?.tunnelEntryIp || "").trim();
}

function hostIpv6Address(host: any) {
  return String(host?.ipv6 || "").trim();
}

function normalizeConnectHostForHost(value: unknown, host: any, fallback: string | null = null) {
  const text = String(value || "").trim();
  if (!text) return fallback;
  const privateAddr = hostPrivateAddress(host);
  const ipv6Addr = hostIpv6Address(host);
  if (privateAddr && sameAddress(text, privateAddr)) return privateAddr;
  if (ipv6Addr && sameAddress(text, ipv6Addr)) return ipv6Addr;
  return fallback;
}

function normalizeHopConnectHostsForHosts(
  raw: Array<string | null>,
  hopHostIds: number[],
  hosts: any[] | undefined,
  externalEntry = false,
): Array<string | null> {
  const base = normalizeHopConnectHosts(raw, hopHostIds.length);
  if (externalEntry && hopHostIds.length > 0) base[0] = raw[0] || null;
  const hostById = new Map((hosts || []).map((host: any) => [Number(host.id), host]));
  return base.map((value, idx) => {
    if (idx === 0 && !externalEntry) return null;
    const host = hostById.get(Number(hopHostIds[idx] || 0));
    const publicAddr = hostPublicAddress(host);
    return normalizeConnectHostForHost(value, host, publicAddr || null);
  });
}

function normalizeChainConnectHostsForHosts(
  raw: Array<string | null>,
  hopHostIds: number[],
  hosts: any[] | undefined,
  externalEntry = false,
): Array<string | null> {
  const base = normalizeHopConnectHosts(raw, hopHostIds.length);
  if (externalEntry && hopHostIds.length > 0) base[0] = raw[0] || null;
  const hostById = new Map((hosts || []).map((host: any) => [Number(host.id), host]));
  return base.map((value, idx) => {
    if (idx === 0 && !externalEntry) return null;
    const host = hostById.get(Number(hopHostIds[idx] || 0));
    return normalizeConnectHostForHost(value, host, null);
  });
}

function hostGeoCoordinate(host: any) {
  if (host?.geoLatitudeMicro == null || host?.geoLongitudeMicro == null) return null;
  const lat = Number(host.geoLatitudeMicro) / 1_000_000;
  const lng = Number(host.geoLongitudeMicro) / 1_000_000;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function hostRegionText(host: any) {
  return [host?.geoCountryName || host?.geoCountryCode, host?.geoRegion]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" / ");
}

function hostCountryCode(host: any) {
  return normalizeCountryCode(host?.geoCountryCode);
}

function createTunnelGlobeHostPoint(host: any): TunnelGlobeHostPoint | null {
  const coord = hostGeoCoordinate(host);
  if (!coord) return null;
  const name = String(host?.name || host?.ip || `主机 #${host?.id || "-"}`).trim();
  return {
    host,
    id: Number(host.id),
    name,
    lat: coord.lat,
    lng: coord.lng,
    regionText: hostRegionText(host),
  };
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

function formatGlobeLatency(value: unknown, timeout?: unknown) {
  if (timeout) return "不可达";
  const latency = Number(value);
  return Number.isFinite(latency) && latency >= 0 ? `${Math.round(latency)}ms` : "未测试";
}

function hasLatestTunnelLatency(tunnel: any) {
  return tunnel?.latestLatencyAt != null
    || tunnel?.latestLatencyMs != null
    || tunnel?.latestLatencyIsTimeout === true;
}

function tunnelManualTestLatencyMs(tunnel: any) {
  const value = tunnel?.lastLatencyMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Number(value) : null;
}

function tunnelLatestStatLatencyMs(tunnel: any) {
  const value = tunnel?.latestLatencyMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Number(value) : null;
}

function tunnelSeriesLatencyEntries(tunnel: any) {
  if (!Array.isArray(tunnel?.latestLatencySeries)) return [];
  return tunnel.latestLatencySeries
    .map((item: any) => ({
      key: normalizeTunnelLatencySeriesKey(item?.seriesKey),
      label: tunnelLatencySeriesDisplayName(normalizeTunnelLatencySeriesKey(item?.seriesKey), item?.seriesLabel),
      latencyMs: typeof item?.latencyMs === "number" && Number.isFinite(item.latencyMs) ? Number(item.latencyMs) : null,
      isTimeout: !!item?.isTimeout,
    }))
    .filter((item: any) => item.key !== "total");
}

function hasStructuredTunnelTestMessage(parsed: ReturnType<typeof parseLinkTestMessage>) {
  return !!parsed?.details?.length || typeof parsed?.totalLatencyMs === "number";
}

function tunnelDisplayLatencyMs(tunnel: any) {
  const parsed = parseLinkTestMessage(tunnel?.lastTestMessage);
  const structuredMessage = hasStructuredTunnelTestMessage(parsed);
  const manualFallback = tunnelManualTestLatencyMs(tunnel);
  const latestFallback = tunnelLatestStatLatencyMs(tunnel);
  const status = String(tunnel?.lastTestStatus || "");
  const isSuccess = status === "success";
  const isFailed = status === "failed";
  const latency = getLinkTestTotalLatency({
    parsed,
    fallbackLatencyMs: manualFallback,
    isSuccess: isSuccess || (!structuredMessage && !isFailed && manualFallback !== null),
  });
  if (structuredMessage || isSuccess || isFailed || latency !== null) return latency;
  if (latestFallback !== null) return latestFallback;
  return manualFallback;
}

function tunnelDisplayLatencyList(tunnel: any) {
  const entries = tunnelSeriesLatencyEntries(tunnel);
  if (entries.length === 0) {
    const value = tunnelDisplayLatencyMs(tunnel);
    return typeof value === "number" && Number.isFinite(value)
      ? [{ label: "总延迟", latencyMs: value, isTimeout: false, key: "total" }]
      : tunnelLatencyIsTimeout(tunnel)
        ? [{ label: "总延迟", latencyMs: null, isTimeout: true, key: "total" }]
        : [];
  }
  const total = tunnel?.latestLatencyMs;
  const totalEntry = typeof total === "number" && Number.isFinite(total)
    ? [{ label: "总延迟", latencyMs: Number(total), isTimeout: !!tunnel?.latestLatencyIsTimeout, key: "total" }]
    : [];
  return [...totalEntry, ...entries];
}

function tunnelLatencyIsTimeout(tunnel: any) {
  const value = tunnelDisplayLatencyMs(tunnel);
  const hasLatency = typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (hasLatency) return false;
  const parsed = parseLinkTestMessage(tunnel?.lastTestMessage);
  const visibleDetails = (parsed.details || []).filter((detail) => (
    detail.pending
    || detail.success
    || detail.message
    || (typeof detail.latencyMs === "number" && Number.isFinite(detail.latencyMs))
  ));
  if (visibleDetails.some((detail) => detail.pending)) return false;
  if (visibleDetails.length > 0) {
    return String(tunnel?.lastTestStatus || "") === "failed" || visibleDetails.some((detail) => !detail.success);
  }
  if (String(tunnel?.lastTestStatus || "") === "failed") return true;
  if (hasLatestTunnelLatency(tunnel)) return !!tunnel?.latestLatencyIsTimeout;
  return !!tunnel?.latestLatencyIsTimeout;
}
function normalizeLongitude(lng: number) {
  if (lng < -180) return lng + 360;
  if (lng > 180) return lng - 360;
  return lng;
}

function longitudeDeltaDegrees(from: number, to: number) {
  let delta = to - from;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

function globeDistanceDegrees(start: Pick<TunnelGlobePath, "startLat" | "startLng" | "endLat" | "endLng">) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const lat1 = toRad(start.startLat);
  const lat2 = toRad(start.endLat);
  const lng1 = toRad(start.startLng);
  const lng2 = toRad(start.endLng);
  const angle = Math.acos(Math.min(1, Math.max(-1, Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1))));
  return (angle * 180) / Math.PI;
}

function tunnelGlobeArcLayerKey(start: TunnelGlobeHostPoint, end: TunnelGlobeHostPoint) {
  const a = `${start.id}:${start.lat.toFixed(3)}:${start.lng.toFixed(3)}`;
  const b = `${end.id}:${end.lat.toFixed(3)}:${end.lng.toFixed(3)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function createTunnelGlobePathCoords(path: Pick<TunnelGlobePath, "startLat" | "startLng" | "endLat" | "endLng" | "altitude" | "layerIndex" | "layerCount">) {
  const dLat = path.endLat - path.startLat;
  const dLng = longitudeDeltaDegrees(path.startLng, path.endLng);
  const midLat = (path.startLat + path.endLat) / 2;
  const midLng = normalizeLongitude(path.startLng + dLng / 2);
  const lngScale = Math.max(0.35, Math.cos((midLat * Math.PI) / 180));
  const projectedLng = dLng * lngScale;
  const distance = Math.sqrt(dLat * dLat + projectedLng * projectedLng);
  const layerOffset = path.layerIndex - (path.layerCount - 1) / 2;
  const sideSpacing = path.layerCount > 1 ? Math.min(7.5, Math.max(1.8, globeDistanceDegrees(path) / 24)) : 0;
  const offset = layerOffset * sideSpacing;
  const offsetLat = distance > 0 ? (projectedLng / distance) * offset : 0;
  const offsetLng = distance > 0 ? (-dLat / (distance * lngScale)) * offset : 0;

  return [
    { lat: path.startLat, lng: path.startLng, alt: TUNNEL_GLOBE_PATH_SURFACE_ALTITUDE },
    { lat: Math.max(-85, Math.min(85, midLat + offsetLat)), lng: normalizeLongitude(midLng + offsetLng), alt: path.altitude },
    { lat: path.endLat, lng: path.endLng, alt: TUNNEL_GLOBE_PATH_SURFACE_ALTITUDE },
  ];
}

function renderTunnelGlobeLinkTooltip(link: TunnelGlobeLink) {
  const routeNodes = link.routeHosts.map((host, index) => `${index + 1}. ${host.name}`).join(" -> ");
  const rows = [
    { label: "类型", value: link.kind === "tunnel" ? "隧道链路" : "端口转发链" },
    { label: "状态", value: link.statusText },
    { label: "延迟", value: link.latencyText },
    { label: "链路", value: link.routeText },
    { label: "节点", value: routeNodes },
  ];
  return `
    <div style="min-width:280px;max-width:360px;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(8,13,24,.94);box-shadow:0 18px 44px rgba(0,0,0,.42);backdrop-filter:blur(10px);color:#f8fafc;padding:12px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;">
        <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:700;">${escapeTooltipHtml(link.name)}</div>
        <div style="display:flex;align-items:center;gap:6px;color:#cbd5e1;font-size:12px;">
          <span style="width:8px;height:8px;border-radius:999px;background:${link.color};box-shadow:0 0 14px ${link.glowColor};"></span>
          ${escapeTooltipHtml(link.kind === "tunnel" ? "隧道" : "转发链")}
        </div>
      </div>
      ${rows.map((row) => `
        <div style="display:grid;grid-template-columns:42px minmax(0,1fr);gap:8px;align-items:start;margin-top:6px;font-size:12px;line-height:1.45;">
          <span style="color:#94a3b8;">${escapeTooltipHtml(row.label)}</span>
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;color:#e2e8f0;">${escapeTooltipHtml(row.value)}</span>
        </div>
      `).join("")}
      <div style="margin-top:10px;color:#93c5fd;font-size:12px;">点击编辑</div>
    </div>
  `;
}

function renderTunnelGlobeHostTooltip(point: TunnelGlobeHostPoint) {
  return `
    <div style="min-width:220px;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(8,13,24,.94);box-shadow:0 18px 44px rgba(0,0,0,.42);color:#f8fafc;padding:10px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
      <div style="font-size:13px;font-weight:700;">${escapeTooltipHtml(point.name)}</div>
      <div style="margin-top:6px;color:#cbd5e1;font-size:12px;">${escapeTooltipHtml(point.regionText || "地区获取中")}</div>
    </div>
  `;
}

function buildTunnelGlobeDataKey(tunnels: any[], chainGroups: any[], hosts: any[], isTunnelSupported: (tunnel: any) => boolean) {
  const hostParts = (hosts || [])
    .map((host: any) => [
      Number(host?.id || 0),
      host?.name || "",
      host?.ip || "",
      host?.geoLatitudeMicro ?? "",
      host?.geoLongitudeMicro ?? "",
      host?.geoCountryCode || "",
      host?.geoCountryName || "",
      host?.geoRegion || "",
    ].join(":"))
    .sort();
  const tunnelParts = (tunnels || [])
    .map((tunnel: any) => [
      Number(tunnel?.id || 0),
      tunnel?.name || "",
      tunnel?.mode || "",
      Number(!!isTunnelSupported(tunnel)),
      Number(!!tunnel?.isRunning),
      Number(!!tunnel?.isEnabled),
      getTunnelHopIds(tunnel).join(">"),
    ].join(":"))
    .sort();
  const chainParts = (chainGroups || [])
    .map((group: any) => [
      Number(group?.id || 0),
      group?.name || "",
      Number(!!group?.isEnabled),
      [...(group?.members || [])]
        .sort((a: any, b: any) => Number(a?.priority || 0) - Number(b?.priority || 0))
        .map((member: any) => `${Number(member?.hostId || 0)}:${Number(member?.priority || 0)}`)
        .join(">"),
    ].join(":"))
    .sort();
  return [hostParts.join("|"), tunnelParts.join("|"), chainParts.join("|")].join("\n");
}

const tunnelModeLabels: Record<TunnelForm["mode"], string> = {
  forwardx: "ForwardX",
  tls: "TLS",
  wss: "WSS",
  tcp: "TCP",
  mtls: "MTLS",
  mwss: "MWSS",
  mtcp: "MTCP",
  nginx_stream: "Stream",
  nginx_tls: "Stream",
};

const gostTunnelModes: TunnelForm["mode"][] = ["tls", "wss", "tcp", "mtls", "mwss", "mtcp"];
const nginxTunnelModes: TunnelForm["mode"][] = ["nginx_stream"];
const tunnelLoadBalanceStrategyLabels: Record<TunnelForm["loadBalanceStrategy"], string> = {
  round_robin: "轮询",
  random: "随机",
  least_conn: "最少连接",
  ip_hash: "IP 哈希",
  fallback: "主备",
};
const unsupportedProtocolTitle = "当前不支持，请联系管理员";

function isNginxTunnelModeValue(mode: unknown) {
  const normalized = String(mode || "").toLowerCase();
  return normalized === "nginx_stream" || normalized === "nginx_tls";
}

function isTunnelProxyProtocolSupported(mode: unknown) {
  const normalized = normalizeTunnelModeForForm(mode);
  return normalized === "forwardx" || gostTunnelModes.includes(normalized);
}

function isTunnelTransportTuningSupported(mode: unknown) {
  return normalizeTunnelModeForForm(mode) === "forwardx";
}

function normalizeTunnelModeForForm(mode: unknown): TunnelForm["mode"] {
  const normalized = String(mode || "").toLowerCase();
  if (normalized === "nginx_tls") return "nginx_stream";
  return (["forwardx", "tls", "wss", "tcp", "mtls", "mwss", "mtcp", "nginx_stream"] as const).includes(normalized as any)
    ? normalized as TunnelForm["mode"]
    : "forwardx";
}

function getTunnelModeDisplay(mode: unknown, showNginxLabel = true) {
  const normalized = String(mode || "").toLowerCase() as TunnelForm["mode"];
  const label = tunnelModeLabels[normalized] || String(mode || "").toUpperCase();
  if (isNginxTunnelModeValue(normalized)) return showNginxLabel ? "Nginx" : "Stream";
  return gostTunnelModes.includes(normalized) ? `GOST ${label}` : label;
}

type TunnelViewMode = "card" | "table" | "globe";
type TunnelSection = "tunnels" | "ports" | "chains" | "groups" | "entries" | "exits";
type TunnelGroupMode = "port" | "failover" | "entry" | "exit";

const TUNNEL_SECTIONS = ["tunnels", "ports", "chains", "groups", "entries", "exits"] as const;
const TUNNEL_SECTION_ITEMS = [
  { value: "tunnels", label: "隧道链路", icon: Network },
  { value: "ports", label: "端口转发", icon: ArrowRightLeft },
  { value: "chains", label: "转发链", icon: Route },
  { value: "groups", label: "转发组", icon: ShieldCheck },
  { value: "entries", label: "入口组", icon: LogIn },
  { value: "exits", label: "出口组", icon: LogOut },
] as const satisfies readonly SlidingTabItem<TunnelSection>[];

const TUNNEL_SECTION_STORAGE_KEY = "forwardx.tunnels.section";
const TUNNEL_VIEW_MODE_STORAGE_KEY = "forwardx.tunnels.viewMode";
const CHAIN_VIEW_MODE_STORAGE_KEY = "forwardx.forwardGroups.viewMode";
const MAX_TUNNEL_HOPS = 10;
const MAX_EXTRA_TUNNEL_EXITS = 4;

function getStoredTunnelViewMode(): TunnelViewMode {
  if (typeof window === "undefined") return "card";
  try {
    const value = window.localStorage.getItem(TUNNEL_VIEW_MODE_STORAGE_KEY);
    return value === "table" || value === "globe" ? value : "card";
  } catch {
    return "card";
  }
}

function storeTunnelViewMode(viewMode: TunnelViewMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TUNNEL_VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // Ignore storage failures so the page still works in restricted browsers.
  }
}

function getStoredChainViewMode(): TunnelViewMode {
  if (typeof window === "undefined") return "card";
  try {
    const value = window.localStorage.getItem(CHAIN_VIEW_MODE_STORAGE_KEY);
    return value === "table" || value === "globe" ? value : "card";
  } catch {
    return "card";
  }
}

function storeChainViewMode(viewMode: TunnelViewMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHAIN_VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // Ignore storage failures so the page still works in restricted browsers.
  }
}


function prefetchReactGlobe() {
  if (reactGlobePrefetchStarted || typeof window === "undefined") return;
  reactGlobePrefetchStarted = true;
  const startPrefetch = () => {
    loadReactGlobe().catch(() => {
      reactGlobePrefetchStarted = false;
    });
  };
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(startPrefetch, { timeout: 2200 });
  } else {
    globalThis.setTimeout(startPrefetch, 700);
  }
}

function formatTunnelLatencyTime(value: string | Date) {
  const d = new Date(value);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const minute = String(d.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hour}:${minute}`;
}

function TunnelWorldGlobe({
  tunnels,
  chainGroups,
  hosts,
  isTunnelSupported,
  onEditTunnel,
  onEditChain,
}: {
  tunnels: any[];
  chainGroups: any[];
  hosts: any[];
  isTunnelSupported: (tunnel: any) => boolean;
  onEditTunnel: (tunnel: any) => void;
  onEditChain: (group: any) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const [globeReady, setGlobeReady] = useState(false);
  const [size, setSize] = useState({ width: 1400, height: 780 });
  const [hoveredLink, setHoveredLink] = useState<TunnelGlobeLink | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<TunnelGlobeHostPoint | null>(null);
  const [countries, setCountries] = useState<TunnelGlobeCountryFeature[]>([]);
  const globeDataKey = useMemo(
    () => buildTunnelGlobeDataKey(tunnels, chainGroups, hosts, isTunnelSupported),
    [chainGroups, hosts, isTunnelSupported, tunnels]
  );

  const globeData = useMemo(() => {
    const hostById = new Map<number, any>((hosts || []).map((host: any) => [Number(host.id), host]));
    const hostPointById = new Map<number, TunnelGlobeHostPoint>();
    const pointForHostId = (hostId: number) => {
      if (hostPointById.has(hostId)) return hostPointById.get(hostId) || null;
      const point = createTunnelGlobeHostPoint(hostById.get(hostId));
      if (point) hostPointById.set(hostId, point);
      return point;
    };

    const links: TunnelGlobeLink[] = [];
    let skipped = 0;

    (tunnels || []).forEach((tunnel: any) => {
      const routeHosts = getTunnelHopIds(tunnel)
        .map((hostId: number) => pointForHostId(Number(hostId)))
        .filter(Boolean) as TunnelGlobeHostPoint[];
      if (routeHosts.length < 2) {
        skipped += 1;
        return;
      }
      const supported = isTunnelSupported(tunnel);
      const active = supported && !!tunnel.isRunning;
      const enabled = supported && !!tunnel.isEnabled;
      links.push({
        id: `tunnel:${tunnel.id}`,
        kind: "tunnel",
        item: tunnel,
        name: String(tunnel.name || `隧道 #${tunnel.id}`),
        routeText: getTunnelRouteText(tunnel, hosts),
        routeHosts,
        statusText: !supported ? "协议未启用" : active ? "运行中" : enabled ? "已启用" : "已停用",
        latencyText: formatGlobeLatency(tunnelDisplayLatencyMs(tunnel), tunnelLatencyIsTimeout(tunnel)),
        color: active ? "#4ade80" : enabled ? "#fbbf24" : "#94a3b8",
        trackColor: active ? "#15803d" : enabled ? "#92400e" : "#475569",
        glowColor: active ? "rgba(74,222,128,.85)" : enabled ? "rgba(251,191,36,.78)" : "rgba(148,163,184,.6)",
      });
    });

    (chainGroups || []).forEach((group: any) => {
      const members = [...(group.members || [])].sort((a: any, b: any) => Number(a.priority) - Number(b.priority));
      const routeHosts = members
        .map((member: any) => pointForHostId(Number(member.hostId || 0)))
        .filter(Boolean) as TunnelGlobeHostPoint[];
      if (routeHosts.length < 2) {
        skipped += 1;
        return;
      }
      const enabled = !!group.isEnabled;
      links.push({
        id: `chain:${group.id}`,
        kind: "chain",
        item: group,
        name: String(group.name || `转发链 #${group.id}`),
        routeText: routeHosts.map((host) => host.name).join(" -> "),
        routeHosts,
        statusText: enabled ? "已启用" : "已停用",
        latencyText: formatGlobeLatency(group.latestLatencyMs, group.latestLatencyIsTimeout),
        color: enabled ? "#14b8a6" : "#94a3b8",
        trackColor: enabled ? "#0f766e" : "#475569",
        glowColor: enabled ? "rgba(20,184,166,.78)" : "rgba(148,163,184,.6)",
      });
    });

    const rawSegments = links.flatMap((link) => link.routeHosts.slice(0, -1).map((start, index) => ({
      link,
      segmentIndex: index,
      start,
      end: link.routeHosts[index + 1],
      layerKey: tunnelGlobeArcLayerKey(start, link.routeHosts[index + 1]),
    })));
    const totalLayersByKey = rawSegments.reduce((acc, segment) => {
      acc.set(segment.layerKey, (acc.get(segment.layerKey) || 0) + 1);
      return acc;
    }, new Map<string, number>());
    const usedLayersByKey = new Map<string, number>();
    const routePaths = rawSegments.map((segment) => {
      const { link, start, end, segmentIndex, layerKey } = segment;
      const layerIndex = usedLayersByKey.get(layerKey) || 0;
      usedLayersByKey.set(layerKey, layerIndex + 1);
      const layerCount = totalLayersByKey.get(layerKey) || 1;
      const path: TunnelGlobePath = {
        link,
        segmentIndex,
        layerIndex,
        layerCount,
        startLat: start.lat,
        startLng: start.lng,
        endLat: end.lat,
        endLng: end.lng,
        altitude: TUNNEL_GLOBE_PATH_MIN_ALTITUDE,
        coords: [],
      };
      const distance = globeDistanceDegrees(path);
      const baseAltitude = Math.max(TUNNEL_GLOBE_PATH_MIN_ALTITUDE, Math.min(TUNNEL_GLOBE_PATH_MAX_ALTITUDE, 0.032 + distance / 2300));
      path.altitude = baseAltitude + Math.min(TUNNEL_GLOBE_PATH_LAYER_ALTITUDE_MAX, Math.abs(layerIndex - (layerCount - 1) / 2) * TUNNEL_GLOBE_PATH_LAYER_ALTITUDE_STEP);
      path.coords = createTunnelGlobePathCoords(path);
      return path;
    });

    return {
      links,
      paths: routePaths,
      hostPoints: Array.from(hostPointById.values()),
      skipped,
    };
  }, [globeDataKey]);

  const hostCountryCodes = useMemo(() => {
    const codes = new Set<string>();
    globeData.hostPoints.forEach((point) => {
      const code = hostCountryCode(point.host);
      if (code) codes.add(code);
    });
    return codes;
  }, [globeData.hostPoints]);
  const latestLinkById = useMemo(() => {
    const tunnelById = new Map<number, any>((tunnels || []).map((tunnel: any) => [Number(tunnel.id), tunnel]));
    const chainById = new Map<number, any>((chainGroups || []).map((group: any) => [Number(group.id), group]));
    const map = new Map<string, TunnelGlobeLink>();
    globeData.links.forEach((link) => {
      if (link.kind === "tunnel") {
        const id = Number(link.item?.id || String(link.id).split(":")[1] || 0);
        const tunnel = tunnelById.get(id);
        if (!tunnel) {
          map.set(link.id, link);
          return;
        }
        const supported = isTunnelSupported(tunnel);
        const active = supported && !!tunnel.isRunning;
        const enabled = supported && !!tunnel.isEnabled;
        map.set(link.id, {
          ...link,
          item: tunnel,
          name: String(tunnel.name || `隧道 #${tunnel.id}`),
          routeText: getTunnelRouteText(tunnel, hosts),
          statusText: !supported ? "协议未启用" : active ? "运行中" : enabled ? "已启用" : "已停用",
          latencyText: formatGlobeLatency(tunnelDisplayLatencyMs(tunnel), tunnelLatencyIsTimeout(tunnel)),
          color: active ? "#4ade80" : enabled ? "#fbbf24" : "#94a3b8",
          trackColor: active ? "#15803d" : enabled ? "#92400e" : "#475569",
          glowColor: active ? "rgba(74,222,128,.85)" : enabled ? "rgba(251,191,36,.78)" : "rgba(148,163,184,.6)",
        });
        return;
      }
      const id = Number(link.item?.id || String(link.id).split(":")[1] || 0);
      const group = chainById.get(id);
      if (!group) {
        map.set(link.id, link);
        return;
      }
      const enabled = !!group.isEnabled;
      map.set(link.id, {
        ...link,
        item: group,
        name: String(group.name || `转发链 #${group.id}`),
        statusText: enabled ? "已启用" : "已停用",
        latencyText: formatGlobeLatency(group.latestLatencyMs, group.latestLatencyIsTimeout),
        color: enabled ? "#14b8a6" : "#94a3b8",
        trackColor: enabled ? "#0f766e" : "#475569",
        glowColor: enabled ? "rgba(20,184,166,.78)" : "rgba(148,163,184,.6)",
      });
    });
    return map;
  }, [chainGroups, globeData.links, isTunnelSupported, tunnels]);
  const latestGlobeLink = (link: TunnelGlobeLink) => latestLinkById.get(link.id) || link;

  useEffect(() => {
    if (!globeReady) return;
    let cancelled = false;
    fetch(TUNNEL_GLOBE_COUNTRIES_URL)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !Array.isArray(data?.features)) return;
        setCountries(data.features as TunnelGlobeCountryFeature[]);
      })
      .catch(() => {
        if (!cancelled) setCountries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [globeReady]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      const viewportHeight = typeof window === "undefined" ? 900 : window.innerHeight;
      const width = Math.max(900, Math.round(rect.width));
      setSize({
        width,
        height: Math.max(720, Math.min(980, Math.round(Math.max(viewportHeight - 240, width * 0.52)))),
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
    controls.autoRotateSpeed = 0.36;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.rotateSpeed = 0.58;
    controls.zoomSpeed = 0.85;
    controls.minDistance = 105;
    controls.maxDistance = 500;
    globe.pointOfView({ lat: 18, lng: 108, altitude: 1.24 }, 0);
  }, [globeReady]);

  useEffect(() => {
    const controls = globeRef.current?.controls();
    if (!controls) return;
    controls.autoRotate = !(hoveredLink || hoveredPoint);
  }, [hoveredLink, hoveredPoint]);

  const handleLinkEdit = (link: TunnelGlobeLink) => {
    if (link.kind === "tunnel") onEditTunnel(link.item);
    else onEditChain(link.item);
  };

  return (
    <>
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
                正在加载链路地球
              </div>
            }
          >
            <ReactGlobe
              ref={globeRef}
              width={size.width}
              height={size.height}
              backgroundColor="rgba(3,7,18,1)"
              globeImageUrl={TUNNEL_GLOBE_EARTH_IMAGE_URL}
              showAtmosphere
              atmosphereColor="#64748b"
              atmosphereAltitude={0.22}
              showGraticules={false}
              globeCurvatureResolution={4}
              polygonsData={countries}
              polygonGeoJsonGeometry="geometry"
              polygonAltitude={(country) => countryFeatureHasCode(country as TunnelGlobeCountryFeature, hostCountryCodes) ? 0.014 : 0.004}
              polygonCapColor={(country) => countryFeatureHasCode(country as TunnelGlobeCountryFeature, hostCountryCodes) ? "rgba(20,184,166,.36)" : "rgba(15,23,42,.05)"}
              polygonSideColor={(country) => countryFeatureHasCode(country as TunnelGlobeCountryFeature, hostCountryCodes) ? "rgba(20,184,166,.22)" : "rgba(2,6,23,.14)"}
              polygonStrokeColor={(country) => countryFeatureHasCode(country as TunnelGlobeCountryFeature, hostCountryCodes) ? "rgba(94,234,212,.86)" : "rgba(148,163,184,.22)"}
              polygonCapCurvatureResolution={4}
              polygonsTransitionDuration={0}
              pointsData={globeData.hostPoints}
              pointLat="lat"
              pointLng="lng"
              pointAltitude={0.035}
              pointRadius={0.28}
              pointResolution={24}
              pointColor={() => "#e0f2fe"}
              pointLabel={(point) => renderTunnelGlobeHostTooltip(point as TunnelGlobeHostPoint)}
              onPointHover={(point) => {
                setHoveredPoint(point as TunnelGlobeHostPoint | null);
                if (!point) setHoveredLink(null);
              }}
              pathsData={globeData.paths}
              pathPoints="coords"
              pathPointLat="lat"
              pathPointLng="lng"
              pathPointAlt="alt"
              pathResolution={4}
              pathColor={(path: object) => {
                const item = path as TunnelGlobePath;
                const link = latestGlobeLink(item.link);
                return hoveredLink?.id === link.id ? link.color : link.trackColor;
              }}
              pathStroke={(path: object) => {
                const item = path as TunnelGlobePath;
                const hovered = hoveredLink?.id === item.link.id;
                return hovered ? 3.05 : 2.1;
              }}
              pathTransitionDuration={0}
              pathLabel={(path) => renderTunnelGlobeLinkTooltip(latestGlobeLink((path as TunnelGlobePath).link))}
              onPathHover={(path) => setHoveredLink(path ? latestGlobeLink((path as TunnelGlobePath).link) : null)}
              onPathClick={(path) => {
                const link = path ? latestGlobeLink((path as TunnelGlobePath).link) : null;
                if (link) handleLinkEdit(link);
              }}
              showPointerCursor={(objectType) => objectType === "path" || objectType === "point"}
              enablePointerInteraction
              onGlobeReady={() => setGlobeReady(true)}
            />
          </Suspense>
          <div className="pointer-events-none absolute left-4 top-4 rounded-md border border-white/10 bg-black/35 px-3 py-2 text-xs text-white shadow-lg backdrop-blur-md">
            <div className="font-medium">全球链路地球</div>
            <div className="mt-1 text-white/70">
              隧道 {tunnels.length} 条 · 转发链 {chainGroups.length} 条 · 已定位 {globeData.links.length} 条
            </div>
            {globeData.skipped > 0 && (
              <div className="mt-1 text-amber-200/85">待定位 {globeData.skipped} 条</div>
            )}
          </div>
          <div className="pointer-events-none absolute right-4 top-4 flex flex-col gap-2 text-xs text-white">
            <div className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-black/35 px-3 py-2 shadow-lg backdrop-blur-md">
              <span className="h-2 w-6 rounded-full bg-[#4ade80]" />
              运行中隧道
            </div>
            <div className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-black/35 px-3 py-2 shadow-lg backdrop-blur-md">
              <span className="h-2 w-6 rounded-full bg-[#14b8a6]" />
              端口转发链
            </div>
          </div>
          {globeData.links.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center">
              <div className="rounded-md border border-white/10 bg-black/35 px-4 py-3 text-sm text-white/80 shadow-lg backdrop-blur-md">
                暂无可定位链路
              </div>
            </div>
          )}
        </div>
      </div>
      <Card className="border-border/40 bg-card/60 md:hidden">
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          3D 地球视图仅在 PC 端显示。
        </CardContent>
      </Card>
    </>
  );
}

function TunnelLatencyDialog({
  tunnelId,
  tunnelName,
  open,
  onOpenChange,
}: {
  tunnelId: number;
  tunnelName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [peakCutEnabled, setPeakCutEnabled] = useState(false);
  const { data, isLoading, isFetching } = trpc.tunnels.latencySeries.useQuery(
    { tunnelId, hours: 24 },
    { enabled: open, refetchInterval: pollingInterval("slow", open), refetchOnMount: "always" }
  );
  const cachedData = tunnelLatencySeriesCache.get(tunnelId);
  const rawSeriesData = (data ?? cachedData) as TunnelLatencySeriesDatum[] | undefined;
  const waitForFreshSeries = open && isFetching && !isLatencySeriesCacheFresh(rawSeriesData);
  const seriesData = waitForFreshSeries ? undefined : rawSeriesData;
  const showInitialLoading = (isLoading || waitForFreshSeries) && !seriesData;

  useEffect(() => {
    if (data) {
      tunnelLatencySeriesCache.set(tunnelId, data as TunnelLatencySeriesDatum[]);
    }
  }, [data, tunnelId]);

  const seriesMeta = useMemo<TunnelLatencySeriesMeta[]>(() => {
    if (!seriesData || seriesData.length === 0) return [];
    const byKey = new Map<string, TunnelLatencySeriesMeta>();
    for (const item of seriesData) {
      const key = normalizeTunnelLatencySeriesKey(item.seriesKey);
      if (byKey.has(key)) continue;
      byKey.set(key, {
        key,
        dataKey: `${key}ChartLatency`,
        rawKey: `${key}Latency`,
        timeoutKey: `${key}Timeout`,
        label: tunnelLatencySeriesDisplayName(key, item.seriesLabel),
        color: tunnelLatencyColors[byKey.size % tunnelLatencyColors.length],
      });
    }
    return Array.from(byKey.values()).sort((a, b) => {
      if (a.key === "total") return -1;
      if (b.key === "total") return 1;
      if (a.key === "primary") return -1;
      if (b.key === "primary") return 1;
      return a.label.localeCompare(b.label, "zh-CN");
    });
  }, [seriesData]);

  const rawChartData = useMemo<TunnelLatencyPoint[]>(() => {
    if (!seriesData || seriesData.length === 0) return [];
    const byTime = new Map<number, TunnelLatencyPoint>();
    for (const item of seriesData) {
      const at = new Date(item.recordedAt);
      const time = Number.isFinite(at.getTime()) ? at.getTime() : Date.now();
      const point = byTime.get(time) || {
        label: formatTunnelLatencyTime(at),
        fullLabel: formatTunnelLatencyTime(at),
      };
      const key = normalizeTunnelLatencySeriesKey(item.seriesKey);
      const isTimeout = !!item.isTimeout;
      const latency = isTimeout ? 0 : (Number(item.latencyMs) || 0);
      point[`${key}Latency`] = latency;
      point[`${key}ChartLatency`] = isTimeout ? 0 : clipLatencyForChart(latency);
      point[`${key}Timeout`] = isTimeout;
      byTime.set(time, point);
    }
    return Array.from(byTime.entries()).sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
  }, [seriesData]);
  const chartData = useMemo<TunnelLatencyPoint[]>(() => {
    if (!peakCutEnabled || seriesMeta.length === 0) return rawChartData;
    return applyLatencyPeakCut(
      rawChartData,
      seriesMeta.flatMap((meta) => [
        { dataKey: meta.rawKey, timeoutKey: meta.timeoutKey },
        { dataKey: meta.dataKey, timeoutKey: meta.timeoutKey },
      ]),
    ) as TunnelLatencyPoint[];
  }, [peakCutEnabled, rawChartData, seriesMeta]);
  const statsSeries = useMemo(() => {
    if (seriesMeta.length === 0 || chartData.length === 0) return [];
    const meta = seriesMeta.find((item) => item.key === "total") || seriesMeta[0];
    return chartData
      .filter((point) => point[meta.rawKey] !== undefined || point[meta.timeoutKey] !== undefined)
      .map((point) => ({
        latency: Number(point[meta.rawKey] || 0),
        isTimeout: !!point[meta.timeoutKey],
      }));
  }, [chartData, seriesMeta]);

  const stats = useMemo(() => {
    return getLatencyStabilityStats(statsSeries);
  }, [statsSeries]);
  const yMax = useMemo(() => {
    if (chartData.length === 0 || seriesMeta.length === 0) return 120;
    const values = chartData.flatMap((point) => seriesMeta.map((meta) => Number(point[meta.dataKey] || 0))).filter((value) => value > 0);
    const maxVal = values.length > 0 ? Math.max(...values) : 0;
    return getLatencyYAxisMax(maxVal, 120);
  }, [chartData, seriesMeta]);
  const yTicks = useMemo(() => {
    return getLatencyYAxisTicks(yMax);
  }, [yMax]);
  const shouldAnimateChart = open && chartData.length > 0 && !tunnelLatencyAnimatedKeys.has(tunnelId);

  useEffect(() => {
    if (shouldAnimateChart) {
      tunnelLatencyAnimatedKeys.add(tunnelId);
    }
  }, [shouldAnimateChart, tunnelId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[96svh] w-[calc(100vw-0.75rem)] max-w-[95vw] flex-col gap-3 overflow-hidden p-3 sm:max-w-3xl sm:p-6">
        <DialogHeader>
          <div className="flex flex-col gap-2 pr-9 sm:flex-row sm:items-start sm:justify-between sm:pr-10">
            <div className="min-w-0">
              <DialogTitle className="text-base sm:text-lg">隧道链路延迟 - {tunnelName}</DialogTitle>
              <DialogDescription>最近 24 小时延迟和丢包。</DialogDescription>
            </div>
            <LatencyPeakCutToggle id={`tunnel-peak-cut-${tunnelId}`} checked={peakCutEnabled} onCheckedChange={setPeakCutEnabled} className="shrink-0 self-start sm:pt-1" />
          </div>
        </DialogHeader>
        <div className="dialog-scroll-area min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
        <div className="h-[42svh] min-h-[220px] w-full sm:h-72">
          {showInitialLoading ? (
            <Skeleton className="h-full w-full" />
          ) : chartData.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">暂无隧道链路延迟数据</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 10, left: -8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="label" tick={{ fontSize: 9 }} minTickGap={60} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => `${v}ms`} width={50} domain={[0, yMax]} ticks={yTicks} allowDecimals={false} />
                <RTooltip
                  cursor={{ stroke: "var(--color-muted-foreground)", strokeDasharray: "3 3" }}
                  offset={12}
                  wrapperStyle={{ pointerEvents: "none" }}
                  content={({ active, payload }: any) => {
                    if (!active || !payload?.length) return null;
                    const item = payload[0].payload;
                    return (
                      <div className="min-w-40 rounded-lg border border-border bg-card px-3 py-2 shadow-md">
                        <p className="mb-2 text-xs text-muted-foreground">{item.fullLabel}</p>
                        <div className="space-y-1">
                          {seriesMeta.map((meta) => {
                            const hasValue = item[meta.rawKey] !== undefined || item[meta.timeoutKey] !== undefined;
                            if (!hasValue) return null;
                            const timeout = !!item[meta.timeoutKey];
                            return (
                              <div key={meta.key} className="flex items-center justify-between gap-4 text-xs">
                                <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: timeout ? "var(--color-destructive)" : meta.color }} />
                                  <span className="truncate">{meta.label}</span>
                                </span>
                                <span className={timeout ? "font-semibold text-destructive" : "font-semibold tabular-nums"}>
                                  {timeout ? "不通" : `${Number(item[meta.rawKey] || 0)}ms`}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  }}
                />
                {seriesMeta.map((meta) => (
                  <Line
                    key={meta.key}
                    type="monotone"
                    dataKey={meta.dataKey}
                    stroke={meta.color}
                    strokeWidth={meta.key === "total" ? 1.8 : 1.35}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    dot={(props: any) => props?.payload?.[meta.timeoutKey] ? (
                      <circle cx={props.cx} cy={props.cy} r={3} fill="var(--color-destructive)" stroke="var(--color-background)" strokeWidth={1.5} />
                    ) : (
                      <circle cx={props.cx} cy={props.cy} r={0} fill="transparent" />
                    )}
                    activeDot={{ r: 4, fill: meta.color, stroke: "var(--color-background)", strokeWidth: 2 }}
                    connectNulls={false}
                    isAnimationActive={shouldAnimateChart}
                    animationDuration={shouldAnimateChart ? 500 : 0}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
        {seriesMeta.length > 1 ? (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {seriesMeta.map((meta) => (
              <span key={meta.key} className="inline-flex max-w-[180px] items-center gap-1.5 truncate">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: meta.color }} />
                <span className="truncate">{meta.label}</span>
              </span>
            ))}
          </div>
        ) : null}
        <LatencyStabilityStats stats={stats} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
function TunnelSelfTestDialog({
  tunnelId,
  tunnelName,
  hosts,
  entryGroups,
  open,
  onOpenChange,
}: {
  tunnelId: number;
  tunnelName: string;
  hosts?: any[];
  entryGroups?: any[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const { data: tunnels } = trpc.tunnels.list.useQuery(undefined, {
    enabled: open,
    refetchInterval: pollingInterval("interactive", open),
    refetchOnWindowFocus: false,
  });
  const tunnel = useMemo(() => tunnels?.find((item: any) => item.id === tunnelId), [tunnels, tunnelId]);
  const [optimisticTesting, setOptimisticTesting] = useState(false);
  const [startedLastTestAt, setStartedLastTestAt] = useState<string | null>(null);
  const [sawServerTesting, setSawServerTesting] = useState(false);
  const testMutation = trpc.tunnels.test.useMutation({
    onSuccess: async () => {
      await utils.tunnels.list.invalidate();
    },
    onError: (e) => {
      setOptimisticTesting(false);
      setStartedLastTestAt(null);
      setSawServerTesting(false);
      toast.error(e.message || "测试失败");
    },
  });

  const status = tunnel?.lastTestStatus as string | undefined;
  const lastTestAt = tunnel?.lastTestAt ? String(tunnel.lastTestAt) : "";
  const isServerTesting = status === "pending" || status === "running";
  const isTesting = testMutation.isPending || optimisticTesting || isServerTesting;
  const isSuccess = status === "success";
  const isFailed = status === "failed";
  const latencyMs = tunnel?.lastLatencyMs;
  const lastFailureToastKey = useRef("");
  const manualTestRef = useRef(false);
  const manualTestBaselineAtRef = useRef("");
  const parsedMessage = useMemo(() => parseLinkTestMessage(tunnel?.lastTestMessage), [tunnel?.lastTestMessage]);
  const hasPendingDetails = hasPendingLinkTestDetails(parsedMessage);
  const displayTesting = isTesting || hasPendingDetails;
  const linkTestNodeData = useMemo(() => {
    const meta: Record<string, any> = {};
    const nodeTooltips: Record<string, ReactNode> = {};
    const fullHostById = new Map<number, any>((hosts || []).map((host: any) => [Number(host.id), host]));
    const tunnelHostById = new Map<number, any>();
    [
      ...(tunnel?.hopHosts || []),
      tunnel?.entryHost,
      tunnel?.exitHost,
      ...(tunnel?.loadBalanceExitHosts || []),
      ...(Array.isArray(tunnel?.loadBalanceExits) ? tunnel.loadBalanceExits.map((exit: any) => exit?.host) : []),
    ].forEach((host: any) => {
      const id = Number(host?.id || 0);
      if (id > 0) tunnelHostById.set(id, host);
    });
    const hopIds = getTunnelHopIds(tunnel);
    const hostForId = (hostId: number) => fullHostById.get(Number(hostId)) || tunnelHostById.get(Number(hostId));
    const entryGroup = (entryGroups || []).find((group: any) => Number(group?.id || 0) === Number(tunnel?.entryGroupId || 0));
    const entryGroupMembers = enabledHostGroupMembers(entryGroup);
    const entryGroupMemberByHostId = new Map<number, any>();
    entryGroupMembers.forEach((member: any) => {
      const hostId = Number(member?.hostId || 0);
      if (hostId > 0) entryGroupMemberByHostId.set(hostId, member);
    });
    const labelForHostId = (hostId: number) => {
      const host = hostForId(hostId);
      const member = entryGroupMemberByHostId.get(Number(hostId));
      return hostDisplayName(host)
        || String(member?.name || member?.remark || "").trim()
        || tunnelHopHostName(tunnel, hostId, hosts)
        || `主机 #${hostId}`;
    };
    const addNodeMetaForHostId = (hostId: number) => {
      const host = hostForId(hostId);
      addHostNodeMeta(meta, host, [
        labelForHostId(hostId),
        String(entryGroupMemberByHostId.get(Number(hostId))?.entryAddress || "").trim(),
        `主机${hostId}`,
        `主机 #${hostId}`,
        tunnelHopHostName(tunnel, hostId, hosts),
        hostDisplayName(host),
        `主机${hostId}`,
        `主机 #${hostId}`,
      ]);
    };
    hopIds.forEach((hostId: number) => addNodeMetaForHostId(hostId));
    entryGroupMembers.forEach((member: any) => {
      const hostId = Number(member?.hostId || 0);
      if (hostId > 0) addNodeMetaForHostId(hostId);
    });
    const firstHostId = Number(hopIds[0] || 0);
    const lastHostId = Number(hopIds[hopIds.length - 1] || 0);
    const nodeMetaFor = (host: any, hostId: number) => meta[hostDisplayName(host)] || meta[String(hostId)] || undefined;
    let plannedSegments: LinkTestPlannedSegment[] = hopIds.slice(0, -1).map((hostId: number, index: number) => {
      const nextHostId = Number(hopIds[index + 1] || 0);
      const fromHost = hostForId(Number(hostId));
      const toHost = hostForId(nextHostId);
      return {
        from: labelForHostId(Number(hostId)),
        to: labelForHostId(nextHostId),
        fromMeta: nodeMetaFor(fromHost, Number(hostId)),
        toMeta: nodeMetaFor(toHost, nextHostId),
      };
    }).filter((segment: LinkTestPlannedSegment) => segment.from && segment.to);
    const entryHostIds = Array.from(new Set<number>((
      entryGroupMembers.length > 0
        ? entryGroupMembers.map((member: any) => Number(member?.hostId || 0))
        : [firstHostId]
    ).filter((hostId: number) => Number.isFinite(hostId) && hostId > 0)));
    if (entryHostIds.length > 1) {
      const restHopIds = hopIds.slice(1).filter((hostId: number) => Number.isFinite(Number(hostId)) && Number(hostId) > 0);
      const nextHostId = Number(restHopIds[0] || lastHostId || tunnel?.exitHostId || 0);
      const nextHost = hostForId(nextHostId);
      const nextLabel = labelForHostId(nextHostId);
      const entrySegments: LinkTestPlannedSegment[] = entryHostIds.map((entryHostId: number) => {
        const entryHost = hostForId(entryHostId);
        return {
          from: labelForHostId(entryHostId),
          to: nextLabel,
          fromMeta: nodeMetaFor(entryHost, entryHostId),
          toMeta: nodeMetaFor(nextHost, nextHostId),
        };
      });
      const restSegments: LinkTestPlannedSegment[] = restHopIds.slice(0, -1).map((hostId: number, index: number) => {
        const nextRestHostId = Number(restHopIds[index + 1] || 0);
        const fromHost = hostForId(Number(hostId));
        const toHost = hostForId(nextRestHostId);
        return {
          from: labelForHostId(Number(hostId)),
          to: labelForHostId(nextRestHostId),
          fromMeta: nodeMetaFor(fromHost, Number(hostId)),
          toMeta: nodeMetaFor(toHost, nextRestHostId),
        };
      });
      plannedSegments = [...entrySegments, ...restSegments].filter((segment: LinkTestPlannedSegment) => segment.from && segment.to);
    }
    const extraExits = Array.isArray(tunnel?.loadBalanceExits)
      ? tunnel.loadBalanceExits
        .filter((exit: any) => Number(exit?.hostId || 0) > 0)
        .sort((a: any, b: any) => Number(a?.seq || 0) - Number(b?.seq || 0))
      : [];
    const primaryExitLabel = lastHostId ? labelForHostId(lastHostId) : "";
    if (primaryExitLabel && extraExits.length > 0) {
      const entryReferenceLabel = entryHostIds.length > 1
        ? "入口组"
        : firstHostId
          ? labelForHostId(firstHostId)
          : "入口";
      const exitRows = [
        {
          hostId: lastHostId,
          label: primaryExitLabel,
          role: "主出口",
          connectHost: String(tunnel?.connectHost || "").trim(),
          listenPort: Number(tunnel?.listenPort || 0) || null,
        },
        ...extraExits.map((exit: any, index: number) => {
          const hostId = Number(exit?.hostId || 0);
          return {
            hostId,
            label: labelForHostId(hostId),
            role: `备用出口 ${index + 1}`,
            connectHost: String(exit?.connectHost || "").trim(),
            listenPort: Number(exit?.listenPort || 0) || null,
          };
        }),
      ].filter((row) => row.hostId > 0);
      const detailByTarget = new Map<string, any>();
      const detailByHostId = new Map<number, any>();
      const detailByIndex = new Map<number, any>();
      (parsedMessage.details || []).forEach((detail: any, index: number) => {
        const route = String(detail?.routeLabel || detail?.hopLabel || "").trim();
        const match = route.match(/->\s*(.+)$/);
        const target = String(match?.[1] || "").trim();
        if (target) detailByTarget.set(target.toLowerCase(), { detail, index });
        const idMatch = String(detail?.hopLabel || "").match(/->\s*(\d+)\s*$/);
        const targetHostId = Number(idMatch?.[1] || 0);
        if (targetHostId > 0) detailByHostId.set(targetHostId, { detail, index });
        detailByIndex.set(index, { detail, index });
      });
      const latestSeries = Array.isArray(tunnel?.latestLatencySeries) ? tunnel.latestLatencySeries : [];
      const latestSeriesByKey = new Map<string, any>();
      latestSeries.forEach((item: any) => {
        const key = String(item?.seriesKey || "").trim().toLowerCase();
        if (key) latestSeriesByKey.set(key, item);
      });
      const detailForExitRow = (row: { hostId: number; label: string }, index: number) => (
        detailByHostId.get(row.hostId)
        || detailByTarget.get(row.label.toLowerCase())
        || detailByIndex.get(index)
        || null
      );
      const latestForExitRow = (index: number) => (
        latestSeriesByKey.get(index === 0 ? "primary" : `exit-${index + 1}`)
        || null
      );
      const tooltip = (
        <div className="min-w-[240px] space-y-2">
          <div>
            <div className="text-sm font-semibold">出口组</div>
            <div className="text-[11px] text-muted-foreground">主图仅展示主出口，备用出口在此查看。相对入口：{entryReferenceLabel}</div>
          </div>
          <div className="space-y-1.5">
            {exitRows.map((row, index) => {
              const detailRecord = detailForExitRow(row, index);
              const detail = detailRecord?.detail;
              const latest = latestForExitRow(index);
              const latestLatency = typeof latest?.latencyMs === "number" && Number.isFinite(latest.latencyMs) ? Number(latest.latencyMs) : null;
              const latestTimeout = latest?.isTimeout === true;
              const pending = detail?.pending === true || displayTesting;
              const failed = !pending && (detail ? detail.success === false : latestTimeout);
              const success = pending || !failed;
              const latency = typeof detail?.latencyMs === "number" && Number.isFinite(detail.latencyMs)
                ? `${detail.latencyMs}ms`
                : pending
                  ? "探测中"
                  : detail
                    ? "失败"
                    : latestLatency !== null
                      ? `${latestLatency}ms`
                      : latestTimeout
                        ? "失败"
                        : "--";
              return (
                <div key={`${row.role}-${row.hostId}`} className="rounded border border-border/60 bg-background/70 px-2 py-1.5">
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <span className="min-w-0 truncate font-medium">{row.label}</span>
                    <span className={success ? "shrink-0 text-emerald-600 dark:text-emerald-400" : "shrink-0 text-destructive"}>{latency}</span>
                  </div>
                  <div className="mt-1 flex min-w-0 items-center justify-between gap-3 text-[11px] text-muted-foreground">
                    <span>{row.role}</span>
                    <span className="min-w-0 truncate">{[row.connectHost, row.listenPort ? `:${row.listenPort}` : ""].filter(Boolean).join("") || "默认连接地址"}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );
      [
        primaryExitLabel,
        primaryExitLabel.toLowerCase(),
        meta[primaryExitLabel]?.label,
        meta[primaryExitLabel]?.label?.toLowerCase(),
      ].filter(Boolean).forEach((key: any) => {
        nodeTooltips[String(key)] = tooltip;
      });
    }
    if (entryHostIds.length <= 1 && hopIds.length === 2 && tunnel?.loadBalanceEnabled && extraExits.length > 0) {
      const entryHost = hostForId(firstHostId);
      const entryLabel = hostDisplayName(entryHost) || (firstHostId ? tunnelHopHostName(tunnel, firstHostId, hosts) : tunnelName);
      const branchGroupKey = `tunnel-${tunnel?.id || tunnelName}-load-balance`;
      const primaryExitHost = hostForId(lastHostId);
      const branchSegments: LinkTestPlannedSegment[] = [{
        from: entryLabel,
        to: hostDisplayName(primaryExitHost) || (lastHostId ? tunnelHopHostName(tunnel, lastHostId, hosts) : tunnelName),
        fromMeta: meta[hostDisplayName(entryHost)] || meta[String(firstHostId)] || undefined,
        toMeta: meta[hostDisplayName(primaryExitHost)] || meta[String(lastHostId)] || undefined,
        groupKey: branchGroupKey,
        groupLabel: "多出口负载",
      }];
      for (const exit of extraExits) {
        const exitHostId = Number(exit?.hostId || 0);
        const exitHost = hostForId(exitHostId);
        addHostNodeMeta(meta, exitHost, [hostDisplayName(exitHost), `主机${exitHostId}`, `主机 #${exitHostId}`]);
        branchSegments.push({
          from: entryLabel,
          to: hostDisplayName(exitHost) || `主机${exitHostId}`,
          fromMeta: meta[hostDisplayName(entryHost)] || meta[String(firstHostId)] || undefined,
          toMeta: meta[hostDisplayName(exitHost)] || meta[String(exitHostId)] || undefined,
          groupKey: branchGroupKey,
          groupLabel: "多出口负载",
        });
      }
      plannedSegments = branchSegments.slice(0, 1).filter((segment: LinkTestPlannedSegment) => segment.from && segment.to);
    }
    return {
      nodeMeta: meta,
      nodeTooltips,
      sourceLabel: firstHostId ? labelForHostId(firstHostId) : tunnelName,
      targetLabel: lastHostId ? labelForHostId(lastHostId) : tunnelName,
      plannedSegments,
    };
  }, [displayTesting, entryGroups, hosts, parsedMessage.details, tunnel, tunnelName]);

  useEffect(() => {
    if (!open) {
      setOptimisticTesting(false);
      setStartedLastTestAt(null);
      setSawServerTesting(false);
      manualTestRef.current = false;
      manualTestBaselineAtRef.current = "";
    }
  }, [open]);

  useEffect(() => {
    if (isServerTesting) setSawServerTesting(true);
  }, [isServerTesting]);

  useEffect(() => {
    if (!optimisticTesting || isServerTesting) return;
    const hasNewTestTimestamp = startedLastTestAt === "__none__"
      ? !!lastTestAt
      : !!lastTestAt && lastTestAt !== startedLastTestAt;
    if (sawServerTesting || hasNewTestTimestamp) {
      setOptimisticTesting(false);
      setStartedLastTestAt(null);
      setSawServerTesting(false);
    }
  }, [isServerTesting, lastTestAt, optimisticTesting, sawServerTesting, startedLastTestAt]);

  useEffect(() => {
    if (!open) {
      lastFailureToastKey.current = "";
      return;
    }
    const message = parsedMessage.message.trim();
    const messageLooksSuccessful = /测试成功|检测成功/.test(message) && !/失败|超时|不可达|异常/.test(message);
    const baselineAt = manualTestBaselineAtRef.current;
    const hasFreshResult = !baselineAt || (tunnel?.lastTestAt && String(tunnel.lastTestAt) !== baselineAt);
    if (!displayTesting && isFailed && message && !messageLooksSuccessful && manualTestRef.current && hasFreshResult) {
      const key = `${tunnelId}:${status}:${tunnel?.lastTestAt || ""}:${message}`;
      if (lastFailureToastKey.current !== key) {
        lastFailureToastKey.current = key;
        manualTestRef.current = false;
        toast.error("隧道链路自测失败", {
          description: message,
          duration: 12000,
        });
      }
    }
    if (!displayTesting && isSuccess) {
      manualTestRef.current = false;
    }
  }, [open, displayTesting, isFailed, isSuccess, status, tunnel?.lastTestAt, parsedMessage.message, tunnelId]);

  const plannedSegmentCount = linkTestNodeData.plannedSegments?.length || 0;
  const probeDialogSizeClass = plannedSegmentCount >= 3 ? "sm:max-w-4xl" : plannedSegmentCount >= 2 ? "sm:max-w-3xl" : "sm:max-w-xl";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`${probeDialogSizeClass} min-w-0`}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            延迟探测
          </DialogTitle>
          <DialogDescription>{tunnelName}</DialogDescription>
        </DialogHeader>

        <LinkTestProbeView
          parsed={parsedMessage}
          fallbackLatencyMs={latencyMs}
          isSuccess={isSuccess}
          isTesting={displayTesting}
          sourceLabel={linkTestNodeData.sourceLabel}
          targetLabel={linkTestNodeData.targetLabel}
          nodeMeta={linkTestNodeData.nodeMeta}
          nodeTooltips={linkTestNodeData.nodeTooltips}
          plannedSegments={linkTestNodeData.plannedSegments}
        />

        <DialogFooter className="gap-2">
          <Button
            onClick={() => {
              manualTestRef.current = true;
              manualTestBaselineAtRef.current = lastTestAt || "";
              setStartedLastTestAt(lastTestAt || "__none__");
              setSawServerTesting(false);
              setOptimisticTesting(true);
              testMutation.mutate({ id: tunnelId });
            }}
            disabled={displayTesting}
            className="w-full min-w-0 gap-2 sm:w-auto sm:min-w-[112px]"
          >
            {displayTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
            {displayTesting ? "探测中..." : "链路测试"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function normalizeForwardGroupMode(mode: unknown) {
  const value = String(mode || "failover");
  return value === "chain" || value === "entry" || value === "exit" ? value : "failover";
}

function enabledHostGroupMembers(group: any) {
  return (group?.members || [])
    .filter((member: any) => member?.memberType === "host" && Number(member?.hostId || 0) > 0 && member?.isEnabled !== false)
    .sort((a: any, b: any) => Number(a?.priority || 0) - Number(b?.priority || 0));
}

function groupMemberHostName(member: any, hosts: any[] | undefined) {
  const hostId = Number(member?.hostId || 0);
  return (hosts || []).find((host: any) => Number(host.id) === hostId)?.name || `主机 #${hostId}`;
}

function groupMemberConnectLabel(member: any, hosts: any[] | undefined) {
  const connectHost = String(member?.connectHost || "").trim();
  if (!connectHost) return "";
  const hostId = Number(member?.hostId || 0);
  const host = (hosts || []).find((item: any) => Number(item.id) === hostId);
  if (hostPrivateAddress(host) && sameAddress(connectHost, hostPrivateAddress(host))) return "内网";
  if (hostIpv6Address(host) && sameAddress(connectHost, hostIpv6Address(host))) return "IPv6";
  return "指定地址";
}

function groupHostSummary(group: any, hosts: any[] | undefined) {
  const members = enabledHostGroupMembers(group);
  if (members.length === 0) return "无可用主机";
  return members.map((member: any) => {
    const connectLabel = groupMemberConnectLabel(member, hosts);
    return `${groupMemberHostName(member, hosts)}${connectLabel ? `(${connectLabel})` : ""}`;
  }).join("、");
}

function TunnelsContent() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const { data: tunnels, isLoading } = trpc.tunnels.list.useQuery(undefined, { refetchInterval: pollingInterval("active") });
  const { data: hosts } = trpc.hosts.list.useQuery();
  const { data: forwardGroups, isLoading: forwardGroupsLoading } = trpc.forwardGroups.list.useQuery(undefined, { refetchInterval: pollingInterval("normal") });
  const { data: systemSettings } = trpc.system.getSettings.useQuery();
  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<TunnelForm>(defaultForm);
  const [tunnelProxyPanelOpen, setTunnelProxyPanelOpen] = useState(false);
  const [tunnelAdvancedOpen, setTunnelAdvancedOpen] = useState(false);
  const [latencyTunnel, setLatencyTunnel] = useState<{ id: number; name: string } | null>(null);
  const [testTunnel, setTestTunnel] = useState<{ id: number; name: string } | null>(null);
  const [viewMode, setViewMode] = useState<TunnelViewMode>(() => getStoredTunnelViewMode());
  const [chainViewMode, setChainViewMode] = useState<TunnelViewMode>(() => getStoredChainViewMode());
  const [activeSection, setActiveSection] = useUrlTab<TunnelSection>({
    values: TUNNEL_SECTIONS,
    defaultValue: "tunnels",
    storageKey: TUNNEL_SECTION_STORAGE_KEY,
  });
  const [showCreateTypeDialog, setShowCreateTypeDialog] = useState(false);
  const [selectedCreateType, setSelectedCreateType] = useState<LinkCreateType>("chain");
  const [chainCreateForm, setChainCreateForm] = useState<ChainCreateForm>(defaultChainCreateForm);
  const [chainAdvancedOpen, setChainAdvancedOpen] = useState(false);
  const [chainEditRequest, setChainEditRequest] = useState<{ id: number; requestKey: number } | null>(null);
  const [groupCreateRequest, setGroupCreateRequest] = useState<{ mode: TunnelGroupMode; requestKey: number } | null>(null);
  const [deleteTunnel, setDeleteTunnel] = useState<any | null>(null);
  const deleteImpactQuery = trpc.tunnels.deleteImpact.useQuery(
    { id: Number(deleteTunnel?.id || 0) },
    { enabled: !!deleteTunnel },
  );

  useEffect(() => {
    prefetchReactGlobe();
  }, []);

  const forwardProtocolSettings = useMemo(
    () => normalizeForwardProtocolSettings(systemSettings?.forwardProtocols),
    [systemSettings?.forwardProtocols]
  );
  const allowedForwardTypes = useMemo<ForwardType[]>(() => {
    const all = [...FORWARD_TYPES];
    if (!user || user.role === "admin") return all;
    const raw = (user as any).allowedForwardTypes as string | null | undefined;
    if (!raw || !raw.trim()) return all;
    const allowed = new Set(raw.split(",").map((item: string) => item.trim()).filter(Boolean));
    const filtered = all.filter((type) => allowed.has(type));
    return filtered.length > 0 ? filtered : all;
  }, [user]);
  const availableChainForwardTypes = useMemo<ForwardType[]>(
    () => allowedForwardTypes.filter((type) => forwardProtocolSettings[type] !== false),
    [allowedForwardTypes, forwardProtocolSettings]
  );
  const defaultChainForwardType = availableChainForwardTypes[0] || "iptables";
  const nginxTunnelEnabled = useMemo(
    () => isNginxForwardProtocolEnabled({
      nginx: false,
      nginx_stream: forwardProtocolSettings.nginx_stream,
      nginx_tls: forwardProtocolSettings.nginx_tls,
    }),
    [forwardProtocolSettings.nginx_stream, forwardProtocolSettings.nginx_tls]
  );
  const tunnelProtocolLabel = (protocolKey: ForwardProtocolKey | null | undefined) => {
    const genericLabel = "\u8be5\u534f\u8bae";
    if (!protocolKey) return genericLabel;
    if (!nginxTunnelEnabled && protocolKey === "nginx_stream") return genericLabel;
    return FORWARD_PROTOCOL_LABELS[protocolKey] || genericLabel;
  };

  const getTunnelProtocolKey = (tunnel: any | null | undefined): ForwardProtocolKey | null => {
    const mode = String(tunnel?.mode || "").toLowerCase();
    if (mode === "nginx_tls") return "nginx_stream";
    return (["forwardx", "tls", "wss", "tcp", "mtls", "mwss", "mtcp", "nginx_stream", "nginx_tls"] as const).includes(mode as any)
      ? mode as ForwardProtocolKey
      : null;
  };
  const isTunnelSupported = (tunnel: any | null | undefined) => {
    const key = getTunnelProtocolKey(tunnel);
    return !key || forwardProtocolSettings[key] !== false;
  };
  const enabledGostTunnelModes = useMemo(
    () => gostTunnelModes.filter((mode) => forwardProtocolSettings[mode] !== false),
    [forwardProtocolSettings]
  );
  const enabledNginxTunnelModes = useMemo(
    () => nginxTunnelEnabled ? nginxTunnelModes.filter((mode) => forwardProtocolSettings[mode] !== false) : [],
    [forwardProtocolSettings, nginxTunnelEnabled]
  );
  const resolveDefaultTunnelMode = () => {
    return forwardProtocolSettings.forwardx !== false
      ? "forwardx"
      : (enabledGostTunnelModes[0] || enabledNginxTunnelModes[0] || "forwardx");
  };
  const activeCount = useMemo(() => tunnels?.filter((t: any) => t.isRunning && isTunnelSupported(t)).length ?? 0, [forwardProtocolSettings, tunnels]);
  const chainGroups = useMemo(() => (forwardGroups || []).filter((group: any) => normalizeForwardGroupMode(group.groupMode) === "chain"), [forwardGroups]);
  const failoverGroups = useMemo(() => (forwardGroups || []).filter((group: any) => normalizeForwardGroupMode(group.groupMode) === "failover"), [forwardGroups]);
  const entryGroups = useMemo(() => (forwardGroups || []).filter((group: any) => normalizeForwardGroupMode(group.groupMode) === "entry"), [forwardGroups]);
  const exitGroups = useMemo(() => (forwardGroups || []).filter((group: any) => normalizeForwardGroupMode(group.groupMode) === "exit"), [forwardGroups]);
  const activeChainCount = useMemo(() => chainGroups.filter((group: any) => group.isEnabled).length, [chainGroups]);
  const activeFailoverGroupCount = useMemo(() => failoverGroups.filter((group: any) => group.isEnabled && group.lastStatus === "healthy").length, [failoverGroups]);
  const activeEntryGroupCount = useMemo(() => entryGroups.filter((group: any) => group.isEnabled && group.lastStatus === "healthy").length, [entryGroups]);
  const usableEntryGroups = useMemo(() => entryGroups.filter((group: any) => group.isEnabled && String(group.domain || "").trim()), [entryGroups]);
  const activeExitGroupCount = useMemo(() => exitGroups.filter((group: any) => group.isEnabled && enabledHostGroupMembers(group).length > 0).length, [exitGroups]);
  const usableExitGroups = useMemo(() => exitGroups.filter((group: any) => group.isEnabled && enabledHostGroupMembers(group).length > 0), [exitGroups]);
  const entryGroupById = useMemo(() => new Map<number, any>(entryGroups.map((group: any) => [Number(group.id), group])), [entryGroups]);
  const exitGroupById = useMemo(() => new Map<number, any>(exitGroups.map((group: any) => [Number(group.id), group])), [exitGroups]);
  const entryMembersForGroup = (groupId: number | null | undefined) => {
    const group = groupId ? entryGroupById.get(Number(groupId)) : null;
    return enabledHostGroupMembers(group);
  };
  const exitMembersForGroup = (groupId: number | null | undefined) => {
    const group = groupId ? exitGroupById.get(Number(groupId)) : null;
    return enabledHostGroupMembers(group);
  };
  const primaryEntryHostIdForGroup = (groupId: number | null | undefined) => Number(entryMembersForGroup(groupId)[0]?.hostId || 0) || null;
  const primaryExitHostIdForGroup = (groupId: number | null | undefined) => Number(exitMembersForGroup(groupId)[0]?.hostId || 0) || null;
  const memberHostIdsForGroup = (members: any[]) => members.map((member: any) => Number(member.hostId || 0)).filter((id: number) => id > 0);
  const externalTunnelHostIds = (entryGroupId: number | null | undefined, exitGroupId: number | null | undefined) => [
    ...memberHostIdsForGroup(entryMembersForGroup(entryGroupId)),
    ...memberHostIdsForGroup(exitMembersForGroup(exitGroupId)),
  ];
  const externalChainEntryHostIds = (entryGroupId: number | null | undefined) => memberHostIdsForGroup(entryMembersForGroup(entryGroupId));
  const stripExternalTunnelHosts = (
    hopIds: number[],
    connectHosts: Array<string | null>,
    entryGroupId: number | null | undefined,
    exitGroupId: number | null | undefined,
  ) => {
    const entryIds = new Set(entryMembersForGroup(entryGroupId).map((member: any) => Number(member.hostId || 0)).filter((id: number) => id > 0));
    const exitIds = new Set(exitMembersForGroup(exitGroupId).map((member: any) => Number(member.hostId || 0)).filter((id: number) => id > 0));
    const nextIds: number[] = [];
    const nextConnectHosts: Array<string | null> = [];
    hopIds.forEach((hostId, index) => {
      const id = Number(hostId || 0);
      if (!id || entryIds.has(id) || exitIds.has(id)) return;
      nextIds.push(id);
      nextConnectHosts.push(connectHosts[index] || null);
    });
    return {
      hopHostIds: nextIds,
      hopConnectHosts: normalizeHopConnectHostsForHosts(nextConnectHosts, nextIds, hosts, !!entryGroupId),
    };
  };
  const stripExternalChainHosts = (
    hopIds: number[],
    connectHosts: Array<string | null>,
    entryGroupId: number | null | undefined,
  ) => {
    const entryIds = new Set(externalChainEntryHostIds(entryGroupId));
    const nextIds: number[] = [];
    const nextConnectHosts: Array<string | null> = [];
    hopIds.forEach((hostId, index) => {
      const id = Number(hostId || 0);
      if (!id || entryIds.has(id)) return;
      nextIds.push(id);
      nextConnectHosts.push(connectHosts[index] || null);
    });
    return {
      hopHostIds: nextIds,
      hopConnectHosts: normalizeChainConnectHostsForHosts(nextConnectHosts, nextIds, hosts, !!entryGroupId),
    };
  };
  const applyEntryGroupToTunnelForm = (prev: TunnelForm, entryGroupId: number | null): TunnelForm => {
    const stripped = stripExternalTunnelHosts(prev.hopHostIds, prev.hopConnectHosts, entryGroupId, prev.exitGroupId);
    return {
      ...prev,
      entryGroupId,
      entryHostId: entryGroupId ? (primaryEntryHostIdForGroup(entryGroupId) || prev.entryHostId) : (stripped.hopHostIds[0] ?? null),
      hopHostIds: stripped.hopHostIds,
      hopConnectHosts: stripped.hopConnectHosts,
    };
  };
  const applyEntryGroupToChainCreateForm = (prev: ChainCreateForm, entryGroupId: number | null): ChainCreateForm => {
    const stripped = stripExternalChainHosts(prev.hopHostIds, prev.hopConnectHosts, entryGroupId);
    return {
      ...prev,
      entryGroupId,
      hopHostIds: stripped.hopHostIds,
      hopConnectHosts: stripped.hopConnectHosts,
    };
  };
  const buildActualTunnelRoute = (source: TunnelForm) => {
    const displayRoute = stripExternalTunnelHosts(source.hopHostIds, source.hopConnectHosts, source.entryGroupId, source.exitGroupId);
    const entryGroupHostId = primaryEntryHostIdForGroup(source.entryGroupId);
    const exitGroupHostId = primaryExitHostIdForGroup(source.exitGroupId);
    const actualIds = [
      entryGroupHostId || null,
      ...displayRoute.hopHostIds,
      exitGroupHostId || null,
    ].filter((id): id is number => Number(id || 0) > 0);
    const fallbackIds = actualIds.length > 0 ? actualIds : source.hopHostIds.filter((id) => Number(id || 0) > 0);
    const connectHostByHostId = new Map(displayRoute.hopHostIds.map((hostId, index) => [Number(hostId || 0), displayRoute.hopConnectHosts[index] || null]));
    const exitGroupConnectHost = source.exitGroupId ? String(exitMembersForGroup(source.exitGroupId)[0]?.connectHost || "").trim() || null : null;
    const rawConnectHosts = fallbackIds.map((hostId, index) => {
      if (index === 0) return null;
      if (exitGroupHostId && Number(hostId) === Number(exitGroupHostId)) return exitGroupConnectHost;
      return connectHostByHostId.get(Number(hostId)) || null;
    });
    return {
      hopHostIds: fallbackIds,
      hopConnectHosts: normalizeHopConnectHostsForHosts(rawConnectHosts, fallbackIds, hosts),
    };
  };
  const inferExitGroupIdForTunnel = (tunnel: any, hopIds: number[]) => {
    const activeExitIds = [
      Number(hopIds[hopIds.length - 1] || tunnel?.exitHostId || 0),
      ...((Array.isArray(tunnel?.loadBalanceExits) ? tunnel.loadBalanceExits : [])
        .map((exit: any) => Number(exit?.hostId || 0))
        .filter((id: number) => id > 0)),
    ];
    if (activeExitIds.length === 0) return null;
    for (const group of exitGroups) {
      const groupIds = enabledHostGroupMembers(group).map((member: any) => Number(member.hostId || 0));
      if (groupIds.length === activeExitIds.length && groupIds.every((id: number, index: number) => id === activeExitIds[index])) return Number(group.id);
    }
    return null;
  };
  const applyExitGroupToForm = (prev: TunnelForm, exitGroupId: number | null): TunnelForm => {
    if (!exitGroupId) return { ...prev, exitGroupId: null, loadBalanceEnabled: false, loadBalanceExits: [] };
    const members = exitMembersForGroup(exitGroupId);
    if (members.length === 0) return { ...prev, exitGroupId, loadBalanceEnabled: false, loadBalanceExits: [] };
    const primaryExitHostId = Number(members[0]?.hostId || 0);
    const stripped = stripExternalTunnelHosts(prev.hopHostIds, prev.hopConnectHosts, prev.entryGroupId, exitGroupId);
    return {
      ...prev,
      exitGroupId,
      exitHostId: primaryExitHostId || prev.exitHostId,
      hopHostIds: stripped.hopHostIds,
      hopConnectHosts: stripped.hopConnectHosts,
      loadBalanceEnabled: members.length > 1,
      loadBalanceExits: members.slice(1).map((member: any) => ({
        hostId: Number(member.hostId || 0) || null,
        connectHost: String(member.connectHost || "").trim(),
      })),
    };
  };
  const tunnelPagination = usePersistentPagination(tunnels || [], {
    storageKey: "forwardx.tunnels.page",
    pageSize: 12,
    isReady: !isLoading && !!tunnels,
  });
  const pagedTunnels = tunnelPagination.items;
  const editingTunnel = useMemo(
    () => editingId ? (tunnels || []).find((tunnel: any) => Number(tunnel.id) === Number(editingId)) || null : null,
    [editingId, tunnels]
  );
  const renderTunnelStatusDot = (tunnel: any, supported = true) => {
    if (!supported) return <span className="h-2.5 w-2.5 rounded-full bg-destructive/60" />;
    if (tunnel.isRunning) return <span className="h-2.5 w-2.5 rounded-full bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" />;
    if (tunnel.isEnabled) return <span className="h-2.5 w-2.5 rounded-full bg-amber-400 shadow-sm shadow-amber-400/50" />;
    return <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />;
  };
  const renderTunnelRoute = (tunnel: any, compact = false) => {
    const hopIds = getTunnelHopIds(tunnel);
    const entryGroup = Number(tunnel?.entryGroupId || 0) > 0 ? entryGroupById.get(Number(tunnel.entryGroupId)) : null;
    const entryGroupLabel = entryGroup
      ? `${String(entryGroup.name || "入口组").trim()}${String(entryGroup.domain || "").trim() ? ` (${String(entryGroup.domain).trim()})` : ""}`
      : "";
    const visibleHopIds = entryGroup
      ? hopIds.filter((hostId: number) => !entryMembersForGroup(Number(entryGroup.id)).some((member: any) => Number(member.hostId || 0) === Number(hostId)))
      : hopIds;
    const extraExitNames = getTunnelLoadBalanceExitNames(tunnel, hosts);
    const exitNames = extraExitNames.length > 0 ? getTunnelExitNames(tunnel, hosts) : [];
    const routeTitle = [
      entryGroupLabel ? `入口组：${entryGroupLabel}` : "",
      getTunnelRouteText(tunnel, hosts),
    ].filter(Boolean).join("；");
    return (
      <div
        className={`flex min-w-0 items-center gap-1.5 text-xs ${compact || exitNames.length > 0 ? "flex-wrap" : "whitespace-nowrap"}`}
        title={routeTitle}
      >
        {entryGroupLabel && (
          <span className="flex min-w-0 items-center gap-1 rounded border border-primary/20 bg-primary/5 px-1.5 py-0.5 text-primary">
            <span className="shrink-0">入口组</span>
            <span className={compact ? "max-w-[10rem] truncate" : "min-w-0 truncate"}>{entryGroupLabel}</span>
          </span>
        )}
        {visibleHopIds.map((hostId: number, index: number) => (
          <Fragment key={`${tunnel.id || "tunnel"}-${hostId}-${index}`}>
            {(index > 0 || entryGroupLabel) && <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
            <span className={compact ? "max-w-[8rem] truncate" : "truncate"}>
              {tunnelHopHostName(tunnel, hostId, hosts)}
            </span>
          </Fragment>
        ))}
        {exitNames.length > 0 && (
          <span className="flex min-w-0 items-center gap-1 rounded border border-border/50 bg-muted/30 px-1.5 py-0.5 text-muted-foreground">
            <span className="shrink-0">出口</span>
            <span className="min-w-0 truncate">{exitNames.join(" / ")}</span>
          </span>
        )}
      </div>
    );
  };
  const resetForm = () => {
    const fallbackMode = resolveDefaultTunnelMode();
    setForm({ ...defaultForm, mode: fallbackMode });
    setTunnelProxyPanelOpen(false);
    setTunnelAdvancedOpen(false);
    setEditingId(null);
  };

  const resetChainCreateForm = () => {
    setChainCreateForm({ ...defaultChainCreateForm, forwardType: defaultChainForwardType });
    setChainAdvancedOpen(false);
  };

  const resetTunnelCreateForm = () => {
    resetForm();
    const fallbackMode = resolveDefaultTunnelMode();
    setForm({
      ...defaultForm,
      mode: fallbackMode,
      entryGroupId: null,
      entryHostId: null,
      exitHostId: null,
      hopHostIds: [],
      hopConnectHosts: [],
      loadBalanceEnabled: false,
      loadBalanceExits: [],
      exitGroupId: null,
    });
    setTunnelAdvancedOpen(false);
  };

  const openEdit = (tunnel: any) => {
    if (!isTunnelSupported(tunnel)) return;
    const hopHostIds = Array.isArray(tunnel.hopHostIds) && tunnel.hopHostIds.length >= 2
      ? tunnel.hopHostIds
      : [tunnel.entryHostId, tunnel.exitHostId];
    const hopConnectHosts = Array.isArray(tunnel.hopConnectHosts) && tunnel.hopConnectHosts.length >= 2
      ? tunnel.hopConnectHosts
      : [null, tunnel.connectHost || null];
    const loadBalanceExits = Array.isArray(tunnel.loadBalanceExits)
      ? tunnel.loadBalanceExits.map((exit: any) => {
        const hostId = Number(exit.hostId) || null;
        const host = hosts?.find((item: any) => Number(item.id) === Number(hostId));
        const privateAddr = hostPrivateAddress(host);
        const ipv6Addr = hostIpv6Address(host);
        const connectHost = String(exit.connectHost || "").trim();
        return {
          hostId,
          connectHost: (privateAddr && sameAddress(connectHost, privateAddr)) || (ipv6Addr && sameAddress(connectHost, ipv6Addr)) ? connectHost : "",
        };
      }).slice(0, MAX_EXTRA_TUNNEL_EXITS)
      : [];
    const entryGroupId = tunnel.entryGroupId ? Number(tunnel.entryGroupId) : null;
    const exitGroupId = inferExitGroupIdForTunnel(tunnel, hopHostIds);
    const displayRoute = stripExternalTunnelHosts(hopHostIds, hopConnectHosts, entryGroupId, exitGroupId);
    const mode = normalizeTunnelModeForForm(tunnel.mode || "tls");
    const proxySupported = isTunnelProxyProtocolSupported(mode);
    const transportTuningSupported = isTunnelTransportTuningSupported(mode);
    const proxyAnyEnabled = proxySupported && (
      !!tunnel.proxyProtocolReceive ||
      !!tunnel.proxyProtocolSend ||
      !!tunnel.proxyProtocolExitReceive ||
      !!tunnel.proxyProtocolExitSend
    );
    const nextForm: TunnelForm = {
      name: tunnel.name,
      entryGroupId,
      entryHostId: tunnel.entryHostId,
      exitHostId: tunnel.exitHostId,
      hopHostIds: displayRoute.hopHostIds,
      hopConnectHosts: displayRoute.hopConnectHosts,
      mode,
      certDomain: String(tunnel.certDomain || ""),
      certPem: String(tunnel.certPem || ""),
      certKeyPem: String(tunnel.certKeyPem || ""),
      listenPort: tunnel.listenPort,
      rateLimitMbps: Number(tunnel.rateLimitMbps || 0),
      trafficMultiplier: trafficMultiplierToInputValue((tunnel as any).trafficMultiplier),
      networkType: tunnel.networkType === "private" ? "private" : "public",
      connectHost: tunnel.connectHost || "",
      proxyProtocolReceive: proxySupported && !!tunnel.proxyProtocolReceive,
      proxyProtocolSend: proxySupported && !!tunnel.proxyProtocolSend,
      proxyProtocolExitReceive: proxySupported && !!tunnel.proxyProtocolExitReceive,
      proxyProtocolExitSend: proxySupported && !!tunnel.proxyProtocolExitSend,
      proxyProtocolVersion: Number(tunnel.proxyProtocolVersion) === 2 ? 2 : 1,
      tcpFastOpen: transportTuningSupported && !!tunnel.tcpFastOpen,
      udpOverTcp: transportTuningSupported && !!tunnel.udpOverTcp,
      loadBalanceEnabled: exitGroupId ? !!tunnel.loadBalanceEnabled : false,
      loadBalanceStrategy: (["round_robin", "random", "least_conn", "ip_hash", "fallback"].includes(String(tunnel.loadBalanceStrategy || ""))
        ? tunnel.loadBalanceStrategy
        : "round_robin") as TunnelForm["loadBalanceStrategy"],
      loadBalanceExits: exitGroupId ? loadBalanceExits : [],
      exitGroupId,
      blockHttp: false,
      blockSocks: false,
      blockTls: false,
    };
    setForm(exitGroupId ? applyExitGroupToForm(nextForm, exitGroupId) : nextForm);
    setTunnelProxyPanelOpen(proxyAnyEnabled);
    setTunnelAdvancedOpen(false);
    setEditingId(tunnel.id);
    setShowDialog(true);
  };

  const createMutation = trpc.tunnels.create.useMutation({
    onSuccess: () => {
      utils.tunnels.list.invalidate();
      setShowDialog(false);
      setShowCreateTypeDialog(false);
      setActiveSection("tunnels");
      resetForm();
      toast.success("隧道已创建");
    },
    onError: (e) => toast.error(e.message || "创建失败"),
  });

  useEffect(() => {
    if (availableChainForwardTypes.length === 0) return;
    if (availableChainForwardTypes.includes(chainCreateForm.forwardType)) return;
    setChainCreateForm((prev) => ({ ...prev, forwardType: availableChainForwardTypes[0] }));
  }, [availableChainForwardTypes, chainCreateForm.forwardType]);

  const createChainMutation = trpc.forwardGroups.create.useMutation({
    onSuccess: () => {
      utils.forwardGroups.list.invalidate();
      utils.rules.list.invalidate();
      setShowCreateTypeDialog(false);
      setActiveSection("chains");
      resetChainCreateForm();
      toast.success("端口转发链已创建");
    },
    onError: (e) => toast.error(e.message || "创建失败"),
  });

  const updateMutation = trpc.tunnels.update.useMutation({
    onSuccess: () => {
      utils.tunnels.list.invalidate();
      setShowDialog(false);
      resetForm();
      toast.success("隧道已更新");
    },
    onError: (e) => toast.error(e.message || "更新失败"),
  });

  const deleteMutation = trpc.tunnels.delete.useMutation({
    onSuccess: () => {
      utils.tunnels.list.invalidate();
      utils.rules.list.invalidate();
      setDeleteTunnel(null);
      toast.success("隧道已删除");
    },
    onError: (e) => toast.error(e.message || "删除失败"),
  });

  const handleSubmit = () => {
    const selectedExitMembers = form.exitGroupId ? exitMembersForGroup(form.exitGroupId) : [];
    const selectedEntryMembers = form.entryGroupId ? entryMembersForGroup(form.entryGroupId) : [];
    if (form.entryGroupId && selectedEntryMembers.length === 0) {
      toast.error("请选择可用的入口组");
      return;
    }
    if (form.exitGroupId && selectedExitMembers.length === 0) {
      toast.error("请选择可用的出口组");
      return;
    }
    const submitForm = form.exitGroupId ? applyExitGroupToForm(form, form.exitGroupId) : form;
    const actualRoute = buildActualTunnelRoute(submitForm);
    if (!submitForm.name || actualRoute.hopHostIds.length < 2) {
      toast.error("请填写隧道名称并至少选择入口主机和出口组");
      return;
    }
    if (actualRoute.hopHostIds.length > MAX_TUNNEL_HOPS) {
      toast.error(`多级隧道最多支持 ${MAX_TUNNEL_HOPS} 级`);
      return;
    }
    const orderedHopHostIds = [...actualRoute.hopHostIds];
    const orderedHopConnectHosts = [...actualRoute.hopConnectHosts];
    const entryHostId = orderedHopHostIds[0] || 0;
    const exitHostId = orderedHopHostIds[orderedHopHostIds.length - 1] || 0;
    if (!entryHostId || !exitHostId || entryHostId === exitHostId) {
      toast.error("请确保入口与出口主机有效且不同");
      return;
    }
    if (new Set(orderedHopHostIds).size !== orderedHopHostIds.length) {
      toast.error("主机链路中的主机不能重复");
      return;
    }
    if (!isValidPort(submitForm.listenPort, true)) {
      toast.error("出口监听端口必须为 0 或 1-65535，0 表示自动分配");
      return;
    }
    const certDomain = String(submitForm.certDomain || "").trim();
    const certPem = normalizePemText(submitForm.certPem);
    const certKeyPem = normalizePemText(submitForm.certKeyPem);
    if (isNginxTunnelModeValue(submitForm.mode) && certDomain && !isValidConnectHost(certDomain)) {
      toast.error("证书域名格式无效");
      return;
    }
    if (isNginxTunnelModeValue(submitForm.mode) && ((certPem && !certKeyPem) || (!certPem && certKeyPem))) {
      toast.error("Nginx 自定义证书和私钥需要同时填写");
      return;
    }
    const rateLimitMbps = Number(submitForm.rateLimitMbps) || 0;
    if (!Number.isInteger(rateLimitMbps) || rateLimitMbps < 0 || rateLimitMbps > 1_000_000) {
      toast.error("隧道限速必须为 0 或正整数 Mbps，0 表示不限速");
      return;
    }
    const trafficMultiplierValue = Number(submitForm.trafficMultiplier);
    if (!Number.isFinite(trafficMultiplierValue) || trafficMultiplierValue < 0.01 || trafficMultiplierValue > 50) {
      toast.error("流量倍率必须在 0.01 - 50 之间");
      return;
    }
    const trafficMultiplier = trafficMultiplierFromInput(trafficMultiplierValue);
    if (!isTunnelSupported(submitForm)) {
      toast.error(unsupportedProtocolTitle);
      return;
    }
    let hasPrivateHop = false;
    for (let i = 1; i < orderedHopConnectHosts.length; i++) {
      const value = String(orderedHopConnectHosts[i] || "").trim();
      if (value && !isValidConnectHost(value)) {
        toast.error(`第 ${i + 1} 跳指定地址格式无效`);
        return;
      }
      if (!value) continue;
      const hopHostId = Number(orderedHopHostIds[i] || 0);
      const hopHost = hosts?.find((h: any) => Number(h.id) === hopHostId);
      const privateAddr = hostPrivateAddress(hopHost);
      if (privateAddr && sameAddress(value, privateAddr)) {
        hasPrivateHop = true;
        continue;
      }
      const ipv6Addr = hostIpv6Address(hopHost);
      if (ipv6Addr && sameAddress(value, ipv6Addr)) continue;
      const publicAddr = hostPublicAddress(hopHost);
      if (publicAddr && sameAddress(value, publicAddr)) continue;
      toast.error(`第 ${i + 1} 跳只能使用入口地址、内网IP或IPv6地址`);
      return;
    }
    const isMultiHopTunnel = orderedHopHostIds.length >= 3;
    const exitHost = hosts?.find((h: any) => Number(h.id) === exitHostId);
    const exitPrivateAddr = hostPrivateAddress(exitHost);
    const exitIpv6Addr = hostIpv6Address(exitHost);
    const regularConnectHost = String(orderedHopConnectHosts[1] || "").trim();
    const regularPrivateConnectHost = !isMultiHopTunnel && exitPrivateAddr && regularConnectHost === exitPrivateAddr
      ? exitPrivateAddr
      : null;
    const regularIpv6ConnectHost = !isMultiHopTunnel && exitIpv6Addr && regularConnectHost === exitIpv6Addr
      ? exitIpv6Addr
      : null;
    const loadBalanceExits = submitForm.loadBalanceExits
      .map((exit) => ({ hostId: Number(exit.hostId || 0), connectHost: String(exit.connectHost || "").trim() }))
      .filter((exit) => exit.hostId > 0 || exit.connectHost);
    const loadBalanceEnabled = !!submitForm.loadBalanceEnabled && loadBalanceExits.length > 0;
    if (loadBalanceEnabled) {
      if (loadBalanceExits.length > MAX_EXTRA_TUNNEL_EXITS) {
        toast.error(`最多额外添加 ${MAX_EXTRA_TUNNEL_EXITS} 个出口`);
        return;
      }
      const usedExitIds = new Set<number>(orderedHopHostIds.map((id) => Number(id)).filter((id) => id > 0));
      for (const exit of loadBalanceExits) {
        if (!exit.hostId) {
          toast.error("出口组包含无效出口 Agent");
          return;
        }
        if (usedExitIds.has(exit.hostId)) {
          toast.error("出口组成员不能与主机链路中的主机重复");
          return;
        }
        usedExitIds.add(exit.hostId);
        const exitHost = hosts?.find((h: any) => Number(h.id) === exit.hostId);
        if (exit.connectHost && !normalizeConnectHostForHost(exit.connectHost, exitHost, null)) {
          toast.error("出口组连接地址只能使用内网IP或IPv6地址");
          return;
        }
        if (exit.connectHost && !isValidConnectHost(exit.connectHost)) {
          toast.error("出口组连接地址格式无效");
          return;
        }
      }
    }
    const proxySupported = isTunnelProxyProtocolSupported(submitForm.mode);
    const proxyAnyEnabled = proxySupported && (
      submitForm.proxyProtocolReceive ||
      submitForm.proxyProtocolSend ||
      submitForm.proxyProtocolExitReceive ||
      submitForm.proxyProtocolExitSend
    );
    const transportTuningSupported = isTunnelTransportTuningSupported(submitForm.mode);
    const payload: any = {
      name: submitForm.name,
      mode: normalizeTunnelModeForForm(submitForm.mode),
      certDomain: isNginxTunnelModeValue(submitForm.mode) ? certDomain || null : null,
      certPem: isNginxTunnelModeValue(submitForm.mode) ? certPem || null : null,
      certKeyPem: isNginxTunnelModeValue(submitForm.mode) ? certKeyPem || null : null,
      listenPort: submitForm.listenPort,
      rateLimitMbps,
      trafficMultiplier,
      networkType: isMultiHopTunnel
        ? (hasPrivateHop ? "private" : "public")
        : (regularPrivateConnectHost ? "private" : "public"),
      connectHost: isMultiHopTunnel ? null : (regularPrivateConnectHost || regularIpv6ConnectHost),
      proxyProtocolReceive: proxySupported && submitForm.proxyProtocolReceive,
      proxyProtocolSend: proxySupported && submitForm.proxyProtocolSend,
      proxyProtocolExitReceive: proxySupported && submitForm.proxyProtocolExitReceive,
      proxyProtocolExitSend: proxySupported && submitForm.proxyProtocolExitSend,
      proxyProtocolVersion: proxyAnyEnabled ? submitForm.proxyProtocolVersion : 1,
      tcpFastOpen: transportTuningSupported && submitForm.tcpFastOpen,
      udpOverTcp: transportTuningSupported && submitForm.udpOverTcp,
      entryGroupId: submitForm.entryGroupId || null,
      entryHostId,
      exitHostId,
      hopHostIds: orderedHopHostIds,
      hopConnectHosts: orderedHopConnectHosts.map((value) => {
        const text = String(value || "").trim();
        return text ? text : null;
      }),
      loadBalanceEnabled,
      loadBalanceStrategy: loadBalanceEnabled ? submitForm.loadBalanceStrategy : "round_robin",
      loadBalanceExits: loadBalanceEnabled
        ? loadBalanceExits.map((exit) => ({
          hostId: exit.hostId,
          connectHost: exit.connectHost || null,
        }))
        : [],
    };
    if (editingId) updateMutation.mutate({ id: editingId, ...payload });
    else createMutation.mutate(payload);
  };

  const handleChainCreateSubmit = () => {
    const name = chainCreateForm.name.trim();
    const minChainHops = chainCreateForm.entryGroupId ? 1 : 2;
    if (!name || chainCreateForm.hopHostIds.length < minChainHops) {
      toast.error(chainCreateForm.entryGroupId ? "请填写链名称并至少选择一台主机" : "请填写链名称并至少选择两台主机");
      return;
    }
    if (chainCreateForm.hopHostIds.length > 5) {
      toast.error("端口转发链最多支持 5 台主机");
      return;
    }
    const normalizedConnectHosts = normalizeChainConnectHostsForHosts(
      chainCreateForm.hopConnectHosts,
      chainCreateForm.hopHostIds,
      hosts,
      !!chainCreateForm.entryGroupId,
    );
    const trafficMultiplierValue = Number(chainCreateForm.trafficMultiplier);
    if (!Number.isFinite(trafficMultiplierValue) || trafficMultiplierValue < 0.01 || trafficMultiplierValue > 50) {
      toast.error("流量倍率必须在 0.01 - 50 之间");
      return;
    }
    const trafficMultiplier = trafficMultiplierFromInput(trafficMultiplierValue);
    if (!availableChainForwardTypes.includes(chainCreateForm.forwardType)) {
      toast.error("请选择可用的转发工具");
      return;
    }
    const chainProxyProtocolSupported = chainCreateForm.forwardType === "gost" || chainCreateForm.forwardType === "realm";
    const chainRealmOptimizationSupported = chainCreateForm.forwardType === "realm";
    createChainMutation.mutate({
      name,
      entryGroupId: chainCreateForm.entryGroupId || null,
      groupMode: "chain",
      groupType: "host",
      forwardType: chainCreateForm.forwardType,
      proxyProtocolReceive: chainProxyProtocolSupported && chainCreateForm.proxyProtocolReceive,
      proxyProtocolSend: chainProxyProtocolSupported && chainCreateForm.proxyProtocolSend,
      proxyProtocolVersion: chainProxyProtocolSupported && Number(chainCreateForm.proxyProtocolVersion) === 2 ? 2 : 1,
      tcpFastOpen: chainRealmOptimizationSupported && chainCreateForm.tcpFastOpen,
      zeroCopy: chainRealmOptimizationSupported && chainCreateForm.zeroCopy,
      domain: null,
      recordType: "A",
      failoverSeconds: 60,
      recoverSeconds: 120,
      trafficMultiplier,
      autoFailback: true,
      isEnabled: chainCreateForm.isEnabled,
      members: chainCreateForm.hopHostIds.map((hostId, index) => ({
        memberType: "host",
        hostId,
        tunnelId: null,
        connectHost: normalizedConnectHosts[index] || null,
        isEnabled: true,
        priority: index,
      })),
    });
  };

  const isPending = createMutation.isPending || updateMutation.isPending;
  const isCreateTypePending = selectedCreateType === "chain" ? createChainMutation.isPending : createMutation.isPending;
  const gostRuntimeDisabled = enabledGostTunnelModes.length === 0;
  const forwardxRuntimeDisabled = forwardProtocolSettings.forwardx === false;
  const setChainForwardType = (forwardType: ForwardType) => {
    const proxySupported = forwardType === "gost" || forwardType === "realm";
    const realmOptimizationSupported = forwardType === "realm";
    setChainCreateForm((prev) => ({
      ...prev,
      forwardType,
      proxyProtocolReceive: proxySupported ? prev.proxyProtocolReceive : false,
      proxyProtocolSend: proxySupported ? prev.proxyProtocolSend : false,
      proxyProtocolVersion: proxySupported ? prev.proxyProtocolVersion : 1,
      tcpFastOpen: realmOptimizationSupported ? prev.tcpFastOpen : false,
      zeroCopy: realmOptimizationSupported ? prev.zeroCopy : false,
    }));
  };
  const setTunnelMode = (mode: TunnelForm["mode"]) => {
    const nextMode = normalizeTunnelModeForForm(mode);
    const proxySupported = isTunnelProxyProtocolSupported(nextMode);
    const transportTuningSupported = isTunnelTransportTuningSupported(nextMode);
    if (!proxySupported) setTunnelProxyPanelOpen(false);
    setForm((prev) => ({
      ...prev,
      mode: nextMode,
      proxyProtocolReceive: proxySupported ? prev.proxyProtocolReceive : false,
      proxyProtocolSend: proxySupported ? prev.proxyProtocolSend : false,
      proxyProtocolExitReceive: proxySupported ? prev.proxyProtocolExitReceive : false,
      proxyProtocolExitSend: proxySupported ? prev.proxyProtocolExitSend : false,
      proxyProtocolVersion: proxySupported ? prev.proxyProtocolVersion : 1,
      tcpFastOpen: transportTuningSupported ? prev.tcpFastOpen : false,
      udpOverTcp: transportTuningSupported ? prev.udpOverTcp : false,
    }));
  };
  const renderNginxCertFields = () => (
    <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="space-y-2">
        <Label>证书域名 / SNI</Label>
        <Input value={form.certDomain} onChange={(e) => setForm({ ...form, certDomain: e.target.value })} placeholder="example.com" />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-2">
          <Label>自定义证书 PEM</Label>
          <Textarea
            value={form.certPem}
            onChange={(e) => setForm({ ...form, certPem: e.target.value })}
            placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"}
            className="min-h-[132px] font-mono text-xs"
          />
        </div>
        <div className="space-y-2">
          <Label>私钥 PEM</Label>
          <Textarea
            value={form.certKeyPem}
            onChange={(e) => setForm({ ...form, certKeyPem: e.target.value })}
            placeholder={"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"}
            className="min-h-[132px] font-mono text-xs"
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        证书与私钥需要同时填写。填写后 Nginx 隧道的 TCP 入口到出口段会使用 TLS，UDP 仍按 Stream 四层转发；未填写时保持普通 Nginx Stream。
      </p>
    </div>
  );
  const renderChainRuntimeOptions = () => {
    const proxySupported = chainCreateForm.forwardType === "gost" || chainCreateForm.forwardType === "realm";
    const realmOptimizationSupported = chainCreateForm.forwardType === "realm";
    const advancedConfigured = (proxySupported && (chainCreateForm.proxyProtocolReceive || chainCreateForm.proxyProtocolSend))
      || (realmOptimizationSupported && (chainCreateForm.tcpFastOpen || chainCreateForm.zeroCopy));
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
          onClick={() => setChainAdvancedOpen((open) => !open)}
        >
          <div className="min-w-0">
            <div className="text-sm font-medium">高级设置</div>
            <div className="text-xs text-muted-foreground">PROXY Protocol、传输优化</div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={advancedConfigured ? "secondary" : "outline"} className="h-5 px-1.5 text-[10px] font-normal">
              {advancedConfigured ? "已配置" : "可选"}
            </Badge>
            <ChevronRight className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${chainAdvancedOpen ? "rotate-90" : ""}`} />
          </div>
        </button>
        {chainAdvancedOpen && (
          <div className="space-y-3 border-t border-border/45 px-3 pb-3 pt-2">
            <div className="space-y-2">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <Label className="text-sm">PROXY Protocol</Label>
                <Select
                  value={String(chainCreateForm.proxyProtocolVersion)}
                  disabled={!proxySupported}
                  onValueChange={(value) => setChainCreateForm((prev) => ({ ...prev, proxyProtocolVersion: Number(value) === 2 ? 2 : 1 }))}
                >
                  <SelectTrigger className="h-8 w-24"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">V1</SelectItem>
                    <SelectItem value="2">V2</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex min-h-10 items-center justify-between gap-2 rounded-md border border-border/50 bg-background/60 px-2.5 py-2" title={!proxySupported ? "仅 GOST 和 Realm 支持" : undefined}>
                  <span className="min-w-0 truncate text-sm">接收 PROXY</span>
                  <Switch
                    checked={proxySupported && chainCreateForm.proxyProtocolReceive}
                    disabled={!proxySupported}
                    onCheckedChange={(proxyProtocolReceive) => setChainCreateForm((prev) => ({ ...prev, proxyProtocolReceive }))}
                  />
                </label>
                <label className="flex min-h-10 items-center justify-between gap-2 rounded-md border border-border/50 bg-background/60 px-2.5 py-2" title={!proxySupported ? "仅 GOST 和 Realm 支持" : undefined}>
                  <span className="min-w-0 truncate text-sm">发送 PROXY</span>
                  <Switch
                    checked={proxySupported && chainCreateForm.proxyProtocolSend}
                    disabled={!proxySupported}
                    onCheckedChange={(proxyProtocolSend) => setChainCreateForm((prev) => ({ ...prev, proxyProtocolSend }))}
                  />
                </label>
              </div>
            </div>

            <div className="space-y-2 border-t border-border/45 pt-3">
              <Label className="text-sm">传输优化</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex min-h-10 items-center justify-between gap-2 rounded-md border border-border/50 bg-background/60 px-2.5 py-2" title={!realmOptimizationSupported ? "仅 Realm 支持" : undefined}>
                  <span className="min-w-0 truncate text-sm">TCP Fast Open</span>
                  <Switch
                    checked={realmOptimizationSupported && chainCreateForm.tcpFastOpen}
                    disabled={!realmOptimizationSupported}
                    onCheckedChange={(tcpFastOpen) => setChainCreateForm((prev) => ({ ...prev, tcpFastOpen }))}
                  />
                </label>
                <label className="flex min-h-10 items-center justify-between gap-2 rounded-md border border-border/50 bg-background/60 px-2.5 py-2" title={!realmOptimizationSupported ? "仅 Realm 支持" : undefined}>
                  <span className="min-w-0 truncate text-sm">zero-copy</span>
                  <Switch
                    checked={realmOptimizationSupported && chainCreateForm.zeroCopy}
                    disabled={!realmOptimizationSupported}
                    onCheckedChange={(zeroCopy) => setChainCreateForm((prev) => ({ ...prev, zeroCopy }))}
                  />
                </label>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };
  const renderTunnelRuntimeOptions = () => {
    const proxySupported = isTunnelProxyProtocolSupported(form.mode);
    const transportTuningSupported = isTunnelTransportTuningSupported(form.mode);
    if (!proxySupported && !transportTuningSupported) return null;
    const proxyAnyEnabled = form.proxyProtocolReceive || form.proxyProtocolSend || form.proxyProtocolExitReceive || form.proxyProtocolExitSend;
    const advancedConfigured = proxyAnyEnabled || form.tcpFastOpen || form.udpOverTcp;
    const shouldCollapseAdvanced = proxySupported && transportTuningSupported;
    const renderProxySwitch = (label: string, field: "proxyProtocolReceive" | "proxyProtocolSend" | "proxyProtocolExitReceive" | "proxyProtocolExitSend") => (
      <label className="flex min-h-10 items-center justify-between gap-2 rounded-md border border-border/50 bg-background/60 px-2.5 py-2">
        <span className="min-w-0 truncate text-sm">{label}</span>
        <Switch
          checked={form[field]}
          onCheckedChange={(checked) => setForm((prev) => ({ ...prev, [field]: checked }))}
        />
      </label>
    );
    const proxyOptions = proxySupported ? (
      <div className="space-y-2">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <Label className="text-sm">PROXY Protocol</Label>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] leading-none ${proxyAnyEnabled ? "border-primary/25 bg-primary/10 text-primary" : "border-border/50 bg-background/60 text-muted-foreground"}`}>
              {proxyAnyEnabled ? `已配置 V${form.proxyProtocolVersion}` : tunnelProxyPanelOpen ? "待配置" : "关闭"}
            </span>
          </div>
          <Switch
            checked={tunnelProxyPanelOpen}
            onCheckedChange={(checked) => {
              setTunnelProxyPanelOpen(checked);
              if (!checked) {
                setForm((prev) => ({
                  ...prev,
                  proxyProtocolReceive: false,
                  proxyProtocolSend: false,
                  proxyProtocolExitReceive: false,
                  proxyProtocolExitSend: false,
                  proxyProtocolVersion: 1,
                }));
              }
            }}
          />
        </div>
        {tunnelProxyPanelOpen && (
          <div className="space-y-2 border-t border-border/45 pt-2">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">入口和出口独立配置</span>
              <div className={segmentedControlClassName}>
                <div className="grid grid-cols-2 gap-1">
                  {([1, 2] as const).map((version) => (
                    <button
                      key={version}
                      type="button"
                      className={segmentedOptionClassName(form.proxyProtocolVersion === version)}
                      disabled={!proxyAnyEnabled}
                      onClick={() => setForm((prev) => ({ ...prev, proxyProtocolVersion: version }))}
                      title={!proxyAnyEnabled ? "开启任一 PROXY Protocol 开关后可选择版本" : undefined}
                    >
                      V{version}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {renderProxySwitch("入口接收上游", "proxyProtocolReceive")}
              {renderProxySwitch("入口发送到出口", "proxyProtocolSend")}
              {renderProxySwitch("出口接收入口", "proxyProtocolExitReceive")}
              {renderProxySwitch("出口发送到目标", "proxyProtocolExitSend")}
            </div>
          </div>
        )}
      </div>
    ) : null;
    const transportOptions = transportTuningSupported ? (
      <div className="space-y-2 border-t border-border/45 pt-2 first:border-t-0 first:pt-0">
        <Label className="text-sm">传输优化</Label>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex min-h-12 items-center justify-between gap-2 rounded-md border border-border/50 bg-background/60 px-3 py-2">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">TCP Fast Open</span>
              <span className="block truncate text-xs text-muted-foreground">降低 TCP 建连等待</span>
            </span>
            <Switch
              checked={form.tcpFastOpen}
              onCheckedChange={(tcpFastOpen) => setForm((prev) => ({ ...prev, tcpFastOpen }))}
            />
          </label>
          <label className="flex min-h-12 items-center justify-between gap-2 rounded-md border border-border/50 bg-background/60 px-3 py-2">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">mimic UDP 混淆</span>
              <span className="block truncate text-xs text-muted-foreground">ForwardX UDP 外观混淆</span>
            </span>
            <Switch
              checked={form.udpOverTcp}
              onCheckedChange={(udpOverTcp) => setForm((prev) => ({ ...prev, udpOverTcp }))}
            />
          </label>
        </div>
        {form.udpOverTcp && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
            mimic TCP 外观伪装会增加封装开销，UDP 业务明显丢包时建议把业务 MTU 调整到 1200-1300。
          </div>
        )}
      </div>
    ) : null;
    if (!shouldCollapseAdvanced) {
      return (
        <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
          {proxyOptions}
          {transportOptions}
        </div>
      );
    }
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
          onClick={() => setTunnelAdvancedOpen((open) => !open)}
        >
          <div className="min-w-0">
            <div className="text-sm font-medium">高级设置</div>
            <div className="text-xs text-muted-foreground">PROXY Protocol、传输优化</div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={advancedConfigured ? "secondary" : "outline"} className="h-5 px-1.5 text-[10px] font-normal">
              {advancedConfigured ? "已配置" : "可选"}
            </Badge>
            <ChevronRight className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${tunnelAdvancedOpen ? "rotate-90" : ""}`} />
          </div>
        </button>
        {tunnelAdvancedOpen && (
          <div className="space-y-2 border-t border-border/45 px-3 pb-3 pt-2">
            {proxyOptions}
            {transportOptions}
          </div>
        )}
      </div>
    );
  };
  const groupViewMode: "card" | "table" = chainViewMode === "table" ? "table" : "card";
  const handleViewModeChange = (nextViewMode: TunnelViewMode) => {
    setViewMode(nextViewMode);
    storeTunnelViewMode(nextViewMode);
  };
  const handleChainViewModeChange = (nextViewMode: TunnelViewMode) => {
    setChainViewMode(nextViewMode);
    storeChainViewMode(nextViewMode);
  };
  const activeViewMode = activeSection === "tunnels"
    ? viewMode
    : activeSection === "chains"
      ? chainViewMode
      : groupViewMode;
  const handleActiveViewModeChange = (nextViewMode: TunnelViewMode) => {
    if (activeSection === "tunnels") handleViewModeChange(nextViewMode);
    else if (activeSection === "chains") handleChainViewModeChange(nextViewMode);
    else if (nextViewMode !== "globe") handleChainViewModeChange(nextViewMode);
  };
  const activeSectionTransitionKey = activeSection === "chains"
    ? `chains-${chainViewMode}-${forwardGroupsLoading || !forwardGroups ? "loading" : chainGroups.length > 0 ? "list" : "empty"}`
    : activeSection === "groups"
      ? `groups-${groupViewMode}-${forwardGroupsLoading || !forwardGroups ? "loading" : failoverGroups.length > 0 ? "list" : "empty"}`
      : activeSection === "entries"
        ? `entries-${groupViewMode}-${forwardGroupsLoading || !forwardGroups ? "loading" : entryGroups.length > 0 ? "list" : "empty"}`
        : activeSection === "exits"
          ? `exits-${groupViewMode}-${forwardGroupsLoading || !forwardGroups ? "loading" : exitGroups.length > 0 ? "list" : "empty"}`
          : `tunnels-${viewMode}-${isLoading || !tunnels ? "loading" : tunnels.length > 0 ? "list" : "empty"}`;
  const headerStat = activeSection === "chains"
    ? { value: `${activeChainCount} / ${chainGroups.length} 启用`, loading: forwardGroupsLoading || !forwardGroups, cacheKey: "tunnels.header.chainsActive", fallback: "0 / 0 启用", iconClass: "text-primary" }
    : activeSection === "groups"
      ? { value: `${activeFailoverGroupCount} / ${failoverGroups.length} 健康`, loading: forwardGroupsLoading || !forwardGroups, cacheKey: "tunnels.header.forwardGroupsActive", fallback: "0 / 0 健康", iconClass: "text-primary" }
      : activeSection === "entries"
        ? { value: `${activeEntryGroupCount} / ${entryGroups.length} 健康`, loading: forwardGroupsLoading || !forwardGroups, cacheKey: "tunnels.header.entryGroupsActive", fallback: "0 / 0 健康", iconClass: "text-emerald-500" }
        : activeSection === "exits"
          ? { value: `${activeExitGroupCount} / ${exitGroups.length} 可用`, loading: forwardGroupsLoading || !forwardGroups, cacheKey: "tunnels.header.exitGroupsActive", fallback: "0 / 0 可用", iconClass: "text-primary" }
          : { value: `${activeCount} / ${tunnels?.length ?? 0} 活跃`, loading: isLoading || !tunnels, cacheKey: "tunnels.header.active", fallback: "0 / 0 活跃", iconClass: "text-chart-2" };
  const handleGlobeChainEdit = (group: any) => {
    const groupId = Number(group?.id || 0);
    if (!groupId) return;
    setActiveSection("chains");
    handleChainViewModeChange("globe");
    setChainEditRequest({ id: groupId, requestKey: Date.now() });
  };
  const canCreateTunnel = !!hosts?.length
    && hosts.length >= 2
    && (forwardProtocolSettings.forwardx !== false || enabledGostTunnelModes.length > 0 || enabledNginxTunnelModes.length > 0);
  const canCreatePort = !!hosts?.length && allowedForwardTypes.some((type) => forwardProtocolSettings[type] !== false);
  const canCreateChain = !!hosts?.length && hosts.length >= 2 && availableChainForwardTypes.length > 0;
  const canCreateGroup = !!hosts?.length && hosts.length >= 1;
  const activeSectionCreatesGroup = activeSection === "ports" || activeSection === "groups" || activeSection === "entries" || activeSection === "exits";
  const canCreateActive = activeSection === "tunnels"
    ? canCreateTunnel
    : activeSection === "chains"
      ? canCreateChain
      : activeSection === "ports"
        ? canCreatePort
        : activeSectionCreatesGroup
          ? canCreateGroup
          : false;
  const createDisabledTitle = !canCreateActive
    ? (activeSection === "ports" ? (!hosts?.length ? "至少需要 1 台主机" : "暂无可用端口转发协议") : activeSectionCreatesGroup ? "至少需要 1 台主机" : "至少需要 1 台主机并启用可用转发协议，或至少需要 2 台主机创建隧道链路/转发链")
    : !canCreateTunnel && activeSection === "tunnels"
      ? "隧道链路暂不可创建，可选择普通端口转发或端口转发链"
      : !canCreateChain && activeSection === "chains"
        ? (availableChainForwardTypes.length === 0 ? "暂无可用转发工具" : "端口转发链暂不可创建，可选择普通端口转发或隧道链路")
        : undefined;

  const openCreateTypeDialog = () => {
    if (activeSectionCreatesGroup) {
      if (activeSection === "ports" ? !canCreatePort : !canCreateGroup) return;
      setGroupCreateRequest({
        mode: activeSection === "ports" ? "port" : activeSection === "entries" ? "entry" : activeSection === "exits" ? "exit" : "failover",
        requestKey: Date.now(),
      });
      return;
    }
    if (activeSection === "tunnels") {
      if (!canCreateTunnel) return;
      resetTunnelCreateForm();
      setShowDialog(true);
      return;
    }
    if (activeSection === "chains") {
      if (!canCreateChain) return;
      setSelectedCreateType("chain");
      resetChainCreateForm();
      setShowCreateTypeDialog(true);
    }
  };
  const selectedCreateDisabled = selectedCreateType === "tunnel" ? !canCreateTunnel : !canCreateChain;
  const renderUnsupportedHint = (children: ReactNode) => (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent>{unsupportedProtocolTitle}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
  const renderTunnelLatencyLabel = (tunnel: any, compact = false) => {
    const latencyValue = tunnelDisplayLatencyMs(tunnel);
    const latency = typeof latencyValue === "number" && Number.isFinite(latencyValue)
      ? latencyValue
      : null;
    if (latency !== null) {
      return <LatencyRating latencyMs={latency} className={compact ? "text-xs" : undefined} />;
    }
    if (tunnelLatencyIsTimeout(tunnel)) {
      return <LatencyRating isTimeout timeoutText="不可达" className={compact ? "text-xs" : undefined} />;
    }
    return <span className={compact ? "text-xs text-muted-foreground" : "text-muted-foreground"}>未测试</span>;
  };

  const renderTunnelLatencyBreakdown = (tunnel: any, compact = false) => {
    const items = tunnelDisplayLatencyList(tunnel);
    if (items.length === 0) {
      return <span className={compact ? "text-xs text-muted-foreground" : "text-muted-foreground"}>未测试</span>;
    }
    return (
      <div className="space-y-1">
        {items.map((item) => (
          <div key={item.key} className="flex min-w-0 items-center justify-between gap-2 whitespace-nowrap text-xs">
            <span className="min-w-0 truncate text-muted-foreground">{item.label}</span>
            <LatencyRating
              latencyMs={item.latencyMs}
              isTimeout={item.isTimeout}
              icon="none"
              timeoutText="不可达"
              className={compact ? "shrink-0 text-[10px]" : "shrink-0"}
            />
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">链路管理</h1>
          <p className="mt-1 text-xs sm:text-sm text-muted-foreground">
            管理隧道链路、端口转发链和转发组
          </p>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center sm:justify-end">
          <Badge variant="outline" className="justify-center gap-1.5 px-3 py-1.5 text-xs">
            <Activity className="h-3 w-3 text-current" />
            <AnimatedStatValue
              value={headerStat.value}
              loading={headerStat.loading}
              cacheKey={headerStat.cacheKey}
              fallbackValue={headerStat.fallback}
            />
          </Badge>
          <div className="hidden items-center overflow-hidden rounded-md border border-border/40 sm:flex">
            <Button
              variant={activeViewMode === "card" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              onClick={() => handleActiveViewModeChange("card")}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={activeViewMode === "table" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              onClick={() => handleActiveViewModeChange("table")}
            >
              <List className="h-4 w-4" />
            </Button>
            {(activeSection === "tunnels" || activeSection === "chains") && <Button
              variant={activeViewMode === "globe" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              title="3D 地球视图"
              onClick={() => handleActiveViewModeChange("globe")}
            >
              <Globe className="h-4 w-4" />
            </Button>}
          </div>
          <Button
            className="gap-2"
            disabled={!canCreateActive}
            title={createDisabledTitle}
            onClick={openCreateTypeDialog}
          >
            <Plus className="h-4 w-4" />
            新增
          </Button>
        </div>
      </div>

      <Tabs value={activeSection} onValueChange={(value) => setActiveSection(value as TunnelSection)} className="space-y-4">
        <SlidingTabsList items={TUNNEL_SECTION_ITEMS} activeValue={activeSection} ariaLabel="链路管理" minItemWidthRem={7.75} />

        <TabsContent value="tunnels" className="space-y-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight sm:text-xl">隧道链路</h2>
            <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
              管理通过 GOST / ForwardX 串联主机的隧道链路。
            </p>
          </div>
          <TunnelSectionTransition transitionKey={activeSectionTransitionKey}>
      {viewMode === "globe" ? (
        (isLoading || forwardGroupsLoading || !tunnels || !forwardGroups || !hosts) ? (
          <DataSectionLoading label="正在加载全球链路地图" />
        ) : (
          <TunnelWorldGlobe
            tunnels={tunnels || []}
            chainGroups={chainGroups}
            hosts={hosts || []}
            isTunnelSupported={isTunnelSupported}
            onEditTunnel={openEdit}
            onEditChain={handleGlobeChainEdit}
          />
        )
      ) : isLoading ? (
        <DataSectionLoading label="正在加载隧道数据" />
      ) : tunnels && tunnels.length > 0 ? (
        <>
        {viewMode === "card" ? (
          <AutoAnimateContainer className="standard-card-grid gap-4">
            {pagedTunnels.map((tunnel: any) => {
              const supported = isTunnelSupported(tunnel);
              const protocolKey = getTunnelProtocolKey(tunnel);
              return (
                <Card key={tunnel.id} className={`action-card border-border/40 bg-card/60 backdrop-blur-md ${!supported ? "opacity-70" : ""}`} title={!supported ? unsupportedProtocolTitle : undefined}>
                  <CardContent className="action-card-content space-y-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-2">
                        <div className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center">
                          {renderTunnelStatusDot(tunnel, supported)}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate font-medium">{tunnel.name}</p>
                          {!supported && (
                            <p className="mt-1 text-[11px] text-destructive">
                              {tunnelProtocolLabel(protocolKey)} 当前不支持
                            </p>
                          )}
                        </div>
                      </div>
                      {supported ? (
                        <Switch
                          checked={tunnel.isEnabled}
                          onCheckedChange={(checked) => updateMutation.mutate({ id: tunnel.id, isEnabled: checked })}
                          className="scale-75"
                          title={tunnel.isEnabled ? "关闭后该隧道将停止下发和转发" : "开启后该隧道将重新下发并恢复转发"}
                        />
                      ) : (
                        renderUnsupportedHint(<span className="inline-flex"><Switch checked={false} disabled className="scale-75" /></span>)
                      )}
                    </div>

                    <div className="space-y-2 rounded-md bg-muted/25 p-2.5 text-xs">
                      {renderTunnelRoute(tunnel, true)}
                      <div className="flex flex-wrap gap-1.5">
                        <Badge variant="outline" className="text-[10px]">
                          {getTunnelModeDisplay(tunnel.mode, nginxTunnelEnabled)}
                        </Badge>
                      </div>
                    </div>

                    <div className="space-y-1 text-xs">
                      <span className="text-muted-foreground">延迟</span>
                      {renderTunnelLatencyBreakdown(tunnel, true)}
                    </div>

                    <div className="action-card-footer flex justify-end gap-1 border-t border-border/40 pt-2">
                      {supported && (
                        <>
                          <Button variant="ghost" size="icon" className="h-8 w-8" title="查看延迟" onClick={() => setLatencyTunnel({ id: tunnel.id, name: tunnel.name })}>
                            <Activity className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8" title="测试延迟" onClick={() => setTestTunnel({ id: tunnel.id, name: tunnel.name })}>
                            <Stethoscope className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(tunnel)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        title={!supported ? unsupportedProtocolTitle : undefined}
                        onClick={() => setDeleteTunnel(tunnel)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </AutoAnimateContainer>
        ) : (
          <>
          <AutoAnimateContainer className="grid gap-3 sm:hidden">
            {pagedTunnels.map((tunnel: any) => {
              const supported = isTunnelSupported(tunnel);
              const protocolKey = getTunnelProtocolKey(tunnel);
              return (
                <Card key={tunnel.id} className={`action-card border-border/40 bg-card/60 backdrop-blur-md ${!supported ? "opacity-70" : ""}`} title={!supported ? unsupportedProtocolTitle : undefined}>
                  <CardContent className="action-card-content space-y-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-2">
                        <div className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center">
                          {renderTunnelStatusDot(tunnel, supported)}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate font-medium">{tunnel.name}</p>
                          {!supported && (
                            <p className="mt-1 text-[11px] text-destructive">
                              {tunnelProtocolLabel(protocolKey)} 当前不支持
                            </p>
                          )}
                        </div>
                      </div>
                      {supported ? (
                        <Switch
                          checked={tunnel.isEnabled}
                          onCheckedChange={(checked) => updateMutation.mutate({ id: tunnel.id, isEnabled: checked })}
                          className="scale-75"
                          title={tunnel.isEnabled ? "关闭后该隧道将停止下发和转发" : "开启后该隧道将重新下发并恢复转发"}
                        />
                      ) : (
                        renderUnsupportedHint(<span className="inline-flex"><Switch checked={false} disabled className="scale-75" /></span>)
                      )}
                    </div>

                    <div className="space-y-2 rounded-md bg-muted/25 p-2.5 text-xs">
                      {renderTunnelRoute(tunnel, true)}
                      <div className="flex flex-wrap gap-1.5">
                        <Badge variant="outline" className="text-[10px]">
                          {getTunnelModeDisplay(tunnel.mode, nginxTunnelEnabled)}
                        </Badge>
                      </div>
                    </div>

                    <div className="space-y-1 text-xs">
                      <span className="text-muted-foreground">延迟</span>
                      {renderTunnelLatencyBreakdown(tunnel, true)}
                    </div>

                    <div className="action-card-footer flex justify-end gap-1 border-t border-border/40 pt-2">
                      {supported && (
                        <>
                          <Button variant="ghost" size="icon" className="h-8 w-8" title="查看延迟" onClick={() => setLatencyTunnel({ id: tunnel.id, name: tunnel.name })}>
                            <Activity className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8" title="测试延迟" onClick={() => setTestTunnel({ id: tunnel.id, name: tunnel.name })}>
                            <Stethoscope className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(tunnel)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        title={!supported ? unsupportedProtocolTitle : undefined}
                        onClick={() => setDeleteTunnel(tunnel)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </AutoAnimateContainer>
          <Card className="hidden border-border/40 bg-card/60 backdrop-blur-md sm:block">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[72px] whitespace-nowrap text-center">状态</TableHead>
                    <TableHead>隧道名称</TableHead>
                    <TableHead>链路</TableHead>
                    <TableHead className="hidden md:table-cell">模式</TableHead>
                    <TableHead className="hidden md:table-cell">延迟</TableHead>
                    <TableHead>开关</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <AutoAnimateContainer as={TableBody}>
                  {pagedTunnels.map((tunnel: any) => {
                    const supported = isTunnelSupported(tunnel);
                    const protocolKey = getTunnelProtocolKey(tunnel);
                    return (
                    <TableRow key={tunnel.id} className={!supported ? "opacity-70" : ""} title={!supported ? unsupportedProtocolTitle : undefined}>
                      <TableCell>
                        <div className="flex items-center justify-center">
                          {renderTunnelStatusDot(tunnel, supported)}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="font-medium">{tunnel.name}</span>
                        {!supported && (
                          <span className="mt-1 block text-[11px] text-destructive">
                            {tunnelProtocolLabel(protocolKey)} 当前不支持
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex min-w-0 items-center gap-2 text-xs">
                          {renderTunnelRoute(tunnel)}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className="text-[10px]">
                            {getTunnelModeDisplay(tunnel.mode, nginxTunnelEnabled)}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {renderTunnelLatencyBreakdown(tunnel, true)}
                      </TableCell>
                      <TableCell>
                        {supported ? (
                          <Switch
                            checked={tunnel.isEnabled}
                            onCheckedChange={(checked) => updateMutation.mutate({ id: tunnel.id, isEnabled: checked })}
                            className="scale-75"
                            title={tunnel.isEnabled ? "关闭后该隧道将停止下发和转发" : "开启后该隧道将重新下发并恢复转发"}
                          />
                        ) : (
                          renderUnsupportedHint(<span className="inline-flex"><Switch checked={false} disabled className="scale-75" /></span>)
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {supported && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                title="查看入口到出口延迟"
                                onClick={() => setLatencyTunnel({ id: tunnel.id, name: tunnel.name })}
                              >
                                <Activity className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                title="测试入口到出口延迟"
                                onClick={() => setTestTunnel({ id: tunnel.id, name: tunnel.name })}
                              >
                                <Stethoscope className="h-3.5 w-3.5" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(tunnel)}>
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            title={!supported ? unsupportedProtocolTitle : undefined}
                            onClick={() => setDeleteTunnel(tunnel)}
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
          <PersistentPagination pagination={tunnelPagination} itemName="条隧道" />
        </>
      ) : (
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardContent className="p-0">
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/30">
                <Network className="h-8 w-8 opacity-40" />
              </div>
              <p className="text-lg font-medium">暂无隧道</p>
              <p className="mt-1 text-sm text-muted-foreground/60">选择两台 Agent 创建第一条隧道</p>
            </div>
          </CardContent>
        </Card>
      )}
          </TunnelSectionTransition>
        </TabsContent>

        <TabsContent value="ports" className="space-y-4">
          <TunnelSectionTransition transitionKey={`ports-${groupViewMode}-${forwardGroupsLoading || !forwardGroups ? "loading" : "ready"}`}>
            <ForwardGroupsContent
              mode="port"
              embedded
              viewMode={groupViewMode}
              onViewModeChange={(nextViewMode) => handleChainViewModeChange(nextViewMode)}
              hideHeaderActions
              createRequestKey={groupCreateRequest?.mode === "port" ? groupCreateRequest.requestKey : undefined}
            />
          </TunnelSectionTransition>
        </TabsContent>
        <TabsContent value="chains" className="space-y-4">
          <TunnelSectionTransition transitionKey={activeSectionTransitionKey}>
          {chainViewMode === "globe" ? (
            <>
              {(isLoading || forwardGroupsLoading || !tunnels || !forwardGroups || !hosts) ? (
                <DataSectionLoading label="正在加载全球链路地图" />
              ) : (
                <TunnelWorldGlobe
                  tunnels={tunnels || []}
                  chainGroups={chainGroups}
                  hosts={hosts || []}
                  isTunnelSupported={isTunnelSupported}
                  onEditTunnel={openEdit}
                  onEditChain={handleGlobeChainEdit}
                />
              )}
              <div className="hidden" aria-hidden>
                <ForwardGroupsContent
                  mode="chain"
                  embedded
                  viewMode="card"
                  hideHeaderActions
                  editRequest={chainEditRequest}
                  onEditRequestConsumed={() => setChainEditRequest(null)}
                />
              </div>
            </>
          ) : (
            <ForwardGroupsContent
              mode="chain"
              embedded
              viewMode={chainViewMode}
              onViewModeChange={handleChainViewModeChange}
              hideHeaderActions
              editRequest={chainEditRequest}
              onEditRequestConsumed={() => setChainEditRequest(null)}
            />
          )}
          </TunnelSectionTransition>
        </TabsContent>

        <TabsContent value="groups" className="space-y-4">
          <TunnelSectionTransition transitionKey={activeSectionTransitionKey}>
            <ForwardGroupsContent
              mode="failover"
              embedded
              viewMode={groupViewMode}
              onViewModeChange={(nextViewMode) => handleChainViewModeChange(nextViewMode)}
              hideHeaderActions
              createRequestKey={groupCreateRequest?.mode === "failover" ? groupCreateRequest.requestKey : undefined}
            />
          </TunnelSectionTransition>
        </TabsContent>

        <TabsContent value="entries" className="space-y-4">
          <TunnelSectionTransition transitionKey={activeSectionTransitionKey}>
            <ForwardGroupsContent
              mode="entry"
              embedded
              viewMode={groupViewMode}
              onViewModeChange={(nextViewMode) => handleChainViewModeChange(nextViewMode)}
              hideHeaderActions
              createRequestKey={groupCreateRequest?.mode === "entry" ? groupCreateRequest.requestKey : undefined}
            />
          </TunnelSectionTransition>
        </TabsContent>

        <TabsContent value="exits" className="space-y-4">
          <TunnelSectionTransition transitionKey={activeSectionTransitionKey}>
            <ForwardGroupsContent
              mode="exit"
              embedded
              viewMode={groupViewMode}
              onViewModeChange={(nextViewMode) => handleChainViewModeChange(nextViewMode)}
              hideHeaderActions
              createRequestKey={groupCreateRequest?.mode === "exit" ? groupCreateRequest.requestKey : undefined}
            />
          </TunnelSectionTransition>
        </TabsContent>
      </Tabs>

      {latencyTunnel && (
        <TunnelLatencyDialog
          tunnelId={latencyTunnel.id}
          tunnelName={latencyTunnel.name}
          open={!!latencyTunnel}
          onOpenChange={(open) => !open && setLatencyTunnel(null)}
        />
      )}
      {testTunnel && (
        <TunnelSelfTestDialog
          tunnelId={testTunnel.id}
          tunnelName={testTunnel.name}
          hosts={hosts || []}
          entryGroups={entryGroups}
          open={!!testTunnel}
          onOpenChange={(open) => !open && setTestTunnel(null)}
        />
      )}

      <Dialog open={!!deleteTunnel} onOpenChange={(open) => !open && setDeleteTunnel(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>删除链路</DialogTitle>
            <DialogDescription>
              确认删除 "{deleteTunnel?.name}"？此操作会解除关联转发规则的隧道绑定，并停止这些规则的运行状态。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {deleteImpactQuery.isLoading ? (
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm text-muted-foreground">
                正在检查关联转发规则...
              </div>
            ) : deleteImpactQuery.data?.forwardRuleCount ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm">
                <p className="font-medium text-destructive">
                  当前链路仍关联 {deleteImpactQuery.data.forwardRuleCount} 条转发规则
                </p>
                <div className="mt-2 max-h-44 space-y-1 overflow-auto text-xs text-muted-foreground">
                  {(deleteImpactQuery.data.forwardRules || []).map((rule: any) => (
                    <div key={rule.id} className="rounded border border-border/40 bg-background/60 px-2 py-1">
                      <span className="font-medium text-foreground">{rule.name}</span>
                      <span className="ml-2">:{rule.sourcePort} -&gt; {rule.targetIp}:{rule.targetPort}</span>
                    </div>
                  ))}
                  {deleteImpactQuery.data.forwardRuleCount > (deleteImpactQuery.data.forwardRules || []).length && (
                    <p>还有 {deleteImpactQuery.data.forwardRuleCount - (deleteImpactQuery.data.forwardRules || []).length} 条未显示。</p>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm text-muted-foreground">
                未发现关联转发规则。
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTunnel(null)}>取消</Button>
            <Button
              variant="destructive"
              disabled={!deleteTunnel || deleteMutation.isPending || deleteImpactQuery.isLoading}
              onClick={() => deleteTunnel && deleteMutation.mutate({ id: deleteTunnel.id, confirmRules: true })}
            >
              {deleteMutation.isPending ? "删除中..." : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showCreateTypeDialog} onOpenChange={setShowCreateTypeDialog}>
        <DialogContent className="flex h-[min(92svh,48rem)] w-[calc(100vw-1rem)] max-w-[95vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl sm:p-0">
          <DialogHeader className="shrink-0 px-3.5 pb-2 pt-3.5 pr-12 sm:px-4 sm:pr-12 sm:pt-4">
            <DialogTitle>新增链路</DialogTitle>
          </DialogHeader>
          <div className="dialog-scroll-area min-h-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain px-3.5 py-2.5 sm:px-4">
                {selectedCreateType === "tunnel" ? (
                  <>
                    <div className="space-y-2">
                      <Label>隧道名称</Label>
                      <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如: 华东-香港隧道" />
                    </div>
                    <div className="space-y-2">
                      <Label>入口组</Label>
                      <Select
                        value={form.entryGroupId ? String(form.entryGroupId) : "none"}
                        onValueChange={(value) => setForm((prev) => applyEntryGroupToTunnelForm(prev, value === "none" ? null : Number(value)))}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="选择已保存入口组" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">不使用入口组</SelectItem>
                          {usableEntryGroups.length === 0 ? (
                            <div className="px-2 py-4 text-center text-xs text-muted-foreground">暂无可用入口组</div>
                          ) : usableEntryGroups.map((group: any) => (
                            <SelectItem key={group.id} value={String(group.id)} textValue={group.name}>
                              <span className="inline-flex min-w-0 flex-col">
                                <span className="truncate">{group.name}</span>
                                <span className="truncate text-xs text-muted-foreground">{String(group.domain || "-")}</span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        {form.entryGroupId ? "入口组提供入口，下方主机从中转或出口开始配置。" : "未使用入口组时，下方第一台主机作为入口。"}
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label>主机链路</Label>
                      <MultiHopEditor
                        hosts={hosts || []}
                        initialHopIds={form.hopHostIds}
                        initialHopConnectHosts={form.hopConnectHosts}
                        maxHops={MAX_TUNNEL_HOPS}
                        externalEntry={!!form.entryGroupId}
                        externalExit={!!form.exitGroupId}
                        fixedExitHostIds={form.exitGroupId ? exitMembersForGroup(form.exitGroupId).map((member: any) => Number(member.hostId || 0)).filter((id: number) => id > 0) : []}
                        excludedHostIds={externalTunnelHostIds(form.entryGroupId, form.exitGroupId)}
                        onChange={(ids) => {
                          setForm((prev) => {
                            const normalizedConnectHosts = normalizeHopConnectHostsForHosts(prev.hopConnectHosts, ids, hosts, !!prev.entryGroupId);
                            const nextEntry = prev.entryGroupId ? prev.entryHostId : (ids[0] ?? null);
                            const nextExit = prev.exitGroupId ? prev.exitHostId : (ids.length > 1 ? ids[ids.length - 1] : null);
                            if (
                              sameNumberArray(prev.hopHostIds, ids)
                              && prev.entryHostId === nextEntry
                              && prev.exitHostId === nextExit
                              && sameNullableStringArray(prev.hopConnectHosts, normalizedConnectHosts)
                            ) {
                              return prev;
                            }
                            const nextForm = {
                              ...prev,
                              hopHostIds: ids,
                              entryHostId: nextEntry,
                              exitHostId: nextExit,
                              hopConnectHosts: normalizedConnectHosts,
                              loadBalanceExits: prev.exitGroupId ? prev.loadBalanceExits : prev.loadBalanceExits.filter((exit) => !ids.includes(Number(exit.hostId || 0))),
                            };
                            return prev.exitGroupId ? applyExitGroupToForm(nextForm, prev.exitGroupId) : nextForm;
                          });
                        }}
                        onConnectHostsChange={(hopConnectHosts) => {
                          setForm((prev) => {
                            const normalizedConnectHosts = normalizeHopConnectHostsForHosts(hopConnectHosts, prev.hopHostIds, hosts, !!prev.entryGroupId);
                            if (sameNullableStringArray(prev.hopConnectHosts, normalizedConnectHosts)) return prev;
                            const nextForm = { ...prev, hopConnectHosts: normalizedConnectHosts };
                            return prev.exitGroupId ? applyExitGroupToForm(nextForm, prev.exitGroupId) : nextForm;
                          });
                        }}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>出口组</Label>
                      <Select
                        value={form.exitGroupId ? String(form.exitGroupId) : "none"}
                        onValueChange={(value) => setForm((prev) => applyExitGroupToForm(prev, value === "none" ? null : Number(value)))}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="选择已保存出口组" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">不使用出口组</SelectItem>
                          {usableExitGroups.length === 0 ? (
                            <div className="px-2 py-4 text-center text-xs text-muted-foreground">暂无可用出口组</div>
                          ) : usableExitGroups.map((group: any) => (
                            <SelectItem key={group.id} value={String(group.id)} textValue={group.name}>
                              <span className="inline-flex min-w-0 flex-col">
                                <span className="truncate">{group.name}</span>
                                <span className="truncate text-xs text-muted-foreground">{groupHostSummary(group, hosts)}</span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {form.exitGroupId ? (
                        <p className="text-xs text-muted-foreground">出口组固定为隧道出口，内网 IP 按出口组成员保存值使用。</p>
                      ) : (
                        <p className="text-xs text-muted-foreground">选择出口组后会自动把组内第一台作为主出口，其余作为额外出口。</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label>隧道类型</Label>
                      <div className={`${segmentedControlClassName} grid ${nginxTunnelEnabled ? "grid-cols-3" : "grid-cols-2"} gap-1`}>
                        <button
                          type="button"
                          onClick={() => {
                            const nextMode = enabledGostTunnelModes.includes(form.mode) ? form.mode : enabledGostTunnelModes[0];
                            if (nextMode) setTunnelMode(nextMode);
                          }}
                          disabled={gostRuntimeDisabled}
                          title={enabledGostTunnelModes.length === 0 ? unsupportedProtocolTitle : undefined}
                          aria-pressed={gostTunnelModes.includes(form.mode)}
                          className={segmentedOptionClassName(gostTunnelModes.includes(form.mode), gostRuntimeDisabled, "px-2")}
                        >
                          <Network className={segmentedIconClassName(gostTunnelModes.includes(form.mode))} />
                          <span className="truncate">GOST</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setTunnelMode("forwardx")}
                          disabled={forwardxRuntimeDisabled}
                          title={forwardProtocolSettings.forwardx === false ? unsupportedProtocolTitle : undefined}
                          aria-pressed={form.mode === "forwardx"}
                          className={segmentedOptionClassName(form.mode === "forwardx", forwardxRuntimeDisabled, "px-2")}
                        >
                          <ShieldCheck className={segmentedIconClassName(form.mode === "forwardx")} />
                          <span className="truncate">ForwardX</span>
                        </button>
                        {nginxTunnelEnabled && <button
                          type="button"
                          onClick={() => setTunnelMode("nginx_stream")}
                          aria-pressed={isNginxTunnelModeValue(form.mode)}
                          className={segmentedOptionClassName(isNginxTunnelModeValue(form.mode), false, "px-2")}
                        >
                          <Server className={segmentedIconClassName(isNginxTunnelModeValue(form.mode))} />
                          <span className="truncate">Nginx</span>
                        </button>}
                      </div>
                    </div>
                    {gostTunnelModes.includes(form.mode) && enabledGostTunnelModes.length === 0 && (
                      <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600">
                        {unsupportedProtocolTitle}
                      </p>
                    )}
                    {gostTunnelModes.includes(form.mode) && (
                      <div className="space-y-2">
                        <Label>GOST 协议</Label>
                        <Select value={form.mode} onValueChange={(v) => setTunnelMode(v as TunnelForm["mode"])}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {enabledGostTunnelModes.map((mode) => (
                              <SelectItem key={mode} value={mode}>{tunnelModeLabels[mode]}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {nginxTunnelEnabled && isNginxTunnelModeValue(form.mode) && renderNginxCertFields()}
                    {renderTunnelRuntimeOptions()}
                    {nginxTunnelEnabled && form.exitGroupId && form.loadBalanceEnabled && form.loadBalanceExits.length > 0 && isNginxTunnelModeValue(form.mode) && (
                      <div className="space-y-2">
                        <Label>出口组负载模式</Label>
                        <Select value={form.loadBalanceStrategy} onValueChange={(v) => setForm({ ...form, loadBalanceStrategy: v as TunnelForm["loadBalanceStrategy"] })}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {Object.entries(tunnelLoadBalanceStrategyLabels).map(([value, label]) => (
                              <SelectItem key={value} value={value}>{label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">仅使用出口组多出口时生效，单出口隧道固定直连主出口。</p>
                      </div>
                    )}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <div className="space-y-2">
                        <Label>出口监听端口</Label>
                        <Input type="number" min={0} max={65535} step={1} value={form.listenPort || ""} onChange={(e) => setForm({ ...form, listenPort: Number(e.target.value) || 0 })} placeholder="自动分配" />
                      </div>
                      <div className="space-y-2">
                        <Label>隧道限速 (Mbps)</Label>
                        <Input type="number" min={0} max={1000000} step={1} value={form.rateLimitMbps || ""} onChange={(e) => setForm({ ...form, rateLimitMbps: Number(e.target.value) || 0 })} placeholder="不限速" />
                      </div>
                      <div className="space-y-2">
                        <Label>流量倍率</Label>
                        <Input type="number" min={0.01} max={50} step={0.01} value={form.trafficMultiplier || ""} onChange={(e) => setForm({ ...form, trafficMultiplier: Number(e.target.value) || 1 })} placeholder="1" />
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label>链名称</Label>
                      <Input
                        value={chainCreateForm.name}
                        onChange={(e) => setChainCreateForm({ ...chainCreateForm, name: e.target.value })}
                        placeholder="例如: 华东-香港转发链"
                      />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px_110px]">
                      <div className="space-y-2">
                        <Label>转发工具</Label>
                        <Select
                          value={chainCreateForm.forwardType}
                          disabled={availableChainForwardTypes.length === 0}
                          onValueChange={(value) => setChainForwardType(value as ForwardType)}
                        >
                          <SelectTrigger><SelectValue placeholder="选择转发工具" /></SelectTrigger>
                          <SelectContent>
                            {availableChainForwardTypes.map((type) => (
                              <SelectItem key={type} value={type}>{FORWARD_TYPE_LABELS[type]}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>流量倍率</Label>
                        <Input type="number" min={0.01} max={50} step={0.01} value={chainCreateForm.trafficMultiplier || ""} onChange={(e) => setChainCreateForm({ ...chainCreateForm, trafficMultiplier: Number(e.target.value) || 1 })} placeholder="1" />
                      </div>
                      <div className="flex items-end">
                        <label className="flex h-10 w-full items-center justify-between rounded-md border border-border/60 px-3">
                          <span className="text-sm">启用</span>
                          <Switch
                            checked={chainCreateForm.isEnabled}
                            onCheckedChange={(isEnabled) => setChainCreateForm({ ...chainCreateForm, isEnabled })}
                          />
                        </label>
                      </div>
                    </div>
                    {renderChainRuntimeOptions()}
                    <div className="space-y-2">
                      <Label>入口组</Label>
                      <Select
                        value={chainCreateForm.entryGroupId ? String(chainCreateForm.entryGroupId) : "none"}
                        onValueChange={(value) => setChainCreateForm((prev) => applyEntryGroupToChainCreateForm(prev, value === "none" ? null : Number(value)))}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="选择已保存入口组" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">不使用入口组</SelectItem>
                          {usableEntryGroups.length === 0 ? (
                            <div className="px-2 py-4 text-center text-xs text-muted-foreground">暂无可用入口组</div>
                          ) : usableEntryGroups.map((group: any) => (
                            <SelectItem key={group.id} value={String(group.id)} textValue={group.name}>
                              <span className="inline-flex min-w-0 flex-col">
                                <span className="truncate">{group.name}</span>
                                <span className="truncate text-xs text-muted-foreground">{String(group.domain || "-")}</span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        {chainCreateForm.entryGroupId ? "入口组提供入口，下方主机从中转或出口开始配置。" : "未使用入口组时，下方第一台主机作为入口。"}
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label>链路主机顺序</Label>
                      <MultiHopEditor
                        hosts={hosts || []}
                        initialHopIds={chainCreateForm.hopHostIds}
                        initialHopConnectHosts={chainCreateForm.hopConnectHosts}
                        maxHops={5}
                        externalEntry={!!chainCreateForm.entryGroupId}
                        excludedHostIds={externalChainEntryHostIds(chainCreateForm.entryGroupId)}
                        onChange={(ids) => {
                          setChainCreateForm((prev) => {
                            const normalizedConnectHosts = normalizeChainConnectHostsForHosts(prev.hopConnectHosts, ids, hosts, !!prev.entryGroupId);
                            if (
                              sameNumberArray(prev.hopHostIds, ids)
                              && sameNullableStringArray(prev.hopConnectHosts, normalizedConnectHosts)
                            ) {
                              return prev;
                            }
                            return {
                              ...prev,
                              hopHostIds: ids,
                              hopConnectHosts: normalizedConnectHosts,
                            };
                          });
                        }}
                        onConnectHostsChange={(hopConnectHosts) => {
                          setChainCreateForm((prev) => {
                            const normalizedConnectHosts = normalizeChainConnectHostsForHosts(hopConnectHosts, prev.hopHostIds, hosts, !!prev.entryGroupId);
                            if (sameNullableStringArray(prev.hopConnectHosts, normalizedConnectHosts)) return prev;
                            return { ...prev, hopConnectHosts: normalizedConnectHosts };
                          });
                        }}
                      />
                    </div>
                  </>
                )}
          </div>
          <DialogFooter className="shrink-0 gap-2 border-t border-border/60 bg-background/95 px-3.5 py-3 sm:px-4">
            <Button variant="outline" onClick={() => setShowCreateTypeDialog(false)}>取消</Button>
            <Button
              disabled={selectedCreateDisabled || isCreateTypePending || (selectedCreateType === "tunnel" && !isTunnelSupported(form))}
              onClick={selectedCreateType === "chain" ? handleChainCreateSubmit : handleSubmit}
            >
              {isCreateTypePending ? "保存中..." : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="flex h-[min(92svh,48rem)] w-[calc(100vw-1rem)] max-w-[95vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl sm:p-0">
          <DialogHeader className="shrink-0 px-3.5 pb-2 pt-3.5 pr-12 sm:px-4 sm:pr-12 sm:pt-4">
            <DialogTitle>{editingId ? "编辑隧道" : "添加链路"}</DialogTitle>
          </DialogHeader>
          <div className="dialog-scroll-area min-h-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain px-3.5 py-2.5 sm:px-4">
            <div className="space-y-2">
              <Label>隧道名称</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如: 华东-香港隧道" />
            </div>
            <div className="space-y-2">
              <Label>入口组</Label>
              <Select
                value={form.entryGroupId ? String(form.entryGroupId) : "none"}
                onValueChange={(value) => setForm((prev) => applyEntryGroupToTunnelForm(prev, value === "none" ? null : Number(value)))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择已保存入口组" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">不使用入口组</SelectItem>
                  {usableEntryGroups.length === 0 ? (
                    <div className="px-2 py-4 text-center text-xs text-muted-foreground">暂无可用入口组</div>
                  ) : usableEntryGroups.map((group: any) => (
                    <SelectItem key={group.id} value={String(group.id)} textValue={group.name}>
                      <span className="inline-flex min-w-0 flex-col">
                        <span className="truncate">{group.name}</span>
                        <span className="truncate text-xs text-muted-foreground">{String(group.domain || "-")}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {form.entryGroupId ? "入口组提供入口，下方主机从中转或出口开始配置。" : "未使用入口组时，下方第一台主机作为入口。"}
              </p>
            </div>
            <div className="space-y-2">
              <Label>主机链路</Label>
              <MultiHopEditor
                hosts={hosts || []}
                initialHopIds={form.hopHostIds}
                initialHopConnectHosts={form.hopConnectHosts}
                maxHops={MAX_TUNNEL_HOPS}
                externalEntry={!!form.entryGroupId}
                externalExit={!!form.exitGroupId}
                fixedExitHostIds={form.exitGroupId ? exitMembersForGroup(form.exitGroupId).map((member: any) => Number(member.hostId || 0)).filter((id: number) => id > 0) : []}
                excludedHostIds={externalTunnelHostIds(form.entryGroupId, form.exitGroupId)}
                onChange={(ids) => {
                  setForm((prev) => {
                    const normalizedConnectHosts = normalizeHopConnectHostsForHosts(prev.hopConnectHosts, ids, hosts, !!prev.entryGroupId);
                    const nextEntry = prev.entryGroupId ? prev.entryHostId : (ids[0] ?? null);
                    const nextExit = prev.exitGroupId ? prev.exitHostId : (ids.length > 1 ? ids[ids.length - 1] : null);
                    if (
                      sameNumberArray(prev.hopHostIds, ids)
                      && prev.entryHostId === nextEntry
                      && prev.exitHostId === nextExit
                      && sameNullableStringArray(prev.hopConnectHosts, normalizedConnectHosts)
                    ) {
                      return prev;
                    }
                    const nextForm = {
                      ...prev,
                      hopHostIds: ids,
                      entryHostId: nextEntry,
                      exitHostId: nextExit,
                      hopConnectHosts: normalizedConnectHosts,
                      loadBalanceExits: prev.exitGroupId ? prev.loadBalanceExits : prev.loadBalanceExits.filter((exit) => !ids.includes(Number(exit.hostId || 0))),
                    };
                    return prev.exitGroupId ? applyExitGroupToForm(nextForm, prev.exitGroupId) : nextForm;
                  });
                }}
                onConnectHostsChange={(hopConnectHosts) => {
                  setForm((prev) => {
                    const normalizedConnectHosts = normalizeHopConnectHostsForHosts(hopConnectHosts, prev.hopHostIds, hosts, !!prev.entryGroupId);
                    if (sameNullableStringArray(prev.hopConnectHosts, normalizedConnectHosts)) return prev;
                    const nextForm = { ...prev, hopConnectHosts: normalizedConnectHosts };
                    return prev.exitGroupId ? applyExitGroupToForm(nextForm, prev.exitGroupId) : nextForm;
                  });
                }}
              />
            </div>
            <div className="space-y-2">
              <Label>出口组</Label>
              <Select
                value={form.exitGroupId ? String(form.exitGroupId) : "none"}
                onValueChange={(value) => setForm((prev) => applyExitGroupToForm(prev, value === "none" ? null : Number(value)))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择已保存出口组" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">不使用出口组</SelectItem>
                  {usableExitGroups.length === 0 ? (
                    <div className="px-2 py-4 text-center text-xs text-muted-foreground">暂无可用出口组</div>
                  ) : usableExitGroups.map((group: any) => (
                    <SelectItem key={group.id} value={String(group.id)} textValue={group.name}>
                      <span className="inline-flex min-w-0 flex-col">
                        <span className="truncate">{group.name}</span>
                        <span className="truncate text-xs text-muted-foreground">{groupHostSummary(group, hosts)}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {form.exitGroupId ? (
                <p className="text-xs text-muted-foreground">出口组固定为隧道出口，内网 IP 按出口组成员保存值使用。</p>
              ) : (
                <p className="text-xs text-muted-foreground">选择出口组后会自动把组内第一台作为主出口，其余作为额外出口。</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>隧道类型</Label>
              <div className={`${segmentedControlClassName} grid ${nginxTunnelEnabled ? "grid-cols-3" : "grid-cols-2"} gap-1`}>
                <button
                  type="button"
                  onClick={() => {
                    const nextMode = enabledGostTunnelModes.includes(form.mode) ? form.mode : enabledGostTunnelModes[0];
                    if (nextMode) setTunnelMode(nextMode);
                  }}
                  disabled={gostRuntimeDisabled}
                  title={enabledGostTunnelModes.length === 0 ? unsupportedProtocolTitle : undefined}
                  aria-pressed={gostTunnelModes.includes(form.mode)}
                  className={segmentedOptionClassName(gostTunnelModes.includes(form.mode), gostRuntimeDisabled, "px-2")}
                >
                  <Network className={segmentedIconClassName(gostTunnelModes.includes(form.mode))} />
                  <span className="truncate">GOST</span>
                </button>
                <button
                  type="button"
                  onClick={() => setTunnelMode("forwardx")}
                  disabled={forwardxRuntimeDisabled}
                  title={forwardProtocolSettings.forwardx === false ? unsupportedProtocolTitle : undefined}
                  aria-pressed={form.mode === "forwardx"}
                  className={segmentedOptionClassName(form.mode === "forwardx", forwardxRuntimeDisabled, "px-2")}
                >
                  <ShieldCheck className={segmentedIconClassName(form.mode === "forwardx")} />
                  <span className="truncate">ForwardX</span>
                </button>
                {nginxTunnelEnabled && <button
                  type="button"
                  onClick={() => setTunnelMode("nginx_stream")}
                  aria-pressed={isNginxTunnelModeValue(form.mode)}
                  className={segmentedOptionClassName(isNginxTunnelModeValue(form.mode), false, "px-2")}
                >
                  <Server className={segmentedIconClassName(isNginxTunnelModeValue(form.mode))} />
                  <span className="truncate">Nginx</span>
                </button>}
              </div>
            </div>
            {gostTunnelModes.includes(form.mode) && enabledGostTunnelModes.length === 0 && (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600">
                {unsupportedProtocolTitle}
              </p>
            )}
            {gostTunnelModes.includes(form.mode) && (
              <div className="space-y-2">
                <Label>GOST 协议</Label>
                <Select value={form.mode} onValueChange={(v) => setTunnelMode(v as TunnelForm["mode"])}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {enabledGostTunnelModes.map((mode) => (
                      <SelectItem key={mode} value={mode}>{tunnelModeLabels[mode]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {nginxTunnelEnabled && isNginxTunnelModeValue(form.mode) && renderNginxCertFields()}
            {renderTunnelRuntimeOptions()}
            {nginxTunnelEnabled && form.exitGroupId && form.loadBalanceEnabled && form.loadBalanceExits.length > 0 && isNginxTunnelModeValue(form.mode) && (
              <div className="space-y-2">
                <Label>出口组负载模式</Label>
                <Select value={form.loadBalanceStrategy} onValueChange={(v) => setForm({ ...form, loadBalanceStrategy: v as TunnelForm["loadBalanceStrategy"] })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(tunnelLoadBalanceStrategyLabels).map(([value, label]) => (
                      <SelectItem key={value} value={value}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">仅使用出口组多出口时生效，单出口隧道固定直连主出口。</p>
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-2">
                <Label>出口监听端口</Label>
                <Input type="number" min={0} max={65535} step={1} value={form.listenPort || ""} onChange={(e) => setForm({ ...form, listenPort: Number(e.target.value) || 0 })} placeholder="自动分配" />
              </div>
              <div className="space-y-2">
                <Label>隧道限速 (Mbps)</Label>
                <Input type="number" min={0} max={1000000} step={1} value={form.rateLimitMbps || ""} onChange={(e) => setForm({ ...form, rateLimitMbps: Number(e.target.value) || 0 })} placeholder="不限速" />
              </div>
              <div className="space-y-2">
                <Label>流量倍率</Label>
                <Input type="number" min={0.01} max={50} step={0.01} value={form.trafficMultiplier || ""} onChange={(e) => setForm({ ...form, trafficMultiplier: Number(e.target.value) || 1 })} placeholder="1" />
              </div>
            </div>
          </div>
          <DialogFooter className="shrink-0 gap-2 border-t border-border/60 bg-background/95 px-3.5 py-3 sm:px-4">
            <Button variant="outline" onClick={() => setShowDialog(false)}>取消</Button>
            <Button onClick={handleSubmit} disabled={isPending || !isTunnelSupported(form)}>{isPending ? "保存中..." : editingId ? "保存" : "创建"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function TunnelsPage() {
  return (
    <DashboardLayout>
      <TunnelsContent />
    </DashboardLayout>
  );
}


