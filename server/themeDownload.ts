import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { assertSafeOutboundUrl, isRestrictedIp } from "./ssrf";
import { THEME_LIMITS } from "../shared/themes";

export const THEME_DOWNLOAD_TIMEOUT_MS = 20_000;
export const THEME_DOWNLOAD_REDIRECTS = 3;
let activeDownloads = 0;

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** DNS is checked again inside lookup and pinned to the actual socket connection. */
export function requestThemeUrl(url: URL, signal: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).get(url, {
      signal,
      // No pooled socket may bypass this request's checked/pinned lookup.
      agent: false,
      headers: { Accept: "application/zip, application/gzip, application/x-tar, application/octet-stream", "Accept-Encoding": "identity", "User-Agent": "ForwardX-Theme-Importer/1" },
      lookup(hostname, _options, callback) {
        void lookup(hostname, { all: true, verbatim: true }).then(records => {
          if (!records.length || records.some(record => isRestrictedIp(record.address, false))) {
            callback(new Error("主题下载不允许访问受限地址"), "", 4);
          } else if (_options.all) callback(null, [records[0]]);
          else callback(null, records[0].address, records[0].family);
        }, error => callback(error, "", 4));
      },
    }, resolve);
    request.on("error", reject);
  });
}

export async function downloadThemeArchive(rawUrl: string, dependencies: {
  validate?: typeof assertSafeOutboundUrl;
  request?: typeof requestThemeUrl;
  signal?: AbortSignal;
} = {}) {
  if (activeDownloads >= 2) throw new Error("主题下载繁忙，请稍后重试");
  activeDownloads++;
  const signal = dependencies.signal || AbortSignal.timeout(THEME_DOWNLOAD_TIMEOUT_MS);
  const validate = dependencies.validate || assertSafeOutboundUrl;
  const request = dependencies.request || requestThemeUrl;
  try {
    let current = rawUrl;
    for (let redirects = 0; redirects <= THEME_DOWNLOAD_REDIRECTS; redirects++) {
      signal.throwIfAborted();
      const url = await abortable(validate(current, { purpose: "主题下载", allowPrivate: false }), signal);
      signal.throwIfAborted();
      const response = await request(url, signal);
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy();
        const location = response.headers.location;
        if (!location || redirects === THEME_DOWNLOAD_REDIRECTS) throw new Error("主题下载重定向次数过多或地址无效");
        current = new URL(location, url).href;
        continue;
      }
      if (status < 200 || status >= 300) { response.destroy(); throw new Error(`主题下载失败（HTTP ${status}）`); }
      if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
        response.destroy(); throw new Error("主题直链服务器必须支持原始文件下载（identity 编码）");
      }
      if (Number(response.headers["content-length"]) > THEME_LIMITS.archiveBytes) {
        response.destroy(); throw new Error("主题压缩包不能超过 3MB");
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        signal.throwIfAborted();
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > THEME_LIMITS.archiveBytes) { response.destroy(); throw new Error("主题压缩包不能超过 3MB"); }
        chunks.push(bytes);
      }
      return Buffer.concat(chunks);
    }
    throw new Error("主题下载失败");
  } catch (error) {
    if (signal.aborted) throw new Error("主题下载超时或已取消");
    throw error;
  } finally { activeDownloads--; }
}
