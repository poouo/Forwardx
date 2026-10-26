import { Component, useCallback, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import type { GlobeMethods } from "react-globe.gl";
import { Globe2, Minus, Pause, Play, Plus, RotateCcw, ScanLine } from "lucide-react";
import { t } from "@/i18n";
import { useTheme } from "@/contexts/ThemeContext";
import { useMotionEnabled } from "@/components/MotionPolicy";
import { Button } from "@/components/ui/button";
import { trackGlobeTooltip } from "@/lib/globeTooltipPosition";

export function globeTooltip({ title, color, status, rows, action }: {
  title: string; color: string; status?: string;
  rows: Array<{ label: string; value: unknown }>; action?: string;
}) {
  const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  const safeColor = /^#[0-9a-f]{6}$/i.test(color) ? color : "#236de9";
  return `<div class="globe-tooltip"><div style="display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:12px"><strong style="min-width:0;overflow-wrap:anywhere;font-size:13px">${escape(title)}</strong><span style="display:flex;align-items:center;gap:6px;white-space:nowrap"><span style="width:7px;height:7px;flex-shrink:0;border-radius:50%;background:${safeColor}"></span>${escape(status || "")}</span></div>${rows.map((row) => `<div style="display:grid;grid-template-columns:minmax(48px,auto) minmax(0,1fr);gap:12px;margin-top:6px"><span data-globe-muted>${escape(row.label)}</span><span data-globe-value>${escape(row.value)}</span></div>`).join("")}${action ? `<div data-globe-accent style="margin-top:12px;font-size:11px">${escape(action)}</div>` : ""}</div>`;
}

export function globeViewportSize(width: number, viewportHeight: number) {
  return { width: Math.max(1, Math.round(width)), height: Math.max(460, Math.min(720, Math.round(viewportHeight - 290))) };
}

export function globeColorWithAlpha(color: string, alpha: number) {
  const hex = /^#[0-9a-f]{6}$/i.test(color) ? color : "#236de9";
  return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${alpha})`;
}

// Theme presets use OKLCH, which Three.js cannot parse. Canvas converts any
// browser-supported CSS color to sRGB without hardcoding the theme palette.
export function resolveGlobeThemeColor(value: string, fallback: string) {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (typeof document === "undefined" || !globalThis.CSS?.supports("color", value)) return fallback;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return fallback;
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
    return alpha ? `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}` : fallback;
  } catch { return fallback; /* Canvas readback may be blocked by browser privacy settings. */ }
}

export class GlobeSceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("[Globe] Scene unavailable", error, info); }
  render() {
    if (this.state.failed) return <div role="status" className="absolute inset-0 grid place-items-center px-8 text-center text-sm text-muted-foreground"><p>{t("地球视图暂不可用，请检查浏览器硬件加速；右侧列表仍可使用。")}</p></div>;
    return this.props.children;
  }
}

export function useGlobeScene(hovered: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [rotating, setRotating] = useState(true);
  const [size, setSize] = useState({ width: 720, height: 580 });
  const { resolvedTheme } = useTheme();
  const motionEnabled = useMotionEnabled();
  const [primary, setPrimary] = useState("#236de9");
  useEffect(() => {
    const element = containerRef.current;
    if (element) return trackGlobeTooltip(element);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    const update = () => {
      const value = getComputedStyle(root).getPropertyValue("--primary").trim();
      setPrimary(resolveGlobeThemeColor(value, resolvedTheme === "dark" ? "#76a7ff" : "#236de9"));
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["style", "class", "data-personalization-theme"] });
    return () => observer.disconnect();
  }, [resolvedTheme]);
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => {
      const next = globeViewportSize(element.getBoundingClientRect().width, window.innerHeight);
      setSize((previous) => previous.width === next.width && previous.height === next.height ? previous : next);
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener("resize", update);
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); };
  }, []);
  useEffect(() => {
    const globe = globeRef.current;
    if (!ready || !globe) return;
    const controls = globe.controls();
    controls.enablePan = false;
    controls.rotateSpeed = 0.58;
    controls.zoomSpeed = 0.8;
    controls.dampingFactor = 0.08;
    controls.minDistance = 150;
    controls.maxDistance = 520;
    globe.pointOfView({ lat: 22, lng: 108, altitude: 1.65 }, 0);
    const visibility = () => { if (document.hidden) globe.pauseAnimation(); else globe.resumeAnimation(); };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, [ready]);
  useEffect(() => {
    const controls = globeRef.current?.controls();
    if (!ready || !controls) return;
    controls.autoRotate = rotating && motionEnabled && !hovered;
    controls.autoRotateSpeed = 0.28;
    controls.enableDamping = motionEnabled;
  }, [ready, rotating, motionEnabled, hovered]);
  const reset = useCallback(() => {
    globeRef.current?.pointOfView({ lat: 22, lng: 108, altitude: 1.65 }, motionEnabled ? 700 : 0);
  }, [motionEnabled]);
  const zoom = useCallback((direction: number) => {
    const globe = globeRef.current;
    if (!globe) return;
    const view = globe.pointOfView();
    globe.pointOfView({ ...view, altitude: Math.max(0.65, Math.min(4, view.altitude * (direction > 0 ? 0.8 : 1.25))) }, motionEnabled ? 300 : 0);
  }, [motionEnabled]);
  const focus = useCallback((point: { lat: number; lng: number }) => {
    setRotating(false);
    globeRef.current?.pointOfView({ lat: point.lat, lng: point.lng, altitude: 1.15 }, motionEnabled ? 700 : 0);
  }, [motionEnabled]);
  return {
    containerRef, globeRef, ready, setReady, size, rotating, setRotating, reset, zoom, focus, motionEnabled,
    palette: { primary, cap: globeColorWithAlpha(primary, resolvedTheme === "dark" ? 0.3 : 0.25), side: globeColorWithAlpha(primary, 0.12), stroke: globeColorWithAlpha(primary, 0.8), mutedStroke: "rgba(148,163,184,.2)" },
  };
}

export function GlobeWorkspace({ title, subtitle, stats, scene, sidebar, children, empty, legend }: {
  title: string; subtitle: string;
  stats: Array<{ label: string; value: ReactNode; tone?: "success" | "warning" }>;
  scene: ReturnType<typeof useGlobeScene>;
  sidebar: ReactNode; children: ReactNode; empty?: ReactNode; legend?: ReactNode;
}) {
  return (
    <section className="globe-workspace hidden min-w-0 overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm md:block">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border/50 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="pearl-icon-badge grid h-10 w-10 shrink-0 place-items-center"><Globe2 className="h-5 w-5" /></span>
          <div className="min-w-0"><h3 className="text-sm font-semibold tracking-tight">{title}</h3><p className="mt-1 text-xs text-muted-foreground">{subtitle}</p></div>
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-2">
          {stats.map((stat) => <div key={stat.label}><dt className="text-[11px] text-muted-foreground">{stat.label}</dt><dd className={`mt-1 text-lg font-semibold leading-none tabular-nums ${stat.tone === "success" ? "text-emerald-600 dark:text-emerald-400" : stat.tone === "warning" ? "text-amber-600 dark:text-amber-400" : "text-foreground"}`}>{stat.value}</dd></div>)}
        </dl>
      </header>
      <div className="grid min-w-0 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <div ref={scene.containerRef} className="globe-stage relative min-w-0 overflow-hidden" style={{ height: scene.size.height }}>
          <div className="globe-orbit globe-orbit-outer" aria-hidden="true" /><div className="globe-orbit globe-orbit-inner" aria-hidden="true" />
          <div className="absolute inset-0"><GlobeSceneBoundary>{children}</GlobeSceneBoundary></div>
          {empty && <div className="pointer-events-none absolute inset-0 z-[2] grid place-items-center px-8"><div className="rounded-xl border border-border/60 bg-card/90 px-5 py-3 text-center text-sm text-muted-foreground shadow-sm">{empty}</div></div>}
          <div className="pointer-events-none absolute inset-x-4 bottom-4 z-[3] flex items-end justify-between gap-3">
            <div className="space-y-2 text-[11px] text-muted-foreground"><div className="flex flex-wrap items-center gap-3">{legend}</div><p className="flex items-center gap-1.5"><ScanLine className="h-3.5 w-3.5" />{t("拖动旋转 · 滚轮缩放")}</p></div>
            <div className="pointer-events-auto flex shrink-0 items-center gap-0.5 rounded-xl border border-border/70 bg-card/95 p-1 shadow-sm">
              <Button variant="ghost" size="icon" className="h-8 w-8" disabled={!scene.ready || !scene.motionEnabled} aria-label={t(scene.rotating ? "暂停旋转" : "自动旋转")} title={t(scene.rotating ? "暂停旋转" : "自动旋转")} aria-pressed={scene.rotating && scene.motionEnabled} onClick={() => scene.setRotating(!scene.rotating)}>{scene.rotating && scene.motionEnabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}</Button>
              <span className="mx-0.5 h-4 w-px bg-border" />
              <Button variant="ghost" size="icon" className="h-8 w-8" disabled={!scene.ready} aria-label={t("放大")} title={t("放大")} onClick={() => scene.zoom(1)}><Plus className="h-3.5 w-3.5" /></Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" disabled={!scene.ready} aria-label={t("缩小")} title={t("缩小")} onClick={() => scene.zoom(-1)}><Minus className="h-3.5 w-3.5" /></Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" disabled={!scene.ready} aria-label={t("重置视角")} title={t("重置视角")} onClick={scene.reset}><RotateCcw className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        </div>
        <aside className="globe-sidebar flex min-h-0 min-w-0 flex-col border-t border-border/50 bg-background/40 xl:border-l xl:border-t-0" style={{ maxHeight: scene.size.height }}>{sidebar}</aside>
      </div>
    </section>
  );
}
