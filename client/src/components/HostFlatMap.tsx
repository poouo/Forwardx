import DeckGL from "@deck.gl/react";
import { GeoJsonLayer, LineLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import MapLibreMap from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { countryFeatureHasCode, normalizeCountryCode, type CountryFeatureLike } from "@/lib/countryFeatures";

const HOST_MAP_COUNTRIES_URL = "/globe/ne_110m_admin_0_countries.geojson";
const HOST_MAP_CLUSTER_DISTANCE_DEGREES = 7.2;
const HOST_MAP_RIGHT_PULL_DEGREES = 20;
const HOST_MAP_LABEL_ROW_DEGREES = 9.6;
const HOST_MAP_MAX_LABELS_PER_COLUMN = 4;

const HOST_MAP_STYLE = {
  version: 8,
  sources: {},
  layers: [
    {
      id: "background",
      type: "background",
      paint: {
        "background-color": "#020617",
      },
    },
  ],
};

type HostMapFeatureCollection = {
  type: "FeatureCollection";
  features: unknown[];
};

const EMPTY_COUNTRIES: HostMapFeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

type HostMapPoint = {
  host: any;
  lat: number;
  lng: number;
  displayLat: number;
  displayLng: number;
  color: [number, number, number, number];
  haloColor: [number, number, number, number];
  statusText: string;
  regionText: string;
  addressText: string;
  countryCode: string;
  flagUrl: string;
  label: string;
};

type HostMapCluster = {
  centerLat: number;
  centerLng: number;
  points: HostMapPoint[];
};

function hostAddressText(host: any) {
  const parts: string[] = [];
  if (host.ipv4) parts.push(`IPv4 ${host.ipv4}`);
  if (host.ipv6) parts.push(`IPv6 ${host.ipv6}`);
  if (parts.length === 0 && host.ip) parts.push(`IP ${host.ip}`);
  return parts.join("  /  ") || "-";
}

function hostRegionText(host: any) {
  const parts = [host.geoCountryName || host.geoCountryCode, host.geoRegion]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return parts.join(" / ");
}

function hostGeoCoordinate(host: any) {
  if (host?.geoLatitudeMicro == null || host?.geoLongitudeMicro == null) return null;
  const lat = Number(host.geoLatitudeMicro) / 1_000_000;
  const lng = Number(host.geoLongitudeMicro) / 1_000_000;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function hostCountryCode(host: any) {
  return normalizeCountryCode(host?.geoCountryCode);
}

function hostFlagUrl(host: any) {
  const countryCode = hostCountryCode(host).toLowerCase();
  return /^[a-z]{2}$/.test(countryCode) ? `https://flagcdn.com/24x18/${countryCode}.png` : "";
}

function hostMapLabel(host: any) {
  const name = String(host?.name || hostAddressText(host) || "-").trim();
  return name.length > 12 ? `${name.slice(0, 11)}...` : name;
}

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

function hostMapClusterDistance(point: HostMapPoint, cluster: HostMapCluster) {
  const latDiff = point.lat - cluster.centerLat;
  const lngScale = Math.max(0.35, Math.cos((((point.lat + cluster.centerLat) / 2) * Math.PI) / 180));
  const lngDiff = longitudeDistanceDegrees(point.lng, cluster.centerLng) * lngScale;
  return Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);
}

function hostMapPointPulledOut(point: HostMapPoint) {
  return Math.abs(point.lat - point.displayLat) > 0.01 || Math.abs(point.lng - point.displayLng) > 0.01;
}

function buildHostMapClusters(points: HostMapPoint[]) {
  const clusters: HostMapCluster[] = [];
  points
    .slice()
    .sort((a, b) => a.lng - b.lng || a.lat - b.lat)
    .forEach((point) => {
      const cluster = clusters.find((item) => hostMapClusterDistance(point, item) <= HOST_MAP_CLUSTER_DISTANCE_DEGREES);
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

function spreadHostMapPoints(points: HostMapPoint[]) {
  return buildHostMapClusters(points).flatMap((cluster) => {
    if (cluster.points.length <= 1) return cluster.points;
    const sorted = cluster.points.slice().sort((a, b) => String(a.host.name || "").localeCompare(String(b.host.name || "")) || Number(a.host.id || 0) - Number(b.host.id || 0));
    const lngScale = Math.max(0.38, Math.cos((cluster.centerLat * Math.PI) / 180));
    const pullLng = HOST_MAP_RIGHT_PULL_DEGREES + Math.min(12, sorted.length * 1.05);
    const rowStep = Math.max(HOST_MAP_LABEL_ROW_DEGREES, Math.min(14, 8.2 + sorted.length * 0.9));
    return sorted.map((point, index) => {
      const column = Math.floor(index / HOST_MAP_MAX_LABELS_PER_COLUMN);
      const row = index % HOST_MAP_MAX_LABELS_PER_COLUMN;
      const columnSize = Math.min(HOST_MAP_MAX_LABELS_PER_COLUMN, sorted.length - column * HOST_MAP_MAX_LABELS_PER_COLUMN);
      const rowOffset = row - (columnSize - 1) / 2;
      return {
        ...point,
        displayLat: clampLatitude(cluster.centerLat + rowOffset * rowStep),
        displayLng: normalizeLongitude(cluster.centerLng + (pullLng + column * 12) / lngScale),
      };
    });
  });
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

function deckColorToCss(color: [number, number, number, number]) {
  const [red, green, blue, alpha] = color;
  return `rgba(${red},${green},${blue},${Math.max(0, Math.min(1, alpha / 255))})`;
}

function renderHostMapTooltip(point: HostMapPoint) {
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
    <div style="min-width:260px;max-width:330px;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(8,13,24,.94);box-shadow:0 18px 44px rgba(0,0,0,.4);backdrop-filter:blur(10px);color:#f8fafc;padding:12px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;">
        <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:700;">${escapeTooltipHtml(point.host.name || "-")}</div>
        <div style="display:flex;align-items:center;gap:6px;color:#cbd5e1;font-size:12px;">
          <span style="width:8px;height:8px;border-radius:999px;background:${deckColorToCss(point.color)};box-shadow:0 0 14px ${deckColorToCss(point.haloColor)};"></span>
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

function buildHostMapPoints(hosts: any[]) {
  const points = hosts.map((host) => {
    const coord = hostGeoCoordinate(host);
    if (!coord) return null;
    const isOnline = !!host.isOnline;
    return {
      host,
      lat: coord.lat,
      lng: coord.lng,
      displayLat: coord.lat,
      displayLng: coord.lng,
      color: isOnline ? [74, 222, 128, 245] : [251, 191, 36, 235],
      haloColor: isOnline ? [74, 222, 128, 125] : [251, 191, 36, 110],
      statusText: isOnline ? "在线" : "离线",
      regionText: hostRegionText(host),
      addressText: hostAddressText(host),
      countryCode: hostCountryCode(host),
      flagUrl: hostFlagUrl(host),
      label: hostMapLabel(host),
    } satisfies HostMapPoint;
  }).filter(Boolean) as HostMapPoint[];

  return spreadHostMapPoints(points);
}

function getInitialMapView(points: HostMapPoint[]) {
  if (points.length === 0) {
    return { longitude: 105, latitude: 25, zoom: 1.3, pitch: 0, bearing: 0 };
  }
  const center = points.reduce(
    (acc, point) => ({
      lat: acc.lat + point.lat,
      lng: acc.lng + point.lng,
    }),
    { lat: 0, lng: 0 }
  );
  return {
    longitude: center.lng / points.length,
    latitude: clampLatitude(center.lat / points.length),
    zoom: points.length === 1 ? 3 : 1.6,
    pitch: 0,
    bearing: 0,
  };
}

export default function HostFlatMap({
  hosts,
  onEdit,
}: {
  hosts: any[];
  onEdit: (host: any) => void;
}) {
  const [countries, setCountries] = useState<HostMapFeatureCollection | null>(null);
  const [countriesLoading, setCountriesLoading] = useState(true);
  const points = useMemo(() => buildHostMapPoints(hosts), [hosts]);
  const missingCount = Math.max(0, hosts.length - points.length);
  const initialViewState = useMemo(() => getInitialMapView(points), [points]);
  const leaderPoints = useMemo(() => points.filter(hostMapPointPulledOut), [points]);
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
    setCountriesLoading(true);
    fetch(HOST_MAP_COUNTRIES_URL)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (Array.isArray(data?.features)) setCountries(data as HostMapFeatureCollection);
        else setCountries(null);
      })
      .catch(() => {
        if (!cancelled) setCountries(null);
      })
      .finally(() => {
        if (!cancelled) setCountriesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const layers = useMemo(() => [
    new GeoJsonLayer({
      id: "host-flat-map-countries",
      data: (countries || EMPTY_COUNTRIES) as any,
      pickable: false,
      stroked: true,
      filled: true,
      extruded: false,
      lineWidthUnits: "pixels",
      getLineWidth: (feature) => countryFeatureHasCode(feature as CountryFeatureLike, hostCountryCodes) ? 2 : 1,
      getLineColor: (feature) => countryFeatureHasCode(feature as CountryFeatureLike, hostCountryCodes) ? [125, 211, 252, 245] : [148, 163, 184, 60],
      getFillColor: (feature) => countryFeatureHasCode(feature as CountryFeatureLike, hostCountryCodes) ? [14, 165, 233, 112] : [15, 23, 42, 28],
    }),
    new LineLayer<HostMapPoint>({
      id: "host-flat-map-leaders",
      data: leaderPoints,
      pickable: false,
      widthUnits: "pixels",
      widthMinPixels: 1,
      widthMaxPixels: 2,
      getSourcePosition: (point) => [point.lng, point.lat],
      getTargetPosition: (point) => [point.displayLng, point.displayLat],
      getColor: (point) => point.host.isOnline ? [125, 211, 252, 185] : [251, 191, 36, 170],
      getWidth: 1.4,
    }),
    new ScatterplotLayer<HostMapPoint>({
      id: "host-flat-map-halo",
      data: points,
      pickable: false,
      getPosition: (point) => [point.displayLng, point.displayLat],
      getFillColor: (point) => point.haloColor,
      getRadius: 90000,
      radiusMinPixels: 14,
      radiusMaxPixels: 44,
    }),
    new ScatterplotLayer<HostMapPoint>({
      id: "host-flat-map-points",
      data: points,
      pickable: true,
      stroked: true,
      filled: true,
      lineWidthUnits: "pixels",
      getLineWidth: 2,
      getLineColor: [248, 250, 252, 225],
      getPosition: (point) => [point.displayLng, point.displayLat],
      getFillColor: (point) => point.color,
      getRadius: 38000,
      radiusMinPixels: 7,
      radiusMaxPixels: 16,
    }),
    new TextLayer<HostMapPoint>({
      id: "host-flat-map-labels",
      data: points,
      pickable: true,
      getPosition: (point) => [point.displayLng, point.displayLat],
      getText: (point) => point.label,
      getSize: 13,
      getColor: [248, 250, 252, 245],
      getAngle: 0,
      getTextAnchor: "middle",
      getAlignmentBaseline: "bottom",
      getPixelOffset: [0, -14],
      background: true,
      backgroundPadding: [5, 3],
      getBackgroundColor: [2, 6, 23, 180],
      sizeUnits: "pixels",
      fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontWeight: 700,
    }),
  ], [countries, hostCountryCodes, leaderPoints, points]);

  return (
    <div className="hidden overflow-hidden rounded-md border border-border/40 bg-[#020617] shadow-sm md:block">
      <div className="relative h-[720px] min-h-[720px] w-full overflow-hidden xl:h-[820px]">
        <DeckGL
          initialViewState={initialViewState}
          controller={{
            scrollZoom: true,
            dragPan: true,
            dragRotate: false,
            doubleClickZoom: true,
            touchZoom: true,
            keyboard: true,
          }}
          layers={layers}
          getTooltip={({ object }) => {
            const point = object as HostMapPoint | null;
            if (!point?.host) return null;
            return {
              html: renderHostMapTooltip(point),
              style: {
                background: "transparent",
                border: "none",
                boxShadow: "none",
                padding: "0",
              },
            };
          }}
          getCursor={({ isDragging, isHovering }) => {
            if (isDragging) return "grabbing";
            return isHovering ? "pointer" : "grab";
          }}
          onClick={({ object }) => {
            const point = object as HostMapPoint | null;
            if (!point?.host) return false;
            onEdit(point.host);
            return true;
          }}
        >
          <MapLibreMap
            reuseMaps
            attributionControl={false}
            mapStyle={HOST_MAP_STYLE as any}
            renderWorldCopies={false}
          />
        </DeckGL>
        <div className="pointer-events-none absolute left-4 top-4 rounded-md border border-white/10 bg-black/40 px-3 py-2 text-xs text-white shadow-lg backdrop-blur-md">
          <div className="font-medium">平面主机地图</div>
          <div className="mt-1 text-white/70">
            已定位 {points.length} 台 · 待定位 {missingCount} 台
          </div>
        </div>
        {countriesLoading && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#020617]/55 text-sm text-white/70">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在加载地图
          </div>
        )}
        {!countriesLoading && points.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center">
            <div className="rounded-md border border-white/10 bg-black/40 px-4 py-3 text-sm text-white/80 shadow-lg backdrop-blur-md">
              暂无可定位主机
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
