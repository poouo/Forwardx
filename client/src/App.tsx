import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmDialogProvider } from "@/components/ui/confirm-dialog";
import { useAuth } from "@/_core/hooks/useAuth";
import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { trpc } from "@/lib/trpc";
import { mobileAuth } from "@/lib/mobileAuth";
import { Redirect, Route, Switch, useLocation } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import PersonalizationLayer from "./components/PersonalizationLayer";

type RouteComponent = ComponentType<any> | LazyExoticComponent<ComponentType<any>>;

const Announcements = lazy(() => import("@/pages/Announcements"));
const Billing = lazy(() => import("@/pages/Billing"));
const EmailSettings = lazy(() => import("@/pages/EmailSettings"));
const ForwardGroups = lazy(() => import("@/pages/ForwardGroups"));
const Home = lazy(() => import("@/pages/Home"));
const HomepagePreview = lazy(() => import("@/pages/HomepagePreview"));
const Hosts = lazy(() => import("@/pages/Hosts"));
const Login = lazy(() => import("@/pages/Login"));
const LookingGlass = lazy(() => import("@/pages/LookingGlass"));
const NotFound = lazy(() => import("@/pages/NotFound"));
const Payments = lazy(() => import("@/pages/Payments"));
const Plans = lazy(() => import("@/pages/Plans"));
const Profile = lazy(() => import("@/pages/Profile"));
const Rules = lazy(() => import("@/pages/Rules"));
const Settings = lazy(() => import("@/pages/Settings"));
const Setup = lazy(() => import("@/pages/Setup"));
const Store = lazy(() => import("@/pages/Store"));
const Subscriptions = lazy(() => import("@/pages/Subscriptions"));
const TrafficBilling = lazy(() => import("@/pages/TrafficBilling"));
const Tunnels = lazy(() => import("@/pages/Tunnels"));
const Users = lazy(() => import("@/pages/Users"));
const Wallet = lazy(() => import("@/pages/Wallet"));

function RouteFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
      正在加载...
    </div>
  );
}

function AdminRoute({ component: Component }: { component: RouteComponent }) {
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

  if (loading || (user && publicInfo.isLoading && !publicInfo.data)) return null;
  if (!user) return <Redirect to="/login" />;
  if (user.role !== "admin" && publicInfo.data?.lookingGlassUserEnabled !== true) return <Redirect to="/" />;
  return <LookingGlass />;
}

function Router() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Switch>
        <Route path="/setup" component={Setup} />
        <Route path="/login" component={Login} />
        <Route path="/homepage-preview" component={HomepagePreview} />
        <Route path="/" component={Home} />
        <Route path="/profile" component={Profile} />
        <Route path="/hosts">{() => <AdminRoute component={Hosts} />}</Route>
        <Route path="/rules" component={Rules} />
        <Route path="/looking-glass" component={LookingGlassRoute} />
        <Route path="/forward-groups">{() => <AdminRoute component={ForwardGroups} />}</Route>
        <Route path="/tunnels">{() => <AdminRoute component={Tunnels} />}</Route>
        <Route path="/users">{() => <AdminRoute component={Users} />}</Route>
        <Route path="/email-settings">{() => <AdminRoute component={EmailSettings} />}</Route>
        <Route path="/payments">{() => <AdminRoute component={Payments} />}</Route>
        <Route path="/billing">{() => <AdminRoute component={Billing} />}</Route>
        <Route path="/traffic-billing">{() => <AdminRoute component={TrafficBilling} />}</Route>
        <Route path="/plans">{() => <AdminRoute component={Plans} />}</Route>
        <Route path="/store" component={Store} />
        <Route path="/subscriptions" component={Subscriptions} />
        <Route path="/wallet" component={Wallet} />
        <Route path="/announcements" component={Announcements} />
        <Route path="/settings">{() => <AdminRoute component={Settings} />}</Route>
        <Route path="/404" component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function SetupGate() {
  const [location] = useLocation();
  const hasMobilePanelUrl = !mobileAuth.isNative || mobileAuth.hasPanelUrl();
  const setup = trpc.setup.status.useQuery(undefined, {
    enabled: hasMobilePanelUrl,
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (!hasMobilePanelUrl) {
    if (location !== "/login") return <Redirect to="/login" />;
    return <Router />;
  }

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
