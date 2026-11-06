import { trpc } from "@/lib/trpc";
import { mobileAuth } from "@/lib/mobileAuth";
import { applyManagedTheme, clearManagedTheme, isThemeSafeMode, leaveThemeSafeMode } from "@/lib/managedTheme";
import { t } from "@/i18n";
import { useEffect, useLayoutEffect, useState } from "react";
import { applySiteFavicon } from "@/lib/siteFavicon";
import { watchMobileAppIcon } from "@/lib/mobileAppIcon";
import { saveSiteBranding } from "@/lib/siteBranding";
import { setThemeRuntime } from "@/lib/themeRuntime";

const MOBILE_BACKGROUND_MEDIA = "(max-width: 767px), (pointer: coarse)";

function cssUrl(value: string) {
  return `url("${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`;
}

function shouldReduceMobileBackground() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(MOBILE_BACKGROUND_MEDIA).matches;
}

export default function PersonalizationLayer() {
  const { data } = trpc.system.publicInfo.useQuery(undefined, {
    enabled: !mobileAuth.isNative || mobileAuth.hasPanelUrl(),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  const [themeSafeMode, setThemeSafeMode] = useState(isThemeSafeMode);
  const activeTheme = data?.activeTheme;
  const customTheme = trpc.themes.styles.useQuery({ id: activeTheme?.id || "ink", revision: activeTheme?.revision && !activeTheme.builtin ? activeTheme.revision : "0".repeat(64) }, {
    enabled: !!activeTheme && !activeTheme.builtin && !themeSafeMode,
    staleTime: 60_000, retry: false, refetchOnWindowFocus: false,
  });
  const [reduceMobileBackground, setReduceMobileBackground] = useState(shouldReduceMobileBackground);
  const background = data?.personalizationBackground;
  const effectiveUrl = String(background?.effectiveUrl || "");
  const source = background?.source || "none";
  const urlType = background?.urlType || "image";
  const opacity = Math.min(1, Math.max(0, Number(background?.opacity ?? 0.22)));
  const blur = Math.min(32, Math.max(0, Number(background?.blur ?? 0)));
  const personalizationTheme = (data as any)?.personalizationTheme;
  const effectiveBlur = reduceMobileBackground ? 0 : blur;
  const scale = 1 + effectiveBlur / 320;
  const isVideoBackground = source === "url" && urlType === "video" && !!effectiveUrl;
  const showVideo = isVideoBackground && !reduceMobileBackground;
  const showImage = source !== "none" && !isVideoBackground && !!effectiveUrl;

  useEffect(() => {
    if (!data) return;
    const branding = saveSiteBranding(data);
    document.title = branding.siteTitle;
  }, [data?.siteTitle, data?.siteLogoDataUrl, !!data]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(MOBILE_BACKGROUND_MEDIA);
    const sync = () => setReduceMobileBackground(media.matches);
    sync();
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", sync);
      return () => media.removeEventListener("change", sync);
    }
    media.addListener(sync);
    return () => media.removeListener(sync);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--personalization-bg-opacity", String(opacity));
    root.style.setProperty("--personalization-bg-blur", `${effectiveBlur}px`);
    root.style.setProperty("--personalization-bg-scale", String(scale));
    if (showImage) {
      root.style.setProperty("--personalization-bg-image", cssUrl(effectiveUrl));
      root.setAttribute("data-personalization-background", "image");
    } else {
      root.style.removeProperty("--personalization-bg-image");
      if (!showVideo) root.setAttribute("data-personalization-background", "none");
    }
    if (showVideo) root.setAttribute("data-personalization-background", "video");
    return () => {
      root.style.removeProperty("--personalization-bg-image");
      root.style.removeProperty("--personalization-bg-opacity");
      root.style.removeProperty("--personalization-bg-blur");
      root.style.removeProperty("--personalization-bg-scale");
      root.removeAttribute("data-personalization-background");
    };
  }, [effectiveBlur, effectiveUrl, opacity, scale, showImage, showVideo]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const applyTheme = () => {
      const definition = customTheme.data?.revision === activeTheme?.revision ? customTheme.data : null;
      applyManagedTheme(themeSafeMode ? "ink" : personalizationTheme, themeSafeMode ? null : definition, root);
    };
    applyTheme();
    const observer = new MutationObserver(applyTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => {
      observer.disconnect();
      clearManagedTheme(root);
    };
  }, [personalizationTheme, activeTheme?.revision, customTheme.data, themeSafeMode]);

  useLayoutEffect(() => {
    setThemeRuntime(!themeSafeMode && !activeTheme?.builtin && customTheme.data?.revision === activeTheme?.revision ? customTheme.data ?? null : null);
    return () => setThemeRuntime(null);
  }, [activeTheme?.builtin, activeTheme?.revision, customTheme.data, themeSafeMode]);

  useLayoutEffect(() => {
    if (!data) return;
    const root = document.documentElement;
    const sync = () => applySiteFavicon(document, data.siteLogoDataUrl, getComputedStyle(root).getPropertyValue("--primary"));
    sync();
    // The on-page vector mark follows theme variables, so the tab must too.
    // Custom uploaded images remain unchanged when switching light/dark mode.
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class", "style"] });
    return () => observer.disconnect();
  }, [data?.siteLogoDataUrl, !!data]);

  useEffect(() => {
    // Do not reset the launcher to the fallback palette while publicInfo is loading.
    if (!data) return;
    return watchMobileAppIcon(document.documentElement);
  }, [!!data]);

  return (
    <>
    {themeSafeMode && <div role="status" className="fixed bottom-4 left-1/2 z-[9999] flex w-[min(94vw,640px)] -translate-x-1/2 items-center gap-3 rounded-lg border bg-card p-3 text-sm text-card-foreground shadow-lg">
      <span className="flex-1">{t("主题安全模式：已暂时恢复内置主题，可在主题管理中切换主题。")}</span>
      <button type="button" className="shrink-0 underline" onClick={() => { leaveThemeSafeMode(); setThemeSafeMode(false); }}>{t("退出安全模式")}</button>
    </div>}
    {showVideo && (
    <video
      key={effectiveUrl}
      className="personalization-video-background"
      src={effectiveUrl}
      autoPlay
      muted
      loop
      playsInline
      preload="metadata"
      aria-hidden="true"
    />
    )}
    </>
  );
}
