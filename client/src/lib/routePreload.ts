import { createElement, useEffect, useState, type ComponentType } from "react";

type PageModule = { default: ComponentType<any> };
type PageLoader = () => Promise<PageModule>;
type PreloadablePage = ComponentType<any> & { preload: () => Promise<void> };

function createPreloadablePage(loader: PageLoader): PreloadablePage {
  let cached: PageModule | null = null;
  let pending: Promise<PageModule> | null = null;

  const load = () => {
    if (cached) return Promise.resolve(cached);
    if (!pending) {
      pending = loader().then((module) => {
        cached = module;
        return module;
      }).catch((error) => {
        pending = null;
        throw error;
      });
    }
    return pending;
  };

  const Page = (props: any) => {
    const [module, setModule] = useState<PageModule | null>(() => cached);

    useEffect(() => {
      if (module || cached) return;
      let mounted = true;
      load().then((nextModule) => {
        if (mounted) setModule(nextModule);
      }).catch(() => {
        // Let the surrounding ErrorBoundary handle the retry/render error.
      });
      return () => {
        mounted = false;
      };
    }, [module]);

    const resolved = module || cached;
    if (!resolved) throw load();
    return createElement(resolved.default, props);
  };

  Page.preload = () => load().then(() => undefined);
  return Page;
}

export const HomePage = createPreloadablePage(() => import("@/pages/Home"));
export const HostsPage = createPreloadablePage(() => import("@/pages/Hosts"));
export const RulesPage = createPreloadablePage(() => import("@/pages/Rules"));
export const ForwardGroupsPage = createPreloadablePage(() => import("@/pages/ForwardGroups"));
export const TunnelsPage = createPreloadablePage(() => import("@/pages/Tunnels"));
export const UsersPage = createPreloadablePage(() => import("@/pages/Users"));
export const ProfilePage = createPreloadablePage(() => import("@/pages/Profile"));
export const SettingsPage = createPreloadablePage(() => import("@/pages/Settings"));
export const PaymentsPage = createPreloadablePage(() => import("@/pages/Payments"));
export const PlansPage = createPreloadablePage(() => import("@/pages/Plans"));
export const StorePage = createPreloadablePage(() => import("@/pages/Store"));
export const SubscriptionsPage = createPreloadablePage(() => import("@/pages/Subscriptions"));
export const BillingPage = createPreloadablePage(() => import("@/pages/Billing"));
export const WalletPage = createPreloadablePage(() => import("@/pages/Wallet"));
export const AnnouncementsPage = createPreloadablePage(() => import("@/pages/Announcements"));
export const EmailSettingsPage = createPreloadablePage(() => import("@/pages/EmailSettings"));
export const HomepagePreviewPage = createPreloadablePage(() => import("@/pages/HomepagePreview"));
export const LookingGlassPage = createPreloadablePage(() => import("@/pages/LookingGlass"));
export const TrafficBillingPage = createPreloadablePage(() => import("@/pages/TrafficBilling"));
export const LoginPage = createPreloadablePage(() => import("@/pages/Login"));

const routePreloaders: Record<string, () => Promise<void>> = {
  "/": HomePage.preload,
  "/hosts": HostsPage.preload,
  "/rules": RulesPage.preload,
  "/forward-groups": ForwardGroupsPage.preload,
  "/tunnels": TunnelsPage.preload,
  "/users": UsersPage.preload,
  "/profile": ProfilePage.preload,
  "/settings": SettingsPage.preload,
  "/payments": PaymentsPage.preload,
  "/plans": PlansPage.preload,
  "/store": StorePage.preload,
  "/subscriptions": SubscriptionsPage.preload,
  "/billing": BillingPage.preload,
  "/wallet": WalletPage.preload,
  "/announcements": AnnouncementsPage.preload,
  "/email-settings": EmailSettingsPage.preload,
  "/homepage-preview": HomepagePreviewPage.preload,
  "/looking-glass": LookingGlassPage.preload,
  "/traffic-billing": TrafficBillingPage.preload,
  "/login": LoginPage.preload,
};

export function normalizeRoutePreloadPath(path: string) {
  const raw = String(path || "/").split("?")[0].split("#")[0] || "/";
  return raw.endsWith("/") && raw !== "/" ? raw.slice(0, -1) : raw;
}

export function preloadAppRoute(path: string) {
  const preload = routePreloaders[normalizeRoutePreloadPath(path)];
  return preload ? preload() : Promise.resolve();
}
