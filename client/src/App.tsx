import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmDialogProvider } from "@/components/ui/confirm-dialog";
import { useAuth } from "@/_core/hooks/useAuth";
import { Suspense, type ComponentType, type ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { mobileAuth } from "@/lib/mobileAuth";
import NotFound from "@/pages/NotFound";
import { Redirect, Route, Switch, useLocation } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import PersonalizationLayer from "./components/PersonalizationLayer";
import Setup from "./pages/Setup";
import {
  AnnouncementsPage,
  BillingPage,
  EmailSettingsPage,
  ForwardGroupsPage,
  HomePage,
  HomepagePreviewPage,
  HostsPage,
  LoginPage,
  LookingGlassPage,
  PaymentsPage,
  PlansPage,
  ProfilePage,
  RulesPage,
  SettingsPage,
  StorePage,
  SubscriptionsPage,
  TrafficBillingPage,
  TunnelsPage,
  UsersPage,
  WalletPage,
} from "@/lib/routePreload";

type RoutableComponent = ComponentType<any>;

function RouteSuspense({ children }: { children: ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}

function routeComponent(Component: RoutableComponent) {
  return () => (
    <RouteSuspense>
      <Component />
    </RouteSuspense>
  );
}

function isLoginRoute(location: string) {
  return location.startsWith("/login");
}

function AdminRoute({ component: Component }: { component: RoutableComponent }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Redirect to="/login" />;
  if (user.role !== "admin") return <Redirect to="/" />;
  return (
    <RouteSuspense>
      <Component />
    </RouteSuspense>
  );
}

function LookingGlassRoute() {
  const { user, loading } = useAuth();
  const publicInfo = trpc.system.publicInfo.useQuery(undefined, {
    enabled: !!user,
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (loading || (user && publicInfo.isLoading && !publicInfo.data)) return null;
  if (!user) return <Redirect to="/login" />;
  if (user.role !== "admin" && publicInfo.data?.lookingGlassUserEnabled !== true) return <Redirect to="/" />;
  return (
    <RouteSuspense>
      <LookingGlassPage />
    </RouteSuspense>
  );
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
