import { Capacitor, registerPlugin } from "@capacitor/core";
import { App } from "@capacitor/app";
import { appIconKey } from "@shared/appIcons";

const AppIcon = registerPlugin<{ setIcon(options: { key: string }): Promise<{ applied: boolean }> }>("ForwardXAppIcon");

/** Serialize OS changes, coalesce stale requests, and only remember successful changes. */
export function createAppIconSynchronizer(write: (key: string) => Promise<{ applied: boolean }>, onError: (error: unknown) => void) {
  let applied = "";
  let revision = 0;
  let chain = Promise.resolve();
  return (key: string) => {
    const request = ++revision;
    chain = chain.then(async () => {
      if (request !== revision || key === applied) return;
      try {
        if ((await write(key)).applied) applied = key;
      } catch (error) {
        onError(error);
      }
    });
    return chain;
  };
}

const syncIcon = createAppIconSynchronizer(key => AppIcon.setIcon({ key }), error => {
  console.warn("[AppIcon] Theme icon update failed; will retry on next foreground", error);
});

export function watchMobileAppIcon(root: HTMLElement, doc: Document = document) {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable("ForwardXAppIcon")) return () => {};
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    if (disposed || doc.visibilityState === "hidden") return;
    timer = setTimeout(() => {
      if (disposed || doc.visibilityState === "hidden") return;
      void syncIcon(appIconKey(root.getAttribute("data-personalization-theme"), root.classList.contains("dark")));
    }, 300);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(root, { attributes: true, attributeFilter: ["class", "data-personalization-theme"] });
  doc.addEventListener("visibilitychange", schedule);
  const listener = App.addListener("appStateChange", ({ isActive }) => { if (isActive) schedule(); });
  void listener.catch(() => undefined);
  schedule();
  return () => {
    disposed = true;
    clearTimeout(timer);
    observer.disconnect();
    doc.removeEventListener("visibilitychange", schedule);
    void listener.then(handle => handle.remove()).catch(() => undefined);
  };
}
