import { IMPERSONATION_EXPIRED, IMPERSONATION_PREFIX } from "@shared/userImpersonation";

const STORAGE_KEY = "forwardx.user-entry";
const WINDOW_NAME = "forwardx-user-entry";
type EntryState = { mode: "normal" | "active" | "ended"; expiresAt: number };
type EntryWindow = Pick<Window, "location" | "history" | "name"> & { sessionStorage: Pick<Storage, "getItem" | "setItem"> };

export function createImpersonationWindow(browser: EntryWindow) {
  let state: EntryState = { mode: "normal", expiresAt: 0 };
  let token = "";
  const listeners = new Set<() => void>();
  const publish = (next: EntryState) => { state = next; listeners.forEach(fn => fn()); };
  const finish = () => {
    if (state.mode === "normal") return;
    token = "";
    try { browser.sessionStorage.setItem(STORAGE_KEY, "ended"); } catch { /* window.name also prevents Cookie fallback after reload. */ }
    publish({ mode: "ended", expiresAt: 0 });
  };
  return {
    initialize() {
      const params = new URLSearchParams(browser.location.hash.slice(1));
      const incoming = params.get("user-session");
      let saved: string | null = null;
      try { saved = browser.sessionStorage.getItem(STORAGE_KEY); } catch { /* Fail closed for entry windows below. */ }
      if (incoming === null && saved === null && browser.name !== WINDOW_NAME) return;
      browser.name = WINDOW_NAME;
      publish({ mode: "ended", expiresAt: 0 });
      // Remove the credential before any rendering/network request.
      if (incoming !== null) {
        params.delete("user-session");
        browser.history.replaceState(browser.history.state, "", browser.location.pathname + browser.location.search + (params.size ? `#${params}` : ""));
      }
      const value = incoming ?? saved ?? "";
      try {
        if (!value.startsWith(IMPERSONATION_PREFIX) || value.length > 4096) throw new Error();
        const payload = value.slice(IMPERSONATION_PREFIX.length).split(".")[1];
        const expiresAt = Number(JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))).exp) * 1000;
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error();
        browser.sessionStorage.setItem(STORAGE_KEY, value);
        token = value;
        publish({ mode: "active", expiresAt });
      } catch { finish(); }
    },
    getState: () => state,
    isEntry: () => state.mode !== "normal",
    finish,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    wrapFetch(original: typeof fetch): typeof fetch {
      return (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, browser.location.href);
        if (state.mode === "normal" || url.origin !== browser.location.origin || !url.pathname.startsWith("/api/")) return original(input, init);
        if (state.mode !== "active" || state.expiresAt <= Date.now()) {
          finish();
          return Promise.reject(new Error(IMPERSONATION_EXPIRED));
        }
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        headers.set("Authorization", `Bearer ${token}`);
        return original(input, { ...init, headers, credentials: "omit" });
      };
    },
  };
}

export const userEntry = createImpersonationWindow(typeof window === "undefined" ? {} as Window : window);

/** Open synchronously in the click handler, before the asynchronous token request. */
export async function openUserBackend(issue: () => Promise<{ token: string }>) {
  const popup = window.open("about:blank", "_blank");
  if (!popup) throw new Error("请允许浏览器弹出新窗口后重试");
  try {
    popup.opener = null;
    popup.name = WINDOW_NAME;
    const result = await issue();
    if (!popup.closed) popup.location.replace(`${window.location.origin}/#user-session=${encodeURIComponent(result.token)}`);
  } catch (error) { popup.close(); throw error; }
}
