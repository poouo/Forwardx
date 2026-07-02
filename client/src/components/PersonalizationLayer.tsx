import { trpc } from "@/lib/trpc";
import { mobileAuth } from "@/lib/mobileAuth";
import { applyPersonalizationTheme, clearPersonalizationTheme } from "@/lib/personalizationTheme";
import { useEffect, useLayoutEffect, useState } from "react";

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
      applyPersonalizationTheme(personalizationTheme, root);
    };
    applyTheme();
    const observer = new MutationObserver(applyTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => {
      observer.disconnect();
      clearPersonalizationTheme(root);
    };
  }, [personalizationTheme]);

  if (!showVideo) return null;

  return (
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
  );
}
