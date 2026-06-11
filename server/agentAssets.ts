import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AGENT_VERSION, APP_VERSION } from "../shared/versions";

export const AGENT_ASSET_NAMES = [
  "forwardx-agent-linux-amd64",
  "forwardx-agent-linux-arm64",
  "forwardx-fxp-linux-amd64",
  "forwardx-fxp-linux-arm64",
] as const;

export const AGENT_ASSET_NAME_SET = new Set<string>(AGENT_ASSET_NAMES);

const serverDir = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

function normalizeVersion(version: string | null | undefined) {
  return String(version || "").trim().replace(/^v/i, "");
}

function isSemver(version: string) {
  return /^\d+\.\d+\.\d+$/.test(version);
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
      if (stat.isFile() && stat.size > 0) return candidate;
    } catch {
      // Try next bundled asset location.
    }
  }
  return null;
}

export function getMissingBundledAgentAssets(version = APP_VERSION) {
  const normalized = normalizeVersion(version);
  return AGENT_ASSET_NAMES.filter((asset) => !getBundledAgentAssetPath(normalized, asset));
}
