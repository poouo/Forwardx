import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { toast } from "@/lib/localizedToast";
import { t } from "@/i18n";
import { mobileAuth } from "@/lib/mobileAuth";

export function GoogleMark() {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" className="shrink-0">
    <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.32 2.98-7.36Z" />
    <path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.04.97-3.38.97-2.6 0-4.81-1.76-5.6-4.12H3.06v2.59A10 10 0 0 0 12 22Z" />
    <path fill="#FBBC05" d="M6.4 13.93a6 6 0 0 1 0-3.86V7.48H3.06a10 10 0 0 0 0 9.04l3.34-2.59Z" />
    <path fill="#EA4335" d="M12 5.95c1.47 0 2.79.51 3.83 1.51l2.88-2.88A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.94 5.48l3.34 2.59C7.19 7.71 9.4 5.95 12 5.95Z" />
  </svg>;
}

export default function GoogleLoginButton({ disabled = false, className = "" }: { disabled?: boolean; className?: string }) {
  const { data } = trpc.google.loginStatus.useQuery(undefined, { enabled: !mobileAuth.isNative, retry: false, staleTime: 30_000 });
  const start = trpc.google.start.useMutation({ onSuccess: data => { window.location.assign(data.url); }, onError: error => toast.error(error.message) });
  if (!data?.enabled || mobileAuth.isNative) return null;
  return <Button type="button" variant="outline" className={`w-full gap-2 whitespace-normal ${className}`} disabled={disabled || start.isPending} onClick={() => start.mutate({})}>
    {start.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <GoogleMark />}
    {t("使用 Google 继续")}
  </Button>;
}
