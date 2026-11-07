import { PERSONALIZATION_THEME_PRESETS, type PersonalizationThemePresetId } from "./personalization";
import { themeHostCardExample, type ThemeViews } from "./themeViews";

export const THEME_API_VERSION = 1;
export const THEME_ARCHIVE_FORMATS = ["zip", "rar", "tar", "tar.gz", "tgz"] as const;
export const THEME_LIMITS = {
  archiveBytes: 30 * 1024 * 1024,
  expandedBytes: 60 * 1024 * 1024,
  fileBytes: 10 * 1024 * 1024,
  cssBytes: 128 * 1024,
  compiledCssBytes: 40 * 1024 * 1024,
  files: 64,
  installed: 12,
  registryBytes: 128 * 1024 * 1024,
} as const;

export type ThemeManifest = {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  base: PersonalizationThemePresetId;
  stylesheet: string;
  variables?: { light?: Record<string, string>; dark?: Record<string, string> };
  views?: ThemeViews;
};

export type ThemeSummary = {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  base: PersonalizationThemePresetId;
  builtin: boolean;
  revision: string;
};

export type ThemeDefinition = { manifest: ThemeManifest; css: string; revision: string };

export const BUILTIN_THEMES: ThemeSummary[] = PERSONALIZATION_THEME_PRESETS.map(preset => ({
  id: preset.id, name: preset.name, description: preset.description,
  base: preset.id, version: "1.0.0", author: "ForwardX", builtin: true, revision: "builtin-v1",
}));

/** Versioned public styling hooks; theme authors should prefer these to utility classes. */
export const THEME_PARTS = ["shell", "sidebar", "workspace", "header", "content", "card", "button", "input", "table", "dialog", "login", "login-header", "login-hero", "login-form", "login-before", "login-after", "login-footer", "hosts", "hosts-toolbar", "hosts-page", "hosts-intro", "hosts-summary", "hosts-groups", "hosts-list", "hosts-outro", "host-grid", "host-card", "host-actions", "theme-group", "theme-field", "theme-label", "theme-value", "theme-text"] as const;

export function themeTemplateFiles(base: PersonalizationThemePresetId = "teal") {
  const manifest: ThemeManifest = {
    apiVersion: 1, id: `my-${base}-theme`, name: "My ForwardX Theme", version: "1.0.0",
    description: "A custom workspace theme", author: "Your name", base, stylesheet: "theme.css",
    variables: {
      light: { "--radius": "0.75rem", "--background": "#f0f6f5", "--card": "#ffffff", "--foreground": "#172a28", "--pearl-surface": "#ffffff", "--pearl-glass": "#ffffffee" },
      dark: { "--background": "#101f20", "--card": "#182b2c", "--foreground": "#e2f3ef", "--pearl-surface": "#182b2c", "--pearl-glass": "#182b2cee" },
    },
    views: {
      shell: { navigation: "left", contentWidth: 1600, spacing: "comfortable" },
      login: { layout: "split", heroTitle: { "zh-CN": "连接你的每一个节点", en: "Connect every node" } },
      hosts: { cardLayout: "grid", columns: { mobile: 1, tablet: 2, desktop: 3 }, gap: 16, card: themeHostCardExample() },
    },
  };
  return {
    "theme.json": JSON.stringify(manifest, null, 2),
    "theme.css": `/* ForwardX Theme API v1. Light/dark mode follows the panel. */
[data-theme-part="card"] { border-radius: var(--radius); box-shadow: 0 6px 24px #0000000a; }
[data-theme-part="header"] { backdrop-filter: blur(16px); }
[data-theme-part="button"] { border-radius: 0.6rem; }
[data-theme-part="sidebar"] { --sidebar-accent: color-mix(in srgb, var(--primary) 12%, var(--sidebar)); }
[data-theme-host-card="true"] { border-radius: 1rem; }
[data-theme-node="host-body"] [data-theme-field="host.name"] { letter-spacing: -0.025em; }
@media (min-width: 1024px) {
  [data-theme-part="content"] { max-width: 1600px; width: 100%; margin-inline: auto; }
}
/* Add local assets with url("assets/background.webp"). No remote URLs or JS. */
`,
    "README.md": "Edit theme.json (views: layouts, login copy, host field bindings) and theme.css, archive these files with theme.json at the root, then upload in Settings > Personalization > Theme management. Remove views to keep the original layouts. Change id for a new theme; keep id and enable replace to upgrade. Developer documentation: /guide/themes\n",
  };
}
