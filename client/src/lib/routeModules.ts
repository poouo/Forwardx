import type { ComponentType } from "react";
import { canPrefetchClientRoute, resolveClientRoute, type ClientPage } from "../../../shared/clientRoutes";
import { createModuleResource } from "./moduleResource";

const imports = {
  Setup: () => import("../pages/Setup"),
  Login: () => import("../pages/Login"),
  HomepagePreview: () => import("../pages/HomepagePreview"),
  Home: () => import("../pages/Home"),
  Profile: () => import("../pages/Profile"),
  Hosts: () => import("../pages/Hosts"),
  Rules: () => import("../pages/Rules"),
  LookingGlass: () => import("../pages/LookingGlass"),
  ForwardGroups: () => import("../pages/ForwardGroups"),
  Tunnels: () => import("../pages/Tunnels"),
  Users: () => import("../pages/Users"),
  EmailSettings: () => import("../pages/EmailSettings"),
  Payments: () => import("../pages/Payments"),
  Billing: () => import("../pages/Billing"),
  TrafficBilling: () => import("../pages/TrafficBilling"),
  Plans: () => import("../pages/Plans"),
  Plugins: () => import("../pages/Plugins"),
  Store: () => import("../pages/Store"),
  Subscriptions: () => import("../pages/Subscriptions"),
  Wallet: () => import("../pages/Wallet"),
  Announcements: () => import("../pages/Announcements"),
  SupportTickets: () => import("../pages/SupportTickets"),
  Affiliates: () => import("../pages/Affiliates"),
  Settings: () => import("../pages/Settings"),
  Operations: () => import("../pages/Operations"),
  CustomSidebarPage: () => import("../pages/CustomSidebarPage"),
  HostMonitor: () => import("../pages/HostMonitor"),
} satisfies Record<ClientPage, () => Promise<{ default: ComponentType<any> }>>;

const resources = new Map<ClientPage, ReturnType<typeof createModuleResource<{ default: ComponentType<any> }>>>();
export function getRouteModule(page: ClientPage) {
  let resource = resources.get(page);
  if (!resource) {
    resource = createModuleResource<{ default: ComponentType<any> }>(imports[page]);
    resources.set(page, resource);
  }
  return resource;
}

export function prefetchRoute(location: string, role?: string) {
  if (!canPrefetchClientRoute(location, role)) return;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (!navigator.onLine || connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType || "")) return;
  const route = resolveClientRoute(location)!;
  void getRouteModule(route.page).load();
}
