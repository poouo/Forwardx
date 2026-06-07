import { trpc } from "@/lib/trpc";
import { ACCOUNT_DISABLED_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { mobileAuth } from "./lib/mobileAuth";
import "./index.css";

const cachedSiteTitle = (() => {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem("forwardx.siteTitle")?.trim() || "";
  } catch {
    return "";
  }
})();

if (cachedSiteTitle) {
  document.title = cachedSiteTitle;
}

const queryClient = new QueryClient();

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;

  const isUnauthorized = error.message === UNAUTHED_ERR_MSG || error.message === ACCOUNT_DISABLED_ERR_MSG;

  if (!isUnauthorized) return;
  if (error.message === ACCOUNT_DISABLED_ERR_MSG) {
    mobileAuth.clear();
    window.sessionStorage.setItem("forwardx.loginNotice", ACCOUNT_DISABLED_ERR_MSG);
  }

  // Only redirect if not already in a public bootstrapping flow.
  if (window.location.pathname !== "/login" && window.location.pathname !== "/setup") {
    window.location.href = "/login";
  }
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Mutation Error]", error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
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
      },
    }),
  ],
});

async function bootstrap() {
  await mobileAuth.hydrateNative();

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
