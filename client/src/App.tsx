import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmDialogProvider } from "@/components/ui/confirm-dialog";
import { useAuth } from "@/_core/hooks/useAuth";
import { lazy, Suspense, type ComponentType } from "react";
import { trpc } from "@/lib/trpc";
import { mobileAuth } from "@/lib/mobileAuth";
import NotFound from "@/pages/NotFound";
import { Redirect, Route, Switch, useLocation } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import PersonalizationLayer from "./components/PersonalizationLayer";
import Setup from "./pages/Setup";
import LoginPage from "@/pages/Login";
import SessionWaitPage from "@/pages/SessionWait";

const AnnouncementsPage = lazy(() => import("@/pages/Announcements"));
const BillingPage = lazy(() => import("@/pages/Billing"));
const CustomSidebarPage = lazy(() => import("@/pages/CustomSidebarPage"));
const EmailSettingsPage = lazy(() => import("@/pages/EmailSettings"));
const ForwardGroupsPage = lazy(() => import("@/pages/ForwardGroups"));
const HomePage = lazy(() => import("@/pages/Home"));
const HomepagePreviewPage = lazy(() => import("@/pages/HomepagePreview"));
const HostMonitorPage = lazy(() => import("@/pages/HostMonitor"));
const HostsPage = lazy(() => import("@/pages/Hosts"));
const LookingGlassPage = lazy(() => import("@/pages/LookingGlass"));
const PaymentsPage = lazy(() => import("@/pages/Payments"));
const PlansPage = lazy(() => import("@/pages/Plans"));
const PluginsPage = lazy(() => import("@/pages/Plugins"));
const ProfilePage = lazy(() => import("@/pages/Profile"));
const RulesPage = lazy(() => import("@/pages/Rules"));
const SettingsPage = lazy(() => import("@/pages/Settings"));
const StorePage = lazy(() => import("@/pages/Store"));
const SubscriptionsPage = lazy(() => import("@/pages/Subscriptions"));
const TrafficBillingPage = lazy(() => import("@/pages/TrafficBilling"));
const TunnelsPage = lazy(() => import("@/pages/Tunnels"));
const UsersPage = lazy(() => import("@/pages/Users"));
const WalletPage = lazy(() => import("@/pages/Wallet"));

type RoutableComponent = ComponentType<any>;

function routeComponent(Component: RoutableComponent) {
  return () => <Component />;
}

function isLoginRoute(location: string) {
  return location.startsWith("/login");
}

function AdminRoute({ component: Component }: { component: RoutableComponent }) {
  const { user, loading } = useAuth();
  if (loading) return null;
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

  if (loading) return null;
  if (user && publicInfo.isLoading && !publicInfo.data) return null;
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

  if (loading) return null;
  if (!user) return <Redirect to="/login" />;
  if (user.role !== "admin") return <Redirect to="/" />;
  if (publicInfo.isLoading && !publicInfo.data) return <PluginsPage sidebarPluginId={sidebarPluginId} />;
  if (publicInfo.data?.pluginsEnabled !== true) return <Redirect to="/settings" />;
  return <PluginsPage sidebarPluginId={sidebarPluginId} />;
}

function Router() {
  return (
    <Suspense
      fallback={(
        <div className="flex min-h-[180px] w-full items-center justify-center p-6 text-sm text-muted-foreground">
          正在加载页面
        </div>
      )}
    >
      <Switch>
        <Route path="/setup" component={Setup} />
        <Route path="/login">{routeComponent(LoginPage)}</Route>
        <Route path="/session-wait">{routeComponent(SessionWaitPage)}</Route>
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
        <Route path="/settings">{() => <AdminRoute component={SettingsPage} />}</Route>
        <Route path="/custom-pages/:pageId">
          {(params) => <CustomSidebarPage pageId={params.pageId} />}
        </Route>
        <Route path="/404" component={NotFound} />
        <Route path="/:monitorPath">{routeComponent(HostMonitorPage)}</Route>
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function SetupGate() {
  const [location] = useLocation();
  const hasMobilePanelUrl = !mobileAuth.isNative || mobileAuth.hasPanelUrl();
  const loginRoute = isLoginRoute(location);
  const setup = trpc.setup.status.useQuery(undefined, {
    enabled: hasMobilePanelUrl && !loginRoute,
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (!hasMobilePanelUrl) {
    if (location !== "/login") return <Redirect to="/login" />;
    return <Router />;
  }

  if (loginRoute) return <Router />;

  if (setup.isError) {
    if (mobileAuth.isNative) {
      if (location !== "/login") return <Redirect to="/login" />;
      return <Router />;
    }
    return <Router />;
  }

  if (setup.isLoading) return null;

  const ready = !!setup.data?.setupComplete;
  if (!ready && location !== "/setup") return <Redirect to="/setup" />;
  if (ready && location === "/setup") return <Redirect to="/login" />;
  return <Router />;
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <ConfirmDialogProvider>
            <PersonalizationLayer />
            <Toaster />
            <SetupGate />
          </ConfirmDialogProvider>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
