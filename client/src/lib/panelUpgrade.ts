import {
  applyGithubAccelerator,
  panelUpdateGithubAccelerator,
  type GithubAcceleratorSettings,
} from "@shared/githubAccelerator";

export const PANEL_UPGRADE_REFRESH_DELAY_SECONDS = 8;
export const PANEL_UPGRADE_REFRESH_DELAY_MS = PANEL_UPGRADE_REFRESH_DELAY_SECONDS * 1000;

export const PANEL_UPGRADE_REFRESH_KEY = "forwardx.panel.upgradeRefresh";
export type PanelUpgradeRefresh = { jobKey: string; deadline: number; completed?: boolean };

export function readPanelUpgradeRefresh(storage: Pick<Storage, "getItem">): PanelUpgradeRefresh | null {
  try {
    const value = JSON.parse(storage.getItem(PANEL_UPGRADE_REFRESH_KEY) || "null");
    if (!value || typeof value.jobKey !== "string" || !value.jobKey || !Number.isFinite(value.deadline) || value.deadline <= 0) return null;
    return { jobKey: value.jobKey, deadline: value.deadline, completed: value.completed === true };
  } catch {
    return null;
  }
}

// Timers can be throttled in hidden tabs. Always derive the countdown from wall time,
// and expose check() so focus/pageshow/visibility events can catch up after a freeze.
export function startPanelUpgradeRefresh(
  deadline: number,
  options: {
    now: () => number;
    timers: Pick<Window, "setInterval" | "clearInterval" | "setTimeout" | "clearTimeout">;
    onCountdown: (seconds: number) => void;
    onRefresh: () => void;
  },
) {
  let stopped = false;
  let interval: number | undefined;
  let timeout: number | undefined;
  const dispose = () => {
    stopped = true;
    if (interval !== undefined) options.timers.clearInterval(interval);
    if (timeout !== undefined) options.timers.clearTimeout(timeout);
  };
  const check = () => {
    if (stopped) return;
    const remaining = Math.max(0, Math.ceil((deadline - options.now()) / 1000));
    options.onCountdown(remaining);
    if (remaining === 0) {
      dispose();
      options.onRefresh();
    }
  };
  interval = options.timers.setInterval(check, 1000);
  timeout = options.timers.setTimeout(check, Math.max(0, deadline - options.now()));
  check();
  return { check, dispose };
}

const PANEL_RELEASES_URL = "https://github.com/poouo/Forwardx/releases";

export function getPanelChangelogUrl(
  version?: string | null,
  releaseUrl?: string | null,
  githubAccelerator?: GithubAcceleratorSettings | null,
) {
  const accelerator = panelUpdateGithubAccelerator(githubAccelerator);
  if (releaseUrl) return applyGithubAccelerator(releaseUrl, accelerator);
  const normalizedVersion = String(version || "").trim();
  if (!normalizedVersion) return applyGithubAccelerator(PANEL_RELEASES_URL, accelerator);
  const tag = normalizedVersion.startsWith("v") ? normalizedVersion : `v${normalizedVersion}`;
  return applyGithubAccelerator(`${PANEL_RELEASES_URL}/tag/${encodeURIComponent(tag)}`, accelerator);
}
