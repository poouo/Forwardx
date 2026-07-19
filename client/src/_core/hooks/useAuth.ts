import { useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { mobileAuth } from "@/lib/mobileAuth";
import { SESSION_BUSY_ERR_MSG } from "@shared/const";

const SESSION_BUSY_RETURN_PATH_KEY = "forwardx.sessionBusyReturnPath";

export function useAuth() {
  const { data: user, error, isLoading: loading } = trpc.auth.me.useQuery(undefined, {
    enabled: !mobileAuth.isNative || mobileAuth.hasPanelUrl(),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const sessionBusy = error?.message === SESSION_BUSY_ERR_MSG;

  useEffect(() => {
    if (!sessionBusy || typeof window === "undefined" || window.location.pathname === "/session-wait") return;
    window.sessionStorage.setItem(
      SESSION_BUSY_RETURN_PATH_KEY,
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    );
    window.location.href = "/session-wait";
  }, [sessionBusy]);

  const logoutMutation = trpc.auth.logout.useMutation({
    onSuccess: () => {
      mobileAuth.clear();
      window.location.href = "/login";
    },
  });

  const logout = () => {
    logoutMutation.mutate();
  };

  return {
    user: user ?? null,
    loading: loading || sessionBusy,
    sessionBusy,
    logout,
  };
}
