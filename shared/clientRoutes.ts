/** Shared by the router, intent prefetch and production HTML preloads. */
export const clientRoutes = [
  { path: "/setup", page: "Setup", dashboard: false },
  { path: "/login", page: "Login", dashboard: false },
  { path: "/homepage-preview", page: "HomepagePreview", dashboard: false },
  { path: "/", page: "Home", dashboard: true },
  { path: "/profile", page: "Profile", dashboard: true },
  { path: "/hosts", page: "Hosts", dashboard: true, admin: true },
  { path: "/rules", page: "Rules", dashboard: true },
  { path: "/looking-glass", page: "LookingGlass", dashboard: true },
  { path: "/forward-groups", page: "ForwardGroups", dashboard: true, admin: true },
  { path: "/tunnels", page: "Tunnels", dashboard: true, admin: true },
  { path: "/users", page: "Users", dashboard: true, admin: true },
  { path: "/email-settings", page: "EmailSettings", dashboard: true, admin: true },
  { path: "/payments", page: "Payments", dashboard: true, admin: true },
  { path: "/billing", page: "Billing", dashboard: true, admin: true },
  { path: "/traffic-billing", page: "TrafficBilling", dashboard: true, admin: true },
  { path: "/plans", page: "Plans", dashboard: true, admin: true },
  { path: "/plugins", page: "Plugins", dashboard: true, admin: true },
  { path: "/plugins/sidebar/", page: "Plugins", dashboard: true, admin: true, prefix: true },
  { path: "/store", page: "Store", dashboard: true },
  { path: "/subscriptions", page: "Subscriptions", dashboard: true },
  { path: "/wallet", page: "Wallet", dashboard: true },
  { path: "/announcements", page: "Announcements", dashboard: true },
  { path: "/tickets", page: "SupportTickets", dashboard: true },
  { path: "/affiliates", page: "Affiliates", dashboard: true },
  { path: "/affiliate-management", page: "Affiliates", dashboard: true, admin: true },
  { path: "/settings", page: "Settings", dashboard: true, admin: true },
  { path: "/operations", page: "Operations", dashboard: true, admin: true },
  { path: "/custom-pages/", page: "CustomSidebarPage", dashboard: true, prefix: true },
] as const;

export type ClientPage = (typeof clientRoutes)[number]["page"] | "HostMonitor";

export function resolveClientRoute(location: string) {
  const path = location.split(/[?#]/, 1)[0];
  return clientRoutes.find(route => "prefix" in route
    ? path.startsWith(route.path) && /^[^/]+$/.test(path.slice(route.path.length))
    : path === route.path);
}

export function canPrefetchClientRoute(location: string, role?: string) {
  const route = resolveClientRoute(location);
  return !!route && (!route.dashboard || !!role) && (!("admin" in route) || role === "admin");
}
