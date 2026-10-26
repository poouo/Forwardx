import { trpc } from "@/lib/trpc";
import { mobileAuth } from "@/lib/mobileAuth";
import { clearSidebarPresentation } from "@/lib/sidebarPresentation";
import { isAuthCheckPending, retryAuthCheck } from "@/lib/queryPolicy";

export function useAuth() {
  const { data: user, isLoading, error } = trpc.auth.me.useQuery(undefined, {
    enabled: !mobileAuth.isNative || mobileAuth.hasPanelUrl(),
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: retryAuthCheck,
  });
  const logoutMutation = trpc.auth.logout.useMutation({
    onSuccess: () => {
      clearSidebarPresentation();
      mobileAuth.clear();
      window.location.href = "/login";
    },
  });

  const logout = () => {
    logoutMutation.mutate();
  };

  return {
    user: user ?? null,
    loading: isAuthCheckPending(user, isLoading, error),
    logout,
  };
}
