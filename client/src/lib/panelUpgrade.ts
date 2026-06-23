export const PANEL_UPGRADE_REFRESH_DELAY_SECONDS = 8;
export const PANEL_UPGRADE_REFRESH_DELAY_MS = PANEL_UPGRADE_REFRESH_DELAY_SECONDS * 1000;

const PANEL_RELEASES_URL = "https://github.com/poouo/Forwardx/releases";

export function getPanelChangelogUrl(version?: string | null, releaseUrl?: string | null) {
  if (releaseUrl) return releaseUrl;
  const normalizedVersion = String(version || "").trim();
  if (!normalizedVersion) return PANEL_RELEASES_URL;
  const tag = normalizedVersion.startsWith("v") ? normalizedVersion : `v${normalizedVersion}`;
  return `${PANEL_RELEASES_URL}/tag/${encodeURIComponent(tag)}`;
}
