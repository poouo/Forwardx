import { applyPersonalizationTheme, clearPersonalizationTheme } from "./personalizationTheme";
import type { ThemeDefinition } from "@shared/themes";

const appliedVariables = new WeakMap<HTMLElement, Set<string>>();
const STYLE_ID = "forwardx-custom-theme";
const SAFE_MODE_KEY = "forwardx.theme.safeMode";

export function isThemeSafeMode() {
  if (typeof window === "undefined") return false;
  const requested = new URLSearchParams(window.location.search).get("themeSafe");
  try {
    if (requested === "1") window.sessionStorage.setItem(SAFE_MODE_KEY, "1");
    if (requested === "0") window.sessionStorage.removeItem(SAFE_MODE_KEY);
    return requested === "1" || window.sessionStorage.getItem(SAFE_MODE_KEY) === "1";
  } catch { return requested === "1"; }
}

export function leaveThemeSafeMode() {
  try { window.sessionStorage.removeItem(SAFE_MODE_KEY); } catch { /* Storage can be disabled. */ }
  const url = new URL(window.location.href);
  url.searchParams.delete("themeSafe");
  window.history.replaceState(window.history.state, "", url);
}

export function clearManagedTheme(root: HTMLElement = document.documentElement) {
  for (const name of appliedVariables.get(root) || []) root.style.removeProperty(name);
  appliedVariables.delete(root);
  root.ownerDocument.getElementById(STYLE_ID)?.remove();
  root.removeAttribute("data-forwardx-theme");
  root.removeAttribute("data-theme-api");
  for (const attribute of ["data-theme-navigation", "data-theme-spacing", "data-theme-content-width"]) root.removeAttribute(attribute);
  clearPersonalizationTheme(root);
}

export function applyManagedTheme(base: unknown, definition?: ThemeDefinition | null, root: HTMLElement = document.documentElement) {
  clearManagedTheme(root);
  const builtin = applyPersonalizationTheme(base, root);
  root.setAttribute("data-forwardx-theme", definition?.manifest.id || builtin);
  root.setAttribute("data-theme-api", "1");
  if (!definition) return;
  const modes = definition.manifest.variables;
  const values = { ...modes?.light, ...(root.classList.contains("dark") ? modes?.dark : {}) };
  const shell = definition.manifest.views?.shell;
  if (shell) {
    root.setAttribute("data-theme-navigation", shell.navigation || "left");
    root.setAttribute("data-theme-spacing", shell.spacing || "comfortable");
    if (shell.contentWidth) {
      values["--theme-content-width"] = `${shell.contentWidth}px`;
      root.setAttribute("data-theme-content-width", "true");
    }
    if (shell.sidebarWidth) values["--theme-sidebar-width"] = `${shell.sidebarWidth}px`;
  }
  const names = new Set<string>();
  for (const [name, value] of Object.entries(values)) {
    root.style.setProperty(name, value);
    names.add(name);
    // Tailwind's color aliases are also set by the built-in palette.
    if (!name.startsWith("--color-") && !name.startsWith("--pearl-") && !name.startsWith("--font-") && name !== "--radius") {
      const alias = `--color-${name.slice(2)}`;
      if (!(alias in values)) { root.style.setProperty(alias, value); names.add(alias); }
    }
  }
  appliedVariables.set(root, names);
  const style = root.ownerDocument.createElement("style");
  style.id = STYLE_ID;
  style.textContent = definition.css;
  root.ownerDocument.head.appendChild(style);
}
