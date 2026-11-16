import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Request, Response, Router } from "express";
import * as db from "./db";

/**
 * Mimic 编译产物缓存。
 *
 * 内核模块只能加载到与编译时完全一致的内核上，所以每种内核都要有一台主机
 * 编译一次。这里把编译结果按「mimic 版本 + 内核 + 架构 + 变体」存在面板上，
 * 同内核的其他主机安装时直接下载，不再装头文件和编译器。
 *
 * 产物会以 root 加载进内核，因此只接受持有有效 Agent Token 的请求；Agent
 * Token 只能由管理员签发，上传方和下载方属于同一信任域。请求不携带 Token
 * 本身，只带它的 SHA-256 和对产物描述、内容摘要的 HMAC，面板走 HTTP 时
 * Token 也不会明文出现在链路上。
 */

export const MIMIC_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
const MIMIC_CACHE_MAX_ENTRIES = 300;
const SIGNATURE_CONTEXT = "forwardx-mimic-cache-v1";
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 120;

export type MimicArtifactDescriptor = {
  kind: "kmod" | "cli";
  version: string;
  arch: string;
  hack: "kfunc" | "kprobe";
  kernelRelease: string;
  kernelBuild: string;
  libc: string;
};

type HeaderSource = Record<string, unknown>;

function header(headers: HeaderSource, name: string) {
  const value = headers[name];
  return String(Array.isArray(value) ? value[0] ?? "" : value ?? "").trim();
}

export function parseMimicArtifactDescriptor(headers: HeaderSource): MimicArtifactDescriptor | null {
  const kind = header(headers, "x-mimic-kind");
  const version = header(headers, "x-mimic-version");
  const arch = header(headers, "x-mimic-arch");
  const hack = header(headers, "x-mimic-hack");
  const kernelRelease = header(headers, "x-mimic-kernel-release");
  const kernelBuild = header(headers, "x-mimic-kernel-build").toLowerCase();
  const libc = header(headers, "x-mimic-libc");
  if (kind !== "kmod" && kind !== "cli") return null;
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version)) return null;
  if (!/^[a-z0-9_]{2,16}$/.test(arch)) return null;
  if (hack !== "kfunc" && hack !== "kprobe") return null;
  if (kind === "kmod") {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+~-]{2,127}$/.test(kernelRelease)) return null;
    if (!/^[a-f0-9]{64}$/.test(kernelBuild)) return null;
    if (libc) return null;
    return { kind, version, arch, hack, kernelRelease, kernelBuild, libc: "" };
  }
  if (kernelRelease || kernelBuild) return null;
  if (libc !== "glibc" && libc !== "musl") return null;
  return { kind, version, arch, hack, kernelRelease: "", kernelBuild: "", libc };
}

function canonical(descriptor: MimicArtifactDescriptor) {
  return [
    descriptor.kind,
    descriptor.version,
    descriptor.arch,
    descriptor.hack,
    descriptor.kernelRelease,
    descriptor.kernelBuild,
    descriptor.libc,
  ].join("\n");
}

export function mimicArtifactId(descriptor: MimicArtifactDescriptor) {
  return crypto.createHash("sha256").update(canonical(descriptor)).digest("hex");
}

export function mimicTokenId(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function signMimicArtifactRequest(token: string, method: string, descriptor: MimicArtifactDescriptor, bodySha256 = "") {
  const message = [SIGNATURE_CONTEXT, method.toUpperCase(), canonical(descriptor), bodySha256].join("\n");
  return crypto.createHmac("sha256", token).update(message).digest("hex");
}

export function verifyMimicArtifactRequest(input: {
  tokens: readonly string[];
  tokenId: string;
  signature: string;
  method: string;
  descriptor: MimicArtifactDescriptor;
  bodySha256?: string;
}) {
  const tokenId = input.tokenId.toLowerCase();
  const signature = input.signature.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(tokenId) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  for (const token of input.tokens) {
    if (!token || mimicTokenId(token) !== tokenId) continue;
    const expected = signMimicArtifactRequest(token, input.method, input.descriptor, input.bodySha256 || "");
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  }
  return false;
}

/** 上传内容必须是 ELF；内核模块还要确实是为所声明的内核编译的 mimic 模块。 */
export function validateMimicArtifact(descriptor: MimicArtifactDescriptor, body: Buffer) {
  if (body.length < 64 || body.length > MIMIC_ARTIFACT_MAX_BYTES) return "size";
  if (body[0] !== 0x7f || body[1] !== 0x45 || body[2] !== 0x4c || body[3] !== 0x46) return "not-elf";
  if (descriptor.kind === "kmod") {
    if (!body.includes(Buffer.from(`vermagic=${descriptor.kernelRelease} `))) return "vermagic";
    if (!body.includes(Buffer.from("name=mimic\0"))) return "module-name";
  }
  return "";
}

export function mimicBuildCacheDir() {
  const configured = String(process.env.FORWARDX_MIMIC_CACHE_DIR || "").trim();
  return configured || path.resolve(process.cwd(), "data", "mimic-build-cache");
}

function artifactPath(descriptor: MimicArtifactDescriptor) {
  return path.join(mimicBuildCacheDir(), `${mimicArtifactId(descriptor)}.bin`);
}

export async function readMimicArtifact(descriptor: MimicArtifactDescriptor) {
  try {
    const body = await fs.promises.readFile(artifactPath(descriptor));
    if (validateMimicArtifact(descriptor, body)) return null;
    return { body, sha256: crypto.createHash("sha256").update(body).digest("hex") };
  } catch {
    return null;
  }
}

async function pruneMimicArtifacts(dir: string) {
  const names = (await fs.promises.readdir(dir)).filter((name) => name.endsWith(".bin"));
  if (names.length <= MIMIC_CACHE_MAX_ENTRIES) return;
  const entries = await Promise.all(names.map(async (name) => {
    const stat = await fs.promises.stat(path.join(dir, name)).catch(() => null);
    return { name, mtimeMs: stat?.mtimeMs ?? 0 };
  }));
  entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const entry of entries.slice(0, entries.length - MIMIC_CACHE_MAX_ENTRIES)) {
    await fs.promises.rm(path.join(dir, entry.name), { force: true });
    await fs.promises.rm(path.join(dir, entry.name.replace(/\.bin$/, ".json")), { force: true });
  }
}

export async function writeMimicArtifact(descriptor: MimicArtifactDescriptor, body: Buffer) {
  const dir = mimicBuildCacheDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const target = artifactPath(descriptor);
  const temp = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.promises.writeFile(temp, body, { mode: 0o600 });
    await fs.promises.rename(temp, target);
  } catch (error) {
    await fs.promises.rm(temp, { force: true });
    throw error;
  }
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  await fs.promises.writeFile(
    target.replace(/\.bin$/, ".json"),
    JSON.stringify({ ...descriptor, sha256, size: body.length, uploadedAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );
  await pruneMimicArtifacts(dir).catch(() => undefined);
  return sha256;
}

function readBoundedBody(req: Request, limit: number) {
  return new Promise<Buffer | null>((resolve) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > limit) { resolve(null); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: Buffer | null) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(Buffer.concat(chunks)));
    req.on("error", () => finish(null));
    req.on("aborted", () => finish(null));
  });
}

const requestWindows = new Map<string, { start: number; count: number }>();

function rateLimited(req: Request) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let entry = requestWindows.get(ip);
  if (!entry || now - entry.start >= RATE_WINDOW_MS) entry = { start: now, count: 0 };
  entry.count += 1;
  if (requestWindows.size > 4096) requestWindows.clear();
  requestWindows.set(ip, entry);
  return entry.count > RATE_LIMIT;
}

type CacheRouteOptions = {
  /** 测试用：替换有效 Agent Token 的来源。 */
  loadTokens?: () => Promise<readonly string[]>;
  log?: (message: string) => void;
};

export function registerMimicBuildCacheRoutes(router: Router, options: CacheRouteOptions = {}) {
  const loadTokens = options.loadTokens ?? (() => db.getAgentAuthTokenCandidates());
  const log = options.log ?? ((message: string) => console.info(message));

  const authorize = async (req: Request, res: Response, bodySha256 = "") => {
    if (rateLimited(req)) {
      res.status(429).json({ error: "Too many requests" });
      return null;
    }
    const descriptor = parseMimicArtifactDescriptor(req.headers as HeaderSource);
    if (!descriptor) {
      res.status(400).json({ error: "Invalid artifact description" });
      return null;
    }
    const authorized = verifyMimicArtifactRequest({
      tokens: await loadTokens(),
      tokenId: header(req.headers as HeaderSource, "x-forwardx-token-id"),
      signature: header(req.headers as HeaderSource, "x-forwardx-signature"),
      method: req.method,
      descriptor,
      bodySha256,
    });
    if (!authorized) {
      res.status(401).json({ error: "Unauthorized" });
      return null;
    }
    return descriptor;
  };

  router.get("/api/agent/mimic-cache", async (req: Request, res: Response) => {
    try {
      const descriptor = await authorize(req, res);
      if (!descriptor) return;
      const artifact = await readMimicArtifact(descriptor);
      if (!artifact) {
        res.status(404).json({ error: "Not cached" });
        return;
      }
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Mimic-Sha256", artifact.sha256);
      res.send(artifact.body);
    } catch (error) {
      console.warn(`[MimicCache] read failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
  });

  router.put("/api/agent/mimic-cache", async (req: Request, res: Response) => {
    try {
      const body = await readBoundedBody(req, MIMIC_ARTIFACT_MAX_BYTES);
      if (!body) {
        if (!res.headersSent) res.status(413).json({ error: "Artifact too large" });
        return;
      }
      const bodySha256 = crypto.createHash("sha256").update(body).digest("hex");
      if (header(req.headers as HeaderSource, "x-mimic-sha256").toLowerCase() !== bodySha256) {
        res.status(400).json({ error: "Checksum mismatch" });
        return;
      }
      const descriptor = await authorize(req, res, bodySha256);
      if (!descriptor) return;
      const invalid = validateMimicArtifact(descriptor, body);
      if (invalid) {
        res.status(422).json({ error: "Artifact rejected", reason: invalid });
        return;
      }
      await writeMimicArtifact(descriptor, body);
      log(`[MimicCache] stored ${descriptor.kind} v${descriptor.version} ${descriptor.arch} ${descriptor.hack}`
        + (descriptor.kind === "kmod" ? ` kernel=${descriptor.kernelRelease}` : ` libc=${descriptor.libc}`)
        + ` size=${body.length}`);
      res.json({ ok: true, sha256: bodySha256 });
    } catch (error) {
      console.warn(`[MimicCache] write failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
  });
}
