import { useEffect, useMemo, useState } from "react";
import { Loader2, Play, TvMinimalPlay } from "lucide-react";
import { t } from "@/i18n";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { hostAddressOptions } from "@shared/hostAddresses";
import { STREAM_UNLOCK_PROVIDER_CATALOG } from "@shared/streamUnlock";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import StreamProviderLogo from "./StreamProviderLogo";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type HostStreamUnlockDialogProps = {
  host: any | null;
  onOpenChange: (open: boolean) => void;
};

type StreamUnlockResult = {
  providerId?: string;
  id?: string;
  key?: string;
  platform?: string;
  kind?: string;
  status?: string;
  state?: string;
  region?: string | null;
  country?: string | null;
  family?: string | null;
};

type DnsResult = {
  domain?: string;
  family?: string | null;
  mode?: string;
};

type ProviderDisplay = {
  provider: (typeof STREAM_UNLOCK_PROVIDER_CATALOG)[number];
  resultCount: number;
  status: string | null;
  regions: string[];
  dnsUnlocked: boolean;
};

const DNS_PROVIDER_BY_DOMAIN: Record<string, string> = {
  "netflix.com": "netflix",
  "disneyplus.com": "disney-plus",
  "youtube.com": "youtube",
  "spotify.com": "spotify",
  "bilibili.tv": "bilibili-tv",
  "ani.gamer.com.tw": "bahamut",
  "api.abema.io": "abema",
};

const CATEGORIES = [
  { id: "streaming", label: "流媒体平台" },
  { id: "ai", label: "AI 服务" },
] as const;

function resultStatus(result: StreamUnlockResult) {
  return String(result.status || result.state || "unknown").trim().toLowerCase();
}

function isDnsResult(result: StreamUnlockResult) {
  return result.kind === "dns" || result.platform === "dns" || result.id === "dns";
}

function resultProviderId(result: StreamUnlockResult) {
  return String(result.providerId || result.platform || result.id || result.key || "").trim().toLowerCase();
}

function providerIdForDomain(domain: unknown) {
  return DNS_PROVIDER_BY_DOMAIN[String(domain || "").trim().toLowerCase().replace(/\.$/, "")] || "";
}

function normalizeRegion(value: unknown) {
  const region = String(value || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(region) ? region : "";
}

function regionFlagUrl(region: string) {
  return `https://flagcdn.com/24x18/${region.toLowerCase()}.png`;
}

function accessibleStatus(status: string) {
  return ["available", "unlocked", "yes"].includes(status);
}

function statusLabel(status: string, availabilityOnly: boolean) {
  if (availabilityOnly) {
    if (accessibleStatus(status)) return t("服务开放");
    if (status === "blocked" || status === "no") return t("地区未开放");
  }
  switch (status) {
    case "available":
    case "unlocked":
    case "yes":
      return t("可访问");
    case "partial":
      return t("部分可用");
    case "blocked":
    case "no":
      return t("区域受限");
    case "login":
    case "login_required":
    case "subscription":
      return t("需要登录或订阅");
    case "error":
    case "failed":
      return t("检测失败");
    default:
      return t("无法判断");
  }
}

function statusClass(status: string, dnsUnlocked: boolean) {
  if (dnsUnlocked || ["available", "unlocked", "yes"].includes(status)) {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  }
  if (["partial", "login", "subscription", "login_required"].includes(status)) {
    return "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400";
  }
  if (["blocked", "no", "error", "failed"].includes(status)) {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  return "border-border/60 bg-muted/40 text-muted-foreground";
}

export default function HostStreamUnlockDialog({ host, onOpenChange }: HostStreamUnlockDialogProps) {
  return <HostStreamUnlockDialogContent key={Number(host?.id || 0)} host={host} onOpenChange={onOpenChange} />;
}

function HostStreamUnlockDialogContent({ host, onOpenChange }: HostStreamUnlockDialogProps) {
  const open = !!host;
  const hostId = Number(host?.id || 0);
  const hasIpv4 = hostAddressOptions(host, "ipv4").length > 0;
  const hasIpv6 = hostAddressOptions(host, "ipv6").length > 0;
  const defaultFamily = !hasIpv4 && hasIpv6 ? "ipv6" : "ipv4";
  const [selectedFamily, setSelectedFamily] = useState<"ipv4" | "ipv6">(defaultFamily);
  const statusQuery = trpc.hosts.streamUnlock.status.useQuery(
    { hostId },
    {
      enabled: open && hostId > 0,
      refetchInterval: open ? 2_000 : false,
      refetchOnWindowFocus: false,
    },
  );
  const startMutation = trpc.hosts.streamUnlock.start.useMutation({
    onSuccess: () => {
      void statusQuery.refetch();
    },
  });

  useEffect(() => {
    if (!open) return;
    setSelectedFamily(defaultFamily);
    void statusQuery.refetch();
  }, [hostId, open, defaultFamily]); // eslint-disable-line react-hooks/exhaustive-deps

  const payload = (statusQuery.data || {}) as any;
  const { providerResults, dnsResults } = useMemo(() => {
    const sourceRows = Array.isArray(payload?.providers)
      ? payload.providers
      : Array.isArray(payload?.items)
        ? payload.items
        : Array.isArray(payload?.results)
          ? payload.results
          : [];
    const rows = (sourceRows as StreamUnlockResult[]).filter((row) => !isDnsResult(row));
    const dns = Array.isArray(payload?.dns) ? payload.dns as DnsResult[] : [];
    return {
      providerResults: rows.map((row) => ({ ...row, providerId: resultProviderId(row) })),
      dnsResults: dns,
    };
  }, [payload?.dns, payload?.items, payload?.providers, payload?.results]);

  const running = Boolean(payload?.running)
    || ["queued", "running", "pending", "started"].includes(String(payload?.status || "").toLowerCase());
  const activeFamily = (selectedFamily === "ipv4" ? hasIpv4 : hasIpv6) ? selectedFamily : defaultFamily;
  const familyProviderResults = providerResults.filter((result) => !result.family || String(result.family).toLowerCase() === activeFamily);
  const familyDnsResults = dnsResults.filter((result) => !result.family || String(result.family).toLowerCase() === activeFamily);
  const providerDisplays = useMemo<ProviderDisplay[]>(() => STREAM_UNLOCK_PROVIDER_CATALOG.map((provider) => {
    const matches = familyProviderResults.filter((result) => result.providerId === provider.id);
    const matchingDns = familyDnsResults.filter((result) => providerIdForDomain(result.domain) === provider.id);
    const dnsUnlocked = !provider.availabilityOnly && matches.some((result) => accessibleStatus(resultStatus(result))
      && matchingDns.some((dns) => dns.mode === "smart_dns_suspected"
        && (!dns.family || !result.family || dns.family === result.family)));
    const regions = [...new Set(matches.map((result) => normalizeRegion(result.region || result.country)).filter(Boolean))];
    const status = matches.length > 0 ? resultStatus(matches[matches.length - 1]) : null;
    return {
      provider,
      resultCount: matches.length,
      status,
      regions,
      dnsUnlocked,
    };
  }), [familyDnsResults, familyProviderResults]);

  const hasPreviousResult = providerResults.length > 0 || dnsResults.length > 0 || Boolean(payload?.checkedAt || payload?.finishedAt || payload?.error);
  const taskError = startMutation.error?.message || statusQuery.error?.message || payload?.error;

  const startDetection = () => {
    if (!hostId || startMutation.isPending || running) return;
    const family = hasIpv4 && !hasIpv6 ? "ipv4" : hasIpv6 && !hasIpv4 ? "ipv6" : "both";
    startMutation.mutate({ hostId, family });
  };

  const groupedProviders = (category: string) => providerDisplays.filter((item) => item.provider.category === category);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(760px,calc(100svh-1.5rem))] w-[calc(100vw-2rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-h-[min(760px,calc(100svh-3rem))] sm:p-0">
        <DialogHeader className="shrink-0 border-b px-5 py-4 sm:px-6">
          <DialogTitle className="flex items-center gap-2">
            <TvMinimalPlay className="h-5 w-5 text-primary" />
            {t("流媒体解锁检测")}
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 touch-pan-y space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
          <div className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{String(host?.name || t("未命名主机"))}</p>
              {(!hasPreviousResult || running) && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {running ? t("正在检测中") : t("尚未进行检测")}
                </p>
              )}
            </div>
            <Button className="shrink-0 gap-2" onClick={startDetection} disabled={!host?.isOnline || running || startMutation.isPending}>
              {running || startMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {running ? t("检测中") : t("开始检测")}
            </Button>
          </div>

          {!host?.isOnline && <p className="text-sm text-amber-600 dark:text-amber-400">{t("主机当前离线，Agent 上线后才能开始检测")}</p>}
          {taskError && <p className="text-sm text-destructive">{taskError}</p>}
          <div className="flex justify-end">
            <div role="group" aria-label={t("IP 版本")} className="inline-flex items-center rounded-md border bg-muted/40 p-0.5">
              {(["ipv4", "ipv6"] as const).map((family) => (
                <Button
                  key={family}
                  type="button"
                  size="sm"
                  variant={activeFamily === family ? "secondary" : "ghost"}
                  aria-pressed={activeFamily === family}
                  disabled={family === "ipv4" ? !hasIpv4 : !hasIpv6}
                  className="h-7 min-w-14 px-2.5 text-xs"
                  onClick={() => setSelectedFamily(family)}
                >
                  {family.toUpperCase()}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-4">
            {CATEGORIES.map((category) => {
              const items = groupedProviders(category.id);
              if (items.length === 0) return null;
              return (
                <section key={category.id} className="space-y-2">
                  <h3 className="text-sm font-semibold">{t(category.label)}</h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {items.map((item) => <ProviderResultRow key={item.provider.id} item={item} checking={running && item.resultCount === 0} />)}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
        <DialogFooter className="shrink-0 border-t px-5 py-3 sm:px-6">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("关闭")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

}

function ProviderResultRow({ item, checking }: { item: ProviderDisplay; checking: boolean }) {
  const status = item.dnsUnlocked ? "dns_unlocked" : item.status;
  const label = item.dnsUnlocked
    ? t("DNS 解锁")
    : item.status
      ? statusLabel(item.status, item.provider.availabilityOnly)
      : checking
        ? t("检测中")
        : null;

  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-md border bg-card/50 px-2.5 py-2">
      <StreamProviderLogo providerId={item.provider.id} className="h-8 w-8 rounded-sm p-1.5" />
      <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_42px_82px] items-center gap-1.5">
        <span className="min-w-0 truncate text-sm font-medium" title={item.provider.name}>{item.provider.name}</span>
        <span className="flex w-[42px] items-center justify-center gap-1 text-[11px] text-muted-foreground" title={item.regions.join(", ")}>
          {item.regions.slice(0, 1).map((region) => (
            <span key={region} className="inline-flex min-w-0 items-center justify-center gap-1">
              <img
                src={regionFlagUrl(region)}
                alt=""
                aria-hidden="true"
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                className="h-[15px] w-5 shrink-0 rounded-[2px] object-cover"
                onError={(event) => { event.currentTarget.style.display = "none"; }}
              />
              <span>{region}</span>
            </span>
          ))}
        </span>
        {label ? (
          <Badge variant="outline" className={cn("w-[82px] justify-center gap-1 whitespace-nowrap text-[11px]", statusClass(status || "unknown", item.dnsUnlocked))}>
            {checking && <Loader2 className="h-3 w-3 animate-spin" />}
            {label}
          </Badge>
        ) : (
          <span aria-hidden="true" className="h-6 w-[82px] shrink-0" />
        )}
      </div>
    </div>
  );
}
