export type HostAgentPanelUrl = {
  agentPanelUrlEnabled?: boolean | number | string | null;
  agentPanelUrl?: string | null;
};

/** Agent-only origin/base URL. Never accept credentials or URL query secrets. */
export function normalizeAgentPanelUrl(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 2048 || /[\s\\"'`$?#]/.test(raw)) return "";
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) return "";
    return url.toString().replace(/\/+$/, "");
  } catch { return ""; }
}

export function hostAgentPanelUrlOverride(host?: HostAgentPanelUrl | null): string {
  const enabled = host?.agentPanelUrlEnabled;
  if (enabled !== true && enabled !== 1 && enabled !== "1" && enabled !== "true") return "";
  return normalizeAgentPanelUrl(host?.agentPanelUrl);
}
