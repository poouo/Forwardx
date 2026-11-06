import { createHash } from "node:crypto";
import path from "node:path";
import { TextDecoder } from "node:util";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import tar from "tar-stream";
import yauzl from "yauzl";
import postcss from "postcss";
import valueParser from "postcss-value-parser";
import { z } from "zod";
import { PERSONALIZATION_THEME_PRESETS } from "../shared/personalization";
import { THEME_API_VERSION, THEME_LIMITS, type ThemeDefinition, type ThemeManifest } from "../shared/themes";
import { readRarThemeArchive } from "./themeRar";
import { themeViewsSchema } from "../shared/themeViews";

const safePath = (name: string) => name.length <= 200 && /^[a-zA-Z0-9_./-]+$/.test(name)
  && !name.startsWith("/") && !name.split("/").some(part => part === ".." || part === "." || !part);
const variableMap = z.record(z.string().regex(/^--[a-z][a-z0-9-]{0,63}$/), z.string().min(1).max(512));
export const themeManifestSchema = z.object({
  apiVersion: z.literal(THEME_API_VERSION),
  id: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
  name: z.string().trim().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/).max(64),
  description: z.string().max(500).optional(), author: z.string().max(100).optional(),
  base: z.enum(["ink", "teal", "forest", "wisteria", "ember", "sakura"]).default("ink"),
  stylesheet: z.string().refine(value => safePath(value) && value.endsWith(".css"), "样式文件路径无效"),
  variables: z.object({ light: variableMap.optional(), dark: variableMap.optional() }).strict().optional(),
  views: themeViewsSchema.optional(),
}).strict();

const assetTypes: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".woff": "font/woff", ".woff2": "font/woff2",
};

function decodeText(bytes: Buffer) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
}

/** Read one entry at a time; never extract uploads to the filesystem. */
function readZipArchive(buffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(new Error("无法读取主题 ZIP 文件"));
      const files = new Map<string, Buffer>();
      const names = new Set<string>();
      let count = 0, total = 0, settled = false;
      const fail = (reason: unknown) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      };
      zip.on("error", fail);
      zip.on("end", () => { if (!settled) { settled = true; resolve(files); } });
      zip.on("entry", (entry: yauzl.Entry) => {
        const directory = entry.fileName.endsWith("/");
        const name = directory ? entry.fileName.slice(0, -1) : entry.fileName;
        const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (++count > THEME_LIMITS.files || !safePath(name) || names.has(name.toLowerCase())
          || entry.isEncrypted() || (kind !== 0 && kind !== 0x8000 && kind !== 0x4000)) {
          return fail(new Error("主题 ZIP 含有重复、加密、不安全的路径或过多文件"));
        }
        names.add(name.toLowerCase());
        if (directory) { zip.readEntry(); return; }
        const ext = path.posix.extname(name).toLowerCase();
        if (name !== "theme.json" && ![".css", ".md", ".txt", ...Object.keys(assetTypes)].includes(ext)) {
          return fail(new Error(`主题包含不支持的文件：${name}`));
        }
        if (entry.uncompressedSize > THEME_LIMITS.fileBytes || total + entry.uncompressedSize > THEME_LIMITS.expandedBytes) {
          return fail(new Error("主题解压后过大（单文件 2MB、合计 6MB）"));
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(streamError || new Error("主题文件读取失败"));
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on("error", fail);
          stream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            total += chunk.length;
            if (size > THEME_LIMITS.fileBytes || total > THEME_LIMITS.expandedBytes) {
              stream.destroy(new Error("主题解压数据超过限制"));
              return;
            }
            chunks.push(chunk);
          });
          stream.on("end", () => {
            if (settled) return;
            files.set(name, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

async function readTarArchive(buffer: Buffer, gzip: boolean) {
  const files = new Map<string, Buffer>();
  const names = new Set<string>();
  let total = 0, count = 0, expanded = 0;
  const extract = tar.extract();
  extract.on("entry", (header, stream, next) => {
    stream.on("error", error => extract.destroy(error));
    const name = header.name.replace(/\/$/, "");
    const directory = header.type === "directory";
    const ext = path.posix.extname(name).toLowerCase();
    if (++count > THEME_LIMITS.files || !safePath(name) || names.has(name.toLowerCase())
      || !["file", "directory"].includes(header.type || "file")) {
      extract.destroy(new Error("主题 TAR 含有重复、不安全的路径、链接或过多文件")); return;
    }
    names.add(name.toLowerCase());
    if (directory) { stream.resume(); stream.on("end", next); return; }
    if (name !== "theme.json" && ![".css", ".md", ".txt", ...Object.keys(assetTypes)].includes(ext)) {
      extract.destroy(new Error(`主题包含不支持的文件：${name}`)); return;
    }
    if ((header.size || 0) > THEME_LIMITS.fileBytes || total + (header.size || 0) > THEME_LIMITS.expandedBytes) {
      extract.destroy(new Error("主题解压后过大（单文件 2MB、合计 6MB）")); return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    stream.on("data", (data: unknown) => {
      const chunk = Buffer.from(data as Uint8Array);
      size += chunk.length; total += chunk.length;
      if (size > THEME_LIMITS.fileBytes || total > THEME_LIMITS.expandedBytes) {
        extract.destroy(new Error("主题解压数据超过限制")); return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => { files.set(name, Buffer.concat(chunks)); next(); });
  });
  const cap = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    expanded += chunk.length;
    callback(expanded > THEME_LIMITS.expandedBytes + THEME_LIMITS.files * 1024 + 2048 ? new Error("主题 TAR 解压数据超过限制") : null, chunk);
  } });
  if (gzip) await pipeline(Readable.from(buffer), createGunzip(), cap, extract);
  else await pipeline(Readable.from(buffer), cap, extract);
  return files;
}

export function readThemeArchive(buffer: Buffer): Promise<Map<string, Buffer>> {
  if (!buffer.length || buffer.length > THEME_LIMITS.archiveBytes) throw new Error("主题压缩包不能超过 3MB");
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return readZipArchive(buffer);
  if (buffer.subarray(0, 6).equals(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]))) return readRarThemeArchive(buffer);
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) return readTarArchive(buffer, true);
  if (buffer.length >= 512 && buffer.subarray(257, 262).toString() === "ustar") return readTarArchive(buffer, false);
  throw new Error("不支持的主题压缩格式，请使用 ZIP、RAR、TAR、TAR.GZ 或 TGZ");
}

function checkCssText(text: string) {
  // Reject escape obfuscation, including escaped url/import names. Keep normal
  // child combinators and media range comparisons available to theme authors.
  if (/[\\\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) || /<\/(?:style|script)/i.test(text)) throw new Error("主题 CSS 不支持转义标识符、HTML 或控制字符");
}

function rewriteValue(value: string, stylesheet: string, files: Map<string, Buffer>, allowAssets: boolean, budget?: { bytes: number }) {
  checkCssText(value);
  const parsed = valueParser(value);
  parsed.walk(node => {
    if (node.type === "function") {
      const name = node.value.toLowerCase();
      if (["expression", "image-set", "-webkit-image-set", "paint", "element", "-moz-element"].includes(name)) throw new Error("主题 CSS 包含不支持的函数");
      if (name === "url") {
        if (!allowAssets) throw new Error("主题变量不能包含 URL，请在样式表中引用资源");
        const significant = node.nodes.filter(child => child.type !== "space");
        if (significant.length !== 1 || !["word", "string"].includes(significant[0].type)) throw new Error("主题资源 URL 无效");
        const relative = significant[0].value;
        if (relative.startsWith("/") || /[:?#%]/.test(relative)) throw new Error("主题资源只允许压缩包内相对路径");
        const asset = path.posix.join(path.posix.dirname(stylesheet), relative);
        const bytes = files.get(asset);
        const mime = assetTypes[path.posix.extname(asset).toLowerCase()];
        if (!safePath(asset) || !bytes || !mime) throw new Error(`主题资源不存在或不支持：${relative}`);
        if (budget) {
          budget.bytes += 4 * Math.ceil(bytes.length / 3) + mime.length + 32;
          if (budget.bytes > THEME_LIMITS.compiledCssBytes) throw new Error("主题引用资源展开后超过 3MB，请减少资源");
        }
        node.nodes = [{ type: "string", quote: '"', value: `data:${mime};base64,${bytes.toString("base64")}`, sourceIndex: 0, sourceEndIndex: 0 }];
        return false;
      }
    }
  });
  return parsed.toString();
}

export function compileTheme(manifest: ThemeManifest, source: string, files: Map<string, Buffer>) {
  if (Buffer.byteLength(source) > THEME_LIMITS.cssBytes) throw new Error("主题 CSS 不能超过 128KB");
  checkCssText(source);
  const budget = { bytes: Buffer.byteLength(source) };
  const css = postcss.parse(source, { from: manifest.stylesheet });
  css.walkAtRules(rule => {
    if (!["media", "supports", "container", "layer", "keyframes", "-webkit-keyframes", "font-face", "property", "starting-style"].includes(rule.name.toLowerCase())) {
      throw new Error(`主题 CSS 不支持 @${rule.name}`);
    }
  });
  css.walkDecls(decl => {
    if (/^(?:behavior|-moz-binding)$/i.test(decl.prop)) throw new Error("主题 CSS 包含不支持的属性");
    decl.value = rewriteValue(decl.value, manifest.stylesheet, files, true, budget);
  });
  for (const variables of Object.values(manifest.variables || {})) {
    if (Object.keys(variables).length > 128) throw new Error("每个模式最多支持 128 个主题变量");
    for (const [key, value] of Object.entries(variables)) {
      if (/[;{}!]/.test(value)) throw new Error(`主题变量无效：${key}`);
      rewriteValue(value, manifest.stylesheet, files, false);
    }
  }
  const compiled = css.toString();
  if (Buffer.byteLength(compiled) > THEME_LIMITS.compiledCssBytes) throw new Error("主题引用资源展开后超过 3MB，请减少资源");
  return compiled;
}

export async function parseThemePackage(buffer: Buffer): Promise<ThemeDefinition> {
  const files = await readThemeArchive(buffer);
  const json = files.get("theme.json");
  if (!json || json.length > 64 * 1024) throw new Error("主题压缩包根目录必须包含 theme.json（最大 64KB）");
  const parsed = themeManifestSchema.safeParse(JSON.parse(decodeText(json)));
  if (!parsed.success) throw new Error(`theme.json 无效：${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("；")}`);
  const manifest = parsed.data;
  if (PERSONALIZATION_THEME_PRESETS.some(preset => preset.id === manifest.id)) throw new Error("自定义主题 ID 不能与内置主题重复");
  const source = files.get(manifest.stylesheet);
  if (!source) throw new Error("找不到 theme.json 指定的样式表");
  const css = compileTheme(manifest, decodeText(source), files);
  const revision = createHash("sha256").update(JSON.stringify(manifest)).update(css).digest("hex");
  return { manifest, css, revision };
}
