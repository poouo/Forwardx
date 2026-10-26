import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmDialogProvider } from "@/components/ui/confirm-dialog";
import { useAuth } from "@/_core/hooks/useAuth";
import type { ComponentType } from "react";
import { useEffect } from "react";
import { clearSidebarPresentation } from "@/lib/sidebarPresentation";
import { trpc } from "@/lib/trpc";
import { mobileAuth } from "@/lib/mobileAuth";
import NotFound from "@/pages/NotFound";
import { Redirect, Route, Switch, useLocation } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import MotionPolicy from "./components/MotionPolicy";
import { ThemeProvider } from "./contexts/ThemeContext";
import PersonalizationLayer from "./components/PersonalizationLayer";
import Live2DWidgetHost from "./components/plugins/Live2DWidgetHost";
import DashboardLayout from "./components/DashboardLayout";
import RoutePage, { RoutePagePlaceholder } from "./components/RoutePage";
import { resolveClientRoute, type ClientPage } from "@shared/clientRoutes";

function pageComponent(page: ClientPage) {
  return (props: Record<string, any>) => <RoutePage page={page} pageProps={props} />;
}

const Setup = pageComponent("Setup");
const AnnouncementsPage = pageComponent("Announcements");
const BillingPage = pageComponent("Billing");
const CustomSidebarPage = pageComponent("CustomSidebarPage");
const EmailSettingsPage = pageComponent("EmailSettings");
const ForwardGroupsPage = pageComponent("ForwardGroups");
const HomePage = pageComponent("Home");
const OperationsPage = pageComponent("Operations");
const HomepagePreviewPage = pageComponent("HomepagePreview");
const HostMonitorPage = pageComponent("HostMonitor");
const HostsPage = pageComponent("Hosts");
const LoginPage = pageComponent("Login");
const LookingGlassPage = pageComponent("LookingGlass");
const PaymentsPage = pageComponent("Payments");
const PlansPage = pageComponent("Plans");
const PluginsPage = pageComponent("Plugins");
const ProfilePage = pageComponent("Profile");
const RulesPage = pageComponent("Rules");
const SettingsPage = pageComponent("Settings");
const StorePage = pageComponent("Store");
const SupportTicketsPage = pageComponent("SupportTickets");
const AffiliatesPage = pageComponent("Affiliates");
const SubscriptionsPage = pageComponent("Subscriptions");
const TrafficBillingPage = pageComponent("TrafficBilling");
const TunnelsPage = pageComponent("Tunnels");
const UsersPage = pageComponent("Users");
const WalletPage = pageComponent("Wallet");
import DatabaseHealthGate from "./components/DatabaseHealthGate";
import PanelStartView from "./components/PanelStartView";

type RoutableComponent = ComponentType<any>;

function routeComponent(Component: RoutableComponent) {
  return () => <Component />;
}

function isLoginRoute(location: string) {
  return location.startsWith("/login");
}

const isLocalDevPanel = (import.meta as any).env?.VITE_FORWARDX_DEV_PANEL === "1";

function AdminRoute({ component: Component }: { component: RoutableComponent }) {
  const { user, loading } = useAuth();
  if (loading) return <PanelStartView />;
  if (!user) return <Redirect to="/login" />;
  if (user.role !== "admin") return <Redirect to="/" />;
  return <Component />;
}

function LookingGlassRoute() {
  const { user, loading } = useAuth();
  const publicInfo = trpc.system.publicInfo.useQuery(undefined, {
    enabled: !!user,
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (loading) return <PanelStartView />;
  if (user && publicInfo.isLoading && !publicInfo.data) return <RoutePagePlaceholder />;
  if (!user) return <Redirect to="/login" />;
  if (user.role !== "admin" && publicInfo.data?.lookingGlassUserEnabled !== true) return <Redirect to="/" />;
  return <LookingGlassPage />;
}

function PluginsRoute({ sidebarPluginId }: { sidebarPluginId?: string }) {
  const { user, loading } = useAuth();
  const publicInfo = trpc.system.publicInfo.useQuery(undefined, {
    enabled: !!user,
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (loading) return <PanelStartView />;
  if (!user) return <Redirect to="/login" />;
  if (user.role !== "admin") return <Redirect to="/" />;
  if (publicInfo.isLoading && !publicInfo.data) return <PluginsPage sidebarPluginId={sidebarPluginId} />;
  if (publicInfo.data?.pluginsEnabled !== true) return <Redirect to="/settings" />;
  return <PluginsPage sidebarPluginId={sidebarPluginId} />;
}

function Router() {
  const [location] = useLocation();
  const { user, loading } = useAuth();
  useEffect(() => { if (!loading && !user) clearSidebarPresentation(); }, [loading, user]);
  const route = resolveClientRoute(location);
  const content = (
    <Switch>
      <Route path="/setup" component={Setup} />
      <Route path="/login">{routeComponent(LoginPage)}</Route>
      <Route path="/session-wait"><Redirect to="/login" /></Route>
      <Route path="/homepage-preview">{routeComponent(HomepagePreviewPage)}</Route>
      <Route path="/">{routeComponent(HomePage)}</Route>
      <Route path="/profile">{routeComponent(ProfilePage)}</Route>
      <Route path="/hosts">{() => <AdminRoute component={HostsPage} />}</Route>
      <Route path="/rules">{routeComponent(RulesPage)}</Route>
      <Route path="/looking-glass" component={LookingGlassRoute} />
      <Route path="/forward-groups">{() => <AdminRoute component={ForwardGroupsPage} />}</Route>
      <Route path="/tunnels">{() => <AdminRoute component={TunnelsPage} />}</Route>
      <Route path="/users">{() => <AdminRoute component={UsersPage} />}</Route>
      <Route path="/email-settings">{() => <AdminRoute component={EmailSettingsPage} />}</Route>
      <Route path="/payments">{() => <AdminRoute component={PaymentsPage} />}</Route>
      <Route path="/billing">{() => <AdminRoute component={BillingPage} />}</Route>
      <Route path="/traffic-billing">{() => <AdminRoute component={TrafficBillingPage} />}</Route>
      <Route path="/plans">{() => <AdminRoute component={PlansPage} />}</Route>
      <Route path="/plugins/sidebar/:pluginId">
        {(params) => <PluginsRoute sidebarPluginId={params.pluginId} />}
      </Route>
      <Route path="/plugins">{() => <PluginsRoute />}</Route>
      <Route path="/store">{routeComponent(StorePage)}</Route>
      <Route path="/subscriptions">{routeComponent(SubscriptionsPage)}</Route>
      <Route path="/wallet">{routeComponent(WalletPage)}</Route>
      <Route path="/announcements">{routeComponent(AnnouncementsPage)}</Route>
      <Route path="/tickets">{routeComponent(SupportTicketsPage)}</Route>
      <Route path="/affiliates">{routeComponent(AffiliatesPage)}</Route>
      <Route path="/affiliate-management">{() => <AdminRoute component={() => <AffiliatesPage admin />} />}</Route>
      <Route path="/settings">{() => <AdminRoute component={SettingsPage} />}</Route>
      <Route path="/operations">{() => <AdminRoute component={OperationsPage} />}</Route>
      <Route path="/custom-pages/:pageId">
        {(params) => <CustomSidebarPage pageId={params.pageId} />}
      </Route>
      <Route path="/404" component={NotFound} />
      <Route path="/:monitorPath">{routeComponent(HostMonitorPage)}</Route>
      <Route component={NotFound} />
    </Switch>
  );
  // Keep navigation, sidebar scroll and upgrade state alive while only the
  // content module changes. Public pages must never inherit the dashboard shell.
  if (loading && route?.dashboard) return <PanelStartView />;
  return user && route?.dashboard
    ? <DashboardLayout key={String(user.id) + ":" + user.role}>{content}</DashboardLayout>
    : content;
}

function SetupGate() {
  const [location] = useLocation();
  const hasMobilePanelUrl = !mobileAuth.isNative || mobileAuth.hasPanelUrl();
  const loginRoute = isLoginRoute(location);

  // Keep this hook unconditional.  Local development redirects /login to the
  // seeded dashboard, and returning before the query here makes the hook list
  // change when the redirect completes.
  const setup = trpc.setup.status.useQuery(undefined, {
    enabled: hasMobilePanelUrl && !loginRoute,
    retry: false,
    refetchOnWindowFocus: false,
  });

  // The local dev panel injects the seeded administrator in the server
  // context, so showing a login form here only creates a needless gate.
  if (isLocalDevPanel && (loginRoute || location === "/session-wait")) {
    return <Redirect to="/" />;
  }

  if (!hasMobilePanelUrl) {
    if (location !== "/login") return <Redirect to="/login" />;
    return <Router />;
  }

  if (loginRoute) return <Router />;

  if (setup.isError) {
    // A failed setup/status read (including DB backpressure) is not a logout.
    return <Router />;
  }

  // Setup writes and protected APIs remain guarded on the server. Do not hold
  // the entire router (and therefore auth/data requests) behind a read check.
  if (setup.isLoading) return <Router />;

  const ready = !!setup.data?.setupComplete;
  if (!ready && location !== "/setup") return <Redirect to="/setup" />;
  if (ready && location === "/setup") return <Redirect to="/login" />;
  return <Router />;
}

import { SeamlessMigrationGate } from "./components/SeamlessMigrationGate";
import RuleTaskNotifications from "./components/RuleTaskNotifications";

function App() {
  return (
    <ErrorBoundary>
      <MotionPolicy>
        <ThemeProvider defaultTheme="light">
          <TooltipProvider>
            <ConfirmDialogProvider>
              <DatabaseHealthGate>
                <SeamlessMigrationGate>
                  <PersonalizationLayer />
                  <Live2DWidgetHost />
                  <Toaster />
                  <RuleTaskNotifications />
                  <SetupGate />
                </SeamlessMigrationGate>
              </DatabaseHealthGate>
            </ConfirmDialogProvider>
          </TooltipProvider>
        </ThemeProvider>
      </MotionPolicy>
    </ErrorBoundary>
  );
}

export default App;
