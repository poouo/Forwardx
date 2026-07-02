import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmDialogProvider } from "@/components/ui/confirm-dialog";
import { useAuth } from "@/_core/hooks/useAuth";
import type { ComponentType } from "react";
import { trpc } from "@/lib/trpc";
import { mobileAuth } from "@/lib/mobileAuth";
import NotFound from "@/pages/NotFound";
import { Redirect, Route, Switch, useLocation } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import PersonalizationLayer from "./components/PersonalizationLayer";
import DashboardLayout from "./components/DashboardLayout";
import DataSectionLoading from "./components/DataSectionLoading";
import Setup from "./pages/Setup";
import AnnouncementsPage from "@/pages/Announcements";
import BillingPage from "@/pages/Billing";
import EmailSettingsPage from "@/pages/EmailSettings";
import ForwardGroupsPage from "@/pages/ForwardGroups";
import HomePage from "@/pages/Home";
import HomepagePreviewPage from "@/pages/HomepagePreview";
import HostMonitorPage from "@/pages/HostMonitor";
import HostsPage from "@/pages/Hosts";
import LoginPage from "@/pages/Login";
import LookingGlassPage from "@/pages/LookingGlass";
import PaymentsPage from "@/pages/Payments";
import PlansPage from "@/pages/Plans";
import ProfilePage from "@/pages/Profile";
import RulesPage from "@/pages/Rules";
import SettingsPage from "@/pages/Settings";
import StorePage from "@/pages/Store";
import SubscriptionsPage from "@/pages/Subscriptions";
import TrafficBillingPage from "@/pages/TrafficBilling";
import TunnelsPage from "@/pages/Tunnels";
import UsersPage from "@/pages/Users";
import WalletPage from "@/pages/Wallet";

type RoutableComponent = ComponentType<any>;

function AppLoading({ label = "正在加载页面" }: { label?: string }) {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background/40 p-6">
      <DataSectionLoading label={label} minHeight="min-h-[220px]" className="max-w-2xl" />
    </div>
  );
}

function DashboardRouteLoading({ label = "正在加载页面" }: { label?: string }) {
  return (
    <DashboardLayout>
      <DataSectionLoading label={label} minHeight="min-h-[320px]" />
    </DashboardLayout>
  );
}

function routeComponent(Component: RoutableComponent) {
  return () => <Component />;
}

function isLoginRoute(location: string) {
  return location.startsWith("/login");
}

function AdminRoute({ component: Component }: { component: RoutableComponent }) {
  const { user, loading } = useAuth();
  if (loading) return <AppLoading label="正在校验登录状态" />;
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

  if (loading) return <AppLoading label="正在校验登录状态" />;
  if (user && publicInfo.isLoading && !publicInfo.data) {
    return <DashboardRouteLoading label="正在加载网络测试权限" />;
  }
  if (!user) return <Redirect to="/login" />;
  if (user.role !== "admin" && publicInfo.data?.lookingGlassUserEnabled !== true) return <Redirect to="/" />;
  return <LookingGlassPage />;
}

function Router() {
  return (
    <Switch>
      <Route path="/setup" component={Setup} />
      <Route path="/login">{routeComponent(LoginPage)}</Route>
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
      <Route path="/store">{routeComponent(StorePage)}</Route>
      <Route path="/subscriptions">{routeComponent(SubscriptionsPage)}</Route>
      <Route path="/wallet">{routeComponent(WalletPage)}</Route>
      <Route path="/announcements">{routeComponent(AnnouncementsPage)}</Route>
      <Route path="/settings">{() => <AdminRoute component={SettingsPage} />}</Route>
      <Route path="/404" component={NotFound} />
      <Route path="/:monitorPath">{routeComponent(HostMonitorPage)}</Route>
      <Route component={NotFound} />
    </Switch>
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

  if (setup.isLoading) return <AppLoading label="正在检查面板状态" />;

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
