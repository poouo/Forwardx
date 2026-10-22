import { siteBrandingScope } from "./siteBranding";
import { resolveClientRoute } from "@shared/clientRoutes";

export type SidebarPresentationGroup = { label: string; items: { path: string; label: string }[] };
const PREFIX = "forwardx.sidebar.presentation.v1:";
const MAX_AGE = 8 * 60 * 60_000;

function normalize(groups: unknown): SidebarPresentationGroup[] {
  if (!Array.isArray(groups) || groups.length > 8) return [];
  return groups.flatMap(group => {
    if (!group || typeof group.label !== "string" || !Array.isArray(group.items) || group.items.length > 100) return [];
    const items = group.items.flatMap((item: any) => {
      if (!item || typeof item.path !== "string" || typeof item.label !== "string" || item.path.length > 256) return [];
      const route = resolveClientRoute(item.path);
      if (!route?.dashboard || /[?#]/.test(item.path)) return [];
      // Only display labels and internal paths: no URLs, identity, counters or permissions.
      return [{ path: item.path, label: item.label.slice(0, 160) }];
    });
    return items.length ? [{ label: group.label.slice(0, 80), items }] : [];
  });
}

/** Tab- and panel-local visual continuity only. Never use this cache for access checks. */
export function readSidebarPresentation(owner?: string, scope = siteBrandingScope(), now = Date.now()): SidebarPresentationGroup[] {
  if (!scope) return [];
  try {
    const raw = window.sessionStorage.getItem(PREFIX + scope);
    if (!raw || raw.length > 50_000) return [];
    const saved = JSON.parse(raw);
    if (saved.version !== 1 || saved.scope !== scope || !Number.isFinite(saved.at) || saved.at > now || now - saved.at > MAX_AGE || (owner !== undefined && saved.owner !== owner)) return [];
    return normalize(saved.groups);
  } catch { return []; }
}

export function saveSidebarPresentation(owner: string, groups: SidebarPresentationGroup[], scope = siteBrandingScope(), now = Date.now()) {
  if (!scope || !owner) return;
  try {
    window.sessionStorage.setItem(PREFIX + scope, JSON.stringify({ version: 1, scope, owner, at: now, groups: normalize(groups) }));
  } catch { /* Storage denial must not prevent navigation. */ }
}

export function clearSidebarPresentation(scope = siteBrandingScope()) {
  if (scope) try { window.sessionStorage.removeItem(PREFIX + scope); } catch { /* Best effort. */ }
}
