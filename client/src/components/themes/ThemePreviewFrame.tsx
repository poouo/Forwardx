import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ThemeDefinition, ThemeSummary } from "@shared/themes";
import { themePreviewDocument } from "@/lib/themePreview";
import { t } from "@/i18n";

export default function ThemePreviewFrame({ theme, dark, definition, kind, viewport = "desktop" }: { theme: ThemeSummary; dark: boolean; definition?: ThemeDefinition; kind: "workspace" | "hosts" | "login"; viewport?: "desktop" | "mobile" }) {
  const [preview, setPreview] = useState<{ key: string; html?: string; error?: string }>();
  const frame = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(800);
  useLayoutEffect(() => {
    const container = frame.current;
    if (!container) return;
    const measure = () => setAvailableWidth(container.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const key = `${theme.id}:${theme.revision}:${kind}:${dark}`;
  useEffect(() => {
    if (kind === "workspace") return;
    let cancelled = false;
    import("@/lib/themeViewsPreview").then(module => module.renderThemeViewsPreview(theme, dark, definition, kind)).then(html => {
      if (!cancelled) setPreview({ key, html });
    }).catch(() => { if (!cancelled) setPreview({ key, error: t("主题预览生成失败") }); });
    return () => { cancelled = true; };
  }, [key, definition]);
  const html = kind === "workspace" ? themePreviewDocument(theme, dark, definition, { title: t("主题预览"), navigation: t("仪表盘"), card: t("工作空间"), button: t("保存"), input: t("输入内容") }) : preview?.key === key ? preview.html : undefined;
  if (kind !== "workspace" && preview?.key === key && preview.error) return <p role="alert" className="text-destructive">{preview.error}</p>;
  const width = viewport === "desktop" ? 1280 : 390;
  const scale = Math.min(1, availableWidth / width);
  const height = Math.min(viewport === "desktop" ? 720 : 760, Math.floor(480 / Math.max(scale, 0.01)));
  return <div ref={frame} className="min-w-0 w-full overflow-hidden rounded-lg border bg-muted/20" style={{ height: height * scale }}>
    {html ? <iframe title={t("主题预览")} sandbox="" className="mx-auto border-0 bg-background" style={{ width, height, transform: `scale(${scale})`, transformOrigin: "top left" }} srcDoc={html} /> : <p role="status" className="p-4 text-sm">{t("正在加载主题")}</p>}
  </div>;
}
