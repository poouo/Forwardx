import { useEffect } from "react";
import { trpc } from "@/lib/trpc";

declare global {
  interface Window {
    initWidget?: (config: {
      waifuPath: string;
      cdnPath?: string;
      cubism2Path?: string;
      cubism5Path?: string;
      modelId?: number;
      tools?: string[];
      drag?: boolean;
      showToggleAfterQuit?: boolean;
      logLevel?: "error" | "warn" | "info" | "trace";
    }) => void;
  }
}

type Live2dWidgetConfig = {
  enabled?: boolean;
  scriptUrl?: string;
  styleUrl?: string;
  cubism2Path?: string;
  cubism5Path?: string;
  waifuPath?: string;
  cdnPath?: string;
  modelId?: number;
  tools?: string[];
  drag?: boolean;
  showToggleAfterQuit?: boolean;
  logLevel?: "error" | "warn" | "info" | "trace";
  showOnMobile?: boolean;
  dock?: "left" | "right";
  size?: number;
};

const LIVE2D_STYLE_ID = "forwardx-live2d-widget-style";
const LIVE2D_RESOURCE_ATTRIBUTE = "data-forwardx-live2d-resource";
const LIVE2D_BODY_CLASS = "forwardx-live2d-active";
const LIVE2D_RIGHT_BODY_CLASS = "forwardx-live2d-right";
let runtimeLoad: Promise<void> | null = null;

function loadExternalResource(url: string, type: "css" | "js") {
  const existing = Array.from(document.querySelectorAll<HTMLLinkElement | HTMLScriptElement>(`[${LIVE2D_RESOURCE_ATTRIBUTE}]`))
    .find((element) => element.getAttribute(LIVE2D_RESOURCE_ATTRIBUTE) === url);
  if (existing) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const element = type === "css" ? document.createElement("link") : document.createElement("script");
    element.setAttribute(LIVE2D_RESOURCE_ATTRIBUTE, url);
    element.addEventListener("load", () => resolve(), { once: true });
    element.addEventListener("error", () => reject(new Error(`Live2D resource failed: ${url}`)), { once: true });
    if (type === "css") {
      const link = element as HTMLLinkElement;
      link.rel = "stylesheet";
      link.href = url;
    } else {
      const script = element as HTMLScriptElement;
      script.type = "module";
      script.src = url;
      script.crossOrigin = "anonymous";
    }
    document.head.appendChild(element);
  });
}

function loadLive2dRuntime(config: Live2dWidgetConfig) {
  if (typeof window.initWidget === "function") return Promise.resolve();
  if (runtimeLoad) return runtimeLoad;
  runtimeLoad = Promise.all([
    loadExternalResource(String(config.styleUrl || ""), "css"),
    loadExternalResource(String(config.scriptUrl || ""), "js"),
  ]).then(() => {
    if (typeof window.initWidget !== "function") throw new Error("Live2D runtime did not expose initWidget");
  }).catch((error) => {
    runtimeLoad = null;
    throw error;
  });
  return runtimeLoad;
}

function patchImageCrossOrigin() {
  const marker = "__forwardxLive2dImagePatched";
  const windowValue = window as Window & { [marker]?: boolean };
  if (windowValue[marker]) return;
  const OriginalImage = window.Image;
  window.Image = function (...args: any[]) {
    const image = new (OriginalImage as any)(...args) as HTMLImageElement;
    image.crossOrigin = "anonymous";
    return image;
  } as unknown as typeof Image;
  window.Image.prototype = OriginalImage.prototype;
  windowValue[marker] = true;
}

function resolveResourcePath(value: string | undefined) {
  const path = String(value || "").trim();
  if (!path) return "";
  try {
    return new URL(path, window.location.origin).toString();
  } catch {
    return "";
  }
}

function applyWidgetLayout(config: Live2dWidgetConfig) {
  const waifu = document.getElementById("waifu");
  const canvas = document.getElementById("live2d") as HTMLCanvasElement | null;
  if (!waifu || !canvas) return false;

  const size = Math.max(200, Math.min(420, Number(config.size || 280)));
  waifu.dataset.forwardxLive2d = "true";
  canvas.style.setProperty("width", `${size}px`, "important");
  canvas.style.setProperty("height", `${size}px`, "important");
  document.body.classList.add(LIVE2D_BODY_CLASS);
  if (config.dock === "left") {
    document.body.classList.remove(LIVE2D_RIGHT_BODY_CLASS);
  } else {
    document.body.classList.add(LIVE2D_RIGHT_BODY_CLASS);
  }

  if (config.drag && config.dock !== "left" && waifu.dataset.forwardxDragReady !== "true") {
    waifu.dataset.forwardxDragReady = "true";
    waifu.addEventListener("mousedown", () => {
      const rect = waifu.getBoundingClientRect();
      waifu.style.left = `${rect.left}px`;
      waifu.style.right = "auto";
      document.body.classList.remove(LIVE2D_RIGHT_BODY_CLASS);
    }, { capture: true, once: true });
  }
  return true;
}

function installLayoutStyle() {
  if (document.getElementById(LIVE2D_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = LIVE2D_STYLE_ID;
  style.textContent = `
    body.${LIVE2D_BODY_CLASS} #waifu,
    body.${LIVE2D_BODY_CLASS} #waifu-toggle { z-index: 45; }
    body.${LIVE2D_RIGHT_BODY_CLASS} #waifu { left: auto; right: 16px; }
    body.${LIVE2D_RIGHT_BODY_CLASS} #waifu-toggle {
      left: auto; right: 0; justify-content: flex-start; margin-left: 0; margin-right: -100px;
    }
    body.${LIVE2D_RIGHT_BODY_CLASS} #waifu-toggle.waifu-toggle-active { margin-right: -50px; }
    body.${LIVE2D_RIGHT_BODY_CLASS} #waifu-toggle.waifu-toggle-active:hover { margin-right: -30px; }
    body.${LIVE2D_BODY_CLASS} #waifu[data-forwardx-live2d] #live2d { max-width: 80vw; max-height: 55vh; }
    @media (max-width: 767px) {
      body.${LIVE2D_BODY_CLASS} #waifu[data-forwardx-live2d] #live2d { max-width: 72vw; max-height: 42vh; }
    }
  `;
  document.head.appendChild(style);
}

export default function Live2DWidgetHost() {
  const { data } = trpc.plugins.live2dWidget.useQuery(undefined, {
    retry: false,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const config = data as Live2dWidgetConfig | undefined;
    if (!config?.enabled || typeof window === "undefined" || typeof document === "undefined") return;
    if (!config.showOnMobile && window.matchMedia?.("(max-width: 767px)").matches) return;
    if (document.getElementById("waifu") || document.getElementById("waifu-toggle")) return;

    let cancelled = false;
    let observer: MutationObserver | null = null;
    const start = async () => {
      try {
        await loadLive2dRuntime(config);
        if (cancelled || typeof window.initWidget !== "function") return;
        patchImageCrossOrigin();
        installLayoutStyle();
        const waifuPath = resolveResourcePath(config.waifuPath);
        const cdnPath = resolveResourcePath(config.cdnPath);
        if (!waifuPath || !cdnPath) throw new Error("Live2D resource path is invalid");
        window.initWidget({
          waifuPath,
          cdnPath,
          cubism2Path: config.cubism2Path,
          cubism5Path: config.cubism5Path,
          modelId: Number(config.modelId || 0),
          tools: Array.isArray(config.tools) ? config.tools : undefined,
          drag: config.drag === true,
          showToggleAfterQuit: config.showToggleAfterQuit !== false,
          logLevel: config.logLevel || "warn",
        });
        observer = new MutationObserver(() => applyWidgetLayout(config));
        observer.observe(document.body, { childList: true, subtree: true });
        window.setTimeout(() => applyWidgetLayout(config), 0);
      } catch (error) {
        console.warn("[ForwardX] Live2D widget was not loaded", error);
      }
    };
    void start();

    return () => {
      cancelled = true;
      observer?.disconnect();
      document.getElementById("waifu")?.remove();
      document.getElementById("waifu-toggle")?.remove();
      document.body.classList.remove(LIVE2D_BODY_CLASS, LIVE2D_RIGHT_BODY_CLASS);
    };
  }, [data]);

  return null;
}
