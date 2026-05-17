import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/_core/hooks/useAuth";
import type { ComponentType } from "react";
import NotFound from "@/pages/NotFound";
import Login from "@/pages/Login";
import { Redirect, Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import Hosts from "./pages/Hosts";
import Rules from "./pages/Rules";
import Tunnels from "./pages/Tunnels";
import Users from "./pages/Users";
import Settings from "./pages/Settings";
import Payments from "./pages/Payments";
import Plans from "./pages/Plans";
import Store from "./pages/Store";

function AdminRoute({ component: Component }: { component: ComponentType }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Redirect to="/login" />;
  if (user.role !== "admin") return <Redirect to="/" />;
  return <Component />;
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/" component={Home} />
      <Route path="/hosts">{() => <AdminRoute component={Hosts} />}</Route>
      <Route path="/rules" component={Rules} />
      <Route path="/tunnels">{() => <AdminRoute component={Tunnels} />}</Route>
      <Route path="/users">{() => <AdminRoute component={Users} />}</Route>
      <Route path="/payments">{() => <AdminRoute component={Payments} />}</Route>
      <Route path="/plans">{() => <AdminRoute component={Plans} />}</Route>
      <Route path="/store" component={Store} />
      <Route path="/settings">{() => <AdminRoute component={Settings} />}</Route>
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
