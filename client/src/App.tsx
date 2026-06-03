import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/_core/hooks/useAuth";
import type { ComponentType } from "react";
import { trpc } from "@/lib/trpc";
import { mobileAuth } from "@/lib/mobileAuth";
import NotFound from "@/pages/NotFound";
import Login from "@/pages/Login";
import { Redirect, Route, Switch, useLocation } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import Hosts from "./pages/Hosts";
import Rules from "./pages/Rules";
import ForwardGroups from "./pages/ForwardGroups";
import Tunnels from "./pages/Tunnels";
import Users from "./pages/Users";
import Profile from "./pages/Profile";
import Settings from "./pages/Settings";
import Payments from "./pages/Payments";
import Plans from "./pages/Plans";
import Store from "./pages/Store";
import Subscriptions from "./pages/Subscriptions";
import Billing from "./pages/Billing";
import Wallet from "./pages/Wallet";
import Announcements from "./pages/Announcements";
import Setup from "./pages/Setup";
import EmailSettings from "./pages/EmailSettings";
import HomepagePreview from "./pages/HomepagePreview";
import LookingGlass from "./pages/LookingGlass";
import TrafficBilling from "./pages/TrafficBilling";

function AdminRoute({ component: Component }: { component: ComponentType }) {
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
          <Toaster />
          <SetupGate />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
