import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { AGENT_VERSION, APP_VERSION } from "../shared/versions";

const REPO_URL = "https://github.com/poouo/Forwardx";
const MAX_AGENT_ASSET_BYTES = 80 * 1024 * 1024;
const fetchLocks = new Map<string, Promise<string | null>>();

export const AGENT_ASSET_NAMES = [
  "forwardx-agent-linux-amd64",
  "forwardx-agent-linux-arm64",
  "forwardx-fxp-linux-amd64",
  "forwardx-fxp-linux-arm64",
  "forwardx-runtime-linux-amd64",
  "forwardx-runtime-linux-arm64",
] as const;

export const AGENT_ASSET_NAME_SET = new Set<string>(AGENT_ASSET_NAMES);

const serverDir = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

function hasElfMagic(buffer: Uint8Array) {
  return buffer.length >= 4
    && buffer[0] === 0x7f
    && buffer[1] === 0x45
    && buffer[2] === 0x4c
    && buffer[3] === 0x46;
}

function isBundledElfAsset(filePath: string) {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    return bytesRead === header.length && hasElfMagic(header);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors while rejecting an invalid asset.
      }
    }
  }
}

async function isCachedElfAsset(filePath: string) {
  let file: fsp.FileHandle | undefined;
  try {
    file = await fsp.open(filePath, "r");
    const header = Buffer.alloc(4);
    const result = await file.read(header, 0, header.length, 0);
    return result.bytesRead === header.length && hasElfMagic(header);
  } catch {
    return false;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function normalizeVersion(version: string | null | undefined) {
  return String(version || "").trim().replace(/^v/i, "");
}

function isSemver(version: string) {
  return /^\d+\.\d+\.\d+$/.test(version);
}

function githubAssetUrl(version: string, asset: string) {
  return `${REPO_URL}/releases/download/v${normalizeVersion(version)}/${encodeURIComponent(asset)}`;
}

function agentAssetCachePath(version: string, asset: string) {
  return path.resolve(process.cwd(), "data", "agent-assets", `v${normalizeVersion(version)}`, asset);
}

function getAgentAssetReleaseCandidates(version: string) {
  const normalized = normalizeVersion(version);
  const agentVersion = normalizeVersion(AGENT_VERSION);
  const appVersion = normalizeVersion(APP_VERSION);
  const candidates = [normalized];
  if ((normalized === agentVersion || normalized === appVersion) && appVersion !== normalized) {
    candidates.unshift(appVersion);
  }
  if ((normalized === agentVersion || normalized === appVersion) && agentVersion !== normalized) {
    candidates.push(agentVersion);
  }
  return Array.from(new Set(candidates.filter(isSemver)));
}

function getAgentAssetCandidates(version: string, asset: string) {
  const normalized = normalizeVersion(version);
  const agentVersion = normalizeVersion(AGENT_VERSION);
  const appVersion = normalizeVersion(APP_VERSION);
  const includeVersionless = normalized === agentVersion || normalized === appVersion;
  const versionDirs = [`v${normalized}`, normalized];
  if (normalized === agentVersion && appVersion !== agentVersion) {
    versionDirs.push(`v${appVersion}`, appVersion);
  } else if (normalized === appVersion && appVersion !== agentVersion) {
    versionDirs.push(`v${agentVersion}`, agentVersion);
  }
  const assetRoots = [
    path.resolve(process.cwd(), "dist", "agent"),
    path.resolve(process.cwd(), "data", "agent-assets"),
    path.resolve(process.cwd(), "agent-assets"),
    path.resolve(serverDir, "agent"),
    path.resolve(serverDir, "agent-assets"),
    path.resolve(serverDir, "..", "dist", "agent"),
    path.resolve(serverDir, "..", "agent-assets"),
  ];

  const candidates: string[] = [];
  for (const root of assetRoots) {
    if (includeVersionless) candidates.push(path.resolve(root, asset));
    for (const versionDir of versionDirs) {
      candidates.push(path.resolve(root, versionDir, asset));
    }
  }
  return Array.from(new Set(candidates));
}

export function getBundledAgentAssetPath(version: string, asset: string) {
  const normalized = normalizeVersion(version);
  if (!isSemver(normalized) || !AGENT_ASSET_NAME_SET.has(asset)) return null;

  for (const candidate of getAgentAssetCandidates(normalized, asset)) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && stat.size > 0 && isBundledElfAsset(candidate)) return candidate;
    } catch {
      // Try next bundled asset location.
    }
  }
  return null;
}

async function downloadAgentAssetToCache(version: string, asset: string) {
  const normalized = normalizeVersion(version);
  if (!isSemver(normalized) || !AGENT_ASSET_NAME_SET.has(asset)) return null;

  for (const releaseVersion of getAgentAssetReleaseCandidates(normalized)) {
    const cachePath = agentAssetCachePath(releaseVersion, asset);
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      const res = await fetch(githubAssetUrl(releaseVersion, asset), {
        cache: "no-store",
        redirect: "follow",
        headers: {
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          "User-Agent": `ForwardX/${APP_VERSION}`,
        },
      });
      if (!res.ok || !res.body) {
        console.warn(`[AgentAssets] Release asset unavailable ${asset} v${releaseVersion}: ${res.status} ${res.statusText}`);
        continue;
      }

      const contentLength = Number(res.headers.get("content-length") || 0);
      if (contentLength > MAX_AGENT_ASSET_BYTES) {
        console.warn(`[AgentAssets] Release asset too large ${asset} v${releaseVersion}: ${contentLength}`);
        continue;
      }

      const file = await fsp.open(tmpPath, "w");
      let written = 0;
      try {
        for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
          written += chunk.length;
          if (written > MAX_AGENT_ASSET_BYTES) throw new Error("Agent asset is too large");
          await file.write(chunk);
        }
      } finally {
        await file.close();
      }
      if (written <= 0) continue;
      if (!(await isCachedElfAsset(tmpPath))) {
        console.warn(`[AgentAssets] Downloaded asset is not an ELF binary ${asset} v${releaseVersion}`);
        continue;
      }
      await fsp.chmod(tmpPath, 0o755).catch(() => undefined);
      await fsp.rename(tmpPath, cachePath);
      return cachePath;
    } catch (error) {
      console.warn(`[AgentAssets] Failed to cache ${asset} v${releaseVersion}:`, error);
    } finally {
      await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }
  return null;
}

export async function getOrFetchAgentAssetPath(version: string, asset: string) {
  const bundled = getBundledAgentAssetPath(version, asset);
  if (bundled) return bundled;

  const normalized = normalizeVersion(version);
  if (!isSemver(normalized) || !AGENT_ASSET_NAME_SET.has(asset)) return null;

  const key = `${normalized}:${asset}`;
  let lock = fetchLocks.get(key);
  if (!lock) {
    lock = downloadAgentAssetToCache(normalized, asset).finally(() => fetchLocks.delete(key));
    fetchLocks.set(key, lock);
  }
  return await lock;
}

export function getMissingBundledAgentAssets(version = APP_VERSION) {
  const normalized = normalizeVersion(version);
  return AGENT_ASSET_NAMES.filter((asset) => !getBundledAgentAssetPath(normalized, asset));
}
