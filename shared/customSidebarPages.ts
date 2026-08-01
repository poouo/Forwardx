export const MAX_CUSTOM_SIDEBAR_PAGES = 20;
export const MAX_CUSTOM_SIDEBAR_ICON_BYTES = 24 * 1024;
export const MAX_CUSTOM_SIDEBAR_ICON_DATA_URL_LENGTH = 40 * 1024;

export const CUSTOM_SIDEBAR_VISIBILITIES = ["all", "admin"] as const;
export type CustomSidebarVisibility = typeof CUSTOM_SIDEBAR_VISIBILITIES[number];
export const CUSTOM_SIDEBAR_OPEN_MODES = ["embed", "external"] as const;
export type CustomSidebarOpenMode = typeof CUSTOM_SIDEBAR_OPEN_MODES[number];

export type CustomSidebarPage = {
  id: string;
  name: string;
  url: string;
  visibility: CustomSidebarVisibility;
  /** Whether the panel should render the URL in an iframe or open it in a new tab. */
  openMode: CustomSidebarOpenMode;
  iconDataUrl?: string;
};

const CUSTOM_PAGE_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,95}$/i;
const SVG_DATA_URL_RE = /^data:image\/svg\+xml;base64,([a-z0-9+/=]+)$/i;

/**
 * Normalize a custom menu URL while keeping panel-relative paths usable.
 * Bare host names are treated as HTTPS URLs so they do not become relative
 * links when used as an iframe source.
 */
export function normalizeCustomSidebarUrl(value: unknown) {
  const text = String(value || "").trim();
  if (!text || text.length > 1000 || /[\u0000-\u001f\u007f]/.test(text)) return "";
  if (text.startsWith("/") && !text.startsWith("//")) {
    try {
      const parsed = new URL(text, "https://forwardx.invalid");
      return parsed.origin === "https://forwardx.invalid" ? text : "";
    } catch {
      return "";
    }
  }
  const candidate = text.startsWith("//")
    ? `https:${text}`
    : /^[a-z][a-z\d+.-]*:\/\//i.test(text)
      ? text
      : `https://${text}`;
  try {
    const url = new URL(candidate);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return "";
    return candidate;
  } catch {
    return "";
  }
}

export function isValidCustomSidebarUrl(value: unknown): value is string {
  return !!normalizeCustomSidebarUrl(value);
}

export function decodeCustomSidebarIconDataUrl(value: unknown) {
  const text = String(value || "").trim();
  if (!text || text.length > MAX_CUSTOM_SIDEBAR_ICON_DATA_URL_LENGTH) return "";
  const match = text.match(SVG_DATA_URL_RE);
  if (!match) return "";
  try {
    const binary = globalThis.atob(match[1]);
    if (binary.length > MAX_CUSTOM_SIDEBAR_ICON_BYTES) return "";
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "";
  }
}

export function isSafeCustomSidebarSvg(value: unknown) {
  const svg = String(value || "").trim();
  if (!svg || new TextEncoder().encode(svg).byteLength > MAX_CUSTOM_SIDEBAR_ICON_BYTES) return false;
  const withoutDeclaration = svg.replace(/^<\?xml[\s\S]*?\?>\s*/i, "");
  if (!/^<svg\b/i.test(withoutDeclaration) || !/<\/svg>\s*$/i.test(withoutDeclaration)) return false;
  if (/<\s*(?:script|foreignObject|iframe|object|embed|image|use|style|audio|video|animate|animateMotion|animateTransform|set)\b/i.test(svg)) return false;
  if (/<\s*!(?:doctype|entity)\b/i.test(svg) || /@import\b/i.test(svg)) return false;
  if (/\bon[a-z]+\s*=/i.test(svg) || /(?:javascript|vbscript)\s*:/i.test(svg)) return false;

  for (const match of svg.matchAll(/\b(?:href|xlink:href)\s*=\s*(["'])(.*?)\1/gi)) {
    if (!match[2].trim().startsWith("#")) return false;
  }
  for (const match of svg.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    if (!match[2].trim().startsWith("#")) return false;
  }
  return true;
}

export function isSafeCustomSidebarIconDataUrl(value: unknown) {
  const svg = decodeCustomSidebarIconDataUrl(value);
  return !!svg && isSafeCustomSidebarSvg(svg);
}

export function normalizeCustomSidebarPages(value: unknown): CustomSidebarPage[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const pages: CustomSidebarPage[] = [];
  for (const item of value.slice(0, MAX_CUSTOM_SIDEBAR_PAGES)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const source = item as Record<string, unknown>;
    const id = String(source.id || "").trim().slice(0, 96);
    const name = String(source.name || "").trim().slice(0, 64);
    const url = normalizeCustomSidebarUrl(String(source.url || "").slice(0, 1000));
    if (!CUSTOM_PAGE_ID_RE.test(id) || seen.has(id) || !name || !isValidCustomSidebarUrl(url)) continue;
    seen.add(id);
    const iconDataUrl = isSafeCustomSidebarIconDataUrl(source.iconDataUrl)
      ? String(source.iconDataUrl).trim()
      : undefined;
    pages.push({
      id,
      name,
      url,
      visibility: source.visibility === "all" ? "all" : "admin",
      openMode: source.openMode === "external" ? "external" : "embed",
      ...(iconDataUrl ? { iconDataUrl } : {}),
    });
  }
  return pages;
}

export function visibleCustomSidebarPages(value: unknown, role: string | null | undefined) {
  const pages = normalizeCustomSidebarPages(value);
  return role === "admin" ? pages : pages.filter((page) => page.visibility === "all");
}
