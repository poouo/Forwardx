import { Preferences } from "@capacitor/preferences";

const PANEL_URL_KEY = "forwardx.mobile.panelUrl";
const USERNAME_KEY = "forwardx.mobile.username";
const PASSWORD_KEY = "forwardx.mobile.password";
const TOKEN_KEY = "forwardx.mobile.token";
const LOGGED_OUT_KEY = "forwardx.mobile.loggedOut";

const PERSISTED_KEYS = [PANEL_URL_KEY, USERNAME_KEY, PASSWORD_KEY, TOKEN_KEY, LOGGED_OUT_KEY];

function isCapacitorRuntime() {
  if (typeof window === "undefined") return false;
  const capacitor = (window as any).Capacitor;
  return !!capacitor?.isNativePlatform?.();
}

function getNativePlatform() {
  if (!isCapacitorRuntime() || typeof window === "undefined") return "web";
  const platform = String((window as any).Capacitor?.getPlatform?.() || "").toLowerCase();
  if (platform === "android" || platform === "ios") return platform;
  return "native";
}

function getLocalValue(key: string) {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(key) || "";
}

function setLocalValue(key: string, value?: string | null) {
  if (typeof window === "undefined") return;
  if (value) window.localStorage.setItem(key, value);
  else window.localStorage.removeItem(key);
}

function persistNative(key: string, value?: string | null) {
  if (!isCapacitorRuntime()) return;
  const action = value ? Preferences.set({ key, value }) : Preferences.remove({ key });
  action.catch(() => undefined);
}

function setValue(key: string, value?: string | null) {
  setLocalValue(key, value);
  persistNative(key, value);
}

function normalizePanelUrl(url: string) {
  return url.trim().replace(/\/+$/, "");
}

function isValidPanelUrl(url: string) {
  const normalized = normalizePanelUrl(url);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export const mobileAuth = {
  get isNative() {
    return isCapacitorRuntime();
  },

  get platform() {
    return getNativePlatform();
  },

  normalizePanelUrl,

  isValidPanelUrl,

  async hydrateNative() {
    if (!isCapacitorRuntime() || typeof window === "undefined") return;
    await Promise.all(
      PERSISTED_KEYS.map(async (key) => {
        const { value } = await Preferences.get({ key });
        setLocalValue(key, value);
      }),
    );
  },

  getPanelUrl() {
    return getLocalValue(PANEL_URL_KEY);
  },

  hasPanelUrl() {
    return isValidPanelUrl(getLocalValue(PANEL_URL_KEY));
  },

  setPanelUrl(url: string) {
    const normalized = normalizePanelUrl(url);
    setValue(PANEL_URL_KEY, normalized);
  },

  getUsername() {
    return getLocalValue(USERNAME_KEY);
  },

  getPassword() {
    return getLocalValue(PASSWORD_KEY);
  },

  setCredentials(username: string, password: string) {
    setValue(USERNAME_KEY, username.trim());
    setValue(PASSWORD_KEY, password);
    setValue(LOGGED_OUT_KEY, "");
  },

  getToken() {
    return getLocalValue(TOKEN_KEY);
  },

  setToken(token?: string | null) {
    setValue(TOKEN_KEY, token || "");
    if (token) setValue(LOGGED_OUT_KEY, "");
  },

  clear() {
    setValue(TOKEN_KEY, "");
    setValue(LOGGED_OUT_KEY, "1");
  },

  wasLoggedOut() {
    return getLocalValue(LOGGED_OUT_KEY) === "1";
  },

  trpcUrl() {
    if (!isCapacitorRuntime()) return "/api/trpc";
    const panelUrl = mobileAuth.getPanelUrl();
    return isValidPanelUrl(panelUrl) ? `${normalizePanelUrl(panelUrl)}/api/trpc` : "/api/trpc";
  },
};
