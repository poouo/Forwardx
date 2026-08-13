export type GithubAcceleratorConfig = {
  enabled?: boolean;
  url?: string | null;
};

export type GithubAcceleratorSettings = GithubAcceleratorConfig & {
  panelUpdateEnabled?: boolean;
};

export type EffectiveGithubAccelerator = {
  enabled: boolean;
  url: string;
};

export type PanelInstallerDeployment = "local" | "docker";
export type PanelInstallerAction = "install" | "upgrade" | "uninstall";

export const PANEL_INSTALLER_RAW_URLS: Record<PanelInstallerDeployment, string> = {
  local: "https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh",
  docker: "https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh",
};

export function normalizeGithubAcceleratorUrl(value: unknown) {
  const url = String(value || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return "";
  try {
    const parsed = new URL(url);
    if (parsed.search || parsed.hash) return "";
    return url;
  } catch {
    return "";
  }
}

export function isGithubDownloadUrl(value: unknown) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    return hostname === "github.com"
      || hostname.endsWith(".github.com")
      || hostname === "raw.githubusercontent.com"
      || hostname.endsWith(".githubusercontent.com");
  } catch {
    return false;
  }
}

export function effectiveGithubAccelerator(config?: GithubAcceleratorConfig | null): EffectiveGithubAccelerator {
  const url = normalizeGithubAcceleratorUrl(config?.url);
  return { enabled: !!config?.enabled && !!url, url };
}

export function panelUpdateGithubAccelerator(settings?: GithubAcceleratorSettings | null) {
  return effectiveGithubAccelerator({
    enabled: !!settings?.enabled && !!settings?.panelUpdateEnabled,
    url: settings?.url,
  });
}

export function applyGithubAccelerator(value: string, config?: GithubAcceleratorConfig | null) {
  const sourceUrl = String(value || "").trim();
  const accelerator = effectiveGithubAccelerator(config);
  if (!accelerator.enabled || !isGithubDownloadUrl(sourceUrl)) return sourceUrl;
  if (sourceUrl === accelerator.url || sourceUrl.startsWith(`${accelerator.url}/`)) return sourceUrl;
  return `${accelerator.url}/${sourceUrl}`;
}

export function githubDownloadCandidates(value: string, config?: GithubAcceleratorConfig | null) {
  const sourceUrl = String(value || "").trim();
  const acceleratedUrl = applyGithubAccelerator(sourceUrl, config);
  return acceleratedUrl && acceleratedUrl !== sourceUrl
    ? [acceleratedUrl, sourceUrl]
    : [sourceUrl];
}

export function shellSingleQuote(value: unknown) {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

export function buildPanelInstallerCommand(options: {
  deployment: PanelInstallerDeployment;
  action: PanelInstallerAction;
  accelerator?: GithubAcceleratorConfig | null;
  sudo?: boolean;
}) {
  const accelerator = effectiveGithubAccelerator(options.accelerator);
  const rawUrl = PANEL_INSTALLER_RAW_URLS[options.deployment];
  const scriptUrl = applyGithubAccelerator(rawUrl, accelerator);
  const runner = options.sudo === false ? "bash" : "sudo bash";
  const acceleratorArg = accelerator.enabled
    ? ` --github-accelerator ${shellSingleQuote(accelerator.url)}`
    : "";
  return `curl -fsSL ${shellSingleQuote(scriptUrl)} | ${runner} -s -- ${options.action}${acceleratorArg}`;
}
