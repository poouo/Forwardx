import { trpc } from "@/lib/trpc";
import { ACCOUNT_DISABLED_ERR_MSG, SESSION_REPLACED_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, httpLink, splitLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import { initializeLanguage } from "./i18n";
import { mobileAuth } from "./lib/mobileAuth";
import "./index.css";
import "./styles/pearl.css";
import { DATABASE_UNAVAILABLE_MESSAGE } from "@shared/databaseHealth";
import { fetchPublicMonitor, PUBLIC_MONITOR_QUERY_PATHS } from "./lib/publicMonitor";
import { fetchManualProbe, MANUAL_PROBE_QUERY_PATHS } from "./lib/manualProbe";
import { createTRPCQueryUtils } from "@trpc/react-query";
import { installDashboardCache } from "./lib/dashboardCache";
import { readSiteBranding, saveSiteBranding } from "./lib/siteBranding";
import { shouldRetryQuery } from "./lib/queryPolicy";

const LOGIN_EXPIRED_NOTICE = "登录状态已失效，请重新登录";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: shouldRetryQuery,
      staleTime: 5_000,
      gcTime: 30 * 60_000,
    },
  },
});
const dashboardCache = installDashboardCache(queryClient, () => mobileAuth.isNative ? mobileAuth.getPanelUrl() : window.location.origin);

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;

  const isUnauthorized =
    error.message === UNAUTHED_ERR_MSG ||
    error.message === ACCOUNT_DISABLED_ERR_MSG ||
    error.message === SESSION_REPLACED_ERR_MSG;

  if (!isUnauthorized) return;
  dashboardCache.clear();
  const notice = error.message === ACCOUNT_DISABLED_ERR_MSG || error.message === SESSION_REPLACED_ERR_MSG
    ? error.message
    : LOGIN_EXPIRED_NOTICE;
  if (mobileAuth.isNative || error.message === ACCOUNT_DISABLED_ERR_MSG) {
    mobileAuth.clear();
  }
  window.sessionStorage.setItem("forwardx.loginNotice", notice);
  void queryClient.cancelQueries();
  queryClient.clear();

  // Only redirect if not already in a public bootstrapping flow.
  if (window.location.pathname !== "/login" && window.location.pathname !== "/setup") {
    window.location.href = "/login";
  }
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    if (error instanceof TRPCClientError && error.message === DATABASE_UNAVAILABLE_MESSAGE) {
      void queryClient.invalidateQueries({ queryKey: ["database-health"] });
      return;
    }
    redirectToLoginIfUnauthorized(error);
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "success" &&
    JSON.stringify(event.mutation.options.mutationKey?.[0]) === JSON.stringify(["auth", "logout"])) dashboardCache.clear();
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    if (error instanceof TRPCClientError && error.message === DATABASE_UNAVAILABLE_MESSAGE) {
      void queryClient.invalidateQueries({ queryKey: ["database-health"] });
      return;
    }
    redirectToLoginIfUnauthorized(error);
    console.error("[API Mutation Error]", error);
  }
});

const criticalQueryPaths = new Set([
  "auth.me",
  "setup.status",
  "system.publicInfo",
  "dashboard.stats",
  "dashboard.trafficTotals",
  "dashboard.trafficSeries",
  "dashboard.trafficBreakdown",
  "dashboard.userTraffic",
  "billing.me",
  "trafficBilling.status",
  "plans.mySubscriptions",
]);

const trpcFetch = (input: RequestInfo | URL, init?: RequestInit) => {
  let requestInput = input;
  if (mobileAuth.isNative) {
    const panelUrl = mobileAuth.getPanelUrl();
    const rawUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const parsed = new URL(rawUrl, window.location.href);
    if (panelUrl && parsed.pathname.startsWith("/api/trpc")) {
      requestInput = `${panelUrl}${parsed.pathname}${parsed.search}`;
    }
  }
  const headers = new Headers(init?.headers);
  if (mobileAuth.isNative) {
    headers.set("x-forwardx-mobile", "1");
    const token = mobileAuth.getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  return globalThis.fetch(requestInput, {
    ...(init ?? {}),
    headers,
    credentials: "include",
  });
};

const trpcClient = trpc.createClient({
  links: [
    splitLink({
      condition: (op) => MANUAL_PROBE_QUERY_PATHS.has(op.path),
      true: httpLink({ url: "/api/trpc", transformer: superjson,
        fetch: (input, init) => fetchManualProbe(trpcFetch, input, init) }),
      false: splitLink({
        condition: (op) => op.type === "query" && PUBLIC_MONITOR_QUERY_PATHS.has(op.path),
        true: httpLink({
          url: "/api/trpc",
          transformer: superjson,
          fetch: (input, init) => fetchPublicMonitor(trpcFetch, input, init),
        }),
        false: splitLink({
          condition: (op) => op.type === "query" && criticalQueryPaths.has(op.path),
          true: httpLink({
            url: "/api/trpc",
            transformer: superjson,
            fetch: trpcFetch,
          }),
          false: httpBatchLink({
            url: "/api/trpc",
            transformer: superjson,
            fetch: trpcFetch,
          }),
        }),
      }),
    }),
  ],
});

async function bootstrap() {
  await mobileAuth.hydrateNative();
  document.title = readSiteBranding().siteTitle;
  // Start network work while locale detection and the eagerly preloaded App are
  // being prepared. React observes the same queries, so it does not repeat them.
  const api = createTRPCQueryUtils({ queryClient, client: trpcClient });
  if (!mobileAuth.isNative || mobileAuth.hasPanelUrl()) {
    // Public branding starts alongside auth, not after mounting the sidebar.
    void api.system.publicInfo.fetch().then(info => {
      document.title = saveSiteBranding(info).siteTitle;
    }).catch(() => { /* Preserve the last public branding on transient failures. */ });
    if (!window.location.pathname.startsWith("/login")) void api.setup.status.prefetch();
    void api.auth.me.fetch().then(user => {
      if (!user || window.location.pathname !== "/") return;
      void api.dashboard.stats.prefetch();
      void api.dashboard.trafficTotals.prefetch();
      void api.dashboard.trafficSeries.prefetch({ hours: 24, bucketMinutes: 60 });
      void api.dashboard.trafficBreakdown.prefetch({ hours: 24, limit: 30 });
    }).catch(() => { /* The normal auth/error boundary handles failures. */ });
  }
  await initializeLanguage(mobileAuth.isNative ? mobileAuth.getPanelUrl() : "");
  // Initialize module-level presentation labels only after locale detection.
  const { default: App } = await import("./App");

  if (mobileAuth.isNative) {
    document.documentElement.classList.add("capacitor-native");
  }

  createRoot(document.getElementById("root")!).render(
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

void bootstrap();
