export type TextDownloadFile = {
  filename: string;
  content: string;
  mimeType?: string;
};

type DownloadLink = {
  href: string;
  download: string;
  rel: string;
  style: { display: string };
  click: () => void;
};

export type FileDownloadRuntime = {
  createBlob: (content: string, mimeType: string) => unknown;
  createObjectUrl: (blob: unknown) => string;
  revokeObjectUrl: (url: string) => void;
  createLink: () => DownloadLink;
  appendLink: (link: DownloadLink) => void;
  removeLink: (link: DownloadLink) => void;
  schedule: (callback: () => void, delayMs: number) => unknown;
};

export type FileDownloadMethod = "blob" | "data";

export const DOWNLOAD_LINK_CLEANUP_DELAY_MS = 1_000;
export const DOWNLOAD_OBJECT_URL_REVOKE_DELAY_MS = 60_000;
export const MAX_DATA_URL_FALLBACK_LENGTH = 512 * 1024;

function normalizeDownloadMimeType(mimeType: string) {
  const normalized = String(mimeType || "").trim();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;\s*charset=[a-z0-9._-]+)?$/i.test(normalized)
    ? normalized
    : "application/octet-stream";
}

export function sanitizeDownloadFilename(filename: string) {
  const sanitized = String(filename || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 180);
  return sanitized || "forwardx-download.txt";
}

function getBrowserDownloadRuntime(): FileDownloadRuntime {
  if (typeof document === "undefined" || !document.body) {
    throw new Error("当前环境不支持浏览器文件下载");
  }
  return {
    createBlob: (content, mimeType) => {
      if (typeof Blob === "undefined") throw new Error("当前浏览器不支持 Blob 文件下载");
      return new Blob([content], { type: mimeType });
    },
    createObjectUrl: (blob) => {
      if (typeof globalThis.URL?.createObjectURL !== "function") {
        throw new Error("当前浏览器不支持 Blob 文件下载");
      }
      return globalThis.URL.createObjectURL(blob as Blob);
    },
    revokeObjectUrl: (url) => globalThis.URL?.revokeObjectURL?.(url),
    createLink: () => document.createElement("a"),
    appendLink: (link) => document.body.appendChild(link as HTMLAnchorElement),
    removeLink: (link) => (link as HTMLAnchorElement).remove(),
    schedule: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  };
}

function safeRemoveLink(runtime: FileDownloadRuntime, link: DownloadLink) {
  try {
    runtime.removeLink(link);
  } catch {
    // Download cleanup must not turn a completed download into a reported failure.
  }
}

function safeRevokeObjectUrl(runtime: FileDownloadRuntime, url: string) {
  try {
    runtime.revokeObjectUrl(url);
  } catch {
    // The URL is already detached from the UI; a failed cleanup is harmless.
  }
}

function scheduleCleanup(runtime: FileDownloadRuntime, callback: () => void, delayMs: number) {
  try {
    runtime.schedule(callback, delayMs);
  } catch {
    // setTimeout is expected to be available in browsers. Keep the download successful if a host overrides it.
  }
}

function triggerDownloadLink(
  runtime: FileDownloadRuntime,
  href: string,
  filename: string,
) {
  const link = runtime.createLink();
  link.href = href;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  runtime.appendLink(link);
  try {
    link.click();
  } catch (error) {
    safeRemoveLink(runtime, link);
    throw error;
  }
  scheduleCleanup(
    runtime,
    () => safeRemoveLink(runtime, link),
    DOWNLOAD_LINK_CLEANUP_DELAY_MS,
  );
}

export function downloadTextFile(
  filename: string,
  content: string,
  mimeType = "text/plain;charset=utf-8",
  injectedRuntime?: FileDownloadRuntime,
): FileDownloadMethod {
  const runtime = injectedRuntime || getBrowserDownloadRuntime();
  const safeFilename = sanitizeDownloadFilename(filename);
  const safeMimeType = normalizeDownloadMimeType(mimeType);
  let objectUrl = "";

  try {
    const blob = runtime.createBlob(content, safeMimeType);
    objectUrl = runtime.createObjectUrl(blob);
    triggerDownloadLink(runtime, objectUrl, safeFilename);
    scheduleCleanup(
      runtime,
      () => safeRevokeObjectUrl(runtime, objectUrl),
      DOWNLOAD_OBJECT_URL_REVOKE_DELAY_MS,
    );
    return "blob";
  } catch {
    if (objectUrl) safeRevokeObjectUrl(runtime, objectUrl);
  }

  try {
    if (content.length > MAX_DATA_URL_FALLBACK_LENGTH) {
      throw new Error("文件过大，无法使用兼容下载");
    }
    const dataUrl = `data:${safeMimeType},${encodeURIComponent(content)}`;
    triggerDownloadLink(runtime, dataUrl, safeFilename);
    return "data";
  } catch {
    throw new Error("浏览器未能保存文件，请检查下载权限后重试");
  }
}
