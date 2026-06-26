import { trpc } from "@/lib/trpc";
import { useEffect } from "react";

function cssUrl(value: string) {
  return `url("${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`;
}

export default function PersonalizationLayer() {
  const { data } = trpc.system.publicInfo.useQuery(undefined, {
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 60_000,
  });
  const background = data?.personalizationBackground;
  const effectiveUrl = String(background?.effectiveUrl || "");
  const source = background?.source || "none";
  const urlType = background?.urlType || "image";
  const opacity = Math.min(0.85, Math.max(0, Number(background?.opacity ?? 0.22)));
  const blur = Math.min(32, Math.max(0, Number(background?.blur ?? 0)));
  const scale = 1 + blur / 320;
  const showImage = source !== "none" && urlType !== "video" && !!effectiveUrl;
  const showVideo = source !== "none" && urlType === "video" && !!effectiveUrl;

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--personalization-bg-opacity", String(opacity));
    root.style.setProperty("--personalization-bg-blur", `${blur}px`);
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
  }, [blur, effectiveUrl, opacity, scale, showImage, showVideo]);

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
