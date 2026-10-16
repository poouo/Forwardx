import { useEffect, useRef, useState, type PointerEvent } from "react";
import { t, getFormatLocale } from "@/i18n";
import { X, Globe2, MapPin } from "lucide-react";

export type ProvinceUsage = { name: string; ips: number; bytesIn: number; bytesOut: number; unknownSamples: number; knownSamples: number };
type SourceIp = {ip:string;bytesIn:number;bytesOut:number;knownSamples:number;unknownSamples:number;city?:string|null;isp?:string|null;countryCode?:string};
export type ProvinceDetails = {ips:SourceIp[];totals:({ips:number;rules:number;hosts:number;lastSeen:number} & Omit<ProvinceUsage,"name">)|null};
export const PROVINCE_COLORS = ["#93c5fd","#22d3ee","#34d399","#fbbf24","#fb7185"];
export function provinceColor(ips: number, maximum: number) {
  if (!ips) return "var(--muted)";
  const ratio = maximum > 1 ? Math.log(ips)/Math.log(maximum) : 1;
  return PROVINCE_COLORS[Math.min(4,Math.floor(ratio*5))];
}
function countryName(code: string) {
  try { return new Intl.DisplayNames([getFormatLocale()],{type:"region"}).of(code) || code; } catch { return code; }
}
type Feature = { properties: { name: string }; geometry: { type: string; coordinates: any[]; encodeOffsets?: any[] } };
export function operationsBytes(value: unknown) {
  let bytes = Number(value) || 0, unit = 0;
  while (bytes >= 1024 && unit < 4) { bytes /= 1024; unit++; }
  return `${bytes.toFixed(unit ? 2 : 0)} ${["B", "KiB", "MiB", "GiB", "TiB"][unit]}`;
}
export function sourceUsage(row?: { bytesIn: unknown; bytesOut: unknown; knownSamples: unknown; unknownSamples: unknown } | null) {
  if (Number(row?.unknownSamples) > 0 && !Number(row?.knownSamples)) return t("不可用");
  return operationsBytes(Number(row?.bytesIn || 0) + Number(row?.bytesOut || 0)) + (Number(row?.unknownSamples) > 0 ? " *" : "");
}
export function geometryPath(feature: Feature) {
  const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const offsets = feature.geometry.type === "Polygon" ? [feature.geometry.encodeOffsets] : feature.geometry.encodeOffsets;
  // ECharts map assets use documented UTF8 zigzag/delta coordinate encoding.
  return polygons.map((polygon: any[], polygonIndex: number) => polygon.map((raw, ringIndex) => {
    let ring: number[][] = raw;
    if (typeof raw === "string") {
      let [x, y] = offsets![polygonIndex][ringIndex];
      ring = [];
      for (let i = 0; i < raw.length; i += 2) {
        const dx = raw.charCodeAt(i) - 64, dy = raw.charCodeAt(i + 1) - 64;
        x += (dx >> 1) ^ -(dx & 1); y += (dy >> 1) ^ -(dy & 1);
        ring.push([x / 1024, y / 1024]);
      }
    }
    return ring.map(([lon, lat], i) => `${i ? "L" : "M"}${((lon - 72) * 12).toFixed(1)},${((55 - lat) * 14).toFixed(1)}`).join("") + "Z";
  }).join("")).join("");
}
export default function OperationsChinaMap({ provinces, unmappedIps, foreignIps = [], foreignCount = 0, unknownIps = unmappedIps, scopeKey = "", detailProvince, details, detailsLoading = false, detailsError = false, fixedDetails, fixedDetailsLoading = false, fixedDetailsError = false, onProvinceChange, onProvinceSelect, onSelectIp }: {
  provinces: ProvinceUsage[]; unmappedIps: number; foreignIps?:SourceIp[];foreignCount?:number;unknownIps?:number;scopeKey?:string;
  detailProvince?:string|null;details?:ProvinceDetails;detailsLoading?:boolean;detailsError?:boolean;
  fixedDetails?:ProvinceDetails;fixedDetailsLoading?:boolean;fixedDetailsError?:boolean;
  onProvinceChange?:(province:string|null)=>void;onProvinceSelect?:(province:string|null)=>void;onSelectIp?:(ip:string)=>void;
}) {
  const [features, setFeatures] = useState<Feature[]>([]), [failed, setFailed] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null), [pinned,setPinned] = useState<string|null>(null);
  const [point,setPoint] = useState({x:12,y:54});
  const mapRef = useRef<HTMLDivElement>(null);
  const active = hovered || pinned;
  useEffect(()=> {setHovered(null);setPinned(null);},[scopeKey]);
  useEffect(()=> {onProvinceChange?.(active);},[active,onProvinceChange]);
  useEffect(()=> {onProvinceSelect?.(pinned);},[pinned,onProvinceSelect]);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/china-provinces.json", { signal: controller.signal }).then(response => {
      if (!response.ok) throw new Error("map unavailable");
      return response.json();
    }).then(data => setFeatures(data.features)).catch(error => { if (error.name !== "AbortError") setFailed(true); });
    return () => controller.abort();
  }, []);
  const usage = new Map(provinces.map(row => [row.name, row]));
  const max = Math.max(1, ...provinces.map(row => row.ips));
  const selected = active ? usage.get(active) : null;
  const activeDetails = detailProvince === active ? details : undefined;
  const pending = !!active && (detailsLoading || detailProvince !== active);
  const foreignSummary = <div className="rounded-lg border bg-background/95 p-3 text-xs shadow-sm backdrop-blur">
    <div className="mb-2 flex items-center justify-between gap-3 font-medium"><span className="flex items-center gap-1.5"><Globe2 className="size-3.5 text-sky-500" />{t("境外来源")}</span><span className="tabular-nums">{foreignCount} IP</span></div>
    {foreignIps.length ? foreignIps.map(row=><div key={row.ip} className="mt-1.5 flex items-center justify-between gap-2"><button className="min-w-0 truncate font-mono text-[11px] text-primary hover:underline" title={`${row.ip} · ${countryName(row.countryCode || "ZZ")}`} onClick={()=>onSelectIp?.(row.ip)}>{row.ip}</button><span className="shrink-0 text-[11px] text-muted-foreground">{countryName(row.countryCode || "ZZ")}</span></div>) : <p className="text-muted-foreground">{t("暂无数据")}</p>}
  </div>;
  const ipRanking = (rows:SourceIp[], compact=false) => <div className="space-y-2">{rows.map((row,index)=><div key={row.ip} className="flex items-start justify-between gap-3 text-xs"><div className="min-w-0"><div className="flex min-w-0 items-center gap-2"><span className="text-muted-foreground">{index+1}</span><button className="truncate font-mono text-primary hover:underline" onClick={()=>onSelectIp?.(row.ip)}>{row.ip}</button></div>{!compact && (row.city || row.isp) && <p className="ml-4 mt-1 truncate text-muted-foreground">{row.city || ""}{row.city && row.isp ? " · " : ""}{row.isp || ""}</p>}</div><span className="shrink-0 tabular-nums">{sourceUsage(row)}</span></div>)}</div>;
  const position = (event:PointerEvent<SVGPathElement>) => {
    const rect = mapRef.current?.getBoundingClientRect();
    if (rect) setPoint({x:Math.max(8,Math.min(event.clientX-rect.left+16,rect.width-288-8)),y:Math.max(44,Math.min(event.clientY-rect.top+12,rect.height-280))});
  };
  return <div className="space-y-3">
    <div ref={mapRef} className="relative overflow-hidden rounded-xl border bg-gradient-to-br from-sky-500/5 via-background to-emerald-500/5">
      <div className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded-full border bg-background/85 px-3 py-1.5 text-[11px] text-muted-foreground backdrop-blur"><span>{t("来源 IP")}</span><span>{t("少")}</span><div className="flex gap-0.5">{PROVINCE_COLORS.map(color=><span key={color} className="h-2 w-4 rounded-sm" style={{background:color}} />)}</div><span>{t("多")}</span></div>
      {failed ? <p className="p-8 text-sm text-muted-foreground">{t("地图加载失败")}</p> : <svg viewBox="0 0 780 740" className="mx-auto max-h-[460px] w-full" aria-label={t("中国来源分布")}>
        {features.map(feature => {
          const name = feature.properties.name, row = usage.get(name);
          return <path key={name} d={geometryPath(feature)} fill={provinceColor(row?.ips || 0,max)} fillOpacity={row ? active === name ? 1 : 0.85 : 0.65}
            stroke={active === name ? "var(--foreground)" : "var(--background)"} strokeOpacity={active === name ? 0.8 : 0.9} strokeWidth={active === name ? 2 : 1.1} fillRule="evenodd"
            style={{transformBox:"fill-box",transformOrigin:"center",transform:active === name ? "translateY(-2px) scale(1.025)" : undefined,filter:active === name ? "drop-shadow(0 4px 5px rgb(15 23 42 / 0.2))" : undefined}}
            className="cursor-pointer outline-none transition-all duration-300 ease-out motion-reduce:transform-none motion-reduce:transition-none" tabIndex={0} role="button"
            aria-label={`${t(name)}: ${row?.ips ?? 0} IP`} aria-pressed={pinned === name}
            onPointerEnter={event => {setHovered(name);position(event);}} onPointerMove={position} onPointerLeave={()=>setHovered(null)}
            onFocus={()=> {setHovered(name);setPoint({x:12,y:54});}} onBlur={()=>setHovered(null)} onClick={()=>setPinned(name)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setPinned(name); } if (event.key === "Escape") {setPinned(null);setHovered(null);} }}>
          </path>;
        })}
      </svg>}
      <div className="absolute bottom-3 left-3 hidden w-56 md:block">{foreignSummary}</div>
      <div className="absolute bottom-3 right-3 rounded-lg border bg-background/90 px-3 py-2 text-right text-xs backdrop-blur"><p className="text-muted-foreground">{t("未定位来源")}</p><p className="mt-1 font-semibold tabular-nums">{unknownIps} IP</p></div>
      {hovered && <div role="status" style={{left:point.x,top:point.y}} className="pointer-events-none absolute z-20 hidden w-72 max-w-[calc(100%-1rem)] animate-in rounded-xl border bg-popover/95 p-4 text-popover-foreground shadow-xl backdrop-blur duration-200 fade-in zoom-in-95 motion-reduce:animate-none md:block">
        <div className="mb-3 flex items-center justify-between gap-3"><span className="font-semibold">{t(hovered)}</span><span className="text-xs text-muted-foreground">{selected?.ips || 0} IP</span></div>
        <div className="mb-3 grid grid-cols-2 gap-3 text-xs"><div><p className="text-muted-foreground">{t("入向流量")}</p><p className="mt-1 tabular-nums">{selected?.unknownSamples && !selected.knownSamples ? t("不可用") : operationsBytes(selected?.bytesIn)}</p></div><div><p className="text-muted-foreground">{t("出向流量")}</p><p className="mt-1 tabular-nums">{selected?.unknownSamples && !selected.knownSamples ? t("不可用") : operationsBytes(selected?.bytesOut)}</p></div></div>
        <p className="mb-2 border-t pt-2 text-[11px] text-muted-foreground">{t("流量前 5 个 IP")}</p>
        {pending ? <p className="animate-pulse text-xs text-muted-foreground">{t("加载中")}</p> : detailsError ? <p className="text-xs text-muted-foreground">{t("省份详情暂不可用")}</p> : activeDetails?.ips.length ? ipRanking(activeDetails.ips,true) : <p className="text-xs text-muted-foreground">{t("暂无数据")}</p>}
        <p className="mt-3 text-[11px] text-muted-foreground">{t("点击省份固定详情")}</p>
      </div>}
    </div>
    <div className="md:hidden">{foreignSummary}</div>
    {pinned ? <div className="animate-in rounded-xl border bg-card p-4 duration-200 fade-in slide-in-from-top-1 motion-reduce:animate-none">
      <div className="mb-4 flex items-center justify-between gap-3"><h3 className="flex items-center gap-2 text-sm font-semibold"><MapPin className="size-4 text-sky-500" />{t(pinned)}</h3><button aria-label={t("关闭")} className="rounded-md p-1 text-muted-foreground hover:bg-muted" onClick={()=> {setPinned(null);setHovered(null);}}><X className="size-4" /></button></div>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">{[{label:t("来源 IP"),value:usage.get(pinned)?.ips || 0},{label:t("采样流量"),value:sourceUsage(usage.get(pinned))},{label:t("规则数"),value:fixedDetails?.totals?.rules ?? "—"},{label:t("主机"),value:fixedDetails?.totals?.hosts ?? "—"}].map(item=><div key={item.label}><p className="text-[11px] text-muted-foreground">{item.label}</p><p className="mt-1 text-sm font-medium tabular-nums">{item.value}</p></div>)}</div>
      <p className="mb-3 text-xs font-medium">{t("流量前 5 个 IP")}</p>
      {fixedDetailsLoading ? <p className="text-xs text-muted-foreground">{t("加载中")}</p> : fixedDetailsError ? <p className="text-xs text-muted-foreground">{t("省份详情暂不可用")}</p> : fixedDetails?.ips.length ? ipRanking(fixedDetails.ips) : <p className="text-xs text-muted-foreground">{t("暂无数据")}</p>}
      {usage.get(pinned)?.unknownSamples ? <p className="mt-3 text-xs text-muted-foreground">{t("部分流量不可用")}</p> : null}
    </div> : <p className="text-xs text-muted-foreground"><span className="hidden md:inline">{t("悬停查看流量与 IP 排行，点击省份固定详情。颜色由蓝到红表示来源 IP 数由少到多。")}</span><span className="md:hidden">{t("点击省份查看流量与 IP 排行。")}</span></p>}
    <p className="text-xs text-muted-foreground">{t("来源 IP 使用本地 IP 库定位，不会上传至第三方；位置仅供参考。")}</p>
  </div>;
}
